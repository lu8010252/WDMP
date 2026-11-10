package main

import (
	"encoding/json"
	"fmt"
	"net/http"
)

type UserOut struct {
	ID           int64    `json:"id"`
	Username     string   `json:"username"`
	Role         string   `json:"role"`
	Permissions  []string `json:"permissions"`
	ProjectScope []int64  `json:"project_scope"` // 空 = 不限制项目(能看所有项目)
	CreatedAt    string   `json:"created_at"`
}

func registerUserRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/users", requireAdmin(listUsers))
	mux.HandleFunc("POST /api/users", requireAdmin(createUser))
	mux.HandleFunc("PUT /api/users/{id}/password", requireAdmin(resetUserPassword))
	mux.HandleFunc("PUT /api/users/{id}/permissions", requireAdmin(updateUserPermissions))
	mux.HandleFunc("DELETE /api/users/{id}", requireAdmin(deleteUser))
	mux.HandleFunc("PUT /api/me/password", requireAuth(changeOwnPassword))
}

// changeOwnPassword 让用户自己改密码(之前只有管理员能重置,普通用户拿到初始密码后没法自己换)
func changeOwnPassword(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var body struct {
		Old string `json:"old_password"`
		New string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if len(body.New) < 6 {
		writeErr(w, 400, "新密码至少需要6位")
		return
	}
	key := "chpw|" + fmt.Sprint(s.UserID)
	if locked, remain := checkLoginLocked(key); locked {
		writeErr(w, http.StatusTooManyRequests, fmt.Sprintf("旧密码连续输错次数过多,请 %d 秒后再试", remain))
		return
	}
	var hash string
	if err := db.conn.QueryRow(`SELECT password_hash FROM users WHERE id=?`, s.UserID).Scan(&hash); err != nil || !checkPassword(hash, body.Old) {
		recordLoginFail(key)
		writeErr(w, 400, "旧密码不正确")
		return
	}
	recordLoginSuccess(key)
	nh, err := hashPassword(body.New)
	if err != nil {
		writeErr(w, 500, "密码加密失败")
		return
	}
	if _, err := db.conn.Exec(`UPDATE users SET password_hash=? WHERE id=?`, nh, s.UserID); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	keep := ""
	if c, err := r.Cookie("sid"); err == nil {
		keep = c.Value
	}
	destroyUserSessions(s.UserID, keep) // 其它设备上的旧登录全部下线,当前这个保留
	logAudit(s, "update", "user", s.UserID, "password", "", "["+s.Username+"]修改了自己的密码")
	writeJSON(w, map[string]any{"ok": true})
}

func listUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := db.conn.Query(`SELECT id,username,role,COALESCE(permissions,'[]'),COALESCE(project_scope,'[]'),created_at FROM users ORDER BY id`)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []UserOut{}
	for rows.Next() {
		var u UserOut
		var permJSON, scopeJSON string
		if err := rows.Scan(&u.ID, &u.Username, &u.Role, &permJSON, &scopeJSON, &u.CreatedAt); err != nil {
			continue
		}
		u.Permissions = decodePermissions(permJSON)
		u.ProjectScope = decodeProjectScope(scopeJSON)
		list = append(list, u)
	}
	writeJSON(w, list)
}

func createUser(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var body struct {
		Username     string   `json:"username"`
		Password     string   `json:"password"`
		Role         string   `json:"role"`
		Permissions  []string `json:"permissions"`
		ProjectScope []int64  `json:"project_scope"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.Password == "" {
		writeErr(w, 400, "用户名和密码不能为空")
		return
	}
	if body.Role != "admin" {
		body.Role = "worker"
	}
	hash, err := hashPassword(body.Password)
	if err != nil {
		writeErr(w, 500, "密码加密失败")
		return
	}
	permJSON := encodePermissions(body.Permissions)
	scopeJSON := encodeProjectScope(body.ProjectScope)
	res, err := db.conn.Exec(`INSERT INTO users(username,password_hash,role,permissions,project_scope,created_at) VALUES (?,?,?,?,?,?)`,
		body.Username, hash, body.Role, permJSON, scopeJSON, nowStr())
	if err != nil {
		writeErr(w, 400, "用户名已存在")
		return
	}
	id, _ := res.LastInsertId()
	perms := decodePermissions(permJSON)
	scope := decodeProjectScope(scopeJSON)
	diffAndLog(s, "create", "user", id, nil, map[string]string{"username": body.Username, "role": body.Role, "permissions": permJSON, "project_scope": scopeJSON})
	writeJSON(w, map[string]any{"id": id, "username": body.Username, "role": body.Role, "permissions": perms, "project_scope": scope})
}

// updateUserPermissions 管理员为某个用户分配角色、模块权限、以及能看到哪些项目。
// 传入的权限/项目列表都会先经过白名单过滤,不合法的值会被静默丢弃,不会报错中断。
func updateUserPermissions(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var body struct {
		Role         string   `json:"role"`
		Permissions  []string `json:"permissions"`
		ProjectScope []int64  `json:"project_scope"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if body.Role != "admin" {
		body.Role = "worker"
	}
	if id == s.UserID && body.Role != "admin" {
		writeErr(w, 400, "不能取消自己的管理员身份,请让其他管理员操作")
		return
	}

	var oldRole, oldPermJSON, oldScopeJSON, uname string
	if err := db.conn.QueryRow(`SELECT role,COALESCE(permissions,'[]'),COALESCE(project_scope,'[]'),username FROM users WHERE id=?`, id).Scan(&oldRole, &oldPermJSON, &oldScopeJSON, &uname); err != nil {
		writeErr(w, 404, "用户不存在")
		return
	}

	newPermJSON := encodePermissions(body.Permissions)
	newScopeJSON := encodeProjectScope(body.ProjectScope)
	if _, err := db.conn.Exec(`UPDATE users SET role=?, permissions=?, project_scope=? WHERE id=?`, body.Role, newPermJSON, newScopeJSON, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	logAudit(s, "update", "user", id, "role", oldRole, body.Role)
	logAudit(s, "update", "user", id, "permissions", oldPermJSON, newPermJSON)
	logAudit(s, "update", "user", id, "project_scope", oldScopeJSON, newScopeJSON)
	writeJSON(w, map[string]any{"ok": true, "username": uname, "role": body.Role, "permissions": decodePermissions(newPermJSON), "project_scope": decodeProjectScope(newScopeJSON)})
}

func resetUserPassword(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Password == "" {
		writeErr(w, 400, "新密码不能为空")
		return
	}
	hash, err := hashPassword(body.Password)
	if err != nil {
		writeErr(w, 500, "密码加密失败")
		return
	}
	var uname string
	db.conn.QueryRow(`SELECT username FROM users WHERE id=?`, id).Scan(&uname)
	if _, err := db.conn.Exec(`UPDATE users SET password_hash=? WHERE id=?`, hash, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	destroyUserSessions(id, "")
	logAudit(s, "update", "user", id, "password", "", "管理员重置了["+uname+"]的密码")
	writeJSON(w, map[string]any{"ok": true})
}

func deleteUser(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	if id == s.UserID {
		writeErr(w, 400, "不能删除自己")
		return
	}
	var uname string
	db.conn.QueryRow(`SELECT username FROM users WHERE id=?`, id).Scan(&uname)
	if _, err := db.conn.Exec(`DELETE FROM users WHERE id=?`, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	destroyUserSessions(id, "")
	diffAndLog(s, "delete", "user", id, map[string]string{"username": uname}, nil)
	writeJSON(w, map[string]any{"ok": true})
}
