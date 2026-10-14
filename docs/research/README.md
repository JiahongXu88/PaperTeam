# 研究 / 工程报告索引（Research & Engineering Reports）

本目录保存各里程碑的实验设计、真实运行验收、审计与校准报告——它们是
PaperTeam 能力声明的证据来源，只增不删。当前工程状态摘要见
[../PROJECT_STATUS.md](../PROJECT_STATUS.md)；产品视角见
[../product-guide.md](../product-guide.md)。

## 存放与公开约定

PaperTeam 是个人开源项目。里程碑计划、技术调研、实验分析及阶段验收报告默认保存在本目录，不使用 `D:\Reports` 或公司项目文档管理约定。提交前检查并脱敏服务器定位信息、凭据、私人论文和未授权实验材料。

原始报告、诊断日志、临时运行产物和私人证据保存在仓库外 `D:\PaperTeamData/<milestone>/`（例如 `D:\PaperTeamData\M13_7`），不提交 GitHub。Linux 原始产物同样保存在 checkout 之外。

## M6 — Research Discovery & Evidence-grounded Pipeline（已冻结）

- [M6_FINAL_SUMMARY.md](M6_FINAL_SUMMARY.md) — 里程碑总览（M6.0–M6.9，冻结 D-0041）
- [M6.1_SEARCH_RAG_ADR.md](M6.1_SEARCH_RAG_ADR.md) / [M6.1_SEARCH_RAG_OSS_ANALYSIS.md](M6.1_SEARCH_RAG_OSS_ANALYSIS.md) — Search/RAG 架构决策与调研
- [M6.8_EVALUATION_REPORT.md](M6.8_EVALUATION_REPORT.md) — 可靠性评估框架与三实验（live 报告另见 `evaluation/reports/`）

## M7 — Research Discovery Activation

- [M7_SCOPE_FREEZE.md](M7_SCOPE_FREEZE.md) / [M7_FINAL_REPORT.md](M7_FINAL_REPORT.md)
- [M7.1_ARCHITECTURE_REVIEW.md](M7.1_ARCHITECTURE_REVIEW.md) / [M7.1_DISCOVERY_VALIDATION.md](M7.1_DISCOVERY_VALIDATION.md) / [M7.1_WEB_SEARCH_DESIGN.md](M7.1_WEB_SEARCH_DESIGN.md)
- [M7.2_IMPLEMENTATION_PLAN.md](M7.2_IMPLEMENTATION_PLAN.md) — 全文获取
- [PAPERTEAM_SELF_REVIEW_M7.md](PAPERTEAM_SELF_REVIEW_M7.md) / [PAPERTEAM_SKILL_DISCOVERY.md](PAPERTEAM_SKILL_DISCOVERY.md)

## M8 — Controlled Deep Research Loop

- [M8_ROADMAP_PROPOSAL.md](M8_ROADMAP_PROPOSAL.md) / [POST_M8_MARKET_ALIGNED_ROADMAP.md](POST_M8_MARKET_ALIGNED_ROADMAP.md)
- [M8.1_RESEARCH_PLAN_IMPLEMENTATION.md](M8.1_RESEARCH_PLAN_IMPLEMENTATION.md) → [M8.5_RESEARCH_PIPELINE_HARDENING.md](M8.5_RESEARCH_PIPELINE_HARDENING.md) — 计划 / 执行 / 覆盖 / 缺口 / 受控循环 / 加固
- [M8_DEEP_RESEARCH_VALIDATION_REPORT.md](M8_DEEP_RESEARCH_VALIDATION_REPORT.md) — 真实模型 + 真实学术检索验收

## M9 — Full Paper E2E Activation

- [M9.1_E2E_ACTIVATION_FOUNDATION.md](M9.1_E2E_ACTIVATION_FOUNDATION.md) → [M9.6_FULL_PAPER_E2E_ACCEPTANCE.md](M9.6_FULL_PAPER_E2E_ACCEPTANCE.md) — 激活 / Web 搜索 / 全文 / 锚定证据 / 确定性参考文献 / 全链验收
- M9.7 系列 — Writer 证据审计与 A/B（[M9.7.1](M9.7.1_GLM53_BASELINE_EVALUATION.md) ~ [M9.7.7](M9.7.7_CLAIM_GROUNDING_SUPPORT_AB_EVALUATION.md)）
- [M9.8_RESEARCH_EVIDENCE_ALIGNMENT.md](M9.8_RESEARCH_EVIDENCE_ALIGNMENT.md) / [M9.9_EVIDENCE_SUPPLY_INTEGRATION.md](M9.9_EVIDENCE_SUPPLY_INTEGRATION.md) / [M9.10_FACT_PRESERVATION_VALIDATION.md](M9.10_FACT_PRESERVATION_VALIDATION.md)

## M10 — Existing Paper Revision 产品化

- [M10.0_BENCHMARK_DESIGN.md](M10.0_BENCHMARK_DESIGN.md) 等 M10.0 系列 — 评估设计 / 审计 / 协议 / 指标 / 人工评估 / 市场调研
- [M10.1_DOCUMENT_DATA_INGESTION_REPORT.md](M10.1_DOCUMENT_DATA_INGESTION_REPORT.md) / [M10.1.1_COMMON_ASSET_INGESTION_REPORT.md](M10.1.1_COMMON_ASSET_INGESTION_REPORT.md) / [M10.2_MULTIMODAL_DOCUMENT_UNDERSTANDING_REPORT.md](M10.2_MULTIMODAL_DOCUMENT_UNDERSTANDING_REPORT.md) — 文档理解与 ingestion（Docling）
- [M10.3_EXISTING_PAPER_REVISION_REPORT.md](M10.3_EXISTING_PAPER_REVISION_REPORT.md) / [M10.3_REAL_PAPER_E2E.md](M10.3_REAL_PAPER_E2E.md) / [M10.3.1_REAL_PAPER_RERUN.md](M10.3.1_REAL_PAPER_RERUN.md) / [M10.3.1_REVISION_RELIABILITY_CLOSURE.md](M10.3.1_REVISION_RELIABILITY_CLOSURE.md) — 真实论文返修链路
- [M10.4.0_AGENT_TRACE_REPORT.md](M10.4.0_AGENT_TRACE_REPORT.md) / [M10.4.1_REVISION_PERFORMANCE_REPORT.md](M10.4.1_REVISION_PERFORMANCE_REPORT.md) / [M10.4.3_FACT_PLAN_DEDUP_REPORT.md](M10.4.3_FACT_PLAN_DEDUP_REPORT.md) / [M10.4.4_WORKFLOW_RELIABILITY_REPORT.md](M10.4.4_WORKFLOW_RELIABILITY_REPORT.md) — 观测 / 性能 / 去重 / 可靠性
- [M10_MODEL_ROUTING_BENCHMARK.md](M10_MODEL_ROUTING_BENCHMARK.md) — 模型路由基准

## M11 — Survey 产品化 + Existing Paper 可靠性收口

- [M11_2_3_REVISION_CONVERGENCE_REPORT.md](M11_2_3_REVISION_CONVERGENCE_REPORT.md) — 降级证据下的修订收敛
- [M11_3_SURVEY_PRODUCT_ACCEPTANCE.md](M11_3_SURVEY_PRODUCT_ACCEPTANCE.md) / [M11_3_PRE_ACCEPTANCE_REPORT.md](M11_3_PRE_ACCEPTANCE_REPORT.md) — 综述产品验收（双 Case 到 PDF）
- [M11_4_EXISTING_PAPER_ACCEPTANCE_PLAN.md](M11_4_EXISTING_PAPER_ACCEPTANCE_PLAN.md) / [M11_4_EXISTING_PAPER_ACCEPTANCE_REPORT.md](M11_4_EXISTING_PAPER_ACCEPTANCE_REPORT.md) — 真实返修验收计划与全程记录（Attempt 1–9）
- [M11_4_QUALITY_GATE_CALIBRATION_AUDIT.md](M11_4_QUALITY_GATE_CALIBRATION_AUDIT.md) / [M11_4_QUALITY_GATE_BENCHMARK.md](M11_4_QUALITY_GATE_BENCHMARK.md) / [M11_4_QUALITY_GATE_PRODUCT_CLOSURE.md](M11_4_QUALITY_GATE_PRODUCT_CLOSURE.md) — 质量门校准与分层语义
- [M11_4_RELIABILITY_CLOSURE.md](M11_4_RELIABILITY_CLOSURE.md) — 可靠性收口（21 次真实 run 定论）
- [M11_5_CLOSURE_REPORT.md](M11_5_CLOSURE_REPORT.md) — M11 产品 / 文档 / 开源收口

## M12 — Publication Intelligence × Multimodal × Deterministic Figures

- [M12_0_FAST_ARCHITECTURE_AUDIT.md](M12_0_FAST_ARCHITECTURE_AUDIT.md) — M12 快速架构审计与三方向冻结（Target Publication / Multimodal / 确定性图表）
- [M12_BATCH1_DETERMINISTIC_FOUNDATIONS.md](M12_BATCH1_DETERMINISTIC_FOUNDATIONS.md) — Batch 1 确定性基础层实施（A1–A6 benchmark 全链 + B1–B2 视觉投影 + C1–C3 图表管线；含隔离证明与三个真实 smoke）
- [M12_BATCH2_PRODUCT_CLOSURE.md](M12_BATCH2_PRODUCT_CLOSURE.md) — Batch 2 产品收口（A7–A10 Target Profile/Readiness/UI + B3–B5 多模态评审 + GitHub CI 79 连败根因修复；真实 OpenAlex/GLM-5.3/glm-5.3-flash 视觉 smoke）
- [M12_BATCH2_TRACK_A_HANDOFF.md](M12_BATCH2_TRACK_A_HANDOFF.md) / [M12_BATCH2_TRACK_B_HANDOFF.md](M12_BATCH2_TRACK_B_HANDOFF.md) — 双轨 subagent 交接契约（工厂签名 / HTTP 路由 / 偏差记录）
- [M12_2_5_LINUX_DUAL_RUNTIME_CLOSURE.md](M12_2_5_LINUX_DUAL_RUNTIME_CLOSURE.md) — Linux & dual-runtime 收口（PAPERTEAM_HOST/图表 CJK/docling 镜像/doctor 三档/CI 持久化与 Linux 集成验收；公司-个人 credentials 隔离契约）
- [M12_BATCH3_FIGURE_GENERATION_CLOSURE.md](M12_BATCH3_FIGURE_GENERATION_CLOSURE.md) — Batch 3 图表生成产品收口（C4 API/UI + C5 手稿受控插入 + C6 真实性守卫 + doctor 部署形态；新加坡 ECS 真实验收）
- [M12_FINAL_CLOSURE.md](M12_FINAL_CLOSURE.md) — M12 最终收口（状态口径统一 / README 双语 / 三个 Demo 方案 / 技术亮点 / CI 证据链 / 已知限制与 PENDING 项如实登记）

## M13 — Storage & Architecture Evolution

- [M13_0_STORAGE_ARCHITECTURE_ASSESSMENT.md](M13_0_STORAGE_ARCHITECTURE_ASSESSMENT.md) — 存储架构只读评估（全库 store 审计 / 读写并发模型 / 事务边界分类 / events.jsonl flake 归因 / 三方案决策矩阵；DATABASE_DECISION = NO-GO — Keep File-backed，SQLite 为触发后唯一候选）
- [M13_1_CODEX_HANDOFF.md](M13_1_CODEX_HANDOFF.md) — 文件后端可靠性 Batch 1/2（EvidenceStore 前向兼容、Figure 插入 write-ahead intent / SHA-256 恢复、SIGKILL 子进程测试）
- [M13_STABILITY_HARDENING_BATCH3.md](M13_STABILITY_HARDENING_BATCH3.md) — Stability Batch 3（RevisionStore 损坏 fail-closed、restore intent、ExternalInstructionStore 并发；DATABASE_DECISION = NO_GO 维持）
- [M13_2_EXPERIMENT_PACKAGE_DESIGN.md](M13_2_EXPERIMENT_PACKAGE_DESIGN.md) / [M13_2_EXPERIMENT_PACKAGE_ACCEPTANCE.md](M13_2_EXPERIMENT_PACKAGE_ACCEPTANCE.md) / [M13_2_CODEX_HANDOFF.md](M13_2_CODEX_HANDOFF.md) — 实验包理解（有界 ZIP 导入、保守分组、作者确认、research.idea 上下文；ECS 合成验收 PASS）
- [M13_3_REAL_EXPERIMENT_ACCEPTANCE.md](M13_3_REAL_EXPERIMENT_ACCEPTANCE.md) — 作者真实实验包验收 + GLM 受控语义理解（PASS 带限制）
- [M13_4_MODEL_PROVIDER_UX_ACCEPTANCE.md](M13_4_MODEL_PROVIDER_UX_ACCEPTANCE.md) — 自定义 Provider 向导与模型发现（公司网关 43 模型真实验证）
- [M13_5_REAL_WORKFLOW_READINESS.md](M13_5_REAL_WORKFLOW_READINESS.md) / [M13_5_1_EXPERIMENT_UPLOAD_RELIABILITY.md](M13_5_1_EXPERIMENT_UPLOAD_RELIABILITY.md) / [M13_5_2_OUTPUT_TRUNCATION_HANDLING.md](M13_5_2_OUTPUT_TRUNCATION_HANDLING.md) — 真实工作流就绪（thinking omit、split scopes、上传可靠性、输出截断）
- [M13_6_EXPERIMENT_ONBOARDING_AND_429_RECOVERY.md](M13_6_EXPERIMENT_ONBOARDING_AND_429_RECOVERY.md) — 实验接入与学术 API 限流恢复（ScholarlyHttpClient / ProviderCooldownRegistry）
- [M13_FINAL_CLOSURE.md](M13_FINAL_CLOSURE.md) — **M13 最终收口（PARTIAL — BLOCKERS REMAIN）**：否定性命题 grounding 立场 / Reviewer 意见非证据 + 具名实体守卫 / Planner partial 标注 / 多 key 归因信号 / academicScore 带内复核；真实 Topic → PDF 全链路（Draft 终态；暴露并修复摘要转义、状态词泄漏、未知 cite key 三个生产缺陷）；阻断 = abstract-only 语料无正式 Evidence + 登记工件未在真实起点产出；M14 Handoff。

## M13.7 — Research → RAG → Evidence

- [M13_7_RESEARCH_RAG_EVIDENCE_ACCEPTANCE.md](M13_7_RESEARCH_RAG_EVIDENCE_ACCEPTANCE.md) — 工程闭环、受控回归、新加坡隔离验收、真实证据与Writer消费、Token和限制。
- [M13_7_2_CITATION_WRITING_QUALITY.md](M13_7_2_CITATION_WRITING_QUALITY.md) — 引用用途、partial 证据边界、中文正文质量、固定回归与有界真实模型对照。
- [M13_7_3_CROSS_SECTION_WRITING_QUALITY.md](M13_7_3_CROSS_SECTION_WRITING_QUALITY.md) — 连续五章真实 A/B、独立冻结主题、失败候选与成本证据；质量验收 PARTIAL，候选未合入。
- [M13_7_4_CHAPTER_RESPONSIBILITY_PLANNING.md](M13_7_4_CHAPTER_RESPONSIBILITY_PLANNING.md) — 轻量章节职责契约候选、两个新主题与 held-out 重复 A/B、真实规划失败和成本；PARTIAL，候选未合入。
- [M13_7_5_REVISION_FIDELITY_TARGETED_REPAIR.md](M13_7_5_REVISION_FIDELITY_TARGETED_REPAIR.md) — 公式来源授权、句级 Scope、定向 Patch Repair 与生产接线审计；确定性修复及真实模型失败证据，PARTIAL。
- [M13_7_6_REVISION_LIVE_CLOSURE.md](M13_7_6_REVISION_LIVE_CLOSURE.md) — 最终修复后的真实 Planner/Writer/Patch 复验、局部引文字段及 Patch Evidence 接线收口；D 与完整 Review/Gate 未完成，PARTIAL。
- [M13_7_7_CROSS_SECTION_ROOT_CAUSE_AND_REDESIGN.md](M13_7_7_CROSS_SECTION_ROOT_CAUSE_AND_REDESIGN.md) — 两轮跨章节失败的源码级根因（相同证据 × 固定长度 × 仅引文事实）、同 Harness 下 GLM-5.3 / Fable 对照、论证单元输入组织最小原型与定向压缩原型的真实 A/B、确定性复述探测器；PARTIAL，生产写作路径未改。
- [M13_7_8_ARGUMENT_UNIT_HELDOUT_VALIDATION.md](M13_7_8_ARGUMENT_UNIT_HELDOUT_VALIDATION.md) — 论证单元方案的 held-out 验证（新主题 SimCLR/MoCo/BYOL/SimSiam，A/B/C/D 四臂 20 任务）：完整方案未过 −30% 复述门（路标模板句 + 比较节逐字回引），但唯一保全全部必要事实且费用 −25%；仅分证据转为免责重复、仅改长度删光数值；探测器 `\%` 缺陷修复；PARTIAL，不进生产。
- [M13_7_9_ACADEMIC_REDUNDANCY_AND_ARGUMENT_UNIT_REFINEMENT.md](M13_7_9_ACADEMIC_REDUNDANCY_AND_ARGUMENT_UNIT_REFINEMENT.md) — 有害学术重复评价层（M/L/P/S/X/E/F/uncertain，指标 A 词面 + 指标 B 有害并列，开发集六臂与人工分类一致）、B2 任务块最小修订（去路标措辞、行为约束、综合式比较）、两个全新 held-out（LLM 偏好对齐 / 超导量子纠错）A vs B2 + H3-only 共 30 任务：有害重复 14.3%→1.6%、9.8%→0.0%，必保事实全保，路标与逐字回述归零，费用 −18.5%/−22.9%；任务块单独不去重；**PASS — Ready for Production Integration**（仅集成设计，生产 Workflow 未改）。
- [M13_7_10_ARGUMENT_UNIT_PRODUCTION_INTEGRATION.md](M13_7_10_ARGUMENT_UNIT_PRODUCTION_INTEGRATION.md) — B2 论证单元写作的生产集成：Outline 可选 `argument` 字段 + 确定性角色 / 任务 / 负向范围派生、普通论文逐节正式 Evidence 分配（覆盖兜底 / partial 只进 compare / pinned 只认 canonical ID）、Survey 契约零改动只加任务块、writing-plan / academic-redundancy 只读产物、style 模式只读 digest；两次真实 GLM-5.3 Planner + `writing.sections`：角色全部合法、17 项必保事实全保、负对照显式拒绝、引用零越界、XeLaTeX 编译通过，有害重复 9.8%→7.0%/8.6%（不等价 Baseline）；framing 平台幻觉修复、多 conclude 结构残余；默认启用（可关），**PARTIAL**。
- [M13_7_11_PRODUCTION_WRITING_E2E_QUALITY_CLOSURE.md](M13_7_11_PRODUCTION_WRITING_E2E_QUALITY_CLOSURE.md) — B2 生产写作的收口验收：冻结真实 Planner 大纲的同条件生产 A/B（开关在 ServiceStack 构造期、独立进程）：A 本身有害重复 0.0%（低于区分度下限）、B 4.1%，词面 27.5%→16.9%，17 项必保事实双臂全保、B 无 A 的引文外编码红旗；双 conclude 规则 LIVE PASS（单样本）；生产 Orchestrator 上 Outline → PDF Stage Replay 三次 run（gate PASS → final rev1；真实 revision.revise 修复 major 定义颠倒 → rev2 draft IMPROVED；style polish 被 invariant 守卫全量拒绝）；两种真实 Resume + 新增重试测试；真实 idea_to_paper Planner 6/6 角色、28/28 canonical evidenceIds、feasibility LOW 停在实验边界；2 个修复（framing/conclude 拒收 pinned partial、digest 使用口径禁路标与限制删除）+ 4 个记录（partial 否定句被确定性 grounding 误判、style JSON 解析折叠、Reviewer 记忆经修订泄漏、Reviewer 方差）；38/40 任务；Topic → PDF 预算阻塞未执行；**PARTIAL**（B2 维持默认开启，M13.7 未收口）。
- [RESEARCH_EVIDENCE_SUPPLY.md](RESEARCH_EVIDENCE_SUPPLY.md) — 有界供给实现与边界。

## Pre-M14 — 夜间技术预研（2026-10-13/14，只读；未改产品代码）

- [PRE_M14_OVERNIGHT_RESEARCH_SUMMARY.md](PRE_M14_OVERNIGHT_RESEARCH_SUMMARY.md) — **总汇总（十四问）**：academic-figure-skill 不作 Skill/Renderer 引入、部分借鉴；Contract + Renderer 注册表但 M14 仅保留 TikZ/pgfplots；`thesis_from_papers` 工作流与 10 个数据模型；generic-ctexbook + 学校适配器；2 P0 / 7 P1 工程阻塞；M14.1–M14.3 建议
- [PRE_M14_ACADEMIC_FIGURE_SKILL_EVALUATION.md](PRE_M14_ACADEMIC_FIGURE_SKILL_EVALUATION.md) — academic-figure-skill 独立评估与 A/B/C 基准（22 会话 + 1 无效试点、75.21 USD；Skill 臂 7.8× 成本 / 5 触顶 / 1 零交付 / 0 native run；臂 C 4/8 可表达与落后项清单）；脚本副本见 [repros/pre-m14-academic-figure-skill/](repros/pre-m14-academic-figure-skill/README.md)
- [PRE_M14_FIGURE_RENDERING_ARCHITECTURE.md](PRE_M14_FIGURE_RENDERING_ARCHITECTURE.md) — 图表生成技术路线（FigureCompiler 不变量坐标、Skill 解剖、6 路线 × 7 维度对比、matplotlib/pgfplots 中文探针、最小 Figure Contract 接口草案、exit-0 Missing character 静默缺口）
- [M14_0_THESIS_WORKFLOW_ARCHITECTURE.md](M14_0_THESIS_WORKFLOW_ARCHITECTURE.md) — M14 学位论文 Workflow 架构只读审计（12 模块坐标、复用/新增/阻碍三分表、10 个数据模型草案、stage 状态机与 `hitl.author_decision` 触发条件、11 项风险）
- [M14_0_THESIS_TEMPLATE_RESEARCH.md](M14_0_THESIS_TEMPLATE_RESEARCH.md) — 中文学位论文 LaTeX 模板调研（10 模板 `gh api` 实读 × 12 维度、本机 MiKTeX 7/10 类在位、ctexbook+biblatex 与 thuthesis 两个编译探针、ThesisDocumentModel + TemplateAdapter 草案、`UNDEFINED_CITATION_PATTERN` biblatex 漏判与 133 s 冷启动）
- [M14_0_ENGINEERING_READINESS_AUDIT.md](M14_0_ENGINEERING_READINESS_AUDIT.md) — 面向 M14 的工程瓶颈审计（十问逐项带坐标；P0-1 修订 12k 截断 + 整文件覆写、P0-2 Review digest 覆盖上限；7 P1 / 5 P2 / 3 P3；17 项可复用能力；文件后端不触发 SQLite 复评）

## M14.0.1 — Real Thesis–Paper Relationship Study（2026-10-14，只读研究；未改产品代码、未安装 Skill）

- [M14_0_1_REAL_THESIS_PAPER_CORPUS.md](M14_0_1_REAL_THESIS_PAPER_CORPUS.md) — 研究协议与真实语料：32 条候选记录（30 篇开放全文：作者自存档 12 + arXiv 12 + 香港理工 6；内地机构库 0 篇开放全文的探测证据）、15 组核验、**9 组内地正式配对（博士 6 / 硕士 3）+ 1 组港校控制**、6 组反例/受限候选、身份验证证据统计、选择偏差；**PARTIAL**（中国学生硕士正式样本 2 组 < 目标 4）
- [M14_0_1_THESIS_PAPER_MAPPING_ANALYSIS.md](M14_0_1_THESIS_PAPER_MAPPING_ANALYSIS.md) — 逐案例 Evidence Matrix 与跨案例归纳：核心章 ≈ 小论文的翻译/逐字再现（表格逐位相同）、成果归属只在附录全局声明、6/10 依赖未发表材料、7/10 存在同实验异值或版本冲突（范登平表 4.3、李谨杰表 9、宋品皓基线、白烨 λ 约定等）、选择性删减、公开副本答辩后修订、一篇拆两章/多篇并一章；与 M14.0 假设不一致的 7 条证据
- [M14_0_1_EVIDENCE_BASED_WORKFLOW_DECISIONS.md](M14_0_1_EVIDENCE_BASED_WORKFLOW_DECISIONS.md) — 11 条架构假设审查、10 个数据模型裁决（SUPPORTED 3 / ADJUST 6 / INSUFFICIENT 1；`SourcePaper` → `ResearchInput`、FrozenFact 三态 + conflict、表格级继承资产）、修订版 `thesis_from_papers` 工作流（新增 `hitl.scope_and_version` / `hitl.fact_conflicts`）、自动化/HITL 边界、P0-1/P0-2 需求细化（含 Review 全文覆盖证明）、M14.1–M14.3 顺序修正、预算账本
- [M14_0_1_THESIS_SKILL_FEASIBILITY.md](M14_0_1_THESIS_SKILL_FEASIBILITY.md) — Skill 裁决 **SELECTIVE**：`thesis-chapter-expansion-zh`（Writer/Planner 组织与写作方法）规范草案；身份/版本/事实状态/冲突/归属/HITL 全部归确定性系统；小样本 A/B 协议与预算帽；本轮不安装、不接入、不做 A/B

## Runtime / 架构审计

- [AGENT_ARCHITECTURE_AUDIT.md](AGENT_ARCHITECTURE_AUDIT.md) — Agent 架构审计
- [PI_1_0_1_UPGRADE_AND_SOAK_REPORT.md](PI_1_0_1_UPGRADE_AND_SOAK_REPORT.md) — Pi SDK 1.0.1 升级与 soak
- [PI_UPSTREAM_REAL_WORKLOAD_AUDIT_2026-10-03.md](PI_UPSTREAM_REAL_WORKLOAD_AUDIT_2026-10-03.md) — 真实负载下 Pi 上游审计
- [PI_UPSTREAM_DEEP_AUDIT_2026_10.md](PI_UPSTREAM_DEEP_AUDIT_2026_10.md) — Pi SDK 上游深度审计（1.0.1 / 1.1.0 / main 三版 × Windows / Linux 双平台故障注入；C1 `repairJson` 无效 `\u` 转义修复 UPSTREAM_FIX_READY，C2 工具期 abort 终态已知未合并 PR #8635 新证据，C3 SDK 路径 `httpIdleTimeoutMs` 仅覆盖 header 的文档缺口；复现脚本见 [repros/pi-upstream-audit-2026-10/](repros/pi-upstream-audit-2026-10/README.md)）
