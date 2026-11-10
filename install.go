package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

type InstallRecord struct {
	ID              int64   `json:"id"`
	ProjectID       int64   `json:"project_id"`
	CategoryID      int64   `json:"category_id"`
	SubCategoryID   int64   `json:"sub_category_id"`
	CategoryName    string  `json:"category_name"`
	SubCategoryName string  `json:"sub_category_name"`
	Location        string  `json:"location"`
	Model           string  `json:"model"`
	Quantity        float64 `json:"quantity"`
	PhotoPath       string  `json:"photo_path"`
	Remark          string  `json:"remark"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
	UpdatedBy       string  `json:"updated_by"`
}

var installCols = "id,project_id,category_id,sub_category_id,category_name,sub_category_name,location,model,quantity,COALESCE(photo_path,''),remark,created_at,updated_at,updated_by"

func scanInstall(row interface{ Scan(...any) error }) (InstallRecord, error) {
	var it InstallRecord
	err := row.Scan(&it.ID, &it.ProjectID, &it.CategoryID, &it.SubCategoryID, &it.CategoryName, &it.SubCategoryName, &it.Location, &it.Model, &it.Quantity, &it.PhotoPath, &it.Remark, &it.CreatedAt, &it.UpdatedAt, &it.UpdatedBy)
	return it, err
}

func installMap(it InstallRecord) map[string]string {
	return map[string]string{
		"category": combinedCategoryLabel(it.CategoryName, it.SubCategoryName),
		"location": it.Location,
		"model":    it.Model,
		"quantity": strconv.FormatFloat(it.Quantity, 'f', -1, 64),
		"remark":   it.Remark,
	}
}

func registerInstallRoutes(mux *http.ServeMux, dataDir string) {
	mux.HandleFunc("GET /api/install", requireAuth(listInstall))
	mux.HandleFunc("POST /api/install", requireModule("install", createInstall))
	mux.HandleFunc("PUT /api/install/{id}", requireModule("install", updateInstall))
	mux.HandleFunc("DELETE /api/install/{id}", requireAdmin(deleteInstall))
	mux.HandleFunc("POST /api/install/{id}/photo", requireModule("install", uploadPhotoHandler(dataDir, "install_records", "install_record")))
}

func listInstall(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	projectID := queryInt(r, "project_id", 0)
	categoryID := queryInt(r, "category_id", 0)
	subCategoryID := queryInt(r, "sub_category_id", 0)
	q := "SELECT " + installCols + " FROM install_records WHERE 1=1"
	args := []any{}
	if projectID > 0 {
		if !hasProjectAccess(s, projectID) {
			writeErr(w, 403, "没有该项目的访问权限")
			return
		}
		q += " AND project_id=?"
		args = append(args, projectID)
	} else {
		q += scopeFilterSQL(s, "project_id", &args)
	}
	if categoryID > 0 {
		q += " AND category_id=?"
		args = append(args, categoryID)
	}
	if subCategoryID > 0 {
		q += " AND sub_category_id=?"
		args = append(args, subCategoryID)
	}
	q += " ORDER BY id DESC"
	rows, err := db.conn.Query(q, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []InstallRecord{}
	for rows.Next() {
		it, err := scanInstall(rows)
		if err == nil {
			list = append(list, it)
		}
	}
	writeJSON(w, list)
}

func createInstall(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var it InstallRecord
	if err := json.NewDecoder(r.Body).Decode(&it); err != nil || it.ProjectID == 0 || it.Model == "" {
		writeErr(w, 400, "所属项目和设备型号不能为空")
		return
	}
	if !hasProjectAccess(s, it.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	if it.CategoryID == 0 {
		writeErr(w, 400, "请选择总分类")
		return
	}
	mainName, subName := resolveCategoryNames(it.CategoryID, it.SubCategoryID)
	if mainName == "" {
		writeErr(w, 400, "所选总分类不存在")
		return
	}
	it.CategoryName, it.SubCategoryName = mainName, subName
	now := nowStr()
	it.CreatedAt, it.UpdatedAt, it.UpdatedBy = now, now, s.Username
	res, err := db.conn.Exec(`INSERT INTO install_records(project_id,category_id,sub_category_id,category_name,sub_category_name,location,model,quantity,remark,created_at,updated_at,updated_by)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		it.ProjectID, it.CategoryID, it.SubCategoryID, it.CategoryName, it.SubCategoryName, it.Location, it.Model, it.Quantity, it.Remark, it.CreatedAt, it.UpdatedAt, it.UpdatedBy)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	it.ID = id
	diffAndLog(s, "create", "install_record", id, nil, installMap(it))

	syncActualQty(s, it.ProjectID, it.CategoryID, it.SubCategoryID, it.Model)
	writeJSON(w, it)
}

func updateInstall(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	row := db.conn.QueryRow("SELECT "+installCols+" FROM install_records WHERE id=?", id)
	old, err := scanInstall(row)
	if err != nil {
		writeErr(w, 404, "记录不存在")
		return
	}
	if !hasProjectAccess(s, old.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	var it InstallRecord
	if err := json.NewDecoder(r.Body).Decode(&it); err != nil || it.Model == "" {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if it.CategoryID == 0 {
		writeErr(w, 400, "请选择总分类")
		return
	}
	mainName, subName := resolveCategoryNames(it.CategoryID, it.SubCategoryID)
	if mainName == "" {
		writeErr(w, 400, "所选总分类不存在")
		return
	}
	it.CategoryName, it.SubCategoryName = mainName, subName
	it.ID = id
	it.ProjectID = old.ProjectID
	it.PhotoPath = old.PhotoPath
	it.CreatedAt = old.CreatedAt
	it.UpdatedAt = nowStr()
	it.UpdatedBy = s.Username
	_, err = db.conn.Exec(`UPDATE install_records SET category_id=?,sub_category_id=?,category_name=?,sub_category_name=?,location=?,model=?,quantity=?,remark=?,updated_at=?,updated_by=? WHERE id=?`,
		it.CategoryID, it.SubCategoryID, it.CategoryName, it.SubCategoryName, it.Location, it.Model, it.Quantity, it.Remark, it.UpdatedAt, it.UpdatedBy, id)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	diffAndLog(s, "update", "install_record", id, installMap(old), installMap(it))

	// 分类或型号发生变化时,旧的组合和新的组合都要重新同步
	syncActualQty(s, old.ProjectID, old.CategoryID, old.SubCategoryID, old.Model)
	if old.CategoryID != it.CategoryID || old.SubCategoryID != it.SubCategoryID || old.Model != it.Model {
		syncActualQty(s, it.ProjectID, it.CategoryID, it.SubCategoryID, it.Model)
	}
	writeJSON(w, it)
}

func deleteInstall(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	row := db.conn.QueryRow("SELECT "+installCols+" FROM install_records WHERE id=?", id)
	old, _ := scanInstall(row)
	if !hasProjectAccess(s, old.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	if _, err := db.conn.Exec(`DELETE FROM install_records WHERE id=?`, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	diffAndLog(s, "delete", "install_record", id, installMap(old), nil)
	syncActualQty(s, old.ProjectID, old.CategoryID, old.SubCategoryID, old.Model)
	writeJSON(w, map[string]any{"ok": true})
}

// syncActualQty 根据 项目+总分类+子分类+设备型号 这一组合,把该组合下所有"现场安装数量登记"
// 的数量汇总,自动写入(或新建)对应的"工程量对比"条目的实际安装数量,实现两个模块的联动同步。
func syncActualQty(s *Session, projectID, categoryID, subCategoryID int64, model string) {
	if projectID == 0 || model == "" {
		return
	}
	var sum float64
	db.conn.QueryRow(`SELECT COALESCE(SUM(quantity),0) FROM install_records WHERE project_id=? AND category_id=? AND sub_category_id=? AND model=?`,
		projectID, categoryID, subCategoryID, model).Scan(&sum)

	var qid int64
	var oldActual float64
	err := db.conn.QueryRow(`SELECT id,actual_qty FROM quantity_items WHERE project_id=? AND category_id=? AND sub_category_id=? AND device_name=?`,
		projectID, categoryID, subCategoryID, model).Scan(&qid, &oldActual)

	if err == sql.ErrNoRows {
		if sum == 0 {
			return // 没有安装登记也没有既有条目,无需创建
		}
		mainName, subName := resolveCategoryNames(categoryID, subCategoryID)
		category := combinedCategoryLabel(mainName, subName)
		now := nowStr()
		res, err2 := db.conn.Exec(`INSERT INTO quantity_items(project_id,category,category_id,sub_category_id,device_name,brand,unit,drawing_qty,list_qty,actual_qty,remark,updated_at,updated_by)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, projectID, category, categoryID, subCategoryID, model, "", "台", 0, 0, sum, "由现场安装数量登记自动创建", now, "系统同步")
		if err2 == nil {
			newID, _ := res.LastInsertId()
			if s != nil {
				diffAndLog(s, "create", "quantity_item", newID, nil, map[string]string{
					"device_name": model, "actual_qty": strconv.FormatFloat(sum, 'f', -1, 64),
					"remark": "由现场安装数量登记自动创建",
				})
			}
		}
		return
	}
	if err != nil || oldActual == sum {
		return
	}
	if _, err := db.conn.Exec(`UPDATE quantity_items SET actual_qty=?, updated_at=?, updated_by=? WHERE id=?`, sum, nowStr(), "系统同步(安装登记)", qid); err != nil {
		// syncActualQty 是安装登记保存/删除后顺带触发的后台联动,本身不面向 HTTP 响应,
		// 失败时没有合适的地方把错误"报"给用户,只能记日志,后续人工核对工程量对比页面数据是否对得上。
		log.Printf("同步工程量实际数量失败(quantity_item id=%d): %v", qid, err)
		return
	}
	if s != nil {
		logAudit(s, "update", "quantity_item", qid, "actual_qty", strconv.FormatFloat(oldActual, 'f', -1, 64), strconv.FormatFloat(sum, 'f', -1, 64))
	}
}
