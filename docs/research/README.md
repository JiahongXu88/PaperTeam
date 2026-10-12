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

## M13.7 — Research → RAG → Evidence

- [M13_7_RESEARCH_RAG_EVIDENCE_ACCEPTANCE.md](M13_7_RESEARCH_RAG_EVIDENCE_ACCEPTANCE.md) — 工程闭环、受控回归、新加坡隔离验收、真实证据与Writer消费、Token和限制。
- [M13_7_2_CITATION_WRITING_QUALITY.md](M13_7_2_CITATION_WRITING_QUALITY.md) — 引用用途、partial 证据边界、中文正文质量、固定回归与有界真实模型对照。
- [M13_7_3_CROSS_SECTION_WRITING_QUALITY.md](M13_7_3_CROSS_SECTION_WRITING_QUALITY.md) — 连续五章真实 A/B、独立冻结主题、失败候选与成本证据；质量验收 PARTIAL，候选未合入。
- [M13_7_4_CHAPTER_RESPONSIBILITY_PLANNING.md](M13_7_4_CHAPTER_RESPONSIBILITY_PLANNING.md) — 轻量章节职责契约候选、两个新主题与 held-out 重复 A/B、真实规划失败和成本；PARTIAL，候选未合入。
- [M13_7_5_REVISION_FIDELITY_TARGETED_REPAIR.md](M13_7_5_REVISION_FIDELITY_TARGETED_REPAIR.md) — 公式来源授权、句级 Scope、定向 Patch Repair 与生产接线审计；确定性修复及真实模型失败证据，PARTIAL。
- [M13_7_6_REVISION_LIVE_CLOSURE.md](M13_7_6_REVISION_LIVE_CLOSURE.md) — 最终修复后的真实 Planner/Writer/Patch 复验、局部引文字段及 Patch Evidence 接线收口；D 与完整 Review/Gate 未完成，PARTIAL。
- [M13_7_7_CROSS_SECTION_ROOT_CAUSE_AND_REDESIGN.md](M13_7_7_CROSS_SECTION_ROOT_CAUSE_AND_REDESIGN.md) — 两轮跨章节失败的源码级根因（相同证据 × 固定长度 × 仅引文事实）、同 Harness 下 GLM-5.3 / Fable 对照、论证单元输入组织最小原型与定向压缩原型的真实 A/B、确定性复述探测器；PARTIAL，生产写作路径未改。
- [M13_7_8_ARGUMENT_UNIT_HELDOUT_VALIDATION.md](M13_7_8_ARGUMENT_UNIT_HELDOUT_VALIDATION.md) — 论证单元方案的 held-out 验证（新主题 SimCLR/MoCo/BYOL/SimSiam，A/B/C/D 四臂 20 任务）：完整方案未过 −30% 复述门（路标模板句 + 比较节逐字回引），但唯一保全全部必要事实且费用 −25%；仅分证据转为免责重复、仅改长度删光数值；探测器 `\%` 缺陷修复；PARTIAL，不进生产。
- [RESEARCH_EVIDENCE_SUPPLY.md](RESEARCH_EVIDENCE_SUPPLY.md) — 有界供给实现与边界。

## Runtime / 架构审计

- [AGENT_ARCHITECTURE_AUDIT.md](AGENT_ARCHITECTURE_AUDIT.md) — Agent 架构审计
- [PI_1_0_1_UPGRADE_AND_SOAK_REPORT.md](PI_1_0_1_UPGRADE_AND_SOAK_REPORT.md) — Pi SDK 1.0.1 升级与 soak
- [PI_UPSTREAM_REAL_WORKLOAD_AUDIT_2026-10-03.md](PI_UPSTREAM_REAL_WORKLOAD_AUDIT_2026-10-03.md) — 真实负载下 Pi 上游审计
