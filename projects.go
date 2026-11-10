package main

import (
	"encoding/json"
	"fmt"
	"net/http"
)

type Project struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Area      string `json:"area"`
	CreatedAt string `json:"created_at"`
}

func registerProjectRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects", requireAuth(listProjects))
	mux.HandleFunc("POST /api/projects", requireModule("projects", createProject))
	mux.HandleFunc("GET /api/projects/{id}/impact", requireAuth(projectImpact))
	mux.HandleFunc("DELETE /api/projects/{id}", requireAdmin(deleteProject))
}

func listProjects(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	args := []any{}
	q := `SELECT id,name,area,created_at FROM projects WHERE 1=1` + scopeFilterSQL(s, "id", &args) + ` ORDER BY id DESC`
	rows, err := db.conn.Query(q, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []Project{}
	for rows.Next() {
		var p Project
		rows.Scan(&p.ID, &p.Name, &p.Area, &p.CreatedAt)
		list = append(list, p)
	}
	writeJSON(w, list)
}

func createProject(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var p Project
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil || p.Name == "" {
		writeErr(w, 400, "项目名称不能为空")
		return
	}
	p.CreatedAt = nowStr()
	res, err := db.conn.Exec(`INSERT INTO projects(name,area,created_at) VALUES (?,?,?)`, p.Name, p.Area, p.CreatedAt)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	p.ID = id
	diffAndLog(s, "create", "project", id, nil, map[string]string{"name": p.Name, "area": p.Area})
	writeJSON(w, p)
}

// projectImpact 统计删除该项目会连带删掉多少条关联记录,供前端删除前弹窗提示
func projectImpact(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	if !hasProjectAccess(s, id) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	counts := map[string]int{}
	tables := map[string]string{
		"devices":  "terminal_devices",
		"quantity": "quantity_items",
		"install":  "install_records",
		"vault":    "core_devices",
		"switches": "switches",
	}
	for key, table := range tables {
		var n int
		db.conn.QueryRow("SELECT COUNT(*) FROM "+table+" WHERE project_id=?", id).Scan(&n)
		counts[key] = n
	}
	writeJSON(w, counts)
}

func deleteProject(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var name string
	db.conn.QueryRow(`SELECT name FROM projects WHERE id=?`, id).Scan(&name)

	// 级联删除该项目名下的全部关联数据,避免留下访问不到的"僵尸数据"
	var devCount, qtyCount, instCount, vaultCount, swCount int
	db.conn.QueryRow(`SELECT COUNT(*) FROM terminal_devices WHERE project_id=?`, id).Scan(&devCount)
	db.conn.QueryRow(`SELECT COUNT(*) FROM quantity_items WHERE project_id=?`, id).Scan(&qtyCount)
	db.conn.QueryRow(`SELECT COUNT(*) FROM install_records WHERE project_id=?`, id).Scan(&instCount)
	db.conn.QueryRow(`SELECT COUNT(*) FROM core_devices WHERE project_id=?`, id).Scan(&vaultCount)
	db.conn.QueryRow(`SELECT COUNT(*) FROM switches WHERE project_id=?`, id).Scan(&swCount)

	// 级联删除语句按顺序执行,任何一条失败都立刻中止并如实报错,
	// 避免"日志显示只删了一半、但接口却告诉用户全部成功"的不一致状态。
	cascadeStmts := []string{
		`DELETE FROM switch_ports WHERE switch_id IN (SELECT id FROM switches WHERE project_id=?)`,
		`DELETE FROM switches WHERE project_id=?`,
		`DELETE FROM core_devices WHERE project_id=?`,
		`DELETE FROM install_records WHERE project_id=?`,
		`DELETE FROM quantity_items WHERE project_id=?`,
		`DELETE FROM terminal_devices WHERE project_id=?`,
	}
	for _, stmt := range cascadeStmts {
		if _, err := db.conn.Exec(stmt, id); err != nil {
			writeErr(w, 500, "级联删除关联数据失败: "+err.Error())
			return
		}
	}

	if _, err := db.conn.Exec(`DELETE FROM projects WHERE id=?`, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	logAudit(s, "delete", "project", id, "cascade",
		"", fmt.Sprintf("删除项目[%s],同时级联删除:设备台账%d条、工程量%d条、安装登记%d条、密码本%d条、交换机%d条",
			name, devCount, qtyCount, instCount, vaultCount, swCount))
	writeJSON(w, map[string]any{"ok": true})
}
