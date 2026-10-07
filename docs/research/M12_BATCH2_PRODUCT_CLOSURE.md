# M12 Batch 2 — Target Publication Intelligence + Multimodal Review + CI 修复 实施报告

> **日期：2026-10-07。执行：Claude Code（双路并行 subagent Track A/B + 主线 CI 诊断修复与统一接线集成）。基线：`6e52b16`（Batch 1 收口），全程 main 未建分支。**
>
> **一句话结论：A7–A10 / B3–B5 / GitHub CI 三线全部完成——Target Publication Intelligence（真实 OpenAlex 发现 → 冻结语料 → 确定性 profile + bounded GLM 摘要 → 六维四档 readiness 判决 → TargetPanel UI 可操作）与 Multimodal Review（确定性六项检查 + 真实 glm-5.3-flash 视觉理解 → ReviewPanel 分栏展示，图表锚可追溯）两条产品链路以真实模型/真实检索 smoke 验收；GitHub CI 79 连败根因（Pi 1.0.1 升级后 typebox 被 `npm prune --omit=dev` 移除 → 容器启动即崩）已修复并验证 main 全绿。backend 全量 2,798 passed（+94）、frontend 287（+6）。**

---

## 1. Track CI — GitHub Actions 79 连败根因与修复

### 1.1 现象定位

- `gh`（以 git credential 的 PAT 为 GH_TOKEN）+ 匿名 REST API 取证：自 `f91ee41`（2026-10-03，**Pi SDK 0.84.4 → 1.0.1 升级**）起 main 连续 79 次 CI failure；最后一次成功 `c0e25b1`。
- 两种失败形态：f91ee41–aabed26 为 ubuntu **Test 步**失败（M11.2.3 `552529f` 修复）；`9302c9d` 起 Test 全绿但 **docker build smoke** 的 Smoke 步失败——`docker run -d` 启动的 backend 容器 ~2s 内退出，30 次 `docker exec` 全报 "container is not running"（旧 workflow 不打 `docker logs`，crash 原因不可见）。

### 1.2 根因（本地完整复现容器链后确证）

`pi-coding-agent@1.0.1` 的 typebox 依赖从 `1.3.7`（与 backend devDep 完全一致，锁文件单一顶层副本，prune 后保留）升到 `1.3.27`，与 backend devDep `typebox: 1.3.7` 分裂成**顶层 dev 1.3.7 + 三处嵌套 prod 1.3.27**。Docker 镜像构建的 `npm prune --omit=dev` 删除顶层 1.3.7 后，嵌套副本无法满足 dist 的扁平 import——`evidence/tools.js`、`retrieval/tools.js`、`skills/scholarlyTools.js`、`figures/spec.js` 均直接 `import { Type } from "typebox"` 且被启动链加载 → 容器启动即 `ERR_MODULE_NOT_FOUND`。ubuntu Test job（vitest 用全量 node_modules）与镜像 build 步（构建期只验 pymupdf/xelatex）都不受影响，只有运行期崩溃——这就是为什么只有 docker job 红。

### 1.3 修复（commit `9302809`）

1. `backend/package.json`：typebox 从 devDependencies 移入 **dependencies** 并对齐 Pi 版本 `1.3.27`（锁文件回归单一顶层 prod 副本；`npm ls` 验证）。
2. 本地完整模拟容器链：`npm ci → build → prune --omit=dev → PAPERTEAM_TEST_RUNTIME=scripted node dist/index.js` → 服务正常 listening（修复前同链路 typebox 缺失）。
3. ci.yml Smoke 步加固：循环后 **`docker logs pt-smoke`** + `ready` 标志显式判定——未来容器崩溃直接可见，不再依赖盲猜。
4. 验证：`9302809` 的 CI run **✓ test 3m25s + ✓ docker build smoke 3m45s**（79 连败后首次全绿）；typebox 1.3.7→1.3.27 API 兼容（typebox 重度套件 126 tests + 全量回归全绿）。

**CI 完成标准**：run SHA == 最新 main HEAD 且 conclusion == success —— 见 §8（最终 push 后复验）。

## 2. Track A — Target Publication Intelligence（A7–A10）

### 2.1 A7 TargetPublicationProfile（`research/target-profile.json`）

- **服务**：`target/TargetProfileService.ts` + 纯函数模块 `quantiles.ts`（线性插值 `Distribution {n,min,p25,median,p75,max}`，round2）/ `paperStats.ts`（单篇确定性提取）/ `aggregate.ts`（覆盖与可用度聚合）；服务束工厂 `target/services.ts`（`buildTargetServices` 一处装配 benchmark/discovery/profile/gap 四服务）。
- **确定性提取（零模型参与）**：章节模式（canonical 折叠词典）+ 各节中位长度、全文/摘要词数（Unicode 分词）、参考文献条目数（`[n]` 标记优先、无标记年份计数兜底并 note 披露）+ 引用密度 + 参考文献年龄中位数、表数、数据集广度（`<名> dataset/benchmark/corpus` 短语 distinct 计数）、图数、ablation/robustness/limitations/方法图存在比例。
- **覆盖诚实性（Batch 2 的核心纪律）**：每维度携带 `DimensionCoverage {availability: available|unavailable|insufficient; coverage; reason?}`——语料论文无全文/无解析产物时统计不发明、零贡献如实计。n<5 → 该维度 insufficient。
- **bounded LLM 摘要（仅 method/writing 两维）**：`TargetSummaryModel {caller, catalogEntry, spec}` seam（pi completeSimple 形状）；输入**只有聚合统计，零 benchmark 论文原文**（防 style cloning 的结构性保证，测试锁定）；typebox 校验 + 至多 1 次 repair，仍失败 → 两维 UNAVAILABLE + `summaryFailure`（不伪造、无无限重试）。
- **freshness 三键**：`(benchmarkRevision, corpusFingerprint, extractorSchemaVersion)` 任一不符 → `get()` 返回信封 `fresh:false + staleReason`；`ensureCurrent()` 才重建；陈旧 profile 永不静默当作当前参照系。损坏 JSON fail-closed（新错误码 `TARGET_PROFILE_CORRUPTED`，主线收口）。

### 2.2 A8 Target Readiness（`research/target-readiness.json`）

- `target/TargetGapService.ts` + `manuscriptStats.ts`（稿件侧确定性观测：tex 命令剥离词数、顶层 `\section` 切分、distinct `\cite` key、visualInventory 优先 .tex 兜底的表/图计数、与 profile 侧同款数据集启发式）。
- **六维 × 四档判决** `{MEETS_TARGET, PARTIALLY_MEETS_TARGET, BELOW_TARGET, INSUFFICIENT_EVIDENCE}`：数值维度按分位带定位（内带 [p25,p75]=MEETS、外带 (min,max)=PARTIALLY、越界=BELOW）；method/writing 定性维判决上限 PARTIALLY（确定性纪律——模型摘要不得判 MEETS，过度声称防线）。每维 observed/targetRange/gaps[]/confidence/evidenceBasis；overall verdict+summary。
- **Target Gap ≠ Actual Defect（任务书 §5 红线）**：每条 gap 字符串携带「不构成稿件事实错误；目标带非官方投稿要求」限定语；`provenance.basis="benchmark_observation"` + disclaimer——benchmark 观测与官方投稿指南的 provenance 区分落地。无手稿 → 全维 INSUFFICIENT（不 crash）；语料不足 → INSUFFICIENT_EVIDENCE + 原因。**全 artifact 无任何数值分数门**（断言 `targetScore` 不存在）。

### 2.3 A9 Workflow / Reviewer / Planner / Gate 集成

| 消费点 | 接入方式 | 缺席时行为 |
|---|---|---|
| FeasibilityService | `assess({targetReference?})` → prompt 尾追加「目标实证参照系」块 | prompt 逐字节不变（测试断言） |
| ReviewerService（academic） | `targetExpectations?` 注入数值期望块（如「目标带正文 X–Y 词、图+表 Z–W」） | 同上（fact/style 模式恒不变） |
| Planner（WriterService.planImprovement） | `targetReadinessDigest?` advisory 块（明示不自动立项） | 同上 |
| Quality Gate | `QualityGateInput/Result.targetReadiness?` 纯透传 + `readinessGateAdvisory` 投影 | 零规则参与、零阻断（rules 深度相等断言） |
| workflow | `target.benchmark → target.profile → target.readiness` 三 stage 插在 idea_to_paper / existing_paper_improvement 的 feasibility 之前（topic_survey 不动） | 未接线 / 已冻结（幂等）/ 无 researchField → 显式 no-op |

- **主线集成时发现并修复的关键缺陷（advisory 纪律兜底）**：targets 在生产栈接线后，target.benchmark 会在「未配置学术检索 provider」的环境（测试栈/无 Key 部署）抛 `SEARCH_PROVIDER_NOT_CONFIGURED` → 主 workflow 直接失败——违反 M12.0 §15「Target 不阻断」。修复：三 stage 的 discovery/提取/评估调用全部包裹 advisory 兜底（错误码+消息记入 stage result 的 skipped.reason，主流程继续，下游以「benchmark 未冻结」no-op）；新增回归测试锁定。**target 阶段从此不可能改变既有 workflow 终态。**
- profile 只在 fresh 时注入审稿上下文（陈旧不注入而非就地重建——防 LLM 调用意外进入审稿路径）；重建只发生在 target.profile stage / 显式 regenerate。

### 2.4 A10 TargetPanel（UI）+ HTTP

- `frontend/src/components/project/TargetPanel.tsx`（自包含）+ `frontend/src/api/target.ts`；主线接入 ProjectPage「目标投稿」tab。四区块：目标配置（venue/档次/documentType/领域/冻结状态）→ Benchmark 语料表（论文/venue/引用数/入选理由/充分性/冻结 revision；exclude/confirm/(re)discover 真实操作）→ Profile 分位带（availability 徽章 + stale 提示 + 重建按钮）→ Readiness（overall 徽章 + 六维判决/置信度/gap + INSUFFICIENT 警告 + disclaimer 脚注）。未配置 vs 未发现两种空态明确区分。
- **HTTP 路由组（主线实现，10 端点）**：`GET/POST /api/projects/:id/target/{benchmark,benchmark/discover,benchmark/refresh,benchmark/papers,benchmark/papers/:sid/exclude,benchmark/confirm,profile,profile/regenerate,readiness,readiness/evaluate}`；为 refresh 语义在 `benchmarkDiscoveryService` 增 `rediscoverAndRefresh`（重发现→指纹不同才 revision+1，相同幂等返回——与 freeze 的幂等 no-op 语义区分）。

## 3. Track B — Multimodal Review（B3–B5）

### 3.1 B3 VisualReviewService（`vision/VisualReviewService.ts` + `vision/visualChecks.ts`）

- **确定性路径（恒运行，零模型依赖）六项检查**：label-ref 解析（unresolved `\ref{fig:/tab:}`）、重复 label、缺 caption（latex 侧）、未引用 artifact（info 级，仅当全文存在 ≥1 视觉引用）、表-文数值一致性、题注-描述匹配（启发式恒 `needs_author_review`）。
- **数值一致性规则（假阳性优先，文件头精确文档化+测试锁定）**：句子须同时绑定「表头指标词 + 行标签词」才比较；每个指标出现位置只取 ≤60 字符内**最近一个**数值（防 "A is 118 while B is 79" 错位）；差值语（by/±/约/了/到）、|整数|≤12、字母相邻数字（MOT17）、字面 "Table N" 引用排除；多表同 (行,指标) 并集消歧；latex 表只与 latex 正文比、pdf 表只与同源 pdf 正文比（分组隔离）。
- **vision 路径（capability 可用时）**：完全复用 M10.2 seam（`resolveVisionModel` + `completeSimple` + pi ImageContent，零新 Runtime）；每图一次有界调用覆盖四项检查（figure↔caption / figure↔正文 claim / legend-axis / diagram↔方法描述，nearby text 2400 字符预算）；typebox 校验 + 1 次 repair → 仍失败如实 `failed`（无无限重试）。模型判断**永不**自动 verified——`verificationStatus ∈ {verified_deterministic, model_observation, needs_author_review}`（Figure ≠ Evidence 纪律的 finding 层落地）。
- **vision 不可用是一等公民**：capability 报告（VisionUnavailableReason 原因码 + skippedChecks + skippedFigures + usage），四项 vision 检查 skipped 如实呈现——绝不出现「全部视觉检查通过」的伪 PASS；确定性检查不受影响（当前 GLM-5.3 文本主模型部署下系统全功能可用）。
- 产物落盘 `reviews/visual-review-r<n>.json` + 每次运行重建 `research/manuscript-visuals.json`（derived 与当前 .tex 同步）。

### 3.2 ReviewFinding 契约扩展（additive）

`finding.ts`：`FINDING_CATEGORIES` 增 `"visual"`；可选新字段 `figureEnvRef?`（VisualArtifactView id，如 `tex:main.tex:table-1`）/`assetRef?`/`visualConfidence?`/`verificationStatus?`；figureEnvRef 成为 visual 类目的第四种合法 provenance；`readFinding` 向后兼容（旧 JSON 原样读入，损坏新字段条目丢弃+计数）。`ReviewAggregator` 增 `summarizeVisualFindings()` + `ReviewSummary.visual?` 单列——counts/scores/openCritical/openMajor 口径零改动（回归锁定）。

### 3.3 B4 图资产 HTTP（`vision/figureAssets.ts` + 路由）

- 纯逻辑解析器：source 抽图（`sources/figures/<sid>/<name>`，png/jpg/jpeg）与生成图（`manuscript/figs/generated/fig-<hex>.pdf`）。**安全语义（13 类攻击面测试）**：扁平名白名单 `^[A-Za-z0-9][A-Za-z0-9._-]*$`、拒绝 `/` `\` `..` 前导点 NUL/控制字符/绝对路径、词法+realpath 双重包含校验、**登记先于读盘**（ParsedDocument figure 块 assetName / figureStore manifest；未登记的重解析残留 → `stale_asset` 404）。错误码契约：`invalid_project`→404 / `invalid_path`·`unsupported_asset`→400 / `missing_artifact`·`stale_asset`→404。
- 路由（主线接线）：`GET /api/projects/:id/sources/:sid/figures/:name`（补 M12.0 G8）+ `GET /api/projects/:id/figures/generated/:name` + `GET|POST /api/projects/:id/visual-reviews/{latest,run}`（latest 从未运行 → `{report:null}` 而非 404）。

### 3.4 B5 ReviewPanel 集成

`ReviewPanel.tsx` 追加 `VisualReviewSection`：**「确定性视觉检查」与「Vision 辅助审查」两组严格分栏**（来源永不混淆）；每条 finding 卡：severity/置信度/图表锚（VisualArtifactView id 可追溯）/page/section/related claim/解释/建议 + 图像预览（`<img>`）或 PDF 链接或显式「预览不可用：<原因>」；vision 不可用显式原因码 + 「确定性-only 模式」标注；未运行（含运行按钮）vs 无 findings 两类空态。不自动修改 Figure（figure-aware revision 属 C4–C6 后续）。

## 4. Benchmark Corpus / Evidence 隔离（Batch 1 四道之上的 Batch 2 增量）

Batch 1 已落地四道隔离（role 过滤 / propose fail-closed / ground 纵深 / vision confirm 禁令）。Batch 2 增量：

1. profile 提取**只读 ParsedDocument parser facts + bib 元数据**，不经过 evidence pipeline，不产生任何 EvidenceRecord；
2. summary 模型输入只有聚合统计——benchmark 论文文本结构性不进任何写作/摘要上下文（D-0012 style cloning 防线延伸到 A7）；
3. 视觉评审 pdf_parsed 侧 `listSourceIds` 显式过滤 `sourceRole !== "reference"`（benchmark 语料不进稿件评审，主线接线时落地）；
4. target 语料论文的三 artifact（benchmark/profile/readiness）全部 advisory——不进 Quality Gate 任何规则、不改变 Revision Task Success / Publication Readiness 判定（M12.0 §15 三层分离的代码级落地）。

## 5. 真实 Smoke（全部通过）

### Smoke A — Target Publication（`test/target/targetPipelineLive.smoke.test.ts`，PAPERTEAM_LIVE_SMOKE=1）

1. **真实 OpenAlex 全链**（2.1s）：CVPR venue 解析 → 2019–2025 MOT 真实发现（≥4 篇带引用数与 venue）→ 冻结 → 确定性 profile（**真实语料 metadata-only → 结构/文献/实验/视觉四维如实 unavailable/insufficient、coverage=0、reason 明示——统计零发明**）→ 幂等（同指纹不重建）→ 手稿 fixture → readiness 六维四档（INSUFFICIENT>0、每条 gap 带「不构成稿件事实错误」、`basis=benchmark_observation`、无 targetScore）。
2. **A7 摘要模型 live 验收**（14.9s）：真实 `zai-coding-cn/glm-5.3`（Z.AI Coding Plan）→ `method:available, writing:available`，`provenance.model` 标注，modelSummarizedFields 非空。

### Smoke B — Multimodal Review（`test/vision/visualReviewLive.smoke.test.ts`，PAPERTEAM_LIVE_SMOKE=1）

- **确定性路径**：visual-review-sample fixture（+追加合规 PNG figure）→ 恰 5 条确定性 findings（1 数值冲突[可追溯 `tex:...:table-N` 锚] + 1 题注不符 + 1 未解析引用 + 1 缺 caption + 1 未引用 info）；全部假阳性守卫零误报（同数异境/异指标/差值语/标识符数字/无行绑定）。
- **vision 路径（真实视觉模型验收）**：`zai-coding-cn/glm-5.3-flash` 经 Pi 目录确认 `input=["text","image"]` + 凭据 → **真实图像分析成功**（completed=1；fixture 图 200×120 PNG；usage 918 input/425 output，$0.0004/次）；模型观察 findings 恒 model_observation/needs_author_review。两处 PDF 资产 figure 如实 skipped（vision 只送 PNG/JPEG——含 Z.AI 拒收 1×1 退化图 code 1210 的实测记录，fixture 已改用真实尺寸图）。`runForProject` 落盘 → `latestVisualReview` 读回 round-trip 验证。
- 附带实测：**M12.2 以真实多模态模型验收完成**（非 deterministic-only MVP）。

### 路由级验收（默认套件内）

- `test/target/targetHttp.test.ts`（4）：null 信封 / 404 / 空字段 400 / targetCount 校验 / 未冻结 refresh 拒绝。
- `test/vision/visualReviewHttp.test.ts`（4）：visual-reviews latest/run 真实 HTTP 链（fixture 手稿 → report 含 findings + capability）+ 图资产 200/400/404（traversal/未登记/扩展名白名单）+ 生成图 manifest 登记。
- 前端组件（6）：TargetPanel 三态（未配置空态/发现按钮真实 API 调用/齐全数据渲染判决徽章）+ ReviewPanel 视觉区三态（未运行/deterministic-only 分栏+不可用原因/运行按钮真实调用）。

## 6. 测试与回归

| 套件 | 结果 |
|---|---|
| backend 全量（4 workers） | **258 files / 2,798 passed / 0 failed / 19 skipped**（Batch 1 基线 242/2704/16 → **+16 files +94 tests**；skipped = live-smoke 门 + docling 门） |
| doclingReal.smoke | 全量并行下 1 次环境 flake（M11.4.5 已知 Windows 内存压力形态）；隔离复跑 2/2 PASS（182s）——非回归 |
| backend typecheck / build | 0 错误 / 成功（含双 agent + 全部主线接线） |
| frontend | typecheck ✓ / build ✓（chunk 警告既有）/ **29 files 287 passed**（281 → +6 组件测试） |
| `git diff --check` | PASS |

新增测试构成：Track A 36（profile 12 + readiness 11 + integration 13）+ Track B 50（vision 38 + review 12）+ 主线 11（targetHttp 4 + visualReviewHttp 4 + advisory 兜底 1 + 前端 6）+ live smoke 3。既有测试仅 2 处期望更新（workflow completedStages 前缀 3 个 no-op target stage——预期行为变更）。

## 7. 文件清单（Batch 2 全量）

**新建 backend src（15）**：`target/{TargetProfileService,TargetGapService,quantiles,paperStats,aggregate,manuscriptStats,promptBlocks,services}.ts`、`vision/{VisualReviewService,visualChecks,figureAssets}.ts`、（前端）`api/target.ts`、`api/visuals.ts`、`components/project/TargetPanel.tsx`
**新建 test（11 + 2 fixture 资产）**：`test/target/{profileFixtures,targetProfile,targetReadiness,targetIntegration,targetHttp,targetPipelineLive.smoke}.test.ts`、`test/vision/{visualReviewChecks,VisualReviewService,figureAssets,visualReviewHttp,visualReviewLive.smoke}.test.ts`、`test/review/{visualFinding,visualAggregation}.test.ts`、`test/fixtures/manuscript/visual-review-sample/{main.tex,tiny-chart.png}`、（前端）`test/{TargetPanel,ReviewPanelVisual}.test.tsx`
**修改（18）**：`serviceStack.ts`（visualReview+targets 接线）、`httpServer.ts`（target/visual-reviews/figures 路由组+图资产）、`index.ts`（targetSummaryModel 装配）、`errors.ts`（+2 code）、`workflow/definitions.ts`（target 三 stage + advisory 兜底）、`search/benchmarkDiscoveryService.ts`（rediscoverAndRefresh 重构）、`agents/{FeasibilityService,ReviewerService}.ts`、`writer/WriterService.ts`（Planner seam）、`quality/gates.ts`、`target/types.ts`、`review/{finding,ReviewAggregator}.ts`、`vision/scriptedVisionRuntime.ts`、`.github/workflows/ci.yml`、`backend/package.json`+`package-lock.json`、（前端）`pages/ProjectPage.tsx`、`components/project/ReviewPanel.tsx`、2 个既有 workflow 测试期望更新

## 8. 遗留问题与下一步

1. **C4–C6 Figure Generation Product Closure**（M12.3 剩余）：HTTP+UI（POST figures/generate + FiguresPanel）、手稿插入（env emitter + 模板 graphicx + Writer 资产白名单语义——触碰修订安全边界须单独串行）、caption 数值↔dataset 守卫 + doctor pgfplots 预检。B4 的生成图资产路由已就位（figs/generated/<figId>.pdf + manifest 登记）。
2. **figureTypeMix / tableStyle 未实现**（profile visuals 维）：需逐图 vision 分析 / LaTeX 侧数据，v1 以 note 诚实说明。
3. **visual findings 的 per-figure 错误消息**在聚合 detail 中只计数不透出（可观测性小缺口，后续可在 detail 中附最近错误）。
4. **missing-caption 只覆盖 latex 侧**（PDF caption 缺失常为 Docling 能力边界，避免噪声 finding——视图 extraction.note 已透明）。
5. target summary 模型装配依赖**启动时**默认模型解析；运行中切换默认模型需重启生效（与 PiRuntimeAdapter 既有语义一致，如实记录）。

## 9. 验证清单（最终状态）

- `npm run typecheck`（backend+frontend）/ `npm run build`（backend+frontend）/ `npm test`（backend 2,798 + frontend 287）/ `git diff --check` 全 PASS；
- 三个 live smoke（真实 OpenAlex ×2 用例 + 真实 GLM-5.3 摘要 + 真实 glm-5.3-flash 视觉理解）全过；
- GitHub CI：`9302809`（typebox 修复）run 37576226286 **✓✓ 全绿**；最终 HEAD push 后复验见 PROJECT_STATUS。

---

**M12 Batch 2 — COMPLETE（A7–A10 / B3–B5 / CI）。M12.1 COMPLETE、M12.2 COMPLETE（含真实视觉模型验收）、M12.3 PARTIAL（C1–C3 既有 + B4 生成图资产路由就位；C4–C6 PENDING）。READY_FOR_BATCH_3 = true。**
