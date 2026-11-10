package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// logAudit 记录一条字段级别的修改履历
func logAudit(s *Session, action, entity string, recordID int64, field, before, after string) {
	if before == after {
		return
	}
	_, err := db.conn.Exec(`INSERT INTO audit_logs(user_id,username,action,entity,record_id,field,before_val,after_val,created_at)
		VALUES (?,?,?,?,?,?,?,?,?)`,
		s.UserID, s.Username, action, entity, recordID, field, before, after, nowStr())
	if err != nil {
		fmt.Println("写入审计日志失败:", err)
	}
}

// diffAndLog 对比两个 map,把变化的字段逐条写入审计日志
func diffAndLog(s *Session, action, entity string, recordID int64, before, after map[string]string) {
	if action == "create" {
		for k, v := range after {
			if v != "" {
				logAudit(s, action, entity, recordID, k, "", v)
			}
		}
		return
	}
	if action == "delete" {
		for k, v := range before {
			if v != "" {
				logAudit(s, action, entity, recordID, k, v, "")
			}
		}
		return
	}
	for k, nv := range after {
		ov := before[k]
		if ov != nv {
			logAudit(s, action, entity, recordID, k, ov, nv)
		}
	}
}

func registerAuditRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/audit", requireAuth(handleAuditList))
	mux.HandleFunc("GET /api/audit/cleanup-preview", requireAdmin(auditCleanupPreview))
	mux.HandleFunc("POST /api/audit/cleanup", requireAdmin(auditCleanup))
}

func handleAuditList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	entity := q.Get("entity")
	username := q.Get("username")
	page := queryInt(r, "page", 1)
	pageSize := int64(50)
	offset := (page - 1) * pageSize

	where := "WHERE 1=1"
	args := []any{}
	if entity != "" {
		where += " AND entity=?"
		args = append(args, entity)
	}
	if username != "" {
		where += " AND username LIKE ?"
		args = append(args, "%"+username+"%")
	}

	var total int64
	db.conn.QueryRow("SELECT COUNT(*) FROM audit_logs "+where, args...).Scan(&total)

	args2 := append(append([]any{}, args...), pageSize, offset)
	rows, err := db.conn.Query(`SELECT id,user_id,username,action,entity,record_id,field,before_val,after_val,created_at
		FROM audit_logs `+where+` ORDER BY id DESC LIMIT ? OFFSET ?`, args2...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()

	type Row struct {
		ID       int64  `json:"id"`
		UserID   int64  `json:"user_id"`
		Username string `json:"username"`
		Action   string `json:"action"`
		Entity   string `json:"entity"`
		RecordID int64  `json:"record_id"`
		Field    string `json:"field"`
		Before   string `json:"before_val"`
		After    string `json:"after_val"`
		At       string `json:"created_at"`
	}
	list := []Row{}
	for rows.Next() {
		var it Row
		rows.Scan(&it.ID, &it.UserID, &it.Username, &it.Action, &it.Entity, &it.RecordID, &it.Field, &it.Before, &it.After, &it.At)
		list = append(list, it)
	}
	writeJSON(w, map[string]any{"total": total, "items": list, "page": page})
}

// auditCleanupPreview 预览"清理N天前的日志"会删掉多少条,供前端弹窗二次确认时展示真实数量
func auditCleanupPreview(w http.ResponseWriter, r *http.Request) {
	days := queryInt(r, "days", 90)
	if days <= 0 {
		writeErr(w, 400, "天数必须大于0")
		return
	}
	cutoff := cutoffDate(days)
	var count int64
	db.conn.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE created_at < ?`, cutoff).Scan(&count)
	writeJSON(w, map[string]any{"count": count, "cutoff": cutoff})
}

// auditCleanup 清理指定天数之前的审计日志(仅管理员),清理动作本身会被记一条新日志,
// 保证"日志被清理过"这件事本身留痕,不会变成谁都能悄无声息地删掉全部记录。
func auditCleanup(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var body struct {
		Days int64 `json:"days"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Days <= 0 {
		writeErr(w, 400, "请指定保留天数(大于0)")
		return
	}
	cutoff := cutoffDate(body.Days)
	var count int64
	db.conn.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE created_at < ?`, cutoff).Scan(&count)
	if count == 0 {
		writeJSON(w, map[string]any{"deleted": 0})
		return
	}
	if _, err := db.conn.Exec(`DELETE FROM audit_logs WHERE created_at < ?`, cutoff); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	// 清理动作本身也记一条日志,保留"何时被谁清理过、清理了多少条"这个事实,不受本次清理影响(清理条件是 created_at < cutoff,这条新日志的时间必然更晚)
	logAudit(s, "delete", "audit_log", 0, "cleanup", "",
		fmt.Sprintf("清理了 %d 条 %s 之前的历史日志(保留最近%d天)", count, cutoff, body.Days))
	writeJSON(w, map[string]any{"deleted": count})
}

func cutoffDate(days int64) string {
	return time.Now().AddDate(0, 0, int(-days)).Format("2006-01-02 15:04:05")
}
