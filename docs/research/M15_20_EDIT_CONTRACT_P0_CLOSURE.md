# M15.20 — P0 授权内核（EditContract）与统一写入守卫

日期：2026-11-01 · 基线：main @ 0ea6463（= origin/main，工作区 clean；开工时 `git fetch` 核对无新提交）
执行：Claude Code（工程执行代理；**PaperTeam 运行时真实模型调用 0 次**，全部验收为零模型回放 / fixture / scripted runtime）
权威审计：`docs/research/M15_QUALITY_GATE_ARCHITECTURE_AND_GOAL_AUDIT.md`（RC1–RC3 / P0-1 / P0-2 的「闭环判定语义」部分）

---

## 0. 结论（先结论后证据）

**`M15_20_P0 = COMPLETE`（附 §8 残余风险；不含 Gate L0–L4 分层等 P1 工作）**

| P0 判定 | 结论 | 主要证据 |
|---|---|---|
| AUTHORITY | **PASS** | 授权只来自结构化契约（系统策略 / 冻结审计禁改 / HTTP 决策通道的真实批准事件）；Planner 文本、理由、「作者已批准」措辞、旧 `fact-authorizations.json` 文本条目在写入授权中全部失效（§3、§5 E1-PLAN / E1-LEGACY） |
| CONTRACT | **PASS** | 审计条目 approve 时冻结 `edit-contract/v1`（锚范围 + 硬禁改 + 绑定批准时目标内容哈希与所见条目哈希）；plan_confirm 批准绑定 planHash + approvalToken；派发前陈旧 / 缺失 / 旧审批 → 不派发；复评回放落盘 diff（§3） |
| SINGLE_GUARD | **PASS** | 所有已枚举的正式写入入口调用同一 `validateCandidateEdit`，并统一经 `guardedRevisionCommit` 提交边界（§2 入口表） |
| FAIL_CLOSED | **PASS** | E1-NUM / SENT / ADVICE / PLAN / APPROVE / PATH / STALE / LEGACY / RACE 全部零模型阻断，正式稿字节不变、不 handled、不 VALIDATED_FIXED（§5） |
| NON_REGRESSION | **PASS（误拒已计数归因）** | 合法正例全部通过；历史 61 个已接受补丁回放：0 个校验器误拒，6 个属**策略收紧**（改动作者冻结基线数值而无结构化批准）——逐条列出（§6） |
| DELIVERY | 见 §7 | 后端 / 前端全量测试、双端 typecheck + build、`git diff --check`；提交并推送 main |

一句话：**「科学上可辩护」与「被授权修改」现在是两个独立判定**——即使 5.402→3.312 有稿内证据，没有作者对该值对的结构化批准且审计禁改存在时，候选不会落盘，复评也不会再说 VALIDATED_FIXED。

---

## 1. 审计六点逐一核实（源码 @0ea6463 + 冻结工件）

| # | 审计假设 | 核实结果 | 证据 |
|---|---|---|---|
| 1 | `forbidden.values` 写入后无人消费 | **证实** | 全仓唯一写点 `TargetAuditRevisionService.ts`（计划生成），后端零读取；前端只展示；`decide` 写入 `ExternalInstructionOrigin` 时丢弃（origin 无该字段） |
| 2 | 同一指令内「建议换数」与「禁改数字」冲突且无优先级 | **证实** | E1 `instructions-after.json` x-620aab7c7d：【审计建议】含 3.312/9.798，【禁止】「不得改变既有数字」；`E1-plan-after-D1.json` proposedDirection 同上 |
| 3 | Planner 计划文本自授权，plan_confirm 后进入台账 | **证实** | `improvement-plan.json` improvement:1 action「把旧值 5.402/6.075 改为 3.312/6.075」+ rationale「【作者已批准】」、`expectedFactChanges: []`；`fact-authorizations.json` 同条 `source: improvement_plan_approved`（`recordImprovementPlanApproval` 原文入账） |
| 4 | 「已批准文本同时出现新旧数值即授权」 | **证实** | `factPreservation.ts valueChangeAuthorized`：遍历 planTexts + improvementTexts，`mentionsValue(before) && mentionsValue(after)` → `plan_value_correction`；strict 模式只清空 planTexts，improvementTexts 保留 |
| 5 | sec01 span 守卫拒绝、摘要路径未经等价守卫落盘 | **证实** | sec01 a0：`REVISION_TARGET_QUOTE_SCOPE_VIOLATION` + `unauthorized_fact_removal`；摘要分支只跑 `findIntroducedNamedReferences` 后整段 `saveOutline` |
| 6 | VALIDATED_FIXED 只证过程 | **证实** | `assessRewriteClosure` 入参类型不含 `forbidden`；checks = lineage / 绑定 / 哈希变化 / 未回退 / 守卫无 false |

**审计未列出、本轮新发现的同类绕过（已一并修复）**：
- 文件级（短章节整文件）与单文件整文件目标：落盘前只有守卫表格与内容塌缩两道守卫，**无事实 / 引用 / 具名实体候选校验**。
- `revision.repair_latex` 多文件分支：Writer 输出**无任何内容守卫**直接写盘。
- 非 span 目标的 Writer 调用保留写工具（`toolPolicy` 未设只读），可经工具直写其它文件，随后被整轮提交。
- 修订快照的提交没有「提交内容 = 已校验内容」的约束（校验与提交之间的竞态窗口）。

## 2. 正式写入入口枚举（P0 覆盖表）

| 入口（stage / 函数） | 触发 | 写入方式 | 本轮之前的守卫 | 本轮：授权校验 | 本轮：提交边界 |
|---|---|---|---|---|---|
| `revision.apply` / `revision.revise` span 目标 | 长章节编辑单元 / 有 targetQuote 的标题 span | 候选 → `writeFileAtomic` | scope + fact + citation + named refs + 结构 + 塌缩 | `validateCandidateEdit`（违规进入既有 ≤2 轮有界修复，修复结果同口径重验） | ✓ |
| 同上，**摘要载体** `outline.abstract` | 目标 = abstract | `saveOutline` | 仅具名实体 | **新增**：契约 + 事实（main.tex 投影）+ 引用 + 执行注记 + 竞态复核；失败保留原摘要、记 rejected 记录 | ✓ |
| 同上，**文件级 / 整文件目标** | 短章节文件、单文件 main.tex | `writeFileAtomic` | 守卫表格 + 塌缩 | **新增**：契约 + 事实 + 引用 + 具名实体 + 执行注记 + 磁盘竞态复核 | ✓ |
| `normalizeManuscriptCitationSyntax`（修订提交前） | 引用语法归一 | `writeFile` | 无 | **新增**：纯表述契约（数值 / 正文 / 引用集合守恒）通过才登记 | ✓ |
| `revision.style_polish` | gate 后作者 apply | `writeFile` / `saveOutline` | style invariants | **新增**：纯表述契约（硬冻结、不得新增值 / 引用）；失败 = all-or-nothing 不应用 | ✓ |
| `revision.repair_latex`（单文件单元 / 多文件整文件） | 编译失败 | `writeFile` | 单元分支有 scoped 守卫；**多文件分支无** | **新增**：纯表述契约；越权修复不落盘（`editContractRejected` 记入 stage 结果） | ✓ |
| `revision.restore_facts` | 累计漂移确定性恢复 | `writeFile` | 确定性 | **新增**：恢复契约（只允许回到冻结基线值） | ✓ |
| Writer 工具直写（非 span 目标） | 模型行为 | 任意文件 | 无 | 摘要 / 章节目标改为只读工具；整文件目标保留磁盘回退但结果走同一校验 | 未登记改动在提交前恢复 |
| `writeMainTex` / `syncReferencesBib` | 修订内 | 由已校验大纲 / 引用确定性派生 | — | 派生物（有大纲时 main.tex 不独立登记；任何恢复后按大纲重新组装） | — |
| **范围外（如实列出）**：`outline.plan` / `writing.sections` 新草稿生成、`import.*` 基线导入、用户 `revision.restore`、`review.snapshot` | 非「对既有稿件的修改」或用户自身操作 | — | — | 不适用（见 §8 R3） | — |

提交边界 `guardedRevisionCommit`（`backend/src/workflow/editContractEnforcement.ts`）：以 **stage 开始时的工作区**为基准（不回退 stage 之前已存在的用户编辑），stage 期间产生、且未登记为「已通过契约校验的写入」的 .tex / 摘要改动恢复为 stage 开始时内容并记 `unvalidated_write_reverted` 事件；随后以工作树指纹提交，`RevisionStore.commit(expectedFingerprint)` 在串行队列内比对，校验后被改动 → `EDIT_CONTRACT_STALE`（`EDIT_CONTRACT_RACE`）拒绝、不产生修订。

## 3. 设计：EditContract 与信任边界

**模块**：`backend/src/quality/editContract.ts`（纯函数）· `editContractStore.ts`（`research/edit-contracts.json`：contracts / approvals / events；损坏即抛错 fail closed）· `backend/src/workflow/editContractEnforcement.ts`（装载、plan_confirm、提交边界）。

**`edit-contract/v1` 字段**：`contractId`（内容哈希）、`source{kind, ref, instructionId, planItemId, planHash}`、`authority[]{kind: system_policy | frozen_protocol | user_approval | synthetic_test_actor, ref, actor, channel, at, boundContentHash}`、`target{carrier, file, baseRevision, baseHash}`、`scope{mode: anchors | whole_target, anchors[{text, textHash}], allowedOps}`、`constraints{numericProtect: all_existing | listed, protectedValues, allowNewValues, hardNumericFreeze, citationPolicy, protectedCitationKeys, unenforceable[]}`、`allowedValueChanges[{before, after, approvalId}]`、`conflicts[]`、`status`、`contentHash`。

**契约来源与优先级**（多契约叠加只能收窄：锚契约存在时整目标契约不扩大范围；约束取最严；`hardNumericFreeze` 存在时任何值对批准不生效）：

| 来源 | 何时生成 | 范围 | 数值约束 | 值变更授权 |
|---|---|---|---|---|
| 审计改写（`target_audit_rewrite`） | 作者在审计计划 `decide` approve（HTTP 通道 actor=author；请求体不能声明主体） | 目标锚（逐字回放） | **硬冻结**：全部既有值逐个原位守恒、不得新增；引用不得增删 | 无（冻结协议） |
| 改进计划条目（`improvement_plan_item`） | `hitl.plan_confirm` approve | targetQuote 或整目标 | 冻结基线值受保护 | **只有**请求体 `approvedFactChanges` 中逐字对应该条结构化 `expectedFactChanges`、且作者逐项勾选的值对 |
| 系统修订底线（`system_revision_policy`） | 每次修订写入现场生成 | 整目标（编辑区间由 span / 单元机制限定） | 冻结基线（最早修订）中的值不可改 / 删（多重集守恒）；后续修订引入的值可修正 | 无 |
| 润色 / 编译修复 / 引用语法归一 | 现场生成 | 整目标 | 硬冻结、不得新增 | 无 |
| 事实恢复 | 现场生成 | 整目标 | 只允许回到冻结基线值 | 无 |

**冲突**：审计建议方向含锚外数值 → `advice_conflicts_with_numeric_freeze`，`resolution=constraint_wins`（契约不扩大，指令文本与 UI 显示「约束优先级」）；plan_confirm 试图对审计硬禁改条目勾选值对 → 409 `EDIT_CONTRACT_VIOLATION`；不可结构化的限制 → `unenforceable` → `EDIT_CONTRACT_UNENFORCEABLE_CONSTRAINT`（暂停修改，不假装已执行）。

**数值 token 化边界**：NFKC、`\%`≡`%`、紧贴数字且前方为空白 / 括号 / 运算符时的 Unicode 负号、`a\times10^{b}`≡`aeb`、千分位、小数末尾 0（与既有 `normalizeNumericToken` 同口径）；`\cite / \ref / \label / 尺寸` 参数中的数字不计；含数字标识符（MOT17 / YOLOv8）不受数值约束（具名实体守卫负责）。顺序守恒只在锚范围 / 硬冻结契约下要求，整目标软策略按多重集守恒。

**旧授权兼容**：`fact-authorizations.json` 继续追加与读取（Quality Gate pairwise / cumulative 口径不变、历史产物只读兼容），但**候选级数值授权**（改 / 删 / 增）只认契约存储中的结构化批准值对（`valueAuthorizationTrustedOnly`）；公式 / 方向 / 弱化等非数值通道语义不变。旧审计审批（指令无 `contractId`）→ 派发前标 `EDIT_CONTRACT_REAPPROVAL_REQUIRED`、不派发；在审计计划中对同条再次 approve 即为原指令补冻结契约（不新增重复指令）。旧项目只读查看 / Review 不受影响。

**复评**：`assessRewriteClosure` 新增 `editContract` 输入与 `checks.editContract`；缺证据 = NOT_EVALUATED（绝不默认满足）；VIOLATED → STILL_OPEN（`EDIT_CONTRACT_VIOLATION[...]`）。`reassess` 对 lineage 修订快照做确定性回放（快照哈希须与 lineage 前后哈希一致；否则退回校验期 accepted 事件 appliedHash 精确匹配）；旧审批无契约时由计划条目结构化字段重建契约**只用于判定**，不授权写入。

**UI / API**：plan_confirm 面板新增「本次批准的授权范围」：每条可执行条目的可写范围、受保护数值数量与样本、关联审计硬禁改、计划文本暗含改数的确定性告警、结构化值变更逐项勾选；存在告警 / 不可执行条目时须勾选知悉才能批准；批准请求体携带 `planHash + approvalToken + approvedFactChanges`。服务端独立复核（伪造 / 计划外值对、旧计划哈希、旧令牌、审计硬禁改 → 409），不依赖前端展示。`approvalToken = sha256(runId | hitl.plan_confirm | planHash)` 是**完整性绑定**而非认证密钥（§8 R1）。审计复评面板显示「编辑契约 ✓/✗」与越权说明。

## 4. 测试与回放资产

| 资产 | 内容 |
|---|---|
| `backend/test/quality/editContract.test.ts`（19） | token 化边界、E1 负例与合法正例（派生夹具） |
| `backend/test/fixtures/editContract/e1-derived.ts` | 根据 M15.19 E1 冻结工件派生的最小等价夹具（非目标句为合成英文，不复制论文正文；working copy sha256 e625701a…） |
| `backend/test/workflow/editContractWorkflow.test.ts`（10） | 真实 HTTP + orchestrator + scripted runtime：E1 全矩阵 + 合法正例 |
| `backend/test/workflow/editContractCommit.test.ts`（4） | 提交边界恢复未校验写入 / stage 前编辑不回退 / E1-RACE |
| `backend/test/workflow/revisionFidelity.test.ts`（+2） | 单文件整文件目标：无批准改数被拒 / 局部语法修正落盘 |
| `scripts/m1520/replay-edit-contract.mjs` | 真实冻结工件只读回放（A：E1 摘要；B：E1 sec01 候选；C：5 个历史项目 61 个已接受补丁）→ `D:\PaperTeamData\M15\M15_20_EditContractP0\replay-e1.json` |

真实回放输入（只读，sha256）：`M15_19/e1/E1-plan-after-D1.json` cc7f1189… · `e2e-stack/p-b6a2677fdf05/manuscript/revisions/rev-1/outline.json` 0a4c715b… · `rev-2/outline.json` 7ec80724… · `e1/instructions-after.json` 8510c8ad… · `reviews/patch-candidates/rev-2/patch_bcdecdd3594c.a0.json` ad26aebb… · `research/improvement-plan.json` c7d2b044… · `research/fact-authorizations.json` 1b782630…。回放后对 M15.19 `MANIFEST.json` 复核 1397 个文件：1396 一致；`e1/vite.log` 不一致——原因是 M15.19 会话遗留的 vite 开发服务仍在运行并把本轮前端编辑的 HMR 日志追加进该文件（本轮工具未写该目录；进程未擅自终止，见 §8 R5）。

## 5. E1 验收矩阵（零模型）

| ID | 场景 | 结果 | 证据（测试 / 回放）与错误码 | 正式稿 |
|---|---|---|---|---|
| E1-NUM | 审计禁改下 5.402→3.312、11.549→9.798 | **PASS（拒绝）** | 真实落盘 diff 回放：`PROTECTED_VALUE_CHANGED` + `NEW_VALUE` + `OUT_OF_SCOPE`；工作流隔离用例 `PROTECTED_VALUE_CHANGED/NEW_VALUE` | 摘要字节不变；main.tex 仍含 5.402/6.075 |
| E1-SENT | 只限定目标句，额外删两句 | **PASS（拒绝）** | 工作流隔离用例 `OUT_OF_SCOPE`（指出「components are intentionally simple」「validate reliability…」两句） | 不变 |
| E1-ADVICE | 「建议换数」与「禁改」冲突 | **PASS** | 契约 `conflicts=[advice_conflicts_with_numeric_freeze]`、`constraint_wins`、允许值对为空；指令 / plan_confirm 显示约束优先级 | — |
| E1-PLAN | Planner 自称已批准 + 文本点名旧→新 | **PASS** | 计划文本不产生值对；plan_confirm 显示 `unstructuredValueChangeWarning`；候选级数值授权只认结构化批准 | 不变 |
| E1-APPROVE | 普通批准不解除禁改；结构化勾选也不能解除审计硬禁改 | **PASS** | 普通批准后仍拒；勾选 5.402→3.312 → 409；计划外伪造值对 → 409；旧 planHash → 409 | 不变 |
| E1-PATH | 摘要 / sec01（文件级）/ 单文件整文件 / span / 普通返修 | **PASS** | 摘要 `OUT_OF_SCOPE…`；sec01 文件级 `TARGET_MISMATCH`（真实 a0 候选回放同码）；整文件 `PROTECTED_VALUE_CHANGED`；span（revisionFidelity 修复环与审计 span 用例）；普通返修系统策略 | 各入口均不变 |
| E1-STALE | 批准后目标变化 / 旧计划 / 旧候选 | **PASS** | 契约绑定 baseHash → `EDIT_CONTRACT_STALE` 不派发；plan_confirm 旧哈希 409；审计决策 409 语义沿用 `TARGET_AUDIT_STALE` | 不变 |
| E1-LEGACY | 旧审批无契约 / 旧台账文本 | **PASS** | `EDIT_CONTRACT_REAPPROVAL_REQUIRED`、不派发；复评用重建契约判 STILL_OPEN；重新批准补契约 | 不变 |
| E1-RACE | 校验后提交前工作树变化 | **PASS** | `EDIT_CONTRACT_STALE`（`EDIT_CONTRACT_RACE`），修订号不前进；摘要 / 文件级写入前磁盘复核；提交边界恢复「登记后又被改写」的内容 | 不变 |
| 复评 | E1 真实历史 lineage 重放 | **STILL_OPEN**（原为 VALIDATED_FIXED×2） | `replay-e1.json` closureReplay；不提供契约证据时为 NOT_EVALUATED | — |

**合法正例**：锚内加限定语、数值全保留（真实 E1 摘要派生 + 工作流）→ 落盘、handled、复评 **VALIDATED_FIXED（editContract SATISFIED）**；作者结构化勾选的值对 → 精确放行、其它值仍受保护；拼写 / 语法 / 局部结构修改 → 通过；既有 M15.17 / M15.18 审计正向闭环（`targetAuditRevisionWorkflow`、`targetAuditDispatchLineage`）通过；`revisionFidelity` 44 / 44。

## 6. 非回归：历史已接受补丁回放（误拒计数与归因）

| 项目 | 当时已接受 | 现契约拒绝 | 归因 |
|---|---|---|---|
| M15.17 p-a8486551421a | 15 | 2 | 改冻结基线数值，授权仅来自 Planner 文本（`value_change_authorized_only_by_planner_text`） |
| M15.18 p-724f527d6766 | 2 | 0 | — |
| M15.19-DEV p-724f527d6766 | 2 | 0 | — |
| MOT R5.1 p-e6770bf79fed | 25 | 3 | 1 × Planner 文本；2 × 审稿驱动的结果段重写删改作者数值（849111b47ad8.a0 删 10/11/0/0.0225；c40f2be212f5.a1 改 45/102），计划文本未点名、无结构化批准 |
| MOT RevisionRecovery p-e3f03d95a00d | 17 | 1 | Planner 文本（即 M14.8.1 经 HITL 批准计划文本的「20--80 帧」删除） |
| **合计** | **61** | **6** | **校验器误拒 0**；6 例均为 P0 有意的策略收紧：改动 / 删除作者冻结基线数值而无结构化批准 |

修复过程中发现并纠正的**校验器误拒**（已消除，不计入上表）：①整目标软策略下合法重组改变数字先后（4 例 VALUE_ORDER_CHANGED）→ 软策略改为多重集守恒；②0.25→0.250 格式性改写 → 与既有事实守卫同口径归一；③含数字标识符（MOT17）被当数值 → 只交给具名实体守卫；④未改动候选因契约目标不符被报违规 → 未改动写入恒不违规。

既有测试因语义收紧而**更新断言**（如实列出）：`externalInstructionLineage` / `atomicSubGaps`（VALIDATED_FIXED 需契约证据；修订链改为真实前后快照）；`factPreservationGate` / `citationPreservationGate` / `faultInjection` Experiment 2（篡改候选现于写入前被拒，不再「落盘后由 gate 检出」；断言改为正式稿无篡改 + 拒绝记录 + gate 不放行）；`targetAuditRevisionWorkflow`（脚本 Writer 改为锚内合规改写——默认脚本整节重写越出契约，被确定性拒绝是正确行为）；`targetAuditDispatchLineage`（checks 增 editContract）；`m141aIntegration`（锚取词边界：旧锚切开 "p72"，插入标记后产生游离数字，原先靠 Planner 文本提及该数字放行）；`revisionFidelity`（泄漏段改为由此前修订写入——不在冻结基线；冻结基线数值删除须结构化批准）。

## 7. 工程与发布

| 检查 | 结果 | 日志（仓库外） |
|---|---|---|
| 后端全量 `vitest run` | **4649 passed / 43 skipped / 0 failed**（447 文件） | `D:\PaperTeamData\M15\M15_20_EditContractP0\backend-full-2.log`（首轮 16 失败的逐条归因见 §6，`backend-full-1.log`） |
| 前端全量 `vitest run` | **374 passed**（38 文件） | `frontend-full.log` |
| 双端 `typecheck` / `build` | 通过 | — |
| `git diff --check` | 通过 | — |
| 真实冻结工件回放 | E1 摘要拒绝 / 复评 STILL_OPEN / 合法限定通过；历史 61 已接受补丁 6 例策略收紧、0 例校验器误拒 | `replay-e1.json`（sha256 以最终运行为准，见 MANIFEST.json） |
| Playwright E2E | 未运行（NOT_EVALUATED；UI 改动由组件测试覆盖） | — |
| PaperTeam 运行时真实模型调用 | **0** | — |

Git：直接在 main 上分逻辑块提交并普通推送（无强推、无新分支）；最终 HEAD / origin/main / CI 状态见交付说明。

## 8. 残余风险与 P1 前置条件

- **R1 批准主体认证**：本地产品无用户认证；「HTTP 决策通道 = 作者」是信任假设。`approvalToken` 只防旧审批重放 / 计划变更，不防有本地 HTTP 访问能力的进程伪造批准。若运行时 Agent 具备访问本机 API 的工具，这是剩余的越权面（本轮未审计 Pi 工具沙箱）。
- **R2 软策略的边界**：整目标系统策略按多重集守恒——同一编辑单元内把数字从一句移到另一句不被授权层识别（事实 / 方向守卫仍在）；含数字标识符的改名由具名实体守卫负责，授权层不拦。
- **R3 范围外写入**：新草稿生成（outline.plan / writing.sections）、导入、用户恢复、`review.snapshot`（会提交 run 外 / 崩溃遗留的工作区改动）不经授权内核。崩溃中途遗留的已校验写入在重试时会因新 stage 未登记而被提交边界回退（只损失工作量，不越权）。
- **R4 策略收紧的产品后果**：审稿驱动的尾段修订（revision.revise）无法删改作者冻结基线数值（无逐项批准入口）；此类修改现只能走 plan_confirm 结构化值对。历史回放 6 / 61 属此类。是否为尾段增加「作者逐项批准」入口属产品决策（P1）。
- **R5 冻结工件**：M15.19 会话遗留 vite 开发服务（端口 5178 系，自 10-31 运行）仍在向 `M15_19/e1/vite.log` 追加日志，建议用户手动停止（本轮未终止非本会话进程）。
- **NOT_EVALUATED**：真实模型在新契约下的改写合规率 / 产出率（需新冻结论文 + 预登记 oracle 的一次真实运行，按审计停止规则，不在本轮）；Playwright E2E 未运行（UI 由组件测试覆盖）。
- **P1 前置条件**：分层 QualityReport（L0–L4）可直接复用 `editContract` 判定作为 L3「任务闭环」的确定性输入；`gate.passed` 不受本轮影响。

