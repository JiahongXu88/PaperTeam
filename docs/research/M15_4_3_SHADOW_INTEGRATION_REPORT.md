# M15.4.3 — CandidateProposer Shadow Integration & Reliability Closure

- 日期：2026-10-24；起点基线 `b61ce65f`（== origin/main，clean，fetch 后无远端更新；与 M15.4.2 交付一致）。
- 预登记 `D:\PaperTeamData\M15\M15_4_3\PRE_REGISTERED_GATES.md`（任何源码修改与任何模型调用之前写入：冻结 HEAD、待改文件 SHA、C2 G1 取证结论、P0-A/P0-B 行为目标、保护锚精确案例清单、模型预算 ≤12、STOP 规则）。实验数据/真实模型原始输出：`D:\PaperTeamData\M15\M15_4_3\`（仓库外，不入 Git）。
- 回放 harness：`scripts/m1543-replay.mjs`（零模型，严格复用 M15.4.1 38 例 + M15.4.2 C2 13 例已落盘响应）。

## 0. 一页决策卡

**裁决：GO_SHADOW_OBSERVATION——P0 两机制通过（51 例回放唯一翻转 = 预登记目标 G1-C01 ABSTAIN→SUPPORTED，13+2 保护锚与全部负例零损失、零错误强判、生产臂零实质翻转）；CandidateProposer 以 `PAPERTEAM_CANDIDATE_SHADOW=off|on`（缺省 off）接入真实 review.run（claim-audit 落盘后的有界后置段，≤4 claim / ≤8 调用 / 并发 1，请求身份幂等复用，独立 candidate-shadow/v1 产物）；OFF 零调用零产物、ON 不改 review 返回值/claim-audit/Gate/HITL（集成测试逐字段对照 + 真实 smoke）；真实模型 smoke 两场景全通（A=真实论文真实工作流产物、B=G1 重复表真实 claim 真实服务通道，合计 CandidateProposer 真实调用 5 次 ≤ 预算 12）。这不是正式 Gate 集成批准——Shadow 产物为 SHADOW_OBSERVATION_ONLY。**

| 项 | 结果 |
|---|---|
| ① P0-A 重复表 | **PASS**（机制层 + 案例 G1-C01 真实收益；取证更正：非文件级重复，是同一逻辑观察的多物理表来源 + 指标下标歧义）；一轮行限定过滤尝试因损失保护锚 F1-C01 触发预登记 STOP → 已完整回退并归因 |
| ② P0-B 括号绝对值 | **PASS（机制层）**：G2-C02 的 DERIVED 误继承解除（弃判从 DERIVED_RECOMPUTE_OUT_OF_SCOPE 前进到 GROUNDING_FAILED）；51 例零生产臂翻转；该案例未转强判的剩余阻断 = "agnostic"↔"Agn." 缩写桥（任务书禁止新增别名特判，如实不修） |
| ③ 51 例零模型回放 | v1543 协议臂 **16 正确强判 / 0 错误**（v1542=15：F 集 13 + C2 2；+G1-C01）；baseline 8/0、production 8/0（M3 后口径，与 M15.4.2 逐例一致） |
| ④ Shadow 集成 | 默认 OFF 零调用零产物（config 测试 + 集成测试断言）；ON：产物落盘、review 返回值逐字段一致、claim-audit 未改写、影子失败只记状态 |
| ⑤ 真实 smoke | A：截取真实论文（M15_4_2 G2 语料）真实 review.run → candidate-shadow-r1.json 真实工作流产物（27 单元 / 140 论断账本 / 4 调用 / 全诚实弃判 / 主链正常）；B：G1 真实 claim 经真实 ReviewerService.proposeClaimCandidate → ACCEPTED SUPPORTED + 2 成员逻辑等价类见证（1 调用 5969/481 token 10.7s） |
| ⑥ 成本 | CandidateProposer 真实调用合计 5 次（A=4 + B=1），in≈26.4K / out≈1.9K token（订阅渠道边际 0；list 口径 ≈$0.05） |
| ⑦ 测试 | 新增 33（P0-A 8 + P0-B 12 + shadow 单元 8 + 集成 4 + config 1）；既有全绿（证书三套件 + proposer 38 + guards 9）；backend 全量 4292/4293（1 例 archiveLimits 满载计时闪失，单文件复验 4/4 过，与本轮无关模块） |
| ⑧ 下一步 | Shadow 观察窗口运行（默认保持 off）；主线转向真实论文 Academic Score / Major 严重度 / Quality Gate 校准（M15.4.2 建议重申），不再扩张 Claim Certificate 局部规则 |

## 1. 阶段 A：调用图审计与 C2 G1 取证（先只读）

- 真实挂载点（从 definitions.ts / claimAudit.ts 实际代码追踪）：review.run 在单元审稿完成后调 `runReviewAudits` → `buildClaimAudit`（确定性整理 Reviewer 已产出的 unit claims；quote 逐字定位 + claimId 内容寻址 + 证书在全部 LaTeX 文件上检索）→ `saveAuditArtifact("claim-audit", round)`。claim 的 span/claimValue/check 在账本内冻结；Shadow 的唯一合法输入就是这个账本——不重跑 Reviewer、不造新 claim。
- **C2 G1 重复表取证结论（对 M15.4.2 §4 归因的更正，已写入预登记 §2）**：G1 源（2609.23061，4 个 .tex、10 张表）**不存在字节级重复文件、不存在跨文件同 tableId**。G1-C01 签名 4 命中的真实构成：① `tab:visdrone_comparison` r17c4（mAP50=42.737，gold）② 同表 r17c5（mAP50:95=25.713）③ `tab:ssm_cnn_paradigm_ablation` r3c7（mAP50=42.737）④ 同表 r3c8。①③ 是**同一逻辑观察的两个物理表来源**（消融表 full-config 行与主对比表 own 行在 4 个共享指标列上逐值逐精度一致，两表 caption 同指 VisDrone2019）；②④ 进入签名是**指标下标粒度**（"mAP 50" 的 token {map} 同时落 "mAP 50" 与 "mAP 50:95" 列头——纯数字 token 被 contextTokens 剔除，FIX-2 只覆盖复合 token）。
- G1-C02（UNEXPLAINED_QUALIFIER: tiny）与 G2-C01（"agnostic"↔"Agn."）属同义词/缩写桥词法缺口——任务书明令不做 SYNONYMS/关键词特判，本轮不修、如实报告。

## 2. P0-A：同一逻辑观察的确定性等价候选协议（candidateProposer，不动 bindTextAtom）

**A1 逻辑等价类（logical-equivalence/v1）**：物理签名命中两两归并，全部条件同时成立才等价：(a) headerPath 逐层相同；(b) 格值 raw 逐字相同 + 单位相同；(c) 同一 subject alternative 的全部词同时落位两行行键/行组；(d) 两表 parseIssues 均空且 caption 非空；(e) **跨行指标指纹**——两行按 headerPath 对齐的其余数值列 ≥2 列 raw 逐字一致（G1 实测 2 列）。全文独立枚举先于去重；未通过判定的命中保持独立竞争；类间混合关系仍弃判；类内成员物理位置全量保留进 witness（members + pairs + fingerprint 列数 + 共同落位主语词）。变体行（"Ours w/o X"）不设词面排除：与基准值不同的变体由 (b)/(e) 失配自然保持独立；与基准全指标同值的「变体」在现行多绑定一致裁决下本就得相同结论，归并不改结果只改见证。
**A2 指标数字标记冲突**：论断 metric 短语与列头指标名的数字标记（50 / 50:95 / top-1 的 1；冒号连接为一个标记，边界感知）冲突（列头有标记且论断标记集非其子集）→ 该列不落位该 metric。列头无标记（mAP (%)）或论断无标记 → 不冲突（只降不升的反方向不触发）。应用于 enumerateSignature（两个方向）与 top 候选 metric 检查。
**唯一性/多绑定改按逻辑类计数**：唯一性=逻辑类数 1（top 须为类成员）；多绑定一致裁决按类代表关系；B2 白名单含等价成员全部物理表（跨表同值守卫不失效——A1-5 负例）；值佐证路径同样按类划分（须恰一个逻辑 winner 且 top 成员所在表有题注）。

**回放逐例（C2 G1，预登记允许的变化）**：G1-C01 ABSTAIN→**CORRECT_STRONG/SUPPORTED**（2 物理→1 逻辑类，witness 记录 members=[6bc12e9c#r17c4, c479c594#r3c7] + fingerprint 2 列）；G1-C03 维持 CORRECT_STRONG/CONTRADICTED（3 物理→2 逻辑类 unanimous DISJOINT，见证更精确）；G1-C02 维持 ABSTAIN（tiny 限定词，词法缺口如实不修）。
**负例全过（candidateProposerM1543.test.ts 8 例）**：值不同指纹失配不并、同值不同指标列不并、副本 parseIssues 不并（RAGGED_ROWS → 维持 2 逻辑类、无等价记录）、B2 第三表拦截、标记子集不冲突、无标记列不触发。

**实施偏差（如实记录）**：试加「行限定过滤」（论断未提变体词时按生产 ROW_QUALIFIERS 剔除变体行命中）→ 51 例回放损失保护锚 F1-C01（gold 行 "Proposed + TAS" 因 "+" 被误判变体而剔除 → 值佐证 0 命中 → 弃判）→ 触发预登记 STOP §8.5 → **完整回退**（代码与 ROW_QUALIFIERS 导出一并还原），归因记录于源码注释与本节。变体行竞争由等价类划分下的混合关系弃判承担（fail-closed）。

## 3. P0-B：括号绝对值的语境归属（claimCertificate.atomQualifiers 生产行为变更）

规则（只作用于派生语义**继承**路径；DERIVED_BEFORE/DERIVED_AFTER 直接判定不动）：数值位于未闭合括号组内（紧随 "(" 或组内 vs/versus/and/or/逗号分隔元素之后）时，取 "(" 前紧邻组头词：普通名词（accuracy/channel/rate）= 同位语绝对值报告 → 阻断继承；派生名词（DERIVED_ATTRIBUTION_NOUNS）/ 继承触发词族 / 介词连词保留集 {by,of,from,than,to,vs,versus,and,or,per,...} / 单位形 / -ly 副词形 / 纯数字 → 维持继承（fail-closed）。括号前无词 = 无头分支 → 维持继承。
**真实案例**：G2-C02 的 atom 68.9 弃判类别从 DERIVED_RECOMPUTE_OUT_OF_SCOPE 前进到 GROUNDING_FAILED（DERIVED 误继承已解除；剩余阻断 = subject "agnostic channel" 不落位行键 "Agn."——缩写桥）。"(X% higher)"、"(by X)"、"(2.1 ms) 降幅重述"、"(a 3.2% improvement)" 类不吞（B-4..B-9 合成正反例）；from/to 端点与既有 of-归因语义不动（B-10/B-11）。
**生产影响审计**：51 例回放 baseline 臂与 production 臂逐例无翻转（8/0 两臂，F3-C02/F4-C01/F4-C03/F5-C01/F5-C02/F5-C03/F5-C06/F7-C01）；claimCertificate 既有 49 测试 + SemanticBinding 15 + CrossTable 7 全绿（P0-B 不翻转任何既有断言）；inputsSha256 配方不含代码 SHA（哈希不变），但行为变更如实按上述逐例审计声明——不声称 dist 未变。

## 4. 51 例零模型回放（E1；scripts/m1543-replay.mjs，严格复用已落盘模型响应）

| 臂 | CORRECT_STRONG | WRONG_STRONG | ABSTAIN | 与 M15.4.2 差异 |
|---|---|---|---|---|
| v1543 协议（本轮） | **16**（F 13 + G1-C01 + G1-C03 + G2-C04） | **0** | 35 | +G1-C01（预登记目标）；其余逐例相同 |
| baseline（规则+oracle） | 8（SUPPORTED 形态） | 0 | 43 | 零实质差异（G1-C01 标签口径 CORRECT_STRONG↔SUPPORTED 同结论） |
| production（提案注入） | 8 | 0 | 42+1 NOT_RUN | 零差异 |

- **保护锚 1（v1542 的 13 强判）**：F1-C01/F2-C04/F2-C05/F2-C06/F2-C08/F3-C01/F3-C02/F3-C03/F3-C04/F5-C02/F5-C03/F5-C04/F7-C01 全部维持 CORRECT_STRONG。
- **保护锚 2（其余 25 例正确拒绝）**：全部维持（F2-C07 被 B2 拦、F1-C02 SCALE 拦、F3-C06 B2 拦、F3-C07/F7-C03 NO-TABLE、全部 L1-wrong 被 grounding/uniqueness 拦）。
- **保护锚 3（C2 既有 2 强判）**：G1-C03、G2-C04 维持；C2 负例（G1-C04 派生、G1-C05 no-table、G3-C04 approx、G2-C03）全部维持弃判。
- Proposal ACCEPTED 与正式 VERIFIED 分开统计：v1543 的 16 条 ACCEPTED 全部是协议臂见证（mapping-witness/v1），**零条**进入正式 claim-certificate/v1 / VERIFIED_*（shadow 权威边界，见 §5）。
- 旧 191 例语料本机不可得：DATA_UNAVAILABLE（沿 M15.4.1/M15.4.2 先例；替代证据链 = 51 例回放 + 合成负例 + 既有全套件）。

## 5. P1 Shadow 集成（默认 OFF；失败隔离；幂等）

- **开关**：`PAPERTEAM_CANDIDATE_SHADOW=off|on`（config → serviceStack → WorkflowServices.review.candidateShadow；缺省 off；非法值回退 off）。**OFF = 零额外模型调用、零产物、零行为差异**（config 测试 + 集成测试断言：影子通道 scope 零调用、无 candidate-shadow-r*.json、review 返回值与 ON 逐字段一致）。
- **挂载点**：`runReviewAudits` 在 `saveAuditArtifact("claim-audit")` 之后的同步有界后置段（review 生命周期内、saveSummary 前；增加可见延迟 ≈ 选中 claim 数 × 单调用时延，仅 ON 时）；claimAuditMode=off 时 runReviewAudits 不执行 → 无 claim 输入 → 不运行（不造新 claim）。
- **资源**：每轮 ≤4 claim、每 claim ≤2 调用（1 提案 + 仅 JSON 解析失败重试 1 次；模型异常≠解析失败、不重试）、整轮硬上限 8、顺序执行；模型调用经 `ReviewerService.proposeClaimCandidate`（新 sealed 方法，contextScope `review/academic/candidate-shadow`，与 claim-recheck/finding-recheck 同一 Pi runtime 通道——复用排队/超时/取消，不新建 Key 存储）。
- **请求身份与幂等**：requestId = sha256(projectId | round | claimId | documentFingerprint | quoteSha256 | claimValue | prompt/adapter 版本)；同身份 terminal 条目直接复用（resume/重试零新调用——单元测试断言零调用 + REUSED）；输入变更（文档/引文/值/协议版本）→ 新身份重跑（单元测试断言）。
- **产物 candidate-shadow-r{round}.json（candidate-shadow/v1）**：逐 claim——schemaVersion、run/revision、claimId、claim span+claimValue、selection（排序依据/审稿 check/是否已有证书）、promptChars、attempts、提案 echo（subject/metric/dataset/conditions/comparison/别名→canonical resolvedCell）、parseError、verification（ACCEPTED/ABSTAIN 全量）、mapping-witness/v1（引文分类/term grounding/唯一性含逻辑等价类/B2-B3）、**规则基线**（同 atom 上 bindTextAtom 零模型结果）、trace（taskId/promptSha256/model）、usage（calls/tokens/duration）。汇总层 calls/tokens/duration 与 SHADOW_OBSERVATION_ONLY 声明。原始 prompt 与模型原始回复不入产物（仅形状与哈希）；论文原文只以 claim quote / witness 引文形式出现（与既有 claim-audit 产物同一敏感级，留在项目产物目录）。
- **失败隔离**：单 claim 异常 → FAILED 条目（PARTIAL）；整段异常（含产物保存失败）→ 记日志、无产物、review.run 照常完成（集成测试场景 3 + 全链 try/catch）；取消直接上抛（与主链取消同语义，单元测试）。日志只含计数/claimId，不含论文原文与模型原文。
- **权威边界**：不签发 claim-certificate/v1；ACCEPTED ≠ VERIFIED_*；不 import gates/revisionTaskGate；claimGuards.ts 仍是唯一守卫事实源（本轮零改动）；未建第二套证书器——verifyProposal 与 shadow 编排只产生观察对照。
- **必测集成场景覆盖**：开关 OFF（零调用零产物 + 返回值一致）、合法 claim（全链+规则基线）、模型 JSON 错误（重试一次后如实记录）、超时/取消（aborted 上抛）、run 重放/resume（同身份复用）、文章输入变化（新身份）、影子模型异常（FAILED+PARTIAL+主链完成）、Reviewer 终态/HITL 不变（返回值逐字段对照）、claim-audit 未改写（ON 下账本读取断言）。

## 6. 真实 Shadow smoke（E2；≤12 次 CandidateProposer 真实调用）

**场景 B（真实服务通道 + P0-A 真实数据）**：G1 真实 claim（"HDMamba-YOLO-B reaches 42.737\% mAP$_{50}$ …"，M15_4_2 G1 语料）经真实 `ReviewerService.proposeClaimCandidate`（zai-coding-cn/glm-5.3）→ **ACCEPTED / SUPPORTED**：1 次调用、in 5969 / out 481 token、10.7s；见证 physicalHitCount=2 → 1 逻辑类（members=[6bc12e9c#r17c4, c479c594#r3c7]、指纹 2 列）；checks 全链（SIGNATURE_UNIQUE_LOGICAL(2 physical copies) / B2_CROSS_TABLE_CLEAR / DOUBLE_KEY_AGREED）；规则基线 UNIQUE→gold 格。产物 `M15_4_3/smoke/smokeB-candidate-shadow-g1.json`。

**场景 A（真实论文真实工作流产物）**：截取真实论文（M15_4_2 G2 BrainIAC 语料，仓库外只读；截取范围记录于产物目录）→ published_paper_assessment 真实 `review.run`（真实单元审稿 27 单元 / 140 条论断账本，状态分布 REVIEWER_CONSISTENT 69 / EXTERNAL_DATA_REQUIRED 33 / NOT_EVALUATED 32 / AUTHOR_CHECK_REQUIRED 5 / REVIEWER_SUSPECTED 1 / VERIFIED_* 0）→ Shadow ON 自动选中 4/20 可选论断（未出具证书优先）→ **candidate-shadow-r1.json 真实工作流产物**（COMPLETED）：4 次真实调用（每 claim 1 次，零重试）、in 20421 / out 1395 token、49.5s；4 条全部诚实 ABSTAIN（真实 Reviewer 论断多为非原子多值句——"61.0 vs 58.7"、"49% / 21% / 21% / 9%" 等，claimValue 不可单值定位或模型正确弃权）——影子在真实输入上零误报、预算内、不阻塞主审稿（review.run 正常完成 round 1，claim-audit 照常落盘且未被改写）。产物 `M15_4_3/smoke/smokeA-{candidate-shadow,claim-audit}-r1.json`。

两场景合计 CandidateProposer 真实调用 **5 次**（A=4 + B=1 ≤ 预算 12）；in≈26.4K / out≈1.9K token（订阅渠道边际 0；list 口径 ≈$0.05）。正常审稿调用（场景 A 的 27 单元审稿等）不计入该预算、按正常 review 计。原始模型输出落盘仓库外。

## 7. 测试 / 回归

- 新增：`candidateProposerM1543.test.ts` 8（P0-A 正反例）、`claimCertificateM1543.test.ts` 12（P0-B 正反例）、`candidateShadow.test.ts` 8（编排单元）、`candidateShadowReviewRun.test.ts` 4（工作流集成 ON/OFF/坏JSON/异常隔离）、config 1（开关解析）。
- 既有：candidateProposer 38/38、claimCertificate 49/49、SemanticBinding 15/15、CrossTable 7/7、claimGuards 9/9、claimAuditReviewRun 全过。
- backend 全量：4292 passed / 1 failed（test/experiments/archiveLimits.test.ts 满载计时闪失；单文件复验 4/4 过——与本轮改动无关的模块，Windows 满载先例处置）。typecheck/build 过。`git diff --check` 干净。frontend 零改动（本轮不涉前端文件）。真实 smoke 测试 env 门控（PAPERTEAM_M1543_SHADOW_SMOKE=1，缺省跳过不进 CI）。

## 8. 变更文件与权威边界

| 文件 | 变更 |
|---|---|
| backend/src/review/candidateProposer.ts | P0-A 等价类 + A2 标记冲突 + 逻辑类唯一性/多绑定（adapter/v3；prompt 不变） |
| backend/src/review/claimCertificate.ts | P0-B 括号同位语规则（atomQualifiers 继承路径；唯一生产行为变更，51 例审计零翻转） |
| backend/src/review/candidateShadow.ts（新） | Shadow 编排（选择/幂等/预算/失败隔离/产物） |
| backend/src/agents/ReviewerService.ts | proposeClaimCandidate sealed 方法（复用 runtime 通道） |
| backend/src/workflow/definitions.ts | runReviewAudits 后置 Shadow 段（开关 + 隔离）+ WorkflowServices.review.candidateShadow |
| backend/src/review/reviewArtifacts.ts / config.ts / serviceStack.ts / index.ts | kind 扩展 / PAPERTEAM_CANDIDATE_SHADOW / 接线 |
| 测试 5 新 1 改 + scripts/m1543-replay.mjs | 如 §7 |

未动：gates.ts、revisionTaskGate.ts、Academic Score/Major/Style 阈值、Reviewer 主 prompt/HITL、EvidenceStore、latexTable 解析器、frontend。

## 9. 局限（如实）

1. P0-B 在 51 例语料上无强判净增（G2-C02 被缩写桥拦在 grounding）——机制层验证靠 12 条合成正反例 + 该案例弃判类别的真实前进；真实论文中 "(68.9\%)" 形态的收益需 Shadow 观察窗口积累。
2. 等价类判定的 (c) 主语共同落位依赖行键词面；模型 subject 为空/回指时经 M1 锚替换后同样受此约束。
3. Shadow 只消费「已定位 + CONSISTENT/INCONSISTENT + 可解析 claimValue」的论断子集（选择只降不升）；账本质量决定 Shadow 覆盖。
4. C2 为 13 例/3 家族单轮；样本不支持族间显著性；标注为执行代理+机械校验（同先例）。
5. 场景 A 的真实论文为截取副本（控制规模；截取已记录于产物目录），非全量长篇 E2E——任务书明示不为 smoke 执行昂贵全链。

## 10. 下一步（唯一建议）

Shadow 观察窗口：在后续真实 Review 中按需显式开启 `PAPERTEAM_CANDIDATE_SHADOW=on`（默认保持 off），积累 candidate-shadow 产物与正式证书/规则基线的三路对照；**主线工作应转向真实论文 Academic Score、Major 严重度与 Quality Gate 校准**（M15.4.2 §6 建议的重申）——Claim Certificate 局部规则的边际收益已收敛（本轮两机制合计净增 1 条正确强判），不再扩张。
