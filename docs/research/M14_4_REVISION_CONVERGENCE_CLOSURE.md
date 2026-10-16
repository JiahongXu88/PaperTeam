# M14.4 — Revision Convergence & Quality Closure（收口报告）

- 日期：2026-10-16
- 基线：`origin/main @ 2dd2766bd5b25cb4069078b8646334b58ca6036e`（M14.3 COMPLETE）
- 开发与验收位置：Windows `D:\Projects\PaperTeam`（本轮全程本地；未连接新加坡服务器）
- 状态：见 §18（最终判定）

---

## 0. 最终状态摘要

M14.3 R3 暴露的四大遗留（修订整节重写、质量劣化不拦截、预算失控、人工恢复 rev-3）在本轮全部以**确定性可验证**的方式修复：

| M14.3 真实故障 | M14.4 修复 | 证据 |
| --- | --- | --- |
| Writer 修订 = 重写完整章节文件（2–5KB 节全部整文件覆写） | thesis 修订默认 span 化：quote 锚点 → 段落窗口；无锚点 → 整 span 合并单元（同一候选守卫环）；文件级裸覆写路径在 thesis 不再存在 | `thesisBoundedRevision.test.ts` 8 例（逐字节断言） |
| 质量逐轮劣化（186→544 issues / 63→54 分）继续跑 | judgeOutcome 补两处劣化误判（重问题净上升、失败规则增长而无改善）；候选级内容塌缩守卫（span + 文件级） | `revisionOutcome`/`revisionConvergence`/`bestRevision` 43 例 + 场景 B 回放 |
| 修订循环不收敛（5 轮人工止损，预算 60 实际 349 调用） | run 级模型预算硬约束（调用数 / token，启动前拦截 + planner 优雅降级）；REGRESSION/CONVERGED 自动停止 | `runBudget.test.ts` + 场景 F 回放（第二轮 review 不再启动） |
| 人工从 rev-3 恢复才能编译 Draft | best-revision 工件（守卫干净 > blocking > critical > 分数带宽）+ build.draft 终局自动恢复（幂等、快照核验） | 场景 B/H 回放（rev-3 自动恢复 + `restoredBestFrom`） |

---

## 1. M14.3 的真实失败现象（复核）

来自 `M14_3_REAL_THESIS_GENERATION_ACCEPTANCE.md`（本轮不连服务器，全部以仓库内报告 + 源码复核）：

- R3（w-67abbcc2a1e6，订阅渠道 zai-coding-cn/glm-5.3）：85 分钟 / **349 次模型调用**（input 1.30M + output 259K tokens）/ 23 节写作 + 10 张继承表格 + **5 轮 review/revision 循环后人工止损**；
- Review Issues 186 → 544，academicScore 63 → 54（逐轮劣化反馈环）；
- 「某些 Writer 修订行为等价于重写完整章节文件」；
- 最终人工恢复 rev-3（写作完成态）后经产品 API 编译 66 页 Draft；
- 三轮累计 452 次调用 vs 建议预算 60。

**可比性提醒（任务 §0）**：R2 的 review coverage 为 83.9%（units 模式 9 个失败单元如实计数），R3 各轮 coverage 未在报告中记录；academicScore 为完成单元的字符加权聚合，单元集随内容变化——跨轮分数**不必然可比**。本轮所有跨轮比较只使用确定性计数（守卫违规 / blocking / critical），分数只作带宽化 tiebreak（§7）。

## 2. Root Cause Audit（源码坐标）

### RC1 — thesis 修订目标为文件级整文件覆写（P0-1 主根因）

派发链（全部在 `backend/src/workflow/definitions.ts`）：

1. `listRevisionTargets`（:11462 起）：有 outline 时每个 section 生成**文件级目标**（`currentLatex` = 整文件，无 `logicalSpan`）。
2. `expandLongFileTargets`（:10855 起）：`size <= maxChars`（默认 9000 字符，`logicalSpan.ts:34`）的目标**原样通过不展开**——M14.1a 的注释明说「≤ maxChars 的目标原样保留（短论文行为零变化）」。R3 的 23 节每节 2–5KB（UTF-8 中文 ≈ 700–1700 字符）**全部低于阈值 → 全部文件级**。
3. writerParams（:2472 起）：`currentLatex: target.currentLatex`（整文件）+ issues；无 `proposalOnly` / `unitContext` / quote 授权。
4. 写回（:2864 `output = result.latex.trim() + "\n"` → :3007 `writeFileAtomic`）：**Writer 输出整体替换章节文件**。

**候选校验缺口**：文件级路径的候选守卫只有 M14.3 继承表格块比对（:2989–3005）；span 分支的完整候选校验环（applyRevisionSpan + 全局 scope + **quote 区间授权** + 结构损伤 + meta 文本 + fact preservation + 具名实体 + citation keys + evidence，:2570–2784）**不覆盖文件级目标**。`revision.plan` 的 targetQuote 投影（M14.1b，:1571）对短文件完全不消费。

**为何 M14.1a 没发现**：M14.1a 的长章节测试全部用 >9000 字符章节（展开路径）；short-paper 行为零变化是当时**有意的设计决定**，thesis 节文件恰好全部落进这个豁免区。

### RC2 — 质量劣化不被判定为回归（P0-2）

`backend/src/review/revisionOutcome.ts` `judgeOutcome`（修复前）：

- REGRESSION 仅当 `newCritical>0 || blockingDelta>0 || (blockingDelta==0 && academicDrop>10)`。R3 学分 63→54 差 9 < 10；critical/blocking 未涨时 **major 大涨也不是回归**。
- CONVERGED 要求 `sameRules`；**failedRuleIds 一变就落 IMPROVED 兜底**。确定性回放实锤（`thesisConvergence.test.ts` 场景 C 首跑）：修订后 `patch_validation_publishable` 首次出现在失败规则集（与非分层 gate.passed 级联），重问题持平 + 规则集变化 → 判 **IMPROVED** → 多烧一整轮（review×3 + revise×1）。
- planSharedTail（:4903 前）只对 `outcome ∈ {CONVERGED, REGRESSION} || convergence === "STALLED"` 停止；`convergence === "REGRESSED"` 不在停止条件（M11.2.3 有意给守卫类回归一轮修复机会——该语义本轮保持）。

### RC3 — 预算未覆盖真实成本形态（P0-3）

- 轮数预算 = `maxRevisionRounds(2)`（`config.ts:346`）+ HITL `revise_more` 手动追加 ≤3（`MAX_MANUAL_REVISION_ROUNDS`，definitions.ts:469）= **恰好 5 轮**，与 R3 的 5 轮一致。
- **不存在任何 run 级模型调用 / token 预算**：`AgentRuntime` 只累计 usage（观测），全仓无 maxModelCalls/tokenBudget；一轮 = N 单元 review（长文档）+ 全文件 Writer 修订 + 每候选 ≤3 次 repair → 349 调用无任何硬约束。
- 驱动器缺陷（`m143RealRun.e2e.test.ts:505`，本轮已修）：`hitl.revision_stalled` 自动回答 `"approve"`——不是合法选项（accept_draft/revise_more/cancel），resume 会 400；不收敛时自动验收无法合法落地，R3 只能人工介入。
- R3 精确的 HITL 应答序列无法在本机复核（运行数据在新加坡服务器，任务明确不连）；上述三个缺口（误判 IMPROVED、revise_more×3、无调用预算）各自独立成立，本轮全部关闭。

### RC4 — 无最佳合法版本概念（P0-4）

- `ManuscriptRevisionStore.restore(projectId, revision)`（RevisionStore.ts:191）与 HTTP `POST /versions/:n/restore`（httpServer.ts:3332）**早已存在**（恢复 = 提交新的不可变修订）；
- 但工作流**从不选择/恢复最佳版本**：gate 判定劣化后继续在劣化版本上修订；iteration-history 有逐轮 scorecard（M11.2.3）却无任何机制把「质量最优轮」绑定回 manuscript——R3 只能人工恢复 rev-3。

## 3. 已复用的机制（零重复开发）

| 机制 | 来源 | 本轮消费方式 |
| --- | --- | --- |
| `RevisionSpan` / `applyRevisionSpan` / `checkGlobalRevisionScope` / `checkRevisionScope`（不可变前后缀 + quote 区间授权） | M14.1a `review/logicalSpan.ts` + `revisionScope.ts` | thesis bounded 直接走同一候选校验环 |
| Finding → targetQuote 投影（`projectFindingTarget`，只认逐字锚点） | M14.1b `review/findingProjection.ts` | thesis 修订派发的锚点来源（未改一行） |
| 候选级 Guard 链（fact 六类 / citation / 结构 / meta / 具名实体）+ bounded repair（≤2） | M11.4 `definitions.ts` 候选环 | thesis bounded 目标进入同一环 |
| `PatchValidationRecord` lineage（patchId/attempt/parent/finalStatus） | M14.1a `review/patchValidation.ts` | rejected 候选诊断保留 |
| iteration-history / scorecard / `judgeOutcome` / `judgeConvergence` | M4.7 + M11.2.3 `revisionOutcome.ts` | 收敛判定修复在其上；best-revision 消费同源 scorecard |
| `ManuscriptRevisionStore.restore` + 恢复意图日志 | M4.8 | build.draft 终局恢复直接调用 |
| ALS trace scope（projectId × runId × stageId） | M10.4.0 `observability/trace.ts` | 预算账本按 run 归因（零业务层改动） |
| testStack / scriptedRuntime / thesis E2E fixture | M14.2/M14.3 | 全部确定性回放测试 |

## 4. 真正修复的缺陷

| # | 缺陷 | 修复 | 坐标 |
| --- | --- | --- | --- |
| 1 | 小于单元上限的章节文件不展开 → 文件级裸覆写 | `expandLongFileTargets` 增 `boundedAll`（thesis）：小文件按**段落块**切单元（`partitionSpanIntoBlockUnits` 新增，#uN 编号 / relocation / merge 语义不变），quote 锚点绑定引文所在段落窗口；大文件维持贪心装箱 | definitions.ts:10855 起；logicalSpan.ts |
| 2 | quote 解析失败会回退整 span（初版实现错误，被测试抓出） | 回退仅限**完全没有锚点**的指令；带锚点但 NOT_FOUND/AMBIGUOUS → unresolved（不猜位置、不悄悄扩大为整节重写） | resolveDirectiveUnit（definitions.ts:10814） |
| 3 | Writer 不知道授权范围 → 合法修复被范围守卫打回 | `authorizedQuotes` 注入 prompt（1q 规则块：授权修改范围 + 逐字校验提示） | WriterService.ts |
| 4 | 摘要式重写（内容塌缩）无守卫 | `revisionContentCollapse`：绝对缩减 >300 字且保留率 <50% → span 候选进 repair 通道（revision_content_loss）；文件级候选 fail-closed 拒绝落盘 + `revision.content_collapse_rejected` 事件 | definitions.ts 候选环 + 文件级路径 |
| 5 | 重问题净上升被判 IMPROVED | 改善信号 = critical/blocking/重问题总数下降或失败规则减少；无改善 + 重问题上升 → REGRESSION；无改善 + 持平且新增失败不全是可修复守卫 → CONVERGED（守卫首现仍交修复轮——既有语义保持） | revisionOutcome.ts judgeOutcome |
| 6 | 无 run 级模型预算 | `RunBudgetLedgerRuntime`（装饰 AgentRuntime）：startAgent **启动前**检查调用数/token，超限抛 `MODEL_BUDGET_EXCEEDED`（permanent，不重试）；账本按 run 落 `research/model-ledger.json`（原子写、重启不重置、每项目 ≤64 run）；planner 在派发 review.run/revision.revise 前查询，耗尽 → overflow HITL / Draft 优雅降级（终态标注 `modelBudgetExhausted`；最后一轮修订未经复审即停的口径如实标注） | runtime/runBudget.ts（新）+ serviceStack 装配 + planSharedTail + config（WORKFLOW_MAX_MODEL_CALLS_PER_RUN / WORKFLOW_MAX_RUN_TOKENS_PER_RUN，0=不限制） |
| 7 | 无最佳合法版本 | `bestRevision.ts`（新，纯函数）：选择键 = 守卫干净 > blocking ↓ > critical ↓ > 分数带宽（10 分带，带内差异 = INCONCLUSIVE 保守保留）；quality.gate 逐轮更新 `reviews/best-revision.json`（同 run 严格更好才替换；新 run 重置基线——跨 run 分数不可比） | bestRevision.ts + reviewArtifacts + quality.gate |
| 8 | 劣化后 Draft 从坏版本构建 | `build.draft`（thesis 分支）前置 `maybeRestoreBestRevision`：当前**可证明劣于**最佳（主键更差且无一更好）→ `restore()` 恢复（新不可变修订，历史不动）→ 快照逐文件核验 → 事件 `revision.best_restored`；stage result / completion summary 带 `restoredBestFrom`；幂等（内容等价不重复恢复） | definitions.ts buildDraftStage |
| 9 | stalled HITL 不知道将被交付哪个版本 | payload 增加 `bestValidRevision`（revision/gateRound/blocking/critical/分数 + 恢复语义说明） | revisionStalledStage |
| 10 | m143 驱动器 stalled 回答非法（approve → 400） | 改答 accept_draft（确定性验收策略） | m143RealRun.e2e.test.ts:505 |

## 5. logicalSpan 修订前后对比（场景 A 确定性回放）

3 段式 thesis 节文件（~560 字，R3 形态），Finding 带 P2 段引文锚点：

| | 修复前（文件级路径） | 修复后（bounded） |
| --- | --- | --- |
| 派发目标 | `sections/ch3-method.tex` 整文件 | `file:sections/ch3-method.tex#u2`（P2 段落窗口） |
| Writer 输入 | 整文件 + issues | 单元全文 + 只读相邻上下文 + **授权范围（1q 块）** |
| Writer 输出语义 | 整文件替换 | 单元替换，引文区间外逐字保持 |
| 候选守卫 | 仅继承表格块比对 | scope + **quote 区间授权** + 结构 + meta + 塌缩 + fact + 实体 + citation + evidence |
| Writer 重写整节时 | **整文件被覆盖（R3 实锤）** | 候选被拒（REVISION_TARGET_QUOTE_SCOPE_VIOLATION），≤2 次 repair 后 fail-closed，原稿逐字节保留 |
| lineage | 无 patch 记录 | `patch:<hash>` 记录 + finalStatus |

逐字节断言（`thesisBoundedRevision.test.ts`）：修改后文件 === 原文仅引文处替换；相邻文件不变；20k+ 章节尾部锚点单元外逐字节保持；多 Finding 各自段落窗口（#u1/#u3）互不吞并；重放不重复应用。

## 6. 候选接受 / 拒绝规则（P0-2）

候选级（确定性，无 LLM；span 候选环 + 文件级新增守卫）：

| 判定 | 条件 | 后果 |
| --- | --- | --- |
| ACCEPT | 全部守卫通过（scope/quote 区间/结构/meta/塌缩/fact/实体/citation/evidence） | applyRevisionSpan 原子应用 + patch 记录 accepted |
| REJECT_GUARD（可修复） | 守卫失败但 scope 类未违反 | ≤2 次 bounded repair（repair prompt 携带 mustPreserve + 违规明细） |
| REJECT（fail-closed） | scope 类违规 / repair 耗尽 / no-progress（同根同提案） | 候选不落盘、原稿保留、failed 记录进 lineage（不污染已接受版本） |
| REJECT（文件级塌缩） | 保留率 <50% 且缩减 >300 字 | `revision.content_collapse_rejected` 事件 + 原稿保留 |
| unresolved | 锚点缺失/歧义/跨章 | 不派发（不猜位置），事件可审计 |

枚举沿用现有 `PatchValidationRecord.finalStatus`（accepted/rejected/exhausted/no_progress）——未新建第二套版本控制；被拒候选的诊断与 lineage 全保留。

## 7. Review 可比性与质量回归判断

- **快照一致性（既有）**：review 审 `reviewedRevision` 快照；gate / revision.plan 消费同轮产物（M4.7 新鲜度规则），本轮未改。
- **跨轮可比纪律（本轮确立）**：best-revision 选择与终局恢复只用**确定性计数**（factViolations + citationViolations == 0、blocking、critical）；academicScore 只按 10 分带宽作末位 tiebreak，**带内差异 = INCONCLUSIVE → 保守保留既有版本**（不追 reviewer 噪声；R2 coverage 83.9% 的口径差异即属此类）。跨 run 不比较（新 run 首轮重置基线）。
- **轮次级回归判定（judgeOutcome 修复后）**：重问题净上升且无规则解决 → REGRESSION（停止）；重问题持平、无改善、新增失败不全是可修复守卫 → CONVERGED（停止）；守卫类新失败（fact/citation/零漂移）仍交一轮确定性修复（既有语义）。
- **不可比较时不假装**：终局恢复要求「可证明更差」（主键更差且无一更好），否则保留当前稿。

## 8. 无进展停止与模型预算（P0-3）

停止条件覆盖（≥ → 机制）：

1. 轮次上限（既有：自动 2 + manual ≤3）；
2. 连续无实质改善 → STALLED/CONVERGED → stalled HITL（既有 + 本轮收紧判定）；
3. 质量恶化 → REGRESSION → stalled HITL（本轮补两处误判）；
4. **模型调用 / token 预算（本轮新增）**：`WORKFLOW_MAX_MODEL_CALLS_PER_RUN` / `WORKFLOW_MAX_RUN_TOKENS_PER_RUN`（0=不限制，缺省）——runtime 启动前硬拦截（并发调用全部计数、不因 settle 时序漏计；在途调用按 Runtime 契约自然 settle）+ planner 优雅降级（overflow HITL → Draft；不再启动新 review/revise/润色）；
5. 候选持续被拒 → bounded repair 耗尽 + no-progress 检测（既有）；
6. 作者决定：stalled/overflow HITL（既有，payload 增最佳版本信息）。

预算真实性（场景 F 回放）：预算恰好覆盖 writing + 第一轮 review + 第一次修订时，**第二轮 review 的 3 次调用全部未启动**（stageHistory 证明），run 以 Draft 终态完成、`modelBudgetExhausted: true` 如实标注、账本 calls ≤ 预算。

停止后的保留（§任务 4.4）：最佳合法版本（best-revision 工件 + 不可变快照）、未解决 Findings（iteration-history / revision plan 状态机）、停止原因（终态 summary + 事件流）、Token/调用统计（model-ledger.json）、可合法交付的 Draft（Build Gate + Fact/Citation Preservation 照常执行）。**提前停止 ≠ Quality Gate PASS**：Draft 终态 qualityStatus 如实（NO_PROGRESS / QUALITY_NOT_REACHED / REVISION_TASK_COMPLETE）。

## 9. 最佳合法版本保留（P0-4）

- 工件：`reviews/best-revision.json`（revision / gateRound / runId / scorecard / basis / updatedAt），quality.gate 每轮更新（幂等落盘）。
- 选择纪律：**不是 academicScore 最高的一轮**——守卫干净优先于一切分数（守卫脏 = 不安全产物），blocking/critical 次之，分数只作带宽 tiebreak；全部相等保留更早版本（少扰动）。
- 恢复（build.draft thesis 分支前置）：当前可证明劣于最佳 → `restore()` → 新不可变修订 → 快照逐文件核验（不一致即 STAGE_CONTRACT_VIOLATION，不在此状态构建）→ assemble/编译/Build Gate/Fact Preservation 全部按恢复后内容执行（**Draft 不因恢复跳过任何检查**）→ `revision.best_restored` 事件 + `restoredBestFrom` 进 stage result 与 completion summary。
- 中断恢复（场景 G）：候选应用后重放——计划条目已 applied 不再派发 / span 内容等价不落新修订（确定性回放证明无重复应用）；恢复操作幂等（内容等价跳过）。
- 事件与历史：恢复不覆盖历史修订、不删除失败候选诊断（patch 工件 append-only 合并——M14.1a 语义）。

## 10. 场景回放矩阵（确定性，任务 §6.2）

| 场景 | 测试 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| A 整节重写 | thesisBoundedRevision ×2 | 合规局部修改只动引文区间（逐字节）；Writer 重写整节 → 候选拒绝 + 原稿逐字节保留 | ✅ |
| B 分数下降 | thesisConvergence 场景 B/H + thesisBoundedRevision 塌缩 | 劣化轮自动停止；塌缩候选拒绝；最佳版本保留 | ✅ |
| C 重复无进展 | thesisConvergence 场景 C | 同型失败 CONVERGED → stalled → accept_draft；不劣于最佳不恢复 | ✅ |
| D 事实污染 | 既有 thesisRevisionGuard E2E（M14.3，未改）+ fact 守卫环回归（全量绿） | 改值候选拒绝、drift gate FAIL | ✅ |
| E 部分改进 | thesisBoundedRevision 多 Finding（成功目标 applied + unresolved 目标不派发如实计数） | 已验证修改保留 + 未完成项准确报告 | ✅ |
| F 预算耗尽 | thesisConvergence 场景 F + runBudget ×2 | 第二轮 review 不启动；优雅 Draft；账本持久、重启不重置；token 预算同账本 | ✅ |
| G 中断恢复 | thesisBoundedRevision 重放 | 不重复应用 / 不丢最佳版本 | ✅ |
| H 合法 Draft | thesisConvergence 场景 B/H | 无进展停止 → 恢复 rev-1 → Build Gate → Draft 注册（`restoredBestFrom: 1`） | ✅ |
| 长章节 | thesisBoundedRevision 25k | 尾部锚点单元外逐字节不变 | ✅ |

## 11. Fact / Citation / Table Guard 回归

- 既有 3607 项后端测试全量回归（§12），含 M14.3 thesisRevisionGuard（继承表格补丁级拒绝）、factPreservation / citationPreservation / drift 全家族、inheritedTableAssets 11 例；
- thesis bounded 候选进入**同一**守卫环（非新实现）：Fact 六类 / Citation 增删 / 结构损伤 / meta / 实体全部适用（场景 A 塌缩用例额外验证新增守卫）；
- 既有四类工作流（idea_to_paper / topic_survey / existing_paper_improvement / existing_paper_review）零行为变化（bounded 仅 thesis 生效；judgeOutcome 收紧对四类工作流同样生效但语义只影响「无改善仍继续」的病态轨迹——其回归全绿）。

## 12. 本地测试结果（Windows 本机）

- 后端全量：见 §18（按最终运行填写）
- 定向新增：thesisBoundedRevision 8 / thesisConvergence 3 / bestRevision 18 / runBudget 2 = 31 例全绿
- typecheck：后端 ✅ / 前端 ✅
- 前端 vitest：见 §18
- build：见 §18

## 13. 真实模型调用量与 Token

见 §18（真实模型 Smoke 结果；预算由驱动器经 RunBudgetLedgerRuntime 硬性执行，上限 6 次）。

## 14. 资源开销

- 本轮开发与测试全部本地；无远程服务器 / GPU / Docker；
- 全量后端测试墙钟约 4.5–12 分钟（取决于并发与机器负载；两次全量运行中 5s 默认超时的用例在并行满载下出现过环境性超时，隔离复跑全部通过——降并发全量运行见 §18）；
- 确定性回放零模型调用；新增机制运行时开销：段落块切分 / best-revision 比较 / 预算账本原子写均为 O(章节规模) 的本地计算。

## 15. 已知限制（如实）

1. **bounded 修订目前限定 thesis_from_papers**：其它工作流维持 M14.1a 尺寸阈值语义（任务 §九「优先将必要的差异限定在学位论文修订路径」）。既有短论文的 <9000 文件仍整文件修订（但其候选现在有塌缩守卫兜底）。
2. **无锚点指令回退整 span 合并单元**（thesis）：编辑范围仍可能覆盖整个 span（如节文件无标题且指令泛指全章）——但候选必须过全部守卫且范围不超出该 span；这是「不猜位置」纪律下能给出的最小确定范围。
3. **预算停止时最后一轮修订未经复审**（预算优先于「再审一轮」）：条目级 revision.validate（确定性）照常执行，终态 `modelBudgetExhausted` 如实标注；作者可提高预算从 checkpoint 恢复。
4. **scorecard 无 coverage 字段**：分数带宽化是当前对 reviewer 波动 / 覆盖口径差异的保守处理；完整 coverage-aware 比较留后续。
5. **跨 run 最佳版本不比较**（新 run 重置基线）：旧 run 的 best 留档不再作为恢复目标——避免跨 run 分数误比；跨 run 续跑（journal 为 run 级）本来就是 M14.3 §20.2 的遗留。
6. **writing journal 仍为 run 级**（M14.3 遗留未动）；R3 的「新 run 全量重写」问题不在本轮范围。
7. estimatedCost 不可靠（订阅渠道 per-call=0）：预算主键为调用数与 token（input+output+cacheWrite；cacheRead 单列不计——重复消费提示而非新成本）。

## 16. 下一阶段建议

1. 案例 B（李谨杰硕士论文）真实验收——本轮机制就绪后按 M14.3 §20.7 随时可跑（驱动器 stalled 已修，预算可经 env 注入）；
2. bounded 修订推广到 existing_paper_improvement（有 quote 的短文件同样走段落窗口——需跨工作流回归校准）；
3. scorecard 增加 coverage 口径字段，best-revision 比较升级为 coverage-aware；
4. 跨 run writing journal 复用（M14.3 §20.2）；
5. PDF→Word 待办保持登记（本轮未动，任务 §十三确认未丢失）。

## 17. Git 交付状态

见 §18（提交链与 CI）。

## 18. 最终判定与实测汇总

### 本地测试（Windows，全程本地）

| 项 | 结果 |
| --- | --- |
| 后端全量（`npx vitest run`，降并发 2 workers） | **3638 passed / 0 failed / 29 skipped（env 门控）**——基线 3607 + 新增 31；另两次满并发全量运行出现的失败全部是 5s 默认超时（含与本次改动无关的 survey/skills 单测），隔离复跑与降并发全量均 0 失败 |
| 新增定向 | thesisBoundedRevision 8 / thesisConvergence 3 / bestRevision 18 / runBudget 2 = **31 全绿** |
| typecheck | 后端 ✅ / 前端 ✅ |
| 前端 vitest | **343 passed / 0 failed** |
| build | 后端 ✅ / 前端 ✅ |
| `git diff --check` | ✅ |

### 真实模型 Smoke（`PAPERTEAM_M144_SMOKE=1`；公司网关 glm/claude-fable-5-1，per-call cost 0）

预算**由驱动器经 RunBudgetLedgerRuntime 硬性执行**（上限 6 次/run；任务纪律「调用上限必须由实际驱动器执行」的直接验证）：

1. 真实 `reviewUnit`（1 次调用）→ 真实 Finding，契约 quote 逐字摘录，`projectFindingTarget` 确定性投影命中（basis=issue_quote）；
2. 真实 Writer bounded 修订（1 次调用）→ **变更区间 9 字符严格落在引文所在段落块内**，引文区间外逐字节保持（公共前后缀 + 段落块边界双断言）；
3. 候选守卫链全过（scope/quote 授权/结构/meta/fact/实体/citation）→ applied，patch lineage 指向 `file:sections/ch3-method.tex#u1`；
4. 确认数值 0.724 / 0.667 与引用 key \cite{ref1}/\cite{ref2} 逐字保留；
5. 预算账本 2/6 次调用落盘。

跨三次 smoke 运行累计真实模型调用 **5 次**（含 1 次真实 reviewer JSON 解析失败的如实尝试；已加一次有界重试），≤ 任务预算 10 次；可计量费用 $0（公司网关），≤ $3 上限。全程未进行整篇五轮 Reviewer/Revision、无大规模 A/B、无 GPU。

### 十八问回答（任务 §十四）

1. **COMPLETE**（边界见 §15，无 Gate 阈值调整、无失败测试省略）。
2. **M14.3 整节重写根因**：`expandLongFileTargets` 只对 >9000 字符文件展开 span；R3 的 23 节（2–5KB）全部低于阈值 → 文件级目标整文件覆写且无候选校验环（§2 RC1，含源码坐标）。
3. **logicalSpan 已保证**：thesis 修订全部 span 化（quote → 段落窗口；无锚点 → 整 span 合并单元；锚点失败 → unresolved 不猜）；真实模型 smoke + 8 例确定性逐字节断言。
4. **范围外逐字节不变**：是——公共前后缀断言 + 相邻文件比较 + 25k 章节单元外逐字节（thesisBoundedRevision ×8）。
5. **质量恶化候选自动拒绝**：候选级（quote 范围守卫 + 内容塌缩守卫，fail-closed）+ 轮次级（REGRESSION 自动停止）双层；被拒候选不污染已接受版本（lineage 保留、原稿保留）。
6. **Reviewer 分数不可比时**：只用确定性计数比较（守卫/违规）；分数按 10 分带宽 tiebreak，带内差异 = INCONCLUSIVE → 保守保留既有最佳；跨 run 不比较。
7. **连续无进展自动停止**：是——CONVERGED/STALLED → stalled HITL（场景 C 回放；判定收紧后规则增长型无改善也停）。
8. **调用/Token 预算可证明硬约束**：是——RunBudgetLedgerRuntime 启动前拦截（MODEL_BUDGET_EXCEEDED，permanent）+ 账本持久（重启不重置，runBudget.test 实证）+ planner 优雅降级（场景 F：第二轮 review 3 次调用全部未启动）。
9. **最佳合法版本自动保留/恢复**：是——best-revision 工件逐轮更新 + build.draft 终局恢复（快照核验 + 幂等）。
10. **人工 rev-3 恢复可避免**：是——场景 B/H 回放：劣化 → 自动停止 → accept_draft → 自动恢复 rev-1 → Build Gate → Draft（restoredBestFrom）。
11. **继承表格与科研事实保持**：是——候选环包含 M14.3 守卫表格比对 + fact 六类守卫；thesisRevisionGuard E2E 与全量回归绿。
12. **旧论文修改工作流正常**：是——bounded 仅 thesis 生效；全量 3638 绿（含 existing_paper 全家族）；judgeOutcome 收紧只影响「无改善仍继续」的病态轨迹（其回归绿）。
13. **实际减少的不必要调用**：①劣化轨迹提前停止（REGRESSION 判定修复：规则增长型无改善从「多烧一整轮」到当轮停止——场景 C 首跑实锤多烧 review×3+revise×1）；②预算耗尽后不再启动整轮 review/修订（场景 F：第二轮 review 3 次 + 后续全链未启动）；③整节重写被拒后不再有「整文件重写 → 更差 → 再修」的恶性循环（每轮 ~N 节 × 全文件重写）。不做无证据的总量宣称。
14. **本地完整测试结果**：见上表（3638/0/29 + 343/0 + typecheck/build 双绿）。
15. **真实模型 Smoke 通过**：是（2/6 次调用内完成全部 6 个验证点；5 次累计含 1 次失败尝试）。
16. **已知劣化机制**：无已知的「继续修订 → 质量下降」未拦截路径；已知边界见 §15（无锚点指令的整 span 编辑范围、预算停止轮未经复审——均如实标注）。
17. **案例 B 准备度**：机制就绪（bounded 修订 + 收敛 + 预算 + 最佳版本 + 驱动器 stalled 修复；`WORKFLOW_MAX_MODEL_CALLS_PER_RUN` 可注入）——可进入下一阶段真实验收。
18. **Git / CI**：见 §17 及下文提交链。

### Git 交付

- 提交链：`4e8ee0e`（feat：bounded 修订 + 收敛修复 + 预算 + 最佳版本 + 31 测试）→ `0ff90ec`（docs：收口报告 + PROJECT_STATUS + API_CONTRACT）→ `bd0bf85`（fix：CI typecheck 的测试 import 修正——本地 tsc 曾在新建测试文件前运行，CI 抓出后修复；后续纪律：新建测试后必须重跑 `npm run typecheck`）。
- 推送：`origin/main` = HEAD = `bd0bf8566a59ba55395509035801d1f8f36152b6`，工作区 clean，`git diff --check` ✅。
- **GitHub CI：双绿**——CI（build + typecheck + backend/frontend 全量测试，ubuntu）`success` 6m31s；Linux Integration `success` 14m25s（run 38873187999 / 38873187674）。首轮 push 的 CI 曾因上述测试 typecheck 失败（1m2s 快速失败），修复后全绿。
- 本轮未连接新加坡服务器；GitHub 自动 CI 不属于服务器开发测试。

**M14.4：COMPLETE。**
