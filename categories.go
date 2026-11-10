package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
)

type Category struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	ParentID  int64  `json:"parent_id"` // 0 = 总分类(顶级),非0 = 子分类,指向所属总分类ID
	CreatedAt string `json:"created_at"`
}

func registerCategoryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/categories", requireAuth(listCategories))
	mux.HandleFunc("POST /api/categories", requireModule("categories", createCategory))
	mux.HandleFunc("PUT /api/categories/{id}", requireModule("categories", updateCategory))
	mux.HandleFunc("GET /api/categories/{id}/impact", requireAuth(categoryImpact))
	mux.HandleFunc("DELETE /api/categories/{id}", requireAdmin(deleteCategory))
}

func listCategories(w http.ResponseWriter, r *http.Request) {
	rows, err := db.conn.Query(`SELECT id,name,parent_id,created_at FROM categories ORDER BY parent_id, id`)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []Category{}
	for rows.Next() {
		var c Category
		rows.Scan(&c.ID, &c.Name, &c.ParentID, &c.CreatedAt)
		list = append(list, c)
	}
	writeJSON(w, list)
}

func createCategory(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var c Category
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil || c.Name == "" {
		writeErr(w, 400, "分类名称不能为空")
		return
	}
	if c.ParentID != 0 {
		var cnt int
		db.conn.QueryRow(`SELECT COUNT(*) FROM categories WHERE id=? AND parent_id=0`, c.ParentID).Scan(&cnt)
		if cnt == 0 {
			writeErr(w, 400, "所属总分类不存在")
			return
		}
	}
	c.CreatedAt = nowStr()
	res, err := db.conn.Exec(`INSERT INTO categories(name,parent_id,created_at) VALUES (?,?,?)`, c.Name, c.ParentID, c.CreatedAt)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	c.ID = id
	entity := "category_main"
	if c.ParentID != 0 {
		entity = "category_sub"
	}
	diffAndLog(s, "create", entity, id, nil, map[string]string{"name": c.Name})
	writeJSON(w, c)
}

func updateCategory(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var old Category
	err = db.conn.QueryRow(`SELECT id,name,parent_id,created_at FROM categories WHERE id=?`, id).Scan(&old.ID, &old.Name, &old.ParentID, &old.CreatedAt)
	if err != nil {
		writeErr(w, 404, "记录不存在")
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		writeErr(w, 400, "分类名称不能为空")
		return
	}
	if _, err := db.conn.Exec(`UPDATE categories SET name=? WHERE id=?`, body.Name, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	entity := "category_main"
	if old.ParentID != 0 {
		entity = "category_sub"
	}
	diffAndLog(s, "update", entity, id, map[string]string{"name": old.Name}, map[string]string{"name": body.Name})
	writeJSON(w, map[string]any{"id": id, "name": body.Name, "parent_id": old.ParentID})
}

// categoryIDsToDelete 返回删除该分类会一并波及的分类ID集合:
// 如果是总分类,包含自身+全部子分类ID;如果是子分类,只有自身。
func categoryIDsToDelete(id int64) []int64 {
	ids := []int64{id}
	rows, err := db.conn.Query(`SELECT id FROM categories WHERE parent_id=?`, id)
	if err != nil {
		return ids
	}
	defer rows.Close()
	for rows.Next() {
		var subID int64
		if rows.Scan(&subID) == nil {
			ids = append(ids, subID)
		}
	}
	return ids
}

func idsPlaceholder(ids []int64) (string, []any) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, v := range ids {
		args[i] = v
	}
	return placeholders, args
}

// categoryLinkedTables 列出所有引用了分类(category_id/sub_category_id)的业务表,
// categoryImpact 和 deleteCategory 共用这份表清单统计/清理关联记录,避免三处重复的 SQL 拼接。
var categoryLinkedTables = map[string]string{"devices": "terminal_devices", "quantity": "quantity_items", "install": "install_records"}

// countCategoryRefs 统计 ids(某分类+其子分类)在各关联表中分别被引用了多少条记录
func countCategoryRefs(ids []int64) map[string]int {
	ph, args := idsPlaceholder(ids)
	dupArgs := append(append([]any{}, args...), args...)
	counts := map[string]int{}
	for key, table := range categoryLinkedTables {
		var n int
		q := fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE category_id IN (%s) OR sub_category_id IN (%s)", table, ph, ph)
		if err := db.conn.QueryRow(q, dupArgs...).Scan(&n); err != nil {
			log.Printf("统计分类关联记录失败(table=%s): %v", table, err)
		}
		counts[key] = n
	}
	return counts
}

// deleteCategoryRefs 级联删除 ids(某分类+其子分类)在各关联表中的记录,返回首个失败的错误(如果有)
func deleteCategoryRefs(ids []int64) error {
	ph, args := idsPlaceholder(ids)
	dupArgs := append(append([]any{}, args...), args...)
	for _, table := range categoryLinkedTables {
		q := fmt.Sprintf("DELETE FROM %s WHERE category_id IN (%s) OR sub_category_id IN (%s)", table, ph, ph)
		if _, err := db.conn.Exec(q, dupArgs...); err != nil {
			return fmt.Errorf("清理关联表 %s 失败: %w", table, err)
		}
	}
	return nil
}

// categoryImpact 统计删除该分类(及其子分类)会连带删掉多少条关联记录,供前端删除前弹窗提示
func categoryImpact(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	ids := categoryIDsToDelete(id)
	counts := countCategoryRefs(ids)
	counts["sub_categories"] = len(ids) - 1
	writeJSON(w, counts)
}

// deleteCategory 删除一个总分类会级联删除其下所有子分类,
// 以及所有引用了这些分类的设备台账/工程量/安装登记记录,避免留下访问不到的"僵尸数据"。
func deleteCategory(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var name string
	var parentID int64
	err = db.conn.QueryRow(`SELECT name,parent_id FROM categories WHERE id=?`, id).Scan(&name, &parentID)
	if err != nil {
		writeErr(w, 404, "记录不存在")
		return
	}

	ids := categoryIDsToDelete(id)
	refCounts := countCategoryRefs(ids)

	if err := deleteCategoryRefs(ids); err != nil {
		writeErr(w, 500, err.Error())
		return
	}

	if parentID == 0 {
		if _, err := db.conn.Exec(`DELETE FROM categories WHERE parent_id=?`, id); err != nil {
			writeErr(w, 500, "删除子分类失败: "+err.Error())
			return
		}
	}
	if _, err := db.conn.Exec(`DELETE FROM categories WHERE id=?`, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	entity := "category_main"
	if parentID != 0 {
		entity = "category_sub"
	}
	logAudit(s, "delete", entity, id, "cascade", "",
		fmt.Sprintf("删除分类[%s],同时级联删除:设备台账%d条、工程量%d条、安装登记%d条(含子分类%d个)",
			name, refCounts["devices"], refCounts["quantity"], refCounts["install"], len(ids)-1))
	writeJSON(w, map[string]any{"ok": true})
}

// findOrCreateCategory 按名称查找分类,不存在则自动创建(用于Excel导入时按文本自动建立分类)
// parentID=0 表示查找/创建总分类;否则在该总分类下查找/创建同名子分类
func findOrCreateCategory(name string, parentID int64) int64 {
	if name == "" {
		return 0
	}
	var id int64
	err := db.conn.QueryRow(`SELECT id FROM categories WHERE name=? AND parent_id=?`, name, parentID).Scan(&id)
	if err == nil {
		return id
	}
	res, err := db.conn.Exec(`INSERT INTO categories(name,parent_id,created_at) VALUES (?,?,?)`, name, parentID, nowStr())
	if err != nil {
		return 0
	}
	id, _ = res.LastInsertId()
	return id
}

// resolveCategoryNames 根据总分类ID/子分类ID查出名称,用于冗余展示字段
func resolveCategoryNames(mainID, subID int64) (string, string) {
	var mainName, subName string
	if mainID > 0 {
		db.conn.QueryRow(`SELECT name FROM categories WHERE id=?`, mainID).Scan(&mainName)
	}
	if subID > 0 {
		db.conn.QueryRow(`SELECT name FROM categories WHERE id=?`, subID).Scan(&subName)
	}
	return mainName, subName
}

func combinedCategoryLabel(mainName, subName string) string {
	if mainName == "" {
		return ""
	}
	if subName == "" {
		return mainName
	}
	return mainName + "/" + subName
}
