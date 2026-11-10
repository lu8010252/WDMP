package main

import (
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"
)

func registerExcelRoutes(mux *http.ServeMux, dataDir string) {
	mux.HandleFunc("GET /api/export/quantity", requireAuth(exportQuantityExcel))
	mux.HandleFunc("POST /api/import/quantity", requireModule("quantity", importQuantityExcel))
	mux.HandleFunc("GET /api/export/devices", requireAuth(exportDevicesExcel))
	mux.HandleFunc("POST /api/import/devices", requireModule("devices", importDevicesExcelHandler(dataDir)))
	mux.HandleFunc("GET /api/export/install", requireAuth(exportInstallExcel))
	mux.HandleFunc("POST /api/import/install", requireModule("install", importInstallExcel))
}

func writeExcelResponse(w http.ResponseWriter, f *excelize.File, filename string) {
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	f.Write(w)
}

func setRow(f *excelize.File, sheet string, rowNum int, vals []any) {
	for i, v := range vals {
		cell, _ := excelize.CoordinatesToCellName(i+1, rowNum)
		f.SetCellValue(sheet, cell, v)
	}
}

// importMode 读取 ?mode=overwrite 或 ?mode=append(默认追加),用于三个导入接口共用
func importMode(r *http.Request) string {
	m := r.URL.Query().Get("mode")
	if m == "overwrite" {
		return "overwrite"
	}
	return "append"
}

// ---------- 工程量对比 ----------
// 分类拆成"总分类"、"子分类"两列,导入时按名称自动查找/创建分类

var quantityHeaders = []string{"总分类", "子分类", "设备型号", "设备品牌", "单位", "图纸数量", "清单数量", "到货数量", "安装数量", "备注"}

func exportQuantityExcel(w http.ResponseWriter, r *http.Request) {
	projectID := queryInt(r, "project_id", 0)
	// COALESCE(sub_category_name,'') 很关键:没填子分类时 LEFT JOIN 会产生 NULL,
	// 扫描进普通 string 变量会报错导致该行后面所有字段整体扫描失败、变成空白(historic bug,这里一并修掉)。
	sqlStr := `SELECT category_name,COALESCE(sub_category_name,''),device_name,COALESCE(brand,''),unit,drawing_qty,list_qty,arrival_qty,actual_qty,remark
		FROM quantity_items q LEFT JOIN (SELECT id AS cid, name AS category_name FROM categories) c1 ON q.category_id=c1.cid
		LEFT JOIN (SELECT id AS sid, name AS sub_category_name FROM categories) c2 ON q.sub_category_id=c2.sid`
	args := []any{}
	if projectID > 0 {
		sqlStr += " WHERE q.project_id=?"
		args = append(args, projectID)
	}
	rows, err := db.conn.Query(sqlStr, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()

	f := excelize.NewFile()
	sheet := "工程量对比"
	f.SetSheetName("Sheet1", sheet)
	setRow(f, sheet, 1, toAnySlice(quantityHeaders))
	r_ := 2
	for rows.Next() {
		var mainCat, subCat, name, brand, unit, remark string
		var dq, lq, arq, aq float64
		if err := rows.Scan(&mainCat, &subCat, &name, &brand, &unit, &dq, &lq, &arq, &aq, &remark); err != nil {
			continue
		}
		setRow(f, sheet, r_, []any{mainCat, subCat, name, brand, unit, dq, lq, arq, aq, remark})
		r_++
	}
	writeExcelResponse(w, f, "工程量对比.xlsx")
}

func importQuantityExcel(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	projectID := queryInt(r, "project_id", 0)
	if projectID == 0 {
		writeErr(w, 400, "请先指定所属项目 project_id")
		return
	}
	mode := importMode(r)
	r.ParseMultipartForm(10 << 20)
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "未找到上传文件")
		return
	}
	defer file.Close()
	f, err := excelize.OpenReader(file)
	if err != nil {
		writeErr(w, 400, "无法解析Excel文件: "+err.Error())
		return
	}
	sheet := f.GetSheetName(0)
	rows, err := f.GetRows(sheet)
	if err != nil || len(rows) < 2 {
		writeErr(w, 400, "Excel内容为空")
		return
	}

	if mode == "overwrite" {
		var oldCount int
		db.conn.QueryRow(`SELECT COUNT(*) FROM quantity_items WHERE project_id=?`, projectID).Scan(&oldCount)
		if oldCount > 0 {
			if _, err := db.conn.Exec(`DELETE FROM quantity_items WHERE project_id=?`, projectID); err != nil {
				writeErr(w, 500, "覆盖导入前清空原有工程量数据失败: "+err.Error())
				return
			}
			logAudit(s, "delete", "quantity_item", 0, "overwrite_import", "",
				"覆盖导入前清空了该项目下原有的 "+strconv.Itoa(oldCount)+" 条工程量记录")
		}
	}

	count := 0
	for _, row := range rows[1:] {
		row = padRow(row, 10)
		mainCat, subCat, name, brand := row[0], row[1], row[2], row[3]
		if name == "" || mainCat == "" {
			continue
		}
		dq, _ := strconv.ParseFloat(row[5], 64)
		lq, _ := strconv.ParseFloat(row[6], 64)
		arq, _ := strconv.ParseFloat(row[7], 64)
		aq, _ := strconv.ParseFloat(row[8], 64)
		unit := row[4]
		if unit == "" {
			unit = "台"
		}
		mainID := findOrCreateCategory(mainCat, 0)
		subID := int64(0)
		if subCat != "" {
			subID = findOrCreateCategory(subCat, mainID)
		}
		category := combinedCategoryLabel(mainCat, subCat)
		res, err := db.conn.Exec(`INSERT INTO quantity_items(project_id,category,category_id,sub_category_id,device_name,brand,unit,drawing_qty,list_qty,arrival_qty,actual_qty,remark,updated_at,updated_by)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, projectID, category, mainID, subID, name, brand, unit, dq, lq, arq, aq, row[9], nowStr(), s.Username)
		if err == nil {
			id, _ := res.LastInsertId()
			diffAndLog(s, "create", "quantity_item", id, nil, map[string]string{"device_name": name, "备注": "Excel批量导入(" + mode + ")"})
			count++
		}
	}
	writeJSON(w, map[string]any{"imported": count, "mode": mode})
}

// ---------- 终端设备点位台账 ----------

var deviceHeaders = []string{"总分类", "子分类", "安装位置", "型号", "机柜", "IP地址", "安装状态", "备注"}

func exportDevicesExcel(w http.ResponseWriter, r *http.Request) {
	projectID := queryInt(r, "project_id", 0)
	// COALESCE(sub_category_name,'') 同上:避免没填子分类时NULL导致整行后续字段扫描失败
	sqlStr := `SELECT category_name,COALESCE(sub_category_name,''),location,model,COALESCE(cabinet,''),ip,status,remark
		FROM terminal_devices d LEFT JOIN (SELECT id AS cid, name AS category_name FROM categories) c1 ON d.category_id=c1.cid
		LEFT JOIN (SELECT id AS sid, name AS sub_category_name FROM categories) c2 ON d.sub_category_id=c2.sid`
	args := []any{}
	if projectID > 0 {
		sqlStr += " WHERE d.project_id=?"
		args = append(args, projectID)
	}
	rows, err := db.conn.Query(sqlStr, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()

	f := excelize.NewFile()
	sheet := "设备台账"
	f.SetSheetName("Sheet1", sheet)
	setRow(f, sheet, 1, toAnySlice(deviceHeaders))
	r_ := 2
	for rows.Next() {
		var mainCat, subCat, loc, model, cabinet, ip, status, remark string
		if err := rows.Scan(&mainCat, &subCat, &loc, &model, &cabinet, &ip, &status, &remark); err != nil {
			continue
		}
		setRow(f, sheet, r_, []any{mainCat, subCat, loc, model, cabinet, ip, status, remark})
		r_++
	}
	writeExcelResponse(w, f, "设备台账.xlsx")
}

// importDevicesExcelHandler 需要 dataDir 用于覆盖导入时清理旧设备的现场照片文件
func importDevicesExcelHandler(dataDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s := sessionFromCtx(r)
		projectID := queryInt(r, "project_id", 0)
		if projectID == 0 {
			writeErr(w, 400, "请先指定所属项目 project_id")
			return
		}
		mode := importMode(r)
		r.ParseMultipartForm(10 << 20)
		file, _, err := r.FormFile("file")
		if err != nil {
			writeErr(w, 400, "未找到上传文件")
			return
		}
		defer file.Close()
		f, err := excelize.OpenReader(file)
		if err != nil {
			writeErr(w, 400, "无法解析Excel文件: "+err.Error())
			return
		}
		sheet := f.GetSheetName(0)
		rows, err := f.GetRows(sheet)
		if err != nil || len(rows) < 2 {
			writeErr(w, 400, "Excel内容为空")
			return
		}

		if mode == "overwrite" {
			photoRows, _ := db.conn.Query(`SELECT photo_path FROM terminal_devices WHERE project_id=? AND photo_path != ''`, projectID)
			if photoRows != nil {
				var paths []string
				for photoRows.Next() {
					var p string
					if photoRows.Scan(&p) == nil && p != "" {
						paths = append(paths, p)
					}
				}
				photoRows.Close()
				for _, p := range paths {
					os.Remove(dataDir + strings.TrimPrefix(p, "/data"))
				}
			}
			var oldCount int
			db.conn.QueryRow(`SELECT COUNT(*) FROM terminal_devices WHERE project_id=?`, projectID).Scan(&oldCount)
			if oldCount > 0 {
				if _, err := db.conn.Exec(`DELETE FROM terminal_devices WHERE project_id=?`, projectID); err != nil {
					writeErr(w, 500, "覆盖导入前清空原有设备台账数据失败: "+err.Error())
					return
				}
				logAudit(s, "delete", "terminal_device", 0, "overwrite_import", "",
					"覆盖导入前清空了该项目下原有的 "+strconv.Itoa(oldCount)+" 条设备台账记录(含现场照片)")
			}
		}

		count := 0
		now := nowStr()
		for _, row := range rows[1:] {
			row = padRow(row, 8)
			mainCat, subCat := row[0], row[1]
			if mainCat == "" {
				continue
			}
			status := row[6]
			if status == "" {
				status = "未安装"
			}
			mainID := findOrCreateCategory(mainCat, 0)
			subID := int64(0)
			if subCat != "" {
				subID = findOrCreateCategory(subCat, mainID)
			}
			category := combinedCategoryLabel(mainCat, subCat)
			res, err := db.conn.Exec(`INSERT INTO terminal_devices(project_id,category,category_id,sub_category_id,location,model,cabinet,ip,status,photo_path,remark,created_at,updated_at,updated_by)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				projectID, category, mainID, subID, row[2], row[3], row[4], row[5], status, "", row[7], now, now, s.Username)
			if err == nil {
				id, _ := res.LastInsertId()
				diffAndLog(s, "create", "terminal_device", id, nil, map[string]string{"model": row[3], "备注": "Excel批量导入(" + mode + ")"})
				count++
			}
		}
		writeJSON(w, map[string]any{"imported": count, "mode": mode})
	}
}

func padRow(row []string, n int) []string {
	for len(row) < n {
		row = append(row, "")
	}
	return row
}

func toAnySlice(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}

// ---------- 现场安装数量登记 ----------

var installHeaders = []string{"总分类", "子分类", "安装位置", "设备型号", "数量", "备注"}

func exportInstallExcel(w http.ResponseWriter, r *http.Request) {
	projectID := queryInt(r, "project_id", 0)
	sqlStr := `SELECT category_name,sub_category_name,location,model,quantity,remark FROM install_records`
	args := []any{}
	if projectID > 0 {
		sqlStr += " WHERE project_id=?"
		args = append(args, projectID)
	}
	rows, err := db.conn.Query(sqlStr, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()

	f := excelize.NewFile()
	sheet := "安装数量登记"
	f.SetSheetName("Sheet1", sheet)
	setRow(f, sheet, 1, toAnySlice(installHeaders))
	r_ := 2
	for rows.Next() {
		var mainCat, subCat, location, model, remark string
		var qty float64
		rows.Scan(&mainCat, &subCat, &location, &model, &qty, &remark)
		setRow(f, sheet, r_, []any{mainCat, subCat, location, model, qty, remark})
		r_++
	}
	writeExcelResponse(w, f, "安装数量登记.xlsx")
}

func importInstallExcel(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	projectID := queryInt(r, "project_id", 0)
	if projectID == 0 {
		writeErr(w, 400, "请先指定所属项目 project_id")
		return
	}
	mode := importMode(r)
	r.ParseMultipartForm(10 << 20)
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "未找到上传文件")
		return
	}
	defer file.Close()
	f, err := excelize.OpenReader(file)
	if err != nil {
		writeErr(w, 400, "无法解析Excel文件: "+err.Error())
		return
	}
	sheet := f.GetSheetName(0)
	rows, err := f.GetRows(sheet)
	if err != nil || len(rows) < 2 {
		writeErr(w, 400, "Excel内容为空")
		return
	}

	// 记住覆盖导入前该项目下所有涉及的(分类+型号)组合,删除并重新导入后要对这些组合重新触发一次
	// 工程量对比同步,否则如果新表格里少了某个型号,老的实际数量会残留、对不上。
	var staleCombos [][3]any
	if mode == "overwrite" {
		var oldCount int
		db.conn.QueryRow(`SELECT COUNT(*) FROM install_records WHERE project_id=?`, projectID).Scan(&oldCount)
		if oldCount > 0 {
			comboRows, _ := db.conn.Query(`SELECT DISTINCT category_id,sub_category_id,model FROM install_records WHERE project_id=?`, projectID)
			if comboRows != nil {
				for comboRows.Next() {
					var cid, sid int64
					var model string
					if comboRows.Scan(&cid, &sid, &model) == nil {
						staleCombos = append(staleCombos, [3]any{cid, sid, model})
					}
				}
				comboRows.Close()
			}
			if _, err := db.conn.Exec(`DELETE FROM install_records WHERE project_id=?`, projectID); err != nil {
				writeErr(w, 500, "覆盖导入前清空原有安装登记数据失败: "+err.Error())
				return
			}
			logAudit(s, "delete", "install_record", 0, "overwrite_import", "",
				"覆盖导入前清空了该项目下原有的 "+strconv.Itoa(oldCount)+" 条安装数量登记记录")
		}
	}

	count := 0
	now := nowStr()
	for _, row := range rows[1:] {
		row = padRow(row, 6)
		mainCat, subCat, location, model := row[0], row[1], row[2], row[3]
		if mainCat == "" || model == "" {
			continue
		}
		qty, _ := strconv.ParseFloat(row[4], 64)
		mainID := findOrCreateCategory(mainCat, 0)
		subID := int64(0)
		if subCat != "" {
			subID = findOrCreateCategory(subCat, mainID)
		}
		res, err := db.conn.Exec(`INSERT INTO install_records(project_id,category_id,sub_category_id,category_name,sub_category_name,location,model,quantity,remark,created_at,updated_at,updated_by)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, projectID, mainID, subID, mainCat, subCat, location, model, qty, row[5], now, now, s.Username)
		if err != nil {
			continue
		}
		id, _ := res.LastInsertId()
		diffAndLog(s, "create", "install_record", id, nil, map[string]string{"model": model, "备注": "Excel批量导入(" + mode + ")"})
		syncActualQty(s, projectID, mainID, subID, model)
		count++
	}

	// 补一次旧组合的同步(处理"新表格里已经不再包含某个老型号"的情况,把对应实际数量归零)
	for _, combo := range staleCombos {
		syncActualQty(s, projectID, combo[0].(int64), combo[1].(int64), combo[2].(string))
	}

	writeJSON(w, map[string]any{"imported": count, "mode": mode})
}
