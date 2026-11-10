package main

import (
	"database/sql"
	"fmt"
	"log"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type appDB struct {
	conn *sql.DB
}

func openDB(path string) (*appDB, error) {
	// 内存充裕的服务器配置:放大连接池和 SQLite 自身的页缓存/mmap,减少磁盘IO、提升并发查询性能。
	// _cache_size=-65536 表示每个连接用 64MB 页缓存(负数单位是KB);_mmap_size 让 SQLite 用内存映射
	// 方式读文件,减少一次数据拷贝。如果以后又要换回小内存机器,把这两个数值调小或去掉即可,
	// 不影响数据正确性,纯粹是性能取舍。
	conn, err := sql.Open("sqlite3", path+"?_journal_mode=WAL&_synchronous=NORMAL&_foreign_keys=on&cache=shared&_cache_size=-65536&_mmap_size=268435456")
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(20)
	conn.SetMaxIdleConns(10)
	conn.SetConnMaxLifetime(time.Hour)
	return &appDB{conn: conn}, nil
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT UNIQUE NOT NULL,
	password_hash TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'worker',
	permissions TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	area TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quantity_items (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id INTEGER NOT NULL,
	category TEXT,
	device_name TEXT NOT NULL,
	brand TEXT,
	unit TEXT,
	drawing_qty REAL NOT NULL DEFAULT 0,
	list_qty REAL NOT NULL DEFAULT 0,
	arrival_qty REAL NOT NULL DEFAULT 0,
	actual_qty REAL NOT NULL DEFAULT 0,
	remark TEXT,
	updated_at TEXT,
	updated_by TEXT
);

CREATE TABLE IF NOT EXISTS terminal_devices (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id INTEGER,
	category TEXT NOT NULL,
	code TEXT,
	location TEXT,
	model TEXT,
	cabinet TEXT,
	ip TEXT,
	mac TEXT,
	cable_no TEXT,
	switch_name TEXT,
	switch_port TEXT,
	status TEXT NOT NULL DEFAULT '未安装',
	photo_path TEXT,
	remark TEXT,
	created_at TEXT,
	updated_at TEXT,
	updated_by TEXT
);

CREATE TABLE IF NOT EXISTS core_devices (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id INTEGER NOT NULL DEFAULT 0,
	name TEXT NOT NULL,
	type TEXT,
	manage_addr TEXT,
	account TEXT,
	password_enc TEXT,
	remark TEXT,
	updated_at TEXT,
	updated_by TEXT
);

CREATE TABLE IF NOT EXISTS switches (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id INTEGER NOT NULL DEFAULT 0,
	name TEXT NOT NULL,
	location TEXT,
	manage_ip TEXT,
	network_type TEXT,
	port_count INTEGER DEFAULT 24,
	remark TEXT,
	updated_at TEXT,
	updated_by TEXT
);

CREATE TABLE IF NOT EXISTS switch_ports (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	switch_id INTEGER NOT NULL,
	port_no INTEGER NOT NULL,
	network_type TEXT,
	connected_device TEXT,
	remark TEXT,
	UNIQUE(switch_id, port_no)
);

CREATE TABLE IF NOT EXISTS audit_logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER,
	username TEXT,
	action TEXT,
	entity TEXT,
	record_id INTEGER,
	field TEXT,
	before_val TEXT,
	after_val TEXT,
	created_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	parent_id INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS install_records (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id INTEGER NOT NULL,
	category_id INTEGER NOT NULL DEFAULT 0,
	sub_category_id INTEGER NOT NULL DEFAULT 0,
	category_name TEXT,
	sub_category_name TEXT,
	location TEXT,
	model TEXT NOT NULL,
	quantity REAL NOT NULL DEFAULT 0,
	photo_path TEXT,
	remark TEXT,
	created_at TEXT,
	updated_at TEXT,
	updated_by TEXT
);

CREATE TABLE IF NOT EXISTS device_checks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	device_id INTEGER NOT NULL,
	project_id INTEGER NOT NULL DEFAULT 0,
	checked_by TEXT NOT NULL,
	result TEXT NOT NULL DEFAULT '正常',
	note TEXT,
	created_at TEXT NOT NULL
);
`

const schemaIndexes = `
CREATE INDEX IF NOT EXISTS idx_devices_project ON terminal_devices(project_id);
CREATE INDEX IF NOT EXISTS idx_quantity_project ON quantity_items(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ports_switch ON switch_ports(switch_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_install_project ON install_records(project_id);
CREATE INDEX IF NOT EXISTS idx_vault_project ON core_devices(project_id);
CREATE INDEX IF NOT EXISTS idx_switches_project ON switches(project_id);
CREATE INDEX IF NOT EXISTS idx_checks_device ON device_checks(device_id);
`

const ftsSchema = `
CREATE VIRTUAL TABLE IF NOT EXISTS devices_fts USING fts5(
	code, location, model, ip, mac, cable_no, cabinet,
	content='terminal_devices', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS devices_fts_ai AFTER INSERT ON terminal_devices BEGIN
	INSERT INTO devices_fts(rowid, code, location, model, ip, mac, cable_no, cabinet)
	VALUES (new.id, new.code, new.location, new.model, new.ip, new.mac, new.cable_no, new.cabinet);
END;
CREATE TRIGGER IF NOT EXISTS devices_fts_ad AFTER DELETE ON terminal_devices BEGIN
	INSERT INTO devices_fts(devices_fts, rowid, code, location, model, ip, mac, cable_no, cabinet)
	VALUES ('delete', old.id, old.code, old.location, old.model, old.ip, old.mac, old.cable_no, old.cabinet);
END;
CREATE TRIGGER IF NOT EXISTS devices_fts_au AFTER UPDATE ON terminal_devices BEGIN
	INSERT INTO devices_fts(devices_fts, rowid, code, location, model, ip, mac, cable_no, cabinet)
	VALUES ('delete', old.id, old.code, old.location, old.model, old.ip, old.mac, old.cable_no, old.cabinet);
	INSERT INTO devices_fts(rowid, code, location, model, ip, mac, cable_no, cabinet)
	VALUES (new.id, new.code, new.location, new.model, new.ip, new.mac, new.cable_no, new.cabinet);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS switches_fts USING fts5(
	name, location, manage_ip, network_type,
	content='switches', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS switches_fts_ai AFTER INSERT ON switches BEGIN
	INSERT INTO switches_fts(rowid, name, location, manage_ip, network_type)
	VALUES (new.id, new.name, new.location, new.manage_ip, new.network_type);
END;
CREATE TRIGGER IF NOT EXISTS switches_fts_ad AFTER DELETE ON switches BEGIN
	INSERT INTO switches_fts(switches_fts, rowid, name, location, manage_ip, network_type)
	VALUES ('delete', old.id, old.name, old.location, old.manage_ip, old.network_type);
END;
CREATE TRIGGER IF NOT EXISTS switches_fts_au AFTER UPDATE ON switches BEGIN
	INSERT INTO switches_fts(switches_fts, rowid, name, location, manage_ip, network_type)
	VALUES ('delete', old.id, old.name, old.location, old.manage_ip, old.network_type);
	INSERT INTO switches_fts(rowid, name, location, manage_ip, network_type)
	VALUES (new.id, new.name, new.location, new.manage_ip, new.network_type);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS quantity_fts USING fts5(
	device_name, brand, category, remark,
	content='quantity_items', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS quantity_fts_ai AFTER INSERT ON quantity_items BEGIN
	INSERT INTO quantity_fts(rowid, device_name, brand, category, remark)
	VALUES (new.id, new.device_name, new.brand, new.category, new.remark);
END;
CREATE TRIGGER IF NOT EXISTS quantity_fts_ad AFTER DELETE ON quantity_items BEGIN
	INSERT INTO quantity_fts(quantity_fts, rowid, device_name, brand, category, remark)
	VALUES ('delete', old.id, old.device_name, old.brand, old.category, old.remark);
END;
CREATE TRIGGER IF NOT EXISTS quantity_fts_au AFTER UPDATE ON quantity_items BEGIN
	INSERT INTO quantity_fts(quantity_fts, rowid, device_name, brand, category, remark)
	VALUES ('delete', old.id, old.device_name, old.brand, old.category, old.remark);
	INSERT INTO quantity_fts(rowid, device_name, brand, category, remark)
	VALUES (new.id, new.device_name, new.brand, new.category, new.remark);
END;
`

func (d *appDB) migrate() error {
	if _, err := d.conn.Exec(schema); err != nil {
		return err
	}
	// migrateColumns 必须在建索引之前执行:老版本数据库里的表已经存在(CREATE TABLE IF NOT EXISTS 跳过),
	// 但缺少后续版本新增的字段,如果先建索引会因为引用了还不存在的列而报错。
	if err := d.migrateColumns(); err != nil {
		return err
	}
	if _, err := d.conn.Exec(schemaIndexes); err != nil {
		return err
	}
	return d.migrateFTS()
}

// migrateFTS 创建全文检索用的 FTS5 虚拟表和同步触发器(表已存在则跳过,触发器负责后续增删改自动同步)。
// 每次启动都会对三张表各执行一次 'rebuild',用现有数据重建一遍索引——这个操作很快(表数据量通常
// 也就几千行),好处是不管是全新建表、还是历史数据库刚刚补上这个功能,都能保证索引和真实数据一致,
// 不需要额外判断"是不是第一次创建"这种状态。
// ftsAvailable 标记本次启动 FTS5 全文检索是否成功可用;为 false 时 search.go 会全程退回 LIKE 子串查询,
// 不会导致整个程序无法启动。之所以做这层容错:FTS5 依赖编译时的 sqlite_fts5 构建标签,
// 万一以后哪次编译流程忘了带这个标签,应该是"搜索变慢一点"而不是"整个系统起不来"。
var ftsAvailable = false

func (d *appDB) migrateFTS() error {
	if _, err := d.conn.Exec(ftsSchema); err != nil {
		log.Printf("全文检索(FTS5)不可用,已自动降级为普通模糊搜索(不影响其它功能): %v", err)
		return nil
	}
	for _, tbl := range []string{"devices_fts", "switches_fts", "quantity_fts"} {
		if _, err := d.conn.Exec(fmt.Sprintf(`INSERT INTO %s(%s) VALUES('rebuild')`, tbl, tbl)); err != nil {
			log.Printf("重建全文检索索引 %s 失败,已自动降级为普通模糊搜索: %v", tbl, err)
			return nil
		}
	}
	ftsAvailable = true
	return nil
}

// migrateColumns 为老版本数据库(升级前建的表)追加二级分类字段,
// 使用 ALTER TABLE ADD COLUMN,已存在则跳过,保证可重复执行、不影响已有数据。
func (d *appDB) migrateColumns() error {
	alters := []struct{ table, col, def string }{
		{"terminal_devices", "category_id", "INTEGER NOT NULL DEFAULT 0"},
		{"terminal_devices", "sub_category_id", "INTEGER NOT NULL DEFAULT 0"},
		{"terminal_devices", "cabinet", "TEXT"},
		{"install_records", "photo_path", "TEXT"},
		{"users", "permissions", "TEXT NOT NULL DEFAULT '[]'"},
		{"quantity_items", "category_id", "INTEGER NOT NULL DEFAULT 0"},
		{"quantity_items", "sub_category_id", "INTEGER NOT NULL DEFAULT 0"},
		{"quantity_items", "arrival_qty", "REAL NOT NULL DEFAULT 0"},
		{"quantity_items", "brand", "TEXT"},
		{"core_devices", "project_id", "INTEGER NOT NULL DEFAULT 0"},
		{"switches", "project_id", "INTEGER NOT NULL DEFAULT 0"},
		{"users", "project_scope", "TEXT NOT NULL DEFAULT '[]'"},
		{"terminal_devices", "last_checked_at", "TEXT"},
		{"terminal_devices", "last_checked_by", "TEXT"},
		{"core_devices", "device_id", "INTEGER NOT NULL DEFAULT 0"},
	}
	for _, a := range alters {
		exists, err := d.columnExists(a.table, a.col)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := d.conn.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", a.table, a.col, a.def)); err != nil {
				return err
			}
		}
	}
	return nil
}

func (d *appDB) columnExists(table, col string) (bool, error) {
	rows, err := d.conn.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == col {
			return true, nil
		}
	}
	return false, nil
}

func (d *appDB) seedAdmin() error {
	var count int
	if err := d.conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	initPass := getenv("ADMIN_INIT_PASSWORD", "admin123")
	hash, err := hashPassword(initPass)
	if err != nil {
		return err
	}
	_, err = d.conn.Exec(`INSERT INTO users(username,password_hash,role,created_at) VALUES (?,?,?,?)`,
		"admin", hash, "admin", nowStr())
	return err
}

// resetAdminPassword 找回密码用:强制把 admin 账号的密码改成指定值,不影响其他账号。
// 由 main.go 在启动时根据 RESET_ADMIN_PASSWORD 环境变量决定是否调用。
func (d *appDB) resetAdminPassword(newPw string) error {
	hash, err := hashPassword(newPw)
	if err != nil {
		return err
	}
	res, err := d.conn.Exec(`UPDATE users SET password_hash=? WHERE username='admin'`, hash)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// admin 账号不存在(理论上不会发生,因为 seedAdmin 保证了它一定存在),兜底创建一个
		_, err = d.conn.Exec(`INSERT INTO users(username,password_hash,role,created_at) VALUES ('admin',?,?,?)`,
			hash, "admin", nowStr())
		return err
	}
	return nil
}

func nowStr() string {
	return time.Now().Format("2006-01-02 15:04:05")
}
