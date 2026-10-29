# M15.11 — Public Peer-Review Evidence Pilot（公开同行评审证据试点）

- 日期：2026-10-29 · 任务书：M15.11（属 M15；**M15_OVERALL=INCOMPLETE 维持**）
- 基线：`282d2450a3ef815a716dd9d48cd3e65e1ab84674`（== origin/main，clean）→ 本轮提交见 §10
- 数据根（仓库外）：`D:\PaperTeamData\M15\M15_11\`（phase-a…e + MANIFEST.json 37 文件 SHA256 全账）
- 预算：600 保护上限；实际 **539 次真实模型调用**（物理计数含 C0/C1/judge/失败尝试），估算成本 **$4.15**（1.30M input / 334k output / 3.34M cache-read tokens）
- 脚本（仓库内）：`scripts/m1511/*.mjs`（13 个，采集/抽样/运行/冻结/提取/对齐/聚合/裁决）

## 0. 第一屏裁决（任务书 §9-#13：四选一，不模棱两可）

**本轮裁决 = `PILOT_NO_MEASURABLE_GAIN`（附 `COST_INEFFICIENT` 标记）**，按冻结协议 §6 的预注册判据执行：

- 主指标 **Human-Review-Issue Coverage（族均）**：C0 通用基线 **33.5%** vs C1 PaperTeam 生产链 **37.0%**，差 **+3.5pp**（bootstrap 95%CI [−2.8, +9.6]；合并口径 31.5% vs 35.1%，+3.6pp）——**未达预注册的 ≥+10pp 有效增益门**。
- 成本：C1 每族 **35.9 次调用/227s** vs C0 **1.08 次/43s**（33×/5.3×）且增益 <10pp → 触发 COST_INEFFICIENT 预注册标记。
- **重要探索性正信号（非主判据）**：SERIOUS 问题子集（方法正确性/关键实验缺失/过度声称/重要相关工作）上 C1 **大幅领先**——冻结 typing 口径 31%→64%（+31pp，32 个 serious 问题族）；剔除 7 条 regex 误型后的 investigator 敏感性口径 40%→68%（+28pp，25 个真 serious）。方向稳健但 n 小，属探索性。
- Grounded Finding Ratio：C0 99.4% / C1 99.3%（两臂几乎全部 finding 带稿件内有效锚点，无退化）。
- M15.9/M15.10 的"目标期刊独立标签=0"事实不被本结果改写；**任何中文期刊"达到录用水平"的声称仍然不能做出**（见 §8-#14）。

## 1. 唯一科学问题与回答

**问**：未见过真实审稿意见时，PaperTeam 生产 Review 链路相对同模型通用 Reviewer，能否更好覆盖公开专家同行评审指出的实质学术问题？

**答**：在本数据集（ICLR 2025 公开被拒投稿 12 族 × 693 个可判读专家问题族）上，**总体覆盖率只有小幅非显著优势（+3.5pp），不足以按预注册标准宣称有效增益；但在"严重问题"子集上有大幅探索性优势（+28~31pp），且依据可靠性（grounded ratio）无退化**。结论：PaperTeam 的分节+证据锚定机制**改变了发现的问题结构**（更严重、更可定位、更细粒度：864 vs 173 findings、121 vs 73 个被用于匹配的不同 finding），而非简单提高总召回。代价是 33 倍调用成本，其中约六成是 PaperMap 章节摘要等结构性开销。

## 2. 数据源与合规（Phase A，详见数据目录 phase-a/）

- **源**：OpenReview API v2，ICLR 2025 被拒投稿（venueid `ICLR.cc/2025/Conference/Rejected_Submission`）。备选源（PeerRead/eLife）未启用（主源充分；两候选源上限未突破）。
- **反爬合规**：OpenReview 2026 年起对匿名 API 全面启用 Cloudflare Turnstile 浏览器验证。本轮由**用户本人在真实 Chrome（独立临时配置）中完成人机验证**（站点设计的验证路径，非绕过）；验证后 cookie 仅用于 ≥1s 间隔的公开数据读取。自动化 Chrome 中 Turnstile 拒绝发 token 的现象如实记录（未对抗）。
- **许可（条款页 2026-09-24 版逐字取证）**：评审=CC BY 4.0；元数据=CC0 1.0；论文正文公开可读、版权归作者→**仅内部分析、不再分发**（PDF 与评审原文全部留在仓库外数据目录；公开仓库只有计数/哈希/脱敏摘录级报告）。
- **版本对齐（核心风险）**：`note.content.pdf` 指向最新版；录用稿恒带 camera-ready 修订。**VERSION_CONFIRMED 规则**：投稿 note 的 invitations 不含任何 Revision/Rebuttal_Revision/Camera_Ready_Revision ⇒ 当前 PDF=审稿人所见版本。推论：frame=被拒投稿（录用稿结构性排除，局限 L1）。
- **抽样框**：19,076 条 listing（33 页零解析失败）→ ICLR 2025 版本可证被拒族 **1,320**；seed=1511、12 个 primary-area 桶比例分层、桶内 seeded shuffle；**选择输入仅元数据，未读评审正文**。

## 3. 样本与盲态（Phase B，详见 phase-b/）

- 34 候选（24 目标+10 预备）→ 34/34 通过资格核验（每族 3-5 条 Official_Review；实质阈值=结构长度，无语义挑选）→ 8 DEV+16 HELD-OUT+10 RESERVE。
- **预算驱动的预注册收缩（deviation v2，HELD-OUT 启动前冻结）**：DEV smoke 实测 C1 单族 ≈38 次调用（21 次 PaperMap 摘要）→ 600 上限最多 ~13 个 C1 族 → **DEV=1 完成族、HELD-OUT=12（cand-09…20）、cand-21…24 RESERVED_UNRUN**。
- **盲态纪律**：HELD-OUT 评审正文存 sequester/；C0/C1 12/12 族预测哈希于 2026-10-29T05:17:13Z 冻结（predictions-frozen.json，missing=[]）**之后**才开封提取（LEAKAGE_AUDIT v2/v3 复核记录）。臂输入目录从未含评审内容。

## 4. 对照臂（Phase C，详见 phase-c/arm-configs.json）

| 臂 | 入口 | 模型 | 输入 | 机制差异 |
|---|---|---|---|---|
| C0 通用基线 | `adapter.runAgent` 直调，contextScope `m1511-c0/*`（default role，**零 skill 注入**） | zai-coding-cn/glm-5.3 | 同项目 PDF→PyMuPDF chunks 重组全文（页标记） | 无 |
| C1 生产链 | 生产 `existing_paper_review` workflow（import-pdf goal=review_only；citationSemanticMode=off 统一冻结） | 同上 | 同一 PDF | 分节审阅+academic-review skill+引用上下文+PaperMap |
| C2 | NOT_RUN（预注册省略：ICLR 无合法 venue guideline 工件；禁止把 CJIG/CEA 统计套 ICLR） | — | — | — |

- 两臂消费**同一解析产物**（稿件正文相同）；C1 多出的是被测机制本身（分节/引用上下文/章节索引摘要）。
- 对齐 judge：同模型盲态（Set A 人类问题族 vs Set B 某臂 findings，不知臂名），语言中立条款（deviation v3，HELD-OUT judge 前冻结）；24 次调用零解析失败。

## 5. 结果（Phase D，详见 phase-d/paired-metrics.json）

### 5.1 主指标与子集

| 指标 | C0 | C1 | 差 |
|---|---|---|---|
| HRI-Coverage（族均，主口径） | 33.5% | 37.0% | **+3.5pp**（CI95 [−2.8,+9.6]，逐族 8 正 4 负） |
| HRI-Coverage（合并 693 问题族） | 31.5%（218） | 35.1%（243） | +3.6pp |
| Serious-Coverage（冻结 typing，32 族） | 31% | 64% | **+31pp** |
| Serious-Coverage（敏感性，剔 7 误型→25 族） | 40% | 68% | **+28pp** |
| Grounded Finding Ratio | 99.4% | 99.3% | −0.1pp（无退化） |
| findings 总量（12 族） | 173（≈14/族） | 864（≈72/族） | 5.0× |
| 匹配用到的不同 finding | 73/173（42%） | 121/864（14%） | — |

### 5.2 成本

| | 每族调用 | 每族墙钟 | 单位检出成本* |
|---|---|---|---|
| C0 | 1.08 | 43s | 6 调用/百匹配问题族 |
| C1 | 35.9（含 ~21 PaperMap 摘要） | 227s | 198 调用/百匹配问题族 |

*按合并口径换算。总账：539/600 调用、$4.15、约 2.5h 模型墙钟。

### 5.3 AI-only 与误报（任务 §9-#10 的诚实处理）

- REFUTED（确定性反证）规则只匹配英文措辞 → C0 14 条被规则命中、C1（中文输出）0 条——**该对比是语言伪影，判 NOT_EVALUABLE_PROPERLY，不作依据**。
- UNVERIFIED_AI_ONLY：C0 100 条 / C1 743 条未被匹配的 finding，其中大量为 C1 细粒度风格/一致性观察（人类评审不写此类小项）——**不称 FP**，如实入 phase-d 明细。

### 5.4 investigator audit（qualitative-audit.md，非独立人工专家）

- 10 matched 抽查：C0 侧 2/5 过匹配（宽泛 finding 吸收多个不同人类问题= fan-in）；C1 侧 1/5 松散。**judge 噪声对两臂绝对值均有上偏，方向略利于 C0**——+3.5pp 差值应保守解读。
- unmatched 高度重叠且为两臂共同盲区：**全局"目标-方法错位""为何该设计能支撑该任务"类 meta 批评**（需要跨节综合与论文级判断）。
- serious typing 全量 32 条复核：7 条误型（21.9%，写作/表述被 regex 命中）→ 敏感性分析确认 serious 增益稳健。

## 6. 产品缺陷修复（实验揭示，入 main）

`backend/src/paper/sectionChunking.ts` findReferencesPage：原"标题行+[n] 标记"双条件在 **author-year 引用风格**（ICLR/NeurIPS 模板，无 [n]）的参考文献页永不满足 → references 恒 0 → `existing_paper_review` 在此类 PDF 上 citation.metadata 阶段崩溃。修复两轮（v2.2 页内年份证据；v4 标题页+次页窗口——SOLOS 案例条目跨页）。测试：`backend/test/paper/pdfIngest.test.ts` 新增 author-year/spill-over/负例 3 组用例，pdfIngest 9/9、referenceExtraction+realPaperRegression 29/29 绿。**该缺陷证明 C1 生产链此前从未在英文会议 PDF 上跑通**——本轮为首次端到端实证。

## 7. 局限（诚实清单）

1. L1 frame=被拒投稿（版本可证规则的推论，录用稿结构性排除）；accept/reject 未作质量真值。
2. L2 judge=同模型盲态代理（LLM_JUDGE_PROXY），存在 fan-in 过匹配；绝对值上偏、差值保守解读。
3. L3 分母膨胀：693 问题族中跨审稿人近义复述未被 Jaccard≥0.6 完全合并（两臂对称承受）。
4. L4 REFUTED 规则语言偏倚 → 不可用（已降级报告）。
5. L5 模型预训练可能见过公开评审（两臂对称；外部效度局限）。
6. L6 HELD-OUT 12 族/serious 25 问题族均为小样本探索性；C1 增益结论限"本数据集+本 judge"。
7. L7 DEV 收缩到 1 族（预算），无方差估计。

## 8. 任务书 §9 十五问逐条

| # | 问 | 答 |
|---|---|---|
| 1 | HEAD/提交/推送？ | 基线 282d2450a3；本轮提交+推送见 §10（含 sectionChunking 修复+测试、13 脚本、本报告、PROJECT_STATUS） |
| 2 | 数据源/会议/年份/领域/法律依据？ | OpenReview API v2；ICLR 2025（CV/ML/NLP 等 12 个 primary-area 桶）；评审 CC BY 4.0+元数据 CC0+论文公开可读仅内部分析；Turnstile 由用户真人通过（非绕过） |
| 3 | 多少族？DEV/HELD-OUT/排除？ | 框 1,320 版本可证被拒族；候选 34；34/34 合格；**实际运行 DEV 1+HELD-OUT 12**（预算预注册收缩），4 HELD-OUT+9 RESERVE 未运行（NOT_RUN 清单在 MANIFEST）；零样本因版本/许可/空评被剔除（规则前置排除） |
| 4 | 多少条 Official Review？版本对应如何证明？ | HELD-OUT 12 族共 **51 条**（3-5/族）；版本=invitations 无修订类邀请 ⇒ content.pdf 即审稿版（data-source-audit §versionAlignment；edits 取证） |
| 5 | 冻结后才解封？泄漏/去重证据？ | predictions-frozen.json 05:17:13Z（missing=[]）先于 sequester 首次读取；LEAKAGE_AUDIT v1-v3；族去重=归一化标题（跨年）+问题族 Jaccard |
| 6 | 两臂入口/配置/输入覆盖？ | §4 表；同模型同解析产物；C1 额外=分节+skill+引用上下文（=被测机制）；无隐藏背景 |
| 7 | 调用数/tokens/费用/时长？ | 539/600 物理调用；1.30M in/334k out/3.34M cache；$4.15 估算（Z.AI Coding Plan 通道，实际计费以账单为准）；模型墙钟约 2.5h |
| 8 | HELD-OUT 数/可对齐问题/不可判？ | 12 族；693 可判读问题族（716 原子问题）；13 条 SUBJECTIVE_OR_UNJUDGEABLE（不入分母） |
| 9 | coverage/serious/grounded？ | §5.1：33.5→37.0（+3.5pp 未达 +10pp 门）；serious 31→64（敏感 40→68）；grounded 99.4/99.3 |
| 10 | AI-only/无依据/未知批评？ | UNVERIFIED_AI_ONLY：C0 100/C1 743（不称 FP）；REFUTED 规则语言偏倚→NOT_EVALUABLE（§5.3） |
| 11 | 差值分布/不确定性/对错案例？ | 逐族 8 正 4 负，CI95 [−2.8,+9.6]；对例=基线薄弱/动机缺量化/证据不足假设（§5.4）；错例=judge 把"理论未证实"匹配到"基线窄"（C0 fan-in） |
| 12 | 成本比可接受？单位检出成本？ | 33× 调用/5.3× 墙钟；6→198 调用/百匹配问题族（33×）；COST_INEFFICIENT 触发（预注册标记） |
| 13 | 四选一裁决？ | **PILOT_NO_MEASURABLE_GAIN + COST_INEFFICIENT**（主判据差 +3.5pp<+10pp）；serious 子集 +28~31pp 为探索性正信号，如实并列报告 |
| 14 | 能否声称某中文期刊"达到录用水平"？ | **不能**。仍缺：期刊级独立人类标签（M15.10 =0）、ICLR→CJIG/CEA venue 语义不可迁移、录用相关性与 false-ready 率未评估 |
| 15 | 下一轮唯一优先建议？ | 见 §9 |

## 9. 下一轮唯一优先建议（结果导向，不做无止境迭代）

**把"论文级目标-方法对齐与声称-证据审查"做成一个低成本整稿 pass，并入 PaperTeam 生产链，并在新 held-out 上复测。**依据：(a) 两臂共同盲区恰是 meta 级全局批评（goal-method misalignment、claim-evidence）；(b) C1 已证明在 serious 子集上有结构优势（+28~31pp），缺的是整稿综合而非更多分节；(c) 成本主因是 PaperMap 章节摘要（~21 调用/族，纯结构性开销）——引入整稿 pass 的同时应把摘要改为按需/缓存/复用，把 C1 每族调用压到 ~15-20，使 33× 成本比降到 ~10×。**复测必须用全新 held-out**（本 12 族已消费）。

## 10. Git/CI 收口

- 本轮提交：① sectionChunking author-year 修复 + pdfIngest 测试（§6）；② `scripts/m1511/` 13 脚本；③ 本报告；④ PROJECT_STATUS 顶部条目。验证：backend typecheck/build ✓；定向回归（pdfIngest 9/9、referenceExtraction、realPaperRegression 29/29）✓；`git diff --check` ✓；提交后 HEAD==origin/main 复核。
- CI（GitHub CI + Linux Integration）以最终 HEAD 状态回查为准，不因等待 CI 虚报结论。
- 数据侧完整账：`D:\PaperTeamData\M15\M15_11\MANIFEST.json`（37 文件 SHA256、来源、license/access、可发布性分类）；若早期止损则只交付已完成阶段——本轮全阶段完成，无 NOT_RUN 空文件。
