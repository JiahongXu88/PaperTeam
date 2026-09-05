# PaperTeam 项目状态

> 更新日期：2026-09-05（M4.2.5 Live Model Integration Gate 完成后）

## 当前阶段

**M4.0-M4.2 Complete（M4.0 Frontend API Contract → M4.1 React Frontend
Skeleton → M4.2 Project Workbench）。React Web Workbench 已落地：React 19 +
TypeScript + Vite + React Router 7 + TanStack Query 5 + Zustand 5（npm，
frontend/ 独立包）；`npm run dev` 一键双进程（Backend :3000 + Vite :5173，
`/api`、`/health` 经 Vite proxy 同源转发，任一退出联动全退）。前端只消费
[API_CONTRACT.md](API_CONTRACT.md) 冻结的 DTO，不依赖 Backend 内部对象；
Runtime Status 完全适配 Pi schema。Project
List / Create Project（双模式）/ Project Workspace 基础壳就绪。
**M4.2.5 Live Model Integration Gate ✅（2026-09-05）：真实 Provider
`zai-coding-cn/glm-5.3` 经运行中 Backend 全链路验证（单 Agent smoke /
live SSE / Workflow 至首个 HITL / 真实 cancel），L3 Live Provider E2E
verified（见下）。下一阶段：M4.3 Workflow Live View + SSE + Cancel。**

## M4.0-M4.2 — React Web Workbench（✅ 完成，2026-09-04）

| 项 | 状态 | 说明 |
|---|---|---|
| M4.0 API Contract | ✅ 完成 | 新增 `docs/API_CONTRACT.md`（端点清单 / DTO / SSE 载荷 / 变更纪律）；审计确认 Backend 已有全部 Project/Workflow/Run/SSE/Evidence/Review/Import 端点，唯一缺口 `GET /api/projects` 已补（`ProjectStore.listMetadata()`，updatedAt 降序，损坏 project.json 跳过）；DTO 边界：Pi AgentSession / Pi event / AgentRunHandle / WorkflowState 全量不进前端 |
| M4.1 Frontend Skeleton | ✅ 完成 | `frontend/` 独立 npm 包：React 19.2 / TS 5.9（strict）/ Vite 7 / react-router-dom 7.18 / @tanstack/react-query 5.102 / zustand 5.0；目录 `api/ components/ pages/ router/ stores/ hooks/ types/ constants/ utils/ styles/`；统一 API Client（ApiError：status/code/NETWORK_ERROR 收敛，404 判定）；Server State 全走 TanStack Query（retry 仅 5xx/网络错误），UI State 走 Zustand（唯一状态：模型未配置横幅 dismiss）；路由 `/`→redirect、`/projects`、`/projects/new`、`/projects/:projectId`、`*`→404；顶栏 RuntimeStatusChip（30s 轮询，Pi schema）+ 模型未配置横幅 |
| M4.2 Project Workbench | ✅ 完成 | ProjectsPage（列表/空态/错误重试/真实字段卡片）；NewProjectPage（Idea-to-Paper 全字段表单 + 双模式选择；校验镜像 Backend 长度上限；Existing-Paper 显示「导入 API 已开放、上传 UI 后续提供」如实提示）；ProjectPage（研究定位真实字段 + WorkflowRun 记录表 + Workflow/Evidence/Review/Artifacts 导航入口标注 M4.3-M4.7，无 mock 数据）；loading/empty/error/not found/form validation/retry/响应式齐备 |
| Dev 双进程 | ✅ 完成 | `scripts/dev.mjs`：backend 依赖/构建检查 + frontend 依赖检查 → 同时 spawn `backend/dist/index.js`（[backend] 前缀）与 Vite（[vite] 前缀）；任一子进程退出 → taskkill 进程树联动退出；Windows 实测 vite 被杀 → backend 联动 → 3000/5173 全释放；根脚本 `build/typecheck/test` 覆盖前后端 |
| 测试 | ✅ 通过 | Backend 234/234（新增 4：GET /api/projects ×3 + listMetadata 排序）；Frontend 24/24（apiClient 6 / projectsApi 4 / ProjectsPage 5 / NewProjectPage 4 / routing 5；Vitest 3 + RTL，`globals: false` 下显式 cleanup）；前端 `tsc --noEmit` 与 production build 通过 |

## M4.2.5 — Live Model Integration Gate（✅ PASS，2026-09-05）

验证型里程碑（无代码改动）。真实 Provider `zai-coding-cn/glm-5.3`（Pi 0.84.4 in-process，`model.phase=configured`）经**运行中 Backend 的公开 HTTP API** 完成 L3 全链路验证。四项验证：

| 项 | 结果 | 说明 |
|---|---|---|
| 单 Agent live smoke | ✅ | `POST /api/projects/:id/generate`（Writer 真实 GLM 调用 10.3s，`manuscript/main.tex` 落盘 1657 字符，内容切题非模板；LaTeX 编译因本机无 TeX 工具 graceful 降级） |
| live 事件流 | ✅ | SSE `GET /api/runs/:runId/events`：replay 边界清晰（`: replay 完成` 注释），此后 4 条 **LIVE** 域事件按 seq 递增实时到达（research.idea 完成 +248s、feasibility 完成 +348s、awaiting_input +348s），stageId 归属正确 |
| Workflow E2E 至首个 HITL | ✅ | run `w-93366adfc650`（项目 `p-b76342cc5b69`）：research.idea（真实 GLM 248s，6 gaps / 21 bibliography / 12 evidence）→ research.feasibility（100s，level=LOW）→ `hitl.feasibility_confirm` **awaiting_input**；checkpoint/events.jsonl/stage 记录/research/feasibility 产物全落盘；activeRuns 归零、managedSessions=3 |
| 真实 cancel | ✅ | run `w-5386755ccb0c`（项目 `p-1131d9dd8cad`）：research.idea 真实生成中（activeRuns=1）POST cancel → 边界语义（在途 LLM 跑完提交结果，循环检查点终结）→ `workflow.cancelled`，终态 cancelled；同项目 run `w-43719502d7c0` 在**复用的同一 research 会话**上新 taskId 完成 research（58s）→ cancel 后会话可复用；全程 runtime healthy |

验证边界（如实记录）：AgentEvent 级（message_update 增量）事件与 AgentRuntime 级 mid-stream `session.abort()` 对真实 Provider 的直接观测，因凭据仅存在于运行中 Backend 进程（`PAPERTEAM_PI_API_KEY` → `setRuntimeApiKey` 仅内存，不落盘；子进程脚本 `modelStatus=not_configured`，符合设计）而无公开观测面——前者经 M3.8 L2（真实 SDK + fauxProvider 假流）覆盖同一映射代码，后者以 Workflow 边界 cancel + runAgent 幂等语义间接验证。凭据安全：Key 未落盘/未入日志/未入库（工作区产物 0 命中；`.env.example` 仅占位符）；Pi 全程 in-process（无 Gateway 进程、无 18789/18790 端口）；回归 build/typecheck/test 全绿（234+24）。测试项目保留：`p-b76342cc5b69`（M4.2.5 Live Model E2E，停于 HITL，可作 M4.3 实时 Workflow UI 演示）、`p-1131d9dd8cad`（M4.2.5 Live Cancel Test，cancelled ×2）。

## M3 — 两条一级业务工作流（✅ 完成）

M3 交付两条一级业务工作流（真实编排引擎 + 真实业务服务，测试中以脚本化 Agent Runtime 全链路验证）：

- **Idea-to-Paper**：调研 → 可行性评估（HITL approve/adjust）→ 大纲（HITL approve/revise）→ 分节写作 → 引用核验 → 三路审稿 → Quality Gate →（bounded 修订 ≤2 轮 + 超限 HITL）→ Build Gate → Final（双 Gate 通过）/ Draft。
- **Existing-LaTeX Improvement**：导入（防 Zip Slip）→ 结构解析 → Baseline Compile → 论文理解 → 引用审计 → 审稿 → 目标评估 → 改进计划（HITL）→ 逐节改造 →（共享审稿/修订/构建后段）。

## M3.8 — Pi Runtime Migration & Runtime Contract v2（✅ 完成，2026-09-04）

| 项 | 状态 | 说明 |
|---|---|---|
| Pi 成为唯一 Runtime | ✅ 完成 | 删除 `PAPERTEAM_AGENT_RUNTIME` selector 与 openclaw 装配分支；index.ts 直接构造 `PiRuntimeAdapter`；业务层仍只面向 `AgentRuntime` 契约（Pi SDK import 限制在 Runtime 层） |
| OpenClaw 基础设施移除 | ✅ 完成 | 删除 `OpenClawRuntimeAdapter`、`runtime/openclaw/gatewayClient`、`backend/src/dev/` 全目录（cli / gatewayHealth / openclawState / runtimeConfig / runtimePaths / supervisor）、Gateway health / handshake / RPC / token / port / runtime.json 全部逻辑；`npm ls openclaw`、`npm ls @openclaw/gateway-client`、`npm ls @openclaw/gateway-protocol` 根与 backend 均为空；用户磁盘上的旧 `~/.paperteam/runtime/openclaw/` state 无害忽略（不主动删除） |
| AgentRuntime Contract v2 | ✅ 完成 | `startAgent(input)` → `AgentRunHandle{taskId, sessionKey, events(), cancel(), result()}`：taskId 在执行开始时立即可得（排队不阻塞句柄返回）；`events()` replay+live、settle 后自然结束、多订阅独立、break 清理订阅；`cancel()` 幂等（queued 标记短路 / running 真实 abort）；`result()` Promise 缓存可重复 await；`close()` 收敛全部 active run 并 dispose 会话。`runAgent()` 保留为 start + await result 的 convenience（业务层 9 处调用点零改动）。v1 的 `cancelTask` / `streamEvents` / `sendMessage` 从契约移除（`getTask` 保留查询已完结任务） |
| 事件流正式接通 | ✅ 完成 | Pi `session.subscribe()` 事件映射为 PaperTeam `AgentEvent`（agent_start / message_start / message_update / message_end / tool_execution_start / update / end / agent_end / agent_settled / turn_start / turn_end）；原始 Pi 事件对象不透传业务层；L2 实证运行中消费（不等任务结束） |
| 取消正式接通 | ✅ 完成 | normal generation 取消（M3.7 实证保持）；**tool execution 取消（M3.8 新增实证）**：customTools 注入可控慢工具 → 执行中 cancel → SDK AbortSignal 真实传导 → 工具停止 → 任务 settle cancelled。工具中 abort 的 SDK 终态实测为 `stopReason="error" + "This operation was aborted"`（LLM 流中断才是 `"aborted"`），Adapter 以取消意图（cancelRequested）归因，不依赖 SDK 编码差异。cancel 已完成/已取消任务幂等 no-op；cancel 后同 session 可继续使用；compaction abort 仍为上游边界（auto-compaction 已禁用、manual compact 未使用） |
| dev 启动链简化 | ✅ 完成 | `npm run dev` → `scripts/dev.mjs`（Node 检查 → backend 依赖检查 → 构建）→ 直启 `backend/dist/index.js`（Pi SDK in-process）。不再安装 OpenClaw / 生成 Gateway state / 寻找端口 / spawn Gateway / 等待 health / 监督子进程 |
| RuntimeStatus 去 Gateway 化 | ✅ 完成 | `GET /api/runtime/status` 新形状：`runtime{provider, phase, version, detail, latencyMs}`（Pi 0.84.4）+ `model{phase, model?, providers, detail}` + `agents{roles}` + `sessions{activeRuns, managedSessions}`；gateway / gatewayRuntimeVersion / gatewayClientSdk / protocolVersion / not_applicable 占位全部删除。healthCheck 语义统一：Runtime 健康（SDK 可加载 / 未关闭 / 初始化正常）≠ 模型就绪（not_configured 单独报告） |
| Model / Auth 收口 | ✅ 完成 | `PAPERTEAM_PI_MODEL` / `PAPERTEAM_PI_API_KEY`（env override，不进日志）/ `agentDir`（默认 `<PAPERTEAM_RUNTIME_ROOT>/runtime/pi/agent`，与 `~/.pi` 隔离）/ `PAPERTEAM_PI_RUN_TIMEOUT_MS`；Key 不硬编码、不落日志；模型未配置 → 结构化失败 + `model.not_configured` |
| 会话隔离回归 | ✅ 完成 | projectId × agentId × contextScope sessionKey 派生保持稳定（纯函数测试 + PiRuntimeAdapter L1 全链路测试）；同 logical session 复用、不同 project / 角色 / reviewer 三 scope 互不串、三路并发、取消一路不影响其它两路 |
| 测试迁移 | ✅ 完成 | 删除 OpenClaw 架构专属测试（OpenClawRuntimeAdapter / runAgent mock-Gateway 集成 / bootstrap / supervisor / versionPins / mockGateway fixture）；业务测试的 fake runtime 全部迁到 v2 接口；PiRuntimeAdapter 测试升级 v2（startAgent 句柄 / 运行中事件 / cancel 幂等 / 排队取消 / result 缓存 / close 收敛 / tool abort 专项） |
| 回归 | ✅ 通过 | `npm run build` / `npm run typecheck` / `npm test` **230/230**（OpenClaw 专属测试移除后总数下降，评价标准为覆盖真实架构）；M3 全量 Workflow 业务测试零回归 |

## M3.7 — Pi Runtime Feasibility & Adapter Spike（✅ 完成，2026-09-04）

Side-by-side 可行性验证：不改变默认 Runtime（当时为 openclaw），新增 Pi 候选实现并用真实代码 + 测试回答「PaperTeam 直接嵌入 Pi SDK 是否比经 OpenClaw Gateway 更合适」。

| 项 | 状态 | 说明 |
|---|---|---|
| PiRuntimeAdapter | ✅ 完成 | 官方 `createAgentSession()` in-process 嵌入（无子进程 / RPC / Gateway）；会话 = `SessionManager.inMemory(cwd)`（Runtime session 可丢弃，Workspace/checkpoint 是事实源）；sessionKey 派生与 OpenClaw 完全一致（`runtime/sessionKey.ts` 共享，GenerationService 显式透传兼容）；per-session 串行 + 跨 session 并发（创建 in-flight 去重）；timeout = 定时器 + `session.abort()`；auto-compaction 经 in-memory settings 关闭 |
| 角色 → Pi 配置映射 | ✅ 完成 | contextScope 前缀 → researcher/writer/reviewer/default：`systemPromptOverride` + 工具白名单（researcher/reviewer 只读，writer 可写文件，无人持有 shell）；systemPrompt 到达 LLM 上下文有 L2 测试实证 |
| 验证分层 | ✅ L1+L2 / **L3 verified（2026-09-05）** | L1 fake session 纯单元 + L2 真实 SDK + 官方 `fauxProvider` 假流：初始化 / 健康 / runAgent 成败 / timeout / 事件顺序与归属 / **abort（LLM 流中取消 → cancelled，会话可复用）** / session 复用 / project·contextScope 隔离 / **Reviewer 三路并发（独立会话、输出不串）** / close·dispose；L3 真实 provider LLM 于 M4.2.5 经运行中 Backend + `zai-coding-cn/glm-5.3` 验证（见 M4.2.5 节） |
| Windows 生命周期 | ✅ 实测 | pi 模式 Backend：零子进程、不占 Gateway 端口（18790）、kill 后无孤儿、端口释放；OpenClaw 基线 `npm run dev` 同日复验正常（Gateway 7.6s ready、health 200、优雅关闭） |
| 回归 | ✅ 通过 | `npm run build` / `npm run typecheck` / `npm test` 280/280（零回归）；顺带修复全量并发下偶发的 orchestrator cancel/awaiting_input 竞态（独立 commit） |
| 结论 | **MIGRATE TO PI（建议）** | P0 验证项全部通过；正式迁移由 **M3.8 执行完毕**（本表为历史记录） |

## M3.6 — Runtime Baseline Upgrade（✅ 完成，2026-09-04）

| 项 | 状态 | 说明 |
|---|---|---|
| OpenClaw 2026.8.2 → 2026.9.1 | ✅ 完成 | openclaw = `@openclaw/gateway-client` = `@openclaw/gateway-protocol` = **2026.9.1**（三处统一精确 pin，protocol v4 不变）；lockfile 更新；版本锚点测试防漂移。**（历史基线；M3.8 起 OpenClaw 不再参与运行，三处依赖已移除）** |
| SDK / Protocol 兼容性 | ✅ 无需适配 | 静态核对 + 编译 + 真机验证：`PROTOCOL_VERSION=4` 不变；RPC `agent`（两段式验收）/ `agent.wait` / `chat.history` 行为不变；未发现影响 PaperTeam 的 breaking change |
| Node Runtime 兼容 | ✅ 完成 | `scripts/dev.mjs` 改为复用根 package.json `engines.node` 作为唯一事实源（微型解析器，不新增依赖），Node 26+ 可用 |
| runtime.json 存量升级迁移 | ✅ 完成 | 旧 `openclawVersion` 自动迁移到当前 pin（端口 / token 保留）；单测 + 真机 E2E 双验证。**（M3.8 起 runtime.json 机制随 Bootstrap 移除；用户磁盘旧文件无害忽略）** |
| 回归 | ✅ 通过 | `npm test` 255 通过；真机 `npm run dev`：Gateway 约 6s 就绪、health 200、Backend 3000 监听、进程树唯一、优雅关闭级联无孤儿、端口全部释放 |

## M3.5 — Runtime Bootstrap / M3 Closure（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| Runtime Bootstrap | ✅ 完成 | 仓库根 `npm run dev`：Node 版本检查 → 依赖自动安装 → 构建 → 准备独立 state → 启动 Gateway → 等 /health 就绪 → 启动 Backend → Ctrl+C 优雅关闭。**（M3.8 起该链路简化为直启 Backend，见 M3.8 表）** |
| 独立 OpenClaw state | ✅ 完成 | state 在用户级 `~/.paperteam/runtime/openclaw/`；路径解析硬校验与全局 `~/.openclaw` 不相等/不嵌套（D-0018） |
| Agent 映射（方案 A） | ✅ 完成 | Researcher/Writer/Reviewer/Citation 默认全部映射默认 agent `main`，会话隔离靠 contextScope（D-0016/D-0018）；映射在 config 层（env 可覆盖）。**（M3.8 起语义保留：会话标识默认 main，仅作 sessionKey 组成段）** |
| Runtime 诊断 | ✅ 完成 | `GET /api/runtime/status`（gateway/runtime/agents/model 分区）。**（M3.8 去 Gateway 化，形状见 M3.8 表）** |
| 优雅关闭 | ✅ 完成 | Ctrl+C：Backend 先停（编排器取消活跃 run、checkpoint 落盘、断开 SSE）→ Gateway 后停；Windows 真实控制台 Ctrl+C E2E 验证（无孤儿、端口释放） |
| 模型凭据边界 | ✅ 完成 | Bootstrap 不搬运/复用任何其他项目凭据；用户把 provider API Key 写入独立 state。**（M3.8 起：`PAPERTEAM_PI_API_KEY` / agentDir auth.json / 标准环境变量）** |

## M3.5 真实环境验证（本机 dev smoke + E2E）

以下为 2026-09-03 在全新机器（未装全局 OpenClaw、无 TeX、无模型凭据）上的真实运行结果（OpenClaw 基线，历史记录）：

1. **`npm run dev` 三次真实启动**：首次自动初始化 `~/.paperteam` state → Gateway 18790 健康（首次约 3s ready）→ Backend 3000 监听 → `GET /health` ok。
2. **`GET /api/runtime/status` 真实输出**：`gateway: healthy`、`runtime: model_not_configured`、四个角色映射 `main` 全部 `configured`、`model: not_configured`。
3. **真实 Idea-to-Paper E2E（无模型凭据路径）**：run 真实推进到 `research.idea` → 经真实 Gateway RPC 返回网关权威错误 → Stage transient 重试 2/2 → failed 终态（`AGENT_RUN_FAILED`）；SSE replay 正常。
4. **Ctrl+C E2E（Windows 真实控制台事件）**：Backend/Gateway/cli 依次优雅退出、端口全部释放、无残留进程。
5. **未真实验证的内容**（如实记录）：带真实模型凭据的完整 Idea-to-Paper 全链路；TeX 真实编译（本机无 pdflatex/xelatex/latexmk）；多模态 PDF 分析。

## M3.0 — Workflow Foundation（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| WorkflowOrchestrator | ✅ 完成 | 确定性 TS 引擎（非 Agent）：stage 推进、retry（按失败分类）、timeout、checkpoint/resume、HITL、协作式取消（AbortSignal 传播）、DoD 硬校验、bounded loop（由 plan() 纯函数表达，可从 checkpoint 重放） |
| WorkflowRun 异步 API | ✅ 完成 | `POST /api/projects/:id/workflows` → 202 `{runId}`；`GET /api/runs/:runId`；`GET /api/runs?projectId=`；`POST /resume`、`POST /cancel`；同一项目存在进行中 run 时拒绝新建（409） |
| StageContract | ✅ 完成 | `StageSpec`：id / requiredInputs / producedOutputs / maxAttempts / timeoutMs / retryable 失败分类 / execute / verifyDod（DoD）。Agent 返回文本 ≠ 成功：产出必须通过 DoD |
| checkpoint 持久化 | ✅ 完成 | `projects/<id>/workflow/runs/<runId>/{checkpoint.json,events.jsonl,stages/}`；checkpoint 原子写（tmp → fsync → rename）；终态「先持久化、后提交内存」 |
| 进程重启恢复 | ✅ 完成 | `recoverInterruptedRuns()`：running/pending 从 checkpoint 重启（已成功 stage 不重复执行）；awaiting_input 保持等待可 resume；事件 seq 与磁盘日志对齐 |
| Domain Event | ✅ 完成 | events.jsonl（追加写、损坏行容忍）；`workflow.*`、`stage.*`、`quality_gate.*`、`build_gate.*`；不含 sessionKey/token/内部事件 |
| SSE | ✅ 完成 | `GET /api/runs/:runId/events`：先订阅后 replay（seq 去重）保证不重不漏；15s 心跳；断开只清理连接 |
| HITL awaiting_input | ✅ 完成 | 通用机制：进入待办 → resume 校验 decision → `onInput` 返回 `"cancel"` 可直接取消 run |
| contextScope | ✅ 完成 | `RunAgentInput.contextScope`；sessionKey 派生 `agent:{agentId}:paperteam-{projectId}--{scope}`；scope 归一化；M2.1 无 scope 行为保持（回归测试） |
| 旧 generate API | ✅ 保留 | M2 同步端点与响应契约不变（标 deprecated） |

## M3.1 — Research & Evidence（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| 项目研究定位字段 | ✅ 完成 | `workflowKind / researchIdea / researchField / documentType / targetProfile / targetVenue / language`；创建携带、`PATCH /api/projects/:id` 更新；旧版 project.json 向后兼容 |
| Researcher | ✅ 完成 | Idea Research 结构化输出校验后落盘 `research/research.json`；候选 Evidence 以 unverified 进入 EvidenceStore；候选 bibliography 去重 |
| Target Feasibility | ✅ 完成 | HIGH/MEDIUM/LOW/INSUFFICIENT 离散结论；LOW/INSUFFICIENT 必须给出差距；HITL adjust 更新目标后重评估（≤3 次） |
| EvidenceStore | ✅ 完成 | 项目级 `evidence/evidence.jsonl`：append/get/list/query/updateVerification/markUsage/stats；损坏行容忍；项目隔离 |
| Citation 静态核验 | ✅ 完成 | `\cite` 族 ↔ references.bib：missing/unused/duplicate/bad；零依赖 |
| Citation metadata 核验 | ✅ 完成 | Provider 抽象 + CrossRef/OpenAlex/arXiv：404 → not_found、网络故障 → unverifiable（绝不因网络判 not_found）；开关与上限可配 |
| Reference PDF 接入 | ✅ 完成 | SourceStore：上传（base64，20MB 上限）、sourceRole、preferred、删除；原始文件与解析产物隔离 |
| PDF 分析 | ✅ 完成（文本层）| `BuiltinPdfAnalyzer`：零依赖文本/结构层；extractionQuality 如实分级 |
| 多模态扩展点 | ✅ 接口就绪 / ⏳ 受环境约束 | `MultimodalAnalyzer` 接口 + `AgentMultimodalAnalyzer`（本地路径交 Runtime 侧 pdf 能力）；能力不可用返回明确 capability-gap，不伪造成功 |
| Section-based 手稿 | ✅ 完成 | outline.json（≥3 节校验）；章节正文片段校验；`main.tex` 由确定性代码组装（不交给 LLM）；references.bib 确定性生成 |
| Derived Context | ✅ 完成 | `context.yaml` 可随时删除重建；`GET /context?rebuild=true` |

## M3.2 — Review & Revision（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| Reviewer | ✅ 完成 | 单 Agent 三 skill：fact / academic / style；统一 ReviewIssue |
| contextScope 隔离 | ✅ 完成 | review/fact、review/academic、review/style 三个独立会话 |
| 并行 fan-out | ✅ 完成 | `Promise.all` 三路并行；无 dangling 连接/定时器 |
| Review aggregation | ✅ 完成 | 确定性聚合；无 LLM 参与聚合 |
| bounded revision loop | ✅ 完成 | 默认最多 2 轮自动修订；引用核验问题进入修订指令；超限 → HITL |
| Build Gate | ✅ 完成 | 编译结果 + include + bib 可用；只判「能否构建」（D-0015） |
| Quality Gate | ✅ 完成 | 9 条确定性规则；报告落盘 + 事件 |
| Draft/Final 规则 | ✅ 完成 | Draft = Build Gate 通过；Final = 双 Gate 通过 |
| Existing-LaTeX 导入 | ✅ 完成 MVP | 零依赖 ZIP 读取器（防 Zip Slip）；结构识别；原始快照；Baseline Compile best-effort |
| Existing-Paper workflow | ✅ 完成 | 导入校验 → baseline → 论文理解 → 引用审计 → 审稿 → 目标评估 → 改进计划 → HITL → 逐节改造 → 共享后段 |

## M3 API 一览（实际实现）

> Workflow API（`POST /api/projects/:id/workflows` + `/api/runs/*`）是**主入口**；
> 下列 review / citation-check / build / quality-gate 等细粒度端点是调试 / 手动操作 /
> 工具 API，前端（M4）不自行串联它们——编排由 WorkflowOrchestrator 在后端完成。

```text
GET    /health                                    存活探针（含 Pi Runtime 实时健康）
GET    /api/runtime/status                        Runtime 诊断（runtime/agents/model/sessions，Pi schema）
POST   /api/projects                              创建项目 {title, workflowKind?, researchIdea?, …}
GET    /api/projects/:id                          项目元数据
PATCH  /api/projects/:id                          更新研究定位字段
POST   /api/projects/:id/generate                 M2 同步写作+编译（deprecated，保留兼容）
POST   /api/projects/:id/workflows                创建异步 WorkflowRun {kind, prompt?} → 202 {runId}
GET    /api/runs?projectId=xxx                    run 列表
GET    /api/runs/:runId                           run 状态 / 待办 / 错误
GET    /api/runs/:runId/events                    SSE（replay + 实时 Domain Event）
POST   /api/runs/:runId/resume                    HITL 输入 {decision, payload?}
POST   /api/runs/:runId/cancel                    取消
POST   /api/projects/:id/import                   导入 LaTeX 项目（archiveBase64 | files）
GET    /api/projects/:id/import                   最近导入报告
POST   /api/projects/:id/sources                  上传文献 {fileName, contentBase64, sourceRole?…}
GET    /api/projects/:id/sources                  文献列表
GET|PATCH|DELETE /api/projects/:id/sources/:sid   详情 / 角色 / 删除
POST   /api/projects/:id/sources/:sid/analyze     PDF 分析 {mode: builtin|multimodal}
GET|POST /api/projects/:id/evidence               Evidence 列表（查询参数）/ 手工添加
POST   /api/projects/:id/evidence/:eid/verify     更新核验状态
GET    /api/projects/:id/feasibility              最近可行性报告
POST   /api/projects/:id/citation-check           引用核验（静态 + metadata）
GET    /api/projects/:id/citation-report          最近引用报告
POST   /api/projects/:id/review                   独立全面审稿（三路并行 + 聚合）
GET    /api/projects/:id/reviews                  审稿汇总列表
POST   /api/projects/:id/quality-gate             Quality Gate 评估（基于最新 artifacts）
POST   /api/projects/:id/build                    Build Gate + Draft PDF
GET    /api/projects/:id/manuscript               大纲 + 章节状态
GET    /api/projects/:id/context?rebuild=true     Derived Context
```

## 测试与验证

- **Backend 234 + Frontend 24 个测试全部通过**（vitest；backend 22 个测试文件。M3.8 迁移后口径，M4.0 新增 4 个 backend 测试：`GET /api/projects` ×3 + `listMetadata` 排序；Frontend 24 个属 `frontend/` 独立包）。构成：M1/M2 业务与 Project/LaTeX/HTTP、M3 Workflow / Evidence / Review / Revision / HITL / Quality Gate / Domain Event / SSE / checkpoint、M3.8 Runtime 层（PiRuntimeAdapter L1 fake session 纯单元 + L2 真实 SDK × 官方 fauxProvider、contextScope 派生、RuntimeStatus Pi 形状、config Pi 块）、M4.0 Project List API。
  M3.8 新增/强化覆盖——Contract v2（`startAgent` 立即返回句柄、运行中 `events()` 消费 replay+live+settle 终止、多订阅独立、`cancel()` 幂等含已完成/已取消、排队任务取消不误伤同会话前序 run、`result()` Promise 缓存、timeout 路径 reject 一致、`close()` 收敛全部在途 run 并 dispose、getTask 运行中/已完结语义）；**tool execution abort 专项**（真实 SDK：工具执行中 cancel → AbortSignal 传导 → 工具停止 → cancelled）；OpenClaw 架构专属测试（mock Gateway 集成 / bootstrap / supervisor / versionPins）随架构删除，业务测试全部迁到 v2 fake runtime。
- `npm run typecheck`、`npm run build` 通过（backend 与根入口均验证）；无 lint 脚本（package.json 未定义）。
- 测试策略：编排引擎与业务服务为真实实现，仅 AgentRuntime 注入脚本化 fake
  （按 contextScope 返回结构化输出）；LaTeX 编译注入 fake runner；metadata provider 注入 fake fetch。

## 非阻塞环境验证项（Non-blocking Validation Gaps）

以下为**环境验证缺口，不是设计决策，不阻塞代码交付**：

1. **带真实模型凭据的完整 Idea-to-Paper E2E**：M3.7/M3.8 已用真实 Pi SDK + 官方 fauxProvider 验证全部 Runtime 语义（初始化 / 单轮 / 事件 / 取消 / 工具取消 / 并发 / 隔离）；**L3 Live Provider E2E 已于 M4.2.5（2026-09-05）verified**——真实 `zai-coding-cn/glm-5.3` 经运行中 Backend 验证单 Agent / SSE / Workflow 至首个 HITL / cancel（见 M4.2.5 节）。HITL resume 之后的完整论文链（Outline → 写作 → 审稿 → 修订 → PDF）仍未跑真实模型（有意节省额度，M4.3+ 按需）。
2. **TeX Live 真实编译**：本机未安装 pdflatex/xelatex/latexmk；LatexCompiler 与 Build Gate 的编译路径经注入式 runner 覆盖，真实 PDF 编译待有 TeX 环境的机器验证。
3. **多模态 PDF 视觉级分析 E2E**：依赖具备视觉/PDF 能力的模型与沙箱路径授权，当前环境无法真实跑通（返回 capability-gap 如实报告，不伪造成功）。
4. **Citation metadata providers 真实网络**：真实限流与响应形态待部署环境观察。

## M3 遗留问题（真实问题，均不阻塞验收）

1. Outline HITL 当前仍为强制节点（PRD 标记 Outline 确认为可选）；当前实现两处 HITL（feasibility/outline）都必经，计划 M4 前端 / Workflow 配置化处理。
2. EvidenceStore 的 update/markUsage 是全量原子重写（规模内可接受）；索引/数据库迁移条件仍按未决问题 2 评估。
3. 修订循环对「需要改 bib 本身」的引用问题只能删除/弱化引用，不会替用户新造文献条目（有意为之：防伪造引用）；bib 自动新增策略未实现，补文献属于 Researcher/用户输入路径。
4. Pi compaction abort 未验证（上游边界）：auto-compaction 已禁用、manual compact 未使用；若未来启用需专项验证其取消边界。
5. Workflow cancel 为边界语义（stage 服务不监听 AbortSignal，在途 LLM 调用跑完后于循环检查点终结；M4.2.5 真实验证确认）；AgentRuntime 级 mid-stream abort 对真实 Provider 的直接观测无公开 API 面（L2 已覆盖同一代码路径）。
6. Windows 下若 dev 父进程被外部硬杀（非 Ctrl+C），Backend 进程可能残留（正常 Ctrl+C 已验证优雅退出）；Pi 路径无任何 Runtime 子进程，硬杀 Backend 即全部回收。

（M3.5~M3.7 时代与 OpenClaw Gateway 相关的遗留项——runAgent 每次连接、Windows Gateway 硬杀孤儿、Gateway 版本 RPC、Bootstrap/生命周期——已随 M3.8 迁移消失，从本清单移除。）

## 未决设计问题

1. documentType / targetProfile 建议值集合的前端呈现（存储层保持自由字符串，不冻结）。
2. EvidenceStore 索引与 SQLite 迁移条件（同前）。
3. M4+ 前端技术栈、Docker/compose、TeX Live 镜像体积控制。

## 历史

- **M4.2.5 Live Model Integration Gate**：验证型里程碑（无代码改动）——真实 Provider `zai-coding-cn/glm-5.3` 经运行中 Backend 公开 API 完成 L3 验证：单 Agent smoke（10.3s 真实输出）、live SSE（4 条 LIVE 域事件实时推送）、Workflow E2E 至首个 HITL（checkpoint 全落盘）、真实 cancel（边界语义 + 会话复用）；凭据零泄漏，Pi 全程 in-process，234+24 测试零回归。
- **M3.8 Pi Runtime Migration & Contract v2**：Pi 成为唯一正式 Runtime（`@earendil-works/pi-coding-agent` 0.84.4 精确 pin）；OpenClaw 全套基础设施（Adapter / Gateway client / Bootstrap / supervisor / runtime.json / 三依赖）移除；`AgentRuntime` Contract v2（startAgent → 句柄：运行中事件流 / 取消 / result）；tool execution AbortSignal 取消传导实证；RuntimeStatus 去 Gateway 化；dev 直启 Backend；230 测试。**Pi + Node.js + npm 固化为 M4 Runtime baseline。**
- **M3.7 Pi Runtime Feasibility**：Side-by-side PiRuntimeAdapter 全项验证（in-process / 三路并发 / abort / 事件 / 隔离 / Windows 零 Gateway 子进程），结论 MIGRATE TO PI；280 测试。
- **M3.6 Runtime Baseline Upgrade**：OpenClaw 全家桶 2026.8.2 → **2026.9.1**（历史 baseline；Node 兼容检查收敛到根 package.json engines；runtime.json 存量版本自动迁移；255 测试 + 真机 Gateway E2E 回归）。
- **M3.5 Runtime Bootstrap / M3 Closure**：OpenClaw 独立 Runtime state（`~/.paperteam`）、`npm run dev` 一键启动、Agent 映射方案 A（D-0018）、`GET /api/runtime/status`、优雅关闭与无孤儿验证、254 测试。
- **M2.1 OpenClaw 2.0 Runtime Upgrade**：官方 `@openclaw/gateway-client/protocol`（protocol v4）、Project↔Session 隔离与 runtimeSessionKey 持久化（详见 git history）。
- **M2 Agent Invocation + Project + LaTeX**：runAgent 真实调用链、ProjectStore、WriterService、GenerationService、LatexCompiler、HTTP API。
- **M1 Backend Runtime Skeleton**：工程骨架、AgentRuntime 抽象、Runtime 健康检查。
- **Architecture Research & Product Design Refresh**：竞品调研与产品/架构方向冻结（D-0008~D-0015）。
