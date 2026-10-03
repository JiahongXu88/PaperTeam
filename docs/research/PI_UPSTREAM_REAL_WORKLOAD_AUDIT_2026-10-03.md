# Pi Upstream Real-Workload Audit

日期：2026-10-03（夜间专项）　审计人：Claude（GLM-5.3）　性质：Real Workload + Runtime Reliability Audit + Upstream Bug Triage

---

## 1. Executive Summary

利用 PaperTeam 真实工作负载（M11.2/M11.2.1 Survey E2E 的 222 个 agent 任务、352 次 model turn、约 2.5 小时 wall time，全部跑在 `zai-coding-cn/glm-5.3` 生产 provider 上）对 Pi Runtime/SDK 做上游问题专项审计。

| 分类 | 数量 | 条目 |
|---|---|---|
| A. CONFIRMED_PI_UPSTREAM_BUG | **0** | — |
| B. LIKELY_PI_BUG_NEEDS_MORE_EVIDENCE | 0 | — |
| C. ALREADY_KNOWN_UPSTREAM | 0 | （本轮未发现命中已有 open issue 的未修问题） |
| D. FIXED_UPSTREAM | **3 组** | F-1（Z.AI CN overflow 误判，#9805+#10208）、F-2（retry 行为缺陷，#9571/#10278/退避上限）、F-3（error retry 废弃 attempt 残留 context） |
| E. PAPERTEAM_INTEGRATION_BUG | 1（已修） | F-8（resume 竞态，M10.4.0 已修复，历史归档） |
| F. PROVIDER_SPECIFIC | 1 | F-5（900s 0-activity 挂起，provider 侧静默） |
| G. EXPECTED_PI_BEHAVIOR | 1 | F-4（流中断 → auto-retry 成功恢复） |
| H. ENVIRONMENTAL | 1 | F-7（openai SDK 默认 fetch 的代理行为差异，仅影响本地 fake provider 开发） |
| I. INCONCLUSIVE | 1 | F-6（工具期 abort → stopReason="error" 的历史观察） |

**结论：本轮没有值得向 Pi upstream 提交的新 Issue（No issue is ready to file）。**
真实生产负载下 Pi 0.84.4 运行面健康；发现的全部 Pi 相关缺陷均属「upstream 已修复、PaperTeam pinned 版本未含」——可行动产出是一份升级建议（0.84.4 → ≥0.99.2，理想 1.0.1）而非新 Issue。

---

## 2. PaperTeam Pi Integration

### 2.1 Inventory（以 package metadata 与真实源码为准）

| 项 | 值 |
|---|---|
| npm package | `@earendil-works/pi-coding-agent`（dependencies，精确 pin）+ `@earendil-works/pi-ai`（devDependencies，精确 pin） |
| 版本 | 双双 `0.84.4`（`backend/package.json`；`backend/src/runtime/pi/version.ts` 同步锁定 `PI_RUNTIME_VERSION="0.84.4"`） |
| 安装实测 | node_modules 内 pi-ai / pi-coding-agent / pi-telemetry 均为 0.84.4（pi-agent-core 等经 `^0.84.4` 传递，0.x 语义下锁定 0.84.x，无漂移） |
| upstream | `github.com/earendil-works/pi`（monorepo；package.json `repository.directory`: `packages/coding-agent` / `packages/ai`） |
| 集成形态 | **in-process SDK**（`createAgentSession` 直调；非 RPC / 非 CLI / 非 coding-agent 子进程） |
| upstream 最新 | main = v1.0.1（2026-10-03 发布）；v0.84.4 tag 存在（b79e4cc8） |

### 2.2 实际使用的 Pi API 面（backend/src 全量 import 盘点）

所有 import 收口于 `@earendil-works/pi-coding-agent` 单一入口（无 pi-ai 直连 import）：

- `createAgentSession({cwd, agentDir, model, modelRuntime, resourceLoader, sessionManager, settingsManager, tools, customTools})`（`runtime/PiRuntimeAdapter.ts`）
- `session.prompt(text, {expandPromptTemplates:false})` / `abort()` / `waitForIdle()` / `dispose()` / `subscribe()` / `getLastAssistantText()` / `getContextUsage()`（duck-typing 兜底）
- `DefaultResourceLoader`（`systemPromptOverride` / `noSkills` / `additionalSkillPaths`）
- `ModelRuntime.create({authPath, modelsPath})` / `getModel` / `hasConfiguredAuth` / `setRuntimeApiKey` / `getError`
- `SessionManager.inMemory` / `SettingsManager.inMemory({compaction:{enabled:false}})`（auto-compaction 关闭）
- `defineTool` / `ToolDefinition`（scholarly / evidence / retrieval 自定义工具）
- 事件消费：`message_start/update/end`、`tool_execution_start/update/end`、`agent_start/agent_settled/agent_end(willRetry)`、`turn_start/turn_end`
- usage 消费：`message_end` 事件上的 `message.usage`（input/output/cacheRead/cacheWrite/totalTokens/cost.total）

架构：`PaperTeam Backend ─in-process→ pi-coding-agent SDK → LLM/Tools`；Pi 细节全部封装在 `runtime/PiRuntimeAdapter.ts`（+ `runtime/pi/` 内部模块），PaperTeam 自建 per-session FIFO、全局并发 permit、分层超时、first-activity watchdog、session rotation/GC、context budget preflight。

### 2.3 Upstream 约定遵守情况

- 已读 upstream `AGENTS.md` / `CONTRIBUTING.md` / 三包 CHANGELOG（agent / coding-agent / ai）
- issue 规范：`pkg:*` 标签（`pkg:agent` / `pkg:ai` / `pkg:coding-agent` / `pkg:tui`）、简洁技术文体、无 emoji
- 本轮未在 upstream 执行任何写操作（无 commit / push / issue / PR）；upstream clone 仅置于 `D:\Tmp\paperteam-pi-upstream-audit`（git worktree 双版本对比）

---

## 3. Audit Workload

**未新烧任何模型预算。** 依据任务规则（优先复用已有真实数据；新 workload ≤1 且仅在既有数据不满足时），既有 M11.2/M11.2.1 数据已覆盖全部要求的观测维度，故本轮 **0 个新增真实 workload**。

### 3.1 复用的真实运行（e2e/.tmp/m1112-survey-e2e/projects/p-6de7674cd29e）

| run | wall | agent tasks | model turns | stage 构成 | 异常 |
|---|---|---|---|---|---|
| w-77b37c95a677（M11.2 survey E2E） | 6,839s（114 min） | 206 | 280 | research.plan 1 / survey.matrix 4 / survey.synthesis 166 / survey.outline 1 / writing.sections 12 / review.run 9 / revision.revise 13 | 1 个 provider error turn（见 F-4） |
| w-ebc55bf49857（M11.2.1 run3 验收） | 1,989s（33 min） | 16 | 72 | research.plan 1 / review.run 6 / revision.revise 9 | 1 个 `read` 工具失败（读不存在文件，良性） |

- 模型：`zai-coding-cn/glm-5.3`（open.bigmodel.cn coding 端点，openai-completions API 族）
- stopReason 分布（280 turns）：stop 206 / toolUse 73 / **error 1**
- 长生成：单 turn 最大 393s；长上下文：单任务 inputTokens 峰值 168,215（206 任务会话链上 context 持续增长可见）
- retry：1 次 session 级 auto-retry（`auto_retry` attempt=1 error="Stream ended without finish_reason" → `auto_retry_end success=true`，约 37s 后恢复）
- usage 一致性：206/206 任务携带完整 usage（零缺失、零全零）；cacheRead 206/206 生效（累计 16.5M cacheRead vs 1.2M raw input）
- compaction：关闭（PaperTeam 侧配置）；rotation/GC：运行期无异常触发

### 3.2 观测手段

PaperTeam 既有 observability（M10.4.0 trace：`agent.task` / `model.turn` / `tool.call` span + usage 属性 + auto_retry 事件）+ run-trace.json 逐 span 分析（脚本只读，不落盘额外数据）+ upstream 双版本源码静态对比（v0.84.4 worktree vs main）+ 独立最小复现环境（`D:\Tmp\paperteam-pi-upstream-audit\repro-abort-stopreason\`，本地 SSE server + npm 安装的 0.84.4）。

---

## 4. Historical Signal Review

| 历史 PaperTeam 现象 | 出处 | 本轮归因 |
|---|---|---|
| provider 0-activity 挂起（白等 ~900s，plan.improvement 一次） | M10.4.1 | **F（PROVIDER_SPECIFIC）**：卡在请求发出后、任何流事件之前，provider 侧静默不可观测；Pi auto-retry 只由 provider 错误事件触发（设计如此）。PaperTeam 的 FIRST_ACTIVITY_TIMEOUT watchdog（M10.4.4）是正确兜底。Pi 无首 token 超时 → Enhancement 候选（附录） |
| `resume()` 竞态死锁 | M10.4.0 | **E（PAPERTEAM_INTEGRATION_BUG）**：WorkflowOrchestrator 旧执行循环与 resume 的窗口竞态，M10.4.0 已修（`await handle.loop`），非 Pi |
| 工具执行中 abort → 终态 `stopReason="error" + "This operation was aborted"` | D-0019 / PiRuntimeAdapter 注释（M5.x 实测） | **I（INCONCLUSIVE）**，见 F-6 |
| FACT_PRESERVATION 振荡 / 修订失败 | M10.3–M11.2.1 | 模型行为，与 Pi 无关（多轮已定论） |
| "Stream ended without finish_reason" | M11.2 trace（本轮分析） | **G（EXPECTED）**：provider 流中断，Pi 分层正确 + auto-retry 成功恢复，见 F-4 |
| arXiv 检索 "This operation was aborted" | M9.10 / m976 citation-report | 工具层 fetch abort（检索超时取消），非 assistant 终态问题 |
| Writer 长调用 p95 224s / max 459s | M10.4.0 | 合法长生成，非异常 |
| dispatch 覆盖缺口 / sectionMatches 偶然命中 | M10.4.3/.4.4 | PaperTeam 派发逻辑缺陷（已修），非 Pi |

---

## 5. Findings

### F-1：Z.AI CN 上下文溢出错误不被识别（PaperTeam pinned 版本）【D. FIXED_UPSTREAM】

- **症状**：Z.AI CN 端点（open.bigmodel.cn，PaperTeam 生产 provider）真溢出时返回 `400 {"code":"1261","message":"Prompt exceeds max length"}`；0.84.4 的 `isContextOverflow()`（`packages/ai/src/utils/overflow.ts`）正则集不含该格式 → 判为普通 provider error。
- **影响链**（0.84.4 源码级确认，`packages/coding-agent/src/core/agent-session.ts`）：
  - `_isRetryableError()`：overflow 应走 compaction 恢复而非 retry——误判后该分流失效（好在 code 1261 的 400 也不匹配 retryable 模式，最终仍以 error 终态，不产生无效重试循环）；
  - `_checkAutoCompaction` Case 1（remove-last + compact + retry once）整条恢复路径对该 provider 不可达。PaperTeam 侧因 compaction 关闭 + 自有 CONTEXT_BUDGET preflight（估算拒绝）通常前置拦截，实际风险被双层弱化，但「measured 基准回写后估算偏差」窗口内真实溢出会发生且得不到正确分类。
- **upstream 修复**（两跳）：#9805（0.86.1，`0e283203c fix(ai): detect z.ai prompt-too-long errors`，补 "Prompt too long"）仍漏 CN 变体 → #10208（0.99.2，`3dd803d7e fix(ai): detect Z.AI CN endpoint context overflow errors`，补 code 1261，**带回归测试** `overflow.test.ts`）。
- **证据**：main `overflow.ts:30` 注释明列 z.ai 三种格式；fix commit diff + regression test 逐行核验。

### F-2：provider retry 行为缺陷三件套（PaperTeam pinned 版本）【D. FIXED_UPSTREAM】

1. **#9571**（0.99.2 修）：`Retry-After` 头含不可解析日期时 retry 立即发射（无退避）→ 现改为指数退避。PaperTeam 场景（长会话 + 高频请求）下 provider 限流时的重试风暴风险。
2. **c37b0e03b `fix: cap agent retry backoff`**（0.87.0 前修）：agent retry 退避无上限 → 持续错误下退避可增长到不合理的等待。PaperTeam 有 stage deadline 兜底，影响有限。
3. **#10278**（1.0.1 修）："Selected model is at capacity" provider 错误直接终结 turn 而非 retry。该错误文本为 Anthropic 系；zai-coding-cn 的容量类错误文本未实测（本轮 352 turn 未遇容量错误），对 PaperTeam 的直接适用性存疑但同族缺陷。

### F-3：error retry 后废弃 attempt 残留后续 provider context【D. FIXED_UPSTREAM】

- 0.87.0 coding-agent CHANGELOG："Fixed selected error retries and final length/overflow recovery retaining abandoned model attempts in future provider context"。
- **PaperTeam 关联**：M11.2 真实 run 恰有 1 次 auto-retry（F-4 场景）。在 0.84.4 上，被放弃的半成品 assistant 消息可能留在后续请求上下文里（幽灵 partial）。本轮观测到该 run 后续 206 任务正常完成，无可见异常（ghost message 对 openai-completions 转换是可容忍的），但属真实已修缺陷，升级即消除。

### F-4：流中断 → auto-retry 成功恢复【G. EXPECTED_PI_BEHAVIOR】

M11.2 真实 trace：review.run 阶段 1 个 turn `stopReason=error`、全零 usage、TTFB 1574ms——provider 流启动后无 finish_reason 断流。Pi 分层正确：`openai-completions` 抛 "Stream ended without finish_reason" → session 级 auto-retry（attempt 1）→ 约 37s 后成功，run 最终 completed。**Pi 按设计工作，无缺陷。** 附带观察：error turn 的 usage 全零 → PaperTeam 的 `accumulateRunUsage` 对 failed turn 也 `assistantTurns+1`（计数含失败 turn），属 PaperTeam 口径选择而非 Pi 问题（§11 P-3）。

### F-5：900s 0-activity provider 挂起【F. PROVIDER_SPECIFIC】

M10.4.1 单次实测（详见 §4）。卡点在 provider 请求发出后、任何 assistant 流事件之前，厂商侧内部原因不可观测。Pi 无错可拾 → 不触发 auto-retry（设计如此，`auto_retry` 仅由 provider 错误事件驱动）。PaperTeam 的 FIRST_ACTIVITY_TIMEOUT（180s）+ stage retry 是正确且足够的兜底。**不是 Pi bug**；Pi 层缺 TTFB 超时是 Enhancement 候选（附录 A-1）。

### F-6：工具期 abort → `stopReason="error"`（历史观察，无法定论）【I. INCONCLUSIVE】

- **观察**（D-0019，M5.x 一次实测）：abort 发生在工具执行期时，终态 assistant 消息为 `stopReason="error" + errorMessage="This operation was aborted"`（DOMException 文本），而非 LLM 流中断时的 `"aborted"`。
- **源码追踪**（0.84.4 与 main 双版本）：runLoop 在工具期 abort 后仍推进到下一次 `streamAssistantResponse`；transport 层（openai-completions catch）按 `options?.signal?.aborted` 归类，理论上应给 `"aborted"`——与实测矛盾，说明历史实例走了某条 signal 已 abort 但归类为 error 的路径（确切机制未定位）。
- **upstream 测试盲区**：`packages/agent/test/e2e.test.ts:125` 只断言流中 abort → `"aborted"`；**工具期 abort 的终态 stopReason 无任何测试覆盖**（0.84.4 与 main 皆然）。
- **文档**：sdk.md 对 `abort()` 仅写 "Abort current operation"，未承诺各阶段 stopReason 编码 → 不构成契约违背。
- **本轮复现尝试**：本地 SSE server + 0.84.4 SDK 的 harness 因 openai SDK 连接池/本地环境交互产生伪影（挂起无法归因于 Pi），faux provider 路径又因包 exports 限制无法从 SDK 消费侧直调。**诚实结论：证据不足，不提交。** PaperTeam 现有 workaround（以 `cancelRequested` 意图归因，不信 stopReason）正确且必须保留。

### F-7：openai SDK 默认 fetch 与 pi-ai 代理层行为不一致【H. ENVIRONMENTAL】

pi-ai 自带代理层（`node-http-proxy.ts`，尊重 NO_PROXY）仅接入 Bedrock 流；openai-completions 走 openai SDK 默认 fetch。本机代理环境（HTTP_PROXY=127.0.0.1:7890）下 SDK 请求 127.0.0.1 本地端点被代理拦截 403（NO_PROXY 未生效于该层）。**非 Pi 缺陷**（Pi 未接管该 fetch），但对「本地 fake provider 开发/测试」有实操影响（需 `env -u HTTP_PROXY -u HTTPS_PROXY`）。记入报告供 PaperTeam e2e 环境参考。

### F-8：resume() 竞态死锁【E. PAPERTEAM_INTEGRATION_BUG（已修）】

M10.4.0 定位并修复（`WorkflowOrchestrator.resume()` 先 `await handle.loop`）。历史归档项，佐证「PaperTeam 保护机制 ≠ Pi bug」的归因纪律。

---

## 6. Confirmed Upstream Candidates

**None.**

本轮没有任何问题满足 A 类标准（Pi 契约违背 + 可脱离 PaperTeam 最小复现 + pinned 可复现 + main 仍存在 + 非重复）。不硬凑。

## 7. Minimal Reproductions

无 confirmed candidate → 按 任务§22 规则**不创建** `docs/research/repros/` 目录。

审计期在 PaperTeam 之外（`D:\Tmp\paperteam-pi-upstream-audit\repro-abort-stopreason\`）搭建过复现环境：

- `server.mjs`：本地 OpenAI 兼容 SSE server（TOOL/SLOW/OK 三模式，零成本确定性；独立 node fetch 验证 34ms 出首 chunk，server 本身正确）
- `repro.mjs`：0.84.4 SDK + models.json 本地 provider，三场景（baseline / 流中 abort / 工具期 abort）
- 结果：baseline 场景完整通过（`stopReason=stop`、事件序列干净 `agent_start > turn_start > message_start(user) > … > agent_settled`）；abort 场景因 F-7 所述代理交互 + openai SDK 连接池伪影不可信，未获得可归因于 Pi 的复现 → 按「不能假装 deterministic」纪律不作为证据
- 该目录保留在 D:\Tmp（审计工作区），不进 PaperTeam 仓库

## 8. Upstream Duplicate / PR Check

对本轮全部 candidate（实为 D 类）核对 upstream issue/PR/commit/CHANGELOG：

| 项 | 核对结果 |
|---|---|
| Z.AI overflow（F-1） | #9805（open，0.86.1 修复关闭）+ #10208（open，0.99.2 修复关闭，`fixes #10208` commit 3dd803d7e + 回归测试）——**known/fixed，非 duplicate 可提** |
| Retry-After 立即重试 | #9571，0.99.2 Fixed 条目——known/fixed |
| capacity 错误终结 turn | #10278，1.0.1 Fixed——known/fixed |
| retry 废弃 attempt 残留 | 0.87.0 changelog Fixed（无独立 issue 号，随 canonical session context 边界重构修复）——known/fixed |
| retry 退避无上限 | commit c37b0e03b——known/fixed |
| 工具期 abort stopReason（F-6） | 搜索 upstream open/closed issue 与测试：无等价 issue；无测试覆盖；文档无承诺 → 若未来复现成功，将是**新** issue（潜在标题域：`pkg:coding-agent`/`pkg:agent` abort terminal-state contract），本轮不满足提交标准 |

## 9. Source Root Cause Analysis

- **F-1 root cause（confirmed，upstream 已定位）**：`packages/ai/src/utils/overflow.ts` 的错误文本正则集未覆盖 Z.AI CN 的 `code 1261` JSON 载荷；两跳修复（0.86.1 补 z.ai 通用文案、0.99.2 补 CN 变体）+ 回归测试。触发条件：请求 token 超窗且 provider 返回 1261。预期：`isContextOverflow=true` → compaction 恢复路径；0.84.4 实际：false → 普通错误路径。
- **F-3 root cause（confirmed，upstream 0.87.0 修复）**：error retry / overflow 恢复后，被放弃的 model attempt 消息未从后续 provider context 剔除（原始 transcript 保历史是对的，但「重试上下文排除」逻辑在该版本有缺口）。
- **F-6 root cause（hypothesis only）**：推测历史实例中 abort 在「请求间隙」触发，DOMException 由某层（openai SDK 内部 controller / 工具 signal 传播）产生并绕过了 transport 层按 `signal.aborted` 归类的 catch 路径，最终落入 `handleRunFailure(error, aborted=false)` → `"error"`。**未经证实，明确标注为假设。**

## 10. Ready-to-submit Issue Drafts

**No issue is ready to file.**

（依据：无 A/B 类 candidate；F-6 复现不足；其余全部 already-known/fixed。若作者希望，F-6 可在未来以「补充实验」方式重开——见 §13。）

## 11. PaperTeam-side Findings（本轮不修改，仅登记）

| # | 发现 | 位置 | 建议 |
|---|---|---|---|
| P-1 | `accumulateRunUsage` 对 error/aborted turn 也计 `assistantTurns+1` | `PiRuntimeAdapter.ts` accumulateRunUsage | 口径选择问题（turn 计数含失败尝试）；如需「有效 turn」统计可在 message_end 判断 stopReason，非必须 |
| P-2 | abort 终态归因依赖 `cancelRequested` 而非 SDK stopReason（F-6 workaround） | `PiRuntimeAdapter.ts` runOnSession | **保留**。若未来升级 Pi 且 F-6 得到复现澄清，再评估是否可简化 |
| P-3 | 本地 fake-provider 开发/e2e 需剥离代理变量（F-7） | e2e 环境文档 | 可在 doctor 脚本或 e2e README 加一行提示（`env -u HTTP_PROXY -u HTTPS_PROXY`），非必须 |
| P-4 | Pi 版本 5 个 release 落后（0.84.4 → 1.0.1），生产 provider 相关修复未享受 | `backend/package.json` | 见 §12 升级建议 |

## 12. Upgrade Opportunities

**建议目标：`@earendil-works/pi-coding-agent` + `pi-ai` 0.84.4 → 1.0.1**（至少 ≥0.99.2 以获得 #10208）。

### 升级收益（PaperTeam 直接相关）

| 修复 | 版本 | 对 PaperTeam 价值 |
|---|---|---|
| #9805 + #10208 Z.AI overflow 识别 | 0.86.1 / 0.99.2 | 生产 provider 溢出正确分类（F-1） |
| retry 废弃 attempt 不残留 context | 0.87.0 | 消除 ghost partial（F-3） |
| retry 退避上限 | ~0.87.0 | 限流场景重试风暴防护 |
| #9571 Retry-After 指数退避 | 0.99.2 | 同上 |
| #10278 capacity 错误重试 | 1.0.1 | provider 容量类错误韧性（同族） |
| 大量模型目录/定价/新 provider 更新 | 0.85–1.0.1 | 模型元数据新鲜度 |

### 兼容性评估（源码级核验）

- PaperTeam 使用的全部导出（`createAgentSession` / `ModelRuntime` / `SessionManager` / `SettingsManager` / `DefaultResourceLoader` / `defineTool`）在 main `packages/coding-agent/src/index.ts` **全部健在**（逐项 grep 核验）。
- 1.0.0 pi-agent-core 破坏性变更（harness/session storage 移除）**不触及** PaperTeam 消费面（PaperTeam 只用 coding-agent SDK 层）。
- 需要回归验证的行为变更：0.87.0 起 `SessionManager` 成为 provider context 的 canonical 源（`session.agent.state.messages` 直改不再生效）——PaperTeam **只读** 该字段（lastAssistantMessage / context 估算），不直改，理论无影响，但需测试确认；0.87.0 `shouldStopAfterTurn` 移除（PaperTeam 未用）；turn_end/extension 事件形状扩展（PaperTeam 只消费白名单事件子集）。
- **升级验证路径建议**：`npm --prefix backend install` 精确 pin 1.0.1 → typecheck + vitest 全量（2212 用例，其中 PiRuntimeAdapter/firstActivityWatchdog/LongRunningGovernance 等套件即行为回归）→ 1 个真实 smoke（survey 或 revision 段）→ 观察 usage/事件序列 diff。风险等级：中低（无签名破坏，行为面变更集中在 PaperTeam 未用的区域）。

## 13. Recommended Next Action（逐 Finding）

| Finding | 建议 | 说明 |
|---|---|---|
| F-1/F-2/F-3（D 类） | **UPGRADE PI**（首选项） | 升级 0.84.4 → 1.0.1；这是本轮唯一强可行动项 |
| F-4（G） | NO ACTION | 按设计工作 |
| F-5（F） | MONITOR | watchdog 已兜底；单次事件不值得追 |
| F-6（I） | MONITOR（可选：补实验） | 保留 workaround；若愿意投入，可在升级 1.0.1 后以本地 server harness（修掉代理伪影）重试复现，成功且 main 复现再谈提 issue |
| F-7（H） | NO ACTION（可选 P-3 提示） | 环境项 |
| F-8（E，已修） | NO ACTION | 历史归档 |
| P-1/P-2/P-3 | NO ACTION / 可选 | 见 §11 |

**不建议本轮做**：FILE ISSUE（无合格 candidate）、PREPARE PR（非维护者身份且无确认缺陷）、FIX PAPERTEAM（无新缺陷）。

---

## 附录 A：Feature / Enhancement Candidates（非 Bug，仅记录）

1. **Pi agent 层无 TTFB / 首 token 超时**（F-5 相关）：SDK 消费者须自建 first-activity watchdog（PaperTeam M10.4.4 即为此造了一个）。若 Pi 在 AgentLoopConfig 提供可选 `firstTokenTimeoutMs`（默认关闭），嵌入式消费者可省一层自建。属 upstream 设计取舍（Pi 作为 coding CLI 由用户手动 Ctrl-C），不强求。
2. **工具期 abort 的终态 stopReason 无测试覆盖**（F-6 相关）：upstream 若补一条 e2e 断言（abort during tools → terminal stopReason 语义固化），对 SDK 消费者是纯收益。

## 附录 B：审计工作区与材料

- Upstream clone + worktree：`D:\Tmp\paperteam-pi-upstream-audit\pi`（main @ 4c6fb7cfe / v1.0.1）、`pi-0844`（v0.84.4 @ b79e4cc83）
- 复现环境：`D:\Tmp\paperteam-pi-upstream-audit\repro-abort-stopreason\`（server.mjs / repro.mjs / faux-repro.mjs；不进 PaperTeam 仓库）
- 真实负载数据：`e2e/.tmp/m1112-survey-e2e/projects/p-6de7674cd29e/workflow/runs/{w-77b37c95a677,w-ebc55bf49857}/run-trace.json`（未改动）
- 本轮对 PaperTeam 仓库的改动：仅本报告文件
