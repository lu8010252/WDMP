package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
)

func registerPhotoRoutes(mux *http.ServeMux, dataDir string) {
	mux.HandleFunc("GET /api/photos/audit", requireAdmin(photoAuditHandler(dataDir)))
	mux.HandleFunc("POST /api/photos/cleanup", requireAdmin(photoCleanupHandler(dataDir)))
}

type photoAuditResult struct {
	TotalFiles      int   `json:"total_files"`
	TotalBytes      int64 `json:"total_bytes"`
	ReferencedFiles int   `json:"referenced_files"`
	OrphanFiles     int   `json:"orphan_files"`
	OrphanBytes     int64 `json:"orphan_bytes"`
	DuplicateGroups int   `json:"duplicate_groups"`
	DuplicateFiles  int   `json:"duplicate_files"` // 重复文件里,除每组保留的一份外,多余的份数
	DuplicateBytes  int64 `json:"duplicate_bytes"`
}

// scanPhotos 是"预览"和"实际清理"共用的核心逻辑:
//  1. 列出 photos 目录下的所有物理文件
//  2. 查数据库(设备台账+安装登记)里当前正被引用的照片文件名集合
//  3. 对仍被引用的文件按内容 SHA-256 分组,找出内容相同但文件名不同的重复文件
//     (孤儿文件不用参与分组,反正孤儿文件本身就会被直接删掉,不需要判断是否重复)
func scanPhotos(dataDir string) (referenced map[string]bool, allFiles map[string]os.FileInfo, hashGroups map[string][]string, err error) {
	photosDir := dataDir + "/photos"
	entries, err := os.ReadDir(photosDir)
	if err != nil {
		return nil, nil, nil, err
	}
	allFiles = map[string]os.FileInfo{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, ierr := e.Info()
		if ierr != nil {
			continue
		}
		allFiles[e.Name()] = info
	}

	referenced = map[string]bool{}
	rows, err := db.conn.Query(`
		SELECT photo_path FROM terminal_devices WHERE photo_path IS NOT NULL AND photo_path != ''
		UNION ALL
		SELECT photo_path FROM install_records WHERE photo_path IS NOT NULL AND photo_path != ''`)
	if err != nil {
		return nil, nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			continue
		}
		referenced[baseName(p)] = true
	}

	hashGroups = map[string][]string{}
	for name := range allFiles {
		if !referenced[name] {
			continue
		}
		h, herr := fileSHA256(photosDir + "/" + name)
		if herr != nil {
			continue
		}
		hashGroups[h] = append(hashGroups[h], name)
	}
	return referenced, allFiles, hashGroups, nil
}

func baseName(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// photoAuditHandler 只做统计预览,不删除任何东西,给前端展示"清理会影响多少文件/释放多少空间"
func photoAuditHandler(dataDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		referenced, allFiles, hashGroups, err := scanPhotos(dataDir)
		if err != nil {
			writeErr(w, 500, "扫描照片目录失败: "+err.Error())
			return
		}
		result := photoAuditResult{TotalFiles: len(allFiles)}
		for name, info := range allFiles {
			result.TotalBytes += info.Size()
			if !referenced[name] {
				result.OrphanFiles++
				result.OrphanBytes += info.Size()
			} else {
				result.ReferencedFiles++
			}
		}
		for _, names := range hashGroups {
			if len(names) <= 1 {
				continue
			}
			result.DuplicateGroups++
			sorted := append([]string{}, names...)
			sort.Strings(sorted)
			for _, n := range sorted[1:] {
				result.DuplicateFiles++
				if info, ok := allFiles[n]; ok {
					result.DuplicateBytes += info.Size()
				}
			}
		}
		writeJSON(w, result)
	}
}

// photoCleanupHandler 真正执行清理:
//  1. 先合并重复文件——同一哈希分组里,保留文件名字典序最小的一份作为"canonical",
//     把所有指向其它重复文件的记录都改成指向 canonical,再删除多余的物理文件
//  2. 再删除孤儿文件——这一步执行完之后没有被任何记录引用的照片,直接删除
func photoCleanupHandler(dataDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s := sessionFromCtx(r)
		photosDir := dataDir + "/photos"
		referenced, allFiles, hashGroups, err := scanPhotos(dataDir)
		if err != nil {
			writeErr(w, 500, "扫描照片目录失败: "+err.Error())
			return
		}

		mergedRefs := 0
		duplicatesRemoved := 0
		var freedBytes int64

		for _, names := range hashGroups {
			if len(names) < 2 {
				continue
			}
			sorted := append([]string{}, names...)
			sort.Strings(sorted)
			canonical := sorted[0]
			canonicalPath := "/data/photos/" + canonical
			for _, dup := range sorted[1:] {
				dupPath := "/data/photos/" + dup
				res1, _ := db.conn.Exec(`UPDATE terminal_devices SET photo_path=? WHERE photo_path=?`, canonicalPath, dupPath)
				res2, _ := db.conn.Exec(`UPDATE install_records SET photo_path=? WHERE photo_path=?`, canonicalPath, dupPath)
				n1, _ := res1.RowsAffected()
				n2, _ := res2.RowsAffected()
				mergedRefs += int(n1 + n2)
				if info, ok := allFiles[dup]; ok {
					if err := os.Remove(photosDir + "/" + dup); err == nil {
						freedBytes += info.Size()
						duplicatesRemoved++
					}
					delete(allFiles, dup)
				}
			}
		}

		orphansRemoved := 0
		for name, info := range allFiles {
			if referenced[name] {
				continue
			}
			if err := os.Remove(photosDir + "/" + name); err == nil {
				orphansRemoved++
				freedBytes += info.Size()
			}
		}

		logAudit(s, "delete", "photo", 0, "cleanup", "",
			fmt.Sprintf("清理照片:合并重复文件 %d 个(更新了 %d 处引用),删除孤儿文件 %d 个,共释放 %s",
				duplicatesRemoved, mergedRefs, orphansRemoved, humanizeBytes(freedBytes)))

		writeJSON(w, map[string]any{
			"duplicates_removed": duplicatesRemoved,
			"merged_references":  mergedRefs,
			"orphans_removed":    orphansRemoved,
			"freed_bytes":        freedBytes,
		})
	}
}

func humanizeBytes(b int64) string {
	if b >= 1024*1024 {
		return fmt.Sprintf("%.1fMB", float64(b)/1024/1024)
	}
	return fmt.Sprintf("%.0fKB", float64(b)/1024)
}
