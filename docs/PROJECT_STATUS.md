# PaperTeam 项目状态

> 更新日期：2026-09-04（M3.7 Pi Runtime Feasibility & Adapter Spike 完成后）

## 当前阶段

**M3.7 Complete（M3.0 → M3.1 → M3.2 → M3.5 Runtime Bootstrap → M3.6 Runtime
Baseline Upgrade → M3.7 Pi Runtime Feasibility）。OpenClaw 2026.9.1 仍是
production/default Runtime baseline；M3.7 以 side-by-side 方式新增
PiRuntimeAdapter（`@earendil-works/pi-coding-agent` 0.84.4 精确 pin，
in-process 嵌入，`PAPERTEAM_AGENT_RUNTIME=pi` 启用，默认仍为 openclaw），
A/B 验证结论为 **MIGRATE TO PI（建议）**——Pi 已证明可覆盖 PaperTeam 当前
全部 Runtime 需求且显著削减基础设施（无 Gateway 子进程 / 端口 / WebSocket /
握手 / RPC 轮询）；正式迁移留待后续任务，本阶段未删除任何 OpenClaw 代码。
下一阶段：M4 Not Started（前端工作台 React 19 + TypeScript + Vite、
Visual Reviewer、LaTeX repair loop、完整版本管理）。**

M3 交付两条一级业务工作流（真实编排引擎 + 真实业务服务，测试中以脚本化 Agent Runtime 全链路验证）：

- **Idea-to-Paper**：调研 → 可行性评估（HITL approve/adjust）→ 大纲（HITL approve/revise）→ 分节写作 → 引用核验 → 三路审稿 → Quality Gate →（bounded 修订 ≤2 轮 + 超限 HITL）→ Build Gate → Final（双 Gate 通过）/ Draft。
- **Existing-LaTeX Improvement**：导入（防 Zip Slip）→ 结构解析 → Baseline Compile → 论文理解 → 引用审计 → 审稿 → 目标评估 → 改进计划（HITL）→ 逐节改造 →（共享审稿/修订/构建后段）。

## M3.7 — Pi Runtime Feasibility & Adapter Spike（✅ 完成，2026-09-04）

Side-by-side 可行性验证：**不改变默认 Runtime（openclaw）**，新增 Pi 候选实现并用真实代码 + 测试回答「PaperTeam 直接嵌入 Pi SDK 是否比经 OpenClaw Gateway 更合适」。

| 项 | 状态 | 说明 |
|---|---|---|
| PiRuntimeAdapter | ✅ 完成 | `backend/src/runtime/PiRuntimeAdapter.ts` + `pi/`（version / roleConfig）：官方 `createAgentSession()` in-process 嵌入（无子进程 / RPC / Gateway）；会话 = `SessionManager.inMemory(cwd)`（Runtime session 可丢弃，Workspace/checkpoint 是事实源）；sessionKey 派生与 OpenClaw 完全一致（`runtime/sessionKey.ts` 共享，GenerationService 显式透传兼容）；per-session 串行 + 跨 session 并发（创建 in-flight 去重）；模型/auth 经 `ModelRuntime`（`PAPERTEAM_PI_MODEL` + `PAPERTEAM_PI_API_KEY`，隔离 agentDir `<runtimeRoot>/runtime/pi/agent/`）；timeout = 定时器 + `session.abort()`；auto-compaction 经 in-memory settings 关闭 |
| 角色 → Pi 配置映射 | ✅ 完成 | contextScope 前缀 → researcher/writer/reviewer/default：`systemPromptOverride`（经 `DefaultResourceLoader` 官方入口）+ 工具白名单（researcher/reviewer 只读，writer 可写文件，无人持有 shell）；systemPrompt 到达 LLM 上下文有 L2 测试实证 |
| Runtime Selector | ✅ 完成 | `PAPERTEAM_AGENT_RUNTIME=openclaw\|pi`（默认 openclaw）；config 层解析（pi 下 OPENCLAW_GATEWAY_URL 不再必填）；index.ts 装配分支；`npm run dev` 在 pi 下跳过 Gateway 启动只监督 Backend；前端零感知 |
| 诊断兼容 | ✅ 最小调整 | `GET /api/runtime/status` 按 provider 分流：pi 返回 gateway `not_applicable` + runtime/model 相位分区（runtime healthy ≠ 模型就绪）；当前 RuntimeStatusService 与 Gateway 的耦合是记录在案的架构耦合点，未做大规模重写 |
| 验证分层 | ✅ L1+L2 / L3 NOT VERIFIED | L1 fake session 纯单元（16 case）+ L2 真实 SDK + 官方 `fauxProvider` 假流（9 case）：初始化 / 健康 / runAgent 成败 / timeout / 事件顺序与归属 / **abort（LLM 流中取消 → cancelled，会话可复用）** / session 复用 / project·contextScope 隔离 / **Reviewer 三路并发（独立会话、输出不串）** / close·dispose；L3 真实 provider LLM 因本机无凭据 NOT VERIFIED（未伪造） |
| Windows 生命周期 | ✅ 实测 | pi 模式 Backend：零子进程、不占 Gateway 端口（18790）、kill 后无孤儿、端口释放（受控实验 + dev 链 E2E）；OpenClaw 基线 `npm run dev` 同日复验正常（Gateway 7.6s ready、health 200、优雅关闭） |
| 回归 | ✅ 通过 | `npm run build` / `npm run typecheck` / `npm test` **280/280**（M3.6 基线 255 + 新增 25，零回归）；顺带修复全量并发下偶发的 orchestrator cancel/awaiting_input 竞态（独立 commit） |
| 结论 | **MIGRATE TO PI（建议）** | P0 验证项全部通过；削减 Gateway / WebSocket / handshake / agent RPC / agent.wait / chat.history / Bootstrap / port / 子进程全套设施。正式迁移（含删除 OpenClaw）留待后续任务；在此之前 OpenClaw 2026.9.1 仍是默认与生产基线 |

| 项 | 状态 | 说明 |
|---|---|---|
| OpenClaw 2026.8.2 → 2026.9.1 | ✅ 完成 | openclaw（runtime 本体，根 devDependency）= `@openclaw/gateway-client` = `@openclaw/gateway-protocol` = **2026.9.1**（三处统一精确 pin，protocol v4 不变，较 2026.8.2 为 stable 大版本升级）；lockfile 更新；版本锚点测试防漂移 |
| SDK / Protocol 兼容性 | ✅ 无需适配 | 静态核对 + 编译 + 真机验证：`PROTOCOL_VERSION=4` 不变；`GatewayClient` 构造选项 / `start`·`request`·`stopAndWait` / `GatewayClientRequestError`·`GatewayClientRequestTimeoutError` 全部保留（新增导出均为增量）；RPC `agent`（两段式验收）/ `agent.wait` / `chat.history` / `gateway.identity.get` / `agents.list` / `models.authStatus` 行为不变；`/health` 契约（`{"ok":true,"status":"live"}`）与实例隔离三件套（`OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` / `--port`）不变；未发现影响 PaperTeam 的 breaking change |
| Node Runtime 兼容 | ✅ 完成 | 修复 M3.5 缺口：`scripts/dev.mjs` 原以 `[25,9,0,26)` 上界错误拒绝 Node 26（engines 的 `>=25.9.0` 无上界、openclaw 2026.9.1 官方支持并推荐 Node 26）；现改为复用根 package.json `engines.node` 作为唯一事实源（微型解析器，不新增依赖、不做版本管理器），单点维护 |
| runtime.json 存量升级迁移 | ✅ 完成 | M3.5 时代写入的 `openclawVersion: 2026.8.2` 会在启动时自动迁移到当前代码 pin（端口 / token 保留，迁移有日志）；修复存量安装升级会被误判「版本漂移」而拒绝启动的缺口；单测 + 真机 E2E（temp runtime root 预置旧版本 → 迁移 → Gateway 健康）双验证 |
| 回归 | ✅ 通过 | `npm run build` / `npm run typecheck` / `npm test`（**255** 通过，含新增迁移测试）；真机 `npm run dev`：Gateway 2026.9.1 约 6s 就绪、health 200、Backend 3000 监听、进程树唯一（无重复 Gateway）、真实 workflow RPC 链路（agent 验收 → agent.wait 终态 → 网关权威错误 → transient 重试 2/2 → failed 终态、SSE 事件完整）、优雅关闭级联无孤儿、端口全部释放 |

## M3.6 — Runtime Baseline Upgrade（✅ 完成，2026-09-04）

| 项 | 状态 | 说明 |
|---|---|---|
| OpenClaw 2026.8.2 → 2026.9.1 | ✅ 完成 | openclaw（runtime 本体，根 devDependency）= `@openclaw/gateway-client` = `@openclaw/gateway-protocol` = **2026.9.1**（三处统一精确 pin，protocol v4 不变，较 2026.8.2 为 stable 大版本升级）；lockfile 更新；版本锚点测试防漂移 |
| SDK / Protocol 兼容性 | ✅ 无需适配 | 静态核对 + 编译 + 真机验证：`PROTOCOL_VERSION=4` 不变；`GatewayClient` 构造选项 / `start`·`request`·`stopAndWait` / `GatewayClientRequestError`·`GatewayClientRequestTimeoutError` 全部保留（新增导出均为增量）；RPC `agent`（两段式验收）/ `agent.wait` / `chat.history` / `gateway.identity.get` / `agents.list` / `models.authStatus` 行为不变；`/health` 契约（`{"ok":true,"status":"live"}`）与实例隔离三件套（`OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` / `--port`）不变；未发现影响 PaperTeam 的 breaking change |
| Node Runtime 兼容 | ✅ 完成 | 修复 M3.5 缺口：`scripts/dev.mjs` 原以 `[25,9,0,26)` 上界错误拒绝 Node 26（engines 的 `>=25.9.0` 无上界、openclaw 2026.9.1 官方支持并推荐 Node 26）；现改为复用根 package.json `engines.node` 作为唯一事实源（微型解析器，不新增依赖、不做版本管理器），单点维护 |
| runtime.json 存量升级迁移 | ✅ 完成 | M3.5 时代写入的 `openclawVersion: 2026.8.2` 会在启动时自动迁移到当前代码 pin（端口 / token 保留，迁移有日志）；修复存量安装升级会被误判「版本漂移」而拒绝启动的缺口；单测 + 真机 E2E（temp runtime root 预置旧版本 → 迁移 → Gateway 健康）双验证 |
| 回归 | ✅ 通过 | `npm run build` / `npm run typecheck` / `npm test`（**255** 通过，含新增迁移测试）；真机 `npm run dev`：Gateway 2026.9.1 约 6s 就绪、health 200、Backend 3000 监听、进程树唯一（无重复 Gateway）、真实 workflow RPC 链路（agent 验收 → agent.wait 终态 → 网关权威错误 → transient 重试 2/2 → failed 终态、SSE 事件完整）、优雅关闭级联无孤儿、端口全部释放 |

## M3.5 — Runtime Bootstrap / M3 Closure（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| Runtime Bootstrap | ✅ 完成 | 仓库根 `npm run dev`：Node 版本检查 → 依赖自动安装（根 openclaw runtime + backend）→ 构建 → 准备独立 state → 启动 Gateway → 等 /health 就绪（60s 预算，进程提前退出即报错）→ 启动 Backend（注入 Gateway URL/token/端口）→ Ctrl+C 优雅关闭 |
| 独立 OpenClaw state | ✅ 完成 | `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` + 独立端口 18790（官方 multiple-gateways 隔离清单）；state 在用户级 `~/.paperteam/runtime/openclaw/`；路径解析硬校验与全局 `~/.openclaw` 不相等/不嵌套，命中拒绝启动（D-0018） |
| OpenClaw 版本统一 | ✅ 完成 | openclaw（runtime 本体，根 devDependency）= `@openclaw/gateway-client` = `@openclaw/gateway-protocol` = **2026.9.1**（M3.5 时为 2026.8.2，M3.6 升级；protocol v4 全程不变）；全部精确 pin，测试断言三处一致且禁止 `^`/`~`/`latest`；安装版本漂移在启动时拒绝，存量 runtime.json 旧版本自动迁移 |
| Agent 映射（方案 A） | ✅ 完成 | Researcher/Writer/Reviewer/Citation 默认全部映射 OpenClaw 默认 agent `main`，会话隔离靠 contextScope（D-0016/D-0018）；映射在 config 层（env 可覆盖），Service 不感知注册表；`agents.list` RPC 实时校验 registered/missing |
| Runtime 诊断 | ✅ 完成 | `GET /api/runtime/status`：gateway（healthy/starting/unavailable/auth_error/protocol_mismatch）、runtime（ready/model_not_configured/auth_error/protocol_mismatch/gateway_unavailable）、agents 映射、model 凭据状态；不泄露 token/密钥；模型未配置不阻塞启动 |
| 优雅关闭 | ✅ 完成 | Ctrl+C：Backend 先停（编排器取消活跃 run、checkpoint 落盘、`server.closeAllConnections()` 立即断开 SSE）→ Gateway 后停；Windows 真实控制台 Ctrl+C E2E 验证（全进程退出、端口释放、无孤儿）；强制兜底 taskkill /T（win）/SIGKILL（posix） |
| 模型凭据边界 | ✅ 完成 | Bootstrap 不搬运/复用任何其他项目凭据；用户把 provider API Key 写入 `~/.paperteam/runtime/openclaw/.env`（OpenClaw 官方凭据位置）；`POST` 生成 token 随机（runtime.json，日志/响应全脱敏） |
| `.env.example` | ✅ 完成 | 补充 Runtime Bootstrap 变量（PAPERTEAM_RUNTIME_ROOT / PAPERTEAM_DEV_* / 独立 state .env 说明）与 agent 映射默认值 |

## M3.5 真实环境验证（本机 dev smoke + E2E）

以下为 2026-09-03 在全新机器（未装全局 OpenClaw、无 `~/.openclaw`、无 TeX、无模型凭据）上的真实运行结果：

1. **`npm run dev` 三次真实启动**：首次自动初始化 `~/.paperteam` state → Gateway 18790 健康（首次约 3s ready）→ Backend 3000 监听 → `GET /health` ok。
2. **`GET /api/runtime/status` 真实输出**：`gateway: healthy`、`runtime: model_not_configured`、四个角色映射 `main` 全部 `configured`（对照真实 `agents.list`）、`model: not_configured`（对照真实 `models.authStatus`，`providers: []`）。
3. **真实 Idea-to-Paper E2E（无模型凭据路径）**：创建项目（UTF-8 中文正常）→ `POST /workflows` → run 真实推进到 `research.idea` → 经真实 Gateway RPC（agent → agent.wait）返回网关权威错误（模型 harness 未配置）→ Stage 按 transient 重试 2/2 → run 进入 `failed` 终态，错误结构化（`AGENT_RUN_FAILED`）；SSE replay 全部 Domain Event 正常。
4. **Ctrl+C E2E（Windows 真实控制台事件）**：GenerateConsoleCtrlEvent 送至 dev 树 → Backend/ Gateway/cli 依次优雅退出（日志 `[dev] 正在关闭（进程退出）... PaperTeam dev 已退出`）→ 端口全部释放、无残留进程。
5. **未真实验证的内容**（如实记录）：带真实模型凭据的完整 Idea-to-Paper 全链路（本机无任何 provider API Key，不伪造）；TeX 真实编译（本机无 pdflatex/xelatex/latexmk）；多模态 PDF 分析。

## M3.0 — Workflow Foundation（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| WorkflowOrchestrator | ✅ 完成 | 确定性 TS 引擎（非 Agent）：stage 推进、retry（按失败分类）、timeout、checkpoint/resume、HITL、协作式取消（AbortSignal 传播）、DoD 硬校验、bounded loop（由 plan() 纯函数表达，可从 checkpoint 重放） |
| WorkflowRun 异步 API | ✅ 完成 | `POST /api/projects/:id/workflows` → 202 `{runId}`；`GET /api/runs/:runId`（状态/当前 stage/待办/错误）；`GET /api/runs?projectId=`；`POST /resume`、`POST /cancel`；同一项目存在进行中 run 时拒绝新建（409） |
| StageContract | ✅ 完成 | `StageSpec`：id / requiredInputs / producedOutputs / maxAttempts / timeoutMs / retryable 失败分类 / execute / verifyDod（DoD）。Agent 返回文本 ≠ 成功：产出必须通过 DoD |
| checkpoint 持久化 | ✅ 完成 | `projects/<id>/workflow/runs/<runId>/{checkpoint.json,events.jsonl,stages/}`；checkpoint 原子写（tmp → fsync → rename）；终态「先持久化、后提交内存」保证可见即可恢复 |
| 进程重启恢复 | ✅ 完成 | `recoverInterruptedRuns()`：running/pending 的 run 从 checkpoint 重启（已成功 stage 不重复执行，plan 基于 stageResults 推进）；awaiting_input 保持等待可 resume；事件 seq 与磁盘日志对齐不回退 |
| Domain Event | ✅ 完成 | events.jsonl（追加写、损坏行容忍）；`workflow.started/recovered/awaiting_input/resumed/cancelled/completed/failed`、`stage.started/progress/completed/failed`、`quality_gate.passed/failed`、`build_gate.passed/failed`；不含 sessionKey/token/协议帧 |
| SSE | ✅ 完成 | `GET /api/runs/:runId/events`：先订阅后 replay（seq 去重）保证不重不漏；15s 心跳；断开只清理连接，不影响 workflow |
| HITL awaiting_input | ✅ 完成 | 通用机制：进入待办（prompt/options/payload 持久化）→ resume 校验 decision → `onInput` 返回 `"cancel"` 可直接取消 run |
| contextScope | ✅ 完成 | `RunAgentInput.contextScope`；sessionKey 派生 `agent:{agentId}:paperteam-{projectId}--{scope}`；scope 归一化（非法字符折叠、不注入 `:`、长度上限）；M2.1 无 scope 行为保持（回归测试） |
| 旧 generate API | ✅ 保留 | M2 同步端点与响应契约不变（标 deprecated，由 WorkflowRun 取代） |

## M3.1 — Research & Evidence（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| 项目研究定位字段 | ✅ 完成 | `workflowKind / researchIdea / researchField / documentType / targetProfile / targetVenue / language`（自由字符串 + 长度校验，DOCUMENT_TYPES/TARGET_PROFILES 仅建议值不冻结 enum）；创建携带、`PATCH /api/projects/:id` 更新；旧版 project.json 向后兼容 |
| Researcher | ✅ 完成 | Idea Research（领域现状/Related Work/Gap/贡献/问题/文献计划）结构化输出校验后落盘 `research/research.json`；候选 Evidence 以 unverified 进入 EvidenceStore；候选 bibliography（key 校验去重） |
| Target Feasibility | ✅ 完成 | HIGH/MEDIUM/LOW/INSUFFICIENT 离散结论；LOW/INSUFFICIENT 必须给出差距（missingRequirements/requiredExperiments 非空，否则拒绝落盘）；HITL adjust 更新目标后重评估（≤3 次） |
| EvidenceStore | ✅ 完成 | 项目级 `evidence/evidence.jsonl`：append（递增 id）/get/list/query（status/sourceId/section/usedBy/claim 子串）/updateVerification/markUsage/stats；损坏行容忍；项目隔离；confidence 仅辅助字段 |
| Citation 静态核验 | ✅ 完成 | `\cite` 族（natbib/biblatex 变体、`\nocite{*}`）↔ references.bib：missing/unused（警告级）/duplicate/bad；零依赖、无网络可用 |
| Citation metadata 核验 | ✅ 完成 | Provider 抽象 + CrossRef/OpenAlex/arXiv（无凭据公开接口）：DOI/标题查询、超时与 User-Agent 礼仪、顺序调用；404 → not_found（hallucinated 候选）、网络/5xx/超时 → unverifiable（绝不因网络故障判 not_found）；开关与上限可配 |
| Reference PDF 接入 | ✅ 完成 | SourceStore：上传（base64 JSON，20MB 上限）、sourceRole（evidence/reference/both）、preferred、删除；原始文件 `sources/papers/`、索引原子写、解析产物 `sources/parsed/` |
| PDF 分析 | ✅ 完成（文本层）| `BuiltinPdfAnalyzer`：零依赖文本/结构层（页数、图片对象、FlateDecode+Tj/TJ 文本抽取、章节标题、引用标记密度、预览），extractionQuality 如实分级 good/partial/poor |
| 多模态扩展点 | ✅ 接口就绪 / ⏳ 受环境约束 | `MultimodalAnalyzer` 接口 + `AgentMultimodalAnalyzer`（消息内本地路径 → OpenClaw agent 内置 pdf 工具；agent RPC 附件仅支持 image/*，PDF 会被网关拒绝，见 D-0017）；能力不可用返回明确 capability-gap，不伪造成功 |
| Section-based 手稿 | ✅ 完成 | outline.json（校验：≥3 节、文件名白名单、id 唯一）；章节正文片段校验（拒绝文档骨架/花括号失衡/空输出）；`main.tex` 由确定性代码 `\input` 组装（不交给 LLM）；references.bib 确定性生成 |
| Derived Context | ✅ 完成 | `context.yaml`（大纲摘要/章节状态/Evidence 统计），可随时删除重建（测试验证内容等价）；`GET /context?rebuild=true` |

## M3.2 — Review & Revision（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| Reviewer | ✅ 完成 | 单 Agent 三 skill：fact（claims ↔ Evidence：SUPPORTED/PARTIALLY/UNSUPPORTED/CONTRADICTED）、academic（五维评分+总分）、style（riskScore 0-100）；统一 ReviewIssue（category/severity/section/description/evidenceRef/suggestedAction/blocking） |
| contextScope 隔离 | ✅ 完成 | review/fact、review/academic、review/style 三个独立会话（派生 key 隔离有专项测试） |
| 并行 fan-out | ✅ 完成 | `Promise.all` 三路并行（各自独立 Gateway 连接）；无 dangling 连接/定时器（进程干净退出） |
| Review aggregation | ✅ 完成 | 确定性聚合：完全相同 issue 去重、severity/category/blocking 计数、academic/style/fact-verdict 汇总、unsupportedCriticalClaims；无 LLM 参与聚合 |
| bounded revision loop | ✅ 完成 | 默认最多 2 轮自动修订（`WORKFLOW_MAX_REVISION_ROUNDS`）；引用核验问题（missing key）也进入修订指令（Writer 删除/修正，不允许新造文献）；编译失败带错误上下文修订；超限 → HITL（accept_draft / revise_more ≤3 轮人工追加 / cancel） |
| Build Gate | ✅ 完成 | 编译结果 + include 文件存在 + bib 可用；只判「能否构建」，质量语义永不进入（D-0015）；`POST /api/projects/:id/build` |
| Quality Gate | ✅ 完成 | 9 条确定性规则（hallucinated 引用、引用结构、矛盾证据、无支撑关键论断、blocking、open critical/major、academic ≥80、style ≤35、目标可行性 HIGH/MEDIUM）；报告落盘 + quality_gate.* 事件；`POST /api/projects/:id/quality-gate` |
| Draft/Final 规则 | ✅ 完成 | Draft = Build Gate 通过即可（Quality 失败仍构建 Draft PDF，测试验证）；Final = 双 Gate 通过；completion.label 如实记录 |
| Existing-LaTeX 导入 | ✅ 完成 MVP | 零依赖 ZIP 读取器（stored/deflate；拒绝 `..`/绝对路径/反斜杠/盘符；单文件 20MB、条目数上限）；结构识别（入口 \documentclass 探测、章节、bib、图表）；原始快照 `workflow/imports/<ts>/`；Baseline Compile best-effort 记录（失败不是导入错误）；`POST/GET /api/projects/:id/import`（archiveBase64 或 files JSON） |
| Existing-Paper workflow | ✅ 完成 | 导入校验（未导入 fail-fast）→ baseline → 论文理解 → 引用审计 → 审稿 → 目标评估 → 改进计划 → HITL（approve/revise ≤3）→ 逐节改造 → 共享后段 |

## M3 API 一览（实际实现）

> Workflow API（`POST /api/projects/:id/workflows` + `/api/runs/*`）是**主入口**；
> 下列 review / citation-check / build / quality-gate 等细粒度端点是调试 / 手动操作 /
> 工具 API，前端（M4）不自行串联它们——编排由 WorkflowOrchestrator 在后端完成。

```text
GET    /health                                    存活探针（含 Gateway 实时健康）
GET    /api/runtime/status                        Runtime 诊断（gateway/runtime/agents/model；M3.5）
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

- **280 个测试全部通过**（vitest；M1/M2/M2.1 原有 79 个 + M3 业务 136 个 + M3.5 新增 39 个 + M3.6 新增 1 个 + **M3.7 新增 25 个**：PiRuntimeAdapter Level 1 fake session 16 个 + 角色映射 2 个 + Level 2 真实 SDK × 官方 faux provider 7 个）：
  M3.7 新增覆盖——Pi Runtime（provider 标识/懒初始化/healthCheck、runAgent 成功·transcript error·前置拒绝·空任务·关闭后、模型未配置结构化失败、SDK 初始化失败、timeout→AgentTimeoutError+abort、cancelTask 取消/幂等/完结后报错、事件回放顺序与归属、session 复用（含显式 sessionKey 透传）、project/contextScope 隔离、per-session 串行、路径越界拒绝、getTask/close·dispose、并发同 key 会话创建去重）；角色映射（scope 前缀→角色、工具白名单最小必要）；真实 SDK 集成（初始化/健康/单轮、systemPromptOverride 到达 LLM 上下文、真实事件链、Reviewer 三路并发独立会话不串、**LLM 流中 abort→cancelled 且会话可复用**、模型解析失败、provider 无凭据）。
  M3.5 新增覆盖——Runtime Bootstrap（路径隔离/嵌套拒绝/相对路径拒绝、runtime.json
  读取/生成/校验/env 覆盖不落盘、token 脱敏、最小 openclaw.json 不覆盖用户配置、
  安装版本漂移拒绝、子进程环境注入与 OPENCLAW_PROFILE 剔除、健康等待成功/重试/超时）、
  DevSupervisor（fake 进程：启动序列/提前退出/外部 shutdown 不误报崩溃/幂等；
  真实 node 子进程：bootstrap→health→shutdown→无孤儿）、Runtime 诊断（healthy/
  unavailable/auth_error/protocol_mismatch/model_not_configured/映射 missing、
  HTTP 200 与 503）、版本锚点防漂移（三处 pin 一致、禁止 `^~latest`、agent 默认 main）。
- `npm run typecheck`、`npm run build` 通过（backend 与根入口均验证）；无 lint 脚本（package.json 未定义）。
- 测试策略：编排引擎与业务服务为真实实现，仅 AgentRuntime 注入脚本化 fake
  （按 contextScope 返回结构化输出）；LaTeX 编译注入 fake runner；metadata provider 注入 fake fetch；
  Bootstrap 注入 fake IO/fetch/ProcessRunner（单测不联网、不装 npm 包），另有一条真实子进程生命周期测试。

## 非阻塞环境验证项（Non-blocking Validation Gaps）

以下为**环境验证缺口，不是设计决策，不阻塞代码交付**：

1. **带真实模型凭据的完整 Idea-to-Paper E2E**：M3.5 已在全新机器用 PaperTeam 独立 Gateway 真实验证：dev 启动、Gateway/Backend 健康、`agents.list`/`models.authStatus` 诊断、workflow 真实推进到 `research.idea` 并经真实 RPC（agent/agent.wait）返回网关权威错误、重试与 failed 终态、SSE replay（见「M3.5 真实环境验证」）。**尚未验证**：有模型凭据时的 LLM 输出质量与全链路产物（Feasibility/Outline/分节写作/审稿/双 Gate）。配置方法：把 provider API Key 写入 `~/.paperteam/runtime/openclaw/.env` 后重启 `npm run dev`。
2. **TeX Live 真实编译**：本机未安装 pdflatex/xelatex/latexmk；LatexCompiler 与 Build Gate 的编译路径经注入式 runner 覆盖，真实 PDF 编译待有 TeX 环境的机器验证。
3. **多模态 PDF 视觉级分析 E2E**：`AgentMultimodalAnalyzer` 依赖 Gateway 在线 + 具备视觉/PDF 能力的模型 + Agent 沙箱可读 PROJECTS_ROOT，当前环境无法真实跑通（返回 capability-gap 如实报告，不伪造成功）。
4. **Citation metadata providers 真实网络**：CrossRef/OpenAlex/arXiv 的真实网络路径在测试中以注入 fetch 覆盖（超时/5xx/网络故障 → unverifiable 的分支）；真实限流与响应形态待部署环境观察。
5. **Gateway 版本上报**：**已针对 2026.9.1 重新查证（2026-09-04，源码级）**：`gateway.identity.get` 响应仍只有 `{deviceId, publicKey}`，不含任何版本字段；新增的 `system.info` RPC 返回机器 / Node / 端口等系统信息，同样不含 OpenClaw 自身版本。`/api/runtime/status` 的 `versions.gatewayRuntime` 因此继续缺省；版本一致性仍由 Bootstrap 启动时的本地安装精确校验保证（漂移拒绝启动）。

## M3 遗留问题（真实问题，均不阻塞验收）

1. `getTask / cancelTask / streamEvents / sendMessage` 在 **OpenClawRuntimeAdapter** 仍为 `RuntimeCapabilityError` 占位（M3 的进度与事件经编排层 Domain Event 实现，未依赖 Runtime 事件流）。**M3.7 起 PiRuntimeAdapter 已实现前三者**（getTask 有限回溯 / cancelTask 真实 abort / streamEvents 事件回放；sendMessage 两端均为占位，HITL 走 Workflow resume）——但受 AgentRuntime Contract v1 的 runAgent 同步终态语义限制（taskId 在返回后才可知），运行中取消/订阅对上层仍不可达，listActiveTasks() 诊断口是其最小形态，正式暴露属 Contract v2（M4 前）。
2. 每次 runAgent 一条 Gateway 连接（M2.1 语义，OpenClaw 路径）；M3.2 三路 review 并行时瞬时 3 条连接，测试观察无残留；在没有真实并发性能证据前不做连接池。（Pi 路径无此问题：in-process、无连接。）
3. EvidenceStore 的 update/markUsage 是全量原子重写（规模内可接受）；索引/数据库迁移条件仍按未决问题 2 评估。
4. 修订循环对「需要改 bib 本身」的引用问题只能删除/弱化引用，不会替用户新造文献条目（有意为之：防伪造引用）；补文献属于 Researcher/用户输入路径。
5. Outline HITL 当前仍为强制节点（PRD 标记 Outline 确认为可选）；当前实现两处 HITL（feasibility/outline）都必经，计划 M4 前端 / Workflow 配置化处理。
6. Windows 下若 `npm run dev` 的父进程被外部硬杀（非控制台 Ctrl+C），子进程可能残留；正常 Ctrl+C 已验证无孤儿（M3.5 交互式 E2E；M3.6 在无头环境以子进程退出触发的同一关闭路径复验），硬杀场景的恢复手段是 `taskkill /PID <dev pid> /T /F`（POSIX 无此问题，进程组信号直达）。Pi 路径（M3.7 实测）无任何子进程，硬杀 Backend 即全部回收，不存在该问题。

## 未决设计问题

1. documentType / targetProfile 建议值集合的前端呈现（存储层保持自由字符串，不冻结）。
2. EvidenceStore 索引与 SQLite 迁移条件（同前）。
3. M4+ 前端技术栈、Docker/compose、TeX Live 镜像体积控制。

## 历史

- **M3.6 Runtime Baseline Upgrade**：OpenClaw 全家桶 2026.8.2 → **2026.9.1**（stable 大版本，protocol v4 不变，无 breaking change、无需 SDK 适配）；Node 兼容检查收敛到根 package.json engines（Node 26+ 可用）；runtime.json 存量版本自动迁移；255 测试 + 真机 Gateway E2E 回归；**2026.9.1 固化为 M4 Runtime baseline**（Node.js + npm，不引入 Bun）。
- **M3.5 Runtime Bootstrap / M3 Closure**：OpenClaw 全家桶升级 2026.8.2（兼容补丁，protocol v4 不变）、独立 Runtime state（`~/.paperteam`）、`npm run dev` 一键启动、Agent 映射方案 A（D-0018）、`GET /api/runtime/status`、优雅关闭与无孤儿验证、254 测试。
- **M2.1 OpenClaw 2.0 Runtime Upgrade**：官方 `@openclaw/gateway-client/protocol`（2026.8.1 → M3.5 升至 2026.8.2 → M3.6 升至 2026.9.1，protocol v4）、Project↔Session 隔离与 runtimeSessionKey 持久化（详见 git history 与 README）。
- **M2 Agent Invocation + Project + LaTeX**：runAgent 真实调用链、ProjectStore、WriterService、GenerationService、LatexCompiler、HTTP API。
- **M1 Backend Runtime Skeleton**：工程骨架、AgentRuntime 抽象、OpenClawRuntimeAdapter、Gateway 健康检查。
- **Architecture Research & Product Design Refresh**：竞品调研与产品/架构方向冻结（D-0008~D-0015）。
