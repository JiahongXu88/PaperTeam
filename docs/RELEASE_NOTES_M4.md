# PaperTeam M4 MVP Release Notes

**Version**: `v0.1.0-mvp` · **Date**: 2026-09-10 · **Status**: MVP / Alpha

PaperTeam 是一个 AI-native 多 Agent 学术研究与论文工作台：从研究 Idea 到
LaTeX / PDF 论文交付，以及已有论文的快速审阅与系统性改进。本版本为 M4
里程碑收口——三条产品路径全部闭环，达到可作为完整产品演示与使用的最小形态。

## Highlights

### 三条产品路径（全部真实链路）

1. **Idea-to-Paper** — 调研 → 可行性（HITL）→ 大纲（HITL）→ 分节写作 →
   引用核验 → 三路审稿 → 审稿-修订闭环 → 质量门禁 → 真实 LaTeX 编译 →
   Draft / Final 双产物。
2. **Existing Paper — Quick Review** — PDF 导入 → 引用真实性（外部学术库）+
   论断-引用语义核验 → 分章节审阅 → 聚合报告 + Markdown 导出。**全程只读**
   （零产物 / 零修订 / 无论文产出 tab）。
3. **Existing Paper — Improvement** — PDF 确定性重建为可修订稿件 → 审稿基线 →
   改进计划（HITL 确认）→ Writer 逐节修订 → 质量门禁 → Draft / Final。
   本版本起浏览器全链路可达（此前仅 API 级 LaTeX 导入）。

### Runtime 与编排

- Pi SDK in-process 唯一 Agent Runtime（0.84.4 精确 pin）+ `AgentRuntime`
  契约 v2（事件流 / 取消 / result）。
- 确定性 TypeScript WorkflowOrchestrator：流程控制不交给 LLM；Stage DoD
  校验、checkpoint 断点恢复、HITL、协作式取消、SSE 实时进度。
- 会话维度 `projectId × agentId × contextScope`，Reviewer 三路并行互不污染。

### 引用完整性（Citation Integrity）

- 真实性核验：Crossref / OpenAlex / Semantic Scholar / arXiv；严格失败语义
  （网络故障 ≠ 未收录 ≠ 疑似捏造）。
- 语义核验：原子论断 × 引用组（v5 算法）；judge 禁止凭记忆判定、伪造引文
  剥离；INSUFFICIENT ≠ 论文问题；按 run 配置（off / contradiction_only / full）。

### 审稿与修订闭环

- 确定性聚合 + Quality Gate（13+ 规则，轮次隔离，可解释阻止项）。
- 确定性 Revision Plan → Writer 逐节修订 → 强制复审 → 收敛判定
  （PASS / IMPROVED / CONVERGED / REGRESSION，零 LLM）；不收敛 / 超限交 HITL。
- 分章节审阅有界并发（真实 benchmark：总时长 2.61×）。
- LaTeX 编译失败自动修复 ≤2 次（最小上下文：受影响文件 + 结构化诊断）。

### Draft / Final 与版本体验

- Build Gate 与 Quality Gate 分离：Draft 只要求可构建；Final 双 Gate 通过且
  对齐当前修订；产物不可变（manifest 只增不改，下载防路径穿越）。
- **版本历史**：论文修订的完整时间线（修订号 / 来源 / 审稿轮次 / 门禁结论 /
  产物 / 迭代 outcome）——版本事实由后端 `ManuscriptVersionDTO` 权威组装。
- **版本比较**：任意两修订的确定性差异（章节级 modified / unchanged / added /
  removed + 行级规模 + 记分对照；零 LLM）。
- **版本恢复**：恢复历史版本 = 创建新的不可变修订（历史与旧 Final 永不删除；
  旧门禁结论自然过期，需重新审稿才能再次 Final）。

### HITL 与工作台

- 可行性 / 大纲 / 改进计划 / 修订决策四类 HITL，随 checkpoint 持久化
  （浏览器刷新与后端重启后可恢复）。
- React 19 工作台：工作流实时视图（SSE / 取消 / 分章节进度）、Evidence
  工作台、质量门禁面板、模型设置（含自定义网关；Key 不回显）、浅 / 深 /
  跟随系统主题。

## 验证

- Backend 565 + Frontend 161 vitest；`build` / `typecheck` 干净。
- Playwright 浏览器级 E2E：smoke / visual（默认栈）、workflow（无模型栈）、
  hitl / evidence-gate / paper-artifacts / **version / improvement**（scripted
  栈 + 本机真实 MiKTeX）全部通过。
- 真实模型（zai-coding-cn/glm-5.3）+ 真实 MiKTeX smoke：Idea-to-Paper 全链路
  （M4.7，Draft PASS / Final correctly blocked 的诚实结论）；真实论文
  （26 页中文 / 15 页 arXiv Attention）PDF Review 全链路；M4.8 真实
  Improvement smoke 记录见 PROJECT_STATUS。

## Known Limitations

见 [README — Known Limitations](../README.md#known-limitations真实清单)。
简言之：Visual Reviewer、Skill install/update、Docker 部署、系统管理后台
未实现（M5+）；后端崩溃时进行中的模型调用经 checkpoint 重试而非迁移；
Windows LaTeX 编译超时只终止 shell；PDF 重建为文本级；单机单用户。

## 升级 / 运行

首版发布，无升级路径。Quick Start 见 [README](../README.md#quick-start)。
