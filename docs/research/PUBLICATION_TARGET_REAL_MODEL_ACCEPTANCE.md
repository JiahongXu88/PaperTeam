# 发表目标 / ReviewPolicy：真实模型验收与最小纠偏

```
PUBLICATION TARGET REAL-MODEL ACCEPTANCE: ACCEPTED（PUBLICATION_TARGET_REAL_MODEL_ACCEPTED）
起始 HEAD: 642103d80dbe7ea63fc7131d1b022b9de74e3ed2（HEAD == origin/main，工作区 clean）
被测模型: zai-coding-cn/glm-5.3（产品模型设置，全部角色同值）· 真实调用 21/24（1 次为预登记重试）· 完整 Workflow 0/1
生产 stage 运行: 1 次真实 review.run → quality.gate → revision.plan（PRODUCTION_STAGE_SMOKE；FULL_WORKFLOW_NOT_RUN）
TARGET_JOURNAL_ACADEMIC_VALIDITY = EXTERNAL_VALIDITY_LIMITED（不变）· 未启动 M17
```

- 日期 2026-11-04 · 执行代理 Claude（Opus 5.5，≠ 被测模型）· 直接在 main，无新分支。
- 仓库外证据：`D:\PaperTeamData\PublicationTargetPolicy\RealModelAcceptance\`——`PROTOCOL.md`（付费调用前冻结，sha256 `f84cef974980c45c52abf18d14cb8ac7d36fb2ae3dde30ac433a8655c1e192d8`）、`MANIFEST.json`、`MODEL_CALL_LEDGER.jsonl`（一次物理调用一行）、`DEVIATIONS.md`、`ACCEPTANCE.json`、逐次 prompt / output（`workflow/**/calls`、`ab/**/calls`）、`analysis/findings.{json,md}`、`analysis/closure-replay.json`、测试日志。
- 仓库内 harness：`scripts/publication-target-acceptance/`（lib / arms / workflow / ab / analyze / replay-closure）。上轮报告 `PUBLICATION_TARGET_REVIEW_POLICY_PRODUCT_CLOSURE.md` 与 M15 / M16 冻结数据未修改。

## 1. 协议要点（预登记，详见 PROTOCOL.md）

- **研究论文**：CoCoReviewBench ICLR2025 `2410.21665v1`（MinerU MD → md-to-tex v2，全文 42,023 字符，未截断）。**已开封的 M16 留出集成员** → 只作行为 smoke，不是独立质量评测。选择依据：零模型预检 17 篇中单元数最少（10 单元 + 跨章 + 整稿 = 12 次）。
- **综述**：PaperTeam 自产中文综述（M13 Final Closure，基于 Transformer 的端到端 MOT，14 篇文献；自有数据）。
- **臂**：A 未设置目标；B 中科院三区（用户设定，未核实）；C 中科院一区（用户设定，未核实）；S0 综述无目标（稿型政策 active）；SV-N 综述不传政策（= 升级前 / 旧 run 口径）。不预设「一区更严格」。
- **为何不跑完整 workflow**：existing_paper_improvement 含 import / understand / research / Writer 修订循环，预计远超 24 次；按任务书改为 1 次真实 review.run 阶段运行 + 直接调用生产 `ReviewerService` 的 A/B 对照。
- **隔离**：A/B 直接调用回放 dry review.run 捕获的生产参数，只替换 projectId（每次新项目 = 新会话）与 reviewPolicy；检索 / 全文 / 元数据联网在所有臂关闭（各臂都没有任何检索结果）。生产缺省 `shared_session`：W-B 的单元共享会话（真实产品行为），因此 W-B 单元与 U-A/U-B 不直接对比；整稿调用在两处都是新会话。

## 2. G1 模型路由：PASS

| 检查 | 结果 |
|---|---|
| 冻结路径 | `ProjectStore.create(publicationTarget)`（生产校验器）→ `freezeReviewPolicy`（`createRun` 调用的同一函数）→ `ctx.state.reviewPolicy`；hash `dda51e528aca7c14` |
| 运行中改设置 | review.run 之后把项目改为 JCR Q1 → revision.plan 前后快照 hash 不变（`midRunSettingChange`）|
| 最终 prompt | dry 与 live 同臂 prompt **逐字节相同**：整稿 A `3bf04fb8adf3`、B `6c1ddaab1356`、C `f3ea2839fc3e`；单元 5.2 A `8d29bf1a5bc8`、B `f9fbafffead4`。W-B live 的整稿调用 = WP-B2 同 hash（重复样本）|
| A/B 不串用 | A 臂 12 个 prompt 中 0 个含政策文本；B 臂 11/12（跨章按设计不注入）；无他臂目标出现 |
| 输入完整 | 整稿 FULL_TEXT 42,023 = 全文；10/10 单元完成，coverage 完整 |
| QualityReport 绑定 | `binding.reviewPolicy = {targetLabel:"中科院三区", tierFactStatus:"USER_TARGET_UNVERIFIED", journal:null}`——来自本 run 冻结快照，不是当前设置 |

## 3. 逐例对照（研究论文整稿；类别为执行代理按预定义口径人工编码，原文逐字核对）

类别：CR 论断-结果匹配 · SB 强基线/对比 · CF 对比公平 · SS 实验设置/统计 · AB 消融 · RP 可复现 · CB 贡献边界 · GEN 单模型泛化 · EV 评价循环性（LS 指标内含 BE 掩码）。

| ID | 臂 | prompt / output | 8 条 finding（按序）| 新实验 / 作者决定标注 | 定位 |
|---|---|---|---|---|---|
| WP-A1 | A | 3bf04fb8 / d119c93c | CR, EV, SB(Ren), SB(近邻基线), SS(人工标注), GEN, SS+AB(minor), CR(minor) | 0/8 | 1 条 quote 非逐字 |
| WP-A2 | A | 3bf04fb8 / 3a8bad56 | CR, CR(SOTA), SB(Ren), SB(Chen 缓解基线), EV, GEN, AB, SS(minor) | 0/8 | quote 全部逐字或留空 |
| W-B | B | 6c1ddaab / 275b38fa | CR, CR(SOTA), **CF**(协议改为逐生成 + 自行复现基线), SS(标注), **SS(方差/显著性)**, SB(Ren), CB/GEN, AB | **6/8** | 8/8 逐字 |
| WP-B2 | B | 6c1ddaab / 599ecb34 | CR, SS(标注), SB(单基线+改协议), **SS(方差)**, **CF**, SS/GEN, AB(minor), **RP**(minor) | 2/8 | 8/8 逐字 |
| WP-C1 | C | f3ea2839 / c0c99fc8 | CR, SB(Ren), **CF**, **SS(方差)**, CR/EV, CB/GEN, AB(minor), **RP**(minor) | **7/8** | 8/8 逐字 |

**两臂共有的核心**（5/5 次都出现）：局部记忆区域提取从未被直接评测（无 IoU / 像素级指标）、只用 SD v1-4、人工标注缺协议、只对比 Wen et al. 而 Ren et al. (2024) 未比较。这些在 A 的两个重复样本之间也稳定，说明模型对本文的主要弱点判断不依赖政策。

**超出 A1–A2 重复波动、且与政策 focus 方向一致的差异**：
- 对比公平（作者把基线的逐 prompt 协议改为逐生成，并且是自行复现）：政策 3/3 次出现，A 0/2。
- 方差 / 置信区间 / 显著性作为独立 major：政策 3/3，A 0/2（A1 只作为合并的 minor）。
- 可复现：政策 2/3（minor），A 0/2。
- 明确写出「需要新实验 / 作者决定 / 不需新数据」：政策 15/24 条，A 0/16。
- `policyDimension`：政策 24/24 条都给出合法 id（解析白名单 0 丢弃）。
- 相应地 A 更多 SB 类（各 2 条点名基线）与 LS 指标循环性（A 2/2，政策 1/3）。

**判读**：「设置目标 vs 未设置」的关注点变化 = **OBSERVED（定性；n = 2 vs 3，单篇论文）**。变化主要来自政策替换了问题类别清单（对比公平 / 可复现等维度在旧清单中不存在）。**B（三区，standard）与 C（一区，elevated）之间**的排序差异落在 B1–B2 自身波动之内（C 没有把贡献边界 / 强基线排到最前）→ 层级特异性 **INCONCLUSIVE**。不推断跨论文 / 跨领域有效性。

**单元 5.2（n=1/臂，新会话）**：U-B 比 U-A 多 1 条方差 / 显著性 major 与 1 条基线公平性 minor（都在 B 单元 focus 中）。U-A 报的「层选择消融」major 在 U-B 中没有出现，符合政策「消融由整稿负责」的分工。方向一致，但没有重复样本，只作旁证。

## 4. 综述（SV-N vs SV-S0，n = 1/臂）

- SV-S0（综述政策）：8 条全部使用综述维度（检索与纳入准则、跨研究综合 ×2、分类框架、覆盖范围、有依据的空白、代表性 ×2），**0 条**要求原创实验 / 消融 / 基线。「检索来源与纳入 / 排除准则未说明」排第 1 位，SV-N 中完全没有这一项。
- SV-N（旧研究论文口径）：同样 **0 条**要求实验 / 消融（只有 1 条措辞套用「超出实验所示」）；关注点集中在「摘要层面证据不足以支撑趋势论断」。
- 判读：综述政策让关注点转向综述特有维度 = OBSERVED（n=1）。但「旧口径会把无实验误判为缺陷」在本例中**没有发生**，所以政策的防误伤作用没有被真实压力检验，只能说明政策无害。
- **模型契约故障（非政策语义违规）**：SV-S0 首次尝试中 1 条 issue 的 `category = "actual_placeholder"`。生产严格枚举使整次调用被拒（在 review.run 中会如实记为 `wholePaper.status = failed`，单元不受影响 = fail-closed）。按协议重试 1 次后成功（DEVIATIONS D1）。研究论文 7 次整稿调用中 0 次出现。解析严格性属于 M16 既有行为，与本功能无关 → backlog。
- **学位论文**：预算内未做真实调用 → **REAL_MODEL_NOT_EVALUATED**；路由与 prompt 由既有零模型测试 T3 锁定。

## 5. 编造 / 事实层级 / 措辞核对（全部 134 条 finding：W-B 65 + 直接调用 69）

| 项 | 结果 |
|---|---|
| 录用预测 / 分数线 / 「达到某分区」措辞 | **0** |
| 声称已检索 / 已核实 | 0（程序命中 1 条为误报：SV-S0 建议作者「区分已证实的空白与推测」）|
| 点名论文 | Ren et al. 2024、Chen et al. 2024、Wen et al. 2024、Webster 2023 都在原文中；**没有编造任何题名 / 年份 / DOI** |
| 原文未出现的专名 | SDXL / SD v1-5 / v2（A 与政策臂都有）：作为「建议在其他检查点验证」的新实验，不是文献事实或已比较的断言 → 不算编造 |
| 强基线纪律 | W-B 的强基线条目写明「I suggest the authors verify this work's availability and comparability」，采纳了「建议核对」措辞；这条基线本身在原文中 |
| quote 逐字 | 整稿：政策臂 24 条中 0 条非逐字（W-B / B2 / C1 全部给出逐字 quote）；A 16 条中 1 条非逐字。W-B 单元 57 条中 2 条非逐字（LaTeX 归一化差异，既有 locator 三态处理）|
| 语言漂移 | W-B 单元 4 条中文（frontmatter 单元 3 条 + 跨章 1 条）。跨章 prompt 不含任何政策文本，所以漂移不归因于政策；整稿 / U-* 0 条。注意英文 prompt 中层级标签是中文「中科院三区」（见 §9）|
| L1 提升 | 证书 0；整稿 8 条恒 `AUTHOR_CHECK_REQUIRED` / 非阻断（L2），强基线意见未被提升 |

## 6. G3 Quality / Revision：PASS（含 1 个已修缺陷）

- **QualityReport（真实产物）**：overall NOT_EVALUATED / finalizable=false（缺编译与依赖，与政策无关）；L4 = **UNVALIDATED**，文案为「用户设定的发表目标「中科院三区」只用于决定审稿关注点，不是本层的通过标准」。**反事实**：用同一 gate 输入、不带政策重建 QualityReport，除 `binding.reviewPolicy` 与 L4 一句说明外逐字段相同；存储的 overall 与重建结果相同。
- **revision.plan（真实产物）**：69 条——单元 critical 1 + major 23 = 24 条 planned；整稿 8 条 major 全部 skipped，note「整稿 AI 学术建议（待作者核验）：进入下一轮可选改进清单，不自动派发 Writer」；minor 33 条 skipped；gate 阻止项 4 条（无章节归属）skipped。
- **回放（`replay-closure.mjs`，把真实 summary 交给生产 planner / 报告段，零模型）**：用户必需意见 `mandatory / planned`（active 与旧口径相同，不被降级）；需要作者新数据的 Reviewer 意见 → `author_decision_required` / 不派发；active 时 review finding planned 24（整稿 8 条延后），旧口径 32。报告：REVISION_TASK_COMPLETE 与 `NOT_READY` 分列，「系统不会虚构结果」段存在，外部意见「优先于发表目标」，无录用 / 达标措辞。
- **API（scripted 栈 live 探针）**：`scheme: sci` → 400「请在 cas 与 jcr 之间选择」；`targetJournalId` 与 `customJournalName` 同时给出 → 400 二选一。自填期刊名「中国图象图形学报」与内置已核验 profile 完全同名，但冻结后 `targetJournal = null`、层级 `USER_TARGET_UNVERIFIED` → 自由文本不继承 profile 规则。
- 关键发现：作者稿件口径下，严重度最高的单元 finding（critical）来自既有 Experiment Policy——「项目未导入实验数据 → 表中数值无可定位证据」。这在所有臂相同，与发表目标无关；planner 记录 21 条弱化授权，由 EditContract 管控。

## 7. G4 最小纠偏：PASS（1 个根因，2 处）

**缺陷**（编码前审计发现，零模型复现）：`createRun` 对**每个**新 run 都冻结快照（包括「研究论文 + 无目标」的 inactive 快照），而 `revision.plan` 以「快照非 null」决定延后整稿建议。结果是新建的无目标 run 也把整稿 AI major 留作可选项，与上轮「未设置目标 = 行为与升级前一致」的契约不符（上轮 T5 只用 `deferWholePaperAdvisory: true` 直接调用 planner，未覆盖 stage 条件）。修订报告第零节同样无条件声称「非阻断学术建议进入下一轮可选改进清单」。

**修复**（`backend/src/workflow/definitions.ts`、`backend/src/review/revisionGoalSummary.ts`，共 +4/−3 行）：两处统一为 `snapshot.active === true`。设置了目标 / 综述 / 学位论文 → 延后（不变）；研究论文无目标 / 旧 run → 按既有规则派发 major（恢复契约）。prompt 文本与政策维度均未改变 → 不递增 `REVIEW_POLICY_VERSION`。

**回归**：`wholePaperSynthesis.test.ts` 新增真实 review.run + revision.plan stage 用例（inactive 快照与旧 run 计划逐项相同；active → skipped）；`publicationTargetPolicy.test.ts` 新增报告段同条件用例并补充 active 断言。变异检查：只把两个源文件换回 HEAD → 两个新用例失败；恢复后 43/43 通过。

未修（不在本轮已证根因内）：前端 WorkflowPanel 在任务层 PASS 时的「新的非阻断建议见修订报告的『下一轮可选改进』」一句不区分 active / inactive（低风险文案，见 §9）。

## 8. G5 工程交付

| 项 | 结果 |
|---|---|
| Backend typecheck / build | exit 0 / exit 0 |
| Backend `npm test`（vitest --maxWorkers=4，串行于生产调用之后）| **441 files passed / 26 skipped；4852 passed / 47 skipped；0 failed**（新增 2 例）|
| Frontend vitest / build（tsc + vite）| 42 files / 390 passed；exit 0（本轮无前端改动）|
| Playwright（隔离 scripted 栈 :3100 + vite :5190，env 门控开启）| publication-target 3/3、m15-quality-report 2/2、m15-target-journal 3/3 = **8/8 passed** |
| Playwright smoke.spec | 1-3 **失败（既有）**：「论文项目」标题 / 「新建项目」链接已在 2026-10 工作台改版中移除；同文件其余用例被 serial 跳过。**不是**全量浏览器套件全绿 |
| CI / Linux Integration | 见会话最终答复（以最终 HEAD 的实际查询为准）|

费用与延迟（账本）：21 次全部 completed（1 次 retry 标记），输入 108,322 / 输出 35,659 tokens，provider 估算 ≈ $0.36（Coding Plan 订阅，估算为名义价）。W-B 墙钟 314 s（并发 3，调用合计 755 s）；直接调用每次 26–35 s。内存全程可用约 9 GB；生产调用之间串行，未与测试并行。

## 9. 结论、未知与 backlog（按优先级，不自动开启新里程碑）

**结论**：配置按生产路径冻结并到达真实模型（G1 PASS）；没有关键事实 / 状态误导；Review / Revision 不变量通过（G3 PASS）；发现并修复 1 个确定性语义缺陷（G4）。真实模型在「设置目标 vs 未设置」下出现可解释的关注点变化（对比公平、统计显著性、可复现、新实验标注），但这只是单篇论文、n=2–3 的定性观察；不同层级之间的差异 INCONCLUSIVE。

仍未知：
1. 跨论文 / 跨领域是否稳定（n=1 篇研究论文，已开封样本）；层级（B vs C、中文收录体系）是否产生可区分的差异。
2. 学位论文真实行为（REAL_MODEL_NOT_EVALUATED）；综述政策对「无实验被误判」的防护（本例旧口径也没误判）。
3. Reviewer 在**有**检索结果时是否会把检索到的强基线与本文对比，或编造（本轮各臂都没有检索）。

Backlog：
1. 整稿解析：单条 issue 非法 `category` 导致整次 8 条丢失（fail-closed 但浪费）——可改为逐条丢弃并计数（M16 路径，需单独决定）。
2. 英文 prompt 中层级标签用中文（「中科院三区」）；本轮整稿 / U-B 无漂移，未证有害；如改需递增政策版本。
3. WorkflowPanel 任务层 PASS 文案不区分 active / inactive 政策。
4. 既有能力缺口（本轮未补，均不影响本次结论）：快速 Review（PDF SectionReview 链路）不读发表目标；学位论文创建页无发表目标输入；Research Search / Evidence 强基线检索未绑定 ReviewPolicy；smoke.spec 1-3 旧文案。
