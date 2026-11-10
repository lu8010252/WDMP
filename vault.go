package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
)

var vaultKey []byte

// initVaultKey 首次运行自动生成 32 字节密钥,保存在数据目录,仅供本机读取
func initVaultKey(dataDir string) {
	keyPath := dataDir + "/vault.key"
	b, err := os.ReadFile(keyPath)
	if err == nil && len(b) == 32 {
		vaultKey = b
		return
	}
	key := make([]byte, 32)
	rand.Read(key)
	os.WriteFile(keyPath, key, 0600)
	vaultKey = key
}

func encryptStr(plain string) (string, error) {
	block, err := aes.NewCipher(vaultKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nonce, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(ct), nil
}

func decryptStr(enc string) (string, error) {
	if enc == "" {
		return "", nil
	}
	data, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(vaultKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", errors.New("密文长度不足")
	}
	nonce, ct := data[:gcm.NonceSize()], data[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

type CoreDevice struct {
	ID         int64  `json:"id"`
	ProjectID  int64  `json:"project_id"`
	DeviceID   int64  `json:"device_id"` // 关联的"设备台账"记录ID,0表示手动填写、不关联任何已安装设备
	Name       string `json:"name"`
	Type       string `json:"type"`
	ManageAddr string `json:"manage_addr"`
	Account    string `json:"account"`
	Password   string `json:"password,omitempty"` // 仅创建/更新/reveal 时使用,列表中不返回明文
	Remark     string `json:"remark"`
	UpdatedAt  string `json:"updated_at"`
	UpdatedBy  string `json:"updated_by"`
}

func registerVaultRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/vault", requireModule("vault", listVault))
	mux.HandleFunc("POST /api/vault", requireModule("vault", createVault))
	mux.HandleFunc("PUT /api/vault/{id}", requireModule("vault", updateVault))
	mux.HandleFunc("DELETE /api/vault/{id}", requireAdmin(deleteVault))
	mux.HandleFunc("GET /api/vault/{id}/reveal", requireModule("vault", revealVault))
}

// vaultSelectCols 用 LEFT JOIN 关联设备台账:如果密码本条目绑定了某台已安装设备(device_id>0),
// 名称/类型/管理地址就实时取设备台账当前的 分类/分类/IP,而不是创建时存的旧快照——
// 这样设备台账那边改了分类、位置或IP,密码本这里会自动跟着变,不需要手动同步两遍。
// 如果没绑定设备,或绑定的设备后来被删了,就退回使用密码本自己存的 name/type/manage_addr。
const vaultSelectCols = `cd.id, cd.project_id, cd.device_id,
	COALESCE(NULLIF(CASE WHEN cd.device_id>0 THEN td.category || CASE WHEN td.location<>'' THEN '('||td.location||')' ELSE '' END ELSE '' END,''), cd.name),
	COALESCE(NULLIF(CASE WHEN cd.device_id>0 THEN td.category ELSE '' END,''), COALESCE(cd.type,'')),
	COALESCE(NULLIF(CASE WHEN cd.device_id>0 THEN td.ip ELSE '' END,''), COALESCE(cd.manage_addr,'')),
	COALESCE(cd.account,''), COALESCE(cd.remark,''), COALESCE(cd.updated_at,''), COALESCE(cd.updated_by,'')`
const vaultFrom = `core_devices cd LEFT JOIN terminal_devices td ON td.id = cd.device_id`

func listVault(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	projectID := queryInt(r, "project_id", 0)
	q := `SELECT ` + vaultSelectCols + ` FROM ` + vaultFrom
	args := []any{}
	if projectID > 0 {
		if !hasProjectAccess(s, projectID) {
			writeErr(w, 403, "没有该项目的访问权限")
			return
		}
		q += " WHERE cd.project_id=?"
		args = append(args, projectID)
	} else {
		q += " WHERE 1=1" + scopeFilterSQL(s, "cd.project_id", &args)
	}
	q += " ORDER BY cd.id DESC"
	rows, err := db.conn.Query(q, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []CoreDevice{}
	for rows.Next() {
		var d CoreDevice
		rows.Scan(&d.ID, &d.ProjectID, &d.DeviceID, &d.Name, &d.Type, &d.ManageAddr, &d.Account, &d.Remark, &d.UpdatedAt, &d.UpdatedBy)
		d.Password = "" // 掩码显示由前端处理为 ******
		list = append(list, d)
	}
	writeJSON(w, list)
}

func vaultMap(d CoreDevice, pwLabel string) map[string]string {
	return map[string]string{
		"name": d.Name, "type": d.Type, "manage_addr": d.ManageAddr, "account": d.Account,
		"remark": d.Remark, "password": pwLabel,
	}
}

func createVault(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	var d CoreDevice
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if d.ProjectID == 0 {
		writeErr(w, 400, "请选择所属项目")
		return
	}
	if !hasProjectAccess(s, d.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	if d.DeviceID > 0 {
		// 从"已安装设备"里选的:名称/类型/管理地址直接取设备台账当前值当作初始快照
		// (后续显示时 listVault 还会实时用 JOIN 覆盖,这里存一份快照只是为了设备被删除后仍有内容可看)。
		row := db.conn.QueryRow(`SELECT project_id,category,COALESCE(location,''),COALESCE(ip,'') FROM terminal_devices WHERE id=?`, d.DeviceID)
		var devProjectID int64
		var category, location, ip string
		if err := row.Scan(&devProjectID, &category, &location, &ip); err != nil {
			writeErr(w, 400, "所选设备不存在")
			return
		}
		if devProjectID != d.ProjectID {
			writeErr(w, 400, "所选设备不属于当前项目")
			return
		}
		d.Name = category
		if location != "" {
			d.Name += "(" + location + ")"
		}
		d.Type = category
		d.ManageAddr = ip
	} else if d.Name == "" {
		writeErr(w, 400, "请选择已安装设备,或手动填写名称")
		return
	}
	enc, err := encryptStr(d.Password)
	if err != nil {
		writeErr(w, 500, "加密失败")
		return
	}
	d.UpdatedAt = nowStr()
	d.UpdatedBy = s.Username
	res, err := db.conn.Exec(`INSERT INTO core_devices(project_id,device_id,name,type,manage_addr,account,password_enc,remark,updated_at,updated_by)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, d.ProjectID, d.DeviceID, d.Name, d.Type, d.ManageAddr, d.Account, enc, d.Remark, d.UpdatedAt, d.UpdatedBy)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	d.ID = id
	diffAndLog(s, "create", "core_device", id, nil, vaultMap(d, "******(已设置)"))
	d.Password = ""
	writeJSON(w, d)
}

func updateVault(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var old CoreDevice
	var oldEnc string
	err = db.conn.QueryRow(`SELECT id,project_id,name,COALESCE(type,''),COALESCE(manage_addr,''),COALESCE(account,''),COALESCE(password_enc,''),COALESCE(remark,''),COALESCE(updated_at,''),COALESCE(updated_by,'') FROM core_devices WHERE id=?`, id).
		Scan(&old.ID, &old.ProjectID, &old.Name, &old.Type, &old.ManageAddr, &old.Account, &oldEnc, &old.Remark, &old.UpdatedAt, &old.UpdatedBy)
	if err != nil {
		writeErr(w, 404, "记录不存在")
		return
	}
	if !hasProjectAccess(s, old.ProjectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	var d CoreDevice
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if d.DeviceID > 0 {
		row := db.conn.QueryRow(`SELECT project_id,category,COALESCE(location,''),COALESCE(ip,'') FROM terminal_devices WHERE id=?`, d.DeviceID)
		var devProjectID int64
		var category, location, ip string
		if err := row.Scan(&devProjectID, &category, &location, &ip); err != nil {
			writeErr(w, 400, "所选设备不存在")
			return
		}
		if devProjectID != old.ProjectID {
			writeErr(w, 400, "所选设备不属于当前项目")
			return
		}
		d.Name = category
		if location != "" {
			d.Name += "(" + location + ")"
		}
		d.Type = category
		d.ManageAddr = ip
	} else if d.Name == "" {
		writeErr(w, 400, "请选择已安装设备,或手动填写名称")
		return
	}
	enc := oldEnc
	pwChanged := "未修改"
	if d.Password != "" {
		enc, err = encryptStr(d.Password)
		if err != nil {
			writeErr(w, 500, "加密失败")
			return
		}
		pwChanged = "******(已修改)"
	}
	d.ID = id
	d.ProjectID = old.ProjectID // 所属项目创建后不允许改,避免和密码本按项目筛选的逻辑冲突
	d.UpdatedAt = nowStr()
	d.UpdatedBy = s.Username
	_, err = db.conn.Exec(`UPDATE core_devices SET device_id=?,name=?,type=?,manage_addr=?,account=?,password_enc=?,remark=?,updated_at=?,updated_by=? WHERE id=?`,
		d.DeviceID, d.Name, d.Type, d.ManageAddr, d.Account, enc, d.Remark, d.UpdatedAt, d.UpdatedBy, id)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	diffAndLog(s, "update", "core_device", id, vaultMap(old, "未修改"), vaultMap(d, pwChanged))
	d.Password = ""
	writeJSON(w, d)
}

func deleteVault(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var name string
	var projectID int64
	db.conn.QueryRow(`SELECT name,project_id FROM core_devices WHERE id=?`, id).Scan(&name, &projectID)
	if !hasProjectAccess(s, projectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	if _, err := db.conn.Exec(`DELETE FROM core_devices WHERE id=?`, id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	diffAndLog(s, "delete", "core_device", id, map[string]string{"name": name}, nil)
	writeJSON(w, map[string]any{"ok": true})
}

// revealVault 返回解密后的明文密码,供前端"一键复制"使用,并记录审计日志
func revealVault(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "无效ID")
		return
	}
	var name, enc string
	var projectID int64
	err = db.conn.QueryRow(`SELECT name,password_enc,project_id FROM core_devices WHERE id=?`, id).Scan(&name, &enc, &projectID)
	if err != nil {
		writeErr(w, 404, "记录不存在")
		return
	}
	if !hasProjectAccess(s, projectID) {
		writeErr(w, 403, "没有该项目的访问权限")
		return
	}
	pw, err := decryptStr(enc)
	if err != nil {
		writeErr(w, 500, "解密失败")
		return
	}
	logAudit(s, "read", "core_device", id, "password", "", "查看了["+name+"]的密码")
	writeJSON(w, map[string]string{"password": pw})
}
