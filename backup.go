package main

import (
	"archive/tar"
	"compress/gzip"
	"database/sql"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// restoreMu 防止管理员并发点击"恢复备份"导致两次恢复流程互相打架,
// 这是一个很少发生的维护性操作,用一把简单的互斥锁足够。
var restoreMu sync.Mutex

// 自动备份的当前生效配置,startAutoBackup 启动时写入一次,只读展示给前端用
var (
	autoBackupIntervalH = 0
	autoBackupKeepCount = 0
)

// autoBackupNameRe 自动备份文件名的合法格式,下载/删除历史备份时用来防止路径穿越。
// 新版用固定编号循环覆盖,如 auto_01.tar.gz ~ auto_07.tar.gz;
// 同时兼容旧版按时间戳命名的文件(auto_20260801_120000.tar.gz),避免升级后旧备份从列表里消失。
// (只允许 auto_YYYYMMDD_HHMMSS.tar.gz 这种固定格式的文件名,拒绝任何包含 / 或 .. 的输入)
var autoBackupNameRe = regexp.MustCompile(`^auto_\d{8}_\d{6}\.tar\.gz$`)

func registerBackupRoutes(mux *http.ServeMux, dataDir string) {
	// 导出完整备份包:数据库 + 密码本加密密钥 + 设备照片,一起打进一个 .tar.gz,
	// 避免只导出数据库导致密钥/照片丢失、事后解不开密码本或照片全部失效的问题。
	mux.HandleFunc("GET /api/backup/download", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		extendDeadlines(w, 30*time.Minute) // 服务器全局 30 秒写超时,备份包较大时会被中途截断
		fname := "wdmp_backup_" + time.Now().Format("20060102_150405") + ".tar.gz"
		w.Header().Set("Content-Disposition", "attachment; filename=\""+fname+"\"")
		w.Header().Set("Content-Type", "application/gzip")
		if err := writeBackupArchive(dataDir, w); err != nil {
			log.Printf("导出完整备份失败: %v", err)
			return
		}
		s := sessionFromCtx(r)
		logAudit(s, "read", "backup", 0, "database", "", "导出了完整备份包(数据库+密钥+照片)")
	}))

	// 恢复备份(即"数据导入"):支持两种格式——
	//   1. 新格式 .tar.gz 完整备份包(数据库+密钥+照片一起恢复,推荐)
	//   2. 旧格式纯 .db 文件(只恢复数据库,兼容升级前导出的备份)
	// 格式通过文件内容的魔数自动识别,不依赖文件名/扩展名。
	mux.HandleFunc("POST /api/backup/restore", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		extendDeadlines(w, 30*time.Minute) // 上传大备份包同样不能被 30 秒读超时打断
		r.Body = http.MaxBytesReader(w, r.Body, 500<<20) // 500MB 上限,留够设备照片较多时的余量
		if err := r.ParseMultipartForm(20 << 20); err != nil {
			writeErr(w, 400, "上传文件解析失败: "+err.Error())
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			writeErr(w, 400, "未找到上传的备份文件")
			return
		}
		defer file.Close()

		tmpPath := fmt.Sprintf("%s/restore_upload_%d.tmp", dataDir, time.Now().UnixNano())
		out, err := os.Create(tmpPath)
		if err != nil {
			writeErr(w, 500, "保存上传文件失败: "+err.Error())
			return
		}
		if _, err := io.Copy(out, file); err != nil {
			out.Close()
			os.Remove(tmpPath)
			writeErr(w, 500, "保存上传文件失败: "+err.Error())
			return
		}
		out.Close()
		defer os.Remove(tmpPath)

		format, err := detectBackupFormat(tmpPath)
		if err != nil {
			writeErr(w, 400, "无法识别的备份文件格式: "+err.Error())
			return
		}

		restoreMu.Lock()
		defer restoreMu.Unlock()

		var msg string
		if format == "targz" {
			msg, err = restoreFromArchive(dataDir, tmpPath)
		} else {
			msg, err = restoreFromRawDB(dataDir, tmpPath)
		}
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}

		// 数据库已整体替换,老会话对应的用户在新数据库里不一定还存在,强制所有人(含当前操作者)重新登录
		sessMu.Lock()
		sessions = map[string]*Session{}
		sessMu.Unlock()

		writeJSON(w, map[string]any{"ok": true, "message": msg})
	}))

	// 自动备份的当前配置(供前端展示"自动备份:每X小时一次,保留N份"这类提示)
	mux.HandleFunc("GET /api/backup/config", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"enabled":        autoBackupIntervalH > 0,
			"interval_hours": autoBackupIntervalH,
			"keep_count":     autoBackupKeepCount,
		})
	}))

	// 自动备份历史列表
	mux.HandleFunc("GET /api/backup/history", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, listAutoBackups(dataDir+"/backups"))
	}))

	// 下载某一份历史自动备份
	mux.HandleFunc("GET /api/backup/history/{name}", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		extendDeadlines(w, 30*time.Minute)
		name := r.PathValue("name")
		if !autoBackupNameRe.MatchString(name) {
			writeErr(w, 400, "非法的文件名")
			return
		}
		fpath := dataDir + "/backups/" + name
		if _, err := os.Stat(fpath); err != nil {
			writeErr(w, 404, "备份文件不存在")
			return
		}
		w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
		w.Header().Set("Content-Type", "application/gzip")
		http.ServeFile(w, r, fpath)
		s := sessionFromCtx(r)
		logAudit(s, "read", "backup", 0, "database", "", "下载了自动备份: "+name)
	}))

	// 删除某一份历史自动备份(手动腾空间用,自动清理已经会按保留份数处理)
	mux.HandleFunc("DELETE /api/backup/history/{name}", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !autoBackupNameRe.MatchString(name) {
			writeErr(w, 400, "非法的文件名")
			return
		}
		if err := os.Remove(dataDir + "/backups/" + name); err != nil {
			writeErr(w, 500, "删除失败: "+err.Error())
			return
		}
		s := sessionFromCtx(r)
		logAudit(s, "delete", "backup", 0, "database", "", "删除了自动备份: "+name)
		writeJSON(w, map[string]any{"ok": true})
	}))
}

// startAutoBackup 是一个常驻后台goroutine,按 BACKUP_INTERVAL_HOURS 指定的周期
// (默认24小时,设为0可关闭)自动打包一份完整备份(数据库+密钥+照片),存到 dataDir/backups/ 下,
// 文件名带时间戳(如 auto_20260805_143000.tar.gz),最多保留 BACKUP_KEEP_COUNT 份(默认7份),超出自动删除最旧的。
// 启动后会立即先备份一次(而不是等满一个周期),这样刚部署完就能马上验证自动备份是否正常工作。
func startAutoBackup(dataDir string) {
	autoBackupIntervalH = getenvInt("BACKUP_INTERVAL_HOURS", 24)
	autoBackupKeepCount = getenvInt("BACKUP_KEEP_COUNT", 7)
	if autoBackupIntervalH <= 0 {
		log.Printf("自动备份未启用(BACKUP_INTERVAL_HOURS=%d),如需开启请设置为正整数(单位:小时)", autoBackupIntervalH)
		return
	}
	backupDir := dataDir + "/backups"
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		log.Printf("创建自动备份目录失败,自动备份功能不可用: %v", err)
		return
	}
	log.Printf("自动备份已启用:每 %d 小时一次,最多保留 %d 份(数据库+密钥+照片完整打包)", autoBackupIntervalH, autoBackupKeepCount)
	ticker := time.NewTicker(time.Duration(autoBackupIntervalH) * time.Hour)
	defer ticker.Stop()
	for {
		runAutoBackup(dataDir, backupDir, autoBackupKeepCount)
		<-ticker.C
	}
}

func runAutoBackup(dataDir, backupDir string, keep int) {
	fname := fmt.Sprintf("auto_%s.tar.gz", time.Now().Format("20060102_150405"))
	fpath := backupDir + "/" + fname
	tmpPath := fpath + ".tmp"

	out, err := os.Create(tmpPath)
	if err != nil {
		log.Printf("自动备份失败(创建文件): %v", err)
		return
	}
	err = writeBackupArchive(dataDir, out)
	out.Close()
	if err != nil {
		log.Printf("自动备份失败: %v", err)
		os.Remove(tmpPath)
		return
	}
	if err := os.Rename(tmpPath, fpath); err != nil {
		log.Printf("自动备份失败(替换文件): %v", err)
		os.Remove(tmpPath)
		return
	}
	log.Printf("自动备份完成: %s", fname)
	cleanupOldBackups(backupDir, keep)
}

// cleanupOldBackups 按文件名字符串排序(时间戳命名,字符串排序即时间顺序),只保留最新的 keep 份
func cleanupOldBackups(backupDir string, keep int) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && autoBackupNameRe.MatchString(e.Name()) {
			names = append(names, e.Name())
		}
	}
	if keep < 0 || len(names) <= keep {
		return
	}
	sort.Strings(names) // 时间戳文件名,字符串排序=时间顺序,最旧的在前
	for _, n := range names[:len(names)-keep] {
		if err := os.Remove(backupDir + "/" + n); err != nil {
			log.Printf("清理旧自动备份失败 %s: %v", n, err)
		} else {
			log.Printf("已清理旧自动备份(超出保留份数): %s", n)
		}
	}
}

// listAutoBackups 返回自动备份目录下所有历史备份,按时间倒序(最新的在最前面)
func listAutoBackups(backupDir string) []map[string]any {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return []map[string]any{}
	}
	list := []map[string]any{}
	for _, e := range entries {
		if e.IsDir() || !autoBackupNameRe.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		list = append(list, map[string]any{
			"name": e.Name(),
			"size": info.Size(),
			"time": info.ModTime().Format("2006-01-02 15:04:05"),
		})
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i]["name"].(string) > list[j]["name"].(string)
	})
	return list
}

/* ================= 完整备份包(.tar.gz)的打包 / 恢复 / 校验 ================= */

// writeBackupArchive 生成一份完整备份包,写入 w,内容包含:
//   wdmp.db   —— 用 VACUUM INTO 生成的一致性数据库快照(不受 WAL 影响)
//   vault.key —— 核心密码本的加密密钥,没有它密码本密文将永久无法解密
//   photos/   —— 全部设备照片原图
func writeBackupArchive(dataDir string, w io.Writer) error {
	tmpDB := fmt.Sprintf("%s/archive_db_%d.db", dataDir, time.Now().UnixNano())
	defer os.Remove(tmpDB)
	if _, err := db.conn.Exec(fmt.Sprintf("VACUUM INTO '%s'", tmpDB)); err != nil {
		return fmt.Errorf("生成数据库快照失败: %w", err)
	}

	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)

	if err := addFileToTar(tw, tmpDB, "wdmp.db"); err != nil {
		tw.Close()
		gz.Close()
		return fmt.Errorf("写入数据库到备份包失败: %w", err)
	}
	if _, err := os.Stat(dataDir + "/vault.key"); err == nil {
		if err := addFileToTar(tw, dataDir+"/vault.key", "vault.key"); err != nil {
			tw.Close()
			gz.Close()
			return fmt.Errorf("写入密钥到备份包失败: %w", err)
		}
	}
	if err := addDirToTar(tw, dataDir+"/photos", "photos"); err != nil {
		tw.Close()
		gz.Close()
		return fmt.Errorf("写入照片到备份包失败: %w", err)
	}

	if err := tw.Close(); err != nil {
		gz.Close()
		return err
	}
	return gz.Close()
}

func addFileToTar(tw *tar.Writer, path, nameInArchive string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	hdr := &tar.Header{Name: nameInArchive, Mode: 0644, Size: info.Size(), ModTime: info.ModTime()}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return err
}

// addDirToTar 把 dirPath 下的所有普通文件(不递归子目录,照片目录目前是平铺存放的)
// 打进 tar,统一放在 prefix/ 前缀下;目录不存在时视为"没有照片",直接跳过不算错误。
func addDirToTar(tw *tar.Writer, dirPath, prefix string) error {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if err := addFileToTar(tw, dirPath+"/"+e.Name(), prefix+"/"+e.Name()); err != nil {
			return err
		}
	}
	return nil
}

// detectBackupFormat 通过文件内容的魔数判断上传的是新格式 .tar.gz 完整备份包,
// 还是旧格式的纯 .db 数据库文件,不依赖用户上传时的文件名/扩展名(更可靠)。
func detectBackupFormat(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	header := make([]byte, 16)
	n, _ := io.ReadFull(f, header)
	if n >= 2 && header[0] == 0x1f && header[1] == 0x8b {
		return "targz", nil
	}
	if n == 16 && string(header) == "SQLite format 3\x00" {
		return "db", nil
	}
	return "", fmt.Errorf("既不是 .tar.gz 完整备份包,也不是 .db 数据库文件")
}

// extractTarGz 解压到 destDir,对每个条目做路径穿越防护(拒绝包含 .. 或绝对路径的条目)
func extractTarGz(srcPath, destDir string) error {
	f, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("不是合法的 gzip 压缩包: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		cleanName := filepath.Clean(hdr.Name)
		if strings.HasPrefix(cleanName, "..") || filepath.IsAbs(cleanName) {
			continue // 跳过任何试图跳出解压目录的条目
		}
		outPath := filepath.Join(destDir, cleanName)
		if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
			return err
		}
		out, err := os.Create(outPath)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		out.Close()
	}
	return nil
}

// restoreFromArchive 恢复新格式的完整备份包:数据库 + 密钥 + 照片一起替换,
// 替换前把当前的这三样都留一份底(文件名/目录名带 before_restore_ 前缀),方便恢复出错时手动找回。
func restoreFromArchive(dataDir, archivePath string) (string, error) {
	extractDir := fmt.Sprintf("%s/restore_extract_%d", dataDir, time.Now().UnixNano())
	if err := os.MkdirAll(extractDir, 0755); err != nil {
		return "", fmt.Errorf("创建临时解压目录失败: %w", err)
	}
	defer os.RemoveAll(extractDir)

	if err := extractTarGz(archivePath, extractDir); err != nil {
		return "", fmt.Errorf("解压备份包失败: %w", err)
	}
	extractedDB := extractDir + "/wdmp.db"
	if _, err := os.Stat(extractedDB); err != nil {
		return "", fmt.Errorf("备份包中未找到 wdmp.db,不是本系统导出的完整备份包")
	}
	if err := validateBackupFile(extractedDB); err != nil {
		return "", fmt.Errorf("备份包中的数据库校验未通过: %w", err)
	}

	mainPath := dataDir + "/wdmp.db"
	keyPath := dataDir + "/vault.key"
	photosPath := dataDir + "/photos"
	ts := time.Now().Format("20060102_150405")

	if err := db.conn.Close(); err != nil {
		log.Printf("恢复备份:关闭旧数据库连接时出错(继续恢复流程): %v", err)
	}
	os.Remove(mainPath + "-wal")
	os.Remove(mainPath + "-shm")

	if err := os.Rename(mainPath, dataDir+"/before_restore_"+ts+".db"); err != nil {
		if newDB, reopenErr := openDB(mainPath); reopenErr == nil {
			db = newDB
		}
		return "", fmt.Errorf("备份当前数据库失败,已取消本次恢复: %w", err)
	}
	if _, err := os.Stat(keyPath); err == nil {
		os.Rename(keyPath, dataDir+"/before_restore_"+ts+"_vault.key")
	}
	if _, err := os.Stat(photosPath); err == nil {
		os.Rename(photosPath, dataDir+"/before_restore_"+ts+"_photos")
	}

	if err := os.Rename(extractedDB, mainPath); err != nil {
		// 尽量把原数据库挪回去,让服务恢复可用
		os.Rename(dataDir+"/before_restore_"+ts+".db", mainPath)
		if newDB, reopenErr := openDB(mainPath); reopenErr == nil {
			db = newDB
		}
		return "", fmt.Errorf("替换数据库文件失败: %w", err)
	}
	if _, err := os.Stat(extractDir + "/vault.key"); err == nil {
		os.Rename(extractDir+"/vault.key", keyPath)
	}
	os.MkdirAll(photosPath, 0755)
	if entries, err := os.ReadDir(extractDir + "/photos"); err == nil {
		for _, e := range entries {
			os.Rename(extractDir+"/photos/"+e.Name(), photosPath+"/"+e.Name())
		}
	}

	newDB, err := openDB(mainPath)
	if err != nil {
		return "", fmt.Errorf("恢复后重新打开数据库失败,请检查服务日志: %w", err)
	}
	if err := newDB.migrate(); err != nil {
		return "", fmt.Errorf("恢复后执行数据库结构升级失败: %w", err)
	}
	db = newDB

	log.Printf("管理员通过上传完整备份包恢复了数据(数据库+密钥+照片),恢复前的数据已保留在数据目录,文件/目录名带 before_restore_%s 前缀", ts)
	return fmt.Sprintf("数据已恢复(数据库+密钥+照片),所有人(包括你自己)需要重新登录。恢复前的数据已保存在服务器数据目录,文件/目录名以 before_restore_%s 开头,确认无误后可手动删除。", ts), nil
}

// restoreFromRawDB 兼容旧格式:上传的是纯 .db 文件(本次升级之前导出的备份),
// 只能恢复数据库本身,恢复不了密钥和照片——这两样如果当时也丢了,是找不回来的,
// 所以只在探测到旧格式时才走这个分支,新导出的备份都是完整包,不会再有这个限制。
func restoreFromRawDB(dataDir, dbPath string) (string, error) {
	if err := validateBackupFile(dbPath); err != nil {
		return "", fmt.Errorf("上传的文件不是合法的本系统备份数据库: %w", err)
	}

	mainPath := dataDir + "/wdmp.db"
	ts := time.Now().Format("20060102_150405")

	if err := db.conn.Close(); err != nil {
		log.Printf("恢复备份:关闭旧数据库连接时出错(继续恢复流程): %v", err)
	}
	os.Remove(mainPath + "-wal")
	os.Remove(mainPath + "-shm")

	safetyPath := fmt.Sprintf("%s/before_restore_%s.db", dataDir, ts)
	if err := os.Rename(mainPath, safetyPath); err != nil {
		if newDB, reopenErr := openDB(mainPath); reopenErr == nil {
			db = newDB
		}
		return "", fmt.Errorf("备份当前数据库失败,已取消本次恢复: %w", err)
	}
	if err := os.Rename(dbPath, mainPath); err != nil {
		os.Rename(safetyPath, mainPath)
		if newDB, reopenErr := openDB(mainPath); reopenErr == nil {
			db = newDB
		}
		return "", fmt.Errorf("替换数据库文件失败: %w", err)
	}

	newDB, err := openDB(mainPath)
	if err != nil {
		return "", fmt.Errorf("恢复后重新打开数据库失败,请检查服务日志: %w", err)
	}
	if err := newDB.migrate(); err != nil {
		return "", fmt.Errorf("恢复后执行数据库结构升级失败: %w", err)
	}
	db = newDB

	log.Printf("管理员通过上传旧格式(纯数据库)备份文件恢复了数据库,原数据库已保留为 %s", safetyPath)
	return "数据库已恢复(这是旧格式备份,只包含数据库,密钥和照片未受影响)。所有人(包括你自己)需要重新登录。原数据库已保存在服务器数据目录,文件名以 before_restore_ 开头,确认无误后可手动删除。", nil
}

// validateBackupFile 在真正替换数据库之前做校验,避免恢复一个损坏、无关或恶意构造的文件:
// 1. 检查 SQLite 文件头魔数
// 2. 用只读模式打开并跑 PRAGMA integrity_check
// 3. 检查几张核心业务表是否存在,确认这确实是本系统的备份,而不是随便一个 SQLite 文件
func validateBackupFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	header := make([]byte, 16)
	_, err = io.ReadFull(f, header)
	f.Close()
	if err != nil || string(header) != "SQLite format 3\x00" {
		return fmt.Errorf("文件头不是合法的 SQLite 数据库")
	}

	conn, err := sql.Open("sqlite3", path+"?mode=ro")
	if err != nil {
		return err
	}
	defer conn.Close()

	var integrity string
	if err := conn.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		return fmt.Errorf("数据库完整性校验未通过,文件可能已损坏")
	}

	for _, t := range []string{"users", "projects", "terminal_devices", "quantity_items"} {
		var name string
		if err := conn.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, t).Scan(&name); err != nil {
			return fmt.Errorf("缺少必要的表 %s,这不像是本系统导出的备份文件", t)
		}
	}
	return nil
}
