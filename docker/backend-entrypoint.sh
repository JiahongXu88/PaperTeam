#!/bin/sh
# PaperTeam backend entrypoint（M5.5）：
#   * 以 root 启动时：修正 volume 目录属主（首次挂载的空 volume 属 root）后
#     用 setpriv 降权到 paperteam 再 exec 主进程（PID 1 = node，SIGTERM 直达）
#   * 以非 root 启动（compose user: 指定）时：直接 exec
# 不读取 / 写入任何密钥；不修改镜像外内容。
set -eu

PROJECTS_ROOT="${PROJECTS_ROOT:-/data/projects}"
RUNTIME_ROOT="${PAPERTEAM_RUNTIME_ROOT:-/data/runtime}"

if [ "$(id -u)" = "0" ]; then
  for dir in "$PROJECTS_ROOT" "$RUNTIME_ROOT" /app/latex-cache; do
    mkdir -p "$dir"
    # 只在属主不对时修正目录本身及其子树（volume 首挂载为空，代价可忽略；
    # 已有数据的 volume 通常已是 paperteam 属主，不重复遍历）
    owner="$(stat -c '%U' "$dir" 2>/dev/null || echo unknown)"
    if [ "$owner" != "paperteam" ]; then
      chown -R paperteam:paperteam "$dir"
    fi
  done
  exec setpriv --reuid=paperteam --regid=paperteam --init-groups "$@"
fi

exec "$@"
