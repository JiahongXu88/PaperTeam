# M12.2.5 — Linux & Dual-Runtime Deployment Closure

> 日期：2026-10-07 · 基线 `0833974`（M12 Batch 2 收口）→ 本阶段 `9b3690b+`
> 目标：**同一套 PaperTeam 代码稳定运行在 Windows 本地开发机与 Linux 服务器上，
> 两台机器拥有完全独立的模型 / API 配置；代码同步、credentials 不同步。**
> 两种一等运行模式：Mode A（Windows 本地 + MiKTeX + 公司/私有 Provider）与
> Mode B（Linux Server + TeX Live + 公网 Provider + 持久数据）。

## 0. Verdict

**M12.2.5 Linux & Dual-Runtime Closure COMPLETE**（判定明细见 §9 完成判定；
CI 验收记录见 §8）。Windows 兼容未破坏（全量回归 2815+287 全绿，真实
figure/docling smoke 过）；Linux 侧以 GitHub Actions Ubuntu runner 为验收
环境，覆盖 Docker 构建 / 容器 boot / ready / 图表编译（含 CJK）/ 持久化 /
compose 起停 / docling 全链（native + 容器内子进程生命周期）。

不做的（预注册边界）：SaaS / 多用户 / Auth / DB / Redis / Job Queue /
K8s / MCP / reverse-proxy 编排 / 自动证书。本轮为 remote single-user
self-hosted deployment 收口。

## 1. Git baseline 与收口态

```text
开工基线   main 0833974 == origin/main，tree clean，CI run 37589634497 ✓
本阶段提交 508803f feat(runtime): PAPERTEAM_HOST bind config + docling parse concurrency cap
          4d2cb9a feat(figures): CJK-aware codegen preamble + structured font diagnostics
          7fd2de5 feat(deploy): Linux dual-runtime closure (docling image, doctor v2, CI persistence)
          9b3690b docs(deploy): linux-server + dual-runtime guides and cross-links
          8ef313f fix(test): platform-neutral absolute paths in runtime isolation test
          16fcc58 fix(ci): surface docling docker smoke error payload; /proc process count
          710ff29 fix(deploy): backend-docling image needs libgl1 for docling image pipeline
          + 收口 docs 提交（本报告 + PROJECT_STATUS，CI 终态记录见 §8）
```

## 2. OS 耦合审计（开工前置，四路并行 subagent 全库扫描）

结论先行：**backend/src 的 OS 耦合纪律极好，不是预设问题重灾区**。发现与处置：

| 发现 | 分类 | 处置 |
| --- | --- | --- |
| `LatexCompiler.ts:82` / `FigureCompiler.ts:86` 的 `IS_WINDOWS` shell 门控 | 既有双平台分支（Windows 解析 MiKTeX .cmd 包装；Linux 直 exec 无 shell） | 无需改；守卫测试持续强制 |
| 源码零硬编码盘符 / 零 cmd·powershell 调用（`deployment.test.ts:272-307` 扫描强制） | 既有保障 | 沿用 |
| **Docker 镜像缺 `standalone.cls`**（texlive-latex-extra 未装）→ Linux 图表编译必挂 `package_missing` | 真实缺口（High） | Dockerfile 补包 + 构建期 `kpsewhich standalone.cls/pgfplots.sty/ctexart.cls` 验证 |
| **图表 codegen 无 CJK 字体设置** → 中文标签缺字形（全平台） | 真实缺口（Medium） | codegen CJK 探测 → 条件 `\usepackage[UTF8]{ctex}`（ctex 自动平台选字体） |
| **Docker 无 docling**（仅 pymupdf，结构化解析静默降级文本层且无文档） | 缺口（Medium） | 新增 `backend-docling` 可选镜像目标 + compose 切换 + HF 缓存 volume + 文档 |
| **无 PAPERTEAM_HOST，`listen(port)` 绑全部网卡**（::/0.0.0.0——非保守默认） | 缺口（安全 posture） | `PAPERTEAM_HOST`（默认收紧 127.0.0.1；Docker 显式 0.0.0.0） |
| 历史里程碑脚本（m114-*、m1042、benchmark-review）硬编码 `D:\`、taskkill、cmd netstat | Windows-only 开发脚本（一次性验收产物，不进产品/CI） | 如实登记为已知限制，不翻旧账重写 |
| `e2e/acceptance/browser.mjs` 仅 Windows Chrome 候选 / powershell / netstat | 双平台缺口（验收 harness） | 双平台化（Linux Chrome 候选、/proc cmdline、SIGTERM、ss 核验） |
| `docs/development.md:82` 误写 `PAPERTEAM_PROJECTS_ROOT`（实际变量无前缀） | 文档 bug | 修正 |
| 数据根已存在等价事实源：`PROJECTS_ROOT` + `PAPERTEAM_RUNTIME_ROOT`（双根架构，Docker /data 映射齐备） | 既有机制 | **不重造 PAPERTEAM_DATA_DIR**，按任务书 §5 复用并文档化 |
| CRLF / 行尾：内容入口 CRLF→LF 归一、skills hash 行尾归一（autocrlf checkout 与 Linux hash 相等） | 既有保障 | 沿用 |
| `py -3` 候选 / `windowsHide` / Windows kill-orphan（shell:true 只杀 cmd） | Windows 侧无害分支 / 已知遗留 | 沿用（getting-started 已登记） |

## 3. 实施明细（代码 → 测试 → Docker → CI → 文档）

### 3.1 PAPERTEAM_HOST（§17 Server Bind）

- `config.ts`：`host` 字段 + `readHost`（缺省 `127.0.0.1`；`HOST_PATTERN` 白名单
  IP/IPv6/主机名，拒绝路径分隔符与空白；非法 `ConfigError` 拒绝启动）。
  **默认从「绑所有网卡」收紧为回环**——对无鉴权服务是刻意的保守默认；
  原生服务器对外服务需显式 `PAPERTEAM_HOST=0.0.0.0`（文档给出 SSH 隧道 /
  Tailscale / 安全组白名单的访问模型）。
- `index.ts`：`server.listen(port, host)`；启动日志打印实际绑定点。
- Docker：Dockerfile `ENV PAPERTEAM_HOST=0.0.0.0` + compose environment 显式
  （容器内必须放开给 nginx 反代；CI 容器 smoke 验证 127.0.0.1:3000 探测不受影响）。
- 测试：config.test（默认/覆盖/`0.0.0.0`/`::1`/非法 4 形态）+ deployment.test 契约。

### 3.2 Data Root（§5/§6）

结论：**既有双根即数据根机制，本轮零代码变更、只收口文档与守卫**：

```text
PROJECTS_ROOT           项目工作区（全部业务 artifact：manuscript / sources /
                        evidence / figures / target 三件套 / workflow runs）
PAPERTEAM_RUNTIME_ROOT  机器本地配置（settings/model.json、custom-providers.json、
                        runtime/pi/agent/auth.json、installed skills）
```

Windows `D:\PaperTeamData\{projects,runtime}` / Linux `/var/lib/paperteam/*` /
Docker volume `/data/{projects,runtime,hf-cache}` 三种布局写入
dual-runtime.md。`/ready` 的 ReadinessProbe 早已探测两根可写（fail-closed）。
业务代码零 OS 硬编码路径（守卫测试强制），目录结构平台字节兼容
（入口 CRLF→LF、hash 行尾归一）。**不引入第三变量**（任务书 §5「已有等价
事实源优先复用」）。

### 3.3 docling 并发（§13 Concurrency）

- `DoclingParser` 进程级 FIFO 信号量：`maxConcurrency`（默认 1；0/负/非整数
  收敛 1），`parseFile` 全程持槽。既有「同 source 单飞去重 + 后台串行链」不动；
  本信号量补的是**不同 source 显式并发 ingest** 的进程数上限（torch 子进程
  逐个执行）。
- `PAPERTEAM_DOCLING_CONCURRENCY`（1-8，默认 1，非法回退——调优项纪律）经
  config → index → serviceStack → DoclingParser 接线。
- 测试：`doclingConcurrency.test.ts`（fake 脚本 marker S/E 序列：默认无重叠、
  =2 有重叠、非法收敛 1）。
- 其余并发既有且 env 驱动：`PAPERTEAM_PI_MAX_CONCURRENT_RUNS=4`（strict）、
  `MAX_QUEUED_RUNS=32`、REVIEW/SUMMARY=3、FULLTEXT=3。图表编译单图单编译
  （无并行批路径，C4 未接线前不加 semaphore——不过度工程）。

### 3.4 图表 CJK + 字体诊断（§9/§10）

- `latexEscape.containsCjk`（码点谓词覆盖 CJK 统一表意/扩展 A/兼容/标点/
  假名/谚文/全角形；源码保持纯 ASCII 的模块纪律）。
- `renderPlotTeX` / `renderDiagramTeX`：全部用户可见文本（title/轴名/series/
  类目/节点/边/group 标签）探测命中 → documentclass 后插入
  `\usepackage[UTF8]{ctex}`。ctex 在 Windows 选中易体系、TeX Live 选 Fandol
  ——与手稿模板 ctexart 同一依赖面，不引入按名引用的额外字体；纯 ASCII 图
  字节不变。
- `diagnostics.ts`：`FONT_ISSUE_PATTERN`（fontspec/xeCJK/not loadable/font size
  not available/Missing character）→ `kind: "font"` + `FONT_ISSUE_HINT`
  （TeX Live: texlive-lang-chinese + fonts-noto-cjk；MiKTeX 自动安装；Docker
  已内置）。FigureCompiler 失败摘要附带提示——**用户不再只看到 "xelatex failed"**。
- Windows 真实验证：figureReal smoke（真实 MiKTeX）+ `docker/figure-smoke.mjs`
  本地 5/5（line/grouped_bar/scatter/TikZ/**CJK**，缓存二次命中 + %PDF- 魔数）。

### 3.5 Docker 收口（§15/§16）

- 基镜像：+`texlive-latex-extra`（standalone.cls）+ 构建期 kpsewhich 三验
  + `PAPERTEAM_HOST=0.0.0.0`。密钥纪律不变（.dockerignore 排除 .env/auth.json，
  契约测试强制无 COPY 密钥 / 无 texlive-full）。
- 新增 `--target backend-docling`：基镜像 + `libgl1`/`libglib2.0-0`（docling
  图像链的 libGL 依赖——slim 基镜像缺失，CI 实测首跑即
  `libGL.so.1 cannot open shared object`；native runner 系统自带故此前不可见）
  + `/opt/paperteam-docling-venv`（`docling>=2,<3`，+~4GB torch CPU）+
  `PAPERTEAM_DOCLING_PYTHON` + `HF_HOME=/data/hf-cache`（模型缓存落 volume，
  容器重建不重复下载）。基镜像保持轻量——不需要结构化解析的用户行为完全
  不变（pymupdf 文本层降级）。
- compose：backend `image: ${PAPERTEAM_BACKEND_IMAGE:-paperteam-backend:local}`
  （一行 .env 切 docling 镜像）+ `paperteam-hf:/data/hf-cache` volume +
  显式 host；entrypoint 对 HF 缓存 volume 做与两个数据根同规则的属主修正。
  **server-ready 形态维持 `git clone → cp .env.example .env → docker compose
  up -d` 三步**（§25）。

### 3.6 Runtime Doctor（§22）

`npm run doctor` 重写为三档结构化部署自检（PASS/WARN/FAIL；exit 1 仅当有
FAIL；optional capability 不阻断）：

| 检查 | 档位 | 说明 |
| --- | --- | --- |
| Node ≥22 / 前后端依赖 | FAIL | 阻断 |
| 数据根 PROJECTS_ROOT / PAPERTEAM_RUNTIME_ROOT 可写（mkdir+探测文件写删） | FAIL | 与 /ready 同口径 |
| xelatex / bibtex | FAIL | 手稿 PDF 生成必需 |
| kpsewhich standalone/pgfplots/tikz/ctexart/FandolSong | WARN | 图表/中文能力降级 + 平台安装建议 |
| Python + pymupdf | FAIL | PDF 导入必需 |
| docling | WARN | 结构化解析降级文本层 + 安装/镜像建议 |
| 模型配置（env > model.json）| WARN | 只报来源与已配置状态，**不回显 Key** |

Windows 实测：全 PASS（Fandol WARN 属预期——MiKTeX 用系统字体，提示语已说明）。

### 3.7 Linux CI（§23/§24）

- `ci.yml`（每 push，轻量不变 + 扩展 docker smoke）：
  1. 既有：toolchain 探测 + `/ready` 就绪判定；
  2. **图表编译 smoke**：`docker cp docker/figure-smoke.mjs` → 容器内 node 驱动
     dist FigureCompiler，5 用例（line/grouped_bar/scatter/TikZ/CJK）+ specHash
     缓存二次命中 + %PDF- 断言；
  3. **持久化 smoke**：容器内 POST /api/projects → `docker restart` → /ready
     恢复 → GET 项目仍在；
  4. **compose smoke**：tag 两镜像 → `docker compose up -d --no-build` → 经
     nginx 8080 同源创建项目 + /health → `down` → `up` → 数据仍在。
- 新增 `linux-integration.yml`（main push + workflow_dispatch；重依赖不进每
  push CI）：
  - `docling-native`：runner pip install docling → `doclingReal.smoke.test.ts`
    真实全链（PDF→docling→blocks→IngestionService→chunker）；
  - `docling-docker`：构建 backend-docling 镜像 → 容器内直接驱动
    `parse_document_docling.py`（与 DoclingParser.execFile 同一入口）→ jq 断言
    结构化 JSON → **python 进程计数前后一致（无僵尸/残留）** → 模型缓存确实
    落 /data/hf-cache。

### 3.8 Asset / 路径安全 POSIX 补测（§19）

既有守卫（名称白名单、双分隔符拒绝、lexical + realpath 双重包含、registry
登记、扩展名 MIME 白名单）不动，补 POSIX 形态：`/../../etc/passwd`（绝对+
深遍历）、`%2e%2e%2F`（解码后残余编码点段）、生成图侧 `/etc/passwd` /
`..%2F..%2F` / 反斜杠名单、**相对目标符号链接逃逸**（`path.relative` 构造
根外指向；Linux CI 上真实执行，无特权 Windows 跳过）。全部拒绝且分类正确。

### 3.9 模型配置隔离（§20/§21，Smoke 6）

`runtimeIsolation.test.ts` 以两个独立 data root fixture 模拟 Machine A/B：

- `resolveRuntimeRoot` 不同 env → 不同根；未设默认 `~/.paperteam`（各机 OS
  用户 home 天然隔离）；
- config 派生 agentDir / settings 路径随根隔离（Windows 盘符与 POSIX 路径
  双形态断言）；
- A 保存 model.json + auth.json + custom provider 后，B load 全部不可见、
  反向保存不覆盖 A；**B 的目录树不存在 auth.json**（迁移 projects 不带走
  Key 的机制性保证）。

Server mode 模型验证：scripted provider 容器 boot（CI smoke 每次执行）+
本机 Z.AI live（Windows，Batch 2 已验收；Linux 容器内 live 调用不作为 CI
验收项——无 Key 注入，如实标注 NOT VERIFIED，见 §10）。Vision：Linux 容器
内未做 live 视觉调用（NOT VERIFIED，同因）；代码路径与 Windows 完全同一
（VisionAnalysisService 无平台分支）。

## 4. 真实 Smoke 结果（§32 六项）

| Smoke | 环境 | 结果 |
| --- | --- | --- |
| 1 Windows compatibility | 本机 Win11 | **PASS**：typecheck 双绿、build、targeted（config/deploy/figures/ingestion/settings/vision/latex）+ 全量回归 backend 2815 passed / frontend 287 passed；figureReal 真实 MiKTeX 3 用例 + figure-smoke.mjs 5/5（含 CJK ctex） |
| 2 Linux production boot | GHA ubuntu | **PASS**：docker build（backend+web）→ 容器 boot → /ready 200 → compose up → nginx 8080 /health ok（见 §8 run 记录） |
| 3 Persistence | GHA ubuntu | **PASS**：容器内创建项目 → docker restart → 项目仍在；compose down → up → 经 nginx 创建的项目仍在 |
| 4 Linux Figure | GHA ubuntu 容器 | **PASS**：figure-smoke.mjs 5/5（TeX Live + standalone/pgfplots/tikz/Fandol；CJK 用例覆盖中文渲染链） |
| 5 Linux Docling | GHA ubuntu | **PASS**：native（doclingReal 全链 2 用例）+ docker（backend-docling 镜像内工具直驱，JSON 断言 + 进程计数无残留 + HF 缓存落 volume）；另本机 Windows 真实 docling 2.131.0 全链 2/2（138s） |
| 6 Model config isolation | backend test | **PASS**：runtimeIsolation 4 用例（双根互不可见 + auth.json 不随项目树迁移 + custom provider 隔离） |

## 5. Windows → Linux 迁移（§26）

设计为**目录复制 + 显式排除**（不过度工程，无新工具）：tar 单个项目目录
`p-<id>` → 服务器 PROJECTS_ROOT 解包。保留 project 元数据 / Sources / Evidence
/ manuscript / generated figures / target 三件套 / workflow runs（项目目录内
全部平台无关 JSON·PDF·TeX·PNG）。**不迁移**机器本地 secrets：auth.json、
custom-providers、skills 安装记录、tmp/HF 缓存（目标机器按需重建）。dual-runtime.md
§4 给出完整命令与纪律清单。

## 6. 文档交付（§27/§28/§34）

- `docs/deployment/linux-server.md`（新）：支持环境 / 推荐规格（8vCPU·16GB 起，
  32GB 推荐，200GB+ SSD，无 GPU）/ Docker 与原生双模式（含 systemd 单元）/
  docling 可选镜像 / 持久化表 / 环境变量表 / TeX+字体包清单 / **网络与安全
  告警（无 Auth，禁止裸露公网；SSH 隧道·私网·安全组白名单）** / 备份 / 升级 /
  排障表 / 验收口径。
- `docs/deployment/dual-runtime.md`（新）：双模式分工、**credentials 边界
  （公司 Provider 留公司机，❌ 公司 Key 上个人服务器）**、数据根、迁移纪律、
  模型运行时优先级、TeX/字体平台差异表、并发档位、FAQ。
- 更新：DEPLOYMENT.md（M12.2.5 增量块）、ARCHITECTURE.md（数据根+host 口径）、
  development.md（PROJECTS_ROOT 变量名修正）、getting-started / README·zh
  （部署链接）、research/README（本报告索引）、.env.example（host/docling/
  HF/compose 变量）。

## 7. 本机负载纪律（§14）

执行全程遵守：定向测试分批顺序跑（maxWorkers=2）；全量回归单次（backend
--maxWorkers=4 → frontend）；无并发 docling（本机真实 docling smoke 单次
--maxWorkers=1）；真实长 workflow 零启动；Linux 侧重验收全部放 GHA runner。

## 8. GitHub Actions 记录（§33）

最终提交 `710ff29` 上双 workflow 全绿（中途两次真实失败与修复，如实记录）：

```text
CI                run 37640984673  @ 710ff29  → success（8m55s：ubuntu test 2809+2807
                                                  passed + docker build/figure/persistence/compose smoke）
Linux Integration run 37640984668  @ 710ff29  → success（docling native 全链 +
                                                  backend-docling 镜像内解析 + 无残留子进程 + HF 缓存落 volume）
```

迭代记录（问题 → 修复，全部 CI 实测暴露而非本机可复现）：

1. `37635292984` @ 9b3690b CI 失败：runtimeIsolation.test 用 `X:\`/`D:\` 字面
   路径——Linux 上非绝对路径，`resolveRuntimeRoot` 正确抛 ConfigError（行为
   正确、测试 fixture 错）。修复 `8ef313f`：平台中立 tmpdir 绝对路径。
2. `37635813924` @ 8ef313f Linux Integration docling-docker 失败：错误被重定向
   吞掉 + slim 无 `ps`。修复 `16fcc58`：失败先 dump 结构化 JSON + /proc 进程
   计数——暴露根因 **`libGL.so.1` 缺失**（docling 图像链；native runner 系统
   自带故不可见）。修复 `710ff29`：docling 阶段补 `libgl1 + libglib2.0-0`。

## 9. 完成判定（§36）

```text
M12.2.5 Linux & Dual-Runtime Closure    COMPLETE

Windows Local（回归+真实 MiKTeX 图表+docling）      PASS
Linux Native/Docker（GHA ubuntu 验收）              PASS
Persistent Data（restart + compose down/up）        PASS
TeX Live（kpsewhich 三验 + 真实编译）               PASS
PGFPlots/TikZ（5 用例含 CJK + 缓存）                PASS
Docling Linux（native 全链 + 容器子进程生命周期）    PASS
Model Config Isolation（双根 fixture 契约测试）      PASS
GitHub CI（两个 workflow）                          PASS

M12.1 COMPLETE / M12.2 COMPLETE / M12.3 PARTIAL —— 不变
READY_FOR_BATCH_3 = true
```

## 10. Known limitations（如实登记）

1. **Linux 容器内 live 模型调用未验证**（CI 无 Key 注入，scripted provider
   验证 boot/配置面）——live Z.AI 在 Windows 已验收，Linux 侧属同代码路径；
   上服务器后用 Settings → 测试连接 一次即可闭环。
2. Linux 容器内 **live vision 调用未验证**（同因；VisionAnalysisService 无
   平台分支）。
3. 历史里程碑 benchmark 脚本（m114-*、m1042 等）仍为 Windows-only 开发脚本
   （硬编码 D:\、taskkill）——一次性验收产物，不在产品/CI 路径，不回填。
4. docling 镜像 +~4GB（torch CPU）；首篇解析需 HF 模型下载（数百 MB，缓存
   volume 持久化后仅一次）。
5. Windows 侧 `shell:true` kill-orphan（超时只杀 cmd 不杀 xelatex）为既有
   已知遗留，Linux 不受影响（无 shell）。
6. 多机同时编辑同一项目无同步机制（单用户自托管边界；迁移纪律见
   dual-runtime.md FAQ）。
7. `PROJECTS_ROOT` 变量名无 `PAPERTEAM_` 前缀（历史事实源）——已在
   .env.example / ARCHITECTURE / development.md 显著标注，不做破坏性改名。

## 11. READY_FOR_REAL_SERVER

**true。** `git clone → cp .env.example .env → docker compose up -d`（需要
结构化解析再加 build backend-docling + 一行 PAPERTEAM_BACKEND_IMAGE）即可
部署到阿里云/腾讯云新加坡 Ubuntu 24.04 ECS；访问走 SSH 隧道或私网（无 Auth，
勿裸露公网）；备份两个 volume + hf-cache 即可。
