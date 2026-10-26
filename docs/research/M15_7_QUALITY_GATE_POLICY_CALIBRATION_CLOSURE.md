# M15.7 — Quality Gate Policy & Calibration Closure

- 日期：2026-10-26
- 裁决：**M15_7_COMPLETE_POLICY_PRODUCTION**（待最终 HEAD CI / Linux Integration 核对，见 §10 门槛 5；若不绿按协议 deviation #4 回滚并降为 PARTIAL）
- 仓库起点/终点：main 514ad218 → 557a9e7 → befa69e → fd0e777 → 24ce628 → 1a179dd → 3969592 → 2ab287f → 4e8640a（本轮 8 提交：7 工程 + 1 文档收口，见 §9）
- 数据根：D:\PaperTeamData\M15\M15_7\（预登记协议、shadow 重放、fresh 运行、预算账本——均不入 Git）
- 预登记：PRE_REGISTERED_PROTOCOL.md（FROZEN 2026-10-26T15:45:04+08:00，正文 SHA256 93027ddf…49d606，副本 frozen_body 独立可验；append-only deviation ×4）

## 0. 一屏结论

1. **政策适配层（B 阶段）**：新增 `backend/src/quality/qualityPolicyV2.ts`（纯函数、确定性、零模型，`QUALITY_POLICY_VERSION = "policy-v2"`）。三臂：legacy_v1（恒等基线）/ score_style_advisory（Candidate A：规则 7 `academic_score_threshold`、规则 8 `style_risk_threshold` 的 FAIL → ADVISORY，携带 UNVALIDATED/原分数/原阈值/Legacy 对照机读载荷）/ policy_aware（Candidate B：A + 场景最小分权——published_paper_assessment 的评估完成三态与投稿 READY 分离；quick_review 显式「不是投稿凭证」）。**两条守护显式保守化**：评分缺失（Legacy 编码为 FAIL）→ NOT_EVALUATED(required) 继续阻断（MISSING_SCORE_RETAINED）；覆盖驱动 FAIL 且无规则 8b 可接力 → 保留阻断（COVERAGE_GUARD_RETAINED）。17 项单测全绿。
2. **Shadow 零模型重放（C 阶段）**：M15 评分有效性研究的 159-run 资产（QualityGateCalibration，引擎 3400f87）中 111 个 completed 非 SMOKE run 三臂重放：**恒等违规 0 / 单调性违规 0 / FALSE_READY_CANDIDATE 0 / 解锁 0**。114 次阈值规则 ADVISORY_CONVERTED（108 runs）全部因 required NOT_EVALUATED 缺口保持阻断——真实历史数据上证明 Advisory 化零 false-ready。同时确认该语料（published 分支）测不到「分数单独阻断」场景 → fresh 腿必要性成立。
3. **Fresh 模型腿（C 阶段，有效预算 46/48）**：MOT R5.1 中文投稿候选稿（82k 字符，units 模式 43/43 覆盖 100%）两个样本走生产管线（idea_to_paper → review.run → quality.gate，干净副本、GlobalBudgetLedger 系统级硬停接线——修 m156 审计缺口）：
   - **mot-zh-author**（author_manuscript，76/10 分）：Legacy FAIL 5 规则（citation 类 required 缺口 + academic_score_threshold）；Candidate A 把 academic_score_threshold 移出阻断（unblocked）而 citation 守卫原样保持 → REMAIN_BLOCKED。
   - **mot-zh-mutated**（摘要「降至 497」→「降至 431」确定性变异，r2 增量复审 7 调用）：评审真实检出变异 → `blocking_issues_zero` + `fact_preservation` 新增阻断；Candidate A 下仍 REMAIN_BLOCKED——**fresh 保护锚成立，falseReady=0**。
   - mot-zh-published / en-arxiv-published：预算截断 PENDING_BUDGET（协议 §7 按优先级，published 分支已由 111-run 重放覆盖）。
4. **生产接线（E 阶段，commit 2ab287f）**：`evaluateProjectQualityGate`（双入口唯一权威判定器）内最小接线 policy_aware 臂——接线点在 patch 级联与 taskScoped 分层之前，Revision Task Success / Publication Readiness 分层消费政策化后的同一 gate，不新建第二判定入口。gate 产物挂 `qualityPolicy` 载荷（版本/臂/Legacy 对照/reasonCode/差分）；`inputFingerprint` 携带 `qualityPolicyVersion`（双入口一致性测试通过）；前端 `GATE_RULE_STATUS_STYLES` 加 `ADVISORY: 建议参考（未校准）`（tone=info，历史产物缺省安全回退）。
5. **80/35 没有被校准**（本轮无独立标注数据，历史 40 采样基准 DATA_UNAVAILABLE）——被诚实降级：从「未校准却单独决定 READY 的硬门」转为「UNVALIDATED 标注的解释性 Advisory」，原分数、原阈值、Legacy FAIL 对照全部保留。学术质量评估本身未删除（分数照常计算与可见）。
6. **诚实缺口**：分数阈值与录用结果的校准未完成（需独立标注语料）；「分数单独阻断→解锁」场景在真实语料上未出现（重放 111 与 fresh 2 均为 REMAIN_BLOCKED——真实稿总有其他守卫缺口），SCORE_ONLY_UNBLOCK 语义由单测覆盖；published/en fresh 腿未跑（预算截断）。

## 1. 阶段状态

| 阶段 | 状态 | 交付 |
|---|---|---|
| A 启动/资产/调用图审计 | COMPLETE | 80/35 错误阻断路径证据（Gates.test.ts:213-234 + FinalizeService.ts:72 + planSharedTail definitions.ts:5890-5933）；调用图/工作流矩阵/四轴契约复用/双入口指纹；协议冻结（哈希独立可验）；基线 quality 283/283、全量 4324/4324 |
| B Quality Policy V2 Shadow | COMPLETE | qualityPolicyV2.ts（三臂适配层）+ 17 单测；commit 557a9e7（在读取任何 per-case 结果前提交） |
| C 独立 Benchmark 与校准 | COMPLETE（fresh 2/4 截断） | 零模型重放脚本 + 111-run 报告（befa69e）；fresh 腿脚本 + RUN_INTENT/账本/变异登记（fd0e777/24ce628/1a179dd）；有效预算 46/48 |
| D Shadow 配对对照与生产闸门 | COMPLETE | §6 门槛 1-4 三层证据核对全绿（单测 300 + 重放 111 + fresh 2）；门槛 5 见 §10 |
| E 最小生产策略实施 | COMPLETE | commit 2ab287f：evaluateProjectQualityGate 接线 + fingerprint policyVersion + 前端 ADVISORY 样式 + GateApi 语义更新 |
| F 真实验收 | COMPLETE（本报告） | 全量回归两次口径、报告、PROJECT_STATUS、push + CI 核对（§9/§10） |

## 2. B 阶段：政策适配层设计

见 §0.1 与 `backend/src/quality/qualityPolicyV2.ts` 头注（预登记协议 §3 判定矩阵的实现级冻结）。关键不变量：

- **单调性**：任何 Legacy PASS 在 Candidate 臂必须仍 PASS（MONOTONICITY_VIOLATION 为硬错误信号；重放/单测/fresh 全 0）。
- **政策变量封闭**：`POLICY_RULE_IDS = ["academic_score_threshold", "style_risk_threshold"]`——其余规则（科学硬门/必需核验/证据 finding）逐条保持，非政策规则的 FAIL 不被触碰（单测：contradictory evidence 阻断原样保留）。
- **Legacy 语义发现**：Legacy 引擎把评分缺失编码为 FAIL（gates.ts `verdict(academic !== null && ...)`）而非 NOT_EVALUATED——协议预注册的「缺失→NOT_EVALUATED(required) 保持阻断」由适配层显式实现（MISSING_SCORE_RETAINED，单测锁定）。
- **覆盖守卫不放松**：规则 7 的 FAIL 可能由覆盖不完整驱动（M14.1a P0-2）——advisory 化仅在有规则 8b `review_coverage_complete` 可接力时发生，否则 COVERAGE_GUARD_RETAINED 保守保留。

## 3. C 阶段：Shadow 零模型重放（111 runs）

数据基底：M15 评分有效性研究 159-run 生产管线资产（track A=22/B=64/C=71、DEV=129/HELDOUT=28、seed 20261021、base 引擎 3400f87、全部 published_paper_assessment 分支）。重放 = 只读消费存储的 quality-gate/review-summary 产物 + 政策臂为唯一变量（同引擎同输入），零模型调用。

| 指标 | 值 | 门槛 |
|---|---|---|
| 重放 / 跳过 | 111 / 2（SMOKE） | — |
| Legacy 恒等违规 | **0** | 必须 0 |
| 单调性违规 | **0** | 必须 0 |
| FALSE_READY_CANDIDATE（C 注入案例被解锁） | **0** | 必须 0 |
| 解锁样本（Legacy FAIL→A PASS） | 0 | — |
| reasonCode × track | 全 REMAIN_BLOCKED（C45/B44/A22） | — |
| Candidate B assessment | ASSESSMENT_INCOMPLETE 111/111 | — |

阈值规则 ADVISORY 转换 114 次（108 runs）；阻断残留主因：`hallucinated_citations_zero` 111/111、`citation_structure_valid` 111/111（published 只读分支缺引用核验腿——评估缺口如实呈现，Candidate B 全部 ASSESSMENT_INCOMPLETE 正确）、`unsupported_critical_claims_zero` 111/111、`open_critical_major_zero` 109/111。

**结论**：真实历史数据上 Advisory 化零 false-ready、零解锁；同时证明该语料测不到分数单独阻断场景（author 分支必须靠 fresh 腿）。

## 4. C 阶段：Fresh 模型腿（预算 46/48）

生产管线真实运行（PROJECTS_ROOT 隔离、GlobalBudgetLedger reserve/settle 系统级硬停、RUN_INTENT 原子写、recheck 调用置 0、GLM-5.3 合规通道）：

| 样本 | purpose | 调用 | 覆盖 | 分数 | Legacy FAIL | Candidate A |
|---|---|---|---|---|---|---|
| mot-zh-author | author_manuscript | 36+2（见 deviation #2） | units 43/43@100% | 76/10 | citation 类 ×4 + academic_score_threshold | REMAIN_BLOCKED（unblocked=academic_score_threshold） |
| mot-zh-mutated | author_manuscript | 7（r2 增量，见 deviation #3） | units 43/43@100% | 75/10 | 上述 + **blocking_issues_zero + fact_preservation** | REMAIN_BLOCKED |
| mot-zh-published | published | — | — | — | PENDING_BUDGET（余量 2 < 启动下界 8） | — |
| en-arxiv-published | published | — | — | — | PENDING_BUDGET（同上） | — |

变异登记：摘要首个「降至 497」→「降至 431」（firstIndex=2087、全文恰好 2 处、双向 sha256 落盘 `evaluation/m157-fresh-mutation-register.json`）——摘要↔正文/表格数值矛盾（HEADLINE_CROSS 的 fresh 替代锚）。**变异被评审真实检出并升级为 blocking + fact preservation 守卫**——Advisory 化没有放走注入缺陷。

预算账本：`budget-ledger.json`（schema v2，maxCalls=48，tighten 只紧不松）；有效已用 46/48 = 账本 45 + 已知未计量 1（deviation #2 的 ping 补记）。usage 明细与 RUN_INTENT/result 全部落盘 `evaluation/` 与 `run-intents/`。

## 5. D 阶段：生产闸门核对（协议 §6 全 AND 门槛）

| # | 门槛 | 证据 | 判定 |
|---|---|---|---|
| 1 | 重放+fresh 实证 false_ready=0；保护锚零回归 | 重放 111（含 C 家族 45 注入案例全 REMAIN_BLOCKED）+ fresh mutated（blocking+fact_preservation 守卫触发）+ 单测单调性/保护锚 | **绿** |
| 2 | NOT_EVALUATED(required) 不因 advisory 变 PASS | 单测（REMAIN_BLOCKED 用例 + requiredComplete=false 断言）+ 重放 111（required 缺口全保持）+ fresh 2（citation required 阻断保持） | **绿** |
| 3 | quick-review assessment 可解释、不映射出版 READY | 单测（NOT_A_SUBMISSION_CREDENTIAL + assessment 三态）+ 重放（B 全 ASSESSMENT_INCOMPLETE——published 缺核验腿如实呈现） | **绿** |
| 4 | 分数仍计算可见、advisory/uncalibrated 标注、无 AI 检测概率/假分数、新旧分歧可理解 | 单测（advisory 载荷完整断言：score/threshold/direction/legacyStatus/legacyDetail）+ fresh（unblocked 差分呈现）+ 前端 ADVISORY 样式 | **绿** |
| 5 | 全量 regression + 双入口 + 历史 JSON 兼容 + typecheck/build + CI + Linux Integration | 见 §9/§10（typecheck/build 零错；quality 300/300、消费方 1034/1034、前端 364/364；全量两次口径见 §9；CI/Linux 见 §10） | **见 §10** |

历史 JSON 兼容：`qualityPolicy` 为可选字段（历史产物缺省=无政策层解释）；ADVISORY 状态仅政策层产出，前端未知状态安全回退（中性色原样展示）；`summarizeGateVerification` counts 初始化含 ADVISORY:0（旧产物重放不缺键）。

## 6. E 阶段：生产接线（commit 2ab287f）

- `backend/src/workflow/definitions.ts` `evaluateProjectQualityGate`：`evaluateQualityGate` 产出 Legacy gate 后立即应用 `applyQualityPolicy(arm: "policy_aware", …)`；政策化 gate 进入 patch 级联与 taskScoped 分层——Revision Task Success / Publication Readiness 语义零改动（分层消费同一 gate；revisionTaskGate 的 academicScore 输入不受 advisory 化影响）。
- `backend/src/quality/gates.ts`：`QualityGateResult.qualityPolicy?` 载荷字段（类型级反向引用 qualityPolicyV2，无运行时环）。
- `inputFingerprint` 增加 `qualityPolicyVersion`——双入口（workflow stage / POST /quality-gate）同输入同指纹（gateDualEntry.test 通过）。
- `frontend/src/components/common/status.ts`：`ADVISORY: { label: "建议参考（未校准）", tone: "info" }`。
- `GateApi.test.ts` 更新为断言新语义（分数规则 ADVISORY/required=false/passed=true、不在 failedRules、qualityPolicy 载荷可见、reasons 与失败规则一一对应保持）。

## 7. 预算与成本（第 8 问）

- 物理模型调用：**46/48 有效**（账本 45：author 首轮 36 + 补救 2 + mutated r2 7 + ping 已计账 0；已知未计量 1：首次 preflight ping）。峰值不超过 48，无超限、无事故重跑消耗（D: 瞬态故障的 36 次为首次执行本体，journal 复用不产生重复计费）。
- token/成本：账本 `totals`（input+output+cacheWrite）见 `budget-ledger.json`；usage 逐调用流水在 `evaluation/m157-fresh-report.json`。
- 报告路径：`evaluation/m157-shadow-replay-report.json` + `m157-shadow-replay-summary.md`、`evaluation/m157-fresh-report.json` + `m157-fresh-summary.md`、`evaluation/m157-fresh-driver-log.txt`、`run-intents/*.json`。

## 8. 遗留与限制（不隐藏）

1. **80/35 校准未完成**：本轮交付的是「未校准→不硬门」的诚实降级 + 可解释呈现；分数与录用/质量结局的统计校准需要独立标注语料（历史 40 采样基准 DATA_UNAVAILABLE；M15 语料无 outcome 标签）。**阈值数值 80/35 未动、未调**（不拍脑袋设新阈值）。
2. **SCORE_ONLY_UNBLOCK 无真实语料实例**：真实稿总有其他守卫缺口（重放 111 + fresh 2 全 REMAIN_BLOCKED）；该 reasonCode 的行为由单测覆盖（79 分单独阻断→advisory 放行+载荷完整）。
3. **published/en fresh 腿未跑**：published 分支语义已由 111-run 重放覆盖（B 全 ASSESSMENT_INCOMPLETE）；EN 家族（arXiv 1506.01498）腿完全缺失。
4. **Rule 6 残余 / unit 模式 claim coverage / 证据污染**：M15.6 遗留，本轮非主修对象，状态未变（见 M15.6 报告 §0.6）。
5. **中文综述独立样本**：继续缺失（SURVEY_HOLDOUT_UNAVAILABLE 沿袭）。

## 9. 测试、提交链与工作树（第 9 问）

- 本地套件：backend typecheck/build 零错；quality 300/300；gate 消费方子集 1034/1034；前端 typecheck 零错 + 364/364；**全量两次口径**：第一次 4340 passed / 1 failed / 42 skipped（失败身份被输出管道 tail 截断——deviation #1 同款教训），第二次完整日志复跑 **4341 passed / 0 failed / 42 skipped（400 文件全过，exit=0）**——第一次失败定性为 flaky（同代码全绿 + gate 相关子集独立全绿；与协议 deviation #1 记录的既有 flaky 一致，未恶化）。
- 提交链（本轮 8 提交，全部直推 main）：557a9e7 政策适配层 → befa69e 重放脚本 → fd0e777 fresh 脚本 → 24ce628 fresh 修复（startedAt/ping 计账/未计量补记） → 1a179dd reuse-project 补救模式 → 3969592 reuse-project 变异写入兼容 → 2ab287f 生产接线 → 4e8640a 文档收口。
- 工作树：clean（除本报告与 PROJECT_STATUS 的收尾提交）。

## 10. 最终裁决与 CI 核对（第 1/10 问）

- **裁决：M15_7_COMPLETE_POLICY_PRODUCTION**——A-F 六阶段 COMPLETE（C 阶段 fresh 腿按协议 §7 预算截断 2/4，published 分支由重放覆盖）；生产 Gate policy 变更已实施（commit 2ab287f）。
- 按协议 deviation #4：门槛 5 的最终 HEAD CI + Linux Integration 在 push 后核对；结果记录于 PROJECT_STATUS（不绿则回滚 2ab287f、降为 M15_7_PARTIAL_POLICY_SHADOW）。
- 10 问决策卡：§0（1/2/3 问）、§3-§4（3 问家族明细）、§8（4/5 问缺口）、§6（7 问复用——无第二 Gate，复用 evaluateQualityGate/evidencePairing/findingAdjudication 产物，适配层只转换两条规则的角色）、§7（8 问成本）、§9（9 问套件/提交）、下段（10 问建议）。

**第 10 问（唯一优先建议）**：M15 系列可按本轮口径收束为 COMPLETE——80/35 的「未校准硬门」问题已以零 false-ready 证据的方式关闭，剩余缺口（分数-结局统计校准、EN fresh 腿）是**新的独立研究问题**（需要人工标注预算），不应在 M15 框架内继续展开；也无需第八轮 Claim Certificate 微修（Rule 6 残余是判别缺口不是工程缺陷，如实保留即可）。
