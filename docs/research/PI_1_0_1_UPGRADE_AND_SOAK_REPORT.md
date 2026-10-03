# Pi 1.0.1 Upgrade & Soak Report

日期：2026-10-03/04（夜间专项）　执行人：Claude（GLM-5.3）　性质：Runtime Upgrade + Full Regression + F-6 专项 + Soak + Case B 预验收

---

## 1. Git

| 项 | 值 |
|---|---|
| 起始状态 | `main` @ `f74abad`，clean，`HEAD == origin/main` |
| 升级基线 | 上一轮审计 `docs/research/PI_UPSTREAM_REAL_WORKLOAD_AUDIT_2026-10-03.md` |
| 分支策略 | 按任务书未建 work/backup 分支，直接在 main 执行 |
| 升级 commit | `f91ee41 chore(runtime): upgrade Pi SDK to 1.0.1`（已 push origin/main） |
| 报告 commit | 见 git log（本报告与 M11.3 报告随 docs commit 入库） |

## 2. Dependency Upgrade（0.84.4 → 1.0.1）

### 2.1 变更

- `backend/package.json`：`@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai` 双双精确 pin `0.84.4` → `1.0.1`（无 `^`/`~`/`latest`，与既有纪律一致）
- `backend/src/runtime/pi/version.ts`：`PI_RUNTIME_VERSION = "1.0.1"`，注释同步更新（内部包结构变化）

### 2.2 Resolved versions（npm ls 实测）

```
@earendil-works/pi-ai@1.0.1
  └─ @earendil-works/pi-telemetry@1.0.1
@earendil-works/pi-coding-agent@1.0.1
  ├─ @earendil-works/chord@1.0.1          [新增依赖]
  ├─ @earendil-works/pi-agent-core@1.0.1
  │    └─ pi-ai@1.0.1 deduped
  ├─ @earendil-works/pi-ai@1.0.1 deduped
  ├─ @earendil-works/pi-codemode@1.0.1    [新增依赖]
  ├─ @earendil-works/pi-mcp@1.0.1         [新增依赖]
  └─ @earendil-works/pi-tui@1.0.1
```

- **全树统一 1.0.1，无多版本**（0.84.4 时代的 `pi-client`/`pi-protocol` 已并入主包；新增 `chord`/`pi-codemode`/`pi-mcp` 三个同版本内部包）。无需 dedupe。

## 3. Compatibility Changes（升级引起的最小修改，全部为测试侧）

Pi 1.0.x 的三处 API/行为变化命中 PaperTeam 测试 fixture；**产品代码（PiRuntimeAdapter 等）零修改**：

| # | 变化 | PaperTeam 命中点 | 修复 |
|---|---|---|---|
| C-1 | tool `execute()` 的 context 参数类型 `ExtensionContext` → `ExtensionToolContext`（新增 `tools`/`executeTool` 嵌套工具执行面） | `test/evidence/anchoredPathActivation.test.ts`、`test/evidence/evidenceTools.test.ts` 的 `NOOP_CTX` 占位 | 类型替换（运行时仍传 `undefined`，被测工具只消费前两参） |
| C-2 | `TranscriptContext` 不再携带独立 `systemPrompt` 字段；system prompt 由 leading `SystemMessage`（`messages[0]`）携带，override 文本落在 `sections`（实测 `preamble`/`cwd`），`content` 可为空串 | `test/PiRuntimeAdapter.test.ts` systemPromptOverride 断言 | 提取函数改为拼接 leading SystemMessage 的 `content` + 全部 `sections` 值 |
| C-3 | 内置模型目录更新：`zai-coding-cn` 的 `glm-5.2` 已删除（现目录：glm-4.6v / glm-5.3 / glm-5.3-flash / glm-5.3-highspeed） | `test/settings/modelSettings.test.ts`、`test/settings/modelSettings.http.test.ts` 用 `glm-5.2` 作"第二模型" | 全部替换为 `glm-5.3-flash`；`runtimeVersion` 断言 `0.84.4`→`1.0.1` |

未命中产品代码的原因核对（逐项审计）：

- `createAgentSession` / `ModelRuntime` / `SessionManager.inMemory` / `SettingsManager.inMemory` / `DefaultResourceLoader` / `defineTool` / `ToolDefinition`：签名兼容（typecheck 证明）
- `session.prompt` / `abort` / `waitForIdle` / `dispose` / `subscribe` / `getLastAssistantText` / `getContextUsage`：1.0.1 dist 类型全部存在；`agent.state.messages` 仍可读（PaperTeam 只读、duck-typing 防御，无 mutate/append/restore —— 符合 0.87+ "SessionManager 为 provider context canonical source" 契约）
- 事件 `message_start/update/end`、`tool_execution_start/update/end`、`agent_start/agent_settled/agent_end(willRetry)`、`turn_start/turn_end`：全部健在（`agent-session.d.ts` 实测）

## 4. Tests

| 套件 | 结果 |
|---|---|
| backend typecheck | **PASS** |
| backend vitest 全量 | **PASS**：2234 passed / 15 skipped / **0 failed**（2249 总数；1 个文件级 teardown 失败 = 已知 `fullText.http` ENOTEMPTY flake，单独重跑通过，与升级无关） |
| frontend typecheck | **PASS** |
| frontend vitest 全量 | **PASS**：271/271 |

升级前基线 2212 用例 → 现总 2249（含 M11.2.1 新增用例），升级未造成任何产品行为测试失败。

## 5. Event Regression（本地 fake SSE server，Pi 1.0.1 实测）

正常 turn（fake provider 快速完成）事件链：

```
agent_start > turn_start > message_start(system) > message_end(system)
> message_start(user) > message_end(user)
> message_start(assistant) > message_update×N > message_end(assistant)
> turn_end(assistant) > agent_end(willRetry=false) > agent_settled
```

- **新事件**：`message_start/end(system)`（system prompt 以消息形态入 transcript，对应 C-2）；auto-retry 时新增 `auto_retry_start` / `auto_retry_end` / `entry_appended`
- PaperTeam 白名单消费不受影响：adapter 的未知事件走 `default: return undefined` 不映射；`agent_end.willRetry` 透传保留
- **abort（流式生成中）**：事件链 `… message_start(assistant) > [abort] message_end(assistant) > turn_end > agent_end > agent_settled`，`stopReason="aborted"`、`errorMessage="Request was aborted"`、`prompt()` 正常 resolve、会话可 dispose —— **语义正确，无回归**
- **timeout / dispose / session idle**：全部场景在 diag harness 内正常 settle（45s watchdog 未触发）

事件回归结论：**无丢失、无重复、无乱序、terminal 语义除 F-6（见 §8）外全部正确**。

## 6. Usage Regression

- fixture 级：`PiRuntimeAdapter.test.ts` 的 usage 采集套件（usage 多 turn / cacheRead / cost.total / accumulateRunUsage）全绿（§4 内含）
- 真实模型级：见 §9 smoke 的 usage 观测（input/output/cacheRead/cacheWrite/total/cost 全字段落 run-trace，`model.turn` span attributes 完整）
- 统计口径（error/aborted turn 是否计 assistantTurns）：**未改动，仅登记**（属统计口径决策，留作者裁决）

## 7. Retry / Overflow

### 7.1 Z.AI CN overflow（F-1 修复验证）

本地 fake server 返回 `400 {"code":"1261","message":"Prompt exceeds max length"}`（openai-completions 真实错误路径）：

```
pi=1.0.1
stopReason=error
errorMessage="400: {\"code\":\"1261\",\"message\":\"Prompt exceeds max length\"}"
isContextOverflow=true        ← 0.84.4 为 false（F-1 缺陷）
events=… > agent_end(willRetry=false) > agent_settled
```

**结论：1.0.1 正确进入 context overflow 语义，不重试（400 不可重试），F-1 修复在位。**（验证 PaperTeam 可观察行为，未复制 Pi 内部实现；证据脚本 `D:\Tmp\paperteam-pi-upstream-audit\repro-abort-stopreason\v1\diag-overflow.mjs`）

### 7.2 Transient retry（500×2 → 成功）

```
6.18s outcome=resolved requests=3 stopReason=stop
events=… agent_end(willRetry=true) > auto_retry_start > entry_appended > agent_start > …（×2）> agent_end(willRetry=false) > agent_settled
```

指数退避生效；恢复后正常完成；`willRetry=true` 的中间 `agent_end` 不构成终态（PaperTeam 以 `prompt()` resolve + waitForIdle 判终态，兼容）。

### 7.3 Retry exhausted（持续 500）

```
14.05s outcome=resolved requests=4 stopReason=error
agent_end(willRetry=true) ×3（每次后 auto_retry）> 最终 agent_end(willRetry=false) > agent_settled
```

4 次请求（1 + 3 retry）后按策略耗尽，终态 error，会话正常 settle。

### 7.4 三层重试互扰检查

- Pi auto-retry（上述）与 PaperTeam first-activity watchdog（180s）/ stage timeout 的层次：fake 测试中 retry 总时长（6~14s）远小于 watchdog 阈值，无 double-retry / 重复请求 / terminal race 观察
- 真实负载级验证由 §9/§10 soak 覆盖（retry 计数、请求计数、事件序）

## 8. Abort / F-6（专项结论：升级为 CONFIRMED_PI_UPSTREAM_BUG）

### 8.1 复现环境修复（上一轮 INCONCLUSIVE 的根因）

上一轮复现失败的两个环境因素，本轮全部排除：

1. **代理干扰**：`env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY …` 对 repro 进程显式清空（openai SDK fetch 不理 NO_PROXY，127.0.0.1 请求会走 7890 代理）
2. **fake server interval 失效**：后台挂起的 node server 在流式场景 `setInterval` 不触发（首 chunk 48ms 即达、0 后续 token）——导致上一轮「无 message_update → abort 未触发 → prompt 挂起」的假象。本轮改为**时间触发 abort**（不依赖事件），并保留事件触发变体作对照

### 8.2 稳定复现（1.0.1）

场景 B（工具执行期 abort，工具为 signal-aware sleep）：

```
+0.18s tool_execution_start:slow_tool
+1.69s session.abort()
+1.69s tool_execution_end > message(toolResult) > turn_end > turn_start
       > message_start(assistant) > message_end(assistant) > turn_end > agent_end > agent_settled
prompt() resolved
stopReason="error"  errorMessage="This operation was aborted"    ← 应为 "aborted"
```

- **9/9 稳定**（8 次主复现 + 1 次变体）
- **变体无关**：工具 reject(AbortError) 与工具正常返回两种行为，终态**相同**（都判 error）
- 对照场景 A（LLM 流式生成期 abort）：`stopReason="aborted"` 正确 —— **同一用户动作因 abort 落点阶段不同产生不同终态语义**
- 场景 C（正常完成）：`stopReason="stop"` 无回归

### 8.3 upstream main 复现

- upstream clone `D:\Tmp\paperteam-pi-upstream-audit\pi` fast-forward 至 `83692682f`（origin/main 最新，较 v1.0.1 仅 +1 Nix workflow commit）并全链构建
- 同一 diag 脚本经 workspace symlink 运行：**同样复现** `stopReason="error" errorMessage="This operation was aborted"`

### 8.4 Root Cause（源码级定位，dist 插桩实证）

完整因果链（每一步有日志/堆栈证据）：

1. 工具执行中 `session.abort()` → `agent.abort()` → `AbortController.abort()`（DOMException 在此刻同步创建，堆栈证实）
2. 工具中止（无论 reject 还是返回），agent loop break 出工具批，turn 1 正常结束
3. loop 启动 turn 2 的模型请求：`Models.stream()` → **`lazyStream(model, async setup)`**（`packages/ai/src/api/lazy.ts`）
4. setup 链中某 await 以该 DOMException reject（插桩 `[PI-DIAG6] lazyStream setup FAILED: AbortError This operation was aborted`，堆栈指向 `AbortController.abort` 创建点）
5. `lazyStream` 的 `.catch()` 调 `createSetupErrorMessage()` —— **硬编码 `stopReason: "error"`，无 `signal.aborted` 检查**（lazy.ts:44-48 附近）
6. 对照：流阶段失败走 `openai-completions.ts:713` 的 `output.stopReason = options?.signal?.aborted ? "aborted" : "error"` —— 分类正确

即：**setup 阶段失败与 stream 阶段失败对 abort 的分类不一致**，前者丢失 abort 语义。

### 8.5 分类与 Issue Candidate

- 分类：**A. CONFIRMED_PI_UPSTREAM_BUG**（由上轮 I-INCONCLUSIVE 升级）
- 依据：行为在 1.0.1 与 main 稳定复现、变体无关、源码根因定位、与场景 A 语义不一致
- **Issue Candidate Draft（已备好，未提交——按任务书禁止 gh issue create / upstream push）**：

> **Title**: `pkg:ai` Abort during tool execution terminates with stopReason "error" instead of "aborted" (lazy-stream setup path drops abort classification)
>
> **Body draft**:
> - SDK: @earendil-works/pi-coding-agent 1.0.1（main @ 83692682f 同样复现）
> - 场景：`session.abort()` 在 custom tool 执行期间调用（工具 signal-aware，reject 与正常返回两种行为结果相同）
> - 实际：最终 assistant message `stopReason="error"`、`errorMessage="This operation was aborted"`；`prompt()` 正常 resolve
> - 期望：`stopReason="aborted"`（与流式生成期 abort 的行为一致——同文件 openai-completions.ts:713 以 `signal?.aborted` 正确分类）
> - 根因：`packages/ai/src/api/lazy.ts` `lazyStream` 的 setup 失败路径 `createSetupErrorMessage()` 硬编码 `stopReason: "error"`，未检查 signal.aborted；abort 落在 turn 间隙时下一请求的 lazy setup 以 DOMException reject，直接进入该路径
> - 复现：本地 fake SSE server + signal-aware slow tool，时间触发 abort；9/9 稳定（脚本可提供）
> - 影响：以 stopReason 归因终态的 SDK 消费方会把用户主动取消误判为 provider/系统错误（重试统计、错误率、告警口径全部失真）

### 8.6 PaperTeam 侧影响

- 现有 workaround（`PiRuntimeAdapter` runOnSession 以 `cancelRequested` 归因，不信任 stopReason）**继续有效且必须保留**（上轮 P-2 决策维持）
- 真实负载中的历史观察（D-0019）与本复现吻合，假说链闭合

## 9. Real Smoke（zai-coding-cn / glm-5.3，MOT 项目尾段）

设置：复用 M11.2/M11.2.1 冻结 MOT 项目副本（`e2e/.tmp/pi101-smoke/`），正式 topic_survey workflow 尾段（前段幂等复用，不重新 Search），HITL 自动 approve（修订环策略同 m1121-run3）。脚本 `scripts/pi101-smoke.mjs`。

| 观测 | 值 |
|---|---|
| duration | 39 min（run `w-42e4c7c3100d`，exit 0） |
| 模型 turns | 51（model.turn spans） |
| agent tasks | 10+（reviewer 三路 ×2 轮 + writer 修订 + …） |
| tool calls | 75+（evidence_query / retrieve_library 等） |
| tokens | input 577,554 / output 232,114 / **cacheRead 4,377,216** / cacheWrite 0 |
| cost | $2.97（全 run 实测） |
| 最长 turn | ~247s（writer 长调用；p50 ~18s） |
| retry / errors | 0 error spans；无 retry 风暴、无 session 异常终止 |
| 事件序 | 白名单事件链完整（message/tool_execution/agent/turn 全配对；新事件 auto_retry 等未映射无影响） |
| workflow 终态 | Draft（art-draft-rev9.pdf），qualityOutcome=IMPROVED，2 修订轮 |
| 质量轨迹 | r8 77/65claims/13unsupported → r9 75/43/10 → r10 76/48/8（与 0.84.4 行为一致的振荡，产品语义未变） |

**Smoke 判定：PASS —— 无 runtime 回归。** usage 全字段完整、cacheRead 大量命中（4.38M tokens，缓存效率正常）、终态归因正确、会话生命周期干净。

阶段耗时（ms）：review.run 819k / revision.revise 1,007k / citation.verify 89k（×2）/ research.plan 91k / build.draft 5.2k。

## 10. Long Workload Soak（Case B 全程，Pi 1.0.1 第二真实负载）

Case B（新主题「多模态大模型中的视觉编码方法」全程 57min）+ Case A 尾段 smoke（§9）合计构成本轮 soak。Case B 运行观测（vs 0.84.4 基线 222 tasks / 352 turns / 2.5h）：

| 指标 | Case B（1.0.1） | 定性对比 0.84.4 |
|---|---|---|
| agent task count | 99 | 同量级 |
| model turn count | 125 | 同量级 |
| tool calls | 66 | 同量级 |
| retry count | 0（无 retry 风暴） | 一致 |
| errors | 0 runtime error spans（唯一 error = 工作流级 FACT_PRESERVATION 阻断，非 Runtime） | 一致 |
| 最长 turn | 221s（p50 16s） | 与 0.84.4 Writer 类长调用分布一致（p95 224s/max 459s 基线内） |
| usage 完整性 | 全 turn 落 run-trace（in/out/cacheRead/cacheWrite/cost） | 一致 |
| cacheRead | 4.32M tokens | 缓存效率正常 |
| tokens / cost | in 634k / out 305k / $3.35 | 单 turn 成本同量级 |
| session 异常终止 | 0 | 一致 |

**§23 专项问答：Pi 1.0.1 有没有出现 event regression / usage regression / retry regression / session leak / abort anomaly / tool pairing issue / unexpected context behavior / new error mode？——全部没有。No runtime regression observed.**

## 11. New Pi Findings

| 编号 | 发现 | 分类 |
|---|---|---|
| F-6' | 工具期 abort → `stopReason="error"`（§8 全链定位） | **A. CONFIRMED_PI_UPSTREAM_BUG**（Issue draft 备好未提交） |
| — | fake 后台 server 的 `setInterval` 不触发（Windows 后台进程环境怪象，首 chunk 正常） | H. ENVIRONMENTAL（仅影响本地测试 harness，非 Pi 问题） |
| — | 新事件 `auto_retry_start/end`、`entry_appended`、`message_start/end(system)` | G. EXPECTED_PI_BEHAVIOR（PaperTeam 白名单外，不映射，无影响） |

无其它新发现；1.0.1 升级修复确认：F-1（Z.AI CN overflow #9805+#10208）、F-2（retry 三件 #9571 等）、F-3（废弃 attempt 残留）、#10278（capacity retry）在位且行为正确（§7）。

## 12. PaperTeam Findings

| 发现 | 说明 | 处置 |
|---|---|---|
| C-1/C-2/C-3 | 升级兼容性测试 fixture 修复 | 已修（仅测试文件） |
| `zai-coding-cn/glm-5.2` 移除 | Pi 目录演进；PaperTeam 无产品代码引用（`src/evaluation/runners/multiModel.ts` 的 glm-5.2 属 M10 评估外部清单，不经 Pi 目录解析，不动） | 登记不修 |
| fake server interval 环境怪象 | 本地 repro harness 需时间触发 abort，不能依赖流事件 | 登记在 repro 脚本注释 |

Case B 运行时观测零异常（§10）；工作流层发现（FACT_PRESERVATION 阻断在新主题复现）归 M11.3 报告 D-1 决策项，非 Runtime 问题。

## 13. Upgrade Verdict

**PASS**

- 依赖升级干净（全树统一 1.0.1，无多版本）
- 全量回归绿（backend 2234/0 + frontend 271/0；唯一文件级失败为既有 ENOTEMPTY flake）
- 专项回归全过（overflow 分类 / transient retry / retry exhausted / 流式 abort 语义 / 事件链）
- 两段真实负载（MOT 尾段 $2.97 + Case B 全程 $3.35，合计 ~$6.3）零 runtime 异常
- 上游修复红利确认在位：Z.AI CN overflow（#9805+#10208）、retry 三件、capacity retry（#10278）
- 唯一遗留：F-6（工具期 abort 终态）为 upstream bug，PaperTeam workaround 继续有效（升级报告 §8；Issue draft 待作者裁决提交）

维持产品行为：两案例工作流语义与 0.84.4 一致（修订环振荡等属产品层既有议题，见 M11.3 报告）。

---

## 附：复现材料位置

- F-6 / overflow / retry diag 脚本：`D:\Tmp\paperteam-pi-upstream-audit\repro-abort-stopreason\{v1,pi-main}\*.mjs`
- upstream clone（main @ 83692682f，已构建）：`D:\Tmp\paperteam-pi-upstream-audit\pi`（dist 插桩已全部还原，语法验证通过）
- fake SSE server：`repro-abort-stopreason\v1\server.mjs`（:8787）/ `server-diag.mjs`（:8788，带请求日志）
