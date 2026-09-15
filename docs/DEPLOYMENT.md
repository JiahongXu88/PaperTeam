# PaperTeam 单机 Linux / Docker 部署（M5.5）

> 状态：**IMPLEMENTED / AWAITING REAL DOCKER ACCEPTANCE**（2026-09-14）。
> Dockerfile / compose / nginx / CI / readiness / 优雅停机 / 跨平台审计已完成并有自动化
> 测试（`backend/test/deploy/deployment.test.ts`），但**开发机（Windows，无 Docker Desktop /
> WSL）无法执行真实 `docker compose build / up / restart / down` 验收**。下面 §7 的
> 验收清单全部为「待执行」；只有在 Docker 主机上逐项跑通后，M5.5 才能标 COMPLETE。

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
| `latexmk`（首选）/ `xelatex`（fallback） | `backend/src/latex/LatexCompiler.ts`（`-xelatex -interaction=nonstopmode -halt-on-error -output-directory=…`） | `latexmk` + `texlive-xetex` |
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
- `GET /ready`：readiness——`ReadinessProbe`（`backend/src/runtime/readiness.ts`）：Runtime ok + `PROJECTS_ROOT` / `PAPERTEAM_RUNTIME_ROOT` 可创建可写（写入并删除探针文件）+ TeX（`latexmk`/`xelatex` 版本探测，60s 缓存）+ Python/pymupdf 状态。`ready = runtime && filesystem`；TeX / Python 缺失记入 `degraded`（Draft 构建 / PDF 导入会结构化失败，其余能力可用）。返回 200 / 503，不做任何昂贵调用。
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

## 7. 真实 Docker 验收清单（待执行；全部完成后 M5.5 才 COMPLETE）

在 Docker 主机上、仓库根执行并记录结果（写入 `docs/M5_ACCEPTANCE.md`）：

- [ ] `docker compose build` 成功（记录两镜像大小）
- [ ] `docker compose up -d`；`/health` 200；`/ready` 200 且 `degraded == []`（TeX + pymupdf 可用）；浏览器打开 `http://<host>:8080` 出现工作台
- [ ] 新建 project（Idea 或导入 PDF）
- [ ] PDF parser smoke：导入一份 PDF，PaperMap 解析成功（`GET /api/projects/:id/paper`）
- [ ] 最小 LaTeX compile：`POST /api/projects/:id/build` 或 Improvement 走到 build.draft，产出 Draft PDF
- [ ] volume 持久化：`docker compose restart` 后 project / revisions / evidence / checkpoints / artifacts / installed Skills（`GET /api/skills`）/ provenance / settings 仍在
- [ ] `docker compose down && docker compose up -d`（不带 `-v`）后再次验证以上数据仍在
- [ ] `docker stop`（45s 内）：日志出现 `stopped cleanly`，无强制退出；重启后 `checkpoints` 完整、中断 run 可恢复
- [ ] Linux 路径纯净：容器内 `GET /api/runtime/status` 与日志无 `C:\`、反斜杠路径

## 8. 本地开发不受影响

Windows / macOS 开发照旧 `npm run dev`（Vite 5173 代理到 Backend 3000）；`IS_WINDOWS`
门控的 `shell:true`（latexmk `.bat`）与 `py -3` 候选只在 Windows 生效；Linux 容器内
走 `spawn` 直接执行与 `python3` / venv 路径。
