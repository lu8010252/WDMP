# ============================================================
# 弱电工程综合管理与运维平台 - Dockerfile
# 多阶段构建:编译阶段使用 golang:alpine(含 gcc,用于 CGO 版 SQLite 驱动),
# 运行阶段基于极小的 alpine 镜像,最终镜像体积小、运行时内存占用低。
# ============================================================

# ---------- 阶段一:编译 ----------
FROM golang:1.22-alpine AS builder

# mattn/go-sqlite3 需要 CGO 编译内置的 SQLite C 代码
RUN apk add --no-cache gcc musl-dev

WORKDIR /build

# 先拷贝依赖描述文件,利用 Docker 层缓存加速重复构建
COPY go.mod go.sum ./
RUN go mod download

COPY . .

ENV CGO_ENABLED=1 GOOS=linux
# -tags sqlite_fts5:mattn/go-sqlite3 默认不编译进 FTS5(全文检索)模块,必须显式加这个构建标签,
# 否则用到 FTS5 虚拟表的地方(全局搜索)会在启动时报错。
RUN go build -tags "sqlite_fts5" -ldflags="-s -w" -o /wdmp .

# ---------- 阶段二:运行 ----------
FROM alpine:3.19

# ca-certificates: 如需未来接入 HTTPS 外部请求; tzdata: 保证日志时间正确
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /wdmp /app/wdmp

# 数据目录(挂载宿主机 ./data 实现持久化)
# 注:此处不切换非 root 用户运行,是为了避免宿主机 bind mount 目录权限
# 与容器内用户 UID 不一致导致 SQLite 无法写入的问题,便于在各类 VPS 上开箱即用。
RUN mkdir -p /app/data

ENV DATA_DIR=/app/data \
    LISTEN_ADDR=:8080 \
    ADMIN_INIT_PASSWORD=admin123 \
    TZ=Asia/Shanghai

EXPOSE 8080
VOLUME ["/app/data"]

ENTRYPOINT ["/app/wdmp"]
