package main

import (
	"encoding/json"
	"net/http"
)

type Switch struct {
	ID          int64  `json:"id"`
	ProjectID   int64  `json:"project_id"`
	Name        string `json:"name"`
	Location    string `json:"location"`
	ManageIP    string `json:"manage_ip"`
	NetworkType string `json:"network_type"` // 内网/外网/监控专网
	PortCount   int    `json:"port_count"`
	Remark      string `json:"remark"`
	UpdatedAt   string `json:"updated_at"`
	UpdatedBy   string `json:"updated_by"`
}

type SwitchPort struct {
	ID              int64  `json:"id"`
	SwitchID        int64  `json:"switch_id"`
	PortNo          int    `json:"port_no"`
	NetworkType     string `json:"network_type"`
	ConnectedDevice string `json:"connected_device"`
	Remark          string `json:"remark"`
}

func registerSwitchRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/switches", requireAuth(listSwitches))
	mux.HandleFunc("POST /api/switches", requireModule("network", createSwitch))
	mux.HandleFunc("PUT /api/switches/{id}", requireModule("network", updateSwitch))
	mux.HandleFunc("DELETE /api/switches/{id}", requireAdmin(deleteSwitch))
	mux.HandleFunc("GET /api/switches/{id}/ports", requireAuth(listPorts))
	mux.HandleFunc("PUT /api/switches/{id}/ports", requireModule("network", bulkUpdatePorts))
}

func listSwitches(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	projectID := queryInt(r, "project_id", 0)
	q := `SELECT id,project_id,name,COALESCE(location,''),COALESCE(manage_ip,''),COALESCE(network_type,''),port_count,COALESCE(remark,''),COALESCE(updated_at,''),COALESCE(updated_by,'') FROM switches`
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
	list := []Switch{}
	for rows.Next() {
		var sw Switch
		rows.Scan(&sw.ID, &sw.ProjectID, &sw.Name, &sw.Location, &sw.ManageIP, &sw.NetworkType, &sw.PortCount, &sw.Remark, &sw.UpdatedAt, &sw.UpdatedBy)
		list = append(list, sw)
	}
	writeJSON(w, list)
}

func swMap(sw Switch) map[string]string {
	return map[string]string{
		"name": sw.Name, "location": sw.Location, "manage_ip": sw.ManageIP,
		"network_type": sw.NetworkType, "remark": sw.Remark,
	}
}

func createSwitch(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var sw Switch
	if err := json.NewDecoder(r.Body).Decode(&sw); err != nil || sw.Name == "" {
		writeErr(w, 400, "交换机名称不能为空")
		return
	}
	if sw.ProjectID == 0 {
		writeErr(w, 400, "请选择所属项目")
		return
	}
	if !hasProjectAccess(s, sw.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	if sw.PortCount == 0 {
		sw.PortCount = 24
	}
	sw.UpdatedAt = nowStr()
	sw.UpdatedBy = s.Username

	// 新建交换机 + 初始化全部端口放在同一个事务里:要么两者都成功,要么都不生效,
	// 避免"交换机建好了、但端口没建全"这种一半状态(之前是分开两步执行,端口初始化如果中途失败不会回滚)。
	tx, err := db.conn.Begin()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	res, err := tx.Exec(`INSERT INTO switches(project_id,name,location,manage_ip,network_type,port_count,remark,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?)`,
		sw.ProjectID, sw.Name, sw.Location, sw.ManageIP, sw.NetworkType, sw.PortCount, sw.Remark, sw.UpdatedAt, sw.UpdatedBy)
	if err != nil {
		tx.Rollback()
		writeErr(w, 500, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	for i := 1; i <= sw.PortCount; i++ {
		if _, err := tx.Exec(`INSERT INTO switch_ports(switch_id,port_no,network_type,connected_device,remark) VALUES (?,?,?,?,?)`, id, i, sw.NetworkType, "", ""); err != nil {
			tx.Rollback()
			writeErr(w, 500, "初始化端口失败: "+err.Error())
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	sw.ID = id
	diffAndLog(s, "create", "switch", id, nil, swMap(sw))
	writeJSON(w, sw)
}

func updateSwitch(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var old Switch
	err = db.conn.QueryRow(`SELECT id,project_id,name,COALESCE(location,''),COALESCE(manage_ip,''),COALESCE(network_type,''),port_count,COALESCE(remark,''),COALESCE(updated_at,''),COALESCE(updated_by,'') FROM switches WHERE id=?`, id).
		Scan(&old.ID, &old.ProjectID, &old.Name, &old.Location, &old.ManageIP, &old.NetworkType, &old.PortCount, &old.Remark, &old.UpdatedAt, &old.UpdatedBy)
	if err != nil {
		writeErr(w, 404, "记录不存在")
		return
	}
	if !hasProjectAccess(s, old.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	var sw Switch
	if err := json.NewDecoder(r.Body).Decode(&sw); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	sw.ID = id
	sw.ProjectID = old.ProjectID // 所属项目创建后不允许改
	sw.PortCount = old.PortCount
	sw.UpdatedAt = nowStr()
	sw.UpdatedBy = s.Username
	_, err = db.conn.Exec(`UPDATE switches SET name=?,location=?,manage_ip=?,network_type=?,remark=?,updated_at=?,updated_by=? WHERE id=?`,
		sw.Name, sw.Location, sw.ManageIP, sw.NetworkType, sw.Remark, sw.UpdatedAt, sw.UpdatedBy, id)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	diffAndLog(s, "update", "switch", id, swMap(old), swMap(sw))
	writeJSON(w, sw)
}

func deleteSwitch(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var name string
	var projectID int64
	db.conn.QueryRow(`SELECT name,project_id FROM switches WHERE id=?`, id).Scan(&name, &projectID)
	if !hasProjectAccess(s, projectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	if _, err := db.conn.Exec(`DELETE FROM switch_ports WHERE switch_id=?`, id); err != nil {
		writeErr(w, 500, "清理端口数据失败: "+err.Error())
		return
	}
	if _, err := db.conn.Exec(`DELETE FROM switches WHERE id=?`, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	diffAndLog(s, "delete", "switch", id, map[string]string{"name": name}, nil)
	writeJSON(w, map[string]any{"ok": true})
}

func listPorts(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var projectID int64
	if err := db.conn.QueryRow(`SELECT project_id FROM switches WHERE id=?`, id).Scan(&projectID); err != nil {
		writeErr(w, 404, "记录不存在")
		return
	}
	if !hasProjectAccess(s, projectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	rows, err := db.conn.Query(`SELECT id,switch_id,port_no,COALESCE(network_type,''),COALESCE(connected_device,''),COALESCE(remark,'') FROM switch_ports WHERE switch_id=? ORDER BY port_no`, id)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []SwitchPort{}
	for rows.Next() {
		var p SwitchPort
		if err := rows.Scan(&p.ID, &p.SwitchID, &p.PortNo, &p.NetworkType, &p.ConnectedDevice, &p.Remark); err != nil {
			continue
		}
		list = append(list, p)
	}
	writeJSON(w, list)
}

func bulkUpdatePorts(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var projectID int64
	if err := db.conn.QueryRow(`SELECT project_id FROM switches WHERE id=?`, id).Scan(&projectID); err != nil {
		writeErr(w, 404, "记录不存在")
		return
	}
	if !hasProjectAccess(s, projectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	var ports []SwitchPort
	if err := json.NewDecoder(r.Body).Decode(&ports); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	for _, p := range ports {
		var old SwitchPort
		db.conn.QueryRow(`SELECT network_type,connected_device,remark FROM switch_ports WHERE switch_id=? AND port_no=?`, id, p.PortNo).
			Scan(&old.NetworkType, &old.ConnectedDevice, &old.Remark)
		_, err := db.conn.Exec(`UPDATE switch_ports SET network_type=?,connected_device=?,remark=? WHERE switch_id=? AND port_no=?`,
			p.NetworkType, p.ConnectedDevice, p.Remark, id, p.PortNo)
		if err == nil {
			diffAndLog(s, "update", "switch_port", id*10000+int64(p.PortNo),
				map[string]string{"network_type": old.NetworkType, "connected_device": old.ConnectedDevice, "remark": old.Remark},
				map[string]string{"network_type": p.NetworkType, "connected_device": p.ConnectedDevice, "remark": p.Remark})
		}
	}
	writeJSON(w, map[string]any{"ok": true})
}
