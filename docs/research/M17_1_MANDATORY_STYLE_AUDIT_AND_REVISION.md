# M17.1 默认必检的学术风格 / 过度防御性表达审查 + 受控自动修订 + 真实论文验收

> 日期：2026-11-04 · 执行：Claude Opus（Claude Code）· 仓库 `D:\Projects\PaperTeam` · 分支 `main`
> 起始 SHA：`773f78fb1d0c5aecfbdd61c154d3bee7fe9b76df`（= origin/main，工作区干净）
> 工程提交：`1c13932cd258a5bb2fd678318c8de8b2f75f46cc`（已推送；CI ✅、Linux Integration ✅）
> 本报告提交：见 git log（docs 提交，紧随 1c13932）

## 0. 结论先行

| 判定 | 结果 | 一句话理由 |
|---|---|---|
| `M17_1_ENGINEERING` | **PASS** | 正常产品入口（修改已有论文 / 新建论文的 review.run）默认调用风格审查，单元级覆盖与失败可追踪；风格 issue 在机器侧钳为建议性，不会误杀科学 Gate；定点修订受锚点 + 守卫 + 编辑契约 + 语义否决约束；后端 4894 / 前端 392 测试、typecheck、build、新 Playwright 用例、CI 与 Linux Integration 全部通过 |
| `M17_1_REAL_PAPER_EFFECT` | **PARTIAL** | 真实模型基线 A 臂完整跑完产品路径到失败终态（既有缺陷，见 §6.3）；B 臂在第 1 轮审稿中途被**系统内存回收**停止，B 的真实审查 / 修订数据**没有产出**——A/B 只有一臂；新建论文路径真实调用未执行；人工评价 `HUMAN_REVIEW_PENDING` |
| `M17_1_COMPLETE` | **否** | 工程达标；真实效果未被证明（缺 B 臂与人工评价） |

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

## 6. 真实模型结果（只陈述实际发生的）

### 6.1 调用与成本
全局账本：共 **45 次**调用（A 37 次全部结算；B 8 次，其中 3 次在进程被停止时未结算），输入 252.5k / 输出 81.8k tokens（缓存读 1.09M），账本估算费用约 1.00（账本内部计价单位，非账单）。A 墙钟 18 分钟。

### 6.2 臂 A（基线 773f78f，真实运行）
- 路径：import → understand → target → citation.verify → review.run(r1) → research / evidence → plan.improvement → revision.apply → revision.validate → citation.verify → review.run(r2) → quality.gate → build.draft → **revision.revise 两次尝试均失败**（`INVALID_LATEX_OUTPUT：章节 main.tex 修订返回了完整文档骨架`）→ run failed。
- 风格相关输出：两轮审稿中 style 类意见 16 条（每轮 8 条、两轮内容重复），**全部是排版 / 可读性问题**（`0.669~帧/秒` 波浪号、长段落括号嵌套、表格「—」未说明、加粗规则、结论句过长），**没有一条指向防御性表达**；没有任何风格自动修改（基线缺省 suggest_only）。
- 事实：最终稿相对导入稿，`discussion.tex` 被质量修订改动，新增数值 token `1`（由 Writer 质量修订引入，非风格链路；基线臂行为，记录在案）；32/32 预登记必要限定 / 负结果句保留。
- 确定性候选扫描（M17.1 同一把尺子）：导入稿 0 处对冲堆叠 / 样板 / 模板候选，限定词总数 3——该稿本身几乎没有可去的防御性写作，与协议中「压力测试过度修改」的预期一致。

### 6.3 臂 B（M17.1，未完成）
- 进程在 review.run 第 1 轮单元审稿期间被 **Claude Code 因系统内存严重不足而回收**（服务端与驱动脚本同时被停；不是程序报错）。按规则未自行重启。
- 因此 B 臂**没有**产出风格审查报告、定点修订记录或最终稿；`analysis.json` 中 B 为空。任何关于 M17.1 在真实论文上的效果（防御性表达是否减少、必要限定是否保留、无谓改写率）**均未被真实模型证明**。
- A 臂暴露的 `main.tex` 根正文修订失败是 M17.1 之前就存在的产品缺陷（Writer 对含正文的组装根 main.tex 返回整文档骨架，被骨架守卫拒绝；与风格功能无关，本阶段未修）。B 臂在 Draft 链上会先执行风格定点修订再到达该点，但若重跑仍可能在其后失败——记为风险。

### 6.4 新建论文路径
协议中计划的「PaperTeam 自产中文稿 ≤4 次 `auditUnitStyle` 生产调用」**未执行**（排在 B 臂之后，内存回收后未再启动模型进程）。新建论文默认触发只有 §4.3 的测试模拟证据。

### 6.5 人工评价
`HUMAN_REVIEW_PENDING`。没有独立盲评，也没有用模型自评替代。

## 7. 三类证据分界
- 测试模拟（scripted / 人工构造）：§4 全部。
- 生产路径 + 真实模型：§6.2（A 臂完整）、§6.3（B 臂仅前 8 次调用，无可用产物）。
- 模型判断：A 臂审稿意见的归类（排版 / 可读性 vs 防御性表达）为执行代理阅读后的判断，原文见 `D:\PaperTeamData\M17_1\analysis.json`。

## 8. 未完成项与下一步
1. **重跑 B 臂**（需你确认机器内存允许；同一冻结协议，剩余全局预算 75 次，B 单 run 上限 65）：`D:\PaperTeamData\M17_1\scripts\drive.mjs` + `analyze.mjs`，可直接复用。
2. 新建论文路径的有界真实触发（`scripts/newpaper.mjs`，≤4 次）。
3. 你本人对 B 臂 before/after 的人工评分（Review 页卡片可直接看）。
4. 既有缺陷（非 M17.1）：组装根 main.tex 含正文时 revision.revise 返回整文档骨架 → run failed；建议单独立项。
5. 既有 E2E 漂移：`e2e/tests/smoke.spec.ts` 标题断言「论文项目」。

## 9. M17.2 输入条件
M17.2（实验数据导入 / 语义映射）不依赖本阶段的真实效果结论即可开始；但「风格修订是否在真实长稿上安全有效」须先完成 §8.1–8.3，再决定是否调整默认自动修订上限或类别白名单。
