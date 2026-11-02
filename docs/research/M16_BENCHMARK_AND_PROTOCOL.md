# M16 — 外部评价体系与冻结协议（工作包 B）

- 冻结协议原件（仓库外）：`D:\PaperTeamData\M16\AcademicReviewValidity\PROTOCOL.md`、`LABEL_POLICY.md`、`METRICS_SCHEMA.json`、`DATA_MANIFEST.json`；哈希见同目录 `PROTOCOL.sha256`（PROTOCOL.md sha256 `584960166eb6e2fc868cdbdf4c44ab3bc131366d5438567a4d8a67a2e50103f2`）；冻结后偏差只追加在 `DEVIATIONS.md`
- 脚本：`scripts/m16-review-validity/`（`lib.mjs` 全局账本 + 硬上限 120；`b-select-sealed.mjs` 抽样；`c-*.mjs` 运行 / 裁判 / 评分）

## 1. 开源基准与可用性

| 项目 | 用途 | 许可 / 使用限制 | 本轮决定 |
|---|---|---|---|
| CoCoReviewBench（hexuandeng，tree `2580687`） | ICLR 2025 论文 MD + 经 OpenReview 讨论正确性过滤的人类原子意见（`opinions` + `conflicts_validation` / `rebuttal_validation`） | 仓库 CC BY 4.0；评审内容来自 OpenReview，按其条款仅本地评测，不再分发 | **采用**：原子意见作为不完备参考；不采用其类别级 completeness 作主指标（见 ROOT_CAUSE R3） |
| SurveyReview（zai-org，v1.1 test） | 综述四维（Readability / Criticalness / Comprehensiveness / Structure）审稿报告情感分 | 见本地 LICENSE；只用 test split | **采用**：只用于 D3 反常复测；按 balanced accuracy + 常数基线报告 |
| ReviewGrounder | rubric 引导 + 受控证据锚定的审稿生成 | 未审计源码 | **未采用**：本轮不引入新审稿机制（PROTOCOL §2：生产检出行为不改） |
| PeerRead | ICLR 2017 等历史评审 | 已在 M15.13 用作 held-out，属 DEV_OPENED | **不用**（污染） |

## 2. 数据分层（LABEL_POLICY）

- **DEV_OPENED**：M15 TJA D2 12 篇 / D3 8 篇、M15.11 抽样框 34 篇、M15.12/13 族、本轮裁判预检 2 篇（D2 中的 veiSkPqIXm、X0epAjg0hd）。
- **EXTERNAL_EXPERT_REFERENCE**：CoCoReviewBench 人类弱点原子意见；SurveyReview 维度分。都不完备，AI 意见未匹配 ≠ 错误。
- **DETERMINISTIC_GOLD**：逐字引文回放（只证明可定位，不证明正确）。
- **SEALED_EVALUATION**：CoCoReview 8 篇（Accept / Reject 各 4，其中 X7eAhXcps1、w5h443GIGo 指派生产臂）+ SurveyReview 8 篇（参考正 / 负各 4）。执行者冻结前未读取人类意见文本。
- **AI_JUDGED_AUXILIARY**：GLM 同模型族盲评裁判的「AI 条目 ↔ 人类意见」匹配；不与人工标签混算。

抽样规则（`b-select-sealed.mjs`）：ICLR 2025 记录 300 → 排除 D2 12、M15.11 重叠 2 → MD 15k–60k 字节、正确性过滤后弱点意见 ≥ 5 → 219 候选 → sha256("m16-sealed|id") 升序分层取。MD 经 GitHub git blobs API 获取并逐篇校验 git blob sha1。

## 3. 臂与公平性

同模型 `zai-coding-cn/glm-5.3`（= 当前产品 Settings 模型；生产臂启动时校验，不一致即 `MODEL_VALIDATION_BLOCKED`）。

| 臂 | 定义 | 目的 |
|---|---|---|
| Atrunc | M15 D2 臂 A Prompt 逐字 + 前 40k 字符 | 复现 D2 |
| Afull | 同 Prompt + 全文 | 候选改造 C：修复已证实根因 INPUT_FIDELITY |
| Bfull | M15 D2 臂 B（证据纪律）Prompt 逐字 + 全文 | 证据约束是否损害覆盖 |
| G0 | 10 条不读论文的通用审稿套话 | 裁判区分力（0 次生成调用） |
| P | 当前 main 的 LaTeX `review.run → quality.gate`（published_paper_assessment），MD → LaTeX 用 M15 `md_to_tex.mjs` | 生产链路描述性对照 + 丢失路径取证（完整运行上限 2） |
| S | M15 D3 臂 A Prompt 逐字 + 全文（≤ 100k） | D3 宽松在平衡新样本是否复现 |

公平口径：主指标取**前 10 条**（单次臂上限 10 条；生产臂按严重度稳定排序取前 10，同产品优先视图），另报全部条目覆盖与条目数；成本按物理调用、token、时长分臂报告（订阅渠道，金额未知）。

## 4. 指标与判定（预注册）

- 主指标 `recallAt10` = 前 10 条覆盖的人类原子弱点意见 / 该篇人类意见数。
- V 裁判区分力：Afull − G0 配对 CI 下界 > 0，否则原子匹配指标在本样本无效 → 检出能力结论 EVALUATION_BLOCKED。
- H1 输入保真：Afull − Atrunc；H2 证据纪律：Bfull − Afull。CI 不含 0 记 SUPPORTED，否则 INCONCLUSIVE。
- P：n = 2，只描述，不做显著性结论。
- S：negRecall ≤ 0.3 且 posRecall ≥ 0.7 → 宽松复现；balanced accuracy ≥ 0.65 → 不复现；其余 INCONCLUSIVE。
- NOT_EVALUATED：严重度一致性（无参考）、中文目标期刊主观质量（无标签）、录用预测（不做）。

裁判预检（DEV_OPENED，2 次调用）：两篇 D2 论文上模型清单覆盖 4–6 / 19–29 条人类意见，G0 覆盖 3 条；抽查 G0 的全部 6 个匹配，均为人类意见本身同样笼统（如「Limited novelty」「Only one dataset was examined」）——裁判遵守「泛泛条目只匹配同样泛泛的意见」规则；也说明约 10–15% 的人类意见可被套话命中，是原子指标的地板。

## 5. 预算与停机

真实付费调用 ≤ 120（含生产子调用、裁判、重试、预检；`budget/calls.jsonl` 每次调用前检查）；完整生产评估 ≤ 2；case-arm ≤ 36（计划 34）。生产臂单次上限 min(45, 剩余 − 10 裁判预留)，不足 30 不启动。封存集只跑一轮，失败照报。

## 6. 统计解释的边界

- n = 8 篇（原子意见约 7–27 条 / 篇），论文级配对 bootstrap；CI 宽，只能检出大效应。
- 裁判与被测模型同族（GLM），可能偏好同族表达；盲化（匿名乱序、去类别码 / 严重度 / 臂名）只缓解、不消除。
- 英文 ML 会议与综述数据上的任何结论**不外推**到 CJIG 或其他中文核心期刊。
