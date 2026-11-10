package main

import (
	"encoding/json"
	"net/http"
	"strconv"
)

type QuantityItem struct {
	ID            int64   `json:"id"`
	ProjectID     int64   `json:"project_id"`
	Category      string  `json:"category"` // 冗余展示字段:"总分类/子分类"
	CategoryID    int64   `json:"category_id"`
	SubCategoryID int64   `json:"sub_category_id"`
	DeviceName    string  `json:"device_name"` // 前端展示为"设备型号"(需与安装数量登记的"设备型号"一致才能自动同步)
	Brand         string  `json:"brand"`        // 设备品牌
	Unit          string  `json:"unit"`
	DrawingQty    float64 `json:"drawing_qty"`
	ListQty       float64 `json:"list_qty"`
	ArrivalQty    float64 `json:"arrival_qty"`
	ActualQty     float64 `json:"actual_qty"`
	Remark        string  `json:"remark"`
	UpdatedAt     string  `json:"updated_at"`
	UpdatedBy     string  `json:"updated_by"`
	DiffList      float64 `json:"diff_list"`      // actual - list(实际 vs 清单)
	DiffDrawing   float64 `json:"diff_drawing"`   // actual - drawing(实际 vs 图纸)
	DiffArrival   float64 `json:"diff_arrival"`   // arrival - list(到货 vs 清单,是否到齐)
	DiffInstalled float64 `json:"diff_installed"` // actual - arrival(实际 vs 到货,装的比到的多则异常)
}

var qtyCols = "id,project_id,COALESCE(category,''),category_id,sub_category_id,device_name,COALESCE(brand,''),COALESCE(unit,''),drawing_qty,list_qty,arrival_qty,actual_qty,COALESCE(remark,''),COALESCE(updated_at,''),COALESCE(updated_by,'')"

func scanQty(row interface{ Scan(...any) error }) (QuantityItem, error) {
	var it QuantityItem
	err := row.Scan(&it.ID, &it.ProjectID, &it.Category, &it.CategoryID, &it.SubCategoryID, &it.DeviceName, &it.Brand, &it.Unit, &it.DrawingQty, &it.ListQty, &it.ArrivalQty, &it.ActualQty, &it.Remark, &it.UpdatedAt, &it.UpdatedBy)
	return it, err
}

func fillQtyDiffs(it *QuantityItem) {
	it.DiffList = it.ActualQty - it.ListQty
	it.DiffDrawing = it.ActualQty - it.DrawingQty
	it.DiffArrival = it.ArrivalQty - it.ListQty
	it.DiffInstalled = it.ActualQty - it.ArrivalQty
}

func registerQuantityRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/quantity", requireAuth(listQuantity))
	mux.HandleFunc("POST /api/quantity", requireModule("quantity", createQuantity))
	mux.HandleFunc("PUT /api/quantity/{id}", requireModule("quantity", updateQuantity))
	mux.HandleFunc("DELETE /api/quantity/{id}", requireAdmin(deleteQuantity))
}

func listQuantity(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	projectID := queryInt(r, "project_id", 0)
	q := "SELECT " + qtyCols + " FROM quantity_items"
	args := []any{}
	if projectID > 0 {
		if !hasProjectAccess(s, projectID) {
			writeErr(w, 403, "没有该项目的访问权限")
			return
		}
		q += " WHERE project_id=?"
		args = append(args, projectID)
	} else {
		q += " WHERE 1=1" + scopeFilterSQL(s, "project_id", &args)
	}
	q += " ORDER BY id DESC"
	rows, err := db.conn.Query(q, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []QuantityItem{}
	for rows.Next() {
		it, err := scanQty(rows)
		if err != nil {
			continue
		}
		fillQtyDiffs(&it)
		list = append(list, it)
	}
	writeJSON(w, list)
}

func qtyMap(it QuantityItem) map[string]string {
	return map[string]string{
		"category":    it.Category,
		"device_name": it.DeviceName,
		"brand":       it.Brand,
		"unit":        it.Unit,
		"drawing_qty": strconv.FormatFloat(it.DrawingQty, 'f', -1, 64),
		"list_qty":    strconv.FormatFloat(it.ListQty, 'f', -1, 64),
		"arrival_qty": strconv.FormatFloat(it.ArrivalQty, 'f', -1, 64),
		"actual_qty":  strconv.FormatFloat(it.ActualQty, 'f', -1, 64),
		"remark":      it.Remark,
	}
}

func createQuantity(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var it QuantityItem
	if err := json.NewDecoder(r.Body).Decode(&it); err != nil || it.DeviceName == "" || it.ProjectID == 0 {
		writeErr(w, 400, "设备型号和所属项目不能为空")
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
	it.Category = combinedCategoryLabel(mainName, subName)
	it.UpdatedAt = nowStr()
	it.UpdatedBy = s.Username
	res, err := db.conn.Exec(`INSERT INTO quantity_items(project_id,category,category_id,sub_category_id,device_name,brand,unit,drawing_qty,list_qty,arrival_qty,actual_qty,remark,updated_at,updated_by)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, it.ProjectID, it.Category, it.CategoryID, it.SubCategoryID, it.DeviceName, it.Brand, it.Unit, it.DrawingQty, it.ListQty, it.ArrivalQty, it.ActualQty, it.Remark, it.UpdatedAt, it.UpdatedBy)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	it.ID = id
	diffAndLog(s, "create", "quantity_item", id, nil, qtyMap(it))
	fillQtyDiffs(&it)
	writeJSON(w, it)
}

func updateQuantity(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	row := db.conn.QueryRow("SELECT "+qtyCols+" FROM quantity_items WHERE id=?", id)
	old, err := scanQty(row)
	if err != nil {
		writeErr(w, 404, "记录不存在")
		return
	}
	if !hasProjectAccess(s, old.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	var it QuantityItem
	if err := json.NewDecoder(r.Body).Decode(&it); err != nil {
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
	it.Category = combinedCategoryLabel(mainName, subName)
	it.ID = id
	it.ProjectID = old.ProjectID
	it.UpdatedAt = nowStr()
	it.UpdatedBy = s.Username
	_, err = db.conn.Exec(`UPDATE quantity_items SET category=?,category_id=?,sub_category_id=?,device_name=?,brand=?,unit=?,drawing_qty=?,list_qty=?,arrival_qty=?,actual_qty=?,remark=?,updated_at=?,updated_by=? WHERE id=?`,
		it.Category, it.CategoryID, it.SubCategoryID, it.DeviceName, it.Brand, it.Unit, it.DrawingQty, it.ListQty, it.ArrivalQty, it.ActualQty, it.Remark, it.UpdatedAt, it.UpdatedBy, id)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	diffAndLog(s, "update", "quantity_item", id, qtyMap(old), qtyMap(it))
	fillQtyDiffs(&it)
	writeJSON(w, it)
}

func deleteQuantity(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	row := db.conn.QueryRow("SELECT "+qtyCols+" FROM quantity_items WHERE id=?", id)
	old, _ := scanQty(row)
	if !hasProjectAccess(s, old.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	if _, err := db.conn.Exec(`DELETE FROM quantity_items WHERE id=?`, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	diffAndLog(s, "delete", "quantity_item", id, qtyMap(old), nil)
	writeJSON(w, map[string]any{"ok": true})
}
