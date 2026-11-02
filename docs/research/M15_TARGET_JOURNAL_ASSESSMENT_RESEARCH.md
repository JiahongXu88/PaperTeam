# M15 Target Journal Assessment — 研究报告（源码 / 文献 / 数据矩阵）

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）· 基线：main @ `7f133ee`（开工时 HEAD = origin/main = ls-remote，工作区 clean）
- 原始目标源：用户本机 `Downloads\PaperTeam_M15_Quality_Gate_Handover.md`（已读；四问原始目标、§2「不得声称 80 分 = 可投 / 核心期刊水准」、§4 验收矩阵）。本轮任务书在其上把目标升级为「论文 × 目标期刊的可核验评估」——但**显式放弃**录用预测与付费人工盲评，这与 M15.9「期刊级判别」（零标签下不可证）不同，本轮只承诺可观察、可核验部分。
- 仓库外证据：`D:\PaperTeamData\M15\TargetJournalAssessment\`

## 1. 既有能力审计（源码事实，不以历史报告为准）

| 模块 | 文件 | 生产接线 | 本轮判断 |
|---|---|---|---|
| 分层 QualityReport L0–L4 | `backend/src/quality/qualityReport.ts`；契约 `docs/research/M15_QUALITY_REPORT_CONTRACT.md` | 生产（gate.passed = overall.finalizable；L4 恒 UNVALIDATED） | **只读复用**为 B 块事实源；不改语义 |
| 官方指南工件 + 确定性合规（M15.9 G1） | `target/TargetGuidelineService.ts`、`guidelineFacts.ts` | 生产 API，但需**用户手工导入 JSON**；`appliesToArticleTypes` 字段**从未被读取**（稿型不影响判定）；无规则分类、无来源复核 | 复用检查器（参考文献类含 PDF 区间判定）；新增 profile 层弥补缺口 |
| 期刊 rubric（M15.9 G2，模型 advisory） | `target/TargetRubricService.ts` | 生产 API，单次 + ≤1 repair，强制证据引文 | **复用**为 B 块主观意见（未校准、永不影响结论） |
| benchmark 发现 / 画像 / 观测带（M12） | `TargetBenchmarkService` / `TargetProfileService` / `TargetGapService` | 生产 | **复用**为 C 块近期发表参照（POSITIVE_ONLY_REFERENCE） |
| 证据审计 / 审计修订 / 投稿准备度（M15.16–18） | `TargetEvidenceAuditService` 等 | flag 缺省关 | 不改；新入口不依赖 flag |
| 修改意见队列 + 修订计划 + EditContract | `review/externalInstructions.ts`、`review/revisionPlan.ts`、`quality/editContract.ts` | 生产 | 新增 `target_journal` 机器 advisory 来源，沿用 target_audit 的降级优先级；授权内核不变 |
| Agent 写边界 | `runtime/pi/workspaceGuard.ts`（缺省只可写 `manuscript/`） | 生产 | 新工件全部在 `research/` 下 → Agent 不可写 |

结论：没有平行开发 Reviewer / 检索 / EvidenceStore 的必要。真正缺的是「带来源与适用域的期刊规则库」「稿型适用性」「来源复核」「把 L0–L3 + 合规 + 意见汇成一个诚实结论」与「UI 主路径」。

## 2. 第三方项目对比（2026-11-02 经 `gh api` / raw / hf-mirror 核实；未核实项标 UNVERIFIED）

| 项目 | 最新 commit | 代码许可 | 数据许可 | 独立人工历史标签？ | 全文 | 入口 / 资源 | 可移植最小机制 | 难外推到中国期刊之处 | 裁决 |
|---|---|---|---|---|---|---|---|---|---|
| PaperScorer（[repo](https://github.com/zlab-princeton/PaperScorer)，[arXiv 2610.31791](https://arxiv.org/abs/2610.31791)） | `f76d60e` 2026-10-26 | MIT（LLaMA-Factory 部分 Apache-2.0） | HF `license: other`（具体条款 UNVERIFIED） | ICLR：真实 OpenReview 录用 / 拒稿；arXiv 集的「拒稿」定义 UNVERIFIED | markdown；Vision 集页图 506 GB | `paperscorer run x.pdf`；3B/7B，vLLM + CUDA，MinerU 预处理需 ≥40 GB GPU | 无训练的基率 + 温度校准 `p = σ(ℓ/τ + logit(π))` | 英文 ML 会议；中文期刊无公开录用 / 拒稿记录 → 无合格负例 | **REFERENCE_ONLY**（不部署 checkpoint；保留可替换预测器接口位置，当前 `HISTORICAL_DECISION_PREDICTION = DISABLED_NO_VALIDATED_DATA`） |
| SurveyReview（[repo](https://github.com/zai-org/SurveyReview)） | `6566398` 2026-08-07 | GitHub Apache-2.0；HF 仓 LICENSE 为 MIT | 未单列；原文条款 UNVERIFIED | 来自真实审稿报告（F1000 / PeerJ / OpenReview）；「报告 → 分数」由人还是 LLM 转写 UNVERIFIED | 有（675 篇综述；test 163 篇） | `src/api_base_evaluate.py`（OpenAI 兼容 API） | 四维 rubric（可读性 / 批判性 / 全面性 / 结构，{-2,-1,1,2}）+ MAE | 仅英文综述 | **ADOPT_METHOD**；数据只作英文离线参照（见验收报告 D3） |
| CoCoReviewBench（[repo](https://github.com/hexuandeng/CoCoReviewBench)，[PMLR v306](https://proceedings.mlr.press/v306/deng26j.html)） | `2580687` 2026-05-02 | CC BY-4.0 | OpenReview 内容按其条款 | **是**：审稿人原句（意见单元）；拆分 / 分类 / 正误校验由 LLM 完成 | 3,900 篇 markdown 在仓库 | 分类模型需 GPU；数据可直接读 | 「无人类参考则不计」的类别级召回；按 22 类根因码统计 | ICLR / NeurIPS 英文；可能在预训练语料中 | **ADOPT_METHOD + 小样本 ADOPT_DATA**（仅本地评测，不再分发） |
| ReviseBench（[repo](https://github.com/CGCL-codes/ReviseBench)） | `e0f1aeb` 2026-04-23 | **无 LICENSE**（API 404 → 保留所有权利） | 无 | 原稿 + 人类修订稿 + OpenReview 意见（12 篇） | 有 PDF | OpenHands + Gemini judge | 原稿 / 人类修订 / 模型修订三方比较的思路 | 许可缺失 | **REFERENCE_ONLY → D4 DATA_BLOCKED（许可）** |
| SciFact（[repo](https://github.com/allenai/scifact)） | `68b98a5` 2023-10-15 | Apache-2.0 | claims CC BY 4.0；abstracts ODC-By | claim–摘要 支持 / 反驳标签 | 仅摘要 | RoBERTa | Claim 核验任务定义 | 生物医学英文摘要，不评整稿质量 | **REFERENCE_ONLY** |
| OpenAlex（[API](https://help.openalex.org/api/)） | — | — | CC0 | 无（元数据） | 否 | 无 key 每日预算有限；免费 key 10× | source 的 ISSN / homepage / topics 消歧 | 不是期刊规则或录用真值 | **ADOPT_DATA（仅身份元数据）**：两个内置 profile 的 OpenAlex ID 已实时核对（S2764372918 → 1006-8961；S202381698 → 1932-6203） |
| journal-recommender（[repo](https://github.com/zero565656/journal-recommender)） | `407aff1` 2026-05-27 | **无 LICENSE** | — | 无（提示词 skill） | 否 | — | 「来源 / 新鲜度 / 风险」分开展示的思路 | 依赖 LetPub / 分区等非官方来源 | **REFERENCE_ONLY**（不复制文本） |

共同结论：**没有任何公开数据提供中文期刊的人工质量标签或录用 / 拒稿记录**。可合法、零 GPU 移植的只有方法（SurveyReview rubric、CoCoReview 已知参考召回、PaperScorer 校准公式）。

## 3. 期刊官方规则来源（G1）

| 期刊 | 官方页面（2026-11-02 抓取，原文不入库，只入 SHA） | 提取规则 | 在线复核 |
|---|---|---|---|
| 中国图象图形学报（CJIG，ISSN 1006-8961） | 撰稿要求 `/zh/info/13448/`（sha `3c188a02…`，与 2026-10-28 M15.9 快照**逐字节一致**）；期刊简介 `/zh/info/24920/`（`9f8fd1e4…`，与 10-28 不同——页面其他部分变化，原句仍在） | 16 条：hard_deterministic 11、evidence_based 4、advisory 1；稿型：研究 / 小综述 / 数据集 / 代码 = 接受，系统综述 / 研究方案 = **官方未写明** | 25/25 原句命中，VERIFIED_LIVE |
| PLOS ONE（ISSN 1932-6203，域外对照） | submission-guidelines、data-availability、journal-information、criteria-for-publication、what-we-publish（5 页 SHA 见 `profileRegistry.ts`；robots `Crawl-delay: 30` 已遵守） | 10 条：hard_deterministic 6、evidence_based 2、advisory 2；**叙述性综述官方明文「不受理未经邀约稿件」** | 快照 17/17；在线复核时 2 页网络失败 → UNREACHABLE（如实记录，未升级为在线验证） |

收录 / 分级：CJIG 页面自述「T1 类（2025）」「CSCD / Scopus / JST / EBSCO」→ 标 `SELF_DECLARED`；**北大中文核心在官方页面未见明文 → UNVERIFIED**（不推断）。

## 4. 外推限制（必须随结论一起出现）
1. 已发表论文只能做正向参照（幸存者偏差），不是负例，也不是隐含硬阈值（D1 实测：1/20 篇已发表 CJIG 论文不满足「近 10 年 ≥60%」，说明官方明文本身也非严格执行）。
2. 主观维度（创新性、贡献、论证）只有模型意见；在英文 ML 会议上的专家对齐（D2）不能迁移成中文期刊的质量校准。
3. 规则覆盖面受限于稿件保真度：LaTeX 源码可检查题目 / 摘要 / 关键词 / 章节 / 脚注等；PDF-only 只能检查参考文献类，图表像素、编译后版式、投稿系统字段一律不可检查。
