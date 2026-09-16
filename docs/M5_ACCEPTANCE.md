# M5 Acceptance（真实论文 A/B 验收记录，2026-09-14 首轮 / 2026-09-15 收口）

> 结论先行：**M5.3 / M5.4 / M5.5 ✅ COMPLETE；M5.6 🟡 PARTIAL — awaiting human pairwise
> evaluation**。09-15 完成：真实 Docker 验收（§4.7）、Citation Preservation Gate（§6.6）、
> 长论文执行超时分层（§6.7）、CI 首次全绿、修复后真实论文 A/B（§4.8）与盲评材料包（§5）。
> 人工 pairwise 评价必须由真人完成，本文件不用任何模型自评替代，因此 M5 整体**仍不标
> COMPLETE**。所有数字来自 `~/.paperteam-acceptance*/**/summary.json` 与 backend.log
> （本地保留，不入库；论文正文不出现在本文件，只有计数 / 指纹 / 章节数）。

## 1. Environment

| 项 | 值 |
|---|---|
| 主机 | Windows 11 Home（开发机）；09-15 起同机 WSL2 Ubuntu 24.04 + Docker Engine 29.8.0 / Compose v5.5.1（未安装 Docker Desktop，见 §4.7） |
| Node | 22（root engines `>=22.22.3`） |
| LaTeX | MiKTeX 25.12：latexmk 4.88 + XeTeX 4.16 |
| PDF | Python 3.11.9 + pymupdf 1.28.0 |
| 模型 / provider | `zai-coding-cn/glm-5.3`（两臂完全相同；Key 经 Settings UI 保存的 auth.json，不在仓库） |
| Runtime 配置 | 全部默认，除 `PAPERTEAM_PI_RUN_TIMEOUT_MS=900000`（见 §4 第一轮发现）；A 臂 `PAPERTEAM_DISABLED_SKILLS=academic-writing-zh,academic-review,academic-style-zh` |
| Quality Gate 阈值 | 默认不变：academic ≥ 80、styleRisk ≤ 35、unsupported critical claims = 0、blocking = 0、critical+major = 0、hallucinated = 0（**未降低任何阈值**） |
| Git SHA（验收代码） | A1/B1/A2/B2/QR/idea：`67efc6d`（+ 未提交的 usage 观测面）；A3/B3/A4：`67efc6d` + Writer 引用修复工作区（= `6edbe47`，pre-gate）；A5/B4：`846dd42`（含 Citation Gate + 超时分层）；A6/B5：`ac67230`；A7/B6：`ac67230`（§4.8）；A9/B7/A10/B8：`8552851`（含 Fact Gate，§4.9 中断轮）；**A12/B10：`9280255`（最终，§4.9）** |
| 执行器 | `scripts/m5-acceptance.mjs`（启动独立 backend、导入 PDF、驱动 run、自动回答 HITL、采集指标） |

## 2. Corpus（本地输入，不入库）

- 一篇 **26 页中文工科论文 PDF**（车载多目标跟踪方向；PaperMap 36 节；`references.bib` 重建 25 条、正文 22 处引用、20 个被引 key）。sha256 前缀 `…`（见本地 summary.json `corpus.sha256`）。
- 材料不足提案：仅一句研究想法（无数据集 / 实现 / 实验）。
- Eval corpus A–E（`backend/test/fixtures/eval/style-corpus/`）用于 deterministic hard check（M5.4 测试全绿）。

## 3. A/B 设计

| | A（对照） | B（M5 能力） |
|---|---|---|
| 学术 Skill | 关闭（`PAPERTEAM_DISABLED_SKILLS`） | 开启（academic-writing-zh / academic-review / academic-style-zh） |
| stylePolicy | suggest_only | apply_once |
| 其他 | 相同模型 / provider / 参数 / PDF / 阈值 / Reviewer 结构 / 900s 执行超时 | 同 |

工作流：Existing Paper Improvement（导入 → 重建 → 理解 → 引用核验 → 三路审稿 → 目标评估 →
改进计划（HITL approve）→ 逐节修订 → 复审 → Gate → bounded 修订 → HITL → Draft/Final）。

## 4. 运行记录与结果

### 4.1 第一轮（默认 300s 执行超时）——两臂都失败（Runtime 配置发现）

| run | 结果 | 原因 |
|---|---|---|
| B1（Skill 开） | `failed` @ review.run，15.5 min，$0.37 | academic / style Reviewer 读取 Skill 后 6–14 轮工具调用，两次尝试均 300s 执行超时（fact Reviewer 22–139s 完成） |
| A1（Skill 关） | `failed` @ revision.apply，36 min，$0.56 | Writer 单节修订（重建稿单节 1100+ 行）两次 300s 超时；Reviewer 最长 263s |

判定：**D. Runtime 配置**（不是 Skill 缺陷，也不是模型故障）——默认 300s 对 20+ 页真实论文
过短。处置：验收改用 900s；compose 部署默认 900s；`.env.example` 注明。默认值未在代码中改动。

### 4.2 第二轮（900s；含当时未发现的 Writer 引用回归）——两臂均完成为 Draft

| 指标 | A2（Skill 关） | B2（Skill 开 + apply_once） |
|---|---|---|
| 状态 / 产物 | completed → **Draft**（Final blocked） | completed → **Draft**（Final blocked） |
| 总时长 | 45.2 min | 48.5 min |
| 修订轮 | apply + 1 revise（预算 2 → overflow → accept_draft） | apply + 1 revise（同） |
| 首轮审稿 issues（critical/major/minor） | 31（1/9/21），academic 74，styleRisk 25，unsupported claims 9 | 26（5/6/15），academic 66，styleRisk 30，unsupported 15 |
| 末轮审稿 | 24（3/7/14），academic **56**，styleRisk **40** | 22（3/5/14），academic **72**，styleRisk **30** |
| 迭代结论 | IMPROVED（academic 62→56 仍标 IMPROVED：规则集相同、major 5→7 未触发 REGRESSION） | REGRESSION（r3）→ IMPROVED（r4） |
| Gate 末轮失败规则 | 5 条（含 style_risk_threshold 40 > 35） | 4 条（style_risk 通过） |
| finding 带 reason 比例（r1） | 15/31 | 9/26 |
| finding 有位置 / 有动作 | 31/31 / 31/31 | 26/26 / 26/26 |
| Style Polish | 不适用 | **未触发**：当时实现只在 Gate PASS 后提供，B2 Gate 未通过（已修：Draft 路径也提供一次，见 §6） |
| LaTeX 编译 | latexmk 4.0s PASS，Draft PDF | latexmk 4.2s PASS，Draft PDF（317 KB） |
| tokens（in / out / cacheRead） | 345,687 / 231,740 / 1,717,440 | 467,333 / 233,400 / 2,378,688 |
| estimated cost（provider list-price） | $1.95（19 runs，45 turns） | $2.30（21 runs，70 turns） |
| Reviewer 成本 / 时长 | $0.51 / 18.6 min | $1.23 / 29.1 min |
| Writer 成本 / 时长 | $1.34 / 30.4 min | $0.99 / 28.9 min |
| accessed skills（真实读取） | 无（verify-citations / paper-search 被分配但未读） | academic-review、academic-style-zh 在首轮被读取；academic-writing-zh 在 1/10 次 Writer 调用中被读取；verify-citations / paper-search 未读 |

**硬指标（基线 rev-1 → 最终 rev）**

| 指标 | A2 | B2 |
|---|---|---|
| citation key 数 | 29 → **0**（全部 20 个 key 被删） | 29 → **0**（同） |
| final 中不在 bib 的 key（虚构引用） | 0 | 0 |
| 数字 token 数 | 951 → 293（新增 19 个基线不存在的数字） | 951 → 542（新增 18 个） |
| 数学片段 | 0 → 225 | 0 → 280 |
| styleSignals（表面模式） | 0 → 1 | 0 → 0 |
| 编译 | PASS | PASS |
| Quick Review 修订变化 | — | — |

**发现 C（Writer regression，两臂共有）**：Existing-Paper 项目没有 research artifact
bibliography，修订 prompt 写成「无可用文献：不要使用 \\cite」，Writer 据此把重建稿的
全部 `\\cite{refN}` 删光；`citation.verify` 之后 citedCount=0，而 Gate 的引用规则
（hallucinated=0 / 结构合法）全部通过——**引用保持不在 Gate 口径内**。这不是
Skill 或模型问题，A/B 两臂完全一致。已修复（§6）并补测试；新增数字多为 Writer
把 PDF 重建文本里的表格 / 公式改写成 LaTeX 数学时产生（数学片段 0 → 225/280），
其中是否有编造数值需人工核对（未做，见 §8）。

**A/B 观察（诚实口径）**：B 的末轮 academicScore 更高（72 vs 56）、styleRisk 更低
（30 vs 40，A 因此多挂一条 gate 规则）、REGRESSION 被收敛判定捕获；但 B 的首轮
Reviewer 更严格（unsupported 15 vs 9、critical 5 vs 1），成本 +18%、Reviewer 时长
+56%。这些数字来自同一 Reviewer 结构的模型输出，**不能作为 B 质量更好的证明**——
人工 pairwise 评价未完成（§8）。可确定的是：Skill 路由与 accessed 观测在真实运行中
按设计工作；Skill 显著增加 Reviewer 工具轮次与延迟。

### 4.3 第三轮（修复 Writer 引用回归后）

| run | 结果 |
|---|---|
| A3（Skill 关） | `failed` @ review.run：provider **429 速率限制**（`code 1302`），两次尝试 15s 内失败；4 个 backend 并发（A3/B3/A2/QR）触发；判定 **E. Provider failure**，不是产品缺陷；`citation.verify` 299s，unverifiable 20（外部学术库同时限流） |
| B3（Skill 开，**pre-gate**） | **未完成**：10:52 完成 revision.apply（rev-2）并进入 citation.verify 后，10:53:30 与 A4 同一秒被外部终止（runner「fetch failed」→ backend SIGTERM；09-15 复盘为主机进入 Modern Standby，见 §4.8）。summary.json 只有 `error: fetch failed`。**落盘证据仍然有效**：rev-1 → rev-2 引用 29 → 77 处、key 20 → 25（新增 ref21–ref25 全部在 references.bib 中，虚构 0）、**丢失 0**——修复后的 Writer 在真实模型上不再删光引用。usage（backend.log）：30 runs、$2.59、Writer 5 次（改进计划 1 + 逐节修订 4，单次最长 **626 s**，均 completed）、Reviewer 23 次（最长 316 s，22 次真实读取 Skill）、无 EXECUTION_TIMEOUT / 429 |
| A4（Skill 关，**pre-gate**） | **未完成**：10:40 进入 revision.apply，10:53:30 与 B3 同时被终止；无修订产物（rev-1 only）。usage：7 runs、$0.51、Writer 2 次（最长 454 s，completed）、无超时 / 429 |

B3 / A4 都在 Citation Preservation Gate 提交之前启动，只能证明 Writer prompt 修复有效，
**不能**作为 Gate 的验证；Gate 的真实模型证据见 §4.8。

### 4.4 场景 C：Quick Review（只读红线）

- run completed（label=review），34.8 min，$1.82，74 runs（33 节审阅 + 章节摘要）。
- **revision before == after == 0；manuscript 目录 mutatedFiles = 0**（零写入）。
- 177 findings（critical 1 / major 38 / minor 124 / info 14；academic 90 / consistency 45 / style 27 / citation 10 / fact 5）。
- 引用真实性：25 条参考文献，VERIFIED 16、PROVIDER_ERROR 9（外部库限流，如实标记）、probableFabrications 0。
- accessed：分章节审阅 `review/section/*` 34/37 次真实读取 academic-review；章节摘要任务走 reviewer 默认绑定（verify-citations）且未读取。

### 4.5 场景 B：材料不足提案（idea_to_paper，stop-at outline）

- research.idea 432s → feasibility **MEDIUM**，明确列出 5 项缺失（无实现、无数据集、无
  Baseline 对比、无算力规划、Evidence 全部未核验）与 5 项需补实验；**没有编造实验 / 数据 /
  引用**（理由文本引用的都是公开基线与数据集名称，作为"需要什么"而非"已有什么"）。
- 大纲生成后按设计取消（不烧写作 token）；$0.59，8 runs。
- Gate 未被降低（该场景未进入 gate）。

### 4.6 场景 E：长程 Runtime

- 4 个 backend 进程并发运行 ~1.5 h，总计 ≥ 150 个 Agent run；无 CONTEXT_BUDGET_EXCEEDED /
  RUNTIME_QUEUE_FULL / RUNTIME_SESSION_CAPACITY；A1 出现 1 次会话轮换（rotation）；
  timeout 分层如实产出 `EXECUTION_TIMEOUT`（A1/B1）；取消（idea 场景 cancel）即时终态；
  usage 观测面（`runtimeStats.usageTotals` + per-task 日志）覆盖全部 run。
- 未覆盖：进程重启 / checkpoint 恢复（本轮未刻意制造），优雅停机（Windows 下 kill 为强制终止）。

### 4.7 场景 F：Docker E2E（✅ 2026-09-15 真实通过；M5.5 → COMPLETE）

**环境获取（公司 Windows 11 Home，原本无 Docker / WSL）**：不安装 Docker Desktop（无法确认
公司商业授权，且系统上无软件中心 / 策略提供的安装包）。路径：Microsoft Store 通道的
`wsl --install` 在该网络失败 → 使用官方 GitHub release 的 `wsl.2.7.14.0.x64.msi`
（Authenticode 签名验证：Microsoft Corporation / Microsoft Code Signing PCA 2024），UAC 提权静默
安装（VirtualMachinePlatform 已启用，**无需重启**）；Ubuntu 24.04 用 Canonical 官方 WSL rootfs
（USTC 镜像下载，SHA256SUMS + GPG 签名验证）`wsl --install --from-file` 导入到 `D:\WSL\Ubuntu`
（systemd 开启）；Docker Engine 29.8.0 / docker-ce-cli / containerd / buildx v0.37.1 / Compose
v5.5.1 来自官方 apt 仓库的 USTC 镜像（Docker GPG 指纹 `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C
0EBF CD88` 核对一致），systemd 托管；Docker Hub 直连不可达 → daemon `registry-mirrors`
（docker.1ms.run / docker.m.daocloud.io）。仓库不复制：WSL 内 `/mnt/d/Projects/PaperTeam` 与
Windows 同一 checkout，`git rev-parse HEAD` 一致。

**构建**：首次 `docker compose build` 在 apt 阶段以 ~20 KB/s 从 deb.debian.org 拉 368 MB TeX 包
（估算 5 小时）——判定为构建阻塞而非「环境问题糊过去」：Dockerfile 新增仅构建期生效的
`APT_MIRROR` / `PIP_INDEX_URL` build-arg（compose 透传 `PAPERTEAM_APT_MIRROR` /
`PAPERTEAM_PIP_INDEX_URL`，缺省官方源、镜像内容不变）。使用 USTC / TUNA 后：

| 项 | 值 |
|---|---|
| build 时长 | 573 s（含 npm ci、TeX 236 包、pymupdf） |
| `paperteam-backend:local` | 1.99 GB（`a68146f96a9c`） |
| `paperteam-web:local` | 83.5 MB（`8b1df5df8d0e`） |
| 镜像内工具链 | Node v22.23.2；Python 3.11.2 + pymupdf 1.28.2（venv）；git 2.39.5；XeTeX 3.141592653-2.6-0.999994（TeX Live 2022/Debian）；latexmk 4.79；biber 2.18；`ctexart.cls`；FandolSong（+ fonts-noto-cjk）；进程用户 `paperteam` |

**up / health / Web**：`docker compose up -d` 后 8 s `/health` 200；`docker compose ps` 两容器
running (healthy)；`/ready` 200 且 `degraded == []`（latexmk 可用、python + pymupdf 可用、
两个数据根可写）；`/api/runtime/status` runtime healthy、model `not_configured`（未注入 Key，
属预期）；Windows 主机 `http://localhost:8080`（WSL2 localhost 转发）首页 200（含 `#root`）、
`/assets/index-*.js` 200（527 KB）、同源 `/api/projects` 200。

**Project 持久化**：`POST /api/projects`（title + researchIdea 带 `m5-docker-acceptance-<ts>`
marker）→ 201，`/data/projects/<id>/project.json` 落 volume；`GET /api/skills` 5 个已安装
Skill（academic-review / academic-style-zh / academic-writing-zh / paper-search / verify-citations），
`/data/runtime/skills/installed` 5 项。`docker compose restart`（3 s 恢复健康）→ project 200、
title / marker 一致、skills 5、runtime 目录在；`docker compose down`（不带 -v；容器与网络删除，
两个 volume 保留）→ `up -d`（10 s）→ 同样全部仍在；`stop` → `start` 后再次一致。

**LaTeX**：导入最小真实模板（`ctexart` + amsmath/amssymb + `natbib` + `\bibliography{references}`
+ 中文正文 + `\cite`）→ `POST /build` passed（latexmk）→ `build/paper.pdf` 32 KB 落 volume；
容器内 PyMuPDF 抽文本含中文（标题 / 引言 / 参考文献 [1]），`main.log` 为 XeTeX 且引用 Fandol
字体 10 处，bibtex 生成 `thebibliography`。PDF 副本保留在本机 `~/.paperteam-acceptance/docker/latex-acceptance.pdf`。

**PDF / PyMuPDF**：`POST /api/projects/import-pdf`（仓库公开 fixture `backend/test/fixtures/pdf/attention.pdf`，
2.2 MB）→ 201：15 页 / 23 节 / 标题来自 PDF（`titleSource=pdf`）——走的是 PaperTeam 真实解析
路径（容器内 `/opt/paperteam-venv/bin/python` 子进程 + `parse_paper_pdf.py`），不是 `import fitz`。

**优雅停机**：`docker compose stop` → 日志 `shutting down (SIGTERM)... budget=40000ms` →
`stopped cleanly`，容器 exit code 0，1 s 内完成（空闲状态；PAPERTEAM_SHUTDOWN_TIMEOUT_MS 可配置，
compose 45 s grace）；`start` 后数据一致；容器内无 zombie 进程、日志无 unhandled rejection。
未做 kill -9（纪律）。

**Linux 路径纯净**：日志与 `/api/runtime/status` 无 `C:\` / 反斜杠路径。

**判定**：build / up / health / Web+API / project / persistence（restart、down-up、stop-start）/
LaTeX / PDF / graceful shutdown 全部真实通过 → **M5.5 COMPLETE**。执行脚本与原始日志：
`~/.paperteam-acceptance/docker/`（`wsl-scripts/acceptance.sh`、`acceptance.log`、
`acceptance-results.json`、`compose-build.log`）。

### 4.8 第四轮（2026-09-15，含 Citation Preservation Gate + 长论文超时分层）——修复后最终 A/B

同一篇 26 页论文、同一模型（`zai-coding-cn/glm-5.3`）、同一阈值；两臂唯一差别仍是学术 Skill 开关与
stylePolicy。运行纪律：每臂独立 backend、全新 `--root`（旧 root 里中断的 run 会被新 backend 自动恢复
并污染 usage 统计），主机用 `SetThreadExecutionState` keep-awake 守护（见下「未完成运行」）。

| 指标 | A8（Skill 关，suggest_only） | B6（Skill 开，apply_once） |
|---|---|---|
| 代码 | `ac67230`（gate + 超时分层 + CI 修复；B6 backend 不含 verdict 归一，A8 含） | `ac67230` |
| 状态 / 产物 | completed → **Draft**（Build PASS，Final blocked） | completed → **Draft**（Build PASS，Final blocked） |
| 时间 | 14:31 → 15:23，**51.8 min** | 14:13 → 15:36，**83.0 min** |
| 修订轮 | apply + 1 revise（预算 2 → overflow → accept_draft） | apply + 1 revise → overflow → accept_draft → **Style Polish（真实触发）** |
| 首轮审稿（critical/major/minor，academic，styleRisk，unsupported） | 26（3/8/15），65，18，17 | 30（3/11/16），70，20，15 |
| 末轮审稿 | 21（2/6/13），**78**，16，17 | 24（2/5/17），**43**，24，18 |
| 收敛判定 | IMPROVED | IMPROVED |
| Gate 末轮失败规则 | 4（unsupported 17 / blocking 4 / critical+major 8 / academic 78 < 80） | 4（unsupported 18 / blocking 2 / critical+major 7 / academic 43 < 80） |
| **`citation_keys_preserved`（真实 gate 产物）** | r2：rev-1→rev-2 29→88 处、key 20→25、丢失 0 → **PASS**；r3：88→88 → PASS | r2：29→65、key 20→25、丢失 0 → **PASS**；r3：65→65 → PASS |
| 硬指标：citation key（基线 → 最终） | 29 → 88 处；**removed = []**；不在 bib 的 key 0 | 29 → 65 处；**removed = []**；不在 bib 的 key 0 |
| 数字 token（基线 951） | 562（新增 40：多为把 PDF 重建的表格 / 公式改写为 LaTeX 数学时出现的尺寸 / 百分比） | 337（新增 5） |
| 数学片段 | 0 → 302 | 0 → 348 |
| styleSignals | 0 → 0 | 0 → 0 |
| LaTeX 编译 | latexmk PASS，Draft PDF（`art-draft-rev3`） | latexmk PASS，Draft PDF（`art-draft-rev3`） |
| runs / turns | 20 / 36 | 26 / 84 |
| tokens（in / out / cacheRead） | 389,669 / 199,540 / 855,360 | 699,456 / 352,774 / 3,790,656 |
| estimated cost | **$1.65** | **$3.52** |
| Writer（runs / cost / 执行总时长 / 单次最长） | 9 / $0.88 / 26.7 min / **391 s**（1 次 > 300 s） | 15 / $2.59 / 52.0 min / **538 s**（5 次 > 300 s） |
| Reviewer（runs / cost / 执行总时长 / 单次最长） | 9 / $0.71 / 19.8 min / 232 s | 9 / $0.81 / 29.7 min / 286 s（4 次真实读取 Skill） |
| EXECUTION_TIMEOUT / 429 | 0 / 0 | 0 / 0 |

**Style Polish（真实模型首次触发，B6）**：Gate 失败 → overflow accept_draft → Draft 构建前提供一次润色，
自动回答 apply（12 条 minor style finding 全选，含摘要 2、sec1 3、sec2 3、sec3 2、sec4 2）→ Writer
`writing/style-polish` 5 节 → **Style Invariant Checker：abstract / sec1 / sec4 通过，sec2 / sec3 失败**——
sec2 丢失 10 段数学与 `equation` 环境、数字 / 单位缺失；sec3 **丢失 citation key ref5**、10 段数学、
4 个 `table` / `tabular` 环境、数字与否定 / 比较哨兵词。按 all-or-nothing 纪律**未写回任何章节、未产生
新修订**（`style-polish-r3.json` status=failed），原稿保留，Draft 直接构建。这正是 M5.4 设计要防的：
真实模型的「只改表达」会连带删掉公式 / 表格 / 引用；第一层（Invariant Checker）挡住后，第二层
（Citation Preservation Gate）不需要出场——两层都在。

**A/B 观察（诚实口径）**：修复后两臂都不再丢引用（丢失 0 vs 第二轮的 29 → 0）；B 的 Writer 更贵更慢
（$2.59 vs $0.88，最长 538 s vs 391 s），B 的 Reviewer 更严（academic 43 vs 78、unsupported 18 vs 17），
末轮 academicScore 反而更低——与第二轮（B 72 vs A 56）方向相反，说明单次 A/B 的 Reviewer 分数**不能**作为
Skill 质量结论；B 的数字新增更少（5 vs 40）、数学片段更多（348 vs 302）。哪一稿真正更好只能由 §5 的人工盲评
回答。两臂 Final 都被 Gate 如实阻止（阈值未动）。

**未完成运行（同一天，如实记录）**：

| run | 结果 | 原因 |
|---|---|---|
| A5 / B4（`846dd42`，12:03 起） | 12:48 同时 `fetch failed` 中断；A5 已到第二轮 revision.revise（rev-3），B4 到第二轮 review.run | 主机 Modern Standby「Idle Timeout」（事件日志 12:43 进入待机、12:48 唤醒）；落盘证据：A5 gate r2 `citation_keys_preserved` **PASS**（29→82，丢失 0），rev-2→rev-3 丢失 0；B4 rev-1→rev-2 29→79 丢失 0；A5 Writer 最长 327 s、Reviewer 365 s 均 completed（旧 300 s 默认下会超时） |
| A6 / B5（`ac67230`，12:53 起） | 卡在 import.understand 78 min 后 `fetch failed` | 12:53:56 再次进入待机，14:11 开盖唤醒；在途 Researcher 调用以 EXECUTION_TIMEOUT（900 s，exec 4694 s 墙钟）收尾 |
| A7（`ac67230`，14:13 起） | `failed` @ review.run（2/2 attempts） | fact Reviewer 输出 verdict `"CONTRADICTION"`（非枚举值），严格解析拒绝 → 判定 **C. 模型输出契约偏差**；修复 `fix(review): normalize near-miss fact verdict labels`（大小写 / 分隔符 / 同义别名归一，其余仍严格拒绝）后 A8 重跑成功 |

### 4.9 第五轮（2026-09-15/16，含 Fact Preservation Gate）——最终 A/B（fact mutation 全程可判定）

配置与 §4.8 完全一致（同一 26 页论文、`zai-coding-cn/glm-5.3`、同阈值、每臂独立 backend + 全新
`--root`、keep-awake 守护）；唯一新增是 Citation + **Fact Preservation 双 Gate 生效**，以及 Writer
修订契约 / 三个学术 Skill 收紧后的行为。运行编号 A9/B7（2026-09-15 夜，环境中断）与 A10/B8
（2026-09-16 重跑）。

**核心证据（来自真实模型、两臂、gate r2 产物，A9/B7 即已取得）**：

| 指标 | A 臂（Skill 关）rev-1→rev-2 | B 臂（Skill 开）rev-1→rev-2 |
|---|---|---|
| `fact_preservation` | **FAIL** | **FAIL** |
| `citation_keys_preserved` | PASS | PASS |
| changedFacts | 30（上限截断） | 7 |
| removedFacts | 2 | 30（上限截断） |
| addedUnsupportedFacts | 21（含新增 7 行表） | 1 |
| placeholderRegressions | 30（上限截断） | 30（上限截断） |
| 授权变更 / 授权删除 | 7 / 131 | 4 / 108 |

解读：真实 Writer 在两臂都**试图**改写既有实验事实（数值替换 / 删除 / 占位化 / 新增无依据表格），
即使修订 prompt 已带事实冻结契约；确定性 Gate 在两臂都如实 FAIL 并派发 `fact_preserve` 恢复条目——
「Writer 试图篡改事实 → Gate 必须 FAIL」成立。授权删除量级大（131/108）来自改进计划里覆盖各章节的
needsEvidence 条目（「证据未归档」类审稿意见允许弱化 prose 论述）——这部分是计划授权的合法弱化，
不是违规。

**恢复轮行为（B7 rev-2→rev-3 离线分析，本地材料）**：恢复修订把无授权口径违规从
（30 changed + 30 placeholder + 21 added）收敛到（14 changed + 18 placeholder + 23 added）；
带真实计划口径下仍有 13 changed + 4 added 未消除——Writer 恢复不彻底（写了不同的值而不是逐字恢复
原值）。因此修订循环不会在预算内转绿，overflow → accept_draft 后 `build.draft` 以
`FACT_PRESERVATION_FAILED` 拒绝冻结 Draft：**系统拒绝把仍携带未授权事实改写的稿件产出为产物**，
这是 §6.9 的设计行为；代价是该路径下 run 以 failed 终态收场，需要人工恢复原值或以 Evidence 支撑
修正后重跑。

**未完成运行（2026-09-15/16，如实记录；环境与外部依赖问题，非产品逻辑）**：

| run | 结果 | 原因 |
|---|---|---|
| A9（`8552851`，09-15 18:19 起） | 19:18 进入恢复修订 rev-2 后，02:37 `fetch failed` 中断 | 主机整夜合盖 Modern Standby（keep-awake 的 `SetThreadExecutionState` 不能阻止合盖睡眠）；r2 gate 产物完整（fact FAIL 证据如上） |
| B7（`8552851`，09-15 18:20 起） | 恢复修订 rev-3 完成、r3 review 进行中（02:37）被 90 分钟看门狗取消 | 同上；rev-3 快照完整（恢复轮分析数据来源） |
| A10 / B8（`8552851`，09-16 14:46 起） | 分别在 r1 / r2 `review.run` 失败（2/2 attempts） | glm-5.3 当日行为漂移：Reviewer 输出**省略 summary 字段**被严格解析拒绝（A10 fact lens / B8 academic lens，两臂同错）。修复：summary 为展示性字段（不参与 Gate 判定），改为从 issues 计数确定性兜底，语义字段（verdict / scores / riskScore / issues）保持严格（`9280255`，同 A7 verdict 归一先例） |

重跑（A12/B9→B10，2026-09-16 15:39 起，`9280255`，`--model-timeout-min 150`）结果：

| 指标 | A12（Skill 关，suggest_only） | B10（Skill 开，apply_once） |
|---|---|---|
| 状态 / 终态 | **failed @ build.draft：`FACT_PRESERVATION_FAILED`** | **failed @ build.draft：`FACT_PRESERVATION_FAILED`** |
| 时间 / 费用 / runs / turns | 47 min / **$1.69** / 21 / 46 | 86 min / **$3.99** / 25 / 90 |
| Writer（runs / cost） | 10 / $0.97 | 14 / $2.83 |
| Reviewer（runs / cost） | 9 / $0.61 | 9 / $1.04 |
| 修订轮 | apply + 1 revise → overflow → accept_draft | apply + 1 revise → overflow → accept_draft → Style Polish（invariant 失败，未写回） |
| r2 gate `fact_preservation` | **FAIL**（改 5 / 删 30·上限 / 新增 8；授权 137+169） | **FAIL**（改 15 / 删 30·上限 / 新增 11；授权 141+212） |
| r3 gate `fact_preservation` | **FAIL**（改 4 / 删 1 / 新增 10；IMPROVED） | **FAIL**（改 10 / 删 9 / 新增 5；IMPROVED） |
| `citation_keys_preserved`（r2/r3） | PASS / PASS | PASS / PASS |
| 末轮审稿（critical/major/minor，academic，styleRisk，unsupported） | 1/8/16，57，35，11 | 1/5/15，**78**，25，17 |
| Draft / Final 产物 | **无（被拦截）** | **无（被拦截）** |

**判定（按 §22 验收标准）**：两臂 Writer 在真实模型下都尝试了无依据的事实改写，Fact Gate
在两臂的全部轮次如实 FAIL，恢复轮（fact_preserve 条目驱动）方向正确（IMPROVED）但不足以
清零，最终两臂都被 `build.draft` 的硬拦截阻止产出 Draft——**「Writer 试图篡改事实 → Gate 必须
FAIL」成立，且系统拒绝把篡改稿冻结为产物**。Citation Preservation 在两臂全程 PASS（引用丢失 0）。
不存在未检测的 fact mutation：所有变更都在 gate 产物中逐项落盘（changed/removed/added 明细）。

**与 A8/B6（pre-fact-gate）的对照**：上一轮两臂均 Draft PASS（引用层安全），本轮两臂 Draft
被拒（事实层拦截）——差异全部来自 Fact Gate 的引入与 Writer 行为（同模型同论文），说明
A8/B6 的 Draft 产物在事实层是不安全的（pair-02 盲评已证实），而本轮系统如实拒绝放行。

## 5. Independent Model Pairwise Evaluation（§5 DoD 调整说明 + 盲评记录）

> **DoD 调整（如实说明）**：M5_PLAN 原 M5.6 完成条件包含「人工 pairwise 评价」。截至 2026-09-16，
> 真人盲评未获得；已完成的 pairwise 评价由 **Claude Code + Fable 5.1（独立会话、盲态）** 执行——
> 评价时未访问 `.blind/` 映射、run 日志、summary 或任何代码仓库材料，只读 baseline / 两候选稿
> （PDF 提取文本）。因此文档口径改为 **Independent Model Pairwise Evaluation（独立外部模型盲评）**，
> human review 保留为 optional 后续动作；本调整的原因是：等待真人评价会无限期阻塞 M5 收口，而
> 事实安全类问题（数值改写 / 方向反转 / 占位化）是可逐项对照基线客观判定的，外部模型盲评已能
> 提供可用信号。**任何文档不得把模型盲评表述为人工评价。**

**pair-02 盲评结论（2026-09-15，JUDGE-CF51，驱动了 §6.9 Fact Preservation）**：两候选均不适合直接
用于硕士论文；稿 1（解盲 = B6，**Skill 开臂**）以删除 / 占位化为主（危害可见、可回填），稿 2
（解盲 = A8，**Skill 关臂**）出现对己方有利的数值改写与比较方向反转（隐性、更危险）。原始记录：
`~/.paperteam-acceptance/pairwise-judge/evaluation-form.md`（本机）。该结论的 sanitized 摘要已并入
§6.9 的驱动证据；逐项问题（表 12 数值改写、部署协议降级、负结果反转、无依据新增）由 §6.9 的
确定性规则全部覆盖（pair-02 离线回归，§6.9 末段）。

<!-- PAIR-03-EVAL -->

**pair-03 盲评结论（2026-09-16，JUDGE-CF51，最终 A/B = A12 vs B10）**：两稿均不适合直接使用；
**稿 2 更好**（事实改动少、可定位、方向对己不利易回退——表 4 本文行与表 9 一行被择一覆盖 +
结论诚实化），稿 1 为全量删除型退化（表 4/5/7/8/9/10 与部署表全部数值 →「待补」、UA-DETRAC
划分口径反转、负结果消失）。方法章两稿高度重合且质量相当。**解盲：稿 1 = A12（Skill 关臂），
稿 2 = B10（Skill 开臂）**。与 pair-02 对照：两轮独立盲评**方向一致**——都判 Skill 开启臂的
修订危害更小（pair-02：B6 删除型可回填 vs A8 数值改写；pair-03：B10 两行可定位覆盖 vs A12
全量删除）。但两点必须同时记录：(a) **两臂在两轮中都存在事实违规**（本轮全部被 Gate FAIL 并
阻止产出 Draft，上一轮无 Fact Gate 时全部漏过）；(b) 三路 Reviewer 的 academic 分数两轮互为
翻转（pair-02 轮 A8=78>B6=43；本轮 B10=78>A12=57）→ 审稿分数不能作为 Skill 质量结论。
综合口径：n=2 的盲评偏好（2/2 指向 Skill 开启臂危害更小）不足以宣称稳定质量提升，但
「Skill 开启臂在事实安全上劣于关闭臂」的担忧**未获任何一轮支持**；Skill 开启臂稳定更慢更贵
（$3.99/$2.83 Writer vs $1.69/$0.97；86 vs 47 min）。原始记录：
`~/.paperteam-acceptance/pairwise/evaluation-form-03.md`（本机）。

**盲评材料**（生成器 `~/.paperteam-acceptance/pairwise/make-pairwise.mjs`，论文内容只在本机，不入库）：

- `~/.paperteam-acceptance/pairwise/pair-01-baseline.md`（两臂共同的修订前基线 rev-1，4 节、24 处引用）、
  `pair-01-1.md` / `pair-01-2.md`（两臂最终修订正文，**随机决定 1/2 顺序，文件内不标 A/B / Skill**）、
  `pair-01-1.pdf` / `pair-01-2.pdf`（Draft PDF）、`evaluation-form-01.md`（评价表）；
  `.blind/mapping-01.json` 为解盲映射，评价前不得打开。pair-01 = A2 vs B2（pre-gate，两臂都已知
  丢失全部引用，评价表已注明按共同缺陷处理）。
- `pair-02-*` = 修复后最终 A/B（§4.8 的 A8 vs B6，两臂均 Draft；稿件 1 / 2 与臂的对应只在
  `.blind/mapping-02.json`）。评价时请同时回答「引用是否被不合理删除 / 新增」——两臂都新增了 5 个基线未引用
  的 bib key（ref21–ref25，均真实存在于 references.bib）。
- 评价维度（1–5）：学术表达 / 清晰度 / 术语一致性 / 中文自然程度 / 逻辑连贯性 / 修改合理性 /
  Review 可执行性；判断题：是否改变事实、是否过度改写、引用是否被不合理删除或新增；总体哪一稿更好与原因。

PaperTeam / Claude 不代填任何分数；即使只有作者本人评价，也先盲评再解盲，解盲结果抄录到本节。

## 6. 验收驱动出的修复（本次提交）

1. **Writer 引用回归**：修订 / 润色的可引用 key 改为 research artifact ∪ `manuscript/references.bib`
   （`manuscriptBibliography`），修订 prompt 增加「保留现有 \\cite，不得整体删光」。
2. **Style Polish 在 Draft 路径也提供一次**（Gate 未通过、用户 accept_draft 后、build.draft 前），
   否则真实论文几乎永远没有润色机会；测试新增（gate 持续失败 → stalled/overflow → 润色 → 强制复审 → Draft）。
3. **Runtime 观测**：`runtimeStats.usageTotals` + per-task usage 日志（含 assigned / accessed skills）。
4. **部署默认**：compose `PAPERTEAM_PI_RUN_TIMEOUT_MS=900000`；`.env.example` 注明长论文建议值。
5. **CI**：ubuntu 安装 pymupdf。

### 6.6 Citation Preservation Gate（2026-09-15，`fix(gate): enforce citation preservation across revisions`）

Prompt 不是 Gate。`backend/src/quality/citationPreservation.ts` 以不可变修订快照为事实源，比较被审阅
修订与其前一修订**实际被引用的 key**（按 key 语义；同 key 次数变化不算删除；`\cite / \citep / \citet /
\citealp / \citealt / \citeauthor / \citeyear / \citeyearpar / \parencite / \textcite / \autocite / \nocite /
\footcite / \smartcite` 与 StaticCitationChecker 共用命令表）。规则：

- 默认 previous 中的 key 不得在 current 中无依据消失；有依据的删除只承认结构化计划——
  sourceRevision == previous 的 RevisionPlan 中 `citation_missing` 条目、条目文本显式点名 `\cite{key}`、
  needsEvidence（证据不足，允许弱化 / 删除论述）条目命中章节内的引用；Existing-Paper 改进计划只承认
  显式点名。
- **catastrophic**：previous > 0 且 current == 0 → hard fail，除非每个 key 都有显式依据（章节级证据条目
  不是「全量引用移除」的明确依据）。
- **历史回归**：previous 与 current 都为 0 但更早基线有引用 → FAIL（references.bib 有条目不能伪装 PASS）。
- 无前序修订 / 快照缺失 / 用户恢复历史修订 → `citation_preservation_not_applicable`（中性，不参与判定，
  前端渲染为「不参与判定」而不是绿色通过）。
- 输出 `previousCount / currentCount / previousKeys / currentKeys / removedKeys / addedKeys /
  allowedRemovedKeys(basis, planItemId, section) / unexpectedRemovedKeys(+ 上一修订位置)`，随 gate 产物落盘；
  不输出整篇论文。`revision.plan` 据此派发 `citation_removed`（section-scoped，Writer 可执行）恢复条目；
  `build.draft` 结果与 `build_gate.*` 事件明确暴露失败；Final 被阻止；Quick Review 无 quality.gate 不受影响。
- 测试：`backend/test/quality/citationPreservation.test.ts`（10→10 PASS、10→0 catastrophic、10→9 无计划 FAIL、
  10→9 计划 citation_missing / 显式点名 PASS、证据条目跨章节不放行、全部删光时证据条目不算依据、命令顺序变化 PASS、
  同 key 次数变化 PASS、新增引用不因保持失败、历史回归 FAIL、Style Polish 删引用第二层 FAIL、改进计划显式点名、
  加载器（单修订 null / 删光 catastrophic / 恢复 null / 计划承认 / 跨多修订基线）、Quick Review 定义无 gate）+
  `backend/test/workflow/citationPreservationGate.test.ts`（scripted `[cite:drop]`：复审 pass 仍 FAIL、
  plan 派发 citation_removed、CONVERGED → stalled → accept_draft → Draft 暴露、无 Final；默认脚本照旧 Final）+
  前端规则标签 / 深链 / 中性渲染。scripted Writer 的修订输出改为「保留 prompt 当前内容中的既有 \cite」
  （镜象真实 Writer 纪律）。Backend 698 → 721 passed、Frontend 170 → 172。

### 6.7 长论文执行超时分层（`fix(workflow): tune long-paper execution deadlines`）

审计：Runtime 已有逐 run `RunAgentInput.timeoutMs` 覆盖（M5.1），但没有任何服务使用；compose 用
`PAPERTEAM_PI_RUN_TIMEOUT_MS=900000` 整体抬高。证据：第一轮两臂 300 s 超时；B3 Writer 单节 626 s、
Reviewer 316 s；A5（新代码）Writer 327 s、Reviewer 365 s 均需 > 300 s 才能完成。决策：**不整体改 300 s**，
新增 `PAPERTEAM_PI_LONG_RUN_TIMEOUT_MS`（默认 900 s，1 s–1 h）只给 Writer（章节 / 修订 / 润色 / 改进计划 /
编译修复）、三路 Reviewer、分章节 Reviewer、Researcher 逐 run 覆盖；可行性评估 / PaperMap 摘要 / PDF 分析 /
引用核验 Agent / Skill 简介保持 300 s；Runtime 全局超时契约不变。compose 改用新变量，`.env.example` /
DEPLOYMENT §6.1 记录分层。测试：config 默认 / 范围、四个服务逐 run 传参、stack 只覆盖长论文服务。

### 6.8 CI 平台无关性（`fix(ci)` × 2）

GitHub Actions ubuntu 自 M5.5 CI job 加入以来一直红，原因是两处 Windows 假设：上传文件名净化用
`path.basename` 而 Linux 不把反斜杠当分隔符（`..\\..\\evil\\name.pdf` 未被中和）→ 先归一反斜杠；
config 测试把 `H:\\custom` / `D:/pt-root` 当绝对路径 → 按平台取。修复后 run `34928394022`（`ac67230`）
**success**（5m37s，含 docker-build smoke job 首次真实跑通）。

### 6.9 Fact Preservation Gate + Writer 修订契约收紧（2026-09-15，`fix(gate): preserve experimental facts across revisions` + `fix(skills)`）

**驱动证据**：pair-02 独立模型盲评（§5）——两个候选稿都在 `citation_keys_preserved` PASS 的前提下
出现事实安全问题：稿 1（解盲 = B6，Skill 开臂）把 7 张结果表全部数值删为「待回填」、删硬件配置与极端
场景阈值、改写式(1) 与 UA-DETRAC 数据划分；稿 2（解盲 = A8，Skill 关臂）直接改写表 12 数值
（IDS 45/47→28/19 等）、把「基本一致」反转为「本文保持优势」、部署协议（3×500 帧、18 分钟）降级为
「单次窗口、约 15–20 分钟」、新增无基线依据的 λp=λiou=0.5 / r=16 / 71 维。结论：引用保持不足以
保证真实论文安全，必须有实验事实保持层。

**设计**（`backend/src/quality/factPreservation.ts`，确定性、无 LLM，与 Citation Preservation 同构：
不可变修订快照为事实源，previous = 被审阅修订的前一修订）：

- **受保护事实**：表格单元格数值（`\begin{table}` 内 tabular，按 `\label` > caption > 序号匹配表、
  按数值列前标签串联匹配行，占位替换单元格用「| 边界前缀兼容 + 列数相同」兜底）；正文数字+单位
  多重集（按文件；排除表格与数学环境，与 styleInvariants 共用 token 口径）；数学公式段多重集
  （归一化空白，缺失与新增双向）；方向性结论（负结果→优势为 hard rule；持平→优势；同指标
  「高于/低于」等方向词对调）；数据集划分（official↔custom）；硬件型号白名单（RDK X3 / RK / Jetson /
  RTX / …）；占位回归（待回填/待补充/待验证/待确认/待归档/暂无数据/TBD/TODO 替换既有具体事实）；
  无依据新增（百分比 / 带单位 / r=16 类超参赋值 / 71 维类量纲后缀 / 新增公式段 / 新增表行）。
- **授权模型**（authorized fact change 只承认结构化依据，自由文本「优化实验描述」不构成授权）：
  变更 = 计划条目文本同时点名旧值与新值，或点名旧值且 Evidence 文本含新值；删除 = needsEvidence
  条目命中章节（只放行 prose，不授权表格 / 公式 / 方向）或计划点名值且明示删除 / 弱化；新增 = 数值
  出现在 Evidence 或计划文本；公式 / 方向 = 计划文本明确提及。无法可靠判定 → FAIL（宁可 needs_review）。
- **写作阶段豁免**：新增审查只作用于 previous 已存在的文件——idea 流的 rev-0 只含 main.tex 骨架，
  writing.sections 产生的新章节文件不参与新增比对（创作不是篡改）；existing-paper 流 rev-0 即全文，
  所有修订都在审查范围内。
- **集成**：Quality Gate 新规则 `fact_preservation`（不可比较 → `fact_preservation_not_applicable`
  中性，前端渲染为「不参与判定」）；`POST /quality-gate` 手动重评同口径；明细随 gate 产物落盘
  （changedFacts / removedFacts / addedUnsupportedFacts / directionalChanges / formulaChanges /
  placeholderRegressions，每 finding 含 file / section / before / after / reason，片段截断）；
  `revision.plan` 派发 `fact_preserve` 恢复条目（section-scoped，指令「恢复原值，新值必须逐字来自
  Evidence」）；**`build.draft` 在事实被无依据篡改时阻止 Draft 冻结**（`FACT_PRESERVATION_FAILED` +
  `fact_preservation.blocked_draft` 事件）——与引用保持的「提示不拦截」不同：被改写的实验数据本身
  就是不实结果，Draft 产物不能携带它。Quick Review 只读不经过 quality.gate，不受影响。
- **Writer 契约**（`buildRevisePrompt`）：修订 ≠ 重写、实验事实默认冻结、疑似错误保留原值并报告、
  具体事实不得降级为占位、负结果不得美化、不得新增无依据实验细节、稿件与 Evidence 冲突时报告不调和。
- **Skill 收紧**（不新增第四个 Skill）：academic-writing-zh §6 新增 6 条修订硬约束 + §4 评价词
  「数值必须逐字来自材料，否则删除」；academic-review 新增 §5 修订稿事实回归检查（critical blocking，
  建议动作写「恢复原值」）；academic-style-zh §1 模糊归因改法收紧（style-only 场景不得引入数字）。
- **测试**：`backend/test/quality/factPreservation.test.ts` 26 例（验收清单 1–15：表格 45→28 /
  47→19 / Frag 102→51 / 35.9%→38.7% / 整表删除、500帧×3次→单次窗口、18min/621帧/309MB→15–20min、
  →待回填、基本一致→保持优势、负结果→优势、公式项替换、official→custom split、硬件删除、r=16
  无 Evidence、计划+Evidence 授权 45→44、模糊授权不通过、needsEvidence 只放行 prose、只改措辞 PASS、
  新文件豁免、gate 三态）+ `backend/test/workflow/factPreservationGate.test.ts`（scripted
  `[fact:mutate]`：gate FAIL、plan 派发、accept_draft → run failed FACT_PRESERVATION_FAILED、无
  Draft/Final 产物；默认脚本照旧 Final + 手动重评同口径）。scripted Writer 修订输出镜像事实纪律
  （保留数学环境与数字 token）；**顺带修复 scripted 修复件丢失公式**（此前被 styleInvariants 的
  同侧空提取掩盖——环境内数学的提取在两侧同为空时不可见）。Backend 728 → 757 passed、
  Frontend 172（GATE_RULES_NEUTRAL 新增 fact_preservation_not_applicable）。

**pair-02 本地回归（本地材料，不入库）**：以 baseline=rev-1、candidate=两臂最终稿、plan=null（无授权）
运行 analyzer：Candidate 1 → FAIL（placeholder_replacement ≥30（上限）、removed prose numbers ≥30、
formula_added 27、metric_direction_flip 4、negative_to_advantage、parity_to_advantage、
dataset_split_changed 1）；Candidate 2 → FAIL（changed ≥30、removed ≥30、placeholder ≥30、
formula_added 27、metric_direction_flip 5、table_added 3）。盲评指出的主要问题全部有对应规则命中；
「删除硬件配置」实为删除具体配置数值（硬件型号仍在），由 prose number removal 覆盖。报告：
`~/.paperteam-acceptance/pair-02-fact-preservation-report.json`。

## 7. Known limitations

- ~~Quality Gate 不检查「修订是否删除了原有引用」~~ → 09-15 已由 Citation Preservation Gate 覆盖（§6.6）。
- ~~修订可以无依据改写 / 删除 / 占位化实验事实~~ → 09-16 已由 Fact Preservation Gate 覆盖（§6.9）。
  该层的诚实边界：方向哨兵只覆盖确定的反转模式（负结果→优势、持平→优势、同指标方向对调），
  检测不到的语义改写仍依赖 Reviewer 与人审；数字 token 口径存在噪声（字母数字混合 token 如
  "023survey" 会进入配对），finding 定位用于人审指引而非逐字精确。
- 真实 Writer 在两轮 fact-gate 运行中都未能把事实恢复到清零（恢复轮 IMPROVED 但仍有残留）——
  修订循环在事实维度不收敛时的终态是「拒绝产出 Draft + run failed」，需要人工恢复原值或以
  Evidence 支撑修正后重跑。这是安全优先的正确行为，但意味着全自动闭环在无 Evidence 的
  既有论文场景下无法产出产物（本轮语料 evidence/ 为空）。
- needsEvidence 条目授权的 prose 删除量级大（A12/B10 r2 分别 169 与 212 项）——「证据不足允许弱化」
  与「删除具体实验事实」之间的边界在章节级授权下偏宽，属于确定性代理的已知保守取舍。
- 占位词表（待回填 / 待补充 / TBD 等）不含「待补」（本轮 A12 实际使用的写法）——
  「待补」由 prose 数值删除规则覆盖（removedFacts），但 placeholderRegressions 维度对它不敏感。
- 需要多个 Writer 调用共同删光引用才会触发 catastrophic；单章节内随「证据不足」论述一起删掉的引用被视为
  有计划删除（章节级依据），这是确定性代理而非语义证明——人工 pairwise 仍要看「引用是否被不合理删除」。
- 硬指标里的「新增数字」只能判「基线不存在」，不能判「编造」——需人工核对。
- ~~Style Polish 真实模型证据依赖 B3~~ → B6 / B10 两次真实触发并被 Invariant Checker 挡下（§4.8/§4.9）。
- 外部学术库（Crossref/OpenAlex）在并发下 PROVIDER_ERROR，引用真实性核验有 9/25 未决。
- ~~Windows 下无法验证 SIGTERM 优雅停机~~ → 09-15 在 Docker 内验证（§4.7）；Windows 本地 dev 仍是强制终止。
- 开发机 Modern Standby「Idle Timeout」会冻结所有本地 backend（09-14 B3/A4、09-15 A5/B4/A6/B5、
  09-15/16 夜 A9/B7 共六组运行中断）；keep-awake（`SetThreadExecutionState`）**不能阻止合盖睡眠**——
  长程验收必须在合盖可控的时间窗内执行。这是宿主机电源策略，不是产品缺陷。
- glm-5.3 的模型输出契约会漂移（09-15 verdict "CONTRADICTION"、09-16 省略 reviewer summary、
  import.understand 输出非 JSON）——展示性字段已做确定性兜底，语义字段保持严格；外部 provider
  的行为漂移是长程验收的持续性风险。

## 8. Final verdict（2026-09-16 更新）

- 场景 A（完整论文全链路）：首轮 Draft PASS / Final blocked（Gate 如实 FAIL，阈值未动）；
  **fact-gate 轮（§4.9）：两臂 run 以 `FACT_PRESERVATION_FAILED` 终止——Writer 的事实改写被
  Gate 全程拦截，系统拒绝把篡改稿冻结为 Draft（这是设计行为，不是失败）**。
- 场景 B（材料不足）：**PASS**（明确缺失、不编造）。
- 场景 C（Quick Review 只读）：**PASS**（零修订、零写入）。
- 场景 D（Style Polish）：**PASS**（B6 / B10 两次真实触发；Invariant Checker 分别挡下 sec2/sec3
  与 sec2/sec4 的违规，原稿保留——M5.4 设计的守卫在真实模型上两次有效）。
- 场景 E（长程 Runtime）：**PASS**（有界、可观测、结构化终态）。
- 场景 F（Docker）：**PASS**（09-15 真实验收，§4.7；M5.5 COMPLETE）。
- 场景 G（Citation Preservation Gate，09-15）：**PASS**——确定性测试矩阵 + 真实模型运行验证
  （§4.8 / §4.9 两轮引用丢失 0）。
- 场景 H（Fact Preservation Gate，09-16）：**PASS**——26 例确定性测试矩阵 + pair-02 离线回归
  （两候选的全部主要盲评问题被规则命中）+ 真实模型最终 A/B 两臂事实改写全部被 FAIL 并阻止产出
  （§4.9）；Quick Review 不受影响（只读、无 gate 路径）；恢复闭环（fact_preserve 条目 → IMPROVED）
  真实运转。
- 独立模型盲评（§5）：pair-02 与 pair-03 两轮完成；两轮均判 Skill 开启臂危害更小（2/2），
  Reviewer academic 分数两轮互为翻转（不可用作结论）。
- **M5 判定：M5.0–M5.5 COMPLETE；M5.6 COMPLETE — engineering goals achieved, Skill quality
  gain not consistently demonstrated**（两臂事实安全均有违规且都被拦截；Skill 质量收益为
  「方向性盲评偏好、样本量不足以宣称稳定提升」，如实记录，不宣称 Skill 已被证明提高论文质量；
  human pairwise 保留为 optional——DoD 调整原因见 §5）。**不打 tag**：Final 产物在本语料上
  无法达成（无 Evidence 支撑的既有论文），发布版本条件不满足（见 RELEASE_NOTES）。
