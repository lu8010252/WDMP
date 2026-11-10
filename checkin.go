package main

import (
	"encoding/json"
	"net/http"
)

// DeviceCheck 是一条"现场核验"记录:谁在什么时候扫码确认过这台设备状态正常/异常。
type DeviceCheck struct {
	ID        int64  `json:"id"`
	DeviceID  int64  `json:"device_id"`
	CheckedBy string `json:"checked_by"`
	Result    string `json:"result"` // 正常 / 异常
	Note      string `json:"note"`
	CreatedAt string `json:"created_at"`
}

func registerCheckinRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/devices/{id}/checkin-info", requireAuth(deviceCheckinInfo))
	mux.HandleFunc("POST /api/devices/{id}/checkin", requireAuth(createDeviceCheck))
}

// deviceCheckinInfo 是手机扫码之后打开的核验页要用到的数据:设备基本信息 + 最近一次核验人/时间 + 最近若干条历史记录。
// 用 requireAuth 而不是 requireModule("devices",...):核验现场设备是"看一眼、确认一下"的轻量操作,
// 不属于新增/编辑设备台账,只要登录了、且对这个设备所在项目有访问权限就该能做,不需要额外给"设备台账"编辑权限。
func deviceCheckinInfo(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	row := db.conn.QueryRow("SELECT "+deviceCols+" FROM terminal_devices WHERE id=?", id)
	d, err := scanDevice(row)
	if err != nil {
		writeErr(w, 404, "设备不存在,二维码可能对应的是已删除的设备")
		return
	}
	if !hasProjectAccess(s, d.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	var projectName string
	db.conn.QueryRow(`SELECT name FROM projects WHERE id=?`, d.ProjectID).Scan(&projectName)

	rows, err := db.conn.Query(`SELECT id,device_id,checked_by,result,COALESCE(note,''),created_at FROM device_checks WHERE device_id=? ORDER BY id DESC LIMIT 10`, id)
	history := []DeviceCheck{}
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var c DeviceCheck
			if rows.Scan(&c.ID, &c.DeviceID, &c.CheckedBy, &c.Result, &c.Note, &c.CreatedAt) == nil {
				history = append(history, c)
			}
		}
	}

	writeJSON(w, map[string]any{
		"device":       d,
		"project_name": projectName,
		"history":      history,
	})
}

// createDeviceCheck 记录一次现场核验(扫码打卡),并把结果冗余同步到 terminal_devices 的
// last_checked_at/last_checked_by 字段,方便设备台账列表直接显示"最近核验"而不用每次都去查 device_checks。
func createDeviceCheck(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var projectID int64
	var deviceLabel string
	if err := db.conn.QueryRow(`SELECT project_id,category FROM terminal_devices WHERE id=?`, id).Scan(&projectID, &deviceLabel); err != nil {
		writeErr(w, 404, "设备不存在")
		return
	}
	if !hasProjectAccess(s, projectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	var body struct {
		Result string `json:"result"`
		Note   string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if body.Result != "异常" {
		body.Result = "正常"
	}
	now := nowStr()
	res, err := db.conn.Exec(`INSERT INTO device_checks(device_id,project_id,checked_by,result,note,created_at) VALUES (?,?,?,?,?,?)`,
		id, projectID, s.Username, body.Result, body.Note, now)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	checkID, _ := res.LastInsertId()
	if _, err := db.conn.Exec(`UPDATE terminal_devices SET last_checked_at=?, last_checked_by=? WHERE id=?`, now, s.Username, id); err != nil {
		writeErr(w, 500, "记录已保存,但同步设备最近核验时间失败: "+err.Error())
		return
	}
	logAudit(s, "checkin", "terminal_device", id, "checkin", "",
		"现场核验["+deviceLabel+"]:结果="+body.Result+func() string {
			if body.Note != "" {
				return " 备注=" + body.Note
			}
			return ""
		}())
	writeJSON(w, map[string]any{"ok": true, "id": checkID, "created_at": now})
}
