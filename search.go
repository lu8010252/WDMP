package main

import (
	"database/sql"
	"net/http"
	"strings"
	"unicode/utf8"
)

type SearchResult struct {
	Module string `json:"module"` // 设备台账/工程量/交换机/密码本
	ID     int64  `json:"id"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

func registerSearchRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/search", requireAuth(globalSearch))
}

// ftsPhrase 把用户输入的关键词包成 FTS5 的"精确短语"查询,而不是直接把原始字符串交给 MATCH。
// 这样做两个目的:1) 关键词里如果包含 FTS5 查询语法的特殊字符(双引号、* 、AND/OR/NOT 这类保留词),
// 不会被当成查询语法解析,只会被当成普通文本去匹配,行为上更接近直觉的"子串搜索";
// 2) 配合 trigram 分词器,双引号短语查询就是连续子串匹配,和原来 LIKE '%kw%' 的语义基本对齐。
func ftsPhrase(kw string) string {
	return `"` + strings.ReplaceAll(kw, `"`, `""`) + `"`
}

// useFTS 判断这次搜索是否走 FTS5:
//  1. ftsAvailable 为 false(比如编译时没带 sqlite_fts5 标签导致降级)时,一律退回 LIKE
//  2. trigram 分词器至少需要3个字符才能组成一个语义片段,关键词太短也退回 LIKE 子串匹配
func useFTS(kw string) bool {
	return ftsAvailable && utf8.RuneCountInString(kw) >= 3
}

func globalSearch(w http.ResponseWriter, r *http.Request) {
	s := sessionFromCtx(r)
	kw := r.URL.Query().Get("q")
	if kw == "" {
		writeJSON(w, []SearchResult{})
		return
	}
	results := []SearchResult{}
	like := "%" + kw + "%"

	// ---- 设备台账 ----
	var devRows *sql.Rows
	var err error
	if useFTS(kw) {
		args := []any{ftsPhrase(kw)}
		q := `
			SELECT d.id,d.category,d.code,d.location,d.ip,d.mac,d.cable_no,d.model
			FROM devices_fts JOIN terminal_devices d ON d.id = devices_fts.rowid
			WHERE devices_fts MATCH ?` + scopeFilterSQL(s, "d.project_id", &args) + ` ORDER BY rank LIMIT 20`
		devRows, err = db.conn.Query(q, args...)
	} else {
		args := []any{like, like, like, like, like, like}
		q := `SELECT id,category,code,location,ip,mac,cable_no,model FROM terminal_devices
			WHERE (code LIKE ? OR location LIKE ? OR ip LIKE ? OR mac LIKE ? OR cable_no LIKE ? OR model LIKE ?)` + scopeFilterSQL(s, "project_id", &args) + ` LIMIT 20`
		devRows, err = db.conn.Query(q, args...)
	}
	if err == nil {
		defer devRows.Close()
		for devRows.Next() {
			var id int64
			var cat, code, loc, ip, mac, cable, model string
			devRows.Scan(&id, &cat, &code, &loc, &ip, &mac, &cable, &model)
			results = append(results, SearchResult{
				Module: "设备台账", ID: id, Title: cat + " " + code,
				Detail: "位置:" + loc + " IP:" + ip + " 线缆号:" + cable + " 型号:" + model,
			})
		}
	}

	// ---- 交换机 ----
	var swRows *sql.Rows
	if useFTS(kw) {
		args := []any{ftsPhrase(kw)}
		q := `
			SELECT sw.id,sw.name,sw.manage_ip,sw.network_type
			FROM switches_fts JOIN switches sw ON sw.id = switches_fts.rowid
			WHERE switches_fts MATCH ?` + scopeFilterSQL(s, "sw.project_id", &args) + ` ORDER BY rank LIMIT 20`
		swRows, err = db.conn.Query(q, args...)
	} else {
		args := []any{like, like}
		q := `SELECT id,name,manage_ip,network_type FROM switches
			WHERE (name LIKE ? OR manage_ip LIKE ?)` + scopeFilterSQL(s, "project_id", &args) + ` LIMIT 20`
		swRows, err = db.conn.Query(q, args...)
	}
	if err == nil {
		defer swRows.Close()
		for swRows.Next() {
			var id int64
			var name, ip, ntype string
			swRows.Scan(&id, &name, &ip, &ntype)
			results = append(results, SearchResult{
				Module: "交换机", ID: id, Title: name,
				Detail: "管理IP:" + ip + " 网络类型:" + ntype,
			})
		}
	}

	// ---- 工程量对比 ----
	var qtyRows *sql.Rows
	if useFTS(kw) {
		args := []any{ftsPhrase(kw)}
		q := `
			SELECT q.id,q.device_name,q.category
			FROM quantity_fts JOIN quantity_items q ON q.id = quantity_fts.rowid
			WHERE quantity_fts MATCH ?` + scopeFilterSQL(s, "q.project_id", &args) + ` ORDER BY rank LIMIT 20`
		qtyRows, err = db.conn.Query(q, args...)
	} else {
		args := []any{like}
		q := `SELECT id,device_name,category FROM quantity_items WHERE device_name LIKE ?` + scopeFilterSQL(s, "project_id", &args) + ` LIMIT 20`
		qtyRows, err = db.conn.Query(q, args...)
	}
	if err == nil {
		defer qtyRows.Close()
		for qtyRows.Next() {
			var id int64
			var name, cat string
			qtyRows.Scan(&id, &name, &cat)
			results = append(results, SearchResult{Module: "工程量对比", ID: id, Title: name, Detail: "分类:" + cat})
		}
	}

	// 核心密码本涉及可解密的真实密码,不跟随"查看开放"的原则,继续按权限严格过滤,
	// 也不接入全文检索(表通常很小,LIKE足够快,没必要为了这点数据单独再建一套FTS索引和权限过滤的复杂度):
	// 没有 vault 权限的人搜索结果里完全看不到密码本条目,哪怕标题里包含关键词也不行。
	if hasPermission(s, "vault") {
		args := []any{like, like}
		q := `SELECT id,name,type,manage_addr FROM core_devices WHERE (name LIKE ? OR manage_addr LIKE ?)` + scopeFilterSQL(s, "project_id", &args) + ` LIMIT 20`
		rows4, err := db.conn.Query(q, args...)
		if err == nil {
			defer rows4.Close()
			for rows4.Next() {
				var id int64
				var name, typ, addr string
				rows4.Scan(&id, &name, &typ, &addr)
				results = append(results, SearchResult{Module: "核心密码本", ID: id, Title: name, Detail: "类型:" + typ + " 地址:" + addr})
			}
		}
	}

	writeJSON(w, results)
}
