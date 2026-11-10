package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

type TerminalDevice struct {
	ID            int64  `json:"id"`
	ProjectID     int64  `json:"project_id"`
	Category      string `json:"category"` // 冗余展示字段:"总分类/子分类"
	CategoryID    int64  `json:"category_id"`
	SubCategoryID int64  `json:"sub_category_id"`
	Code          string `json:"code"` // 已从新增/编辑表单里取消,仅保留历史数据只读展示于导出等场景
	Location      string `json:"location"`
	Model         string `json:"model"`
	Cabinet       string `json:"cabinet"`
	IP            string `json:"ip"`
	MAC           string `json:"mac"`         // 同上,已取消
	CableNo       string `json:"cable_no"`    // 同上,已取消
	SwitchName    string `json:"switch_name"` // 同上,已取消
	SwitchPort    string `json:"switch_port"` // 同上,已取消
	Status        string `json:"status"`
	PhotoPath     string `json:"photo_path"`
	Remark        string `json:"remark"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
	UpdatedBy     string `json:"updated_by"`
}

var deviceCols = "id,project_id,category,category_id,sub_category_id,COALESCE(code,''),location,model,ip,COALESCE(mac,''),COALESCE(cable_no,''),COALESCE(switch_name,''),COALESCE(switch_port,''),status,COALESCE(photo_path,''),remark,created_at,updated_at,updated_by,COALESCE(cabinet,'')"

func scanDevice(rows interface{ Scan(...any) error }) (TerminalDevice, error) {
	var d TerminalDevice
	err := rows.Scan(&d.ID, &d.ProjectID, &d.Category, &d.CategoryID, &d.SubCategoryID, &d.Code, &d.Location, &d.Model, &d.IP, &d.MAC, &d.CableNo, &d.SwitchName, &d.SwitchPort, &d.Status, &d.PhotoPath, &d.Remark, &d.CreatedAt, &d.UpdatedAt, &d.UpdatedBy, &d.Cabinet)
	return d, err
}

func deviceMap(d TerminalDevice) map[string]string {
	return map[string]string{
		"category": d.Category, "location": d.Location, "model": d.Model, "cabinet": d.Cabinet,
		"ip": d.IP, "status": d.Status, "remark": d.Remark,
	}
}

func registerDeviceRoutes(mux *http.ServeMux, dataDir string) {
	mux.HandleFunc("GET /api/devices", requireAuth(listDevices))
	mux.HandleFunc("POST /api/devices", requireModule("devices", createDevice))
	mux.HandleFunc("PUT /api/devices/{id}", requireModule("devices", updateDevice))
	mux.HandleFunc("DELETE /api/devices/{id}", requireAdmin(deleteDevice))
	mux.HandleFunc("POST /api/devices/{id}/photo", requireModule("devices", uploadPhotoHandler(dataDir, "terminal_devices", "terminal_device")))
	mux.HandleFunc("POST /api/devices/labels", requireAuth(batchLabels))
	mux.HandleFunc("POST /api/devices/batch-status", requireModule("devices", batchUpdateStatus))
	mux.HandleFunc("POST /api/devices/batch-delete", requireAdmin(batchDeleteDevices))
}

func listDevices(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	q := r.URL.Query()
	projectID := queryInt(r, "project_id", 0)
	categoryID := queryInt(r, "category_id", 0)
	subCategoryID := queryInt(r, "sub_category_id", 0)
	status := q.Get("status")
	kw := q.Get("q")

	sqlStr := "SELECT " + deviceCols + " FROM terminal_devices WHERE 1=1"
	args := []any{}
	if projectID > 0 {
		if !hasProjectAccess(s, projectID) {
			writeErr(w, 403, "没有该项目的访问权限")
			return
		}
		sqlStr += " AND project_id=?"
		args = append(args, projectID)
	} else {
		sqlStr += scopeFilterSQL(s, "project_id", &args)
	}
	if categoryID > 0 {
		sqlStr += " AND category_id=?"
		args = append(args, categoryID)
	}
	if subCategoryID > 0 {
		sqlStr += " AND sub_category_id=?"
		args = append(args, subCategoryID)
	}
	if status != "" {
		sqlStr += " AND status=?"
		args = append(args, status)
	}
	if kw != "" {
		sqlStr += " AND (location LIKE ? OR ip LIKE ? OR model LIKE ? OR cabinet LIKE ?)"
		like := "%" + kw + "%"
		args = append(args, like, like, like, like)
	}
	sqlStr += " ORDER BY id DESC"
	rows, err := db.conn.Query(sqlStr, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []TerminalDevice{}
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			continue
		}
		list = append(list, d)
	}
	writeJSON(w, list)
}

func createDevice(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var d TerminalDevice
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil || d.CategoryID == 0 {
		writeErr(w, 400, "请选择设备总分类")
		return
	}
	if !hasProjectAccess(s, d.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	mainName, subName := resolveCategoryNames(d.CategoryID, d.SubCategoryID)
	if mainName == "" {
		writeErr(w, 400, "所选总分类不存在")
		return
	}
	d.Category = combinedCategoryLabel(mainName, subName)
	if d.Status == "" {
		d.Status = "未安装"
	}
	now := nowStr()
	d.CreatedAt, d.UpdatedAt, d.UpdatedBy = now, now, s.Username
	res, err := db.conn.Exec(`INSERT INTO terminal_devices(project_id,category,category_id,sub_category_id,code,location,model,cabinet,ip,mac,cable_no,switch_name,switch_port,status,photo_path,remark,created_at,updated_at,updated_by)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		d.ProjectID, d.Category, d.CategoryID, d.SubCategoryID, d.Code, d.Location, d.Model, d.Cabinet, d.IP, d.MAC, d.CableNo, d.SwitchName, d.SwitchPort, d.Status, "", d.Remark, d.CreatedAt, d.UpdatedAt, d.UpdatedBy)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	d.ID = id
	diffAndLog(s, "create", "terminal_device", id, nil, deviceMap(d))
	writeJSON(w, d)
}

func updateDevice(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	row := db.conn.QueryRow("SELECT "+deviceCols+" FROM terminal_devices WHERE id=?", id)
	old, err := scanDevice(row)
	if err != nil {
		writeErr(w, 404, "记录不存在")
		return
	}
	if !hasProjectAccess(s, old.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	var d TerminalDevice
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if d.CategoryID == 0 {
		writeErr(w, 400, "请选择设备总分类")
		return
	}
	mainName, subName := resolveCategoryNames(d.CategoryID, d.SubCategoryID)
	if mainName == "" {
		writeErr(w, 400, "所选总分类不存在")
		return
	}
	d.Category = combinedCategoryLabel(mainName, subName)
	d.ID = id
	d.ProjectID = old.ProjectID
	d.PhotoPath = old.PhotoPath
	d.CreatedAt = old.CreatedAt
	d.UpdatedAt = nowStr()
	d.UpdatedBy = s.Username
	// 编号/MAC/线缆号/所属交换机/端口 这几个字段已经从新增/编辑表单里取消,前端不会再提交它们,
	// 这里强制沿用数据库里原有的值,避免因为请求体里缺了这几个字段而被静默清空成空字符串。
	d.Code = old.Code
	d.MAC = old.MAC
	d.CableNo = old.CableNo
	d.SwitchName = old.SwitchName
	d.SwitchPort = old.SwitchPort
	_, err = db.conn.Exec(`UPDATE terminal_devices SET category=?,category_id=?,sub_category_id=?,location=?,model=?,cabinet=?,ip=?,status=?,remark=?,updated_at=?,updated_by=? WHERE id=?`,
		d.Category, d.CategoryID, d.SubCategoryID, d.Location, d.Model, d.Cabinet, d.IP, d.Status, d.Remark, d.UpdatedAt, d.UpdatedBy, id)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	diffAndLog(s, "update", "terminal_device", id, deviceMap(old), deviceMap(d))
	writeJSON(w, d)
}

func deleteDevice(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	row := db.conn.QueryRow("SELECT "+deviceCols+" FROM terminal_devices WHERE id=?", id)
	old, _ := scanDevice(row)
	if !hasProjectAccess(s, old.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	if _, err := db.conn.Exec(`DELETE FROM terminal_devices WHERE id=?`, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	diffAndLog(s, "delete", "terminal_device", id, deviceMap(old), nil)
	writeJSON(w, map[string]any{"ok": true})
}

// uploadPhotoHandler 是"现场照片上传"的通用实现,设备台账和安装数量登记共用同一套逻辑。
// table/entity 只能是代码里写死的表名/审计对象类型,不接受外部输入,不存在SQL注入风险。
// 文件名按内容的 SHA-256 哈希命名(而不是随机数):这样只要两张照片内容完全一样(哪怕是不同设备
// 分别拍的、或者同一张图传了两次),就会落到同一个物理文件上,不会重复占用磁盘,天然去重。
func uploadPhotoHandler(dataDir, table, entity string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s := sessionFromCtx(r)
		id, err := pathID(r)
		if err != nil {
			writeErr(w, 400, "无效ID")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 300*1024) // 300KB 上限,留余量
		if err := r.ParseMultipartForm(300 * 1024); err != nil {
			writeErr(w, 400, "照片过大或格式错误,请确认已压缩至200KB以内")
			return
		}
		var recordProjectID int64
		if err := db.conn.QueryRow(fmt.Sprintf(`SELECT project_id FROM %s WHERE id=?`, table), id).Scan(&recordProjectID); err != nil {
			writeErr(w, 404, "记录不存在")
			return
		}
		if !hasProjectAccess(s, recordProjectID) {
			writeErr(w, 403, "没有该项目的访问权限")
			return
		}
		file, header, err := r.FormFile("photo")
		if err != nil {
			writeErr(w, 400, "未找到上传文件")
			return
		}
		defer file.Close()

		data, err := io.ReadAll(file)
		if err != nil {
			writeErr(w, 500, "读取上传内容失败")
			return
		}
		ext := ".jpg"
		if strings.Contains(strings.ToLower(header.Filename), ".png") {
			ext = ".png"
		}
		sum := sha256.Sum256(data)
		fname := hex.EncodeToString(sum[:]) + ext
		fpath := dataDir + "/photos/" + fname
		// 只有本地还没有内容完全相同的文件时才真正写盘;已存在就直接复用,不重复写一遍
		if _, statErr := os.Stat(fpath); statErr != nil {
			if err := os.WriteFile(fpath, data, 0644); err != nil {
				writeErr(w, 500, "保存照片失败")
				return
			}
		}

		var oldPhoto string
		db.conn.QueryRow(fmt.Sprintf(`SELECT COALESCE(photo_path,'') FROM %s WHERE id=?`, table), id).Scan(&oldPhoto)
		newPath := "/data/photos/" + fname
		_, err = db.conn.Exec(fmt.Sprintf(`UPDATE %s SET photo_path=?, updated_at=?, updated_by=? WHERE id=?`, table), newPath, nowStr(), s.Username, id)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		// 因为内容相同的照片现在会被去重、共用同一个物理文件,删除旧照片前必须先确认
		// 没有其它设备/安装记录也还在引用它(比如两台设备当初传的是同一张照片),
		// 否则会把别人正在用的照片文件误删掉。oldPhoto==newPath(重复上传同一张图)也直接跳过。
		if oldPhoto != "" && oldPhoto != newPath {
			var stillUsed int
			db.conn.QueryRow(`SELECT
				(SELECT COUNT(*) FROM terminal_devices WHERE photo_path=?) +
				(SELECT COUNT(*) FROM install_records WHERE photo_path=?)`, oldPhoto, oldPhoto).Scan(&stillUsed)
			if stillUsed == 0 {
				os.Remove(dataDir + strings.TrimPrefix(oldPhoto, "/data"))
			}
		}
		logAudit(s, "update", entity, id, "photo_path", oldPhoto, newPath)
		writeJSON(w, map[string]any{"photo_path": newPath})
	}
}

// batchLabels 根据勾选的设备ID批量返回打印标签所需数据(编号+位置+线缆号+IP)
func batchLabels(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.IDs) == 0 {
		writeErr(w, 400, "请选择需要生成标签的设备")
		return
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(body.IDs)), ",")
	args := make([]any, len(body.IDs))
	for i, id := range body.IDs {
		args[i] = id
	}
	rows, err := db.conn.Query("SELECT "+deviceCols+" FROM terminal_devices WHERE id IN ("+placeholders+")", args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []TerminalDevice{}
	for rows.Next() {
		d, err := scanDevice(rows)
		if err == nil {
			list = append(list, d)
		}
	}
	writeJSON(w, list)
}

// batchUpdateStatus 批量修改一批设备的安装状态,每台设备的变更都会单独记录审计日志
func batchUpdateStatus(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var body struct {
		IDs    []int64 `json:"ids"`
		Status string  `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.IDs) == 0 || body.Status == "" {
		writeErr(w, 400, "请选择设备并指定目标状态")
		return
	}
	validStatus := map[string]bool{"未安装": true, "已安装": true, "已调试": true, "施工异常": true}
	if !validStatus[body.Status] {
		writeErr(w, 400, "无效的安装状态")
		return
	}
	updated := 0
	for _, id := range body.IDs {
		var oldStatus string
		var projectID int64
		if err := db.conn.QueryRow(`SELECT status,project_id FROM terminal_devices WHERE id=?`, id).Scan(&oldStatus, &projectID); err != nil {
			continue
		}
		if !hasProjectAccess(s, projectID) {
			continue
		}
		if oldStatus == body.Status {
			continue
		}
		_, err := db.conn.Exec(`UPDATE terminal_devices SET status=?, updated_at=?, updated_by=? WHERE id=?`, body.Status, nowStr(), s.Username, id)
		if err == nil {
			logAudit(s, "update", "terminal_device", id, "status", oldStatus, body.Status)
			updated++
		}
	}
	writeJSON(w, map[string]any{"updated": updated})
}

// batchDeleteDevices 批量删除设备(仅管理员),每台设备的删除都会单独记录审计日志
func batchDeleteDevices(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.IDs) == 0 {
		writeErr(w, 400, "请选择需要删除的设备")
		return
	}
	deleted := 0
	for _, id := range body.IDs {
		row := db.conn.QueryRow("SELECT "+deviceCols+" FROM terminal_devices WHERE id=?", id)
		old, err := scanDevice(row)
		if err != nil {
			continue
		}
		if _, err := db.conn.Exec(`DELETE FROM terminal_devices WHERE id=?`, id); err != nil {
			continue
		}
		diffAndLog(s, "delete", "terminal_device", id, deviceMap(old), nil)
		deleted++
	}
	writeJSON(w, map[string]any{"deleted": deleted})
}
