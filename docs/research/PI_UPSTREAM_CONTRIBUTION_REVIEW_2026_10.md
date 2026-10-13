# Pi Upstream Contribution Review — 2026-10

日期：2026-10-13　执行：Claude Code（Fable 5.1）　性质：Pi SDK 上游贡献深化研究（C1 独立复审、补丁重写、双平台验证、对抗式自审、Review Package）

**本轮零次公开投稿**：未创建 Issue / PR / Discussion / 评论，未推送任何 Pi 分支到公开远程。所有交付物标注 **REVIEW REQUIRED — NOT SUBMITTED UPSTREAM**，等待用户交 ChatGPT 独立审核后再决定是否投稿。

---

## 0. 裁决

**READY_FOR_CHATGPT_REVIEW**

| 项 | 结论 |
|---|---|
| Best Candidate | **C1**：`@earendil-works/pi-ai` `repairJson` 把 `"u"` 放在单字符合法转义集合里，使「`\u` 后非四位十六进制」的无效转义不被修复，工具调用参数整体坍缩为 `{}` 或**静默丢失**后续字段 |
| 上游状态 | main `7d75a0e3e`（2026-10-12 23:37 UTC）与 v1.2.0（2026-10-12 发布）均**未修复**；`json-parse.ts` 自 2026-04-21 `e58d631c8` 引入 `repairJson` 起从未改动；无等价 Issue / PR |
| 补丁形态 | 上一轮 `ab9c50d93`（+22 −3）**被推翻**，改为 **1 行源码 + 1 行注释**（`cf79153df`，base `7d75a0e3e`）+ 7 条回归测试 |
| 验证 | 修复前新测试 3 失败 / 4 通过 → 修复后 7/7；`npm run check` Windows + Linux exit 0；端到端矩阵 1.0.1 / 1.1.0 / 1.2.0 / main 四版本复现、补丁后 7 个 JSON 场景全部恢复；逐字符流式中间态与修复前**逐一相同**；对抗式独立审查 ACCEPT-WITH-NITS（已采纳） |
| Linux 全量 `./test.sh` | 未打补丁 main：**exit 0，0 FAIL**（上轮环境缺口已全部补齐）；打补丁：出现 2 条**与本补丁无关的既有 flaky 测试**，同机未打补丁隔离复跑同样以相同比例失败（§5.4，如实登记） |
| 其它候选 | C2（工具期 abort）：main 仍复现，PR #8635 仍开放且仍与 main 在 `lazy.ts` 冲突，不另起 PR；C3（SDK 路径 HTTP idle timeout）：代码未变，上游 #9976 以「AI 生成」被关、#9787 开放无回应，降为低优先级文档项；未发现比 C1 更值得提交的新候选 |

一句话：**C1 从「可投稿」打磨为「可经受严肃 Code Review」**——更小（1 行）、有证明（差分 + 77 万输入 fuzz 零回归、流式中间态零变化）、有诚实的测试账本。

---

## 1. 基线

| 项 | 值 |
|---|---|
| PaperTeam | `main` @ `a8b957f054e8ef41009653ca3f20ea9ee03074e6`（本轮起点，clean） |
| PaperTeam Pi 依赖 | 1.0.1（未动，本轮不升级） |
| Pi 上游 main | `7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6`（比上轮 `148622bc6` 新 34 个提交；其间发布 **v1.2.0** = `06a466935`；npm `latest` 1.2.0） |
| 34 个新提交与本研究的交集 | 零：`packages/ai/src/utils/json-parse.ts`、`lazy.ts`、`sdk.ts`、`http-dispatcher.ts`、`model-runtime.ts`、`agent-loop.ts` 均无变化；`d4d53612b`（Anthropic strict tool 回退）只改 `anthropic-messages.ts` |
| 独立 Pi checkout | `D:\PaperTeamData\PiUpstreamAudit\pi-upstream`，新分支 `audit/json-repair-invalid-unicode-escape-v2`（origin/main 起），`npm ci --ignore-scripts` + `npm run build:offline` |
| 服务器 | 新加坡 ECS（与上轮同一台，地址见私人日志），TCP 22 可达，沿用既有密钥与 host key；`~/pi-upstream-audit/pi` 切到 `audit/json-repair-invalid-unicode-escape-v2`/`-v3`（origin/main 起）重装重建；docker `paperteam-backend-1` / `paperteam-web-1` 全程未触碰 |
| 服务器新增（仅用户空间） | `~/.local/bin/{rg,fd}`（GitHub release 静态二进制）、`~/.cargo` + rustup 1.96.0（`--no-modify-path`，按 `packages/env/daemon/rust-toolchain.toml`）、`packages/env/daemon/target/debug/pi-env`（`npm run build:daemon`） |
| 付费模型调用 | 0 次 |

---

## 2. 第一阶段：C1 独立复审（像 Reviewer 一样回答十个问题）

### 2.1 根因重述与「是否 Pi 的 Bug」

`repairJson` 的既有策略是「doubling backslashes before invalid escape characters」：模型忘记双写反斜杠时，把 `\c` 修成 `\\c`，让 `JSON.parse` 得到字面反斜杠。代码里 `\u` 有专门分支：后四位全是十六进制则保留；否则**落到** `VALID_JSON_ESCAPES.has("u")` 分支原样保留。于是那段四位十六进制检查对输出而言是**死代码**（匹配与否结果一样，只差 `index` 步进）。这足以证明原作者意图是「非十六进制的 `\u` 应按无效转义处理」，`"u"` 在集合里是疏漏，不是设计。调用者（模型）确实违约，但 `repairJson` 的存在就是为了修这类违约，并且对其它 25 个字母都修了——不一致性在 Pi 内部。

### 2.2 最新 main 是否已修复

否。`git log origin/main -- packages/ai/src/utils/json-parse.ts` 只有 4 个历史提交，最新 `e58d631c8`（2026-04-21）；v1.2.0 的 npm 包实测同样复现（§4.2）。

### 2.3 partial-json 的降级语义（本轮最关键的新事实）

读 `partial-json@0.1.7` 源码并实测：`parseStr` 对**完整但含无效转义**的字符串抛 `MalformedJSON`，而 `parseObj` / `parseArr` 把所有异常 `catch` 后 `return obj`（`Allow.OBJ`）→ **不抛错，返回出错键之前的对象**。对**未闭合**的字符串，先尝试补引号 `JSON.parse`，失败则从 `lastIndexOf("\\")` 截断——所以 `caf\u00` 截断得 `caf`，`\d` 截断得 `""`。

推论：`parseStreamingJson` 第 2 层 `partialParse(original)` 对任何对象/数组输入**都不会抛**，第 3 层 `partialParse(repairJson(x))` 对工具参数形态**不可达**。上轮补丁里「`\u` 后不足四位且全为十六进制则保留」的分支，正是只在第 3 层才可能被观察到的——它是**不可观察的死分支**。

### 2.4 旧补丁复审结论

| 问题 | 结论 |
|---|---|
| 是否符合 `repairJson` 既有设计 | 是，但多余：移除 `"u"` 本身即让非十六进制 `\u` 走既有「无效转义」分支 |
| 是否错误改变合法 JSON | 否（两版都不会） |
| 是否改变 Streaming 中途状态 | 否——但旧补丁为此多写的分支并无作用（§2.3） |
| 是否存在更小实现 | **是**：删掉集合里的 `"u"`，1 行 |
| 测试是否覆盖真正边界 | 旧版 11 条中 2 条测的是不可观察分支；新版 7 条，去掉冗余层，补 Windows 路径、`\\u0041`、`x\u00"` 边界 |

**处置：推翻旧补丁，改写为最小实现。**

### 2.5 新补丁

```diff
-const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
+// `\u` is not listed: it is only valid with four hex digits, which repairJson checks separately.
+const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
```

commit `cf79153df`（Windows 研究分支）/ Linux `git am` 同一 patch；`git format-patch --base=7d75a0e3e`，sha256 `8f36bf68…3455d9`。提交信息 `fix(ai): treat \u without four hex digits as an invalid escape in repairJson`，正文按 AGENTS.md「问题 → 具体例子 → 方案」写法，含 LaTeX 与 `C:\users\x` 两类例子。

### 2.6 十类输入的逐项结论

| 输入类型 | 修复前 | 修复后 |
|---|---|---|
| `\url` `\usepackage` `\underline` `\uline` `\upshape` | 字段丢失 / `{}` | 字面反斜杠保留 |
| `\u12G4`（3 位十六进制 + 非十六进制） | `{}` | `\\u12G4` |
| 完整字符串末尾 `x\u` `x\u12` `x\u00` | `{}` | 字面 `x\u…` |
| 合法 `\u00e9` `\u2014` | 不变 | 不变 |
| 代理对 `\ud83d\ude00` | 不变 | 不变 |
| 已正确双写 `\\url` `\\u0041` | 不变 | 不变 |
| 混合合法与非法（`a\tb \cite{x} \url{y} \"q\" \u00e9`） | `{}` | 全部正确 |
| 属性名中的 `\u`（`{"te\ut":"v","next":1}`） | `{}` | 键为 `te\ut`，`next` 保留 |
| 故障后的后续字段（`a`,`b`,`c`,`d`） | 只剩 `a` | 全部保留 |
| 逐 Token 流式：所有中间前缀 | — | **与修复前逐一相同**（§4.3） |

明确区分的两种语义：**最终完整 JSON** 的修复语义改变（且只对此前必然解析失败的输入）；**流式未完成** 的容错语义零变化（第 2 层始终解析原文）。

---

## 3. 第二阶段：三类证据

### 3.1 纯函数差分（`review/differential-repair.mjs`）

三个变体（A 上游 / B 本补丁 / C 旧补丁）× 20 条语料 × 全部 588 个前缀，经 Pi 原样的 `parseJsonWithRepair` / `parseStreamingJson` 包装：

- A vs B：**12 处差异，全部是完整输入**（即修复目标）；中间前缀 0 差异。
- B vs C：**0 差异**；partial-json 在 588 个前缀上抛错 0 次 → 第 3 层不可达，旧补丁多余分支无法被观察。

### 3.2 Standalone Tool Call（公开 SDK + 进程内 fake SSE server，无凭据）

| 场景 | 1.0.1 / 1.1.0 / **1.2.0** / main（未打补丁，Win + Linux 一致） | main 打补丁（Win + Linux 一致） |
|---|---|---|
| `note-url` | 工具未执行，`Validation failed for tool "add_note"` | `{"text":"See \\url{…}"}` → `noted (35 chars)` |
| `note-u-short` | 工具未执行 | `{"text":"x\\u12"}` |
| `tex-usepackage` | `{"path":"main.tex"}` → `wrote main.tex (NO CONTENT)` | `content` 46 字符保留 |
| `note-cite` / `tex-cite` / `note-valid` / `note-u-valid` | 正确 | 不变 |
| `abort-slow-tool`（C2 对照） | `stopReason=error` | 不变 |

验证维度：工具实收参数（`tool_execution_start.args`）、必填字段、schema 验证路径、`message_end` 中的 `toolCalls.arguments`、工具结果文本、终态 `stopReason`。

**Anthropic 路径**：在 checkout 内临时写了一个与上游 `anthropic-sse-parsing.test.ts`「repairs malformed SSE JSON and malformed streamed tool JSON」同构的测试（`input_json_delta` 三段，`\usepackage`）：上游文件 → 失败（`content` 缺失）；补丁 → 通过。测试文件随后删除，副本存于 `review/evidence/tmp-anthropic-invalid-u.test.ts`（evidence only，不进补丁）。

### 3.3 逐字符流式中间态（新增 `*-chars` 场景，驱动器新增 `intermediateArgs` 记录）

- `note-url-chars`：1.2.0 与补丁 main 的中间态序列**完全相同**（`{}` → `{"text":""}` → … → `{"text":"See "}` → `{}`，`\u` 到达即坍缩，与今天 `\c` 的行为一致）；补丁只多出最后一个完整态。
- `tex-usepackage-chars`：12 个中间态相同，补丁多出最终完整对象。
- `note-u-valid-chars`（`\u00e9` 被切成多段）：两者 9 个态相同，从未闪成字面反斜杠。

### 3.4 跨版本 / 跨平台

| | 1.0.1 | 1.1.0 | 1.2.0 | main 7d75a0e3e | main 补丁 |
|---|---|---|---|---|---|
| Windows 11 / Node 22.22.3 | 复现 | 复现 | 复现 | 复现 | 修复 |
| Ubuntu 24.04 / Node 22.20.0 | 复现（上轮） | 复现（上轮） | — | 复现 | 修复 |

无 ALREADY_FIXED_UPSTREAM 情形。

---

## 4. 第三阶段：上游质量标准

| 项 | Windows | Linux |
|---|---|---|
| 新测试（修复前） | 3 failed / 4 passed | — |
| 新测试 + 相邻（`anthropic-sse-parsing` / `assistant-message-frame` / `openai-responses-partial-json-cleanup`） | 全部通过 | 全部通过 |
| `npm run check`（biome / pinned-deps / runtime-deps / ts-imports / entry-graphs / install-lock / tsc / browser-smoke） | exit 0，biome 零改写 | exit 0 |
| `./test.sh` 全量（未打补丁 main） | 未跑（见下） | **exit 0，0 FAIL** |
| `./test.sh` 全量（打补丁） | 未跑 | 见 §5.4 |

Windows 未跑全量 `./test.sh`：开发 shell 中存在 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`（Claude Code 自身），上游规则禁止在有 provider 环境变量时跑全量 vitest；Linux 为全量平台。

上轮 Linux 失败的真因与收口：
- grep / find 15 条：`rg` / `fd` 缺失（`ensureTool` 需从 GitHub 下载，test.sh 的隔离 HOME 下每次重下且失败）→ 用户空间安装到 `~/.local/bin`（test.sh 保留 PATH）。
- `pi-env` 6 个文件：**不是 sshd / PTY**，日志实为 `Build the daemon first: npm run build:daemon in packages/env`（Rust daemon 未构建）；`ssh.test.ts` 本就 `describe.skipIf(sshd === undefined)` 并自起一次性 sshd 于 localhost。装 rustup 1.96.0 到 `~/.cargo`（不改 shell profile），`cargo build --locked` 成功。
- 结果：未打补丁 main 的 `./test.sh` 全绿。

---

## 5. 第四阶段：其它候选

### 5.1 C2（工具期 abort → `stopReason="error"`）

- main `7d75a0e3e` 与 1.2.0 仍复现（`abort-slow-tool`：`error` / `This operation was aborted` / `agent_settled.aborted=true`）。
- PR #8635：OPEN，`mergeable: CONFLICTING`，最后活动 2026-09-29；`git merge-tree origin/main pr-8635` 仍只在 `packages/ai/src/api/lazy.ts` 冲突（`createSetupErrorMessage` 的 `timestamp` 参数），`models.ts` / `model-runtime.ts` / `provider-composer.ts` 自动合并。#8409 已 `lgtm`。
- 处置不变：不开竞争 PR；`agent_settled.aborted` 可作旁路终态判据（1.1.0+）。

### 5.2 C3（SDK 路径 HTTP idle timeout）

- 代码零变化（`sdk.ts` / `http-dispatcher.ts` / 调用点与 `docs/settings.md` 第 125 行「HTTP header and body idle timeout」同上轮）。
- 新对照的上游条目：**#9976**（2026-09-23，与 C3 几乎同一发现「SDK timeout 只覆盖 time-to-headers、undici body idle 被 SSE keepalive 击穿」）被维护者以「very hard to read this issue. no AI generated issues please」关闭；**#9787**（2026-09-20，OPEN 无维护者回应）指出仅 import SDK 就会让 pi 内嵌的 undici 在模块加载时把默认 `Agent` 装成进程全局 dispatcher——这与本轮/上轮观察到的「SDK 路径 body 空闲只受 undici 默认 300s 约束」一致，并补全了机制。
- 处置：维持 DOCUMENTATION_OPPORTUNITY，**优先级下调**；若投稿，必须由用户本人以极短篇幅写，否则重蹈 #9976。本轮不再投入。

### 5.3 新候选搜索

检索 2026-10-12 之后新 Issue（json / escape / tool arguments）与 open PR（#9461 defer streamed tool argument parsing、#9569 coerce JSON-encoded arguments）：无与 `json-parse.ts` 重叠者，无比 C1 更小更确定的候选。资源集中于 C1。

### 5.4 诚实登记：打补丁后 Linux `./test.sh` 的两条失败

打补丁树两次全量运行均 exit 1，失败集合相同：

| 测试 | 现象 | 隔离复跑（补丁） | 隔离复跑（**未打补丁** pi-ai 源码 + 重建 dist，同机） | Windows（补丁） |
|---|---|---|---|---|
| `packages/ai/test/radius-oauth.test.ts` › exchanges the browser callback code… | 30s 超时 + 未处理 `fetch failed / other side closed`（本地 OAuth 测试服务器） | 3/3 通过 | 3/3 通过 | — |
| `packages/coding-agent/test/auth-storage.test.ts` › keeps a coalesced reload alive… | 得到 `old` 而非 `new`（锁 / 重载竞态） | 5 次中 **3 次失败** | 5 次中 **3 次失败** | 3/3 通过 |

两个文件都不导入 `json-parse`；失败率与补丁无关；上游 CI 在 `7d75a0e3e` 为 success，但同日 `235e8886f` 为 failure、多条 cancelled。结论：**既有 flaky**，未打补丁的全绿是运气。按要求不跳过、不改断言。最终 v3 补丁（Linux `dc32372af`）第三次全量：`pi-ai` 整包全绿（145 文件 / 1349 测试，含 `radius-oauth`），仅 `auth-storage` 一条再次失败；完整账本见 `review/evidence/linux-test-sh-summary.txt`。

---

## 6. 第五阶段：投稿规则核查（CONTRIBUTING.md / AGENTS.md / `.github` @ 7d75a0e3e）

| 规则 | 事实 |
|---|---|
| 新贡献者 Issue 与 PR 默认自动关闭（`issue-gate.yml` / `pr-gate.yml` 读取 `.github/APPROVED_CONTRIBUTORS`，405 行，用户不在其中） | 必须先开 Issue |
| `lgtmi` 只放行后续 Issue；**`lgtm` 才放行 PR**；命令须在回复开头（可前置 @mention）或结尾 | PR 前必须拿到 `lgtm` |
| Issue 模板只有 Bug Report / Contribution Proposal / Package Report；`blank_issues_enabled: false` | C1 用 **Bug Report**（What happened / Steps / Expected / Version） |
| 一屏以内、**本人口吻**（禁 LLM 生成；若用须以明确标注的评论跟进）、说明是否愿意自己修 | Issue 文本必须由用户自己写；本报告只给事实提纲 |
| 周五至周日不保证审阅 | 2026-10-13 周二 |
| PR 前 `npm run check` + `./test.sh` 必须通过 | check 双平台通过；test.sh 见 §5.4 |
| 不改 CHANGELOG（维护者加） | 未改 |
| 提交信息 `fix(ai): …`；AI 发的评论末尾加免责行；回归测试旁注 Issue 号 | 已按格式；Issue 号待有后补 `// #NNNN` |
| Git：只 add 自己的文件，禁 `add -A` / `reset --hard` / `stash` / `checkout .` / `--no-verify`；不随意 `npm run build` / `npm test` | 遵守（研究克隆内为了 harness 跑了 `build:offline` 与 `./test.sh`，与上轮同样登记） |
| 自动化刷 Issue 永久封禁 | 本轮零投稿 |
| 无 PR 模板文件 | PR 描述自拟（草稿见 Review Package §10） |

---

## 7. 第六阶段：Reviewer-style 自审（15 问）

1. **Bug 是否真实？** 是：5 行脚本对 npm 1.2.0 直接复现（`parseStreamingJson` 是 `@earendil-works/pi-ai` 公开导出）。
2. **为什么属于 Pi？** `repairJson` 对所有其它字母修复同类错误，唯独 `\u` 不修，且其专用分支因 `"u"` 在集合里成为死代码。
3. **是否已被上游修复？** 否（main 7d75a0e3e / v1.2.0）。
4. **哪个版本首次出现？** `e58d631c8`（2026-04-21）引入 `repairJson` 时即如此；本轮实证 1.0.1 / 1.1.0 / 1.2.0 / main。
5. **Patch 是否最小？** 1 行源码（+1 行注释）。替代写法（保留 `"u"`、在 `\u` 分支加 else 双写）3 行且重复 fall-through。
6. **是否引入新状态或分支？** 否。
7. **非必要抽象？** 无。
8. **是否破坏正常调用者？** 否：`repairJson` 只在 `JSON.parse` 失败后运行；差分 + fuzz 对此前成功输入零差异。
9. **是否破坏 Streaming？** 否：第 2 层解析原文；588 前缀 + 77 万 fuzz 零中间态差异；逐字符 e2e 序列相同。
10. **更简单实现？** 无。
11. **回归测试边界是否充分？** 7 条覆盖 LaTeX / Windows 路径 / 3 位十六进制 / 不足四位 / 属性名 / 合法与代理对与已双写 / 后续字段 / 流式截断。
12. **能否构造反例击穿？** 对抗式审查找到的唯一「变差」是**完整**载荷里模型自己截断了真实转义（`{"a":"caf\u00e","b":1}`：旧 `{}` → 新字面 `caf\u00e`）。这是 `\c`/`\x` 等既有同策略，且只影响此前就解析失败的输入；登记为 known trade-off，不改。
13. **是否覆盖已有类似测试？** 上游 `anthropic-sse-parsing.test.ts` 已测 `\H`，未测 `\u`；本补丁不改该文件，新增单元测试文件。
14. **最小复现是否不依赖 PaperTeam？** 是（5 行 + 公开 harness）。
15. **是否满足上游规则？** 代码与测试满足；流程上缺用户本人的 Issue 与 `lgtm`。

**独立对抗式审查**（独立子代理，新上下文，读源码 + 自建 77 万输入前缀 fuzz）：verdict **ACCEPT-WITH-NITS**。SHOULD-FIX「测试里有 emoji 字面量（AGENTS.md 禁 emoji 入代码）」→ 已改为 `\u{1f600}`；建议「`C:\users\x` 比 LaTeX 更有说服力」→ 已加入测试与提交信息；NIT「三处同层冗余断言」→ 已裁（9 → 7 条）并补 `\\u0041`、`x\u00"` 边界；NIT「注释可更短」→ 未采纳（保留以防有人把 `"u"` 加回去）。修改后重新 `npm run check` exit 0、测试 7/7、未打补丁 3 失败。

---

## 8. Review Package

`docs/research/repros/pi-upstream-audit-2026-10/review/`（全部脱敏、无凭据、不含 Pi 仓库副本）：

- `README.md`：身份（SHA / 版本 / sha256）、问题定义、5 行最小复现、修复前后结果、完整 Diff、测试说明、行为变化清单、回归分析与 known trade-off、规则核查、相似 Issue/PR、未通过测试及原因、投稿策略、给审核者的问题、独立审查摘要。
- `0001-fix-ai-treat-u-without-four-hex-digits-as-an-invalid.patch`（`git format-patch --base=7d75a0e3e`）。
- `json-parse.test.ts`（与补丁内相同）。
- `differential-repair.mjs` + 输出。
- `evidence/`：Windows / Linux 矩阵、逐字符中间态、vitest 日志、check 日志、Anthropic 路径 evidence 测试、Linux test.sh 账本。

公开 harness 同步更新：`fake-openai-server.mjs` 新增 3 个 `*-chars` 场景；`run-scenario.mjs` 新增 `intermediateArgs`；`README.md` 加 review 入口。

---

## 9. 尚存风险

1. **投稿门槛**：Issue 必须用户本人口吻、一屏内；`lgtm` 不保证给出（#9976 的前车之鉴是 AI 味文本直接被关）。
2. **Known trade-off**（§7 第 12 问）：完整载荷内被模型截断的真实 `\u` 转义，从「丢字段」变为「字面垃圾」；与既有策略一致，但 reviewer 可能追问。
3. **测试文件位置**：维护者可能更想把断言并入 `anthropic-sse-parsing.test.ts` 而非新建文件；两种都可辩护。
4. **Linux flaky**：`auth-storage` / `radius-oauth` 若在上游 CI 也抖动，PR 需如实点名而非重跑掩盖。
5. **`\uXXXX` 碰巧十六进制**（`\udead`、`\uabcd`）仍被当作转义——本层无法区分，补丁未改、未声称解决。
6. PaperTeam 生产仍 pin 1.0.1；C1 进入发布版前，`record_evidence.quote` 等自由文本参数含 `\u…` LaTeX 时仍会整体被判 schema 错误（上轮登记项 7），可在 prompt 要求双写反斜杠。

---

## 10. 推荐下一步

1. 用户把 `review/README.md`（或本报告的 GitHub 链接）交 ChatGPT 独立审核，重点请其回答 README §11 的六个问题。
2. 审核通过后，用户以自己的话开 Bug Report Issue（事实提纲 README §10 第 1 条），加 `pkg:ai`，等待 `lgtm`。
3. 拿到 `lgtm` 后：在测试里补 `// #<issue>`，从研究分支推送、开 PR（提交信息即 PR 正文 + known trade-off + 测试账本）。
4. C2：可选在 PR #8635 下用本人口吻补「1.2.0 / main 7d75a0e3e 仍复现、`lazy.ts` 冲突点」；C3 暂不动。
5. PaperTeam：待 C1 进入 Pi 发布版本后再评估升级（届时跑 `PiRuntimeAdapter.test.ts` 全套 + 1 个真实 smoke）。

---

## 11. 产物与坐标

| 路径 | 内容 |
|---|---|
| 本仓库 `docs/research/PI_UPSTREAM_CONTRIBUTION_REVIEW_2026_10.md` | 本报告 |
| 本仓库 `docs/research/repros/pi-upstream-audit-2026-10/review/` | Review Package（§8） |
| 本仓库 `docs/research/repros/pi-upstream-audit-2026-10/{fake-openai-server,run-scenario}.mjs` | 公开 harness（含新场景） |
| `D:\PaperTeamData\PiUpstreamAudit\pi-upstream` | 分支 `audit/json-repair-invalid-unicode-escape-v2` @ `cf79153df`（旧分支 `audit/json-repair-invalid-unicode-escape` @ `ab9c50d93` 保留对照） |
| `D:\PaperTeamData\PiUpstreamAudit\patches\v3\` | 最终 patch；`v2\` 为 emoji 修正前版本 |
| `D:\PaperTeamData\PiUpstreamAudit\harness\results-v2\`、`results-differential-repair.txt`、`*-v2-*.log`、`server-*.log` | 原始结果与日志 |
| 服务器 `~/pi-upstream-audit/{pi,harness,0001-v2.patch,0001-v3.patch,test-sh-*.log}` | Linux 镜像（分支 v2 @ `eb8e28f00`、v3 @ `dc32372af`） |
| `D:\PaperTeamData\PiUpstreamAudit\harness\versions\v1.2.0` | 新增 1.2.0 npm 安装 |

不进仓库：Pi 源码、node_modules、原始 JSON 结果、服务器日志全文。
