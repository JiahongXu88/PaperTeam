# M15.5 — Quality Gate Calibration & Real Paper Validation

- 日期：2026-10-25
- 裁决：**M15_5_PARTIAL**（A/B/C/D/E 完成；F=零生产代码变更的工程收口——证据不支持任何生产阈值/政策更改，按预登记输出 CALIBRATION_INSUFFICIENT 与 shadow 评测）
- 仓库起点/终点：main 1cd86f1 → 本轮提交（见 §9）
- 数据根：D:\PaperTeamData\M15\M15_5\（预登记协议、基准 manifest、19 个当前管线样本的原始数据、零模型重放、四轴审定、MOT 三路对照——均不入 Git）
- 原始基准数据复用：D:\PaperTeamData\M11_4_QualityGateBenchmark\benchmark-report.json（21 样本，10-06 管线）

## 0. 一屏结论

1. **Gate 80 分阈值无校准依据，本轮维持不动**：40 个独立采样（6 paper family × 2 轮管线）证明任何绝对分阈值都无判别力——80 分拒绝全部可接受中文稿同时放过一次合成退化稿；65 分拦不住任何东西。中文带 63-80 / 英文带 76-86 的语言分层稳定存在。
2. **Gate 的真实失效点在规则 4/5/6（finding 计数腿），不在分数腿**：40/40 样本 gate FAIL（含全部已发表论文与诚实真实稿）——「证据库空缺」被 fact reviewer 的 UNSUPPORTED 契约计成论断违规，语义上应是 NOT_EVALUATED。已发表论文的 blocking 有 44%-100% 是该工件。
3. **旧 Gate 对真实 MOT 论文的 FAIL 实质正确**：p-c923662f9c48 r3 零模型重建显示失败根因为真实缺陷（修订引入 unsupported claim、泄漏的【待作者确认】占位符、与作者自己已核验证据 E001/S003 的冲突、表间数值不一致），分层语义（revisionTask FAIL / publicationReadiness NOT_READY + 11 条基线继承风险）按设计工作。只有 74<80 与 38>35 两条是未校准阈值造成的不可靠拒绝成分。
4. **候选校准策略方向验证、实现未达标**：verification 轴分层（无 pairing 语境 NOT_EVALUATED 化 + 真实缺陷保持阻断）在 18 样本 shadow 重放中保持全部 15 个真实缺陷稿 FAIL（反例保护 ✓），但文本启发式不足以剥离已发表论文（1/9-0/6 通过）与诚实稿（0/2）的工件——合格实现必须消费生产已有的结构化信号（claimGrounding/findingAdjudication/claimCertificate），这是下一阶段方案。
5. **两腿分工实证**：确定性腿（citation.verify 对注入引用损坏 3/3 精确命中）与 LLM 腿（同节内数值矛盾 3/2 检出、证据冲突 6/6 检出）各有效；**跨节（摘要↔表）数值一致性是双盲区**（注入矛盾 0/2 检出）——已发表论文 Attention Is All You Need 的真实笔误（正文 41.0 vs 表 41.8）被同节检出能力抓到，证明该能力真实但边界明确。
6. **零生产代码变更**：本轮全部产出 = 1 个基准评测脚本（m114 的扩展）+ 本报告 + PROJECT_STATUS。无科学事实改写、未越过任何 HITL、生产 Gate 阈值/规则逐字节未动。

## 1. 阶段状态

| 阶段 | 状态 | 交付 |
|---|---|---|
| A 基线与追溯 | COMPLETE | 评分链/调用点/输入构造全链审计；预登记协议（评分前落盘）；MOT 数据清单（a3bec2a/a8cca9a 确认不在本机，latest.zip=acce88f2 是 R5.1 审查包非验收稿） |
| B 基准集 | COMPLETE（survey 场景 PARTIAL） | 6 family + 2 controlled_edit，40 采样，DEV/HOLDOUT 按预登记切分，泄漏控制声明 |
| C Academic Score 校准 | COMPLETE（结论=CALIBRATION_INSUFFICIENT） | 跨轮稳定性、语言分层、阈值判别力表、代理偏差检查 |
| D Severity/Scope/Gate | COMPLETE | 40 样本 blocking/critical 四轴逐例审定；规则 4/5/6 语义缺口定位；候选策略 shadow 重放 |
| E 真实 MOT 复验 | COMPLETE（M14.9.5.3/5.4 字节级复验 BLOCKED） | p-c923662f9c48 r3 零模型重建 + 三路对照 + R5.1 诚实稿当前管线采样（mot-r51） |
| F 工程收口 | COMPLETE（零生产变更） | 基准脚本入库、测试基线 308/308、报告、CI |

## 2. 门禁因果图（阶段 A 审计结论，file:line 以当前 HEAD 为准）

- 评分来源：ReviewerService 五维（问题定义/方法合理性/实验充分性/论证逻辑/写作质量，各 0-100，无分段锚点）→ overallScore 模型自报（缺失时等权平均兜底）→ digest 模式直接取 academic 路三选一；units 模式字符加权聚合。styleRisk 0-100 模型自报。severity/blocking 模型自报（published 只读口径有 rubric 注入但不回写）。
- 生产调用点：`evaluateProjectQualityGate`（definitions.ts:1731-2046）是唯一评估入口，workflow `quality.gate` stage 与 POST /quality-gate 双入口共用；Final 消费 gate.passed（planSharedTail definitions.ts:5848 + FinalizeService.ts:72）。
- 阈值链：DEFAULT_QUALITY_THRESHOLDS（80/35/true）+ env 覆盖 `QUALITY_ACADEMIC_PASS_SCORE`/`QUALITY_STYLE_RISK_MAX`（config.ts:645-654）——非纯硬编码，但无 API/run 级覆盖。
- 分层：revisionTaskGate 仅 existing_paper_improvement/review 启用（task_scoped）；existing_paper_review kind 不挂 qualityGateStage。
- 同根因去重：规则 5/6 按 rootCauseKey（unsupportedClaimIds ∪ claim-check:*）排除——M11.2.3/M14.9.5.4 已修，p-c923662f9c48 r3 实测排除 critical 6/major 10 无双计数。
- StyleRisk：**是硬阻断**（规则 8 required），非 advisory——V2 shadow 已将其 advisory 化但生产未消费。
- NOT_EVALUATED：M14.9.5.4 状态机正确（required NOT_EVALUATED → passed=false；308/308 测试含回归）。
- **语义缺口（本轮核心发现）**：规则 4 的 claimsEvaluated>0 → FAIL 路径与规则 5/6 的 finding 计数不消费「evidence pairing 缺失」信号；fact reviewer 的 prompt 契约在无 verified Evidence 时把关键论断标 UNSUPPORTED → 库空被计成违规。quick_review/published assessment/idea_to_paper 语境均受影响。

## 3. 基准集（阶段 B）

构成（BENCHMARK_MANIFEST.json，sha256 全固定）：
- **DEV_TUNE**：F1（真实返修中文 4 锚点：冻结基线 423CF0E0…/人工终稿/PT 候选/删表合成退化）、F2 ByteTrack、F3 OC-SORT（已发表英文）+ CE1（F3+摘要数值矛盾注入）/CE2（F2+2 引用 key 损坏）
- **FROZEN_HOLDOUT**：F4 StrongSORT（M11.4 轮已见的声明局限）、F5 Attention Is All You Need（**全新**，NLP 域，从未参与任何校准）、F6-MOT（R5.1 submission candidate 210b82ae…，真实诚实稿）
- 预测先落盘（evaluation/FROZEN_HOLDOUT_predictions.md）后开封（FROZEN_HOLDOUT_unsealed.md 逐条对照）

标签独立性：qualityClass 为构造性先验（文件来源），非模型评分；CE 缺陷为构造注入（MECHANICALLY_VERIFIED）；F1 科学缺陷层标注为单人 HUMAN_REVIEWED（局限如实声明）；不虚构 inter-rater agreement。已发表≠零缺陷（F5 的 41.0/41.8 真实笔误即证）。

**基准局限（如实）**：F2-F4 副本继承骨架项目（MOT p-d12dc28ad850）的 evidence store，reviewer 可查到无关领域证据并偶发误用（f2 一样本引用 E001 判 BYTE 机制冲突——跨域证据污染，两轮均现；对 U/C 计数的解读需扣除此因素，对已发表论文该因素方向=多报缺陷）。综述场景无新真实样本（surveyWriting 确定性规则有独立单测）。

## 4. Academic Score 校准（阶段 C）——CALIBRATION_INSUFFICIENT

稳定性（同稿重复 + 跨轮管线对照）：

| 锚点 | 10-06 管线 | 当前管线 | Δ |
|---|---|---|---|
| f1-human-final | 74/74/73（σ0.6） | 76/68（σ5.7） | −1.7 |
| f1-bad-notables | 74/63/80（σ8.6） | 72/68（σ2.8） | −2.3 |
| f2-bytetrack | 86/83/83（σ1.7） | 82/84（σ1.4） | −1.0 |
| f4-strongsort | 77/77/80（σ1.7） | 77/76（σ0.7） | −1.5 |
| f5-attention（新） | — | 81/86（σ3.5） | — |
| mot-r51（新） | — | 76/82（σ4.2） | — |

- 管线漂移全部在噪声内（预测的「>5 分需归因」未触发）；评分刻度 10-06→10-25 稳定。
- 语言分层：zh 63-80（n=21）/ en 76-86（n=21）——任何跨语言统一绝对阈值对一侧系统性失准。
- 阈值判别力（40 样本）：80→14/40（拒全部 zh 可接受稿 + 放过 1 次合成退化）；75→25/40；70→33/40；65→35/40（唯一被拒是 63 极值）。**无可行绝对阈值**。
- 代理偏差：删表退化稿（写作未变）63-80 与可接受稿重叠；注入数值矛盾后 77/77 vs 基线 80.3——分数维度对毁灭性科学缺陷几乎无响应，「写得好」权重过高。分数不能承担科学完整性判定（该职责应由 finding 层承担——本轮数据支持此分工）。
- **处置：生产 80 阈值不动**。任务层已不消费绝对分（revisionTaskGate）；80 只影响投稿层与 idea_to_paper/topic_survey。任何下调（如 70）在 DEV 上无判别收益、在 held-out 上无验证——不提交。

## 5. Severity/Scope/Gate 语义（阶段 D）

四轴审定（HUMAN_REVIEWED 单人，evaluation/finding-adjudication-labels.md，含证据 span）核心结论：

1. **blocking 构成二分**：已发表论文（无 pairing）的 blocking 44%-100% 为「证据库无记录」工件（NOT_EVALUATED 语义）；真实稿（F1）的 blocking 主体为 VERIFIED_BY_EVIDENCE（E001/S003 冲突）与 VERIFIED_IN_DOC（主表 71.2/74.0/8200 vs 消融表 68.1/72.5/10800 同配置不一致）——**两类同权阻断，无法区分**。
2. **候选策略 C' shadow 重放**（零模型，40 样本）：真实缺陷稿 15/15 保持 FAIL（反例保护 ✓——含表间不一致、E001 冲突全部保留）；但已发表论文仅 1/9-0/6 通过、诚实稿 mot-r51 0/2 通过——文本启发式剥离不净。**方向正确、实现需结构化信号**（claimGrounding transparent/opaque、findingAdjudication verification 轴、claimCertificate 稿内核验、gate 输入层 pairing 状态）。不满足任务书 §7 的生产变更门槛，未实施。
3. 同根因双计数：existing-paper 返修语境已修（rootCauseKey 归因排除，r3 实证）；quick-review 语境无去重输入（计数腿可能重复计因）——记录为已知边界。
4. Revision Task Success vs Publication Ready：分层正确（r3：任务层 FAIL 3 项检查 / 投稿层 NOT_READY + 11 条基线继承风险；外审意见 3/5 闭环 + 1 条待作者裁决——author decision 出口保留）。
5. NOT_EVALUATED 不伪装为 PASS：状态机与测试回归全部通过；**但规则 4/5/6 的计数路径绕过了该语义**（§2 缺口）——这是 V2 shadow 与生产的实质差异点。
6. 反例保护清单（安全反例核验）：f1 表间不一致 ✓ 保持阻断；f1 摘要 vs E001 ✓；f5 41.0/41.8 ✓（major 可见不阻断，分级正确）；CE2 引用损坏 ✓（citation.verify 3/3 确定性命中）；**CE1 注入数值矛盾 ✗ 0/2 检出（双盲区）**——任何候选策略实施前必须先补确定性跨节（摘要↔表）数值一致性检查。

## 6. 真实 MOT 论文复验（阶段 E）

**版本判定**（mot/MOT_EVIDENCE_INVENTORY.md）：a3bec2a（1f3369…）与 a8cca9a（31fb697c…）**不在本机**（全盘检索；M14.9.5.x 数据目录已删）→ M14.9.5.3/5.4 字节级复验 BLOCKED，如实声明。本机在案版本链：baseline-import.zip（fb071906…，M11.4 同构导入）↔ p-* M11.4 项目（gate artifacts 完整）↔ M10.3 冻结基线（423CF0E0…）；R5.1 审查包 latest.zip（acce88f2…）≠ 验收稿，其 manuscript/paper_submission_candidate.tex（210b82ae…，10-18）为最新真实稿（MOT Revival 论文——与 MRG-DTM 稿是两篇不同论文）。

**p-c923662f9c48 r3 三路对照**（mot/mot-r3-three-way.json，零模型）：
1. 正式旧 Gate FAIL：unsupported_critical_claims_zero（修订引入 1 条，claimGapAudit 正确排除原稿既有 7 条）/ open_critical_major_zero（0/2，归因排除 6+10）/ academic 74<80 / styleRisk 38>35 / patch_validation_publishable。真实缺陷清单（分级）：VERIFIED_BY_EVIDENCE（摘要「均改善」vs E001/S003 公平消融）、VERIFIED_IN_DOC（表 3 vs 表 5 同配置数值不一致）、AUTHOR_DECISION_REQUIRED（模板外推速度来源【待作者确认】占位符泄漏进正文、L_mem detach 未定、灰区 claim 1 条）、NOT_EVALUATED（表 4/5/6/7/8 数值待实验记录核验）。
2. 质量 V2 Shadow：该 run 早于 M15.1/M15.2 机制 → claimAudit/citationAudit/findingAudit 均不存在 → V2 诚实输出 NOT_EVALUATED（verificationCompleteness.complete=false，missing 3 项）——**shadow 不伪装已核验，行为正确**。
3. 候选策略 C'：仍 FAIL（blocking 3 / critical 3 / major 5 保留——真实缺陷不放过）。

**结论**：旧 Gate FAIL **实质正确**（任务层 3 项真实失败 + 作者裁决项），只有 74<80 与 38>35 是未校准阈值成分（M15.5 数据证明中文可接受带 63-80、styleRisk 35 边缘方差 ±8）。正确的终态就是 FAIL/AUTHOR_DECISION_REQUIRED——**不为「让 MOT PASS」放宽任何口径**。R5.1 诚实稿（mot-r51）当前管线采样 76/82 分、blocking 全部为证据库空工件（无内部矛盾 finding——审稿人未在诚实稿上发现虚假缺陷），gate 仍 FAIL（工件 + 76<80 + 38>35）——工件性 FAIL 对真实论文无差别。

**修改闭环**：无确定性系统 Bug 需修（分层/归因/去重/NOT_EVALUATED 全部按设计工作）；不提出修稿建议（M14.9.5.3 停在合法 hitl.research_plan 的输入不在本机；现存项目无存活待批准 HITL——全盘 checkpoint 扫描 {completed:4, failed:3, cancelled:5}）。

## 7. 从 M11.4 到 M15.5：老问题清单核验

| M11.4 老问题 | 状态 | 证据 |
|---|---|---|
| 审稿输入截断（44% 可见） | **已修**（64 块 + 句界截断；F1 覆盖率 92-93%） | m114 修复 + 本轮 dry-run 复核 |
| claimGapAudit 转述归因不可达 | **已修**（词元 containment ≥0.6） | M11.4 §16.2 + r3 排除口径实证 |
| 规则重复计数 | **已修（返修语境）**（rootCauseKey 归因排除） | r3「归因排除 critical 6/major 10」；quick-review 语境仍无去重输入（新边界） |
| 任务 scope 与全稿 publishability 混淆 | **已修**（Option C 分层落地） | r3 revisionTask/publicationReadiness 分离实证 |
| academicScore≥80 未校准 | **未修（维持）**——本轮 40 采样再证无任何绝对阈值可行；生产不动（证据不足以换阈值，只足以证伪阈值语义） | §4 |
| Reviewer 分数无锚点/波动 | **部分在**：无锚点仍在（prompt 未动）；同稿 σ en 0.7-3.5 / zh 0.6-5.7；跨管线刻度稳定 | §4 |
| M15.1「110/110 只读 run Gate FAIL」 | **根因定位**：规则 4/5/6 计数腿对真实论文无判别力（本轮 40/40 复现）——不是评分问题，是 finding 计数语义问题 | §5 |

新问题（本轮发现）：
- N1：**规则 4/5/6 不消费 evidence pairing 状态**（库空 → UNSUPPORTED → FAIL，语义应为 NOT_EVALUATED）——影响 quick_review/published assessment/idea_to_paper 全场景。
- N2：**跨节（摘要↔实验表）数值一致性双盲区**（CE1 注入 0/2 检出；同节内 3/2 检出对照）。
- N3：**跨域证据污染**（benchmark 复用带存量 evidence 的骨架时，reviewer 可把无关领域证据用于 CONTRADICTED 判定；生产同域项目风险低，published-assessment 场景需注意）。
- N4：style 阈值 35 的边缘方差（已发表论文 58/38 越线 2 例；中文诚实稿 38 越线 1 例）——与学术分阈值同性质，未校准硬门。

## 8. 模型与成本记账

- 真实底层模型调用：**≈65 次**（区间 63-68：成功样本 19×3=57 + 连通性 2 + 诊断 1 + 失败尝试 ≈5-8；reviewAll=academic+fact+style 三路；style 结构化修复重试计入）。另 citation.verify 的 scholarly 元数据 HTTP 调用 47 req/样本（非 LLM，不计）。
- Tokens：输入估 **≈1.1-1.2M**（zh digest 30-54k 字符/调用 ≈0.7-1.0 tok/char；en ≈0.25-0.35 tok/char + 系统提示），输出估 ≈0.25M。精确值不可得（reviewAll 任务 getTask 不返回 usage；唯一精确点：ping 201 in/7 out/cacheR 768，list-price estimatedCost $0.00051）。
- Coding Plan 边际成本：**$0**（订阅额度内）。list-price 总成本未获精确值（provider 未回传逐任务 usage）——如实声明。
- 并发 ≤2、同稿 ≤3 纪律遵守；无密钥回显/提交。

## 9. 工程交付与验证

- 新增：`scripts/m155-quality-gate-benchmark.mjs`（m114 基准的 M15.5 扩展：controlled_edit 锚点、多文件项目、生产 Gate 规则重放、citation.verify 确定性检出、预算硬顶、resume-by-key；数据格式与 m114 兼容）。
- **零生产代码变更**（gates.ts/qualityDecisionV2.ts/revisionTaskGate.ts/ReviewerService.ts 逐字节未动；无阈值/规则/prompt 修改；CandidateProposer/Pi Runtime/Docling/RAG 未触碰）。
- 测试：quality+review 相关 23 文件 308/308 PASS（改动前基线=改动后，因无生产改动）；backend 全量/typecheck/build 见 CI。
- CI：见 PROJECT_STATUS 与 §0（推送后核验 CI + Linux Integration 真实 conclusion，链接在最终报告中更新）。

## 10. 下一步（只推荐一个真正必要的）

**把「evidence pairing 状态」接入生产 Gate 规则 4/5/6 的计数语义**（V2 shadow 先行）：无 pairing（库空/quick-review 第三方稿）时规则 4 的 UNSUPPORTED 与规则 5/6 的 evidence_gap 类 finding 降为 NOT_EVALUATED 呈现不阻断，VERIFIED_IN_DOC/BY_EVIDENCE 保持阻断——配套先补确定性跨节数值一致性检查（摘要↔表，CE1 型盲区）。此改动同时解决 N1（判别力）与 M15.1 的 110/110 恒 FAIL，且不放松任何真实缺陷的阻断（本轮 15/15 反例保护数据可作其回归基线）。涉及生产政策，需作者批准后按任务书 §7 五条门槛实施。
