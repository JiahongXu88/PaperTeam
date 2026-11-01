# M15.19 — Actionable Evidence Gaps & Real Revision Closure

日期：2026-11-01 · 基线：main @ ac7c3b8（M15.18 结束态，origin 一致，CI / Linux Integration 双绿）
执行：Claude Code（长程；冻结协议 + 真实模型验收 + 提交推送）

## 0. 终局裁决（两项互不混淆）

- **`M15_19_ACTIONABLE_REVISION = PARTIAL`**
  - **G3a_ITEM_REAL_CLOSURE = PARTIAL**：真实链路**机器闭环已打通**——真实审计（m1519-caudit-v2）原生产出原子子缺口 → 确定性门禁
    `REWRITE_ELIGIBLE(internal_evidence)` → 浏览器真实点击批准 → 真实 Planner / Writer → 摘要真实落盘（rev 2，SHA e8d10791→48487328）→
    gate 事实 / 引用保持 PASS → 复评 `VALIDATED_FIXED`（两次幂等）；同一贡献的需实验 / 需补证据 3 个子项保持作者裁决、零派发。
    **但按预先冻结的 oracle 与 PROTOCOL §3(A)「不改既有数值」，该改写不合规**：Writer 把摘要头条数字 5.402 / 11.549 **替换**为正文另一检测口径的
    3.312 / 9.798（皆为稿内真实数值，由已批准的 Planner 条目授权），并顺带删除了摘要中两句与审计目标无关的表述。不事后放宽 oracle → 判 PARTIAL。
  - **G3b_WORKFLOW_TERMINAL = PARTIAL**：run 停在 `hitl.revision_overflow`（按协议不 accept_draft / 不 revise_more）；Quality Gate r4 FAIL
    （累计事实漂移 2 项：共享修订尾段把列表编号「2.」在 sec02 / sec03 间移动；blocking 1；claim 级核验 NOT_EVALUATED）；
    另有一处守卫未识别的公式类改写（sec02，PDF 乱码数学字形被改写为「Cw = Cw + ∆C」）。
  - G1 / G2 / G5 / G6 PASS；G4 PASS（枚举负例全过）但新发现一个「超出审计授权范围仍判 VALIDATED_FIXED」的缺口（§7）；G7 见交付说明。
- **`M15_TARGET_JOURNAL_QUALITY = INCOMPLETE`** —— 目标期刊独立人类质量标签仍为 0，未校准；本轮不输出任何录用水平 / 录用概率 / publication_ready。

条目级修订成功（Revision Task Success）≠ 内部 Quality Gate PASS ≠ 投稿准备度，三者互不蕴含。

**一句话**：把「每贡献一项」的捆绑审计改成原子子缺口 + 内部证据弱化型确定性放行后，同一历史论文的可改写项由 0 变 3（DEV），冻结的新真实论文
上第一次跑通了「审计 → 批准 → 真实 Writer 落盘 → 守卫 → VALIDATED_FIXED」；但真实改写**换了数字并扩大了改动范围**，暴露出
「审计指令的禁止项未被确定性执行、Planner 批准条目可越权授权」这一下一阶段必须修的缺口，故不宣称 COMPLETE。

## 1. 交付提交

| 提交 | 内容 |
|---|---|
| 2452b21 | Phase B–D：原子子缺口审计 v2 + 确定性分类（内部证据弱化型 / 比较型）+ 定向证据清单 + pool 优先级 / 覆盖诊断 + 候选级冻结口径跨文件误归因修复 + UI 分组（代码冻结点；CI / Linux Integration 双绿） |
| a478560 | Deviation D1（真实 E1 暴露）：摘要载体投影 + 摘要目标复评哈希（提交说明含 1 个 U+FFFD 乱码字符——已推送不改写历史，内容见 §5.2） |
| 8e9a1b2 | Deviation D2：改进计划结构化输出失败可诊断性 + E1 驱动 rerun |
| （收口） | 复评说明按分类标签措辞 + 本报告 |

## 2. Phase A：状态图、根因、冻结协议

### 2.1 真实状态图（改写能否派发的充要条件）

```
audit (ContributionAuditService, 3 次有界调用)
  extract → compare → synthesize ── v1: gapPlan「每贡献恰一项」(actionType 二值)
                                └─ v2: 原子子缺口 {gapKind, targetQuote, evidence[], priorWork[]} + 确定性守卫
plan (TargetAuditRevisionService.generatePlan，零模型；绑定 指纹+evaluatedAt+修订号+venue+classifierVersion)
  v1 项 → classifyAuditGap（旧口径，语义不变）
  v2 项 → classifyAuditSubGap：可派发 ⇔ gapKind∈{INTERNAL, TEXT, PRIOR} ∧ 目标锚审计回放 ∧ 计划期对当前稿再回放
                                   ∧ 唯一投影到可编辑载体 ∧ （内部型：≥1 稿内证据锚回放且≠声称；比较型：pool 身份 + quote 回放 + 无时间违规 + 已被稿件引用）
decide（作者逐项）→ REWRITE → ExternalInstruction(target_audit, pending, origin{texAnchor,targetFile})
                   其它 → AUTHOR_DECISION_REQUIRED（永不派发）
Planner (plan.improvement) → hitl.plan_confirm → revision.apply（指令 + 逐字锚派发，Fact/Citation/Scope 守卫）
  → recordTargetOutcome（落盘后裁决）→ planItemOutcomes(lineage) → 共享尾段（validate / review / gate / revise …）
reassess：VALIDATED_FIXED ⇔ handled ∧ lineage ∧ 目标绑定 ∧ 内容变化 ∧ 未回退 ∧ 守卫(span patch 或覆盖修订的 gate) ∧ 无开放子条
```

### 2.2 只读诊断（真实历史案例，用于开发，非新测试）

| 样本 | 现象 | 结论 |
|---|---|---|
| S1 arXiv:2609.08265 审计 #2 | C4「…'MOT18' typo; no variance…」整项 requires_real | 可改写子项被捆绑 |
| S2 arXiv:1907.12740 审计 #2 | C3「'experimental comparison' label overstates…」与「无复现 / 显著性」捆绑；C2「comprehensive」为缺失型（无对立稿内锚） | 根因 1 + B2 门禁对内部弱化型偏严 |
| N1 case-R | C5 摘要「更高精度」vs ICDAR2015 F 值——标准内部不一致 | PDF-only → UNMAPPABLE（正确） |
| LaTeX ZIP 导入 | 不产生 PaperDocument | 证据审计只能走 PDF 导入 + 重建 TeX |

验收协议于任何 M15.19 模型调用前冻结：`D:\PaperTeamData\M15\M15_19\PROTOCOL.md`（sha256 97cb485c…；预算 120；两类合法改写 oracle；
E1 选样规则；plan_confirm 预登记 revise 反馈；overflow 只停不扩）。

## 3. Phase B：原子子缺口与确定性分类（G1 / G2）

- `ContributionAuditService`：综合契约 v2 `m1519-caudit-v2`（构造参数；产品路径用 v2，研究脚本缺省 v1——M15.14/15 复现口径不变）。
  v2 综合调用附带稿件正文（关键节 + 支撑节，≤40k，截断登记），五类子缺口（INTERNAL_CLAIM_MISMATCH / TEXT_OR_STRUCTURE_CORRECTION /
  PRIOR_WORK_COMPARISON / EXPERIMENT_OR_AUTHOR_INPUT / UNCERTAIN_OR_MISSING_EVIDENCE）；稳定 id = sha256(贡献 | 类型 | 归一化目标锚)；
  守卫：换字眼去重、每贡献 ≤4、目标 / 证据锚逐字回放、证据≠声称、先前工作只解析到 pool、quote 回放、时间因果；非法项计数不吞其它子项。
- `TargetAuditRevisionService.classifyAuditSubGap`：模型 gapKind 只是建议；计划期对当前稿**再回放**目标锚与证据锚；内部弱化型与比较型严格区分；
  需实验永不改写；需补证据项附 `evidenceRequest`。旧 v1 工件走原函数；已决策计划不被新分类覆盖。
- 指令文案：稿内证据锚以〔〕只读呈现（不参与派发端「」锚定位）；内部证据型不携带先前工作（声明不得新增比较结论）。

## 4. Phase C：定向证据（不无限扩大 pool）

- 需补证据项逐来源标注缺失原因（仅模型记忆 / 不可解析 / quote 未回放 / 未被稿件引用 / 仅摘要）+ 导入指引（合法全文入库 → 重新审计 → 在库全文
  按身份升级 verified_fulltext → 重新计划）；不检索、不升格、不从模型记忆构造全文。
- pool：解析上限 20 不变，改为优先「声称所在节被引」的参考文献（旧口径按年份取最新 20）；登记 refsNotSelected / cutFromPool。
- `meta.priorWorkCoverage`：审计点名的最近先前工作逐条诊断——在参考文献但未解析 / 已检索被 pool 截掉 / 在库未升级 / 仅模型记忆且不在参考文献。
  真实 DEV：Luo et al.「Multiple Object Tracking: A Literature Review」诊断为 model_memory_not_in_references（人工核对 S2 参考文献与 bib 均无该文——诊断正确）。

## 5. Phase D：Writer / 守卫真实拒绝归因 + 执行期缺陷

### 5.1 M15.18 S2 21 个 span 候选全拒的逐项归因（确定性回放，零模型）

| 归因 | 数 | 修复后 |
|---|---|---|
| 仅因冻结口径继承 sec01 文件级路径已落盘的封面 / 单位块删除（跨文件误归因） | 4 | fact PASS，无其它已记录失败 |
| 误归因 + 自身真实违规（4 × 引文授权外改动；1 × 删除 \cite{ref155}） | 5 | 仍拒（正确） |
| 自身真实删除（sec05 含 [89] 句；sec03 ACF [24] / MOT15 [15]） | 2 | 仍拒（正确） |
| 修复轮按误归因反馈把封面 / 版权 / arXiv 横幅回填进 sec02–05 | 10 | 仍拒（正确） |

更正 M15.18 报告措辞：「\section{1 Introduction}（被删除）: prose_number（值 1）」的值来自同段作者单位上标，不是标题编号误判。
修复（`computeFactPreservationForCandidate`）：冻结口径对「源修订、无候选」再评一次、多重集扣减；候选桶达上限不扣减（fail-closed）；
Quality Gate cumulative 口径未改。修复前红：新测试在旧源码 3/7 失败；修复后 7/7。脚本 `scripts/m1519/replay-candidate-facts.mjs`。

### 5.2 Deviation D1（真实 E1 暴露，修复前登记）

PDF 重建把第 1 页封面 + 摘要原文留在 `sections/sec01.tex`，摘要同时在 `outline.abstract`（main.tex `\begin{abstract}` 载体）。
- D1a：引文在两载体都回放时按节序选中 sec01 副本 → 改写会落在副本、论文真正的摘要不变。修复：优先摘要载体，重复位置列入 `alsoFoundIn`（UI 展示，不派发）。
- D1b：复评读 `manuscript/abstract` 文件永远失败 → 摘要改写只能 NOT_EVALUATED（与 revision 端摘要 lineage 口径不一致，M15.17/18 起潜伏）。修复：按 outline.abstract 同口径取哈希。
- 真实复现：`scripts/m1519/repro-abstract-carrier.mjs`（真实 E1 文件，dist=2452b21）；单元回归 +2（旧源码 2/2 失败）。
  修复后同一审计工件确定性重算计划（零模型，不重审计）；门槛未变。

### 5.3 Deviation D2（真实 E1 run 失败）

首个 run 在 `plan.improvement` 两次尝试均报「输出的 JSON 不完整（对象未闭合）」（84 s / 44 s），in-process runtime 不持久化原始输出，
检测器无法区分长度截断与结构损坏——根因**不可确定**。处置：最小诊断（同一错误类 / kind，stage 错误附输出长度与末尾 160 字符）；同一项目恰 1 个新 run
（import.parse 仅在无 main.tex 时重建——稿件 / 审计 / 计划 / 决策不变）。新 run 的 plan.improvement 一次成功（5 条：2 modify + 3 author_decision），
故诊断信息本轮未被触发。

## 6. Phase E：真实模型验收

### 6.1 DEV（允许调参；M15.18 S2 只读副本）

审计 4 次物理调用（含 1 次解析重试）：8 个子缺口 / 5 个贡献（3 个贡献含混合需求）→ **REWRITE_ELIGIBLE 3**（internal_evidence 2：C4「CNNs are essential…」
↔ SEC34/SEC35；C3「For a fair comparison…」↔ SEC34；prior_work_verified 1）· 需实验 1 · 需补证据 4。同一论文 M15.18 两次审计：0。DEV 后无需调参，代码冻结。

### 6.2 E1 选样（冻结规则，导入前冻结 oracle）

arXiv API `cat:cs.CV AND abs:"multi-object tracking"` 降序 40 条（排除 2609.08265），按序筛查：#1 TQC、#2 AUSPEX、#3 DSATrack 声称与表格一致（不满足）；
**#4 arXiv:2610.23125v1（RCA-MOT）选定**（共筛 4 篇；arXiv 非排他分发许可，私有存放）。Oracle（ORACLE.md sha256 c5ea6443…）：
O1 摘要「sets new SOTA results」vs Table I DetA / MOTA 未超 PFTrack + 正文「without corresponding increases in DetA and MOTA」；
O2 摘要 / 引言「improving the previous best HOTA by 5.402…」混用 YOLO-RGBT 与 PFTrack 检测口径 + 正文「Cross-method benchmark results may differ in detectors」。
两者合法修改均要求**数字不变**。重建损失：7 个章节文件；参考文献只解析出 2 条、映射 5 处引用；封面 + 摘要原文重复在 sec01；行尾连字符保留。

### 6.3 E1 审计与计划（真实）

审计 3 次物理调用 / 90 s：5 个抽取贡献中 4 个 claimQuote 不可回放被丢弃（anchorFailures=4，如实计数）；保留贡献 C2 下 4 个子缺口：

| 子缺口 | 类型 | 确定性分类 | 依据 |
|---|---|---|---|
| ta-sg-34ced22fcb | INTERNAL_CLAIM_MISMATCH | **REWRITE_ELIGIBLE(internal_evidence)** | 目标锚（摘要）「improving the previous best HOTA by 5.402/6.075 points and IDF1 by 11.549/12.789 points, respectively」↔ 证据锚 SEC11「…with PFTrack detections achieves 45.042 HOTA and 57.108 IDF1, exceeding the highest prior values listed by 3.312 and 9.798 points」+ UniRTL 句；**与 O2 一致（系统未接触 oracle）** |
| ta-sg-17affc957e | PRIOR_WORK_COMPARISON | NEEDS_TARGETED_EVIDENCE | 无 pool 可解析 + quote 回放 + 已被引用的先前工作 |
| ta-sg-2be4b027d4 | EXPERIMENT_OR_AUTHOR_INPUT | NEEDS_REAL_EXPERIMENT | 学习型可靠性模块对照缺失 |
| ta-sg-750ed138de | UNCERTAIN_OR_MISSING_EVIDENCE | NEEDS_TARGETED_EVIDENCE | 缺 PFTrack / UniS-MOT 全文 |

D1 修复后投影：`abstract`（abstract-carrier+quote-replay，alsoFoundIn sections/sec01.tex）。浏览器（CDP，vite :5178）逐项点击批准 4 项（代理测试性批准，
隔离测试项目）；后端计划 decided：1 条 pending 改写指令（section=abstract）+ 3 条 AUTHOR_DECISION_REQUIRED。

### 6.4 真实执行与逐字 diff

rerun w-9913d910d1d4：plan.improvement（5 条）→ plan_confirm（预登记 revise 反馈 → approve）→ revision.apply（rev 2）→ revision.plan / revise（rev 3）→
validate → review → quality.gate r3 / r4 → `hitl.revision_overflow`（停）。

**摘要（outline.abstract → main.tex \begin{abstract}）目标句 before → after：**

- before：「… RCA-MOT sets new SOTA results on VT-MOT and UniRTL, improving the previous best HOTA by 5.402/6.075 points and IDF1 by 11.549/12.789 points, respectively, while post-hoc analyses further validate reliability as an informative control signal. Code will be released upon acceptance.」
- after：「… Under a single detection setting, RCA-MOT exceeds the highest prior values on VT-MOT and reproduced prior baselines on UniRTL by 3.312/6.075 HOTA points and 9.798/12.789 IDF1 points, respectively. Code will be released upon acceptance.」

同一摘要写入中的**越界改动**（未被审计指令授权）：删除「The individual components are intentionally simple, focusing evaluation on … learned reliability-estimation modules.」
（恰为需实验子项的目标句）与「while post-hoc analyses further validate reliability as an informative control signal」；删去「and multimodal information integration」；
前几句合并改写、en-dash→连字符、去除 PDF 换行。

对照 oracle：O1「new SOTA」笼统声称被移除并限定比较口径 ✓；O2 口径混用被纠正 ✓；**「数字不变」✗**（5.402→3.312、11.549→9.798，由 Planner 条目
improvement:1「把旧值 5.402/6.075 改为 3.312/6.075…」授权、plan_confirm 代理批准后事实守卫按授权放行）；**范围 ✗**（两句无关删除）。
引言同类句（sec01:236「surpasses the previous SOTA by 5.402/6.075 HOTA」）**未改**（Planner improvement:2 无落盘结果）；sec01 内封面 + 摘要副本未改（重建副本，如实列出）。

**指令 lineage**：x-620aab7c7d handled；planItemOutcomes `external:x-620aab7c7d applied abstract @rev2 e8d10791→48487328`；resolutionTrace fact ✓ citation ✓。
**复评**（两次一致）：ta-sg-34ced22fcb VALIDATED_FIXED（lineage / 目标绑定 / 内容变化 / 未回退 / 守卫全 ✓）；其余 3 项 NEEDS_AUTHOR_DECISION。
**守卫证据**：gate r3（覆盖 rev 2 = 摘要落盘修订）pairwise 事实 ✓、引用 ✓、**累计事实 ✓**；复评引用的是 r4（覆盖 rev 3）的 pairwise 事实 / 引用 ✓——
r4 累计事实 ✗ 来自 sec02 / sec03 的编号「2.」漂移，不在摘要。（精度注记：文件级 lineage 的守卫证据宜取覆盖 lineage 修订号的那一轮并同时要求累计口径，列为后续。）

**共享修订尾段的其它落盘改动**（review 驱动，非审计条目）：sec02 PDF 乱码数学字形清理 + 「Cose→Cost」，但一处乱码公式被改写成「Cw = Cw + ∆C」
（语义疑似改变，公式守卫未识别乱码字形）；sec02/03 编号「2.」移动（r4 累计守卫拦截）；sec05 增加「as specified in \cite{ref1}」（既有 key）；
sec07「showed that」→「are designed to evaluate whether」并删去一行「D. Reliability Validity」；sec01 引言句增加「two RGB–infrared MOT benchmarks」。

### 6.5 负例（E2；来源逐条标注）

| 负例 | 结果 | 来源 |
|---|---|---|
| 同贡献可改写 + 需实验 / 需补证据 | 改写子项落盘；其余 3 项 AUTHOR_DECISION、零派发、零造数 | **真实 E1** |
| 换稿 / 修订号前进 → 409 | 重新生成计划 409 TARGET_AUDIT_STALE；决策 409 TARGET_AUDIT_STALE；审计 stale=true | **真实 HTTP（E1，rev 1→3）** |
| flag off | GET ×3 enabled:false；POST evidence-audit / revision-plan / reassess 403 | **真实独立进程 :3119** |
| PDF-only / 无唯一锚 → UNMAPPABLE | 零伪改动 | 回归（atomicSubGaps「pdf-only target」）；M15.18 N1 真实 |
| 比较型缺可回放先前工作 | NEEDS_TARGETED_EVIDENCE + 缺失来源清单 | **真实 E1**（ta-sg-17affc957e）+ 回归 |
| 跨文件 lineage / 目标被回退 / 摘要被恢复 | 非 VALIDATED_FIXED | 回归（atomicSubGaps ×2） |
| Writer 改数字 / 删引用 | 候选级拒绝 | 真实回放 21 候选 + 回归 |
| 拆条 / 候选拒绝 / 塌缩 / 重试 | 无虚假 handled | M15.18 回归套件（全绿） |

### 6.6 UI 与报告（G5）

浏览器真实点击「复评闭环」与「生成投稿准备度报告」：分组「已改（机器可证）1 · 需真实实验 / 作者决策 1 · 需补文献 / 定向证据 2」，条目逐项显示子缺口类型、
所属贡献、只读证据锚、缺失来源、证据门 ✓✗ 与 lineage。截图私有保存（e1/ui/*-10/11/20-*.png）。

## 7. 验收门

| 门 | 结论 | 依据 |
|---|---|---|
| G1 原子 gap | **PASS** | v2 解析 + 确定性守卫 + 稳定 id + 父贡献；DEV / E1 真实输出均同贡献多子项；v1 兼容（单测 + 旧工件计划） |
| G2 确定性分类 | **PASS** | 内部弱化型 vs 比较型严格区分（单测矩阵 + DEV 0→3 + E1）；无证据不放行；需实验永不派发 |
| G3a 真实条目闭环 | **PARTIAL** | 机器闭环成功（VALIDATED_FIXED，真实 lineage + gate）；oracle「数字不变」与授权范围不满足 |
| G3b 工作流终态 | **PARTIAL** | revision_overflow；gate r4 FAIL（累计漂移 2、blocking 1）；共享尾段一处公式类改写未被拦截 |
| G4 防假成功 | **PASS（附缺口）** | 枚举负例全过；新缺口：审计指令「不得改数字 / 只改目标句」未被确定性执行——Planner 授权条目与整段摘要路径可越权，复评仍判 VALIDATED_FIXED |
| G5 UI / 报告 | **PASS** | 真实点击；四类分组；前后证据 |
| G6 工程 | 见交付说明 | 后端全量 / 前端全量 / 双端 typecheck + build / diff --check；CI + Linux Integration 以最终提交为准 |
| G7 Git / 证据 | 见交付说明 | main 直推快进、无强推；私有 MANIFEST.json SHA256 |

## 8. 数据、调用与费用

- 物理模型调用 **60 / 120**（0 失败调用；plan.improvement 两次「输出不可解析」计为完成调用）：DEV 审计 4 · E1 连通 1 · E1 审计 3 · 首个 run 16（含 2 次失败的 Planner）·
  rerun 36。模型 `zai-coding-cn/glm-5.3`（Z.AI Coding Plan 订阅）。run 账本 token：输入 335 140 / 输出 83 685；list price 估算 ≈ $1.29（run）+ 审计少量，订阅计费。
- 时长：首个 run 至暂停 496 s；E1 审计 90 s；rerun 至 overflow 832 s。
- 私有数据 `D:\PaperTeamData\M15\M15_19\`：PROTOCOL / RUNLOG（D1 / D2）/ 选样与 oracle / 审计与计划工件 / 修订前后快照 / 指令与 patch / gate / 复评 ×2 /
  UI 截图与 innerText / 负例 / 回放与复现 / MANIFEST.json。PDF、模型输出、项目工件、截图不入公开仓库。

## 9. 下阶段（仅真正未解决问题）

1. **审计指令禁止项的确定性执行**（G3a 未过的直接根因）：target_audit 改写的「不得改变既有数字 / 只改目标锚」须在派发端与落盘后裁决中强制——
   Planner 条目的数值变更授权不得覆盖审计指令禁止项；摘要等整段目标需目标句级范围守卫（目标锚外文本逐字保留）；违反 → candidate_rejected、不 handled。
   同时收紧审计 prompt 的 proposedDirection（禁止建议替换数字）。需新冻结真实样本验收。
2. 文件级 lineage 的守卫证据取「覆盖 lineage 修订号」那一轮 gate，并要求累计口径同时 PASS。
3. 共享修订尾段：PDF 乱码数学字形被改写时公式守卫不识别；编号漂移；在审计定向修订场景下应可限制尾段范围。
4. PDF 重建：封面 + 摘要副本留在 sec01、行尾连字符、IEEE 参考文献只解析 2 条；审计 claimQuote 4/5 不可回放。
5. Planner 结构化输出失败的原始输出持久化（D2 诊断只附长度与末尾）。
6. 引言同类口径句与摘要不同步（Planner 子条无落盘结果未进入复评开放子条统计）。
