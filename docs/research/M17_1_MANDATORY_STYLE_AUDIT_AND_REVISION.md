# M17.1 默认必检的学术风格 / 过度防御性表达审查 + 受控自动修订 + 真实论文验收

> 日期：2026-11-04 · 执行：Claude Opus（Claude Code）· 仓库 `D:\Projects\PaperTeam` · 分支 `main`
> 起始 SHA：`773f78fb1d0c5aecfbdd61c154d3bee7fe9b76df`（= origin/main，工作区干净）
> 工程提交：`1c13932cd258a5bb2fd678318c8de8b2f75f46cc`（已推送；CI ✅、Linux Integration ✅）
> 报告提交：首版 `19ebac0`（B 臂中断时）；本版为 B 臂重跑后的更新（见 git log）。代码自 1c13932 起未改动。

## 0. 结论先行（四个层次分开判定）

| 层次 | 判定 | 依据 |
|---|---|---|
| 工程 `M17_1_ENGINEERING` | **PASS** | 默认调用、单元级覆盖与失败可追踪、风格 issue 机器侧钳为建议性、定点修订受锚点 + 守卫 + 编辑契约 + 语义否决约束；后端 4894 / 前端 392 测试、typecheck、build、Playwright 新用例、CI 与 Linux Integration 全部通过（§4） |
| 真实审查路径验证 | **PASS（有限定）** | 真实模型、真实产品 HTTP 入口：B 臂三轮风格审查 8/8 中文单元覆盖 COMPLETE，复审只重审改动单元；`revision.style_audit_apply` 在 Draft 链真实执行并落盘 4 处；Gate 中 17 条被模型标 major 的 style 意见被钳为 minor，规则 `academic_style_audit_reported`=INFO。限定：**两臂 run 都以 `revision.revise` 失败终止**（历史缺陷，§6.4），**不是完整 A/B 产品闭环 PASS**；新建论文路径只做了 2 次生产函数直调触发（非 idea_to_paper 入口，§6.5） |
| 真实防御性表达改善效果 `M17_1_REAL_PAPER_EFFECT` | **NOT_DEMONSTRATED（PARTIAL）** | 冻结样本确定性候选 0 处，作者本人论文普遍低密度——样本**不足以证明改善效果**；B 的 4 处自动修订中只有 1 处（删「如实报告为」）经执行代理初筛无问题；**1 处删句后残留句末逗号、1 处造成术语不一致、1 处引入主语重复**（守卫与语义复核均未拦住，§6.3）；必要限定 / 负结果信息全部保留 |
| 人工评价 | **HUMAN_REVIEW_PENDING** | 未收到作者评分；本报告中的语义判断均为执行代理（Claude）的初筛 |
| `M17_1_COMPLETE` | **否** | 工程达标，审查路径真实可用；改善效果未被证明、人工评价未完成、两臂闭环均未跑通 |

不做的承诺：这不是 AI 生成检测，不输出 AI 率 / AI 概率，不承诺通过任何 AIGC 检测器；风格改善不等于投稿准备完成，Publication Target 与 Gate 阈值未调整。

## 1. M17.0 三个缺口：在当前 HEAD 上核实并处理

| 缺口 | 773f78f 证据 | M17.1 处理（1c13932） |
|---|---|---|
| ① academic-style-zh 未进入长文档逐单元审查 | 单元审稿用 `contextScope: "review/academic/unit"`（`backend/src/agents/ReviewerService.ts:520`@773f78f），该 scope 不路由 `academic-style-zh`；长文档模式 style 结果 `issues: []`，只有加权 riskScore | 新增每单元一次 sealed 调用 `ReviewerService.auditUnitStyle`，`contextScope: "review/style/unit"`（`ReviewerService.ts:742`），落在 `review/style` 路由前缀（`backend/src/skills/routing.ts:65`）→ academic-style-zh；短稿（digest 模式）同样按覆盖计划单元审查。学术单元审稿 prompt 与请求指纹**逐字节不变** |
| ② styleInvariants.ts 因限定词计数变化拒绝有益修订 | `compare("sentinel_words" …)` / `compare("source_boundaries" …)` 计数一变即阻断（`backend/src/review/styleInvariants.ts:362, 373`） | **未放宽**。另建窄通道：`checkStyleRewrite`（`backend/src/review/academicStyleAudit.ts:602`）只在**锚内**判定，按类别区分：对冲堆叠允许删冗余但必须保留 ≥1 个限定；样板自谦可删；实质限定词（样本 / 数据集 / 协议 / 验证 / 统计 / 负结果 / 代价）、否定、比较方向、强断言 / 因果 / 泛化新增全部拦截。fixture #9 证明「仅因数量变化」不再误拦，同时对照用例证明 style_polish 守卫行为不变 |
| ③ 模型把 style issue 标 major 会硬 FAIL | 聚合对所有类别计 critical/major/blocking（`ReviewAggregator.ts:154`@773f78f），`blocking_issues_zero` / `open_critical_major_zero`（`gates.ts:890, 915`）不排除 style | `applyStyleAdvisoryPolicy`（`backend/src/review/ReviewAggregator.ts:94`，调用于 `:178`）：category=style 一律计为 minor / 非 blocking，原值存 `modelSeverity` / `modelBlocking`，`severityPolicy: "style_advisory/v1"`——机器侧白名单，不靠 prompt。fact / academic 不受影响 |

## 2. 架构决策（复用而非新造）

- **为何默认必检**：用户裁决（任务书 §0）。M17.0 的「flag 默认 off + 作者逐句批准」被替换为「默认审查 + 机器分级 + 只对可证明的纯措辞条目自动定点修订」。
- **复用点**：覆盖计划 / 单元切分（`coverageLedger` + `logicalSpan`）、Reviewer 运行时与 sealed 会话、`EditContract` + `validateCandidateEdit`、`guardedRevisionCommit` 提交边界、`checkClaimStrengthEscalation`、`detectClauseConclusionFlips`、既有尾部重走（citation.verify → review.run → quality.gate）。**没有**新 Agent、Skill 安装器、第二套 Style Store 或第二套 Gate。
- **新增模型调用（实测前的设计预算）**：每轮 review.run 每个中文正文单元 1 次（失败重试 1 次；每轮上限 `PAPERTEAM_ACADEMIC_STYLE_AUDIT_MAX_CALLS`=80）；修订复审只重审改动单元（单元哈希 + 政策版本复用）；每 run 至多 1 次定点修订阶段，语义复核 ≤ 2 次调用（每批 20 条）。预算不足 / 失败 → 单元 `SKIPPED_BUDGET` / `FAILED`，覆盖如实降为 PARTIAL / FAILED，从不静默 PASS。风格调用排在学术单元审稿之后，不会挤占同一 stage 的学术审稿。
- **规则来源**（只借鉴判定思路，未引入第三方文本，模块头注释记录 SHA 与许可证）：Kiterlin@f516147（MIT）必要限定判据与防御句分类；OvOYu@bdab0d2（MIT）事实优先 / audit 只读；Shaishav@cf30d64（Apache-2.0）支撑—缩窄—删除与强度变化审查。拒绝 Adkid「不说输 / 打不过的维度不设为比赛」。

## 3. 修改内容

| 文件 | 行为 |
|---|---|
| `backend/src/review/academicStyleAudit.ts`（新） | 共享政策（Writer 预防规则 `ACADEMIC_STYLE_WRITER_LINES` 与 Reviewer 审查规则同源）；9 类 styleCategory；候选扫描（仅提示）；审查 prompt；严格解析（缺 `styleFindings` = 结构违约）；锚点定位（空白容忍、唯一才可改）；`checkStyleRewrite` 锚内守卫；`classifyStyleFinding` 机器分级；覆盖汇总；语义复核 prompt / 解析；修订记录与确定性复评关闭 |
| `backend/src/review/academicStyleAuditRunner.ts`（新） | review.run 内调度：每单元恰一条记录 COMPLETE / REUSED / FAILED / SKIPPED_BUDGET / NOT_APPLICABLE（纯标题、非中文、英文稿、第三方已发表论文只读评估）+ 原因、尝试次数、taskId / model / promptSha256 / usage / 耗时；跨轮复用 |
| `backend/src/review/academicStyleRevision.ts`（新） | 定点修订内核：资格 → 唯一锚定（当前稿）→ 锚内守卫 → `academic_style_rewrite` 契约整目标校验 → 语义否决 → 同目标合并后再校验（契约 + 强度升级 + 结论翻转）→ 任一失败整目标不写 |
| `backend/src/quality/editContract.ts` | 新 source.kind `academic_style_rewrite`：anchors 模式、`allowedOps={replace_wording, delete_text}`、数值硬冻结、`preserve_existing_no_new` |
| `backend/src/agents/ReviewerService.ts` | `auditUnitStyle`、`checkStyleRewrites`（sealed，新会话）；`ReviewIssue.modelSeverity/modelBlocking/severityPolicy` |
| `backend/src/review/ReviewAggregator.ts` | style 严重度钳制；`ReviewSummary.styleAudit` 摘要 |
| `backend/src/quality/gates.ts` + `qualityReport.ts` + `reviewPurpose.ts` | 建议性规则 `academic_style_audit_reported`（`gates.ts:972`）：COMPLETE=INFO、PARTIAL/FAILED/DISABLED=NOT_EVALUATED、无可审单元=NOT_APPLICABLE；非必需（不阻止 Final，也不显示为通过）；L2 层；旧产物无字段则不出现 |
| `backend/src/workflow/definitions.ts` | review.run 接入（`:1771`，`runStyleAuditForReview` `:13457`）；新 stage `revision.style_audit_apply`（`:5545`）与 planner `planStyleAuditApply`（`:5701`）：gate 通过分支（Final 前）与 Draft 链（构建前）各调用，每 run 至多一次；落盘改稿计入 contentIdx → 尾部重走；Draft 入口经复审后回到 Draft 链 |
| `backend/src/writer/WriterService.ts` | `MANUSCRIPT_CONTENT_LINES` 追加共享预防规则（Writer 自检不替代 Reviewer 必检） |
| `config.ts` / `serviceStack.ts` / `index.ts` | `PAPERTEAM_ACADEMIC_STYLE_AUDIT`（缺省 on；off 仅诊断，状态 DISABLED 可见）、调用 / 自动修订上限 |
| `httpServer.ts` + `reviewArtifacts.ts` | `GET /api/projects/:id/style-audit`；产物 `reviews/style-audit-r{n}.json`、`reviews/style-revision-r{n}.json` |
| 前端 | `AcademicStyleAuditPanel.tsx`：Review 页（系统性改进，含 LaTeX 无 PDF 分支）与论文产出页；覆盖状态、类别计数、已定点修订 before/after、「未修改：需要证据或作者决定」、保留的必要限定、失败单元警示、免责声明；无 AI 率 |
| `scriptedRuntime.ts` | 测试夹具：`review/style/unit` 缺省「已审无问题」，含「粗浅的尝试」时报一条可删除自谦；语义复核恒 EQUIVALENT |

可观测字段：单元 `status/reason/attempts/error/taskId/model/promptSha256/usage/ms/candidatesUnaddressed/droppedFindings`；finding `id/file/logicalSection/originalQuote/styleCategory/candidateReason/necessityJudgment/evidenceConstraints/suggestedAction/proposedRewrite/disposition/dispositionReason/precheck/reviewStatus/revisionStatus/lineage`；修订条目 `status ∈ {AUTO_FIXED, KEPT, AUTHOR_DECISION, GUARD_REJECTED, SEMANTIC_REJECTED, ANCHOR_LOST, NOT_DISPATCHED, STALE}` + 可读 detail；stage 结果 `styleAuditState/Findings/AutoEligible`、`revision.style_audit_apply` 的各状态计数与语义复核调用数；领域事件 `style_audit.revision_applied/skipped`。

## 4. 测试证据（全部为测试模拟——scripted / 人工构造，**不是**真实模型结果）

### 4.1 fixture（`backend/test/review/academicStyleAudit.test.ts`，28 例，句子全部人工构造）
任务书 §6.1 映射：#1 自谦整句删除（并对照 style_polish 守卫仍拒绝）；#2 对冲堆叠保留一个限定 ✓ / 删光 ✗；#3 「我们不研究 X」改正向丢边界 ✗；#4 小样本 / 单数据集 / 特定协议删除 ✗；#5 无检验加「显著」✗；#6 负结果 / 失败 / 成本删除 ✗；#7 新增首次 / SOTA / 普遍适用 / 全面领先 ✗；#8 相关变因果、部分变全体 ✗；#9 限定词数量减少本身不拦截 ✓；#10 多处相同原句（锚点不唯一 → AUTHOR_DECISION）、跨行引文定位、`\cite` / `\ref` / 数值 / 比较方向变化 ✗；#11 空数组 = 已审无问题，缺字段 / 非数组 = 抛出，单条非法 fail-closed 丢弃并记原因；覆盖五态。机器分级：必要限定 / 负结果恒 KEEP（即使模型建议改），贡献弱化 / overclaim / UNCERTAIN 恒 AUTHOR_DECISION。

### 4.2 调度 / 修订 / Gate（`academicStyleRevision.test.ts`，12 例）
长稿 12 单元：10 中文正文全部审查、标题 / 英文单元 NOT_APPLICABLE、无重复审查（#14）；非法输出 / 超时重试后 FAILED、其余单元照常 → PARTIAL；调用上限 → SKIPPED_BUDGET；开关 off = DISABLED；跨轮复用。修订：EQUIVALENT → AUTO_FIXED 且锚外逐字、引用 / 必要限定保留；UNSURE / CHANGED / 不可用 → 保持原文；锚点丢失 / 不唯一 / 已处理 / 超上限；KEEP 与 AUTHOR_DECISION 永不派发；越权改写在落盘前被再次拦截。Gate（#12）：style major / critical / blocking 不触发两条硬门，原值留痕；真实 fact / academic blocking 照常 FAIL；覆盖 FAILED 时 Gate 的 passed 与失败规则集合与无风格摘要时完全一致。

### 4.3 默认路径集成（`backend/test/workflow/academicStyleDefault.test.ts`，#13）
- 修改已有论文（HTTP：导入 → existing_paper_improvement，不设任何选项）：默认审查 → `revision.style_audit_apply` 恰好一次 → 样板自谦整句删除、必要限定句 / `71.3` / `\cite{a}` 逐字保留 → 复审 COMPLETE、上一轮条目 CLOSED 且未被重新标出 → Final；Gate 规则 INFO；`/style-audit` API 可见。
- 新建论文（idea_to_paper，默认请求）：review.run 默认产出风格覆盖账本。

### 4.4 全量回归
| 项 | 结果 |
|---|---|
| 后端 `vitest run --maxWorkers=4` | 444 文件 / **4894 passed**、47 skipped、0 failed（第一次全量 4 例失败均已定位：3 例为测试对「调用数 / stage 列表 / review 前缀」的假设需随新功能更新（thesisConvergence 预算按轮扣除风格调用、thesis.e2e 排除 `review/style/*`、topicSurvey stage 列表），1 例 `zaiApiChannel` 并行负载下 5s 超时、隔离复跑通过——历史 flaky） |
| 后端 typecheck / build | 通过 |
| 前端 `vitest run` | 43 文件 / **392 passed** |
| 前端 typecheck | 通过 |
| `git diff --check` | 通过 |
| Playwright `academic-style-audit.spec.ts`（scripted 栈，隔离端口） | **passed**（截图 `D:\PaperTeamData\M17_1\m17-1-style-card.png`）；同时跑 `latex-import-improvement.spec.ts` passed；`smoke.spec.ts` 1-3 失败——断言页面标题「论文项目」，而该页 2026-10-09（6cfdcd7）起已改名「我的项目」，与本次改动无关的既有断言漂移 |
| GitHub CI（1c13932） | **success** |
| Linux Integration（1c13932） | **success** |

科学硬门不回归：既有 gate / fact / citation / EditContract / target_audit / M15 / M16 冻结用例全部在上述全量中通过；`styleInvariants.ts`、style_polish 通道、Publication Target 策略与阈值未改。

## 5. 真实论文验收协议（先冻结后调用）

协议文件 `D:\PaperTeamData\M17_1\PROTOCOL.md`（调用前写入）。要点：
- 样本：作者本人 MOT 论文投稿候选稿（本机研究使用，原文 / 产物不入仓库）sourceSha256 `694929ef…764faf`；预先固定的中文节选（摘要、引言、实验结果两小节、讨论含局限、结论；正文约 14.9k 字符）zipSha256 `feff8242…07394f`；预先登记 32 句必要限定 / 负结果句（`protected_sentences.json`，sha256 `1730d65a…67437`）。此样本未用于任何 prompt / 规则开发。
- 臂：A = 773f78f 固定构建（`git archive` 导出，仓库外构建）；B = 1c13932。两臂同模型 `zai-coding-cn/glm-5.3`（产品现有设置）、同一 HTTP 产品入口（与 UI 相同请求：`import-paper` latex/improvement → `workflows` kind=existing_paper_improvement、stylePolicy=suggest_only）、HITL 按产品默认选项自动推进、检索 / 元数据联网关闭。
- 预算：全局硬上限 120 次（产品自带全局账本拦截）；A 单 run 45、B 单 run 65；失败不重试超过 1 次；不在同一样本上调参后重跑。

## 6. 真实模型结果（只陈述实际发生的；原始证据 `D:\PaperTeamData\M17_1\`）

### 6.1 执行记录
| 项 | A（773f78f） | B（1c13932） |
|---|---|---|
| 目录 | `runs/A` | `runs/B2`（重跑）；首次尝试 `runs/B` 在 review.run r1 中途被 Claude Code **低内存回收**停止，无产物，原样保留 |
| 重跑前检查 | — | 可用内存 10.6/31.6 GB；实验端口无残留服务；其余 node 进程与本实验无关，未终止 |
| 模型 | zai-coding-cn/glm-5.3 | 同 |
| 调用数 | 37 | 59（≤ 单 run 上限 65），其中风格审查 12 + 语义复核 1 = **13**；另因风格修订触发 1 轮复审（r3） |
| tokens（输入 / 输出） | 232k / 74k | 305k / 89k（风格调用 34k / 10k，约 11%） |
| 墙钟 | 18 分钟 | 19 分钟 |
| 终态 | failed：`revision.revise` 两次返回整文档骨架（`main.tex`） | failed：同一位置同一错误（在风格修订与复审之后） |
| 全局账本 | 本轮共 106 次（A 37 + B 首次 8 + B 重跑 59 + 新稿触发 2），上限 120，未越界 |

两臂路径：import → understand → target → citation.verify → review.run r1 → research / evidence → plan.improvement → revision.apply → validate → citation.verify → review.run r2 → quality.gate（FAIL：真实的 7 critical / 17–21 major 学术与事实意见）→ Draft 链。B 在 Draft 链先执行 `revision.style_audit_apply` → citation.verify → review.run r3 → quality.gate → build.draft → revision.revise（失败）；A 直接 build.draft → revision.revise（失败）。

### 6.2 审查覆盖与发现
- **A（基线）**：没有风格审查通道；学术单元审稿中的 style 类意见每轮 8 条（两轮内容重复），全部是排版 / 可读性问题（`0.669~帧/秒` 波浪号、长段落嵌套、表格「—」未说明、加粗规则、结论句过长），**没有一条指向防御性表达**；没有任何风格自动修改。
- **B**：风格审查三轮全部 COMPLETE——r1 8/8 单元新执行；r2 3 个改动单元重审、5 个复用；r3 1 个重审、7 个复用（标题单元 2 个 NOT_APPLICABLE，原因可见）。发现数 r1 13 / r2 19 / r3 19；机器处置 r2：可自动 4 / 保留 12 / 交作者 3。保留项都是真实的必要限定或负结果，例如「每个场景只有 8–12 个片段…片段级方向计数…」「这是…探索性观察，不是…因果规律」「与阈值匹配的强外部基线相比，修正栈不具稳健的身份优势，HOTA…均低于…BoT-SORT」「本文不声称…」。交作者的 3 条中有 2 条是**模型自己发现的 overclaim 风险**（「结果是决定性的」「…证明管线一致」），系统没有自动改。另有 1 条模型改写想删掉括号里的样本来源计数，被确定性预检拦截，改为交作者决定。
- B 学术单元审稿中模型把 6 / 5 / 6 条 style 意见标为 major，聚合层均按 minor 计（`modelSeverity` 留痕）；Gate `academic_style_audit_reported`=INFO（r2、r3），未进入 blocking / critical-major 判定。

### 6.3 B 的自动定点修订（全部为 `sections/introduction.tex`，均通过锚内守卫、编辑契约、强度 / 翻转检测，语义复核 1 次调用判 EQUIVALENT）
| # | 原句 → 改后 | 执行代理初筛（待作者人工评价） |
|---|---|---|
| 1 | 「…实测（0.669~帧/秒，**如实报告为**非实时）」→「…（0.669~帧/秒，非实时）」 | 合理：删自证用语，「非实时」这一负面结论与数值保留 |
| 2 | 「本文以 12 臂×3 种子的预注册消融**如实报告了其**未通过主假设检验的结论。」→「…预注册消融**检验了轨迹稳定性正则**，其未通过主假设检验。」 | 负结果保留；但新句与同句前半「对…轨迹稳定性正则，」**主语重复**，措辞变差——**失败案例**（r3 复审已重新标出该句为不自然表达） |
| 3 | 「这也是本文的出发点。」→ 删除 | 信息已在前文括号中，但删除后前一句以「…未做同等的事件级量化），」结尾、直接换段——**句末残留逗号，失败案例**（导出人工评审材料时发现，修正了首版「可接受」的判断；锚内守卫不检查标点衔接） |
| 4 | 「…也可能在**机制自伤**时仍以正面措辞掩盖」→「…在**改进本身反而损害机制**时…」 | 命题未变，但「机制自伤」是全文统一术语（另处「整体指标掩盖机制自伤」）——**术语不一致，失败案例**；r3 复审将改写句再次标出（closure `reflagged: true`） |

复评（确定性）：4 条均 CLOSED（原句已不在、改写在位）；其中 1 条被重新标出。按「每 run 至多一次」上界，系统没有再自动改，而是交给作者。

### 6.4 安全核对（零模型，`scripts/analyze.mjs`）
- 32 句预登记必要限定 / 负结果句：A 32/32 逐字保留；B 30/32 逐字保留。缺的 2 句**正是上表 #1、#4 的风格改写**：句中的限定标记（「非实时」「无法排除…」）都还在，只是句子文本不再逐字一致。没有任何必要限定或负结果信息被删除。
- 数值 / 引用：风格修订没有引入任何数值、引用或比较方向变化（四条均在锚内，契约硬冻结）。两臂各有一处由**质量修订**（既有 Writer 通道）引起的数值 token 变化：A 在 `discussion.tex` 新增 `1`；B 在 `results.tex` 表题补充加粗规则，新增 `0/10/19`，与表中「10 帧 / 19 帧」输出延迟列一致。两处都不属于风格链路，记录在案。
- 新增强断言 / 因果 / 泛化：风格链路 0 处。
- 风格链路质量（执行代理判断，待人工复核）：4 处中 3 处有问题（#2 主语重复、#3 残留逗号、#4 术语不一致），0 处纯属无意义改动。逐条人工评审材料：`D:\PaperTeamData\M17_1\B2_HUMAN_REVIEW.md`。

### 6.5 `main.tex` 骨架问题（历史缺陷，本轮不修）
- 根因：多文件 LaTeX 导入项目（无大纲）中，归到含正文（摘要）的根 `main.tex` 的意见，会经 `listRevisionTargets`「指令引用现有文件 → 追加」分支（`backend/src/workflow/definitions.ts` `listRevisionTargets`）成为**没有 logicalSpan 的整文件伪目标**；而整文件修订只对单文件项目开启（`isWholeFileTarget = singleFile && …`）。于是 Writer 拿到含导言区的完整文件、却被要求只返回正文片段，模型返回完整骨架，被骨架守卫拒绝。stage 两次失败后 run 失败。773f78f 起即如此，与 M17.1 无关。
- 对 B 的影响：不阻断风格证据——Draft 链上风格修订与复审排在 `build.draft → revision.revise` 之前。修它会改变两臂可比性，且需要放宽或改造目标选择逻辑，不在 M17.1 范围；建议单独立项（方向：组装根正文按 `rootBodySpans` 投影为 span 目标，而不是整文件伪目标），不放宽骨架守卫。

### 6.6 新建论文路径触发（PARTIAL）
`scripts/newpaper.mjs`：用 PaperTeam 自产中文综述（M13 Final Closure，p-47370dc6a0f0）的引言 / 结论首单元，直调与 review.run 相同的 `runAcademicStyleAudit` + `ReviewerService.auditUnitStyle`（同模型）。2 次调用，均成功（6.9 s / 11.8 s），覆盖 COMPLETE。3 条发现：「…初步迹象」被标为必要限定 → 保留；「…可能构成后续研究值得关注的方向」→ UNCERTAIN，交作者；「最后需要集中说明本文的局限」→「本文的局限为：」→ 可自动修订（本触发未执行修订）。**这是生产函数直调的触发 smoke，不是 idea_to_paper 产品入口的完整闭环**；新建论文的默认触发在产品路径上只有 §4.3 的测试模拟证据。

### 6.7 人工评价
`HUMAN_REVIEW_PENDING`。请作者对 §6.3 的 4 处改写和 §6.2 的保留 / 交作者条目打分（可在 Review 页「学术风格与防御性表达」卡查看 before/after；B 项目位于 `runs/B2/projects`）。

## 7. 三类证据分界
- 测试模拟（scripted / 人工构造）：§4 全部。
- 生产路径 + 真实模型：§6.1–6.4（A、B 两臂；均在同一历史缺陷处失败，非完整闭环）；§6.6 为生产函数直调。
- 模型 / 执行代理判断：B 的发现与改写是真实模型输出；「合理 / 失败案例 / 无谓改写」等判定是 Claude 的初筛，不是独立人工评价。

## 8. 下一组独立验证样本（v1 协议待作者核对，未执行；`D:\PaperTeamData\M17_1\M17_1B_PROTOCOL_v1.md`）
零模型扫描（`scripts/scan_candidates.mjs`，确定性候选 / 万字正文；扫描粗糙，0 ≠ 无防御写作）：MOT 投稿全文 0.3、MOT R2 初稿 1.0、硕士论文 T1 七章 0.7、BCI-v2 中文稿 0、**PaperTeam 自产综述 10.4**（「需要指出的是 + 证据范围限定」句型，能同时检验「删样板、留限定」）。第三方 CNKI 语料中「在一定程度上…提升了…」类贡献弱化很常见（本地索引 24 页命中），但属版权作品，只能本机研究使用，改写实验需你确认边界。草案协议 `D:\PaperTeamData\M17_1\NEXT_SAMPLE_PROTOCOL_DRAFT.md`：主样本 PaperTeam 综述（outline 组装稿，不触发 §6.5 路径），可比基线 A 具备（773f78f 构建可复用），建议总上限 100 次、独立账本，新增「术语一致性」核对项。**不使用人工 fixture 充当真实证据，不改动 M17.1 冻结样本。**

## 9. 未完成项与 M17.2 输入
1. 作者人工评价（§6.7）。
2. 新样本协议的授权与冻结（§8），之后才能判定改善效果。
3. 已暴露的机制改进候选（不在本轮实施）：守卫加入术语一致性（被改写的词若在全文其他位置作为术语出现则拒绝或交作者）、删除后的标点衔接检查、改写后句内重复检测。
4. 历史缺陷 `main.tex` 根正文整文件伪目标（§6.5），单独立项。
5. 既有 E2E 漂移：`e2e/tests/smoke.spec.ts` 标题断言「论文项目」。
M17.2（实验数据导入）不依赖本阶段效果结论即可开始；默认自动修订的类别白名单与上限是否调整，待 1–3 完成后决定。

## 10. M17.1.1：B2 修订缺陷修复（`7b65518`）与 M17.1b 准备状态

### 10.1 根因与分类
| B2 修改 | 现象 | 根因 | 检查类型 |
|---|---|---|---|
| 2 | 删除「这也是本文的出发点。」后句子停在「，」上 | 锚点是逗号后的分句并带走句号；锚内守卫只比较原句 / 改写，看不到拼接边界 | 确定性：拼接边界标点 |
| 1 | 「机制自伤」被展开改写，全文术语不一致 | 审查只看引言单元，语义复核只看一个段落；没有任何检查看全稿 | 确定性：被替换片段在全稿其他位置出现 → 视为可能的术语，不自动改 |
| 4 | 改写补出的主语与同句锚外重复 | 锚点从句中「本文以…」开始；只有「扩写 ≤ 10%」的长度约束 | 确定性：同句重复；语义：通顺度 |
| 共性 | 改后句子不通顺 | 语义复核只判命题等价，从未看到拼接后的整句 | 语义：复核改看改前 / 改后整句，新增独立的 fluency 判定（只可否决） |

### 10.2 修改（`7b65518c33308c4aecdbddddbf3466f830d5a2ec`；Fact / Citation / EditContract 守卫与 `styleInvariants.ts` 未改）
- `checkStyleSplice`（`backend/src/review/academicStyleAudit.ts`）：`dangling_punctuation`（前文停在，、；：上）、`double_punctuation`、`terminal_punctuation_lost`、`term_replaced`（被替换的非对冲、非样板片段在全稿其他位置出现）、`duplicate_in_sentence`（新增的 4 字片段已在同句锚外出现）。差分会合并间隔 ≤ 2 字的改动块。
- 机器分级预检（单元文本）与 `prepareStyleRevisions`（目标文件 + 全稿语料，由 `revision.style_audit_apply` 传入）各运行一次。
- 语义复核条目新增 `sentenceBefore` / `sentenceAfter`；输出新增 `fluency`（FLUENT / AWKWARD / UNSURE）。只有 `verdict=EQUIVALENT` 且 `fluency=FLUENT` 才落盘；缺失按 UNSURE 处理，保持原文、交作者。
- 测试：`backend/test/review/academicStyleSplice.test.ts` 10 条定向回归（人工构造，话题与 B2 无关，每类配一条合法修改的负控制）。后端全量 445 文件 / **4904 passed / 0 failed**；typecheck 通过。

### 10.3 B2 真实修改的零模型重放（`D:\PaperTeamData\M17_1\b2_replay_m1711.json`）
| 修改 | 7b65518 判定 |
|---|---|
| 1 机制自伤 | 拦下：`term_replaced`（「机制自伤」在全稿其他位置出现 2 次） |
| 2 删句 | 拦下：`dangling_punctuation` |
| 3 删「如实报告为」 | 通过确定性检查；仍需语义复核同时给出 EQUIVALENT 和 FLUENT |
| 4 主语重复 | 拦下：`duplicate_in_sentence`。另有 `term_replaced` **误报**（「如实报告」只是在修改 3 的锚点里也出现），偏保守，记为已知局限，不加样本专用豁免 |

修改 3 的上下文核对：「实测」没有被删除，删去的只有「如实报告为」；测量来源（RDK X3 全链路实测）、数值与「非实时」结论都在同一句中保留。是否削弱了负结果披露的修辞强调，留给作者裁决，暂记「有条件接受」，不计为质量合格样本。逐条人工评审材料：`D:\PaperTeamData\M17_1\B2_HUMAN_REVIEW.md`（评分栏空白，待作者填写）。

### 10.4 M17.1b 协议 v2（`D:\PaperTeamData\M17_1\M17_1B_PROTOCOL_v2.md`；v1 与 M17.1 冻结协议、B2 产物原样保留）
- A 臂 773f78f；B 臂 **7b65518**；函数级 A/B 重放；全局上限 60 次调用。
- 主集改为 **ChinaXiv 中文预印本**（Internet Archive 镜像检索，平台许可为 CC BY / BY-SA / BY-NC-SA / CC0 之一，逐篇核验 PDF 首页）。**排除本机 CNKI 索引**：知网会员协议规定下载文章仅限本人使用、不得传播至第三方，无法确认可以提交给云端模型服务商。
- 12 篇 × P / L / R 三段（约 300 句）。P / L 只是候选层，真实标签全部由作者在模型输出前独立确认；分层报告召回与 R 层漏检；新增「未修改决定正确率」；盲评随机化、隐藏来源，并允许「两者都不应改动」。
- 冻结状态：**未冻结、未产生任何模型输出**。待办：作者批准 v2 → 运行抽样脚本（零模型）→ 候选初标 → 作者逐句确认 → 填写哈希并冻结 → 才运行实验。
