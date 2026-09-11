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

> 进度：timeout 分层与 run 级 usage 基础采集已随 M5.1 第二批提前落地；
> 全局并发与有界受理（Runtime 层 global concurrency + bounded
> admission）已于 2026-09-11 完成（见 PROJECT_STATUS.md）。剩余：context
> budget、session rotation / TTL / GC、观测面与自愈补齐。

### M5.3 Controlled Skill Integration

Skill install / update 的受控路径：保留「仓库内审计 + pin revision +
LICENSE / PROVENANCE」纪律（D-0025），补齐安装来源校验、版本升级的
diff 审计、绑定编辑的 UI；不引入开放 marketplace，不放宽安全边界。

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
