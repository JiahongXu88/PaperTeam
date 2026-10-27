# M15.8.3 补充任务 — Quality & Efficiency Audit（A–D）

- 日期：2026-10-27；HEAD 基线 `106592f`（审计分析）→ `de988bd`（含披露指引修复）
- 数据：`D:\PaperTeamData\M15\M15_8\M15_8_3\additional-audit\`（机器可读产物 taskA/B/C/D*.json）
- 口径：全部零模型（冻结产物 + 既有回放报告 + 代码审计）；M15.8.3 两段 run 的 r10-r14 产物在 run 终态后读取（终态 completed/failed 之后不再变化）；**区分已测量事实 / 日志推断 / 未验证假设**（各节标注）。

## A. Quality Gate 全规则审计（r9 冻结口径 + 代码级）

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| A1 | required verification 未执行 | **无**。r9 NOT_EVALUATED 仅 2 条（cross_section_numeric_consistency=NO_TABLES、target_feasibility），均 required=false 非阻断且如实标注「不代表通过」 | taskA-rule-audit.json |
| A2 | Finding 与证据不一致 | r9 三条 academic major 与证据库状态**一致**（S002 §5 指标专章存在、像素指标确未展开、app-scenarios 双源单薄均属实）；未发现凭空 finding | review-r9-* + sources/chunks/S002 |
| A3 | Rule 4/5/6 重复计数/归因 | 归因排除方向正确（同根因 major 去重：summary openMajor 4 → gate 计 3，明示「排除同根因 1 条」）；rule 4 按 opaque/transparent 分层计数与 M15.6 契约一致 | gates.ts L623-706 代码审计 + r9 gate |
| A4 | 已修复 claim 持续影响 | **发现（非 bug，死锁表现）**：65,213 finding 连续复发 6 轮（r2-r4、r7-r9）——数值冻结守卫 vs 删除指令的死锁使 finding 无法消失；E018 绑定后 r10 起 finding 消失（正确行为） | taskD-depth caseAnalysis |
| A5 | 陈旧产物误用 | 代码级确认：gate 消费**同轮** claim-grounding（`loadClaimGrounding(review.round)`）；citation.verify 每轮重跑；每轮 claim-grounding 现场重算。未发现跨轮错配 | definitions.ts L1807 + 事件序列 |
| A6 | policy_aware 语义 | ADVISORY（style 55>35）不阻断、分数照常呈现；academic_score PASS 走 policy 臂。与 M15.7 语义一致 | r9-r14 gate 产物 |
| A7 | 三态分层 | published 只读=ASSESSMENT_*（shadow replay 111/111 无 FALSE_READY）；本轮全部 author_manuscript 语境；Draft/Final 分离正确（QUALITY_NOT_REACHED 下 Finalize 不可达，Draft 合法构建） | m158-r-shadow-replay aggregate + 本轮两段 run |
| A8 | NEEDS_VERIFICATION 项 | r10-r14 的 claim 重抽措辞漂移（16→19→17→18 条波动）对 rule 4 计数的净影响**无法只读判定**（需逐 claim 对照原文措辞——已抽样 7 条确认非重复计数，但未全量） | 标记为 NEEDS_VERIFICATION |

## B. 历史缺陷回归与对抗测试矩阵（7 族，全部零模型）

| 缺陷家族 | 输入 | 预期 | 实际 | 判定 | 证据 |
|---|---|---|---|---|---|
| published 只读分层 | 111 completed run 零模型重放 | 全 ASSESSMENT_INCOMPLETE / REMAIN_BLOCKED、0 FALSE_READY | A22/B44/C45 全 REMAIN_BLOCKED；identity/monotonicity 违规 0；modelCalls=0 | PASS | evaluation/m158-r-shadow-replay-report.json |
| 引用 key 损坏（N2） | bib key +x 后缀（双向 sha256） | missing=1 → structure FAIL → Finalize 422 | gateFailed/finalizeRefused/targeted/zeroModel 全 true | PASS | evaluation/m158-n2-report.json |
| 数值矛盾（N1 零模型腿） | HOTA 0.801→0.877 结论侧翻转 | fact_preservation 拦截 → FAIL → 422 | 全 true（fresh reviewer 检出腿未跑——P 未 PASS 无干净基线，**不冒充**） | PASS（零模型腿） | evaluation/m158-n1-report.json |
| Gate 双入口一致性 | 冻结产物 workflow vs POST 重评 | 20/20 规则全等 + Finalize 确定性 422 + Draft 字节级一致 | 达成 | PASS | evaluation/m158-g7-report.json |
| **跨语言 claim↔chunk** | 中文 claim × S025 英文摘要（词面零命中） | 锚回落 → 三段核验 → verified | **E018 verified judge=supported（生产管道实证）** | PASS | M15_8_3 preground + E018 + 单测 8 例 |
| 全文恢复后 basis 失效 | 15 篇恢复后快照 abstract_only | 不悄悄进基线；需显式 refresh | refresh 18 条目失效 revision+1；本轮 G7 指纹恢复路径合法消灭级联 | PASS | M15_8_2 phase-a + 本轮预登记 §1.3 |
| HITL 待决 Finalize 阻断 | Gate FAIL 下 Finalize | 422 不绕过 | M15.8 实测 422；本轮 14 轮 FAIL 期间 Finalize 不可达 | PASS | M15.8 报告 + 本轮事件序列 |

**回归结论：未发现历史缺陷回归。** 本轮新增修复（R5/D-2/披露指引）均有生产实证且未翻转任何既有锚。

## C. Runtime/Harness 成本与效率（已测量事实）

三账本合并（M15.8 94 + tail 72 + M15.8.2 32 = 197 调用，$4.93 list；ping 剔除；M15.8.3 p40 单列）：

| Stage | 调用 | 占比 | in-Tok | out-Tok | cacheRead | list-$ | 占比 | 失败 |
|---|---|---|---|---|---|---|---|---|
| **revision.revise(writer)** | **59** | 29.9% | 653k | 33k | **7.29M** | **$2.96** | **60.0%** | 0 |
| review.run 三路合计 | 31 | 15.7% | 403k | 53k | 735k | $0.99 | 20.0% | 4 |
| survey.synthesis | 26 | 13.2% | 60k | 8k | 753k | $0.32 | 6.4% | 0 |
| survey.matrix | 27 | 13.7% | 57k | 9k | 634k | $0.28 | 5.7% | 0 |
| writing.sections | 20 | 10.2% | 91k | 11k | 335k | $0.26 | 5.3% | 1 |
| citation.audit/verify | 28 | 14.2% | 21k | 3k | 71k | $0.06 | 1.2% | 0 |

- **修订循环 = 60% 成本**（日志推断：同批 finding 跨轮重派 + 逐节上下文重建致 cacheRead 124k/调用）。
- **无进展环实测**：w-d00409085580 4 轮 gate 全 FAIL；M15.8.3 r10→r12 三轮 plan 全 validated 而阻断不动（fixed-point 实证）——convergence 检测器（REGRESSED/STALLED）按设计触发，未失控烧预算。
- 失败重试归因（已测量）：5 次模型失败（fact×2/academic/style/writing 各 1）+ 1 次配置失败（M15.8.3 preground 模型 env——脚本缺省回落到未注册模型，属 harness 工程错误非模型失败）。
- 预算层：无重复扣费证据（reserve/settle 对账一致）；拒付 2+3 次如实入 stops。
- 定向 vs 全量（部分测量/部分推断）：定向补证 3 claim=3 调用（本轮实测）；全量级联 ≈55-80（**推断**，未执行）。
- **三个最值得实施的优化**（假设，未验证）：① writer 修订上下文增量复用（同 finding 跨轮的 section 级缓存，削 7.3M cacheRead 大头）；② fact reviewer 的 claim 抽取锚定（对已 transparent/SUPPORTED 的既有语句降权重抽，抑制措辞漂移重抽）；③ needsEvidence 指令直接点名剩余 claim 全集（本轮逐轮 1 条的收敛速度 → 一轮批量披露）。

## D. 真实论文质量纵向分析（r1→r14）

轨迹（unsupported/claims、gate major）：r1 9/17·5 → r2-r4 11/19·3（平台期）→ r5 4/12·7 → r6 2/11·3 → r7 5/14·9（污染+重抽）→ r8-r9 4/16·4 → r10 8/19·7（拆分变细）→ r11 7·4 → r12 7·3 → r13 6·3 → **r14 5 opaque + 1 transparent · 2**。

四类区分（taskD-depth.json）：
- **真正解决**：B1 65,213（E018 verified 绑定，数值保留非删除）；B3 结论趋势（r7 弱化后不再复发）。
- **表述已修/演化为深度缺口**：B4「无中立梳理」（事实误述已修；r9+ 演化为内容深度 major——不同 finding，需语料升级或披露口径）。
- **未解决（出口已打通）**：B2 gad 枚举与其余 4 条 opaque（披露机制 r14 首证 1 条走通）。
- **评价噪声**：claim 重抽措辞漂移（16↔19 波动）与审稿拆分粒度变化贡献了 r7/r10 的计数回弹（抽样 7 条确认非重复计数；全量对照 NEEDS_VERIFICATION）。
- Evidence：17→19 条（+E018 direct、+E019 partial）；引用 15/15 持续全绿；Draft 链 rev5→rev12→rev14（Build PASS）。

## 交付状态

- A/B/C/D 机器可读产物：`additional-audit/taskA-rule-audit.json`、`taskB-adversarial-matrix.json`、`taskC-stage-cost.json`、`taskC-depth.json`、`taskD-longitudinal.json`、`taskD-depth.json`。
- 本报告零模型；不替代 P 的 PASS+Final 验收（见主报告 `M15_8_3_QUALITY_GATE_REAL_FINAL_CLOSURE.md`）。
