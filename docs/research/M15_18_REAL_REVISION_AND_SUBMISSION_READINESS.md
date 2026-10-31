# M15.18 — 真实修订闭环补完与目标期刊投稿准备度综合验收

日期：2026-11-01 · 基线：main @ 83c9339（M15.17 结束态，origin 一致，CI/Linux Integration 双绿）
执行：Claude Code（长程；真实模型验收 + 提交推送）

## 0. 终局裁决（两项互不混淆）

- **`M15_18_REAL_REVISION_AND_SUBMISSION_READINESS = PARTIAL`** —— G3（真实模型完整闭环）未通过：
  预先冻结的真实样本池（S1 × 2 次审计、S2 × 2 次审计，共 4 次真实审计）**没有自然产出任何
  一条通过确定性分类门禁的 REWRITE_ELIGIBLE 项**，因此不存在可被作者批准、真实改写、复评为
  VALIDATED_FIXED 的审计条目。按协议不追加审计、不放宽门禁、不以 scripted 替代。G1/G2/G4/G6/G7
  通过，G5 PARTIAL（报告在真实数据上生成，但没有一条真实 VALIDATED_FIXED 可对账）。
- **`M15_TARGET_JOURNAL_QUALITY = INCOMPLETE`** —— 无目标期刊独立人类质量标签、未做预注册校准（本阶段不做）。

Revision Task Success、内部 Quality Gate PASS、Publication Ready 三者互不蕴含；本阶段任何输出都不是录用判断。

**一句话**：P0 代码缺陷（拆条吞派发 / 候选被拒仍 handled / 复评只看状态）已修复并以「修复前真实复现 → 修复后回归」
锁定；真实 E2E 又发现并修复了两处会直接阻断真实改写闭环的投影缺陷（PDF 连字、逐字锚按错误下标切片）和两处
真实 run 暴露的加固点；但在预先冻结的样本池内，真实审计从未产出可改写项，G3 的真实执行腿本轮没有机会被验证。

## 1. 基线与交付提交

| 提交 | 内容 |
|---|---|
| 645eb9d | P0-A 拆条 lineage / P0-B targetChanged 落盘后裁决 / 复评证据门（+22 测试） |
| 3f7ea02 | P0-C（真实 E2E 发现）：审计锚投影 NFKC 等价 + 源偏移逐字锚 |
| 57a7569 | Phase E 投稿准备度报告（后端汇总 + 路由 + TargetPanel 7c）+ scripts/m1518 驱动 |
| 6f3af70 | P0-C 补：计划 classifierVersion（旧实现生成且未决策的计划按同一审计重算） |
| 5872430 | 真实 run 发现：散文式执行注记剥离 + 文件级 lineage 守卫证据取自覆盖修订的 Quality Gate |
| 0cf3fdf | Phase E 官方规范展示标签（COMPLIANT 含不可评价条款时不说「全部符合」） |
| （收口） | 本报告 |

## 2. Phase A：故障定位（以 83c9339 源码为准）

### 2.1 调用链 / 状态机定位图

```
decide(approve REWRITE)                         TargetAuditRevisionService.decide
  └─ ExternalInstruction{source=target_audit, pending, section, text 内嵌「TeX 逐字锚」}
plan.improvement（Planner，真实模型）            definitions.ts improvementPlanStage
  └─ improvement-plan.json items[]{actionType, instructionId, targetQuote(模型转述)}
revision.apply                                   revisionReviseStage("revision.apply")
  ├─ collectRevisionDirectives
  │    author_decision 子条 → recordUnresolvedPlanOutcome(…,"AUTHOR_DECISION_REQUIRED")   :13530
  │       ⇒ 整条指令 status=unresolved、statusNote="AUTHOR_DECISION_REQUIRED: …"  ← 翻转点
  ├─ authorOwnedComments（statusNote 前缀过滤）                                     :3159 ← 原指令被移出派发通道
  ├─ modify 子条（转述 targetQuote）→ 长章节单元定位失败 → unresolved dispatch
  ├─ Writer prompt 外部意见块已无该指令 → externalOutcomes 不含该指令
  ├─ targetChanged = result.latex vs currentLatex（在塌缩/守卫表格之前）            :3931 ← 顺序差
  └─ applyDispatchOutcome：无报告 → 状态不变（停在 AUTHOR_DECISION）
reassess
  ├─ case "handled" → VALIDATED_FIXED（只看状态；非改写项被置 handled 也判成功）    :1080 ← 无证据门
  └─ executedPlanItems = resolutionTrace.planItemIds（含 author_decision 子条自身）  :1117 ← 假进展
计划期锚（M15.17 P1）
  └─ extractTexVerbatimQuote：在变换后文本定位，却用同一下标切原 TeX               ← 锚左移（Phase D 发现）
     projectQuoteToManuscript / comparableContains：无 NFKC（审计锚校验有）        ← 连字失配（Phase D 发现）
```

### 2.2 核查结论（①根因 ②受影响不变量 ③最小修复点 ④测试 oracle）

| 核查 | ① 根因 | ② 不变量 | ③ 最小修复 | ④ oracle |
|---|---|---|---|---|
| 作者批准状态保存在哪 | 只在 plan 工件 authorDecision；指令侧无结构化标记 | 已批准改写不得被模型拆条撤销 | 指令 `origin`（planId/itemId/contributionId/claimQuote/texAnchor/targetFile/approvedAt）；Planner 别名行加批准前缀 + 规则 11 | 拆条用例原指令 handled、statusNote 未翻转 |
| target_audit 如何进 Planner | commentAliases 原文，无批准语义 | 原文证据 ≠ 模型转述 | 原文锚存 origin；派发只认原文锚；锚失效 fail-closed | Writer prompt 含 `--- 意见 <id>`；锚失效用例零派发 |
| 拆条后谁改原指令状态 | recordUnresolvedPlanOutcome（任一 author_decision 子条覆盖整条） | 子条结论只属于子条 | 已批准改写只写 `planItemOutcomes`；authorOwnedComments 排除已批准改写 | 「只有 author_decision」用例仍派发并落盘 |
| 机器如何判 applied/handled | targetChanged 在守卫前按提案算 | 被拒 / 未写入 ≠ 已改 | `recordTargetOutcome` 于最终处置后调用；`candidateStatus` accepted/rejected/unchanged | 塌缩拒绝：文件不变 ⇒ 不 handled |
| reassess 是否只看 handled | 是 | VALIDATED_FIXED 需可核验证据 | `assessRewriteClosure`：lineage + 目标绑定 + 内容变化 + 未回退 + 守卫 + 无开放子条；无 lineage → NOT_EVALUATED | 单元矩阵 8 例 + 回退用例 |

验收协议于任何 M15.18 真实模型调用前冻结：`D:\PaperTeamData\M15\M15_18\PROTOCOL.md`（样本池、预算 100、
P0 判据、证据字段、负例、失败裁决）。

## 3. Phase B：P0-A 拆条 / 状态翻转修复（645eb9d）

- `externalInstructions.ts`：`origin`（:102）、`planItemOutcomes` + `PlanItemOutcomeKind`（:123；author_decision /
  evidence_only / action_type_missing / noop_unverified / noop_verified / candidate_rejected / unchanged / applied）、
  `isApprovedAuditRewrite`（:154；旧工件无 origin 时以固定段落【允许的修改】兼容识别）、`appendPlanItemOutcome`
  （:164；同子条+结果+修订号去重——重试/恢复不重复计数）；读取器对旧工件零字段兼容。
- `definitions.ts`：
  - `recordUnresolvedPlanOutcome`（:13575 / :13592）：已批准审计改写 → 只登记子条结果，不改 status/statusNote；
  - 派发入口（:3166–:3227）：approvedAuditRewriteIds / 审计目标文件映射；**锚失效 fail-closed**（:3182，TeX 逐字锚
    不在目标文件 → 不派发且其 Planner 子条一并剔除，记 `TARGET_AUDIT_ANCHOR_STALE`；已有落盘 lineage 的只跳过派发）；
    authorOwnedComments 排除已批准改写（:3217）；真人/作者意见在 Writer prompt 中先于 target_audit（:3227）；
  - Planner 输入（:8515）：已批准改写加 `【作者已批准：按既有证据改写】` 前缀（原文不变）+ WriterService 规则 11。
- 真人 mandatory 优先级、needs-experiment 永不派发、actionType 不被篡改：原有语义保持（回归见 §6）。

## 4. Phase C：targetChanged 与「完成」判定顺序（645eb9d）

- `recordTargetOutcome`（definitions.ts:3654）在最终处置之后调用：span 落盘后（:4214，且提案相对 span 非仅
  边界空白差异）/ 文件级塌缩与守卫表格之后（:4262，以实际写回内容判定）/ 摘要具名实体守卫之后（:4082）/
  span 候选被拒 `continue` 前（:4037，记 `rejected`，不再落入「章节未匹配」）。
- `applyDispatchOutcome`（externalInstructions.ts:783）：`candidateStatus` 为 rejected/unchanged 的报告不算真实变化；
  逐子条 lineage 携带修订号、文件、前后 SHA、patch id（`withPlanItemLineage`，:855）。
- 审计目标文件上 Planner modify 子条候选落盘时补确定性 attribution（不跨文件归因——集成测试中真实踩到的
  sec01≠sec02 误归因已修正）。
- 复评 `assessRewriteClosure`（TargetAuditRevisionService.ts:596）证据门如 §2.2；非改写项永不 VALIDATED_FIXED。

### 修复前 / 后复现（同一 scripted 场景；旧代码 = 暂存修复源文件后运行，原始输出 `repro_before_fix.txt`）

| 场景 | 修复前（83c9339 逻辑） | 修复后 |
|---|---|---|
| Planner 拆 modify(转述)+author_decision | status=unresolved，statusNote=AUTHOR_DECISION_REQUIRED；**原指令未派发、稿件未改**；复评 PARTIALLY_ADDRESSED，依据把 author_decision 子条 improvement:2 当「已执行」（假进展） | 原指令以 TeX 逐字锚派发并落盘；handled；子条 {improvement:2 author_decision, applied(前后 SHA)}；复评 PARTIALLY_ADDRESSED（开放子条 1，如实不夸大） |
| 文件级候选被内容塌缩守卫拒绝 | **文件一字未改，但 handled，复评 VALIDATED_FIXED（假修复）** | candidate_rejected；statusNote「候选修改被守卫拒绝、未落盘」；复评 STILL_OPEN |

## 5. Phase D：真实模型验收

环境：真实 backend（Pi in-process runtime，`zai-coding-cn/glm-5.3`，Z.AI Coding Plan 订阅），隔离 projects
root `D:\PaperTeamData\M15\M15_18\e2e-stack`，flag on，真实 HTTP，Chrome CDP 真实点击（vite :5178 → :3118）。
外部环境：OpenAlex 日配额耗尽（429，Retry-After≈24000s）——citation/审计 pool 走其余 provider 并如实降级。

### 5.1 样本与审计结果（4 次真实审计，全部按协议）

| 样本 | 许可 | 项目 | 审计 | gapPlan（模型） | 确定性计划分类 |
|---|---|---|---|---|---|
| S1 arXiv:2609.08265（KAIST MOT 综述） | arXiv 非排他分发许可，研究评估 | p-dabcfa1f5915 | #1 3 调用/79s | 4 × requires_real | 4 × NEEDS_REAL_EXPERIMENT |
| 〃 | 〃 | 〃 | #2 3 调用/63s | 3 × requires_real（C4 含「'MOT18' typo」可改写子项被并入需实验） | 3 × NEEDS_REAL_EXPERIMENT |
| S2 arXiv:1907.12740（Ciaparrone 等，MOT 深度学习综述） | 〃（arXiv 元数据核验身份） | p-724f527d6766 | #1 3 调用/70s | 2 × requires_real + 1 × can_rewrite（C5） | 修复前：C5 **UNMAPPABLE（误判，连字）**；修复后：C5 NEEDS_TARGETED_EVIDENCE |
| 〃 | 〃 | 〃 | #2 3 调用/69s | 2 × requires_real + 3 × can_rewrite（C1/C2/C5） | 3 × NEEDS_TARGETED_EVIDENCE（全部投影成功）+ 2 × NEEDS_REAL_EXPERIMENT |
| N1 case-R（私有中文研究论文 PDF-only） | 私有，内部评估 | p-6217e179ef36 | 3 调用/132s | 4 × requires_real + 1 × can_rewrite | 4 × NEEDS_REAL_EXPERIMENT + 1 × UNMAPPABLE（只读，不猜位置） |

**REWRITE_ELIGIBLE 合计 = 0 → G3 的前置条件在样本池内从未满足。**

### 5.2 G3 不通过的真实根因（逐层，均有工件）

1. **审计 prompt 结构性捆绑**（`ContributionAuditService.ts:673`，冻结 `m1514-caudit-v1`）：「每个缺验证的贡献
   恰好一个 gapPlan 项」——混合子缺口（措辞/笔误 + 消融）只能取一个 actionType，模型保守取 requires_real
   （S1 7/7）。
2. **有界先前工作 pool 与模型记忆脱节**：S2 refs 109 → resolve 上限 20（18 解析）→ pool 12（全部摘要级，
   fulltext 0）；模型给出的最近先前工作（Luo 2014、Emami 2018）只在模型记忆中，`resolvesToPool=false`，
   比较态 INSUFFICIENT_EVIDENCE。
3. **B2 分类门禁（M15.17 冻结）据实拦截**：can_rewrite + INSUFFICIENT_EVIDENCE + 无可解析先前工作 →
   NEEDS_TARGETED_EVIDENCE（S2 4/4）。其中 C2「'Comprehensive' 覆盖声称缺选择标准」属于不依赖先前工作的
   弱化型改写——门禁对这一子类偏严，但事后放宽门禁违反协议，列为下阶段候选（§10）。
4. **真实缺陷（已修复，P0-C）**：S2 C5 的锚在重建 TeX 中含 PDF 连字「ﬁ」；审计锚校验（NFKC）通过而计划
   投影无 NFKC → 误判 UNMAPPABLE。修复后 S2#2 的 C1 锚（含「identiﬁed」）同样投影成功——修复在真实数据上生效。

### 5.3 P0-C：真实 E2E 发现的投影 / 逐字锚缺陷（3f7ea02 / 6f3af70；Deviation D1 已登记）

| 输入 | 修复前 | 修复后 |
|---|---|---|
| S2 真实 sec05.tex × C5 claimQuote（「…in the field of MOT…」，TeX 为「ﬁeld」） | projection `unresolved / quote-not-found` | `resolved → sections/sec05.tex`；逐字锚保留原 TeX 字节「ﬁeld」 |
| `\section{Method}` + `\cite{a1,a2,a3}` + `12.5\%` 之后的目标句 | 锚 = `\% gains are background only.\nThe detector achieves 97.9\% F1 on Total-Te`（跨入前一句、截断目标句） | 锚 = 目标句逐字（含 `\%` 与 `\cite{ref3}`） |

修复：`latexToComparableMapped`（每个输出字符记录 TeX 源偏移）；投影与锚提取统一使用审计侧
`normalizeForQuoteMatch` 等价（NFKC 连字/全半角 + 去零宽/软连字符 + 空白折叠 + 小写）；切出的锚经同一归一化
回放自检，不含审计引文 → fail-closed。NFKC 只消排版变体，不做语义匹配（换词用例仍 fail-closed）。
计划工件携带 `classifierVersion`：同审计 + 同修订 + 同版本 → 幂等返回；旧实现生成且**未决策**的计划按同一
审计重算；已决策计划绝不覆盖。Deviation 处置：修源码→提交→重建 dist→重启 backend；**不重新审计**（同一真实
审计工件确定性重分类，零模型），门槛未放宽。

### 5.4 真实 UI / HITL 与负例

- **浏览器真实点击（CDP）**：S1（3 项）、S2（5 项）在 TargetPanel 逐项点击「批准」；后端计划 `decided`，指令
  `origin.kind=target_audit_author_decision`；截图 `e2e/ui/*-10/11-*.png`。决策均为隔离测试项目上的代理测试性
  决策（日志标注），未触碰任何真实用户项目。
- **需实验项**：S1 复评 3 × NEEDS_AUTHOR_DECISION / VALIDATED_FIXED=0；N1 5 × NEEDS_AUTHOR_DECISION；
  需实验指令 pending + AUTHOR_DECISION_REQUIRED，零派发；实验需求包（目的/基线/数据/指标）在计划与报告中。
- **PDF-only 零伪改动（N1）**：只读项目上 can_rewrite → UNMAPPABLE；全批准 5 指令；幂等重试 +0；稿件不变。
- **stale 409（M15.17 C1 补跑，真实 HTTP）**：N1 换稿 → 审计 stale=true，计划重生成 409 `TARGET_AUDIT_STALE`，
  决策 409 `TARGET_AUDIT_STALE`。重新审计 + 已决策计划 → 409 `TARGET_AUDIT_PLAN_INVALID_STATE`、venue 切换、
  修订号前进：单测 / HTTP 契约覆盖（四路）。
- **flag off（独立真实进程，:3119，独立 root）**：GET evidence-audit / revision-plan / submission-readiness 均
  `enabled:false`；POST evidence-audit / revision-plan / reassess 与 `.md` 下载均 403。
- **重启恢复**：Deviation 期间两次重启 backend，两个暂停 run 均被恢复为 awaiting_input，计划 / 指令工件完整。

### 5.5 S2 真实 improvement run（无审计改写项可派发时，验证其余真实链路；w-67ad37922652，24 min）

- 5 条审计指令（3 定向证据 + 2 需实验，均作者裁决）**零派发**：外部意见通道为空，复评 5 × NEEDS_AUTHOR_DECISION。
- 真实 Planner 23 条计划（8 条链接意见——Planner 为作者裁决指令补的兜底条目），`revision.apply` → rev 2，
  `revision.revise` → rev 3。
- 守卫真实拦截：rev 2 的 21 个 span 候选全部在候选校验被拒 / 耗尽（Fact：如删除 `\section{1 Introduction}` 的
  标题编号被判删除数值事实）；7 + 2 条意见在长章节中锚不可唯一定位 → 未派发、不猜位置。
- Quality Gate 两轮 FAIL（累计事实漂移 12、blocking 3、claim 级核验 NOT_EVALUATED），终态 SYSTEM_FAILED、
  publicationReadiness NOT_READY；run 停在「自动修订已达上限」HITL，未接受 Draft。Revision Task Success = FAIL，
  与内部 Gate、Publication Ready 三者均未成立，互不蕴含。
- 实际落盘差异：sec05 仅 `\cite` 列表空白的确定性归一；sec03 一处标点；**sec01（短文件 → 文件级路径）删除了
  PDF 封面 / 作者 / 版权横幅（Planner 计划授权），并把一行执行注记写进正文**：「冲突报告（保留原表述，未擅自恢复）：
  fact-preserve 系列条目要求「恢复」……」。文件级路径没有候选级校验，既有 `stripRevisionExecutionNotes` 只识别
  【…】与项目符号注记 → 已加固（5872430：执行报告标签 + 冒号的散文行、含 fact-preserve / 计划 id 等内部标识的行），
  并把复评对文件级 lineage 的守卫证据收紧为「gate 复核正向记录或覆盖该修订的 Quality Gate 事实 / 引用保持 PASS」。
  该次落盘的注记行保留在测试项目 rev 3 中作证据，未手工改动。

## 6. Phase E：投稿准备度报告（57a7569）

`TargetSubmissionReadinessService`（零模型，只汇总既有工件）→ `GET /target/submission-readiness`（JSON）与
`/submission-readiness.md`（附件下载）；flag off → enabled:false / 403。TargetPanel 7c 区块：按需生成 + 下载。

| 区块 | 来源工件 | 纪律 |
|---|---|---|
| 官方投稿规范 | target-guideline-compliance.json | 可机检 / 仅部分可机检 / 本稿不可评价；硬性违规；评估修订落后于当前稿 → 提示重评；PDF-only 区间口径 |
| benchmark 观测 | target-readiness.json + profile | 「处于/低于观测带」措辞；语料不足统一 INSUFFICIENT；注明非最低录用标准 |
| 贡献风险 | target-contribution-audit.json | claim 原文 → 先前工作身份（DOI/arXiv/年）→ 材料等级 / 身份可解析 / quote 回放 → 状态 / 缺失验证 / 不确定性 |
| 修订行动清单 | target-audit-revision-plan.json | 可基于现有证据改写 / 需补文献与定向证据 / 必须真实实验或作者决策（附实验需求包）/ 不可定位 |
| 闭环对账 | target-audit-revision-report.json | 七态 + 证据门逐项 ✓✗ + 依据 |
| 剩余风险 / 局限 | 上述汇总 | 独立人类标签 = 0；不输出录用概率 / 质量档位 / Publication Ready |

### 6.1 真实数据上的报告（浏览器真实点击生成；`e2e/*-submission-readiness.md`、`e2e/ui/*-20-closure-report.png`）

| 项目 | 官方规范（确定性） | benchmark | 贡献风险 | 行动清单 | 闭环 |
|---|---|---|---|---|---|
| S2（可编辑 TeX，r3） | 存在 4 条硬性违规（无关键词块 / 摘要无目的-方法-结果-结论结构 / 近 10 年占比 55% < 60% / DOI 0/109）；可机检 7 · 部分 1 · 不可评价 4 | 尚无观测报告（未冻结 benchmark；OpenAlex 配额耗尽，未做发现） | C1/C2/C5 INSUFFICIENT_EVIDENCE（先前工作仅模型记忆）、C3/C4 EVIDENCE_GAP；审计相对 r3 已陈旧并提示重审 | 可改写 0 · 定向证据 3 · 真实实验/作者 2 | 5 × NEEDS_AUTHOR_DECISION |
| N1（PDF-only，换稿后） | 机检范围内未发现硬性违规（另有 10 条不可评价，需人工核对）——原始 topStatus 为 COMPLIANT，报告不复述为「全部符合」 | 同上 | C1/C4 SUPPORTED_DIFFERENCE、C2 INSUFFICIENT、C3 POTENTIAL_OVERLAP、C5 EVIDENCE_GAP（摘要「更高精度」与 ICDAR2015 F 值未超越最强对比方法不一致） | 真实实验/作者 4 · 不可定位 1 | 5 × NEEDS_AUTHOR_DECISION |

学术不确定性（报告内逐条列出）：所有比较依据为摘要级 / 模型记忆（fulltext 0）；目标期刊独立人类标签 = 0；
benchmark 观测本轮不可用；报告不含任何录用概率或质量档位。

未做（按任务书列为后续，不阻塞）：cover letter / highlights / 投稿门户格式包。

## 7. 验收门

| 门 | 结论 | 依据 / 阻断项 |
|---|---|---|
| G1 核心派发 | **PASS** | origin + planItemOutcomes 确定性 lineage；拆条 / 只 author_decision / 只 modify / 锚失效 / 真人先序 / 幂等重跑 / 回退 7 个长章节集成回归 + 15 单元；修复前真实复现（原指令未派发、假进展）→ 修复后派发并落盘 |
| G2 实际变更 | **PASS** | targetChanged 于落盘后裁决；候选被拒 → candidate_rejected 且不 handled（修复前：文件未改却 VALIDATED_FIXED）；Writer 自称已改无变化 / 数值篡改被拒 / 塌缩拒绝回归全绿；真实 S2 run：21 个 span 候选被守卫拒绝（fact 守卫），无一计为已改 |
| G3 真实模型完整闭环 | **PARTIAL（未通过硬门）** | 真实链路已验证：真实审计 ×5 → 确定性计划 → 浏览器真实点击决策 → 作者裁决指令 → 真实 improvement run（真实 Planner/Writer/守卫/Gate）→ 复评；**阻断**：冻结样本池（S1×2、S2×2 审计）REWRITE_ELIGIBLE = 0（§5.2 三层根因），无一条审计改写项可执行 → 无 VALIDATED_FIXED；不以 scripted 替代 |
| G4 科学纪律 | **PASS** | PDF-only 零伪改动（N1 can_rewrite → UNMAPPABLE、稿件不变）；需实验零派发零造数（S1 3 项、S2 5 项、N1 5 项）；不可确认 → NEEDS_TARGETED_EVIDENCE / UNMAPPABLE 诚实降级；文献依据等级逐条标注；Fact/Citation/Evidence/Scope/Quality Gate 未放宽（真实 S2 gate 两轮 FAIL：累计事实漂移 12，SYSTEM_FAILED / NOT_READY，Draft 未冻结）；NFKC 等价与审计侧完全一致，换词仍 fail-closed |
| G5 投稿准备度 | **PARTIAL** | 六区块报告 + Markdown 下载 + UI 真实点击，在 S2/N1 真实数据上生成，不确定性逐条标注；缺：benchmark 观测（本轮未冻结）与任何真实 VALIDATED_FIXED 对账 |
| G6 负例 / 可靠性 | **PASS** | stale：真实换稿 → 计划 409 / 决策 409（TARGET_AUDIT_STALE），重审计覆盖 / venue / 修订号前进由单测 + HTTP 契约覆盖；幂等：真实 decide 重试 +0、复评两次一致；flag off：独立真实进程 GET enabled:false / POST 与下载 403；重启恢复：3 次重启后暂停 run 均恢复；真实守卫拒绝不误报 repaired；双端 typecheck + build；后端全量 417 文件 / 4583 通过、前端 38 / 372 通过 |
| G7 CI / 交付 | 以包含本报告的最终提交在 GitHub CI + Linux Integration 的结果为准（报告不自引用其所在提交 SHA；结论随交付说明给出） | main 直推、快进、未强推；推送后核对 HEAD == origin/main、工作区 clean；私有数据 MANIFEST.json 551 文件 SHA256 |

## 8. 测试与工程

- 新增 / 修改测试：后端 `targetAuditDispatchLineage.test.ts`（7 集成，长章节多 span）、`externalInstructionLineage.test.ts`
  （15 单元）、`targetAuditRevision.test.ts`（+3：逐字锚边界、连字等价、classifierVersion 重算；1 条旧断言改为回归
  oracle）、`submissionReadiness.test.ts`（5）、`targetHttp.test.ts`（+2）、`revisionExecutionNotes.test.ts`（+1）；
  前端 `TargetPanel.test.tsx`（+1）。scripted runtime 增 `scopeOutputOverride`（仅测试构造真实形态的拆条 / 自称已改 /
  被拒候选）。
- 全量：后端 417 文件 / 4583 通过 / 0 失败（43 skipped 为真实模型 smoke 等既有跳过）；前端 38 文件 / 372 通过；
  双端 `tsc --noEmit` + build 通过；每次提交前 `git diff --check`。
- CI：645eb9d 首跑 CI 的 docker compose smoke 作业失败（web 容器启动 70ms 后 `curl: (56) Connection reset`，nginx
  就绪竞态；build·typecheck·test 作业成功；原始日志 `ci-645eb9d-failed.log`），仅重跑失败作业即绿；6f3af70 双绿。

## 9. 数据、模型调用与费用

- 物理模型调用 **90 / 100**（预算内；0 失败）：S1 run 14 · S2 run 60（含 per-run cap 触发的优雅停止）· 审计 5 × 3 = 15 ·
  连通性测试 1。模型：`zai-coding-cn/glm-5.3`（Z.AI Coding Plan 订阅）；Pi 运行时按 list price 估算 ≈ $2.88（订阅计费，
  无公司网关额外收费）。
- 时长：S1/S2 run 至暂停各 ≈10 min；单次审计 63–132 s；S2 improvement run 24 min（到达自动修订上限 HITL）。
- 私有数据：`D:\PaperTeamData\M15\M15_18\`（PROTOCOL.md 冻结协议、RUNLOG.md 含 Deviation D1、state.json、各项目
  修订前后快照 / 指令 / patch 校验 / 事件流 / 复评 / 投稿准备度报告、UI 截图与 innerText、修复前后复现、CI 失败日志、
  S2 PDF 与 arXiv 元数据；MANIFEST.json 含 SHA256 与 public/private 分类）。原始 PDF、模型完整输出、项目工件、截图
  均不入公开仓库。
- 未清理：两个测试 run 停在 HITL（S1 research_plan、S2 revision_overflow），未接受 Draft、未投稿；测试项目保留供复核。

## 10. 下阶段待办（仅真正未解决问题）

1. **G3 真实闭环仍缺一条自然产生的 REWRITE_ELIGIBLE 样本**。可选路径（需预注册，不在本轮启动）：
   (a) 审计 gapPlan 允许按子缺口拆分 actionType（prompt 版本升级 + 回归 M15.14/15/16 校准，而非放宽门禁）；
   (b) B2 门禁区分「弱化 / 一致性修正型改写」（不依赖先前工作身份）与「比较 / 定位型改写」（依赖）——需单独
   设计评审与回归，不能在验收中途修改；(c) 走 NEEDS_TARGETED_EVIDENCE 的真实用户路径：作者入库最近先前工作
   全文 → 重新审计 → 重分类。
2. 先前工作 pool 规模（resolve 20 / pool 12 / fulltext 0）与模型记忆脱节；在库全文升级规模化（M15.16 遗留）。
3. OpenAlex 配额耗尽时的 pool 质量影响需单独量化。
4. cover letter / highlights 等投稿包外围功能（用户明确需要时）。
