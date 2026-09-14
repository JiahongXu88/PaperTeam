# PaperTeam M5 计划：Chinese Academic Quality & Long-Running Reliability

> 建立日期：2026-09-11。M4 已 COMPLETE（v0.1.0-mvp，见
> [PROJECT_STATUS.md](PROJECT_STATUS.md)）。本文件是 M5 的阶段定义与边界权威；
> 实现进度仍以 PROJECT_STATUS.md 为准。
>
> M5 主题：**中文论文质量与长程运行加固**——把「跑得通」的 MVP 推向
> 「长时间可靠运行、中文论文产出质量可评测、可部署」的可用产品。

## 0. M5 主线

M5 围绕六条主线展开，阶段编号即建议执行顺序（M5.0 → M5.6）：

1. **中文论文质量**：以真实中文论文为对象建立可重复的质量评测口径
   （M5.0 基线 + M5.6 验收），避免「改了 prompt 自我感觉变好」。
2. **长程 Runtime 可靠性**：AgentRuntime 契约 v2 之上一批可靠性修复与
   加固（AbortSignal 语义统一、事件缓冲正确性、排队取消及时性、
   长程运行治理），支撑数小时级多轮论文工作流。
3. **Skill 受控接入**：在既有 Skill Registry（审计 seed + pin revision）
   之上补 install/update 的受控产品化路径，不做开放生态。
4. **Style Revision Loop**：面向中文学术写作风格（表达、术语、结构衔接）
   的修订回路，复用既有 Writer–Reviewer 闭环基础设施。
5. **单机 Linux / Docker 部署**：单机单用户形态下的部署可行性
   （含 TeX 工具链镜像），不是集群方案。
6. **最终真实论文 A/B 验收**：以 M5.0 基线口径对 M5 全部改动做
   真实中文论文 A/B 对比验收。

## 1. 阶段定义

### M5.0 Baseline & Evaluation（轻量收口）

- 冻结本计划文件（阶段定义 + 边界）。
- **不在本轮构造完整中文论文 benchmark corpus**；完整 eval corpus
  （中文论文样本集 + 评分口径 + 跑分 harness）在 M5.4 / M5.6 前逐步补齐。
- 现状基线来源：M4.7/M4.8 已有的真实模型 smoke 记录（中文小论文全链路、
  arXiv 英文论文 Improvement 全链路）。

### M5.1 Runtime Lifecycle Reliability

AgentRuntime 契约 v2（`backend/src/runtime/types.ts`）不变更的前提下，
分批修复 PiRuntimeAdapter 的生命周期可靠性问题：

- **第一批（本轮）**：
  - AbortSignal 语义统一——`startAgent()` 自身正确消费
    `RunAgentInput.signal`（pre-aborted / queued / running 三态、监听器
    清理、幂等）；`runAgent()` 退化为纯 convenience wrapper
    （= startAgent + await result），不再持有第二套 signal 实现。
  - 事件缓冲慢消费者问题——有界 replay buffer 的前部裁剪与消费者
    数组下标游标互相冲突，慢消费者可能**静默漏事件**；改为单调递增
    sequence + 每订阅者独立逻辑游标，落后于缓冲淘汰窗口时显式暴露
    gap，绝不静默。
  - queued cancellation——排队任务被取消后应及时 settle cancelled，
    不等待同会话前序长任务完成；不误伤正在运行的任务，不阻塞队列
    后续任务。
- **后续批次**：timeout 分层细化、token usage / cost 统计、context
  budget、session rotation / TTL / GC、global concurrency 等（见 §3）。

### M5.2 Long-Running Governance

长程运行（数小时、多轮审稿-修订、数十会话）的治理：超时分层
（run / stage / workflow三级）、资源预算（token / context）、会话生命
周期管理（rotation、空闲回收）、全局并发与背压、长时间运行的观测面
与自愈（进程重启恢复已有 checkpoint 机制，补齐运行时侧语义）。

> 进度：**COMPLETE（2026-09-12）**。M5.1 第二批提前落地 timeout 分层与
> run 级 usage；2026-09-11 完成全局并发与有界受理；2026-09-12 收口
> context budget（oversized 拒绝 / 输出预留 / measured-estimated-unknown
> 三态占用）、session rotation（安全边界换代、sessionKey 稳定、FIFO
> 保持）、TTL / GC / 会话容量（idle 回收、LRU 淘汰、容量结构化拒绝）
> 与观测面 / 安全自愈（runtimeStats 扩展、逐会话诊断、execution
> timeout / prompt 异常后的下一边界重建）。auto-compaction 保持关闭。
> 真实边界如实：后端进程 crash 时内存中的 AgentSession 无法迁移，
> Workspace/checkpoint 语义不变（见 PROJECT_STATUS.md M5.2 收口记录）。

### M5.3 Controlled Academic Skill Integration（✅ COMPLETE，2026-09-14）

> 范围修正：原描述偏向「Skill install / update / diff / 绑定 UI」这一产品化
> 表面。本阶段的核心重新明确为**三个经过审计、固定版本、按 PaperTeam 学术
> 场景适配的 Skill 真正进入正确的 Writer / Reviewer 工作流**；受控产品化
> 只保留支撑这一目标的最小能力。

三个 Academic Skill（均 MIT，上游 commit 精确 pin，不以 upstream main 为
runtime 依赖）：

| PaperTeam id | 上游 | 适配方向 |
|---|---|---|
| `academic-writing-zh` | K-Dense-AI/scientific-agent-skills `skills/scientific-writing` | 中文工科论文写作：证据绑定、不补造实验 / 数字 / 引用、claim 强度 ≤ evidence、LaTeX / citation key / 公式 / 图表引用保持 |
| `academic-review` | 同仓库 `skills/peer-review` | 可执行的审稿 finding（location / issue / evidence-reason / impact / suggestedAction / severity）；引用真实性仍归 Citation infrastructure；Reviewer 只读 |
| `academic-style-zh` | op7418/Humanizer-zh | 只保留适合中文学术写作的检测 / 修订原则；明确移除「像人」类改写（第一人称、个人感受、题外话、故意混乱、绕过检测器）；硬约束：不改数值 / 单位 / 公式 / citation key / 术语 / 否定与比较方向 / 结论强度 |

具备：

- immutable upstream revision（完整 40 位 commit SHA；拒绝 main / latest / tag）；
- LICENSE / PROVENANCE 随 seed 入库（缺失即拒绝安装）；上游原件 verbatim 快照
  （UPSTREAM_SKILL.md）+ PaperTeam adaptation notes；
- content hash（SKILL.md，行尾归一化）+ bundle hash（整目录）；篡改检测 →
  不注入、由版本快照自愈；
- role + contextScope 路由（修复 `skillDirsForAgent(role)` 只有 role 粒度、
  三个 Reviewer 共用 reviewer 的问题）：fact / academic / style Reviewer 得到
  不同 Skill 集；Writer 普通写作 vs style-polish 不同；researcher / citation
  既有路由不退化；旧 role-only 调用继续有效；
- session 级 Skill 版本固定：Skill 目录以 `versions/<id>/<hash>/` 不可变快照
  注入，更新只影响新 session / 后续 rotation 后的新 generation；
- assigned ≠ accessed：任务终态记录 assignedSkills（id / revision /
  contentHash）；accessed 只在 Pi `tool_execution_start(read)` 事件真实命中
  Skill 文件时记录，否则如实报告 accessBasis=unknown——绝不把「放进
  available_skills」等同于「已使用」；
- controlled install / update：approved catalog = 仓库内审计 seed；
  安装状态 / pinned revision / contentHash / license / provenance / update
  available / diff preview / apply audited update；无任意 URL 安装；
- 最小 Skill Settings UI：名称 / 用途 / 来源 / 固定 revision / 安装状态 /
  hash 摘要 / 绑定的 role + contextScope / update 状态；install / preview /
  apply / provenance / bindings。

不做：开放 Marketplace、任意 URL 安装、用户随意执行第三方 Skill 脚本、
自动从互联网下载未知代码并运行。上游附带的 Python/Bash 工具不进入
PaperTeam（Reviewer / Writer 权限不放宽）。软件 attribution（LICENSE /
PROVENANCE / CITATION 提示）与用户论文 bibliography 是两个概念：PaperTeam
不会因为使用某个 Skill 就自动改动用户论文的参考文献。

> 进度：**COMPLETE（2026-09-14）**。三个 Skill 以审计 seed 入库
> （`backend/skills/seed/academic-{writing-zh,review,style-zh}/`：SKILL.md
> 适配正文 + skill.json + LICENSE 原件 + PROVENANCE.md + UPSTREAM_SKILL.md
> verbatim 快照）；上游 pin：K-Dense-AI/scientific-agent-skills
> `0b2afe68a5f9379097ad815e028af664f1e222b7`（scientific-writing / peer-review）、
> op7418/Humanizer-zh `91f3d394db8419c20d67ebe22a96cf8fee0a404b`。SkillRegistry
> 重构为受控 Skill Store（`installed/` 元数据 + 当前副本、`versions/<id>/<hash>/`
> 不可变快照；seed 校验拒绝非 40 位 SHA / 缺 LICENSE / 缺 PROVENANCE / 上游快照
> hash 不符；篡改 → 不注入 + 自愈；已安装 skill 的 seed 变化只标 update
> available，需预览后应用）；`routing.ts` 提供 role + contextScope 路由
> （fact→verify-citations、academic / section→academic-review、style→
> academic-style-zh；writer 默认 / outline / sections / revision→academic-
> writing-zh，style-polish→+academic-style-zh，repair→无）；PiRuntimeAdapter
> 在会话创建 / rotation 边界解析注入并在 generation 内固定，任务终态携带
> `skills.assigned`（id / revision / contentHash）与 `skills.accessed`
> （仅 read 工具真实命中快照文件；无事件 → accessBasis=unknown、accessed=null）；
> HTTP：GET /api/skills（skills + catalog + bindings）、/provenance、
> /update-preview、POST /install（仅 approved id）、/update（候选 hash 校验）；
> Skills 页展示用途 / 来源 / 固定 revision / hash 摘要 / role+scope 绑定 /
> 更新状态，支持安装 / 预览 / 应用 / 查看 provenance；`PAPERTEAM_DISABLED_
> SKILLS` 用于 A/B 关闭学术 Skill。测试：backend 652 → 670 passed（skills
> 27），frontend 161 → 164 passed。

### M5.4 Style Revision Loop

中文学术写作风格修订回路：style 维度从「审稿 lens 之一」升级为可配置
的修订目标（表达自然度、术语一致性、学术措辞、段落衔接），复用
deterministic Revision Plan + Writer 执行 + 强制复审 + 收敛判定的既有
闭环（D-0026），不新增 Agent 角色。

### M5.5 Linux / Docker Deployment

单机 Linux 部署：Backend + Frontend + Pi SDK + TeX 工具链
（texlive-xetex + 中文字体）的 Docker 镜像与 compose 配置；Windows
依赖项（pymupdf 子进程、路径处理）的跨平台核验。目标形态是**单机
单用户**，不做多租户 / K8s / HA。

### M5.6 Real Paper Acceptance & Release

以 M5.0 建立的口径做真实中文论文 A/B 验收（M5 改动前后的产出质量、
长程运行稳定性、部署可用性），诚实记录结论；版本发布与 Release Notes。

## 2. M5 明确不做（非目标）

以下内容**不属于 M5**（部分为更远期方向，部分明确不做）：

- 多 Runtime 实际接入（AgentRuntime 契约保留可替换性，但 M5 只有
  PiRuntimeAdapter 一个实现）；
- Claude Code / DeepSeek 等 Harness Runtime 接入；
- Visual Reviewer（多模态视觉审稿）；
- PDF 图表 / 原版式保真重建（Improvement 链路的确定性重建保持
  「文本级、不含原图与原版式」的如实边界，D-0028）；
- Experiment Agent（实验设计与执行代理）；
- 在线 Skill Marketplace（开放生态）；
- 多租户；
- Kubernetes / 高可用；
- System Admin（系统管理后台）。

> 历史文档中「M5+（可选方向）：Visual Reviewer、Skill Management、
> Deployment、System Admin」的表述自本文件起被取代：M5 实际范围以上述
> §1 为准；Visual Reviewer 与 System Admin 移出 M5。

## 3. 执行纪律

- 每个阶段先写回归测试再改实现（尤其 Runtime 行为类改动）。
- 不降低既有质量门禁，不修改 Writer / Reviewer 业务语义
  （M5.4 除外，且需 A/B 证据）。
- AgentRuntime 契约 v2 保持向后兼容；如确需扩展（如事件 sequence），
  采用可选字段 / 最小表面，并先确认全部调用方。
- 阶段完成标准：`npm run build` / `npm run typecheck` / `npm test`
  全绿 + 该阶段专项测试通过 + PROJECT_STATUS 更新。
