# M15 长程收敛：Quality Gate 可信性闭环（M15-LONG-RUN-QUALITY-GATE-CLOSURE）

- 日期：2026-11-01 → 11-02 · 执行：Claude（Opus 5.5）· 分支：main（直接提交，普通推送）
- 起点：`793a472d364ee267e8154510e9030f6245e32891`（= origin/main，clean，开工 `git fetch` 无新提交）
- 权威输入：`docs/research/M15_QUALITY_GATE_ARCHITECTURE_AND_GOAL_AUDIT.md`、`docs/research/M15_20_EDIT_CONTRACT_P0_CLOSURE.md`、用户本机 `Downloads\PaperTeam_M15_Quality_Gate_Handover.md`（四问原始目标）
- 仓库外证据：`D:\PaperTeamData\M15\LongRunClosure\`（replay / replay-c / e2e / E / E3-calibration / 全量测试日志）
- 设计契约：`docs/research/M15_QUALITY_REPORT_CONTRACT.md`

> 终局裁决见 §8。

---

## 1. 初始承诺矩阵（开工时建立：原始目标 → 当时能力 → 生产接线 → 差距 → 验收证据）

| 原始目标 | 开工时能力 | 生产接线（开工时） | 本次差距 | 验收证据（本次） |
|---|---|---|---|---|
| Authorization：模型文本不是权限 | EditContract P0 + 结构化 plan_confirm | 生产（P0） | ① Agent 写工具可写 `manuscript/revisions/`（修订快照 = 复评回放证据源）、`revisions.json`、`restore-intent.json`；② 审批面能力边界无确定性回归 | §3 A1 |
| 提交边界 | guardedRevisionCommit（修订 stage） | 生产 | `review.snapshot` 直接 commit 工作区（吸收崩溃遗留 / 未校验 Agent 写入）；commit 复制期 TOCTOU | §3 A2 |
| 数值语义 | 软策略多重集守恒 | 生产 | ③ 数值互换看不见；④ **新发现**：token 化把「11.549 in IDF1」「3 ex」当长度字面量剥离 → 受保护数值静默漏检 | §3 A3 |
| 尾段授权 | 尾段改冻结数值一律拒绝 | 生产 | 无合法出路（R4）| §3 A3 |
| 唯一决策事实源 | `gate.passed` 单布尔 + 9 个结论概念 | 生产 | 无分层报告；L2 模型意见与已证实缺陷同为 FAIL；`academic_non_regression` 让未校准分数承担硬门；旧产物无状态时默认按 passed | §4 B |
| Correctness 生产接线 | 跨节数值 / 作者复算 / 引用元数据在生产；claim 审计作者稿为 shadow | 部分生产 | 跨节一致性输入工件缺失时非必需（移除工件可放行）；shadow 未在报告中标注 | §5 C |
| Revision closure / UI | P0 契约复评；plan_confirm 授权展示 | 生产 | 数值修改无逐项批准 UI；分层结论无呈现；Playwright 未运行 | §6 D |
| Calibration / 外部效度 | 独立人类标签 0；M15.10 双盲包待真人 | 不可证 | 根因级 finding 标签方案缺失 | §7 E |

成熟度标注口径沿用审计报告（shadow / 单测 / 生产 / 学术未验证），不以报告宣称为证据。

## 2. 缺口燃尽表

| # | 缺口 | 状态 | 模块 | 证据 |
|---|---|---|---|---|
| G1 | Agent 可写修订快照 / 登记 / 恢复意图 | FIXED_VERIFIED | `runtime/pi/workspaceGuard.ts` | `test/manuscript/reviewSnapshotProvenance.test.ts`、`test/runtime/agentCapabilityBoundary.test.ts` |
| G2 | 审批面能力边界无回归 | FIXED_VERIFIED（范围：Agent 工具面） | `roleConfig` / 自定义工具 | `agentCapabilityBoundary.test.ts`（无 shell / 无地址参数 / 契约与审批存储不可写） |
| G3 | 同 OS 用户进程可直接调用本机决策 API | BLOCKED_EXTERNAL → 显式产品限制 | — | §3 A1「可保证边界」 |
| G4 | review.snapshot 吸收未校验 Agent 写入 | FIXED_VERIFIED | `manuscript/RevisionStore.commitReviewSnapshot`、`agentWriteJournal.ts`、`index.ts` onWrite | 7 条正负例（真实受控工具）；真实运行快照路径无吸收（onWrite 未被真实写入触发，§7） |
| G5 | commit 复制期 TOCTOU | FIXED_VERIFIED | `RevisionStore.commitInner` | 复制后快照指纹复核（`EDIT_CONTRACT_RACE`） |
| G6 | 长度字面量吞数字（漏保护） | FIXED_VERIFIED | `quality/editContract.ts` LENGTH_LITERAL | `editContract.test.ts` 回归；61 补丁回放不变 |
| G7 | 数值互换 | FIXED_VERIFIED（同句、唯一值、指标式标签） | `extractValueBindings` | 正负例 + 回放 0 新增误拒 |
| G8 | 尾段冻结数值无逐项批准 | FIXED_VERIFIED | `quality/valueChangeRequests.ts`、HTTP decide、UI | 后端 7 例 + 浏览器 E2E |
| G9 | 分层 QualityReport / 唯一事实源 | FIXED_VERIFIED | `quality/qualityReport.ts`、definitions、Finalize、httpServer | `qualityReport.test.ts` 15、双入口一致性、浏览器 E2E |
| G10 | 未校准分数硬门 | FIXED_VERIFIED（改作者裁决） | `revisionTaskGate.ts` | 6b 用例改断言（语义变更如实记录） |
| G11 | 旧产物默认合格 | FIXED_VERIFIED | `deriveLegacyQualityReport` | 投影单测 + Finalize 用例 |
| G12 | 跨节一致性输入缺失可放行 | FIXED_VERIFIED | `gates.ts` | 冻结稿反事实回放 |
| G13 | claim 级作者稿审计仍 shadow | NOT_APPLICABLE（裁决：不晋升） | — | §5 C1 理由 |
| G14 | 独立人类标签 0 | BLOCKED_EXTERNAL | — | §7 E3 外部校准包 |
| G16 | 引用语法归一写入不写契约事件（真实运行暴露） | FIXED_VERIFIED | definitions `normalizeManuscriptCitationSyntax` | §7 Q3 复验 |
| G15 | 3 个既有 E2E 失败（smoke 标题 / 运行中取消 / 真实编译失败修复） | OPEN（范围外，既有） | e2e | §6 |

## 3. A — 信任边界与最小风险修复

### A1 审批面边界
- 静态 + 确定性回归：所有角色 × 工具策略的内置工具 ⊆ {read, write, edit, grep, find, ls}；生产自定义工具（scholarly / retrieve_library / evidence）无 url / host / port / command 类参数；SearXNG 地址来自配置而非模型。→ **运行中 Agent 没有发出 HTTP 请求或执行命令的能力，模型文本无法调用 HITL / 审计决策 / plan_confirm / 数值修改决策接口。**
- 写边界补洞：`manuscript/revisions/**`、`manuscript/revisions.json`、`manuscript/restore-intent.json` 不可写（Agent 此前可伪造复评回放所用的修订快照）；`research/edit-contracts.json`、`fact-authorizations.json`、`workflow/**`、`reviews/**` 不可写（回归断言）。
- **可保证的边界（如实）**：「批准来自 Agent 之外的 HTTP 调用方」。本地产品无用户认证；同一 OS 用户的任何进程（包括用户自己运行的脚本、本次 E 段驱动脚本）都可以调用决策 API，系统记录为 actor=author。approvalToken / planHash / boundHash 只防陈旧与伪造内容，不证明「人类亲自点击」。不扩展为多用户 RBAC。

### A2 review.snapshot 与提交边界
- Agent 受控 write / edit 每次成功写入后经 `onWrite` 追加 `workflow/agent-writes.jsonl`（Agent 对 workflow/ 不可读写；日志不可用 → 拒绝写入）。
- `commitReviewSnapshot`（workflow review.run 与手动 POST /review 共用）：相对上一修订的改动中，内容等于「上一修订之后某次 Agent 写入结果」的文件 = 未经契约校验的 Agent 改动 → 原内容隔离到 `workflow/review-snapshot-quarantine/` 后恢复；其余改动按非 Agent 来源吸收并在修订记录 `provenance` 中逐文件登记；分类、恢复、提交在同一串行队列内，以工作树指纹约束提交；commit 复制后再复核快照指纹。日志损坏 → `REVIEW_SNAPSHOT_PROVENANCE_UNAVAILABLE`（fail closed）。
- 作者主动编辑：磁盘编辑照常吸收；作者在 Agent 写入后再改同一文件 → 以作者内容为准。服务端写入与作者编辑不可区分（都不是 Agent 工具写入）——如实登记为 `absorbedNonAgentChanges`，不冒称「作者」。

### A3 数值语义与尾段授权
- 修复 token 化漏检：`LENGTH_LITERAL` 只匹配紧贴单位的长度（`2cm`），不再吞「11.549 in」。
- 数值互换：整目标软策略下，同句内两个基线唯一值在两个指标式标签（HOTA / IDF1 / mAP / BLEU-4…）之间互换 → `EDIT_CONTRACT_VALUE_REBOUND`。首版（单向换绑）回放出现 6 例新增拒绝（多次出现的值 / 非指标标签），按止损规则一次纠偏收窄为「同句交换 + 唯一值」后回放 **0 新增**；不判定形态（单向挪动、跨句、中文指标名、表格）如实列为边界。
- 尾段授权（R4）：被拒候选中可确定配对的冻结数值变更登记为 `value-change-request/v1`（旧值 / 新值 / 原句 / 建议句 / 基线哈希 / 来源），作者经 `POST /value-change-requests/decide` 逐项批准（回传 boundHash，任一不合法整批 409）；批准只在目标一致且旧值仍在基线中唯一出现时作为 allowedValueChange 生效。硬禁改、其它违规、无法配对、值多次出现、互换 → 不生成请求。
- 回放：`replay/replay-edit-contract-A.json` —— E1 摘要真实落盘 diff 仍拒绝（PROTECTED_VALUE_CHANGED / NEW_VALUE / OUT_OF_SCOPE）、复评仍 STILL_OPEN、合法限定通过；61 个历史已接受补丁：6 例策略收紧（与 P0 同 6 例）、0 新增。

## 4. B — 分层 QualityReport（唯一决策事实源）
见 `docs/research/M15_QUALITY_REPORT_CONTRACT.md`。要点：
- 9 个结论概念的归宿：`gate.passed` / `publicationReadiness` / Finalize 资格 → 从报告派生；`qualityPolicy.legacyPassed` → 保留为历史对照（不再驱动）；`revisionTask.verdict` → L3 输入；QualityScore / academicScore → L2（未校准）；目标期刊 readiness → L4 advisory；`qualityDecisionV2Shadow`、claim 审计 → 影子，L2 标注未启用。
- 同严格度：L2 待核验与必需未评估仍不可冻结；唯一有意放宽 = 未校准分数回退由硬 FAIL 改作者裁决（证据：SD 5–12）。
- 双入口：`gateDualEntry.test.ts` 断言 workflow 与手动重评的报告（除入口 / 时间）逐字段相等、GET 返回的报告等于产物嵌入报告、passed ≡ finalizable。

## 5. C — 科学核验接入生产（只接可证明有效的部分）
- C1 盘点裁决：生产 L1 = 跨节数值一致性（确定性证书绑定）、作者登记数据复算、引用元数据、已核验证据矛盾——**本来就在生产 Gate，本次给出层级与证据等级**；claim 级作者稿审计（LLM 抽取 + 逐字回放 + REVIEWER_SUSPECTED）只有影子证据，其 VERIFIED_CONTRADICTED 来源于作者数据复算（已在 L1），**不晋升**，在 L2 标 `SHADOW_NOT_IN_PRODUCTION_GATE`；findingAdjudication / candidateProposer / qualityDecisionV2 保持影子，不新增第四 Reviewer。
- C2：被审修订快照缺失 → 跨节一致性必需未评估；疑义（suspected）保持作者稿必需未评估（不冒充已证实）；作者数据复算标注为 `author_data_recomputed`（不写成外部核验）。
- C3 冻结真实作者稿零模型回放（`replay-c/frozen-replay-*.json`，源目录只读复制）：
  - MOT R5.1 长篇中文作者稿（rev 4 / r6）：L0 PASS；L1 PASS 但 3 项未评估（矛盾证据 / 作者数据复算 / 跨节一致性）；L2 必需 `unsupported_critical_claims_zero` 未评估（长文档单元模式不产出 claims）+ claim 审计影子 → overall **NOT_EVALUATED**（不可冻结）；L3 需作者裁决；L4 UNVALIDATED。
  - M15.19 E1 作者稿（rev 3 / r4）：L0 FAIL（覆盖、累计事实保持）、L3 FAIL（patch 实质 / 任务守卫）→ overall FAIL，与 M15.19 当时的 r4 FAIL 一致，且现在可分辨是完整性 / 修订闭环问题而非已证实学术错误（L1 PASS）。
  - 反事实：两稿删除被审修订快照 / 删除引用核验报告后均**不可冻结**，对应条目为必需 NOT_EVALUATED。

## 6. D — 修订闭环与生产 UI / E2E
- UI：质量门禁面板新增分层报告（总体状态 + 一句话结论 + L0–L4 状态 + 每条需关注条目的证据等级）、L4「未经独立校准」与独立标签数；数值修改逐项批准面板（逐条显示旧值 → 新值、原句 / 建议句；须勾选核对才能批准；无「全部批准」）。文案：「质量验收通过」→「完整性与已证实缺陷检查通过」；「投稿就绪」→「无阻断项（不代表可投稿）」；README 两处能力边界同步。
- Playwright（本机 Chrome，scripted 栈 + fakebin，零模型；日志 `e2e/`）：
  - 新增 `m15-quality-report.spec.ts` 2/2：分层报告 PASS 轮与失败轮、L4、外部效度声明；数值修改未核对不可批准、伪造 boundHash → 409、浏览器批准 → 服务端 approved + 批准事件、重评后 L3 待批准项消失。
  - `evidence-gate.spec.ts` 7/7（修正自 M15.7 起过期的「阈值规则 = 未通过」断言 → ADVISORY）。
  - `improvement.spec.ts` 2/2：PDF 导入 → research_plan → evidence_supply → **plan_confirm 在浏览器中批准（核对「本次批准的授权范围」）** → 修订 → Gate；终态按分层报告判定（必需 claim 级核验未评估 → 诚实 Draft；旧断言「必达 Final」自 M14.9.5.4 起过期）。
  - 其它回归：hitl 7/7、paper-artifacts 6/7、version 7/7、latex-import 1/1、workflow 1/2、smoke 0/1。3 个失败与本次改动无关：smoke 断言的标题「论文项目」在前端源码中不存在（既有过期）；workflow B「运行中取消」需慢速运行时（scripted 瞬时完成）；paper-artifacts G 需真实编译失败（本栈 PATH 前置 fakebin 恒成功）。记为 G15 OPEN，未扩大范围修复。
  - 审计修复路径（target_audit，flag 默认关）浏览器 E2E 未运行：NOT_EVALUATED；其后端集成用例（`targetAuditRevisionWorkflow`）全量测试通过。

## 7. E — 有界真实验证 + 外部校准准备

### E1 协议（首次真实调用前冻结）
`D:\PaperTeamData\M15\LongRunClosure\E\PROTOCOL.md`（sha256 `1bc2e6ff549bfcb387b900fcab8ad830d238a6167ab6a2d1f21e79380e35e245`）：只回答零模型无法证明的三个工程问题 Q1–Q3；样本 arXiv:1706.03762（仓库测试夹具，定位研发 smoke，**不是** held-out）；不运行 R2（零标签下 R2 也不产生学术证据）；HITL 按固定表决策、plan_confirm 不授权任何数值变更、不批准任何数值修改请求。

### E2 真实运行（1 次 / 共 38 次模型调用）
- run `w-bb298c6e52fc`，项目 `p-aa57b4480745`，glm-5.3（Z.AI Coding Plan），16:11→16:27（UTC），终态 `completed / draft`。
- 用量（项目 `research/model-ledger.json`）：38 次调用；输入 140,007 / 输出 42,454 / 缓存读 897,152 token；ledger 估算 0.62（订阅渠道，**不是账单**，逐次真实费用未知）。
- 核验（`scripts/m15-longrun/verify-real-run.mjs` → `E\verify.json`，零模型只读）：
  - **Q1 PASS（范围受限）**：review.snapshot 两轮均经 commitReviewSnapshot（rev-1 初始快照；r2 无改动不产生修订）；无 Agent 写入被吸收。真实 Writer 本次全部走只读工具的提案路径，Agent 写入日志 0 条——生产 onWrite 装配**未被真实写入触发**，其行为只由使用真实受控工具的单测证明。
  - **Q2 PASS**：`quality-gate-r2.json` 嵌入 quality-report/v1；passed=false ≡ finalizable=false；L0 PASS / L1 PASS / L2 NOT_EVALUATED（必需 claim 级核验未执行 + 模型 blocking / critical·major 待核验）/ L3 NEEDS_AUTHOR_DECISION（3 项待批准数值修改）/ L4 UNVALIDATED → 诚实 Draft。
  - **Q3 首测 REVIEW → 集中修复 → PASS**：Writer 的 5 个候选全部被编辑契约拒绝（PROTECTED_VALUE_REMOVED ×4、OUT_OF_SCOPE ×2、PROTECTED_VALUE_CHANGED ×1；**无越权内容落盘**），3 项可配对的删值登记为 pending 数值修改请求；rev-2 的 4 个文件改动全部是确定性引用语法归一（14 行，均为 `\cite{a, b}`→`\cite{a,b}`），已经契约校验并登记，但**未写契约事件**——lineage 无法从事件审计。按协议做一次同根因修复（归一写入写入 `candidate_accepted` + appliedHash），并零模型复验：真实 rev-1 → 重放归一 ≡ 真实 rev-2 逐文件相等，4 个事件 appliedHash 全部匹配（`E\normalize-replay.json`；`test/replay/m15RealRunNormalizeReplay.test.ts`、`test/workflow/citationNormalizeContractEvent.test.ts`）。未消耗额外模型调用。
- 冻结资料完整性：M15.19 `MANIFEST.json` 复核 1396/1397 一致，唯一例外仍是 `e1/vite.log`（PID 14800 的遗留 Vite 持续追加，非本任务进程，未终止、未重写 manifest）。本任务所有输出写入 `LongRunClosure\`；冻结项目只读复制后回放。

### E3 学术外部有效性
- 可用的独立人类标签：0（M15.10 双盲包仍待真人；公开同行评审材料均为同模型裁判，不计）。
- 交付最小外部校准包：`D:\PaperTeamData\M15\LongRunClosure\E3-calibration\CALIBRATION_PACKAGE.md`（样本选择原则、盲评流程、根因级 finding 标签 schema + 模板、自报问题召回、预注册指标与晋升线、质控与仲裁；L4 直接复用 M15.10 包）。最低需求：2 名独立评审 + 1 名仲裁；根因级 10 篇 ≈ 30–40 人时；期刊级 ≈ 每人 15–20 h。

## 8. 终局裁决

**M15 LONG-RUN：ENGINEERING_CLOSED_AWAITING_EXTERNAL_CALIBRATION**（CI / Linux Integration 结果见交付说明）

| 判定项 | 结论 | 最强证据 |
|---|---|---|
| ENGINEERING | PASS | A–D 单测 / 集成 / 冻结回放 / 浏览器 E2E；真实运行 Q1–Q3；全量后端 4687/0、前端 377/0 |
| FINDING_CORRECTNESS | 确定性 L1 部分：工程验证（注入 / 反事实 / 冻结稿）；模型 finding：INCOMPLETE | 无独立标签 |
| SEVERITY | 语义约束已实现（L2 不冒充已证实；真实 L1 缺陷照常 FAIL）；严重度准确性 INCOMPLETE | qualityReport.test.ts；无标签 |
| REVISION | PASS（授权 / 契约 / lineage / 合法暂停） | E1 回放 + 真实运行 5/5 越权候选被拒 + 数值修改逐项批准 E2E |
| SCORE_CALIBRATION | INCOMPLETE | 独立标签 0；分数不再承担任何硬门 |
| TARGET_JOURNAL_VALIDITY | INCOMPLETE（L4 恒 UNVALIDATED） | 同上 |

已知限制（不另开阶段）：同 OS 用户进程可调用决策 API（G3）；Agent 写入日志生产装配未被真实写入触发；数值互换只判同句唯一值的指标式标签；claim 级作者稿审计保持影子；3 个既有 E2E 失败（G15，范围外）；全量后端在默认并发下有超时型偶发失败（4 workers 下 0 失败）。
