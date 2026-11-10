package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"
)

//go:embed static
var staticFS embed.FS

var db *appDB

func main() {
	dataDir := getenv("DATA_DIR", "./data")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("创建数据目录失败: %v", err)
	}
	if err := os.MkdirAll(dataDir+"/photos", 0755); err != nil {
		log.Fatalf("创建照片目录失败: %v", err)
	}

	// 启动时打印数据目录状态,方便在日志里确认数据是否正确挂载(避免"部署后数据没了"类问题)
	if info, err := os.Stat(dataDir + "/wdmp.db"); err == nil {
		log.Printf("数据目录: %s  数据库大小: %d bytes (已有数据)", dataDir, info.Size())
	} else {
		log.Printf("数据目录: %s  wdmp.db 不存在,将自动创建(首次部署属正常,否则请检查数据目录是否正确挂载)", dataDir)
	}

	var err error
	db, err = openDB(dataDir + "/wdmp.db")
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer db.conn.Close()

	if err := db.migrate(); err != nil {
		log.Fatalf("初始化数据库结构失败: %v", err)
	}
	if err := db.seedAdmin(); err != nil {
		log.Fatalf("初始化管理员账号失败: %v", err)
	}

	// 找回密码用:如果启动时设置了 RESET_ADMIN_PASSWORD 环境变量,强制把 admin 密码改成这个值。
	// 用完后请务必从 docker-compose.yml / 启动命令里删掉这个变量,避免每次重启都被强制改回同一个密码。
	if resetPw := getenv("RESET_ADMIN_PASSWORD", ""); resetPw != "" {
		if err := db.resetAdminPassword(resetPw); err != nil {
			log.Printf("重置 admin 密码失败: %v", err)
		} else {
			log.Printf("已根据 RESET_ADMIN_PASSWORD 环境变量重置 admin 密码,请登录后立即删除该环境变量并重新构建/重启")
		}
	}

	initVaultKey(dataDir)
	go sessionJanitor()
	go loginAttemptJanitor()
	go startAutoBackup(dataDir)

	mux := http.NewServeMux()
	registerAuthRoutes(mux)
	registerProjectRoutes(mux)
	registerCategoryRoutes(mux)
	registerQuantityRoutes(mux)
	registerInstallRoutes(mux, dataDir)
	registerDeviceRoutes(mux, dataDir)
	registerVaultRoutes(mux)
	registerSwitchRoutes(mux)
	registerAuditRoutes(mux)
	registerSearchRoutes(mux)
	registerBackupRoutes(mux, dataDir)
	registerPhotoRoutes(mux, dataDir)
	registerExcelRoutes(mux, dataDir)
	registerUserRoutes(mux)
	registerCheckinRoutes(mux)

	// 静态照片文件(需要登录)
	photoFS := http.Dir(dataDir + "/photos")
	mux.Handle("GET /data/photos/", requireAuth(http.StripPrefix("/data/photos/", http.FileServer(photoFS)).ServeHTTP))

	// 前端静态资源
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("GET /", http.FileServer(http.FS(sub)))

	addr := getenv("LISTEN_ADDR", ":8080")
	srv := &http.Server{
		Addr:         addr,
		Handler:      logMiddleware(maxBodyMiddleware(mux)),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	log.Printf("弱电工程综合管理与运维平台启动,监听 %s", addr)
	log.Fatal(srv.ListenAndServe())
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %v", r.Method, r.URL.Path, time.Since(start))
	})
}

// maxBodyMiddleware 给所有请求体加一个统一的硬上限(默认20MB),防止有人发超大请求
// 把内存/磁盘打爆(比如几百MB的JSON body)。20MB 是照顾 Excel 导入(内部还有自己的
// 10MB 内存阈值)留出的余量,普通 JSON 接口的请求体远小于这个数,不会受影响;
// 各接口如果有更严格的限制(比如设备照片上传的300KB),会在自己的 handler 里再收紧,
// 这里的限制和它们叠加生效,不冲突。
const maxRequestBodyBytes = 20 << 20 // 20MB

func maxBodyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limit := int64(maxRequestBodyBytes)
		if r.URL.Path == "/api/backup/restore" {
			// 恢复备份要上传整个备份包(含照片),handler 里自己限制 500MB;
			// 这里如果仍套 20MB,外层上限会先生效,导致稍大的备份根本传不上来
			limit = 500 << 20
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		next.ServeHTTP(w, r)
	})
}
