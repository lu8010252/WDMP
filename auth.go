package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type Session struct {
	UserID       int64
	Username     string
	Role         string
	Permissions  []string
	ProjectScope []int64 // 空切片 = 不限制(能看到所有项目);非空 = 只能访问列表内的项目ID
	Expires      time.Time
}

var (
	sessMu    sync.RWMutex
	sessions  = map[string]*Session{}
	sessionTTL = 12 * time.Hour
)

// cookieSecure 控制登录 cookie 是否带 Secure 标志(只允许通过 HTTPS 发送)。
// 应用本身跑在 HTTP 上、由外层 Nginx/Caddy 反代终结 TLS 是常见部署方式,这种情况下
// 应用进程收到的是明文 HTTP 请求,没法通过 r.TLS 自动判断,所以用环境变量显式开关。
// 部署时只要外层配了 HTTPS,就设置 COOKIE_SECURE=true;纯内网/临时测试用 HTTP 访问则不要开,
// 否则浏览器会拒绝在 HTTP 页面下写入这个 cookie,导致登录后立刻被当成"未登录"。
var cookieSecure = getenv("COOKIE_SECURE", "false") == "true"

// ---- 登录失败限流 ----
// 按"客户端IP + 用户名"维度记录连续失败次数,超过阈值后短时锁定,
// 防止对 /api/login 进行密码爆破。数据只存内存,重启会重置,足够应对常见场景。
type loginAttempt struct {
	fails    int
	lockedAt time.Time
}

var (
	loginMu       sync.Mutex
	loginAttempts = map[string]*loginAttempt{}

	maxLoginFails  = 5
	loginLockTime  = 5 * time.Minute
	loginAttemptTTL = 30 * time.Minute // 超过这么久没有新失败记录,视为过期一并清理
)

func loginAttemptKey(r *http.Request, username string) string {
	return clientIP(r) + "|" + username
}

// clientIP 尽量取到真实客户端IP;如果部署在反代之后且信任 X-Forwarded-For,
// 可以在这里改成优先读取该头,目前默认直接用连接的 RemoteAddr。
func clientIP(r *http.Request) string {
	ip := r.RemoteAddr
	if idx := strings.LastIndex(ip, ":"); idx != -1 {
		ip = ip[:idx]
	}
	return ip
}

// checkLoginLocked 返回是否处于锁定状态,以及剩余锁定秒数
func checkLoginLocked(key string) (bool, int) {
	loginMu.Lock()
	defer loginMu.Unlock()
	a, ok := loginAttempts[key]
	if !ok || a.fails < maxLoginFails {
		return false, 0
	}
	remain := loginLockTime - time.Since(a.lockedAt)
	if remain <= 0 {
		delete(loginAttempts, key)
		return false, 0
	}
	return true, int(remain.Seconds()) + 1
}

func recordLoginFail(key string) {
	loginMu.Lock()
	defer loginMu.Unlock()
	a, ok := loginAttempts[key]
	if !ok {
		a = &loginAttempt{}
		loginAttempts[key] = a
	}
	a.fails++
	if a.fails >= maxLoginFails {
		a.lockedAt = time.Now()
	}
}

func recordLoginSuccess(key string) {
	loginMu.Lock()
	delete(loginAttempts, key)
	loginMu.Unlock()
}

// loginAttemptJanitor 定期清理很久没有活动的失败记录,避免内存无限增长
func loginAttemptJanitor() {
	t := time.NewTicker(30 * time.Minute)
	for range t.C {
		loginMu.Lock()
		for k, a := range loginAttempts {
			if a.fails < maxLoginFails && time.Since(a.lockedAt) > loginAttemptTTL {
				delete(loginAttempts, k)
			}
			if a.fails >= maxLoginFails && time.Since(a.lockedAt) > loginLockTime {
				delete(loginAttempts, k)
			}
		}
		loginMu.Unlock()
	}
}

type ctxKey string

const ctxSessionKey ctxKey = "session"

func hashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	return string(b), err
}

func checkPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

func newSessionToken() string {
	b := make([]byte, 24)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func createSession(userID int64, username, role string, permissions []string, projectScope []int64) string {
	tok := newSessionToken()
	sessMu.Lock()
	sessions[tok] = &Session{UserID: userID, Username: username, Role: role, Permissions: permissions, ProjectScope: projectScope, Expires: time.Now().Add(sessionTTL)}
	sessMu.Unlock()
	return tok
}

func getSession(tok string) *Session {
	sessMu.RLock()
	s, ok := sessions[tok]
	sessMu.RUnlock()
	if !ok || time.Now().After(s.Expires) {
		return nil
	}
	return s
}

func destroySession(tok string) {
	sessMu.Lock()
	delete(sessions, tok)
	sessMu.Unlock()
}

func sessionJanitor() {
	t := time.NewTicker(30 * time.Minute)
	for range t.C {
		now := time.Now()
		sessMu.Lock()
		for k, v := range sessions {
			if now.After(v.Expires) {
				delete(sessions, k)
			}
		}
		sessMu.Unlock()
	}
}

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("sid")
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "未登录")
			return
		}
		s := getSession(c.Value)
		if s == nil {
			writeErr(w, http.StatusUnauthorized, "登录已过期,请重新登录")
			return
		}
		// 每次请求都从数据库重新读一次角色和权限,而不是只信任登录时缓存的值,
		// 这样管理员改了某人的角色/权限后立即生效,不需要对方重新登录;
		// 顺带效果:如果这个用户已经被删除,也能立刻让其现存的登录状态失效,而不用等12小时会话过期。
		var role, permJSON, scopeJSON string
		if err := db.conn.QueryRow(`SELECT role, COALESCE(permissions,'[]'), COALESCE(project_scope,'[]') FROM users WHERE id=?`, s.UserID).Scan(&role, &permJSON, &scopeJSON); err != nil {
			destroySession(c.Value)
			writeErr(w, http.StatusUnauthorized, "账号不存在或已被删除,请重新登录")
			return
		}
		sessMu.Lock()
		s.Role = role
		s.Permissions = decodePermissions(permJSON)
		s.ProjectScope = decodeProjectScope(scopeJSON)
		s.Expires = time.Now().Add(sessionTTL)
		sessMu.Unlock()
		ctx := context.WithValue(r.Context(), ctxSessionKey, s)
		next(w, r.WithContext(ctx))
	}
}

// PERMISSION_MODULES 是可以被单独授权的功能模块列表(key -> 中文名),用于:
//  1. 用户管理页面渲染权限勾选项
//  2. 校验管理员提交的权限列表,过滤掉任何不在这个白名单里的值(防止乱传字符串)
// 除 vault 外,这里的权限控制的是"新增/编辑"能力,不是"能不能看"——查看这几个模块对所有登录用户
// 都是开放的,未被授权时相当于"只读"。vault(核心密码本)是唯一的例外:没被授权时连看都看不到,
// 因为里面存的是可解密的真实密码。仪表盘、工具箱不需要授权;用户管理、数据备份、修改日志涉及全局
// 管理权限,只有 admin 角色能用,不开放给"授权"这种细粒度控制,避免权限提升风险。
var PERMISSION_MODULES = map[string]string{
	"projects":   "项目管理(新增/编辑)",
	"categories": "分类管理(新增/编辑)",
	"quantity":   "工程量对比(新增/编辑)",
	"install":    "现场安装数量登记(新增/编辑)",
	"devices":    "设备台账(新增/编辑)",
	"vault":      "核心密码本(未授权则完全不可见)",
	"network":    "网络与交换机(新增/编辑)",
}

func decodePermissions(raw string) []string {
	if raw == "" {
		return []string{}
	}
	var list []string
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return []string{}
	}
	return list
}

func encodePermissions(list []string) string {
	// 过滤掉任何不在白名单里的值,防止管理员端传入的数据被篡改成非法权限key
	clean := []string{}
	for _, m := range list {
		if _, ok := PERMISSION_MODULES[m]; ok {
			clean = append(clean, m)
		}
	}
	b, err := json.Marshal(clean)
	if err != nil {
		return "[]"
	}
	return string(b)
}

func decodeProjectScope(raw string) []int64 {
	if raw == "" {
		return []int64{}
	}
	var list []int64
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return []int64{}
	}
	return list
}

// encodeProjectScope 把项目ID列表按白名单(数据库里真实存在的项目ID)过滤后编码成JSON,
// 防止管理员端传入的数据里混入不存在的项目ID。ids 为空则表示"不限制项目"。
func encodeProjectScope(ids []int64) string {
	clean := []int64{}
	for _, id := range ids {
		var exists int
		db.conn.QueryRow(`SELECT COUNT(*) FROM projects WHERE id=?`, id).Scan(&exists)
		if exists > 0 {
			clean = append(clean, id)
		}
	}
	b, err := json.Marshal(clean)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// hasProjectAccess 判断当前登录用户是否可以访问指定项目的数据。
// admin 永远放行;ProjectScope 为空表示该账号没有被限制(能看所有项目,这也是老账号升级后的默认行为);
// 否则必须命中列表里的某个项目ID才放行。
func hasProjectAccess(s *Session, projectID int64) bool {
	if s == nil {
		return false
	}
	if s.Role == "admin" {
		return true
	}
	if len(s.ProjectScope) == 0 {
		return true
	}
	for _, id := range s.ProjectScope {
		if id == projectID {
			return true
		}
	}
	return false
}

// scopeFilterSQL 在"列表不带具体 project_id 筛选条件"的场景下(比如管理员想看全部项目汇总),
// 给 SQL 拼接一段 "AND <col> IN (?,?,...)" 把结果限制在当前用户可访问的项目范围内;
// 如果账号不受项目范围限制(admin 或 ProjectScope 为空),返回空字符串,不影响原查询。
// col 是列名(不接受外部输入,调用方只能传写死的列名如 "project_id","d.project_id",不存在SQL注入风险)。
func scopeFilterSQL(s *Session, col string, args *[]any) string {
	if s == nil || s.Role == "admin" || len(s.ProjectScope) == 0 {
		return ""
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(s.ProjectScope)), ",")
	for _, id := range s.ProjectScope {
		*args = append(*args, id)
	}
	return " AND " + col + " IN (" + ph + ")"
}

func hasPermission(s *Session, module string) bool {
	if s == nil {
		return false
	}
	if s.Role == "admin" {
		return true
	}
	for _, m := range s.Permissions {
		if m == module {
			return true
		}
	}
	return false
}

// requireModule 在 requireAuth 基础上再校验用户是否被授权访问指定模块,admin 角色始终放行。
func requireModule(module string, next http.HandlerFunc) http.HandlerFunc {
	return requireAuth(func(w http.ResponseWriter, r *http.Request) {
		s := sessionFromCtx(r)
		if !hasPermission(s, module) {
			writeErr(w, http.StatusForbidden, "没有该模块的操作权限,请联系管理员分配")
			return
		}
		next(w, r)
	})
}

func requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return requireAuth(func(w http.ResponseWriter, r *http.Request) {
		s := sessionFromCtx(r)
		if s.Role != "admin" {
			writeErr(w, http.StatusForbidden, "仅管理员可操作")
			return
		}
		next(w, r)
	})
}

func sessionFromCtx(r *http.Request) *Session {
	s, _ := r.Context().Value(ctxSessionKey).(*Session)
	return s
}

func registerAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/login", handleLogin)
	mux.HandleFunc("POST /api/logout", handleLogout)
	mux.HandleFunc("POST /api/register", handleRegister)
	mux.HandleFunc("GET /api/me", requireAuth(handleMe))
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}

	key := loginAttemptKey(r, body.Username)
	if locked, remain := checkLoginLocked(key); locked {
		writeErr(w, http.StatusTooManyRequests, fmt.Sprintf("连续输错密码次数过多,请 %d 秒后再试", remain))
		return
	}

	var id int64
	var hash, role, permJSON, scopeJSON string
	err := db.conn.QueryRow(`SELECT id,password_hash,role,COALESCE(permissions,'[]'),COALESCE(project_scope,'[]') FROM users WHERE username=?`, body.Username).Scan(&id, &hash, &role, &permJSON, &scopeJSON)
	if err != nil || !checkPassword(hash, body.Password) {
		recordLoginFail(key)
		writeErr(w, http.StatusUnauthorized, "用户名或密码错误")
		return
	}
	recordLoginSuccess(key)
	perms := decodePermissions(permJSON)
	scope := decodeProjectScope(scopeJSON)
	tok := createSession(id, body.Username, role, perms, scope)
	http.SetCookie(w, &http.Cookie{
		Name:     "sid",
		Value:    tok,
		Path:     "/",
		HttpOnly: true,
		Secure:   cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
	writeJSON(w, map[string]any{"id": id, "username": body.Username, "role": role, "permissions": perms, "project_scope": scope})
}

// allowRegistration 控制是否开放"用户自助注册"入口,默认开放。
// 注册出来的账号默认是"只读"状态:能看到项目管理/分类管理/工程量对比/安装登记/设备台账/网络与交换机
// 这6个模块的数据,但新增/编辑都需要管理员在用户管理页面手动授权才能操作,delete则始终只有管理员能做。
// 核心密码本(vault)是例外:未被单独授权的账号完全看不到,不适用"注册即可查看"这条,因为里面存的是
// 可解密的真实密码,风险和其它模块不是一个量级。
var allowRegistration = getenv("ALLOW_REGISTRATION", "true") == "true"

func handleRegister(w http.ResponseWriter, r *http.Request) {
	if !allowRegistration {
		writeErr(w, http.StatusForbidden, "当前未开放自助注册,请联系管理员创建账号")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	body.Username = strings.TrimSpace(body.Username)
	if len(body.Username) < 2 || len(body.Username) > 32 {
		writeErr(w, 400, "用户名长度需在2~32个字符之间")
		return
	}
	if len(body.Password) < 6 {
		writeErr(w, 400, "密码至少需要6位")
		return
	}

	// 复用登录失败限流的机制(不同的 key 前缀,不会和登录锁定互相干扰),防止被拿来批量注册灌水
	key := "register|" + clientIP(r)
	if locked, remain := checkLoginLocked(key); locked {
		writeErr(w, http.StatusTooManyRequests, fmt.Sprintf("操作过于频繁,请 %d 秒后再试", remain))
		return
	}

	hash, err := hashPassword(body.Password)
	if err != nil {
		writeErr(w, 500, "密码加密失败")
		return
	}
	res, err := db.conn.Exec(`INSERT INTO users(username,password_hash,role,permissions,created_at) VALUES (?,?,?,?,?)`,
		body.Username, hash, "worker", "[]", nowStr())
	if err != nil {
		recordLoginFail(key)
		writeErr(w, 400, "该用户名已被注册,换一个试试")
		return
	}
	recordLoginSuccess(key)
	id, _ := res.LastInsertId()
	// 自助注册没有登录会话,构造一个占位 Session 仅用于审计日志里标注操作人
	logAudit(&Session{UserID: id, Username: body.Username}, "create", "user", id, "注册", "", body.Username+" (自助注册,待管理员分配权限)")
	writeJSON(w, map[string]any{"ok": true, "message": "注册成功!现在可以登录查看所有数据,但暂时不能新增/编辑(核心密码本除外,完全看不到),如需编辑权限请联系管理员在用户管理里分配。"})
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("sid"); err == nil {
		destroySession(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: "sid", Value: "", Path: "/", Secure: cookieSecure, MaxAge: -1})
	writeJSON(w, map[string]any{"ok": true})
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	writeJSON(w, map[string]any{"id": s.UserID, "username": s.Username, "role": s.Role, "permissions": s.Permissions, "project_scope": s.ProjectScope})
}
