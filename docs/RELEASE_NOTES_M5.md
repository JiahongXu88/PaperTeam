# PaperTeam M5 Release Notes（进行中 / PARTIAL）

**Status**: M5 PARTIAL · **Date**: 2026-09-14 · **Baseline**: `v0.1.0-mvp`（M4）之后的 main

M5 主题是「中文论文质量与长程运行加固」。本轮交付 M5.1–M5.4 完整能力与 M5.5 部署实现，
并用真实中文工科论文 + 真实模型完成了 M5.6 的首轮 A/B 与红线验收
（详见 [docs/M5_ACCEPTANCE.md](M5_ACCEPTANCE.md)）。**未发布 tag**：M5.5 真实 Docker
验收与 M5.6 人工评价尚未完成，按纪律不宣布 M5 COMPLETE。

## Highlights

### M5.1 / M5.2 Runtime 长程治理（✅）
AbortSignal 统一、事件 seq + event_gap、queued cancel、timeout 分层、结构化终态、
原生 usage；全局并发 / 有界受理 / context budget / session rotation / TTL·GC / 容量 /
观测面 / 安全自愈；160-run soak。

### M5.3 Controlled Academic Skill Integration（✅）
- 三个审计 Skill（MIT，固定上游 commit）：`academic-writing-zh`、`academic-review`
  （K-Dense-AI/scientific-agent-skills @ `0b2afe68…`）、`academic-style-zh`
  （op7418/Humanizer-zh @ `91f3d394…`），PaperTeam 学术适配（不建立第二套事实系统、
  不是 AI detector、Reviewer 只读、不自动向用户论文插入上游引用）。
- 受控 Skill Store：完整 SHA / LICENSE / PROVENANCE 校验、不可变版本快照、篡改自愈、
  更新预览 / 应用、approved catalog；无任意 URL 安装。
- role + contextScope 路由（三个 Reviewer lens 不同 Skill 集）；会话级版本固定；
  任务终态 `skills.assigned` 与真实观测的 `skills.accessed`（无事件 → unknown）。
- Skills 设置页。

### M5.4 Chinese Academic Style Revision Loop（✅）
- `stylePolicy`：`suggest_only`（默认，minor 只是建议）/ `apply_once`（HITL 勾选 →
  style-only 修订 → 确定性 invariant 守卫 → 新修订 → 强制复审；最多一轮；Draft 路径也提供一次）。
- Style Invariant Checker：citation key / 数字单位 / 公式 / LaTeX 结构 / 受保护术语 /
  否定·比较·结论强度哨兵（保守哨兵，非语义证明）。
- Style Reviewer finding：location / issue / reason / proposedAction / severity；AI 概率字段一律丢弃。
- Quick Review 100% 只读（携带 stylePolicy → 400）。
- M5 eval corpus + deterministic hard checks + 人工评价模板。

### M5.5 Linux / Docker Deployment（✅ 真实 Docker 验收通过，2026-09-15）
Dockerfile（多阶段 backend / web；受限网络 `APT_MIRROR` / `PIP_INDEX_URL` build-arg）、
compose（双 volume、backend 内部、web 唯一端口、长论文超时 env）、nginx 同源反代、
`/ready` readiness、可配置优雅停机、CI（ubuntu + docker build smoke）。在 WSL2 +
Docker Engine 主机上完成 build / up / health / Web+API / 持久化（restart、down/up）/
容器内 XeLaTeX 中文 PDF / 容器内 PyMuPDF 解析 / SIGTERM 优雅停机 的真实验收
（docs/M5_ACCEPTANCE.md §4.7）。

### M5.6 验收驱动修复（2026-09-15）
- **Citation Preservation Gate**（`quality/citationPreservation.ts`）：修订前后实际被引用的
  key 按 key 语义比较，无计划依据的丢失 → `citation_keys_preserved` FAIL（全部删光 hard fail、
  历史回归 FAIL）；`revision.plan` 派发 `citation_removed` 恢复条目；Draft 路径明确暴露；
  Quick Review 不受影响。Prompt 不是 Gate。
- **长论文执行超时分层**：新增 `PAPERTEAM_PI_LONG_RUN_TIMEOUT_MS`（默认 900 s）只覆盖
  Writer / 三路 Reviewer / 分章节 Reviewer / Researcher；通用 300 s 默认与 Runtime 契约不变。
- **CI 平台无关性**：上传文件名反斜杠归一化、配置测试的绝对路径按平台取——GitHub Actions
  ubuntu 首次绿。

### M5.6 Real Paper Acceptance（多轮真实执行，记录于 M5_ACCEPTANCE）
- 真实 26 页中文工科论文 A/B（glm-5.3，两臂同模型同阈值）：首轮两臂均 Draft PASS / Final
  blocked（Gate 如实 FAIL，阈值未动）；Quick Review 零写入；材料不足提案不编造；
  长程 runtime 有界可观测。
- 验收驱动修复：Writer 曾删光重建稿全部引用（引用 key 事实源改为 references.bib）、
  默认 300s 执行超时对长论文过短（部署默认 900s）、Style Polish 在 Draft 路径也提供。
- **Citation Preservation Gate**（`citation_keys_preserved`）：修订前后实际引用 key 的确定性
  比较，无计划依据的丢失 → FAIL；修复后 A/B（A8/B6）两臂引用丢失 0。
- **Fact Preservation Gate**（`fact_preservation`，pair-02 独立模型盲评驱动）：表格数值 /
  正文数字 / 公式 / 方向性结论（负结果→优势为 hard rule）/ 数据集划分 / 硬件 / 占位回归 /
  无依据新增的确定性保护；授权只认结构化计划 + Evidence；**被篡改的稿件拒绝冻结 Draft**
  （`FACT_PRESERVATION_FAILED`）。真实模型最终 A/B 两臂的 fact mutation 均被 FAIL 拦截，
  恢复轮由 `fact_preserve` 计划条目驱动（Writer 恢复不彻底时系统如实拒绝产出）。
- Writer 修订契约与三个学术 Skill（academic-writing-zh / academic-review / academic-style-zh）
  收紧：修订 ≠ 重写、既有实验事实默认冻结、疑似错误保留原值、负结果不得美化、稿件与 Evidence
  冲突时报告不调和。**未新增第四个 Skill。**
- Skill 质量增益：**未证明稳定提升，也未出现「开启臂更差」的证据**——两轮独立盲评（pair-02/03）
  都判 Skill 开启臂的修订危害更小（2/2），但两臂在两轮中都存在事实违规（本轮全部被 Gate 拦截）；
  三路 Reviewer 的 academic 分数两轮互为翻转（不可用作结论）。Skill 开启臂稳定更慢更贵
  （$3.99 vs $1.69、86 vs 47 min）。如实记录：受控接入 / 观测 / 事实安全等工程目标达成，
  质量收益为「方向性偏好、样本量不足以宣称」。
- pairwise 评价口径：**Independent Model Pairwise Evaluation**（独立外部模型盲评；
  human review optional，调整原因见 M5_ACCEPTANCE §5）。

## Compatibility
- AgentRuntime 契约 v2 只新增可选字段（`AgentTask.skills`、`RuntimeSessionStats.usageTotals`、
  `SessionDiagnosticEntry.assignedSkills/contextScope`）。
- 新配置：`PAPERTEAM_DISABLED_SKILLS`、`PAPERTEAM_SHUTDOWN_TIMEOUT_MS`；run 选项 `stylePolicy`。
- 新路由：`/api/skills/*`（provenance / update-preview / install / update）、
  `/api/projects/:id/style-polish`、`/ready`。

## 建议 tag
现有体系：`v0.1.0-mvp`（M4）。M5 完整收口后建议 `v0.2.0`（次版本：新增 Skill / Style Loop /
部署能力，无破坏性变更）。**本轮不打 tag**。
