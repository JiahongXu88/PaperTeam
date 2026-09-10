# Changelog

All notable changes to PaperTeam are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0-mvp] — 2026-09-10 — M4 MVP（Alpha）

首个公开里程碑：M1–M4 全部完成，三条产品路径闭环。详见
[docs/RELEASE_NOTES_M4.md](docs/RELEASE_NOTES_M4.md)。

### 三条产品路径

- **Idea-to-Paper**：调研 → 可行性（HITL）→ 大纲（HITL）→ 分节写作 → 引用核验 →
  三路审稿 → 修订闭环 → 质量门禁 → LaTeX 编译 → Draft / Final。
- **Existing Paper — Quick Review**：PDF 导入 → PaperMap → 引用真实性 + 语义核验 →
  分章节审阅 → 聚合报告（Markdown 导出）；全程只读。
- **Existing Paper — Improvement**：PDF 导入 → 确定性重建可修订稿件 → 审稿基线 →
  改进计划（HITL）→ Writer 逐节修订 → 质量门禁 → Draft / Final（M4.8 起浏览器全链路可达）。

### Runtime 与编排

- Pi SDK in-process 为唯一 Agent Runtime（`@earendil-works/pi-coding-agent` 0.84.4，
  精确 pin）；`AgentRuntime` 契约 v2（startAgent → 句柄：事件流 / 取消 / result）。
- 确定性 TypeScript WorkflowOrchestrator：Stage DoD、checkpoint / 断点恢复、
  HITL、协作式取消、bounded loop、SSE Domain Event。
- 会话维度 `projectId × agentId × contextScope`；Reviewer 三路审稿独立会话并行。

### 引用完整性

- Layer 1 真实性核验：Crossref / OpenAlex / Semantic Scholar / arXiv；失败语义
  严格（网络故障 ≠ not_found ≠ 捏造）。
- Layer 2 语义核验：原子论断 × 引用组（v5）、judge 禁止凭记忆判定、伪造引文
  剥离、确定性 severity；按 run 配置（off / contradiction_only / full，缺省 off）。

### 审阅与修订

- Reviewer 三 skill（fact / academic / style）并行 + 确定性聚合。
- 分章节审阅有界并发（`PAPERTEAM_REVIEW_CONCURRENCY`，真实 benchmark 2.61× 总提速）
  + per-section journal 崩溃恢复。
- 确定性 Revision Plan → Writer 逐节修订 → 强制复审 → 收敛判定
  （PASS / IMPROVED / CONVERGED / REGRESSION，零 LLM）。
- Quality Gate：13+ 条确定性规则、轮次隔离、修订后过期如实提示、可解释阻止项。

### 产物与版本（M4.7 / M4.8）

- Build Gate 与 Quality Gate 分离（Draft 只要求可构建，D-0015）。
- Draft / Final 不可变产物（manifest 只增不改；下载只经 manifest 解析防路径穿越）。
- LaTeX 编译失败自动修复 ≤2 次（最小上下文：受影响文件 + 结构化诊断）。
- **版本体验（M4.8）**：不可变修订链上的版本历史（ManuscriptVersionDTO）、
  两修订确定性比较（章节级差异 + 记分对照，零 LLM）、恢复历史版本
  （= 创建新修订，历史与旧 Final 永不删除；旧 Gate 自然 stale）。
- 摘要（abstract）为一等修订目标（载体 outline.abstract；禁止路由到组装根 main.tex）。

### 工作台（React 19）

- 项目列表 / 创建（双模式 + PDF File-First 导入）/ 项目生命周期（归档 / 恢复 /
  永久删除）。
- 工作流实时视图（Stage Timeline / SSE / 取消 / 分章节进度）、HITL 决策面板、
  Evidence 工作台、质量门禁面板、论文产出（Draft / Final / 构建 / 迭代 / 版本历史）。
- 浅色 / 深色 / 跟随系统主题；模型设置（Provider / 模型搜索 / 自定义网关 /
  Test Connection，Key 不回显）。

### 已知限制

Visual Reviewer、Skill install/update、Docker 部署、系统管理后台未实现
（M5+）；后端进程崩溃时进行中的模型调用经 checkpoint 重试而非迁移；
Windows 下 LaTeX 编译超时只终止 shell 进程；单机单用户形态。
完整清单见 [README](README.md#known-limitations真实清单)。

## [Unreleased]

- M5+（可选方向）：Visual Reviewer、Skill Management、Deployment、System Admin。
