# PaperTeam 单机 Linux / Docker 部署（M5.5）

> 状态：**✅ COMPLETE（真实 Docker 验收 2026-09-15）**。Docker 主机 = 同一台开发机上的
> WSL2 Ubuntu 24.04 + Docker Engine 29.8 / Compose v5.5（未安装 Docker Desktop：公司环境
> 无法确认其商业授权，改用 WSL2 内的 Docker Engine；见 docs/M5_ACCEPTANCE.md §4.7）。
> §7 清单逐项真实执行并通过；构建期需要 apt / pip 镜像（§3）。

形态：单机、单用户、Linux / Docker。不做 Kubernetes / HA / autoscaling / 多租户 /
Redis / 外部任务队列 / System Admin / 登录系统。

## 1. 架构

```
浏览器 ──► web（nginx :80 → 主机 ${PAPERTEAM_WEB_PORT:-8080}）
            ├─ /            Frontend 静态资源（Vite build）
            └─ /api /health /ready ──► backend:3000（compose 内部网络，不对外发布）
                                         ├─ Node 22 + Backend dist + Pi SDK（in-process Runtime）
                                         ├─ Python3 venv + pymupdf（PDF 解析）
                                         ├─ XeLaTeX / latexmk / biber + ctex + Fandol / Noto CJK
                                         └─ volumes：/data/projects（PROJECTS_ROOT）
                                                     /data/runtime（PAPERTEAM_RUNTIME_ROOT）
```

用户只访问一个地址；`/api` 同源（无 CORS）；Backend `:3000` 只在 compose 网络内可达。

## 2. 运行依赖审计（以源码与 doctor 为准，不凭计划猜）

| 依赖 | 来源 | 镜像中的落点 |
|---|---|---|
| Node `>=22.22.3 <23 \|\| >=24.15 <25 \|\| >=25.9`（root `package.json` engines） | Backend / Frontend 构建 | `node:22-bookworm-slim` |
| `@earendil-works/pi-coding-agent` 0.84.4 | Pi in-process Runtime | backend `node_modules`（`npm prune --omit=dev`） |
| Python 3 + `pymupdf` | `backend/src/paper/pdfToolchain.ts` 候选 `PAPERTEAM_PDF_PYTHON` > python > python3 > py -3；脚本 `backend/tools/parse_paper_pdf.py` | `/opt/paperteam-venv`（`PAPERTEAM_PDF_PYTHON` 指向其 python） |
| `xelatex` + `bibtex`（显式编排） | `backend/src/latex/LatexCompiler.ts`（M9.5.1：xelatex → bibtex → xelatex × 2，staging 统一 build/ 工作目录；不依赖 latexmk/perl） | `texlive-xetex` |
| TeX 包：`ctexart`、`amsmath`、`amssymb`、`natbib`（`ManuscriptService.writeMainTex`）；导入论文常见 `xcolor / graphicx / hyperref / pgf(tikz) / biblatex` | 模板 + Existing-Paper 导入 | `texlive-latex-base` / `texlive-latex-recommended` / `texlive-lang-chinese`（ctex + Fandol） / `texlive-pictures` / `texlive-bibtex-extra` + `biber` |
| 中文字体 | ctex 默认 Fandol；fontspec 按名引用时需系统字体 | `texlive-lang-chinese`（Fandol）+ `fonts-noto-cjk` |
| Git | Backend 运行时**不**调用 git（已 grep）；Pi SDK / 用户导入项目可能带 git 元数据 | `git`（小，可选） |
| Skill Registry 审计 seed | `backend/skills/seed/`（`defaultSeedsRoot()` 相对 dist 解析） | `COPY backend/skills ./skills` |
| PDF 解析脚本 | `backend/tools/`（相对 dist 解析） | `COPY backend/tools ./tools` |

**不装 `texlive-full`**：体积 4-5 GB、维护成本高；上表已覆盖 PaperTeam 模板与导入论文的
真实需要。若某篇导入论文依赖其它包，编译失败会以结构化 Build Gate 结果呈现（Draft 可继续），
按需在 Dockerfile 追加包即可。

## 3. 构建与启动

```bash
# 在仓库根（Linux / Docker 主机）
cp .env.example .env            # 可选：填入 PAPERTEAM_PI_MODEL / PAPERTEAM_PI_API_KEY 等
docker compose build            # 两个目标：backend、web（多阶段，最终镜像只含运行内容）
docker compose up -d
curl -fsS http://localhost:8080/health     # liveness（进程活着、Runtime 可初始化；不调模型）
curl -fsS http://localhost:8080/ready      # readiness（Runtime + 数据根可写 + TeX / Python 状态）
open http://localhost:8080                 # Web 工作台
```

`.env` 缺失也能启动（模型 `not_configured`，UI 提示到「设置 → 模型设置」保存 Key，
落到 runtime volume 的 `auth.json`）。`PAPERTEAM_WEB_PORT` 改对外端口。

**受限网络构建**（M5.5 真实验收发现：构建主机到 deb.debian.org 约 20 KB/s、pypi.org 单请求
25 s，368 MB 的 TeX 包集实际不可完成）：`Dockerfile` 提供两个只在构建期生效的 build-arg，
compose 从环境变量透传，缺省仍是官方源、镜像内容不变（同一套 Debian / PyPI 包）：

```bash
PAPERTEAM_APT_MIRROR=http://mirrors.ustc.edu.cn \
PAPERTEAM_PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
docker compose build
```

`APT_MIRROR` 是主机前缀（替换 `http://deb.debian.org/` 下的 `debian` 与 `debian-security`；
基础镜像无 ca-certificates，用 http 镜像）。Docker Hub 不可达时在 daemon 侧配 registry mirror，
与仓库无关。

## 4. 持久化（事实源 = volume，不是容器可写层）

| volume | 容器路径 | 内容 |
|---|---|---|
| `paperteam-projects` | `/data/projects` | project / manuscript / revisions（不可变修订链）/ evidence / reviews（review / gate / plan / style-polish）/ checkpoints（WorkflowRun）/ artifacts（Draft / Final PDF）/ paper（PDF 与 PaperMap） |
| `paperteam-runtime` | `/data/runtime` | installed Skills + versions 快照 + provenance / Skill 中文简介 / settings（model.json、custom providers）/ Pi agentDir（auth.json、models.json）|

删除并重建容器（`docker compose down && docker compose up -d`）后以上全部保留；
`docker compose down -v` 才会删除数据（有意为之才执行）。首次挂载的空 volume 属主为
root：`docker/backend-entrypoint.sh` 以 root 启动时修正为 `paperteam` 后用 `setpriv`
降权再 `exec node`（PID 1 = node，SIGTERM 直达）。

## 5. 密钥

- 镜像不含 `.env`、`auth.json`、任何 Key（`.dockerignore` 排除；Dockerfile 无 `COPY .env`；测试断言）。
- compose 只写非敏感环境变量；Key 通过同目录 `.env`（`env_file`，可缺省）或 Settings UI 注入。
- `.gitignore` 已忽略 `.env`、`/runtime/`、`projects/`；仓库内只保留 `.env.example`。
- 如需 Docker secret：把 `PAPERTEAM_PI_API_KEY` 换成 `secrets:` 挂载后在 entrypoint 读入环境变量即可（本轮未加，单机形态 `.env` 已足够且最小）。

## 6. 健康 / 就绪 / 停机

- `GET /health`：liveness——进程活着、Runtime `healthCheck`（不调用模型）。Docker `HEALTHCHECK` 与 compose `healthcheck` 用它；web 依赖 `service_healthy`。
- `GET /ready`：readiness——`ReadinessProbe`（`backend/src/runtime/readiness.ts`）：Runtime ok + `PROJECTS_ROOT` / `PAPERTEAM_RUNTIME_ROOT` 可创建可写（写入并删除探针文件）+ TeX（`xelatex`/`bibtex` 版本探测，60s 缓存）+ Python/pymupdf 状态。`ready = runtime && filesystem`；TeX / Python 缺失记入 `degraded`（Draft 构建 / PDF 导入会结构化失败，其余能力可用）。返回 200 / 503，不做任何昂贵调用。
- `GET /api/runtime/status`：模型就绪、会话诊断（含每会话 assignedSkills）。
- **SIGTERM（docker stop）**：`registerShutdown`（`backend/src/index.ts`）——① `server.close()` 停止接受新连接（新任务不再受理）；② `orchestrator.close()` 取消活跃 run（queued 即时终态、running 协作式 abort；checkpoint 随 stage 落盘，取消不会写半个 checkpoint）；③ `runtime.close()` 收敛在途 run、释放全部 AgentSession、清理 GC / 超时定时器；④ `closeAllConnections` 后 exit 0。兜底 `PAPERTEAM_SHUTDOWN_TIMEOUT_MS`（默认 30s；compose 设 40s）超时强制 exit 1 并记日志；compose `stop_grace_period: 45s` > 预算。旧实现固定 5s 对长任务过短，已改为可配置。

### 6.1 Agent 执行超时分层（M5.6）

| 层 | 配置 | 默认 | 适用 |
|---|---|---|---|
| Runtime 通用执行超时 | `PAPERTEAM_PI_RUN_TIMEOUT_MS`（/ `PAPERTEAM_PI_EXECUTION_TIMEOUT_MS`） | 300 s | 可行性评估、PaperMap 章节摘要、PDF 分析、引用核验 Agent、Skill 简介等短任务；Runtime 全局契约，不建议整体抬高 |
| 长论文阶段执行超时 | `PAPERTEAM_PI_LONG_RUN_TIMEOUT_MS` | 900 s | Writer（章节写作 / 逐节修订 / 润色 / 改进计划 / 编译修复）、三路 Reviewer、分章节 Reviewer、Researcher——以整篇论文为输入；逐 run 以 `RunAgentInput.timeoutMs` 覆盖，不改 Runtime 默认 |
| Stage 空闲超时 | `WORKFLOW_STAGE_TIMEOUT_MS` | 900 s | 连续无进度汇报即判超时（分章节 stage 按章节汇报，可超过该值） |

依据：M5.6 真实 26 页中文论文验收——第一轮两臂都在 300 s 执行超时失败（Writer 单节修订、
academic / style Reviewer）；B3 实测单节修订最长 626 s、单路审稿 315 s。短任务保持 300 s 是为了
让真正卡死的调用尽早以 `EXECUTION_TIMEOUT` 结构化失败，而不是被长论文口径掩盖。

## 7. 真实 Docker 验收清单（✅ 2026-09-15 全部通过；明细见 docs/M5_ACCEPTANCE.md §4.7）

Docker 主机：WSL2 Ubuntu 24.04（内核 6.18.33-microsoft-standard-WSL2）+ Docker Engine 29.8.0 /
Compose v5.5.1 / buildx v0.37.1；仓库 = 同一个 checkout（`/mnt/d/Projects/PaperTeam`，HEAD 与
Windows 一致）。执行脚本与原始日志保留在本机 `~/.paperteam-acceptance/docker/`。

- [x] `docker compose build`：573 s（apt / pip 走 USTC / TUNA 镜像）；`paperteam-backend:local` 1.99 GB、`paperteam-web:local` 83.5 MB；镜像内 Node v22.23.2、Python 3.11.2、pymupdf 1.28.2、git 2.39.5、XeTeX 3.141592653-2.6-0.999994（TeX Live 2022/Debian）、latexmk 4.79、biber 2.18、ctexart.cls、FandolSong 字体，进程用户 `paperteam`
- [x] `docker compose up -d`：8 s 后 `/health` 200；`/ready` 200 且 `degraded == []`（latexmk 可用、python + pymupdf 可用、两个数据根可写）；`/api/runtime/status` runtime healthy（模型 not_configured，未注入 Key 属预期）；Windows 主机 `http://localhost:8080` 首页 / assets / `/api/projects` 均 200
- [x] 新建 project（`m5-docker-acceptance-<ts>` + researchIdea marker）→ 201，`/data/projects/<id>/project.json` 落 volume；`GET /api/skills` 5 个 Skill 已安装（academic-review / academic-style-zh / academic-writing-zh / paper-search / verify-citations），`/data/runtime/skills/installed` 5 项
- [x] PDF parser smoke：`POST /api/projects/import-pdf`（仓库 fixture `attention.pdf`，2.2 MB）→ 201，15 页 / 23 节 / 标题来自 PDF——容器内 Python 子进程 + PyMuPDF 真实解析
- [x] 最小 LaTeX compile：导入 ctexart + amsmath + natbib 中文稿 → `POST /build` passed（latexmk）→ `build/paper.pdf` 32 KB；PyMuPDF 抽文本含中文，main.log 为 XeTeX 且引用 Fandol 字体 10 处，bibtex 生成参考文献 [1]
- [x] `docker compose restart`（3 s 恢复健康）后 project / marker / 5 个 Skill / runtime 目录仍在
- [x] `docker compose down && docker compose up -d`（不带 `-v`，容器与网络重建，volume 保留）后同样全部仍在
- [x] `docker compose stop`：日志 `shutting down (SIGTERM)... budget=40000ms` → `stopped cleanly`，容器 exit code 0，1 s 内完成；`start` 后数据仍在；容器内无 zombie 进程、日志无 unhandled rejection
- [x] Linux 路径纯净：日志与 `/api/runtime/status` 无 `C:\` / 反斜杠路径

## 8. 可选服务：SearXNG（M6.3 Web Search）

Web Search（`search_web` 工具 / `POST /api/projects/:id/research/web-search`）由
独立 SearXNG 元搜索引擎承担，**可选、默认不启动**——不启用时 PaperTeam /
Academic Search / Literature Library 全部照常工作（Web Search 结构化 503
`SEARCH_PROVIDER_NOT_CONFIGURED`）。

```bash
# 1) 启用可选 profile（默认 docker compose up 不含它）
docker compose --profile research up -d

# 2) 在同目录 .env 加一行（compose 网络内服务名；backend 经此地址调用）
echo 'PAPERTEAM_SEARXNG_URL=http://searxng:8080' >> .env
docker compose up -d backend   # 重建 backend 使 env 生效

# 3) 验证（searxng 只对 compose 网络内 expose:8080，宿主机不直达——经 backend 验证）
PROJECT_ID=<你的项目 id>
curl -fsS -X POST http://localhost:8080/api/projects/$PROJECT_ID/research/web-search \
  -H 'Content-Type: application/json' -d '{"query":"test","limit":3}'
curl -fsS http://localhost:8080/api/research/providers   # PaperTeam 侧健康观测
#    自备 settings 时务必在 search.formats 加 json——SearXNG 上游默认只有 html，
#    未启用时 /search 对 format=json 返回 403（PaperTeam 如实报 misconfigured）
```

- 配置模板 `docker/searxng/settings.yml`（挂载为只读）：`use_default_settings:
  true` 深度合并；**必改三项已就位**——`search.formats` 加 `json`；`server.limiter:
  false`（内网部署；开启且无 valkey 时 JSON API 限 4 次/小时/IP）；大陆引擎白名单
  `bing`（base_url 覆盖 `https://cn.bing.com`）+ `baidu`。engine 名是 SearXNG
  上游真实模块名（与上游 settings.yml 一致，勿自造）。
- 境外引擎（DDG/Brave 等）需代理：在 settings.yml 的 `outgoing.proxies` 配置
  `socks5h://…`（模板尾有注释示例）。
- 本机裸跑（不经 compose）：自行启动 SearXNG 后设
  `PAPERTEAM_SEARXNG_URL=http://127.0.0.1:8080`（端口以实际为准，勿假设 8080）。
- `GET /api/research/providers` 返回全部 search provider 的健康四态
  （healthy/degraded/rate_limited/unavailable）；`unresponsive_engines` 非空时
  SearXNG provider 如实 degraded（继续可用，结果标注）。
- **M9.2 起**：backend 的 `PAPERTEAM_SEARXNG_URL` 在 compose 中显式透传
  （`${PAPERTEAM_SEARXNG_URL:-}`，缺省空 = 未配置）——`.env` 一处设置即可，
  不需要重建镜像，`docker compose up -d backend` 重建容器生效；前端
  Discovery 的 Web 检索页签会显示 SearXNG 可用性（未配置警告 / 状态行），
  `GET /api/research/providers` 是其数据源。实测验收（WSL2 Docker Engine，
  2026-09-22）见
  [research/M9.2_GENERAL_WEB_SEARCH_ACTIVATION.md](research/M9.2_GENERAL_WEB_SEARCH_ACTIVATION.md)。

## 9. 本地开发不受影响

Windows / macOS 开发照旧 `npm run dev`（Vite 5173 代理到 Backend 3000）；`IS_WINDOWS`
门控的 `shell:true`（latexmk `.bat`）与 `py -3` 候选只在 Windows 生效；Linux 容器内
走 `spawn` 直接执行与 `python3` / venv 路径。
