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

## [Unreleased] — M5（进行中）

### M5.3 Controlled Academic Skill Integration（2026-09-14）

- 新增三个审计 Skill（MIT，固定上游 commit）：`academic-writing-zh`、
  `academic-review`（K-Dense-AI/scientific-agent-skills @ `0b2afe6`）、
  `academic-style-zh`（op7418/Humanizer-zh @ `91f3d39`），均为 PaperTeam 学术
  适配版（不建立第二套事实系统、不是 AI detector、Reviewer 保持只读）。
- Skill Store 受控化：完整 SHA / LICENSE / PROVENANCE 校验、不可变版本快照、
  篡改检测与自愈、update 预览 / 应用、approved catalog 安装；无任意 URL 安装。
- role + contextScope 路由：fact / academic / style Reviewer 得到不同 Skill 集，
  Writer 普通写作 vs style-polish 不同；旧 role-only 调用兼容。
- 会话级 Skill 版本固定（更新只影响新会话 / 新 generation）；任务终态携带
  `skills.assigned` 与真实观测的 `skills.accessed`（无事件时如实 unknown）。
- Skills 设置页：用途 / 来源 / 固定 revision / hash / 绑定 / 更新状态；
  安装 / 预览更新 / 应用更新 / 查看 provenance。
- 配置：`PAPERTEAM_DISABLED_SKILLS`。

### M5.4 Chinese Academic Style Revision Loop（2026-09-14）

- run 选项 `stylePolicy`：`suggest_only`（默认，style minor 只是建议）/
  `apply_once`（Gate 通过后 HITL 勾选 style 建议 → style-only 修订，最多一轮）。
- Style Invariant Checker：citation key / 数字单位 / 公式 / LaTeX 结构 / 受保护
  术语 / 否定·比较·强度哨兵；失败不覆盖当前修订、不自动重试。
- Style Reviewer finding 含 reason / proposedAction；AI 概率类字段一律丢弃。
- Quick Review 保持 100% 只读：携带 stylePolicy → 400。
- UI：Improvement 启动的「语言风格建议」选项、HITL 勾选面板、「语言润色」状态卡。
- M5 eval corpus（A–E 自建样本）+ `styleSignals` 确定性扫描 + 人工评价模板。

### M5.5 Linux / Docker Deployment（2026-09-14，IMPLEMENTED / AWAITING REAL DOCKER ACCEPTANCE）

- `Dockerfile`（多阶段：frontend-build / backend-build / `backend` / `web`）、
  `compose.yml`（web 唯一对外端口、backend 内部、双 named volume、stop_grace_period）、
  `docker/nginx.conf`（同源反代，SSE 不缓冲）、`docker/backend-entrypoint.sh`
  （volume 属主修正 + setpriv 降权）、`.dockerignore`。
- `GET /ready` readiness（Runtime + 数据根可写 + TeX / Python 状态，degraded 如实）；
  `/health` 保持 liveness。
- 优雅停机：`PAPERTEAM_SHUTDOWN_TIMEOUT_MS`（默认 30s）替代固定 5s 硬退出；
  先停止受理，再取消 / 收敛 / 释放会话。
- CI：`.github/workflows/ci.yml`（ubuntu build / typecheck / test + docker build smoke）。
- 真实 `docker compose` 验收待在 Docker 主机执行（开发机无 Docker / WSL）。

### M5.6 Real Paper Acceptance（2026-09-14，PARTIAL）

- 真实 26 页中文工科论文 A/B（glm-5.3）：两臂均 Draft PASS / Final blocked（Gate
  如实 FAIL）；Quick Review 零写入；材料不足提案不编造；详见 docs/M5_ACCEPTANCE.md。
- 修复：Writer 修订不再删光 Existing-Paper 重建稿的引用（可引用 key 以
  references.bib 为事实源 + prompt 保留引用）；Style Polish 在 Draft 路径也提供一次；
  `runtimeStats.usageTotals` + per-task usage 日志（含 assigned / accessed skills）；
  compose 默认执行超时 900s；`scripts/m5-acceptance.mjs` 验收执行器。
- 未完成：人工评价、Docker E2E；M5 不标 COMPLETE，不打 tag。

### 其余 M5 阶段

- M5.1 / M5.2 Runtime 生命周期与长程治理（见 docs/PROJECT_STATUS.md）。
