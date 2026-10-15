#!/usr/bin/env bash
# M14.3 浏览器级 thesis E2E 启动器（服务器 / Linux）。
#
# 用法（仓库根目录）：
#   bash frontend/e2e/run-thesis-e2e.sh
#
# 组件：
#   1. 罐头 docling wrapper（$E2E_TMP/fake-docling.sh）：探测与解析都成功，
#      解析产物含 scripted 贡献锚句（verbatim 锚定可复现）；
#   2. Backend（dist）：PAPERTEAM_TEST_RUNTIME=scripted + loopback + 独立端口
#      + 独立 PROJECTS_ROOT（真实编排 / checkpoint / SSE / 文件）；
#   3. Vite dev server（/api 代理到 backend）；
#   4. Playwright chromium（首次自动安装）。
set -euo pipefail
cd "$(dirname "$0")/../.."

export PATH="$HOME/node-v24.15.0-linux-x64/bin:$PATH"
E2E_TMP="$(mktemp -d /tmp/paperteam-e2e-XXXXXX)"
BACKEND_PORT=3210
# 进程组清理（子 shell 里的 node/vite 一并收口；含端口兜底）
trap 'kill ${BACKEND_PID:-0} ${VITE_PID:-0} 2>/dev/null; fuser -k 3210/tcp 2>/dev/null; fuser -k 5173/tcp 2>/dev/null; true' EXIT

# ---- 1. 罐头 docling（内容含 THESIS_CONTRIBUTION_QUOTE 锚句）----
cat > "$E2E_TMP/fake-docling.sh" << 'WRAPPER'
#!/bin/bash
if [ "${1:-}" = "-c" ]; then printf '%s
' '{"python":"3.12.0","module":"e2e-fake"}'; exit 0; fi
printf '%s\n' '{"ok":true,"parser":{"id":"docling","version":"e2e-fake"},"pdfPath":"e2e","pageCount":2,"blocks":[{"type":"text","textKind":"paragraph","page":1,"text":"本文提出了一种新的显著性目标检测方法，并在多个数据集上验证了其有效性。"},{"type":"table","page":2,"headers":["Method","S"],"rows":[["Ours","0.724"]],"rowCount":1,"columnCount":2,"caption":"表1 消融"}],"notes":[]}'
WRAPPER
chmod +x "$E2E_TMP/fake-docling.sh"

# ---- 2. Backend（真实 dist；模型输出 scripted）----
( cd backend \
  && PAPERTEAM_TEST_RUNTIME=scripted \
     PAPERTEAM_TEST_ALLOW_FIXTURE_ACTOR=1 \
     PAPERTEAM_PORT=$BACKEND_PORT \
     PAPERTEAM_HOST=127.0.0.1 \
     NODE_ENV=development \
     PROJECTS_ROOT="$E2E_TMP/projects" \
     PAPERTEAM_DOCLING_PYTHON="$E2E_TMP/fake-docling.sh" \
     node dist/index.js > "$E2E_TMP/backend.log" 2>&1 ) &
BACKEND_PID=$!

# ---- 3. Vite ----
( cd frontend && PAPERTEAM_PORT=$BACKEND_PORT npx vite --port 5173 --strictPort --host 127.0.0.1 > "$E2E_TMP/vite.log" 2>&1 ) &
VITE_PID=$!

# 就绪探测（backend /health + vite 端口）
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$BACKEND_PORT/health" > /dev/null 2>&1; then break; fi
  sleep 1
done
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:5173/" > /dev/null 2>&1; then break; fi
  sleep 1
done
echo "[e2e] backend(3210) 与 vite(5173) 就绪；日志：$E2E_TMP"

# ---- 4. Playwright ----
cd frontend
if [ ! -d node_modules/@playwright ]; then
  npm install --no-save @playwright/test >/dev/null 2>&1
fi
npx playwright install chromium 2>/dev/null || true
npx playwright test "$@"
