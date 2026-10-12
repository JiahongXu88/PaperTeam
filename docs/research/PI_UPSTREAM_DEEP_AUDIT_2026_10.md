# Pi Upstream Deep Audit & Contribution Research — 2026-10

日期：2026-10-12　执行：Claude Code（Fable 5.1）　性质：Pi SDK 上游审计 + 独立故障注入 + 候选修复与回归测试

---

## 0. 裁决

**SUCCESS — Upstream Contribution Candidate Ready（1 个）**，附 1 个已知未合并缺陷的新鲜复现证据与 1 个 SDK 文档/行为差异。

| 编号 | 候选 | 分级 | 一句话 |
|---|---|---|---|
| C1 | `repairJson` 不修复「`\u` 后非四位十六进制」的无效转义，工具调用参数整体坍缩为 `{}` 或静默丢字段 | **UPSTREAM_FIX_READY** | 新发现；1.0.1 / 1.1.0 / main 均复现（Windows + Linux）；最小 Patch + 11 条回归测试；`npm run check` 通过；pi-ai 全量测试通过 |
| C2 | 工具执行期 `abort()` → 终态 `stopReason="error"` + `This operation was aborted` | UPSTREAM_BUG_VERIFIED（已知，修复 PR #8635 开放七周、现与 main 冲突） | 本轮在 1.1.0 与 main@148622bc6 上双平台复现；1.1.0 新增 `agent_settled.aborted` 可作旁路判据 |
| C3 | SDK 路径（`createAgentSession`）从不安装 HTTP dispatcher：`httpIdleTimeoutMs` 文档称「header 与 body 空闲超时」，嵌入式会话里只覆盖 header 阶段 | **DOCUMENTATION_OPPORTUNITY**（可附最小 SDK 导出） | 新发现；3s 设置切不断 header 后静默，body 空闲只靠 Node undici 300s 默认值 |
| C4 | 成功轮后连续可重试失败使 `getContextUsage()` 膨胀 | ALREADY_KNOWN（#10287 开放，#10807 关闭） | main 上仍在；PaperTeam 暴露面低 |
| C5 | 重试退避期 abort：无终态 `agent_end(willRetry=false)`，终态消息保留 provider 错误 | BY_DESIGN | 文档明确以 `agent_settled` 为终态信号 |
| C6 | 压缩摘要包含此前请求已省略的 thinking（#9602） | ALREADY_FIXED_UPSTREAM（unreleased，15e7bdc14） | 不重复提 |
| C7 | provider 错误扁平化为字符串，`Request timed out.` 不可归因 | KNOWN / NEEDS_UPSTREAM_DECISION（#9702 无回应、#10697 开放） | 本轮 TCP 中断复现得到裸 `terminated` |
| C8 | Z.AI CN 溢出识别、Retry-After、capacity 重试等 | ALREADY_FIXED_UPSTREAM（上轮定论） | 1.0.1 已含 |

本轮 **零次付费模型调用**；全部实验为本地确定性 mock。PaperTeam 生产代码零改动，仅新增报告与公开复现脚本。

---

## 1. 基线

| 项 | 值 |
|---|---|
| PaperTeam | `main` @ `d5f34775a080d5879d556c7c06c111a65989860d`（clean） |
| PaperTeam Pi 依赖 | `@earendil-works/pi-coding-agent@1.0.1`、`@earendil-works/pi-ai@1.0.1`（`backend/package.json` 精确 pin；全树 1.0.1） |
| Pi 上游 | `github.com/earendil-works/pi`；最新 tag **v1.1.0**（`abe508e1b`，2026-10-07；npm `latest` = 1.1.0，发布 2026-10-07T22:16Z）；`main` HEAD **`148622bc6`**（2026-10-12 12:16 +0200，v1.1.0 之后 55 个提交） |
| 独立 Pi checkout | `D:\PaperTeamData\PiUpstreamAudit\pi-upstream`（main）+ worktree `pi-v1.0.1`（`a7229ddc2`）/ `pi-v1.1.0`（`abe508e1b`）；服务器 `~/pi-upstream-audit/pi` |
| Node | Windows 22.22.3 / Linux 22.20.0（上游 engines `>=22.19.0`） |
| 构建 | 两端 `npm ci --ignore-scripts` + `npm run build` 成功 |

### 1.1 新加坡 ECS 连接

- TCP 22 可达（`Test-NetConnection` TcpTestSucceeded=True，ICMP 不通）。
- 首次 `ssh ... ecs-user@47.84.30.153` 报 `Host key verification failed`。`ssh-keyscan` 取得新 IP 的 ED25519 / RSA / ECDSA 三把密钥，指纹与本机 known_hosts 中已信任的 `paperteam-sg`（旧 IP `47.84.130.164`）**逐一相同**（ED25519 `SHA256:plKQAp/U4N++DCdCJKfUfzPnKtGnfSjy/NxJX97SsnM`）→ 判定为同一台服务器换了公网 IP，把新 IP 的 host key 追加进 known_hosts（未关闭校验），沿用 `~/.ssh/paperteam-sg-key.pem` + `KexAlgorithms=curve25519-sha256`。
- 环境：Ubuntu 24.04.5 LTS，4 vCPU，15 GiB RAM（可用 14 GiB），`/` 34 GB 可用；Node 22.20.0 / npm 10.9.3 位于 `~/.local/bin`（非交互 shell 不在 PATH，需显式 `export PATH`）。
- 既有业务：docker `paperteam-backend-1`（healthy）与 `paperteam-web-1`（127.0.0.1:8080）在跑，`~/PaperTeam`（`507913aa`）、`~/paperteam-acceptance`、`~/.pi` 均存在。**全部未触碰**；本轮只在新建的 `~/pi-upstream-audit/` 下工作，未复制任何 API Key。

---

## 2. 第一阶段：PaperTeam 历史证据

读取 M13.7.11 / M13.7.10 / M11.4 / M13.5.x / M13.6 / M10.4.x / DECISIONS / 两份既有 Pi 审计报告与 `PiRuntimeAdapter.ts` 全文。归纳出的 runtime 层现象与归属：

| # | 现象 | 版本 | 本轮归属 |
|---|---|---|---|
| P1 | 工具期 abort → `stopReason="error"`（D-0020、1.0.1 soak 9/9） | 0.84.4 / 1.0.1 / main | Pi 缺陷，已知未修 → **C2** |
| P2 | provider 错误只剩 `errorMessage` 字符串，class/cause/HTTP 状态丢失 | 1.0.1 | Pi 设计限制 → **C7** |
| P3 | M11.4 Attempt 5 两次 `assessment.target` 超时（300s 自身计时 / 177s `Request timed out.`） | 1.0.1 | 不可归因（P2 所致）；本轮实证 `timeoutMs` 只覆盖 header 阶段 → **C3** 解释了其中一半 |
| P4 | provider 0 事件挂起 ~900s 不触发 auto-retry | 0.84.4 | 设计如此；上游 #8331 开放；PaperTeam 首活性 watchdog 合理 → **C3** |
| P5 | Z.AI CN `code 1261` 溢出误判 | 0.84.4 | ALREADY_FIXED（0.99.2） |
| P6 | `Stream ended without finish_reason` → auto-retry 成功 | 0.84.4 / 1.0.1 | 期望行为 |
| P8 | `stopReason="length"` 被当成功 / thinking 预算共用 `max_tokens` | 1.0.1 | PaperTeam 应用层（W5 已处理） |
| P9 | `reasoning:true` 模型总是发 `thinking:{type:"disabled"}` | 1.0.1 | 网关兼容问题，Pi 编码合法 |
| P10 | 工具调用后偶发 400 thinking signature binding（自动重试恢复） | 1.0.1 | NEEDS_MORE_EVIDENCE（单次、无载荷）；源码 `anthropic-messages.ts:1395-1445` 的签名重放逻辑本身合理，未做实验 |
| P12 | `\cite` 非法 JSON 转义导致 structured repair 浪费 | 1.0.1 | PaperTeam 结构化输出解析（assistant 文本）；**但同一模型习惯落在工具参数上即触发 C1** |

PaperTeam 为 Pi 行为所做的补偿逻辑（W1–W10：`cancelRequested` 归因、首活性 watchdog、执行超时 + 轮换、关闭 compaction + 自建 context 预算、`length` → 截断错误、`reasoning:false` 单点、`UNKNOWN_OWNER` 超时分类、以 `prompt()` resolve 而非 `agent_end` 判终态、同名工具覆盖内置、剥离代理变量）均在 `PiRuntimeAdapter.ts` 内有注释与坐标；本轮结论：**W1 / W2 / W7 / W8 必须保留**（分别对应 C2 / C3 / C7 / C5），其余为应用策略。

---

## 3. 第二阶段：Pi 架构与版本差异（1.0.1 → 1.1.0 → main）

通读 `AGENTS.md`、`CONTRIBUTING.md`、`packages/agent/src/agent-loop.ts`（949 行）、`packages/ai/src/api/lazy.ts`、`utils/{abort,abort-signals,event-stream,retry,provider-retry,json-parse}.ts`、`api/openai-completions.ts` 的工具参数终结与错误分类段、`coding-agent/src/core/{agent-session,model-runtime,sdk,http-dispatcher}.ts` 相关段。

与 PaperTeam 消费面相关的差异：

| 变化 | 版本 | 对 PaperTeam |
|---|---|---|
| `agent_settled` 新增 `aborted`（commit 503c60552，#10607） | 1.1.0 | 可替代一部分 W1 的意图归因（但 C2 的 `stopReason` 仍错） |
| `AssistantMessage.durationMs` / `ToolResultMessage.durationMs`（36a686ee8，#10549） | 1.1.0 | 可用于 trace；注意 lazy setup 时间不计入（inner stream 先打点） |
| `server_busy` / `servers are currently busy` 可重试（#10543）；Mistral `finish_reason:"error"` 可重试 | 1.1.0 | 韧性增强 |
| 输出上限估算 4 → 3.5 chars/token（#10497） | 1.1.0 | 减少 context-limit 请求失败 |
| 流函数必须返回 `AssistantMessageEventStream`（Breaking） | 1.1.0 | PaperTeam 未自定义流函数，不受影响 |
| Azure provider 重命名（Breaking） | 1.0.3 | 不使用 |
| `serializeConversation()` 省略 thinking（15e7bdc14，对应 #9602） | main（unreleased） | compaction 关闭，不受影响 |
| `before_agent_start` 语义变化、session busy 口径（Breaking） | main（unreleased） | PaperTeam 不用 extension hook |
| `lazy.ts` `createSetupErrorMessage` 增加 `timestamp` 参数（36a686ee8） | 1.1.0 | 使 PR #8635 产生冲突（C2） |

贡献规则要点（CONTRIBUTING.md 当前版）：新贡献者的 Issue / PR **默认自动关闭**；维护者回复 `lgtmi`（Issue）/ `lgtm`（Issue + PR）后才放行；Issue 须用模板、一屏以内、**本人口吻（不要 LLM 生成，若用需明确标注）**；PR 前 `npm run check` + `./test.sh` 必须通过；不改 CHANGELOG；周五至周日不保证审阅；自动化刷 Issue 会被永久封禁。

---

## 4. 第三阶段：上游 Issue / PR 对照

检索 60+ 条相关 Issue / PR（关键词：aborted stopReason、abort tool、Request timed out、errorMessage structured、usage failed turn、compaction thinking、Retry-After、stream timeout idle、repairJson、invalid escape、backslash、partial-json、unicode escape、usepackage）。与本轮候选的对应：

| 候选 | 上游条目 | 状态（2026-10-12） |
|---|---|---|
| C1 | — | **无等价 Issue / PR**。相邻：#8858（markdown 围栏参数 → `{}`，closed no-action）、#6274（edit 工具内嵌 JSON 转义，closed no-action）、#10074（Claude strict 工具丢 `u` → `\b`/`\f` 控制字符，open）、#3694（为 repairJson 补测试的 PR，closed） |
| C2 | #8409（lgtm 已给）、PR **#8635**（open since 2026-08-25，+199/−97，5 文件，社区 reviewer approved，作者两次 rebase、三次 ping）、#9883（auto-closed）、PR #9467 / #9882（auto-closed） | 未合并；本轮 `git merge` 实测 PR 与 `148622bc6` 在 `lazy.ts` 两处冲突 |
| C3 | #8331（流中停滞永久挂起，open；维护者："本地模型可能停更久，不能有低默认值"）、#10762（headless 挂起，被标为 #8331 重复）、PR #8593（idle watchdog，auto-closed） | 开放；本轮补充的是 **SDK 路径与 CLI 路径的差异**，上游讨论尚未触及 |
| C4 | #10287（open，三位用户给出参考 diff 求 lgtm）、#10807（closed）、#10068 | 开放未修 |
| C5 | #10017 / #10705（abort 与 follow-up / deferred continuation） | 相邻但不同 |
| C6 | #9602 | 代码已落 main（15e7bdc14），Issue 仍 open |
| C7 | #9702（closed no-action）、#7234 / #5623（closed）、#10697（open，建议把 `error.cause` 折进 `errorMessage`）、#10752（closed no-action） | 结构化字段方向未获维护者回应 |

另注意 #9986 / #9306（工具期 abort 留下未应答 tool call；Temporal 团队 fork 的 step 化方案）与 #10601（agent 级重试忽略 Retry-After）均开放，本轮未深入。

---

## 5. 第四阶段：独立最小复现 Harness

目录：`docs/research/repros/pi-upstream-audit-2026-10/`（公开，已脱敏）与 `D:\PaperTeamData\PiUpstreamAudit\harness\`（含 results）。

- `fake-openai-server.mjs`：**进程内** OpenAI 兼容 SSE server（避免上轮 Windows 后台进程计时器失效的坑），以请求 `model` 字段选场景；可产生：原始反斜杠的工具调用参数、HTTP 500 序列、header 前 / 后静默、带 `: ping` 注释的静默、流中 TCP destroy、慢工具。
- `run-scenario.mjs`：公开 SDK 驱动（`ModelRuntime.create` → `models.json` 自定义 provider → `createAgentSession` + 三个自定义工具 `add_note` / `write_tex` / `slow_tool`），`--sdk <包目录>` 切换 Pi 版本，记录全部事件、工具实收参数、`getContextUsage()`、server 收到的请求。
- `run-matrix.sh`：场景 × 版本矩阵。

版本矩阵：**v1.0.1**（PaperTeam `backend/node_modules`，只读使用）、**v1.1.0**（npm 安装）、**main@148622bc6**（本地构建）、**main-patched**；平台：Windows 11 + Ubuntu 24.04。

---

## 6. C1 — `repairJson` 对无效 `\u` 转义的修复缺口【UPSTREAM_FIX_READY】

### 6.1 现象

模型在工具调用参数的 JSON 字符串里忘记双写反斜杠是真实且常见的（上游 #6274 GLM-5.2、#10074 Claude strict 工具；PaperTeam M13.7.11 的 GLM-5.3 `\cite`）。Pi 的 `repairJson()` 对此有明确策略：「doubling backslashes before invalid escape characters」——`\c` → `\\c`，字面反斜杠得以保留。但 `\u` 后不是四位十六进制时，代码**原样保留**而不是按无效转义处理，于是 `JSON.parse` 继续失败，`parseStreamingJson` 退到 `partial-json`，后者把出错位置之后的内容当作截断丢弃。

端到端结果（三版本 × 两平台**完全一致**，`results/win-baseline-*`、`results-linux/linux-baseline-*`）：

| 场景 | 原始参数 | 1.0.1 / 1.1.0 / main 工具实收 | 后果 |
|---|---|---|---|
| `note-url` | `{"text":"See \url{https://example.org/paper}"}` | `{}` | `Validation failed for tool "add_note"`，模型得到的是 schema 错误而非转义错误 |
| `note-u-short` | `{"text":"x\u12"}` | `{}` | 同上 |
| `tex-usepackage` | `{"path":"main.tex","content":"\documentclass{article}\n\usepackage{graphicx}\n"}` | `{"path":"main.tex"}` | **`content` 静默丢失**，工具按「无内容」执行（`wrote main.tex (NO CONTENT)`） |
| `note-cite`（对照） | `{"text":"See \cite{knuth84}"}` | `{"text":"See \\cite{knuth84}"}` | 修复正确 |
| `tex-cite`（对照） | `\documentclass` + `\cite` | 全部保留 | 修复正确 |
| `note-u-valid`（对照） | `caf\u00e9 \u2014` | `café —` | 合法转义不受影响 |

LaTeX 中以 `u` 开头的命令（`\url`、`\usepackage`、`\underline`、`\upshape`、`\unskip`…）全部命中；`\b` `\f` `\n` `\r` `\t` 开头的命令（`\begin`、`\frac`、`\newcommand`、`\ref`、`\textbf`）是合法转义，解析器无法区分，属模型责任，不在本候选范围。

### 6.2 根因

`packages/ai/src/utils/json-parse.ts`（1.0.1 / 1.1.0 / main 三版文件**完全相同**）：

```ts
if (nextChar === "u") {
    const unicodeDigits = json.slice(index + 2, index + 6);
    if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) { ...keep...; continue; }
}
if (VALID_JSON_ESCAPES.has(nextChar)) {   // 集合含 "u" → 原样保留 "\u"
    repaired += `\\${nextChar}`; index += 1; continue;
}
repaired += "\\\\";                        // 其它无效转义才走到这里
```

`"u"` 同时位于 `VALID_JSON_ESCAPES`，使非十六进制的 `\u` 落入「合法转义」分支。随后 `parseJsonWithRepair` 因 `repaired === json` 直接重新抛出，`parseStreamingJson` 的第 2/3 级 `partialParse` 返回截断前缀（`{}` 或 `{"path":"a.tex"}`）。

### 6.3 修复（最小、符合既有策略）

分支 `audit/json-repair-invalid-unicode-escape`，commit `ab9c50d93`，基线 `148622bc6`；Patch：`D:\PaperTeamData\PiUpstreamAudit\patches\0001-fix-ai-repair-u-escapes-that-are-not-followed-by-fou.patch`（sha256 `bb67a48d…d834b2`，`git format-patch --base=148622bc6`）。

- `json-parse.ts`：`\u` 后四位十六进制 → 保留；**剩余字符不足四个且全为十六进制** → 保留（流式 JSON 可能在转义中间被截断，下一 delta 会补全）；其它 → 按无效转义双写反斜杠。`VALID_JSON_ESCAPES` 移除 `"u"`（单字符转义集合语义更准确）。+22/−3。
- 新增 `packages/ai/test/json-parse.test.ts`（11 条）：`\c` 双写、合法转义与 `\u00e9` 不动、`\url` / `\usepackage` / `\u12G4` 双写、`x\u12` 双写并可 `JSON.parse`、输入在 `\u00` / `\u` 处截断时保持不变、控制字符转义、`parseJsonWithRepair` 修 `\url`、`parseStreamingJson` 对 `\c` 与 `\u` 同样修复、**后续字段不丢**、截断中的 `\u` 仍可部分解析、合法 `\u` 不动。

### 6.4 验证

| 项 | 结果 |
|---|---|
| 修复前运行新测试 | **5 failed / 6 passed**（失败项正是 `\u` 相关断言） |
| 修复后 | **11/11 passed**（Windows 与 Linux） |
| 相邻解析测试（`openai-responses-partial-json-cleanup`、`assistant-message-frame`、`anthropic-sse-parsing`） | 35/35 passed |
| `npm run check`（biome / pinned-deps / runtime-deps / ts-imports / entry-graphs / install-lock / tsc / browser-smoke） | **exit 0**（biome 重排了测试文件格式，已 amend） |
| pi-ai 包全量 vitest（Windows） | 144 files passed / 27 skipped；1337 tests passed / 868 skipped（e2e 无 key 自动跳过） |
| `./test.sh`（Linux，补丁版） | pi-ai **144 passed / 27 skipped**；pi-agent-core 4/4；coding-agent 306 passed / 3 failed（15 条 grep/find 测试，原因 `ripgrep (rg) is not available and could not be downloaded`，服务器无 `rg`/`fd`）；pi-env 6 文件失败（ssh / terminal 测试需要本机 sshd 与 PTY 环境）；其余包全部通过。失败集合与本补丁无关（不触及 json-parse），属环境依赖 |
| e2e 矩阵（main-patched，Windows + Linux） | 7 个 JSON 场景全部恢复：`note-url` → 35 字符、`note-u-short` → `x\u12`、`tex-usepackage` → `content` 46 字符保留；对照组不变；`abort-slow-tool` 行为不变（与本补丁无关） |

### 6.5 风险与边界

- 行为只在「`\u` 后非四位十六进制」的字符串上改变，而这类输入此前**必然**解析失败；合法 `\uXXXX` 路径未改。
- 流式截断：`"\u00` 末尾保持不变，`partialParse` 仍能给出前缀（测试覆盖）。
- `partial-json` 0.1.7 未升级。不涉及 provider 差异（anthropic-messages / openai-responses / bedrock / mistral / pi-messages 共用同一函数）。
- 归属：Pi core（`pi-ai` utils），非 extension 可替代——参数解析发生在 provider 流终结处，extension 拿到的已是 `{}`。

---

## 7. C2 — 工具期 abort 终态分类【UPSTREAM_BUG_VERIFIED，修复待合并】

### 7.1 本轮新证据

`abort-slow-tool --abort-during-tool`（signal-aware 慢工具，1.5s 后 `session.abort()`）：

| SDK | stopReason | errorMessage | `agent_settled.aborted` | 平台 |
|---|---|---|---|---|
| 1.0.1 | `error` | `This operation was aborted` | （字段不存在） | Win + Linux |
| 1.1.0 | `error` | `This operation was aborted` | `true` | Win + Linux |
| main 148622bc6 | `error` | `This operation was aborted` | `true` | Win + Linux |

对照：流式生成期 abort（`stall-after-headers --abort-after-ms 1000`）与首 token 前 abort（`stall-no-headers --abort-after-ms 1000`）终态均为 `aborted`（`Request was aborted` / `Request aborted`）——**同一用户动作按落点阶段得到不同终态**，与上轮结论一致。

### 7.2 根因与上游状态

`packages/ai/src/api/lazy.ts` `createSetupErrorMessage()` 在 main 仍硬编码 `stopReason: "error"`，`lazyStream()` 不接收 signal；`ModelRuntime.stream/streamSimple/streamDeferred`（`model-runtime.ts:705/728/744/760`）调用 `lazyStream` 时未传 `options.signal`。agent loop 在工具批被 abort 后仍进入下一次 `streamAssistantResponse`（`agent-loop.ts` runLoop：`hasMoreToolCalls` 未因 abort 置 false），setup 链以 DOMException reject → 误判。

- #8409（2026-08-20）报告同一现象，badlogic 回复 `lgtm please send a pr`。
- PR **#8635**（2026-08-25）实现了与 #9883 相同的方案：`lazyStream(model, setup, signal?)` + `models.ts` / `model-runtime.ts` / `provider-composer.ts` 全部调用点转发 `options?.signal` + 回归测试 `8409-aborted-tool-auth-setup.test.ts`。社区 reviewer approved（2026-09-14），作者 09-03 / 09-16 两次解决冲突并 ping 维护者，至今未合并。
- 本轮实测：PR head `7a7077dc6` 与 `148622bc6` 合并在 `lazy.ts` **两处冲突**（1.1.0 的 36a686ee8 给 `createSetupErrorMessage` 增加了 `timestamp` 参数并改了调用行）；`model-runtime.ts` / `provider-composer.ts` 可自动合并。解决方式显然：`createSetupErrorMessage(model, error, timestamp, stopReason)`。
- main 新增的其它 `lazyStream` 调用点：`virtual-models.ts:191`（固定抛错，与 abort 无关）、`azure.ts:34/38`（setup 仅同步解析端点，不涉及 signal；为一致性可一并转发 `options?.signal`）。

### 7.3 处置

不另起竞争 PR。可供用户决定的动作：在 PR #8635 或 #9883 下以本人口吻补充「1.1.0 与 main@148622bc6 仍复现 + 与 main 的冲突位置」（事实提纲见附录 B）。PaperTeam 的 W1（`cancelRequested` 归因）继续保留；升级到 1.1.0 后可额外读取 `agent_settled.aborted`。

---

## 8. C3 — SDK 路径未安装 HTTP dispatcher，`httpIdleTimeoutMs` 只覆盖 header【DOCUMENTATION_OPPORTUNITY】

### 8.1 实证（1.0.1 与 main 相同）

| 场景 | 设置 | 结果 |
|---|---|---|
| `stall-no-headers`（server 永不回响应头） | `retry.provider.timeoutMs=3000` | **3.1s** 终态 `error` / `Request timed out.` |
| `stall-no-headers` | `httpIdleTimeoutMs=3000` | 3.1s `Request timed out.`（经 `sdk.ts` 映射成 `timeoutMs`） |
| `stall-after-headers`（回头 + 1 chunk 后静默，无字节） | `retry.provider.timeoutMs=3000` 或 `httpIdleTimeoutMs=3000` | **不触发**，15s 后被 harness watchdog abort（`aborted`） |
| `stall-after-headers-pings`（静默但每秒 `: ping`） | `httpIdleTimeoutMs=3000` | 不触发（12s watchdog） |
| `drop-mid-stream`（TCP destroy） | retry on | 错误文本裸 `terminated`（#10697），auto-retry 恢复 |

长时对照（Linux，main，无设置 / `httpIdleTimeoutMs=20000` / pings）：见 §8.4。

### 8.2 源码链

- `coding-agent/src/core/sdk.ts` `buildRequestOptions()`：`timeoutMs = options.timeoutMs ?? retry.provider.timeoutMs ?? httpIdleTimeoutMs`；
- `pi-ai/api/openai-completions.ts:372`：`timeout: options.timeoutMs` 传给 OpenAI SDK（`maxRetries: 0`）；
- `openai@6.40.0 client.js fetchWithTimeout()`：`setTimeout(abort, ms)` 包裹 `fetch()`，**fetch 在响应头到达即 resolve**，此后不再受该计时器约束；
- 真正的 body 空闲超时在 `coding-agent/src/core/http-dispatcher.ts` `configureHttpDispatcher(timeoutMs)`：`undici.EnvHttpProxyAgent({ bodyTimeout, headersTimeout, ... })` + `setGlobalDispatcher` + `undici.install()`。**调用点只有** `cli/setup.ts:12`、`main.ts:597/875`、`rpc-entry.ts:11`、`interactive-mode.ts:2063/5014`、`experimental/*/harness-setup.ts`；`createAgentSession`（SDK）从不调用；`configureHttpDispatcher` 也**未从 `packages/coding-agent/src/index.ts` 导出**；`docs/sdk.md` 对 dispatcher / idle timeout / proxy 零提及。
- 因此嵌入式会话的 body 空闲只受 Node 自带 undici 的默认 `bodyTimeout` 约束（undici 文档：`bodyTimeout` **Default: 300e3**，监测相邻 body chunk 间隔），且 `: ping` 注释字节会重置它；`httpProxy` 设置（`applyHttpProxySettings`）同样只在 CLI 生效。

### 8.3 判定

- 这解释了 PaperTeam 的两个历史观察：M11.4 的「undici headersTimeout/bodyTimeout 300000」其实是 **Node 默认值而非 Pi 设置**；首活性 watchdog（W2）在 SDK 模式下是必要的，而不是冗余。
- 属于 SDK 文档缺口 + 轻量 SDK 能力（把 `configureHttpDispatcher` 作为公开导出，或在 `docs/sdk.md` / `settings.md` 写明「SDK 模式下 `httpIdleTimeoutMs` 仅作用于请求头超时，宿主需自行配置 undici dispatcher」）。是否由核心代为安装全局 dispatcher是维护者决策（库擅自改进程全局状态有争议），因此分级为 DOCUMENTATION_OPPORTUNITY 而非 bug。
- 与开放的 #8331 / #10762 互补：那两条讨论的是 CLI 路径与默认值；SDK 路径差异尚未被提出。

### 8.4 长时对照结果

Linux（Ubuntu 24.04，Node 22.20.0，main@148622bc6 + C1 补丁，`results-linux/long/`）：

| 场景 | `httpIdleTimeoutMs` | 结果 |
|---|---|---|
| `stall-after-headers`（回头 + 1 chunk 后无字节） | 未设置（默认 300000） | **300.8s** 终态 `error` / `terminated`（Node undici 默认 `bodyTimeout` 300e3 触发；错误文本不含 cause，见 C7） |
| `stall-after-headers` | **20000** | **仍为 300.8s** `terminated` —— 设置对 SDK 路径的 body 阶段无效 |
| `stall-after-headers-pings`（每秒 `: ping` 注释） | 未设置 | **400s 内未超时**，由 harness watchdog 中止（`aborted`）；字节流动使 bodyTimeout 不断重置 |

三条结果与 §8.2 的源码链完全吻合：SDK 模式下唯一由 Pi 控制的计时器是 OpenAI SDK 的 header 超时；body 空闲由 Node 默认值决定且可被 keepalive 字节绕过。

---

## 9. 其它候选的证据与结论

### C4 `getContextUsage()` 在可重试失败后膨胀【ALREADY_KNOWN，#10287 开放】

`tool-then-500-always --retry`（成功 toolUse 轮 usage=160 → 3 次 500 重试耗尽）：`getContextUsage().tokens` 1.0.1 = **616**，main = **610**，而成功锚点为 160（`plain` / `error-500-then-ok` 恢复后均为 160）。机制与 #10287 / #10807 描述一致（`_omitRecoveryAttempt` 的 `context_edit` 使 usage 锚点失效，退回 chars/4 全投影估算）。PaperTeam：compaction 关闭、`getContextUsage` 仅作第三级兜底（`PiRuntimeAdapter.ts:1899-1921`），暴露面低；但若升级后依赖它做轮换判定需注意。

### C5 重试退避期 abort【BY_DESIGN】

`error-500-always --retry --abort-on-retry`：`message_end(error) > agent_end(willRetry=true) > auto_retry_start(#1) > abort > auto_retry_end(success=false, "Retry cancelled") > agent_settled(aborted=true)`。无终态 `agent_end(willRetry=false)`，无 `aborted` assistant 消息，终态消息仍是 500 错误且已被 `_omitRecoveryAttempt` 从投影中省略。`docs/sdk.md:92-94` 与 `json.md:48-56` 明确 `agent_end` 只是低级 run 结束、`agent_settled` 才是「不会再自动继续」；`_handlePostAgentRun` 对 `_agentRunAbortRequested` 有显式处理。PaperTeam 以 `prompt()` resolve 判终态（W8），不受影响。

### C6 压缩含 thinking【ALREADY_FIXED_UPSTREAM】

main 15e7bdc14 `fix(coding-agent,durable): omit thinking from compaction summaries`（v1.1.0 之后，未发布）；#9602 仍 open。

### C7 错误保真【KNOWN】

`drop-mid-stream` 在 1.0.1 与 main 的错误文本均为裸 `terminated`（undici `cause` 被 `error-body.ts` 丢弃，#10697 的描述成立）。结构化字段提案 #9702 自动关闭无回应。PaperTeam 的 `UNKNOWN_OWNER` 分类（W7）继续保留；若上游采纳 #10697 的「cause 折进 errorMessage」，PaperTeam 的正则分类会直接受益。

### 未进一步追查

- P10（thinking signature 400）：源码 `anthropic-messages.ts:1395-1445` 对无签名 thinking 块做了「转文本 / 允许空签名」处理，单次事件无载荷，NEEDS_MORE_EVIDENCE。
- #9986 / #9306（abort 留下未应答 tool call）：已有报告与 Temporal fork 方案，未重复。

---

## 10. PaperTeam 侧登记（本轮不修改）

来自 Adapter 全文审计，均为应用层，按价值排序：

1. **失败终轮清零已测量 context**：`acc.contextTokens = totalTokens` last-wins，Pi 的失败消息 `totalTokens:0` → `usage.contextTokens=0` → 回写被 `>0` 守卫跳过，`managed.context` 停留在上一轮（`PiRuntimeAdapter.ts:1408-1421, 3296-3298`）。建议忽略 0 或取 max。
2. **Pi 合成失败消息会解除首活性 watchdog**：`handleRunFailure` 以 `role:"assistant"` 发 `message_start`，connect-refused + auto-retry 数毫秒内即「有活动」，之后真正静默的重试只受执行预算约束（最长 1800s）。建议以 `errorMessage === undefined` 判首活性或在 `auto_retry_end` 重新武装。
3. **`AGENT_RUN_FAILED` 一律 `transient`**（`WorkflowOrchestrator.ts:1140-1143`）：401 / 400 / 402 也会被重试。可借用 Pi 的 `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` 思路加一类 permanent。
4. Pi auto-retry（默认 3 次）与 stage `maxAttempts=2` 叠加最多 8 次模型调用，配置未暴露 `retry.*`；建议在配置里显式登记。
5. cancel 与 provider 错误竞态（`close()` 期间）可能把真实错误标成 cancelled（`:2273`）。
6. 轮换 / preflight 不在执行计时器内；注释版本号仍写 0.84.4（`:11`、`types.ts:228`、`contextBudget.ts` 头）。
7. C1 对 PaperTeam 的暴露：自定义工具 `record_evidence.quote`（逐字引文）等自由文本参数若含 `\u...` 形式的 LaTeX，会整体被判 schema 错误；升级到含 C1 修复的版本前，可在 prompt 中要求双写反斜杠。

升级建议：**不默认升级**。1.0.1 → 1.1.0 对 PaperTeam 的收益为 `agent_settled.aborted`、`durationMs`、busy 类错误重试、3.5 chars/token；Breaking 项（流函数类型、Azure 重命名）不触及 PaperTeam 消费面。待 C1 进入发布版本后再评估一并升级（届时需跑 `PiRuntimeAdapter.test.ts` 全套 + 1 个真实 smoke）。

---

## 11. 贡献建议与最小提交顺序

1. **C1**（唯一 PR-ready）：按 CONTRIBUTING 流程，先由用户本人以自己的口吻开 Issue（模板 Bug，一屏内；事实提纲见附录 A），等待 `lgtm`；获批后从 `audit/json-repair-invalid-unicode-escape` 推送 PR（PR 描述草稿见附录 A.3；CHANGELOG 不改）。预期争议点：是否该把 `\u` 的「<4 个全十六进制」截断例外写成这样——可按 reviewer 意见简化。
2. **C2**：不开新 PR；可选在 PR #8635 下补充复现与冲突事实（附录 B），帮助其合并。
3. **C3**：先以 Issue（Documentation / Bug 模板）提出「SDK 路径 `httpIdleTimeoutMs` 仅覆盖 header」事实，由维护者决定是文档补充、导出 `configureHttpDispatcher`，还是别的方案；附录 C 给事实提纲。
4. C4 / C7：不新开（已有开放 Issue）；若用户愿意，可在 #10287 / #10697 下附上本轮确定性复现路径。

是否值得正式投稿：**值得**（C1）。它小、确定、可独立复现、符合 Pi「核心最小」原则、带回归测试与完整 check；唯一门槛是新贡献者的 lgtm 流程与「本人口吻」要求。

---

## 12. 不构成成果的项（如实登记）

- C5 退避期 abort、P6 流中断自动重试、P9 thinking 字段编码：Pi 按设计工作。
- P3 `Request timed out.` 历史根因：仍不可恢复；本轮只解释了「为何该超时只在 header 阶段触发」。
- P10：证据不足。
- 本轮未运行真实模型，所以「模型是否真的在工具参数里发无效 `\u`」依赖上游 #6274 / #10074 与 PaperTeam M13.7.11 的观察，而非本轮新采样；下次真实 run 建议在 trace 中记录 `tool_execution_start.args === {}` 的频次作为触发条件。

---

## 13. 资源与成本

- 付费 API：0 次。
- 服务器：仅用户目录 `~/pi-upstream-audit/`（pi clone + node_modules + dist ≈ 2 GB；harness；1.0.1 / 1.1.0 npm 安装）；未开端口、未改安全组、未动 docker / 系统 Node。
- 本机：`D:\PaperTeamData\PiUpstreamAudit\`（pi-upstream + 两个 worktree + harness + results + patches + 日志）。
- 不进仓库的内容：Pi 源码、node_modules、原始结果 JSON（`results/`、`results-linux/`）。

---

## 附录 A — C1 投稿材料

### A.1 Issue 事实提纲（供用户本人撰写，不是投稿文本）

- 包：`@earendil-works/pi-ai`（`pkg:ai`），1.0.1 / 1.1.0 / main 148622bc6 均复现，Windows 与 Linux 相同。
- 现象：工具调用参数里含 `\u` 后非四位十六进制的字符串（如 LaTeX `\url{}`、`\usepackage`）时，`parseStreamingJson` 返回 `{}`，或只保留出错字段之前的属性（`{"path":"a.tex","content":"\usepackage{x}"}` → `{"path":"a.tex"}`）；而 `\cite`、`\documentclass` 这类无效转义会被 `repairJson` 修成字面反斜杠。
- 最小复现（无需 provider）：`parseStreamingJson(String.raw\`{"text":"\url{x}"}\`)` → `{}`；`parseStreamingJson(String.raw\`{"text":"\cite{x}"}\`)` → `{text:"\\cite{x}"}`。
- 位置：`packages/ai/src/utils/json-parse.ts` `repairJson`，`"u"` 在 `VALID_JSON_ESCAPES` 内导致非十六进制 `\u` 走「合法转义」分支。
- 影响：工具收到 schema 验证错误（信息误导）或静默少字段；对 LaTeX / 正则 / Windows 路径类内容的 Agent 产品常见。
- 愿意自己修：是（补丁 +22/−3，11 条测试，`npm run check` 通过）。
- 若使用 AI 协助撰写，按规则标注。

### A.2 PR 标题

`fix(ai): repair \u escapes that are not followed by four hex digits`

### A.3 PR 描述草稿

> `repairJson` doubles the backslash of invalid escapes such as `\c`, so a model that forgot to escape a literal backslash still yields parseable tool arguments. `\u` followed by anything other than four hex digits was left untouched instead: `JSON.parse` kept failing and `parseStreamingJson` fell back to partial-json, which drops the rest of the object. `{"text":"\url{...}"}` became `{}` and `{"path":"a.tex","content":"\usepackage{x}"}` became `{"path":"a.tex"}`. LaTeX commands starting with `u` (`\url`, `\usepackage`, `\underline`) hit this.
>
> Treat such a `\u` like any other invalid escape. A `\u` cut off by the end of the input (fewer than four characters left, all hex) is still left alone so a later streaming delta can complete it.
>
> Tests: `packages/ai/test/json-parse.test.ts` covers the repaired cases, the truncated-stream case, and the unchanged valid escapes. `npm run check` and `./test.sh` run (`./test.sh` failures on my Linux box are limited to tests needing `rg`/`fd`/sshd, unrelated).

## 附录 B — C2 补充事实（供用户评论 PR #8635 / #9883 时核对）

- 1.1.0 与 main 148622bc6：工具执行期 `session.abort()` → 最终 assistant `stopReason="error"`，`errorMessage="This operation was aborted"`；1.1.0 起 `agent_settled.aborted === true`。
- PR #8635 head 7a7077dc6 与 main 148622bc6 合并冲突：`packages/ai/src/api/lazy.ts` 的 `createSetupErrorMessage` 签名（main 新增 `timestamp`）与 `lazyStream` 的 catch 分支；其余文件自动合并。
- 复现脚本：本仓库 `docs/research/repros/pi-upstream-audit-2026-10/`（`abort-slow-tool --abort-during-tool`）。

## 附录 C — C3 事实提纲

- `docs/settings.md` 写 `httpIdleTimeoutMs`「HTTP header and body idle timeout」；SDK 模式下该值经 `sdk.ts buildRequestOptions` 只变成 OpenAI SDK `timeout`（header 到达前）。
- `configureHttpDispatcher`（undici `bodyTimeout`/`headersTimeout`/`EnvHttpProxyAgent`）只在 CLI / RPC / interactive / experimental harness 入口调用；`createAgentSession` 不调用；未从包入口导出；`docs/sdk.md` 无说明。
- 实测：`httpIdleTimeoutMs=3000` 下 header 前静默 3.1s 报错，header 后静默不触发；body 空闲只受 Node undici 默认 300s 约束，`: ping` 字节会重置。
- 请求：在 sdk.md 写明，或导出 `configureHttpDispatcher` 供宿主调用。

## 附录 D — 证据与产物清单

| 路径 | 内容 |
|---|---|
| `D:\PaperTeamData\PiUpstreamAudit\pi-upstream` | Pi main 克隆，分支 `audit/json-repair-invalid-unicode-escape`（ab9c50d93），`pr-8635` 本地分支 |
| `…\pi-v1.0.1`、`…\pi-v1.1.0` | 版本 worktree（源码对比） |
| `…\patches\0001-fix-ai-repair-u-escapes-that-are-not-followed-by-fou.patch` | 候选补丁（base 148622bc6） |
| `…\harness\results\win-baseline-*`、`win-patched-*`、`retry-*`、`probe-*` | Windows 结果 JSON |
| `…\harness\results-linux\linux-baseline-*`、`linux-patched-*`、`test-sh-patched.log` | Linux 结果与 `./test.sh` 全量日志 |
| `…\check-local-patched.log`、`vitest-ai-win-patched.log`、`build-local-main.log` | check / 测试 / 构建日志 |
| 服务器 `~/pi-upstream-audit/{pi,harness,patches}` | Linux 镜像工作区（补丁已 `git am`，38b08431e） |
| 本仓库 `docs/research/repros/pi-upstream-audit-2026-10/` | 公开复现脚本 + README |
