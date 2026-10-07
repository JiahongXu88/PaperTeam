# PaperTeam Linux 服务器部署（M12.2.5）

> 面向「一台 Ubuntu 服务器 + 远程浏览器访问」的自托管单用户部署。
> 基础 Docker 形态自 M5.5 起可用（见 [../DEPLOYMENT.md](../DEPLOYMENT.md)）；
> 本篇是 Linux 服务器视角的完整手册：环境基线、Docker / 原生两种模式、
> docling 结构化解析、数据持久化、备份、升级、排障。
>
> 双运行时（公司 Windows 本地 + 个人 Linux 服务器）的分工与 credentials 边界
> 见 [dual-runtime.md](dual-runtime.md)。

## 1. 支持环境

| 项 | 基线 |
| --- | --- |
| 操作系统 | **Ubuntu 24.04 LTS（x86_64）**（官方 Linux baseline；22.04 亦可用） |
| Docker 模式 | Docker Engine 24+ / docker compose v2（推荐主路线） |
| 原生模式 | Node.js 22 LTS+（`npm run doctor` 自检）、TeX Live、Python 3.10+ |
| TeX | TeX Live（`texlive-xetex` 等，见 §5；不需要 MiKTeX） |
| 结构化解析 | docling 2.x（可选；缺省自动降级 pymupdf 文本层） |
| GPU | **不需要**（docling CPU 栈即可；模型推理走 API） |

### 推荐服务器规格

```text
8 vCPU / 16 GB RAM   —— 最低可实用（docling 结构化解析 + LaTeX 并行编译会吃 CPU）
8 vCPU / 32 GB RAM   —— 推荐（长跑 Workflow + 批量全文解析）
200 GB+ SSD          —— 项目数据 + HF 模型缓存（docling 模型约 1GB）+ TeX
```

## 2. Docker 模式（推荐主路线）

```bash
git clone https://github.com/JiahongXu88/PaperTeam.git
cd PaperTeam

cp .env.example .env
# 按需编辑 .env：模型 Key（或启动后在 Settings → 模型设置 页面保存）、
# PAPERTEAM_WEB_PORT 等。.env 已被 .gitignore 忽略，永远不进 Git。

docker compose up -d          # 构建 + 启动；首次构建约 10-20 分钟（TeX Live 层最大）
# 之后浏览器访问 http://<服务器地址>:8080
```

启动后验证：

```bash
docker compose ps                     # backend 应为 healthy
curl -fsS http://127.0.0.1:8080/health | jq .status     # "ok"
curl -fsS http://127.0.0.1:8080/ready | jq .ready       # true（TeX/Python 缺失只降级不阻塞）
```

架构：`web`（nginx：前端静态 + `/api` `/health` `/ready` 同源反代，唯一对外端口）
→ `backend`（Node 22 + Pi SDK + Python/pymupdf + XeLaTeX/bibtex + 中文字体，
容器网络内 `expose:3000` 不对外发布）。前端不需要任何跨域配置。

### 数据持久化

事实源全部在 named volume（`docker compose down` / 重建容器后数据仍在；
`down -v` 显式删 volume 才会丢）：

| volume | 容器路径 | 内容 |
| --- | --- | --- |
| `paperteam-projects` | `/data/projects`（`PROJECTS_ROOT`） | 全部项目工作区：manuscript / sources / evidence / figures / target benchmark·profile·readiness / workflow runs |
| `paperteam-runtime` | `/data/runtime`（`PAPERTEAM_RUNTIME_ROOT`） | 模型设置（model.json / custom-providers.json）、Pi auth.json、已安装 Skills |
| `paperteam-hf` | `/data/hf-cache` | docling 模型缓存（仅 backend-docling 镜像使用；重建容器不重复下载） |

### docling 结构化解析（可选）

基镜像只装 pymupdf（PDF 解析自动降级文本层，行为不变）。要完整结构化解析
（版面 / 表格结构 / 图片抽取）：

```bash
# 1) 构建 docling 增强镜像（+~4GB：torch CPU 栈；首次约 10 分钟）
docker build --target backend-docling -t paperteam-backend-docling:local .

# 2) .env 里切换镜像 + （可选）并发
echo 'PAPERTEAM_BACKEND_IMAGE=paperteam-backend-docling:local' >> .env
# echo 'PAPERTEAM_DOCLING_CONCURRENCY=2' >> .env

# 3) 重建 backend
docker compose up -d
```

首次解析会从 HuggingFace 下载模型（数百 MB，落 `paperteam-hf` volume 后不再
联网）；国内服务器在 `.env` 加 `HF_ENDPOINT=https://hf-mirror.com`。
docling 是 CPU 密集子进程，默认并发 1（逐个执行），服务器资源充足可调 2。

受限网络构建（国内服务器）：`PAPERTEAM_APT_MIRROR=http://mirrors.ustc.edu.cn
PAPERTEAM_PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple docker compose build`
（只影响构建期下载来源，不改变镜像内容）。

## 3. 原生模式（不装 Docker）

```bash
# 基础依赖
sudo apt update && sudo apt install -y nodejs npm python3 python3-venv git \
  texlive-xetex texlive-latex-base texlive-latex-recommended \
  texlive-latex-extra texlive-pictures texlive-lang-chinese texlive-bibtex-extra biber \
  fonts-noto-cjk
python3 -m pip install --user --break-system-packages "pymupdf>=1.24,<2"
# 可选：结构化解析（torch CPU 栈，约 4GB）
python3 -m pip install --user --break-system-packages "docling>=2,<3"

# 构建 + 启动
git clone https://github.com/JiahongXu88/PaperTeam.git && cd PaperTeam
npm run install:all
npm run build
npm run doctor                        # 部署自检（PASS/WARN/FAIL 三档）

# 数据根（两个事实源目录；建议放 /var/lib 或独立数据盘）
export PROJECTS_ROOT=/var/lib/paperteam/projects
export PAPERTEAM_RUNTIME_ROOT=/var/lib/paperteam/runtime
sudo mkdir -p "$PROJECTS_ROOT" "$PAPERTEAM_RUNTIME_ROOT"
sudo chown -R "$USER:" "$PROJECTS_ROOT" "$PAPERTEAM_RUNTIME_ROOT"

# 前台启动（bind 127.0.0.1:3000；systemd 单元模板见下）
node backend/dist/index.js
```

原生模式下前端由 `npm run dev`（开发）或任一静态服务器 + 反代提供；生产建议
直接用 Docker 模式获得同源 nginx。systemd 单元示例：

```ini
# /etc/systemd/system/paperteam.service
[Unit]
Description=PaperTeam backend
After=network-online.target

[Service]
WorkingDirectory=/opt/PaperTeam
Environment=NODE_ENV=production
Environment=PROJECTS_ROOT=/var/lib/paperteam/projects
Environment=PAPERTEAM_RUNTIME_ROOT=/var/lib/paperteam/runtime
Environment=PAPERTEAM_HOST=127.0.0.1     # 只监听回环：必须经反代/隧道访问
ExecStart=/usr/bin/node backend/dist/index.js
Restart=on-failure
# 协作式停机预算（与后端 PAPERTEAM_SHUTDOWN_TIMEOUT_MS 对齐）
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
```

## 4. 环境变量（服务器相关）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PAPERTEAM_HOST` | `127.0.0.1` | 监听地址。**默认回环是刻意的安全默认**；Docker 镜像内已显式 `0.0.0.0`。原生对外服务须显式设置并配合 §6 的访问控制 |
| `PAPERTEAM_PORT` | `3000` | 监听端口 |
| `PROJECTS_ROOT` | `./projects`（cwd 相对） | 项目工作区根（**无 `PAPERTEAM_` 前缀**，历史事实源变量） |
| `PAPERTEAM_RUNTIME_ROOT` | `~/.paperteam` | 运行时根（模型设置 / auth / skills；必须绝对路径） |
| `PAPERTEAM_PDF_PYTHON` | 自动探测 | pymupdf 解释器 |
| `PAPERTEAM_DOCLING_PYTHON` | 自动探测 | docling 解释器（docling 镜像已内置指向独立 venv） |
| `PAPERTEAM_DOCLING_CONCURRENCY` | `1` | docling 解析子进程并发上限 |
| `PAPERTEAM_PI_MAX_CONCURRENT_RUNS` | `4` | Agent 全局并发 |
| `PAPERTEAM_PI_MAX_QUEUED_RUNS` | `32` | Agent 等待队列容量 |
| `PAPERTEAM_WEB_PORT` | `8080` | compose：web 对外端口 |
| `PAPERTEAM_BACKEND_IMAGE` | `paperteam-backend:local` | compose：backend 镜像（切 docling 增强镜像用） |
| `HF_ENDPOINT` / `HF_HOME` | — | docling 模型下载镜像 / 缓存目录（镜像内 `HF_HOME=/data/hf-cache`） |

完整清单见根目录 `.env.example`。

## 5. TeX Live 与中文字体

后端只用 `xelatex` + `bibtex` 显式编排（无 MiKTeX 专属行为、无 latexmk 依赖），
TeX Live 全兼容。需要安装的包集（Docker 镜像已内置，原生模式按 §3 apt 安装）：

```text
texlive-xetex  texlive-latex-base  texlive-latex-recommended
texlive-latex-extra        ← standalone.cls（图表编译必需）
texlive-pictures           ← pgf / tikz / pgfplots（图表）
texlive-lang-chinese       ← ctex 文档类 + Fandol 中文字体（手稿与中文图表）
texlive-bibtex-extra + biber
fonts-noto-cjk             ← 兜底中文字体
```

中文渲染链：手稿模板 `ctexart` 与图表 codegen 的 ctex 导言在 Linux 自动选用
**Fandol** 字体（`texlive-lang-chinese` 提供），不依赖 SimSun / Microsoft YaHei
等 Windows 字体。字体缺失时：编译诊断会给出 `kind=font` 分类与安装建议
（`npm run doctor` 的 `kpsewhich` 探测也会 WARN 提示），不会只看到
"xelatex failed"。

## 6. 网络与安全（重要）

**PaperTeam 当前没有用户认证。** 任何能访问端口的人都能读写你的全部项目与
模型配置。因此：

- Docker 模式：`PAPERTEAM_WEB_PORT` 只绑服务器本地 / 内网，**不要**在安全组
  里对公网开放 8080。
- 原生模式：保持 `PAPERTEAM_HOST=127.0.0.1`（默认），远程访问走：
  - **SSH 隧道（推荐，零额外组件）**：`ssh -L 8080:127.0.0.1:8080 user@server`，
    然后本地浏览器开 `http://127.0.0.1:8080`；
  - 或 Tailscale / WireGuard 类私网，或云安全组白名单（仅家庭/办公出口 IP）。
- 本阶段不引入 Auth / TLS / 反代证书编排；若未来直接暴露公网，必须先补认证层。

## 7. 备份

必须备份的目录（都在 volume / 数据根下，与代码完全解耦）：

```text
PROJECTS_ROOT          全部项目数据（manuscript / sources / evidence / figures / target 三件套 / workflow runs）
PAPERTEAM_RUNTIME_ROOT 模型设置 + custom providers + 已装 skills
/data/hf-cache         docling 模型缓存（可重建，备份可省；重新下载即可）
```

文件系统级备份即可（tar / rsync / 云盘快照）。**注意**：
`PAPERTEAM_RUNTIME_ROOT/runtime/pi/agent/auth.json` 含 API Key——备份介质要
加密保管；**不要**把它随项目数据一起分享/导出（项目导出不含它，见
dual-runtime.md 的迁移纪律）。

```bash
# 示例：停写后热备（compose 模式；volume 实际名以 docker volume ls 为准，
# 默认形如 paperteam_paperteam-projects）
docker compose stop backend
sudo tar -czf paperteam-$(date +%F).tgz /var/lib/docker/volumes/paperteam_paperteam-projects \
  /var/lib/docker/volumes/paperteam_paperteam-runtime
docker compose start backend
```

## 8. 升级

```bash
cd PaperTeam
git pull
docker compose build          # 或先构建 docling 目标再切 PAPERTEAM_BACKEND_IMAGE
docker compose up -d          # 滚动重建容器；volume 数据不动
```

升级前后各看一次 `docker compose logs backend | grep -i error` 与
`curl /ready`。跨版本数据目录结构不兼容时会在启动日志明确报错（fail-closed），
不会静默损坏数据。

## 9. 排障

| 症状 | 定位与处理 |
| --- | --- |
| 容器反复重启 | `docker compose logs backend`（启动 ConfigError 会写明哪个 env 非法） |
| `/ready` 503 | 看 body：runtime 不健康（模型 provider 配置问题）或数据根不可写（volume 权限，entrypoint 已自动 chown，检查挂载） |
| PDF 生成失败（LaTeX） | `/ready` 的 `degraded` 与 `build/compile.log`；字体类错误带 `kind=font` 与安装建议 |
| 图表编译 `package_missing: standalone` | TeX 缺 `texlive-latex-extra`（原生 apt 安装；Docker 镜像已内置） |
| 结构化解析降级文本层 | `PAPERTEAM_DOCLING_PYTHON` 指向的解释器无 docling：换 backend-docling 镜像或 pip install docling；`npm run doctor` 有专项检查 |
| docling 首次解析慢 / 失败 | 模型下载中（数百 MB）；国内加 `HF_ENDPOINT=https://hf-mirror.com`；超时上限 600s/篇 |
| 端口被占 | `PAPERTEAM_WEB_PORT` 换端口；原生模式换 `PAPERTEAM_PORT` |
| API Key 泄露怀疑 | Settings → 模型设置里登出重存；auth.json 只在 `PAPERTEAM_RUNTIME_ROOT/runtime/pi/agent/` 下，删除即清除 |

## 10. 验收口径

Docker 形态的持久化 / 重启 / down-up / 图表编译 / docling 全链均有 CI 自动验收
（`ci.yml` docker smoke + `linux-integration.yml`），本机部署后至少复验：

```bash
docker compose ps                                   # healthy
curl -fsS http://127.0.0.1:8080/ready | jq .ready   # true
# 浏览器创建一个项目 → 上传一篇 PDF → docker compose restart → 项目与解析产物仍在
```
