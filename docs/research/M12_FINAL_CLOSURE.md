# M12 Final Closure — 产品、文档、Demo 与技术成果收口报告

> **日期：2026-10-08。执行：Claude Code。基线：`30964ed`（== origin/main，working tree clean）。本轮全程只改文档，不改业务代码；阿里云新加坡 ECS 保持停机，未为本轮验收启动服务器。**
>
> **一句话结论：M12 三条产品线（M12.1 Target Publication Intelligence / M12.2 Multimodal Review / M12.3 Academic Figure Generation）全部 Feature Complete，Windows 与 Linux Docker 双运行时 Deployment Verified，GitHub CI 与 Linux Integration 在最终 commit `30964ed` 双绿；真实模型（GLM Z.AI）与真实服务器（新加坡 ECS 容器内 xelatex）验收均有记录。Browser E2E 未对 M12 新功能执行（如实标记 PENDING），M12 功能页面产品截图待补（服务器停机，本轮不录制）。M12 判定：功能与工程收口 COMPLETE；产品演示资产 PARTIAL。**

---

## 0. 状态口径（本报告统一用语）

| 维度 | 状态 | 依据 |
|---|---|---|
| Feature Complete | ✅ COMPLETE | M12.1/M12.2/M12.3 分别在 Batch 2 / Batch 3 判定 COMPLETE（见 §2） |
| Deployment Verified | ✅ Windows + Linux Docker | Windows 真实 MiKTeX/Docling/GLM smoke；新加坡 ECS 双容器 healthy + Runtime Doctor PASS（Batch 3 §20） |
| Browser E2E Verified | ⚠️ **PENDING** | M12 新功能（TargetPanel / VisualReviewSection / FiguresPanel）验收 = 组件测试 + API 集成 + 部署 bundle 验证；真实浏览器走查未执行 |
| Demo Assets Ready | ⚠️ **PARTIAL** | 三条 Demo 的操作路径与验收依据齐备；M11 时代页面截图已有 125 张（`e2e/shots/`），M12 功能页面截图 0 张（待补） |

## 1. M12 实施范围与时间线

M12 立项于 M12.0 架构审计（`docs/research/M12_0_FAST_ARCHITECTURE_AUDIT.md`，653 行，冻结三方向设计，识别 9 个真实缺口 G1–G9），随后分四批落地，全程 main 无分支：

| 阶段 | 日期 | 最终 commit | 范围 | 报告 |
|---|---|---|---|---|
| M12.0 架构审计冻结 | 10-07 | `7cd9433`（基线） | 设计冻结，零代码 | M12_0_FAST_ARCHITECTURE_AUDIT |
| Batch 1 确定性基础层 | 10-07 | `6e52b16` | A1–A6 / B1–B2 / C1–C3 + 四道 Evidence 隔离 | M12_BATCH1_DETERMINISTIC_FOUNDATIONS |
| Batch 2 产品收口 | 10-07 | `0833974`（终 `457d823`） | A7–A10 / B3–B5 + CI 79 连败修复 | M12_BATCH2_PRODUCT_CLOSURE |
| M12.2.5 Linux 双运行时 | 10-07 | `a3e9528`（代码至 `710ff29`） | 部署闭环 / doctor 三形态 / CI 持久化 | M12_2_5_LINUX_DUAL_RUNTIME_CLOSURE |
| Batch 3 图表产品收口 | 10-08 | `6db034e` + `a20a528` → `30964ed` | C4–C6 + Doctor + 真实服务器验收 | M12_BATCH3_FIGURE_GENERATION_CLOSURE |
| **M12 Final Closure（本轮）** | 10-08 | 本报告提交 | README / Demo / 成果 / 状态收口 | 本文件 |

测试规模轨迹（backend passed）：2,553（M11.5）→ 2,704（Batch 1）→ 2,798（Batch 2）→ 2,815（M12.2.5 Windows）→ **2,860（Batch 3，于新加坡服务器宿主机执行）**；frontend：281 → 287 → **292**。全部为 vitest 真实执行数字，非估算。

## 2. M12.1–M12.3 完成状态

| 方向 | 状态 | 判定处 | 核心交付 |
|---|---|---|---|
| M12.1 Target Publication Intelligence | **COMPLETE** | Batch 2 §判定（A1–A10 全绿） | 三 artifact + TargetPanel + 10 HTTP 端点 + 工作流接入（advisory-only） |
| M12.2 Multimodal Review | **COMPLETE**（含真实视觉模型验收） | Batch 2 §判定（B1–B5 全绿） | VisualArtifactView 投影 + 6 确定性检查 + 4 视觉检查 + ReviewPanel 双列 |
| M12.3 Academic Figure Generation | **COMPLETE**（含真实服务器验收） | Batch 3 §22（C1–C6 全绿） | PlotSpec/DiagramSpec → pgfplots/TikZ → xelatex 矢量 PDF + 受控插入 + 真实性守卫 |
| M12.2.5 Linux & Dual-Runtime | **COMPLETE** | M12_2_5 报告 | Windows/Linux 同代码双形态 + doctor 三形态 + CI 持久化验证 |

**M12 FEATURE COMPLETE = true；READY_FOR_M12_FINAL_CLOSURE = true（本报告即该收口）。**

## 3. Target Publication Intelligence（M12.1）

**做什么**：为配置了 `documentType + targetProfile（12 档）+ targetVenue? + researchField` 的项目建立经验参照系——按投稿目标过滤、按引用数排序的真实文献发现（OpenAlex 服务端 source-id 过滤 + 21 条种子 venue 表）→ 自动遴选 8–15 篇（目标 12）以 `sourceRole="reference"` 导入 → 冻结 `research/target-benchmark.json`（revision/fingerprint 幂等）→ `target-profile.json`（结构/文献/实验/图表四维分位带 `{n,min,p25,median,p75,max}` + 仅 method/writing 两维的有界 GLM 摘要，输入仅为聚合统计）→ `target-readiness.json`（**六维 × 四档判决**：MEETS_TARGET / PARTIALLY_MEETS_TARGET / BELOW_TARGET / INSUFFICIENT_EVIDENCE，每 gap 附 observed/targetRange/confidence/evidenceBasis）。

**边界（如实）**：
- **advisory-only**：三 artifact 不参与任何 quality gate，target 阶段失败降级为 `skipped.reason`，永不改变工作流终态（Batch 2 修复的关键纪律缺陷）。
- **不存在 targetScore 数值分**——判决是分档语义不是打分；method/writing 维判决上限 PARTIALLY（确定性纪律）。
- 四道隔离屏障保证 benchmark 文献**永不进入 Evidence 池**（role 过滤 / propose fail-closed / ground() Stage-1 拦截 `unverifiable(reference_source_not_evidence)` / vision 服务端 role 检查）。
- **能力界定：目标论文质量对标与差距提示，不是投稿成功保证。**

## 4. Multimodal Review（M12.2）

**做什么**：对**已登记的视觉资产**做审查——`VisualArtifactView` 是三个权威来源（pdf_parsed 块 / latex 环境 / 生成图表）之上的**派生只读投影**，不建新 store。`VisualReviewService` 恒跑 6 项确定性检查（label 引用解析 / 重复 label / 缺 caption / 未引用资产 / 表格数值 / caption-引用错配），配置视觉模型时增跑 4 项视觉检查（figure-caption / figure-claim / legend-axis / diagram-method 一致性）。报告落 `reviews/visual-review-r<n>.json`。

**边界（如实）**：
- **能力界定：审查已支持的图表与视觉资产，不代表任意 PDF 视觉理解。** PDF 内嵌图（无独立 PNG/JPEG 资产）如实 skipped；视觉模型只收 PNG/JPEG。
- 模型观察永不自动 verified（`verificationStatus ∈ {verified_deterministic, model_observation, needs_author_review}`）——Figure ≠ Evidence 红线。
- 视觉 findings 不进入 counts/openCritical/openMajor，不参与任何 gate（M12.0 §10.3 v1 零新增阻断）。
- 降级是一等公民：`VisionUnavailableReason` 结构化原因 + skippedChecks/skippedFigures 如实上报，绝不伪造全过。

## 5. Academic Figure Generation（M12.3）

**做什么**：数据集候选只能来自已解析来源块（sourceId+blockId 锚）或显式 manual origin → PlotSpec（line/bar/grouped_bar/scatter + benchmark_comparison/ablation 语义型）/ DiagramSpec（pipeline/comparison，DAG 校验）→ **确定性 TypeScript codegen 产出 pgfplots/TikZ**（全量转义、CJK 感知 ctex、纯 ASCII 字节不变）→ standalone 单遍 xelatex → 矢量 PDF 落 `manuscript/figs/generated/<figId>.pdf`（figId = specHash 前 12 hex，**同 spec 同图**，specHash 缓存命中零重编译）。manifest.json 记录 datasetHash/dataOrigin/insertedIn/supersededBy lineage。插入是确定性 env emitter（append 带受控 `\ref` 引用句 / replace 保 label + 区间外字节不动 + supersededBy）。

**真实性守卫**：
- generate 时来源锚反查（inlineDataset 篡改 → 409 `FIGURE_DATASET_STALE`）；
- caption↔dataset 数值声明三桶核验（value/delta/relative），跨桶混淆拦截（"50→75 提升 50 points" 判 violation），计数/全称/单位 UNVERIFIED → insert 硬闸走 `confirmUnverified` 作者确认通道（422 AUTHOR_REVIEW_REQUIRED）；
- Writer 图形守卫：tikz/pgfplots 恒禁，includegraphics 集合与基线一致；
- 已有论文项目 append 拒绝（403 `FIGURE_SCOPE_VIOLATION`，replace-only）。

**边界（如实）**：
- **能力界定：以真实数据和确定性 PGFPlots/TikZ 为基础的图表编译，不是生成式图像模型。** 图型覆盖 = 4 种数据图 + 2 种方法图模板（冻结范围）。
- **不宣称任意 ZIP 实验文件可完整自动理解**（明确写进演示红线）。
- LLM 起草 DiagramSpec 未实现（图表链路零模型参与，结构化表单入口）；figureTypeMix/tableStyle 未实现（Batch 2/3 遗留，如实记录）；>100 行数据集的逐行差值声明降为 UNVERIFIED。

## 6. Windows/Linux Deployment（M12.2.5 + Batch 3）

同一代码库两种形态：**Mode A Windows 开发机**（MiKTeX + 私有 provider 凭据，`PAPERTEAM_RUNTIME_ROOT` 隔离）与 **Mode B Linux 服务器**（Docker Compose + TeX Live + backend-docling 镜像 + 持久 volume + 公网仅 22/SSH 隧道访问）。凭据不同步（隔离有测试锁定）。Runtime Doctor 三形态（development / deployment=docker / deployment=native）检查各自真实需要的运行时事实。部署文档：`docs/deployment/linux-server.md`、`docs/deployment/dual-runtime.md`。

已预注册的范围外（如实）：SaaS / 多用户 / Auth / 数据库 / Redis / 队列 / K8s / MCP / 反代证书——定位是单用户自托管。

## 7. 真实模型与真实服务器验收证据

**Windows 真实链路（Batch 1–3 各报告记录）**：
- 真实 OpenAlex 学术发现（Batch 1 Smoke A 2.98s 全链；Batch 2 Smoke A 2.1s 四维诚实降级）；
- 真实 `glm-5.3`（Z.AI Coding Plan）profile 摘要 14.9s，provenance.model 落档（Batch 2）；
- 真实 `glm-5.3-flash` 视觉：`input=["text","image"]` 真实图像分析 completed=1（usage 918 in / 425 out；**$0.0004/次**——全部 M12 记录中唯一成本数字）（Batch 2 Smoke B）；
- 真实 MiKTeX 图表编译（line 2.0s / grouped_bar 2.1s / TikZ 1.8s，全部 %PDF 矢量；二次生成 cached:true 零编译）（Batch 1 Smoke C）；
- 真实 Docling 2.131.0 全链 2/2（138s）（M12.2.5）。

**新加坡 ECS 真实服务器（Batch 3 Part E，10-07/08）**：
- 环境：Ubuntu 24.04 / 4 vCPU / 16 GiB / 200G 数据盘 / Docker Compose / backend-docling 镜像（12.4G）/ TeX Live + pgfplots/TikZ/Fandol / GLM Z.AI Coding Plan；
- 部署：`git pull` → `docker compose build`（backend-docling + web）→ `up -d` 滚动重建 → 双容器 healthy；volume/.env/模型配置/HF 缓存全保留；**Runtime Doctor 自动识别 docker 形态全 PASS（exit 0）**；
- Smoke A–E 全过：A 真实 CSV → ingestion → datasets API → PlotSpec → 容器内真实 xelatex → 矢量 PDF → HTTP 资产服务；B DiagramSpec → TikZ → 矢量 PDF；C 有界真实 GLM 工作流手稿 → 插入 → 真实 xelatex+bibtex → **含图 Draft PDF**；D 篡改/无支撑声明拒绝；E existing-paper scope 守卫；
- 服务器宿主机执行全量回归 **2,860 passed / 0 failed / 25 skipped**（Node 22.20.0 用户目录 tarball + pymupdf --user，未动系统）。
- GLM 真实连接验收（前序部署记录）：双通道 1002/822ms。

**数字回填的诚实说明**：Batch 3 报告 §14（smoke 逐步时长 / 产物 SHA / 磁盘）为空占位，服务器已停机，本轮**无法回填且不虚构**——定性结论（全过）以 §12 执行记录与 PROJECT_STATUS 日志为准；如需逐步数字证据，登记 `SERVER_RESTART_REQUIRED_LATER`（目的：重放 Smoke A–E 并记录时延/SHA；预计 1–2 小时服务器时长）。

**本轮服务器状态：`SERVER_NOT_STARTED = true`。**

## 8. GitHub CI 证据

| commit | CI | Linux Integration | 备注 |
|---|---|---|---|
| `9302809` | run 37576226286 ✓ | — | 79 连败后首绿（typebox prune 根因修复） |
| `457d823` | run 37588467466 ✓ | — | Batch 2 终态（含 Dockerfile COPY resources 修复） |
| `710ff29` | run 37640984673 ✓ | run 37640984668 ✓ | M12.2.5 终态（8m55s；含容器内图表编译/持久化/compose smoke） |
| `a20a528` | run 37728925205 ✓ | run 37728925181 ✓ | Batch 3 终态（events.jsonl flake 修复后） |
| `30964ed` | run **37730402607** ✓ | run **37730402573** ✓ | **最终 HEAD，本轮 2026-10-08 复核确认双绿** |

CI 内容（`ci.yml`）：ubuntu Node 22 install/build/typecheck/test + pymupdf 真实 PDF 工具链 + Docker 镜像构建 smoke（含 `docker/figure-smoke.mjs` 容器内真实图表编译 5 用例含 CJK + specHash 缓存 + restart 持久化 + compose down-up）。`linux-integration.yml`：docling native + backend-docling 镜像双链路 + /proc 僵尸进程检查 + HF 缓存断言。

## 9. 三个产品 Demo 方案

> 设计原则：全部复用真实测试项目与既有验收产物，不创造虚构科研结果；服务器停机期间 Demo 1/2 可在 Windows 开发机复现（需 GLM 凭据），Demo 3 需本机 xelatex；在线录屏与 M12 功能截图登记待补。

### Demo 1 — 综述论文自动生成（Topic → Research → Evidence → Writing → Review → PDF）

- **输入材料**：一个综述主题（例：既有真实测试项目主题，如多目标跟踪综述）。
- **操作路径**：新建项目 → 选 Survey/Review 类型 → 输入主题 → 工作流自动推进：文献发现（OpenAlex）→ 语料导入与解析（Docling）→ 证据锚定 → 大纲 → 分节写作 → 引用核验（外部学术库交叉验证）→ 评审 → 修订 → 构建 Draft PDF。
- **关键页面**：工作流（阶段进度 + HITL 决策）、文献库（来源/全文/解析块）、证据（verified 状态与锚）、引用（核验状态）、评审、论文产出（PDF）。
- **技术亮点**：确定性参考文献链（xelatex+bibtex 编排）；Evidence 双层核验（只有 verified 证据进写作上下文）；零伪造引用（引用冻结清单）；两层质量门。
- **验收依据**：M9.6 全文 E2E、M11.3 综述产品验收、M11.4 可靠性程序 21 次真实运行（守卫零误报、零捏造泄漏）；真实测试项目存在于 `projects/`。
- **人工干预点**：HITL 决策（11 个决策点：可行性/大纲/修订计划等）；Final 冻结为作者决策。
- **截图状态**：相关页面 M11 时代截图已有（`e2e/shots/` 125 张，含 project-workflow/evidence/citations/review/pdf）。

### Demo 2 — 已有论文返修（Manuscript → Reviewer Comments → Evidence → Revision → Review → PDF）

- **输入材料**：真实论文 ZIP（主稿冻结版 v1）+ 审稿意见（真实返修案例输入包，SHA `b5d78f38…`，D:\PaperTeamData\，见 M10.3 记录）。
- **操作路径**：导入 ZIP → 基线构建（citation verify）→ 逐条意见结构化 → 定向证据补充 → 修订计划（作者批准）→ 机器验证的受限补丁 → 逐条意见判决（handled / already satisfied / conflicts with data / needs your decision）→ 修订 PDF + 投稿就绪性独立判决。
- **关键页面**：导入基线、审稿意见、工作流、修订 diff（受限补丁）、论文产出（修订 PDF）。
- **技术亮点**：范围补丁（未授权数值改动与结论升级由代码拒绝）；事实保持守卫（字节级表格 lineage 归因）；意见闭环与投稿就绪分开报告。
- **验收依据**：M10.3/M10.4 真实案例 E2E（15/18 → 收敛修复）；M11.4 Attempt 9 可靠性闭环（23 项 machine-owned 修复 + 21 真实 run）；真实输入包在库。
- **人工干预点**：修订计划批准；needs-your-decision 意见的作者裁决；Final 冻结。
- **边界**：**返修完成 ≠ 可投稿**（分开报告）；PDF 重建文本级 + 受控插入图。
- **截图状态**：评审/工作流/PDF 页面截图已有；修订 diff 视图截图待补。

### Demo 3 — 学术图表生成（Dataset → Spec → Vector PDF → Insertion → Final PDF）

- **输入材料**：experiment.csv 上传，或已解析 PDF 来源的表格块（sourceId+blockId 锚）。
- **操作路径**（Batch 3 §19 演示脚本，已在真实服务器走通）：文献库上传 CSV →「学术图表」数据图构建器（数据集下拉显示 fileName/行列/来源角色）→ 选图型/X 列/Series/caption →「校验 Spec」（守卫预览）→「生成图表」（真实 xelatex 秒级）→ 图表库（来源徽章 + datasetHash 派生 figId + PDF 内联预览）→「插入论文」（选章节 + caption 实时数值守卫 + label）→「论文产出」构建含图 Draft PDF。
- **关键页面**：文献库（上传）、学术图表（构建器 + 图表库）、论文产出（PDF）。
- **技术亮点**：确定性 codegen（同 spec 同图，specHash 缓存零重编译）；来源锚防篡改（datasetHash 反查）；caption 三桶数值真实性守卫 + UNVERIFIED 作者确认通道；受控插入（引用句唯一 `\ref` + label lineage + supersededBy）。
- **验收依据**：Batch 3 Smoke A–E 全过（真实服务器容器内 xelatex）；CI 容器内 figure-smoke 5/5 含 CJK；错误注入用例测试锁定（62.1→63.4 "提升 5 分" 判 violation 等反例）。
- **人工干预点**：UNVERIFIED caption 的作者确认（confirmUnverified）；方法图走结构化表单（非自由绘图）。
- **边界（演示红线）**：不宣称任意格式乱序 ZIP 实验包自动识别；图型 = 4 数据图 + 2 方法图模板。
- **截图状态**：FiguresPanel **无截图，待补**（登记 PENDING；服务器停机本轮不录）。

## 10. 已知限制（M12 汇总，全部来自各批报告如实记录）

1. 图表覆盖 = 4 种数据图 + 2 种方法图模板；figureTypeMix / tableStyle 未实现。
2. LLM 起草 DiagramSpec 未实现（图表链零模型参与）；Writer「需要新图」接单闭环未实现。
3. >100 行数据集的逐行差值声明降为 UNVERIFIED（成对差值比对跳过）。
4. caption 守卫保守方向：可能要求额外作者确认（宁误报不放过）。
5. 视觉审查：PDF 内嵌图无独立资产时如实 skipped；每图视觉错误只计数不逐条透出；缺 caption 检查仅 LaTeX 侧。
6. summaryModel 启动时解析（切换模型需重启）；target 三阶段无目标配置时 no-op（by design）。
7. Linux 容器内真实模型/视觉调用未在 CI 验证（CI 无密钥；Windows 真实验收 + 同代码路径）；历史里程碑脚本（m114-*/m1042 等）仍 Windows-only 开发产物。
8. SOURCE_DATE_EPOCH 字节级 PDF 复现未进 v1。
9. 单用户、无鉴权/多租户（预注册范围外）。
10. EvidenceStore 为 JSONL 文件存储（规模上限见 M13.0 评估）。

## 11. 未完成的 Browser E2E（如实）

M12 新功能验收形态 = **组件测试（TargetPanel/FiguresPanel/VisualReviewSection 共 11 个）+ API 集成测试（真实 HTTP 路由驱动）+ 部署 bundle 验证 + 真实服务器 HTTP 链路**。既有 Playwright 套件（12 spec）未新增 M12 功能用例；Claude Browser Acceptance 探索式走查未对 M12 页面执行（服务器无浏览器自动化）。**判定：Browser E2E Verified = PENDING**，不标记 PASS。

补齐路径（后续）：本地 `npm run dev` + Playwright 新增 target/figures/visual-review spec；或服务器重启后浏览器走查 + 录屏。本轮登记不执行（资源纪律）。

## 12. 用户端尚未覆盖的体验

- M12 功能页面零产品截图（README 现有截图全部为 M11 时代页面）。
- 在线 Demo / 录屏不存在（服务器停机 + 未录制）。
- Demo 演示脚本未固化为 `docs/demo/` 文档（本轮以本报告 §9 为准，后续可抽出）。
- 图表插入在**修订工作流内**的审批桥（insert_figure 计划条目类型）未实现——现行保守边界 = replace-only + 修订工作流内不改。
- 新用户首次跑通三条 Demo 的引导文档（getting-started 仅覆盖安装与零成本首路径）。

## 13. 技术亮点（技术交流 / 求职叙事用，全部真实可证）

1. **确定性优先的多智能体系统**：模型只做模型擅长的事（写作/理解/判断），一切可确定性化的环节（参考文献、图表编译、数值核验、守卫、gate）都是代码不是提示词——"靠代码不靠自律"贯穿全栈。
2. **科研诚实作为架构属性**：Evidence 双层核验 + 引用冻结 + Experiment Gate（无真实数据的研究论文停在实验计划）+ Figure≠Evidence 红线 + 四道 benchmark/evidence 隔离屏障——防捏造是结构保证。
3. **确定性学术图表编译器**：PlotSpec/DiagramSpec（typebox 校验）→ TypeScript codegen → pgfplots/TikZ → 单遍 xelatex 矢量 PDF；specHash 内容寻址（同 spec 同图 + 缓存）；datasetHash 来源锚反查防篡改；caption 三桶数值真实性核验 + 作者确认 HITL 通道——全链零 Python、零生成式图像模型。
4. **受限修订引擎**：范围补丁 + 字节级表格 lineage 归因 + includegraphics 集合不变式 + 未授权数值改动代码级拒绝；21 次真实运行可靠性程序验证。
5. **降级一等公民的视觉审查**：确定性 6 检查恒跑，视觉 4 检查能力感知，模型观察永不自动 verified，VisionUnavailableReason 结构化降级。
6. **双平台同构**：Windows（MiKTeX/私有凭据）与 Linux Docker（TeX Live/backend-docling/持久卷）同一代码库，doctor 三形态自检，CI 在两个生态各自验证真实工具链（容器内真实 xelatex 编译、docker restart 持久化、docling 僵尸进程检查）。
7. **工程可靠性实践**：CI 79 连败的根因定位（typebox dev/prod 分裂被 prune 删）与本地全链复现；events.jsonl 时序 flake 的准确归因（终态可见先于事件落盘，测试等待口径缺口，非功能回归）；全量回归在真实服务器宿主机执行。
8. **测试纪律**：2,860 backend + 292 frontend 真实通过；每个特性带反例测试锁定（任务书反例逐条进测试）；fixture 即契约（smoke 断言精确到 findings 数量）。

## 14. 后续工程建议（优先级排序）

1. **Browser E2E 补齐**（M12 收口的唯一 PENDING 验收）：新增 target/figures/visual-review Playwright spec + 截图录制。
2. **README/文档截图更新**：M12 功能页面截图（需运行环境）。
3. **insert_figure 修订计划条目**：打通修订工作流与图表动作的审批桥。
4. 图表批量（一 dataset 多图）+ spec 模板库 + Writer「需要新图」接单闭环（Batch 3 §21 遗留）。
5. M13.0 存储架构评估（本轮 Part B 已完成，见 `M13_0_STORAGE_ARCHITECTURE_ASSESSMENT.md`）及其后续决议。
6. 若需 Smoke A–E 数字级证据：`SERVER_RESTART_REQUIRED_LATER`（重放并记录时延/SHA，约 1–2 小时服务器时长）。

## 15. M12 Final Verdict

| 判定项 | 结论 |
|---|---|
| M12.1 Target Publication Intelligence | **COMPLETE** |
| M12.2 Multimodal Review | **COMPLETE**（真实视觉模型验收过） |
| M12.3 Academic Figure Generation | **COMPLETE**（真实服务器验收过） |
| M12.2.5 Linux & Dual-Runtime | **COMPLETE** |
| M12 Feature Complete | **true** |
| Deployment Verified | **true（Windows + Linux Docker；服务器现停机，未为本轮启动）** |
| Browser E2E Verified | **PENDING（如实，不标 PASS）** |
| Demo Assets Ready | **PARTIAL（路径+依据齐备；M12 功能截图/录屏待补）** |
| **M12 Final** | **功能与工程收口 COMPLETE；演示资产 PARTIAL；无未收口的功能性缺口** |
