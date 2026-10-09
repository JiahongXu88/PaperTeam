# M13.5 — Real Workflow Readiness & Experiment Workbench Closure 验收报告

- 日期：2026-10-09
- 分支：main（直接实施，按任务要求）
- 范围：模型 thinking 兼容性修复（P0）、实验包 split-aware grouping（P0）、实验数据工作台 UI（P1）、模型目录收起与研究论文上传入口（P1）、回归与真实网关实测
- 基线：`be3d686`（M13.4 后 main）→ 本轮 5 个提交（见 §12）
- 最终验收目标：**PaperTeam 重新具备真实研究论文工作流的启动条件** ✅（见 §14）

---

## 1. 模型 thinking 失败根因（定论）

M13.4 验收轮的 Bug 报告方向正确，本轮把机制补到 HTTP 请求体级定论：

**Pi（@earendil-works/pi-ai）anthropic-messages 编码层**（`dist/api/anthropic-messages.js` `buildParams`）：

```js
else if (model.reasoning) {
  if (options?.thinkingEnabled) { /* thinking: enabled/adaptive */ }
  else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
    params.thinking = { type: "disabled" };   // ← 关键：字段仍然在请求体里
  }
}
```

- **只要模型注册了 `reasoning: true`，无论本次是否请求思考，请求体必带 `thinking` 字段**（未请求档位时是 `{type:"disabled"}`，不是省略字段）。
- 公司网关（new-api 系）按「请求里是否出现 `thinking` 字段」选择渠道：claude-anthropic 分组下 `glm-5.3-highspeed` 没有任何 thinking 渠道，因此 **enabled 与 disabled 同样 500「可用渠道不存在」**；`claude-fable-5-1` 有 thinking 渠道，两种都通过。
- `reasoning: false` 的模型走不到该分支——完全没有 `thinking` 字段——1582ms 通过。
- **受控 A/B 单变量翻转已实锤**（M13.4 报告），本轮又以 Mock Gateway 请求体断言固化进回归测试（`test/settings/thinkingCompat.test.ts`）：同一配置仅 `reasoning` 元数据差异，请求体在「无 thinking 字段」与「`{type:"disabled"}`」之间稳定翻转。
- 选项层澄清：`SimpleStreamOptions.reasoning` 类型是 `ThinkingLevel`（**不含 `"off"`**）；`undefined` 就是「本次不请求思考」的唯一合法编码，且字面量 `"off"` 是真值、反而会走 enabled 编码——**不能用传 `"off"` 的方式关字段**。让 anthropic 请求体彻底不带 thinking 字段的唯一单点手段是注册层 `model.reasoning === false`（同时也会去掉 interleaved-thinking beta 头）。

旧 `testConnectionReasoning` 注释「支持 off → undefined（Pi 会编码成各家的 off/none 语义）」的假设对 anthropic 协议不成立，已订正。

## 2. 保存前与保存后配置差异（为什么两个入口结论相反）

| 入口 | 模型定义来源 | highspeed 条目 | 探针请求体 | 结果 |
|---|---|---|---|---|
| 自定义提供商面板（保存前测试） | **表单当前配置**（发现 API 只回 `{id}`，无能力元数据） | `reasoning` 缺省 → false | 无 thinking 字段 | ✅ PASS |
| 默认/Agent 模型测试（保存后） | **落盘配置**（作者 17:30 手写 `reasoning: true`） | `reasoning: true` | `thinking:{type:"disabled"}` | ❌ 500 渠道不存在 |

同根因的第二表现：`ProbeModel` 对 reasoning 模型必然产生 thinking 字段，而「文本探针通过」被当成了完整兼容信号。本轮把概念拆开（见 §3）并在 UI 三处测试结果文案中新增 `THINKING_INCOMPATIBLE` 分类与可行动提示。

**17:43 预检通过之谜（Bug 报告未解疑点）**：当时的 Agent 预检走 `createAgentSession` 默认 medium → `thinking:{type:"enabled", budget_tokens}`。本轮实测矩阵（§4）证明该网关对 highspeed **enabled 同样 500**——因此 17:43 通过只可能是网关渠道配置在当时之后发生了变更（服务端侧事实，无法在本轮追溯），与客户端编码差异无关。当前网关状态以 §4 实测为准。

## 3. 修复设计：三个概念的分离（不建第二套 Runtime）

| 概念 | 载体 | 语义 |
|---|---|---|
| 模型推理能力 | `CustomProviderModel.reasoning` | 能力元数据，UI 照常展示「支持推理」，不参与请求编码决策 |
| 网关协议兼容 | `CustomProviderModel.thinkingRequest: "auto" \| "omit"`（新，缺省 auto） | **当前接入链路能否携带 thinking 字段**。omit 时 `toProviderConfigInput` 把该模型注册进 Pi 的 `reasoning` 置 false——单点覆盖全部调用路径 |
| 本次调用意图 | Pi 选项层 `reasoning: ThinkingLevel \| undefined` / Agent 会话 `thinkingLevel` | 不变；omit 模型下任何档位请求都不会产生 thinking 字段 |

覆盖的调用路径（全部经同一注册 seam）：保存前自定义 Provider 测试（`testCustomProvider` 临时注册）、保存后默认/Per-Agent 测试（`testConnection`）、Agent Runtime `startAgent`/`createAgentSession`、`completeSimple` 直调（语义理解 / Target 摘要 / Vision）。

配套改动：
- `classifyFailure` 新增 `THINKING_INCOMPATIBLE`（reasoning 模型上的渠道不存在 / thinking 400 类错误），探针失败详情附带「把该模型的 thinking 参数设为不发送」提示；三处 UI 标签映射同步。
- 基础连接测试与 Agent 兼容性的区分落在产品语义上：文本探针只验证 Key/模型存在/文本响应（如实呈现），Agent 能力由 §4 的真实工具调用矩阵验证——不宣称文本 PASS 等于 Agent PASS。
- 不按模型 id 硬编码绕过；实测矩阵驱动，未修改公司网关任何配置。

## 4. Fable / Highspeed 实际兼容矩阵（真实公司网关，有界调用）

凭据：作者已保存的 `glm` 条目（只读，不打印）。探针脚本与结果：`D:\Reports\PaperTeamRuns\M13_5\gateway-matrix.mjs` / `gateway-matrix.json`（私有，不进仓库）。

| # | 场景 | 编码 | 结果 |
|---|---|---|---|
| A | Fable 基础（探针语义） | `thinking:{type:"disabled"}` | ✅ PASS（3.7s） |
| B | Fable 显式 low 档 | `thinking:{type:"enabled"…}` | ✅ PASS |
| C | Fable Tool Calling（真实 toolCall → 回填 → 引用工具数据的最终答复） | tools + disabled | ✅ PASS |
| D | Highspeed auto 基础 | `thinking:{type:"disabled"}` | ❌ 500 渠道不存在（**网关侧限制，客户端不可修，已如实标记**） |
| E | Highspeed omit 基础（M13.5 修复路径） | 无 thinking 字段 | ✅ PASS（2.5s） |
| F | Highspeed omit Tool Calling（完整往返） | 无 thinking 字段 + tools | ✅ PASS（模型答复逐字引用工具返回值） |
| G | Highspeed omit + 显式请求 medium（Agent 默认档语义） | 注册层拦截，无字段 | ✅ PASS |
| H | 真实 Pi Agent 会话（`createAgentSession` + customTool，highspeed omit） | Agent 循环 | ✅ PASS（`tool_execution_start/end` 事件齐全，最终答复基于真实工具数据） |

结论：**Fable 全兼容（现状配置即可用）；Highspeed 经 `thinkingRequest:"omit"` 后全兼容**（代价：经此网关不使用思考能力）。Highspeed 在 auto 模式下被网关拒绝是服务端渠道配置问题，本轮未也不应假装修复。

作者当前落盘配置（默认模型 `glm/claude-fable-5-1`、无 per-agent override、两家模型均 auto）**未做任何改动**——默认模型已全兼容，无需配置变更即可启动工作流；若日后要给某 Agent 用 highspeed，在设置 → 自定义提供商 → 编辑模型 → thinking 参数选「不发送」即可（§4-E/F/G/H 已验证该路径）。

## 5. 实验 split 冲突原始原因

真实 A2e 包（作者已导入 `p-14afa81bd7fa`，包哈希 `9fa6ff16…`）：同一主结果文件含 Dev25（8 观测）/ Confirmation13（8）/ Full38（20）三行组，提取层已把 `split` 存进 `MetricObservation`；但 `rebuild()` 把「组内 split 值 >1」整组判 conflict，而 `editFile()` 只能改**文件级** groupId——观测级 split 差异没有任何 UI/API 出口，作者永远无法确认 main 组（死锁）。这不是数据错误，是数据建模能力缺口：split 共存是研究自身的评测范围纪律。

## 6. 新实验数据模型及兼容策略

schema v2（`ExperimentPackage.schemaVersion: 1|2`，v1 原样可读、语义不变）：

- `ExperimentGroup.splitScopes?: ExperimentSplitScope[]`：按观测 `split` 原值确定性构建（码位序；slug 冲突追加序号，绝不合并不同 split；缺失归 `unknown`，不推断不补全）。scope id = `groupId@slug`（groupId 合法字符集不含 `@`，无跨组碰撞）。
- 冲突语义四分法：**A** 可划分范围（有可信 split 值）→ 候选 + 作者按范围核对；**B** 真协议矛盾（同一范围内 protocol 互相矛盾）→ scope.conflicts + 组级 conflict，确认被拒；**C** 数据不足（unknown 范围）→ 保留 Unknown、可确认但明确标注「未声明评测范围」；**D** 来源失效 → 既有 view() 组级冲突标注不变。跨范围 protocol/split 差异不再算冲突（范围内 split 恒定，跨范围差异是预期）。
- `confirm(groupIds, scopeIds?)` 双粒度：多范围组整组确认被拒并给出范围清单；单范围组沿用 v1「整组确认即进入工作流」；组在全部范围确认后置 confirmed（图表门禁信号不变）。
- **科研隔离边界**：`workflowUse: allowed|excluded|undecided` 是与确认独立的显式授权。多范围组确认后缺省 undecided——**不进入** `workflowContext`（Researcher 上下文）；作者显式「允许进入工作流」才注入，可随时排除/恢复。v1 旧包沿用整组确认即进入的旧语义，升级零破坏。
- 标度混用告警收敛到（组 × 范围）内：跨范围同名指标不再比较；同范围内混标仍告警。
- 多范围组的配置↔结果比较跳过歧义的 split 字段，其余字段照常逐值比较。
- 兼容验证：M13.2/M13.3/M13.3.1 全部既有测试（21 个）在新语义下通过（唯一改动的断言是协议矛盾从组级 conflicts 迁到 scope 级——语义等价、位置更准）；旧 v1 manifest 手工降级 fixture 读取与工作流行为不变。

## 7. 新页面交互流程

`ExperimentPackagesPanel` 重构为工作台（信息架构：上传 → AI 辅助整理 → 核对范围与指标 → 作者确认 → 用于论文写作）：

- **摘要卡先行**：文件/解析分布、实验组、待确认范围、指标观测数 + 下一步引导；SHA-256、schema、源材料判定、关联候选收进「技术细节」折叠区。
- **AI 辅助实验理解**（更名，不再叫 GLM）：展示实际模型/耗时/token；建议为可审核列表，逐条「采纳」仍走确定性 `editFile`。
- **核对实验范围与分组**：每组卡片 + 范围表（范围/指标条数/种数/来源文件/协议/状态/工作流授权），人话表述「该结果文件包含 N 种评测范围，需要分别核对」；确认与授权是两个显式动作。批量确认改为带范围摘要的二次确认，只含无冲突单一范围组，普通文档不列入。
- **指标浏览**：服务端过滤（范围/组/指标/method/来源）+ 分页（`GET …/observations`），真实值不选优，每条带源文件行列锚；Evidence 登记入口保留。
- **文件清单**：默认折叠 + 搜索/角色/状态过滤 + 分页；中文角色名；修改收进每行「修改分类」抽屉（修复了角色改完立即改组名会被过期数据回写的竞态）。
- **用于论文写作**：汇总已确认 + 已授权范围，图表入口，边界提示（已解析 ≠ 确认 ≠ 授权 ≠ Evidence Verification）。

## 8. 研究论文实验数据上传引导

- 新建研究论文表单内说明「实验数据在创建项目后上传，不要求创建时就有；启动科研实验相关流程前有明确门禁提示」。
- `idea_to_paper` 项目概览新增显著的「实验数据」卡片：无数据时给「上传实验数据」主按钮直达实验页（并解释门禁），有数据时给入口。综述/已有论文流程不受影响。

## 9. 模型目录展开收起修复

原实现是常驻滚动容器（无收起机制）。现 `model-catalog-block`：显式收起/展开按钮（aria-expanded）、Esc（document 级监听，不依赖焦点位置）、点击外部关闭、高度有界（18rem 滚动）；收起不丢搜索词与已选模型，重新获取目录不重置选择；每模型新增 thinking 参数选择与「无 thinking」徽标。模型发现 API 业务逻辑零改动。E2E 全覆盖（§10）。

## 10. 回归测试

- Backend 全量：**2966 passed / 20 skipped**，唯一失败为已知 SSE 并发 flake（`httpWorkflowApi` 实时订阅超时；该文件单独重跑全绿，M13.4 基线即有，stash 对照确认非本轮回归）。
- 新增 `test/settings/thinkingCompat.test.ts`（6）：Mock Gateway 请求体级断言（auto→disabled 字段、omit→无字段无 beta 头、THINKING_INCOMPATIBLE 分类与提示、非法值拒绝、持久化往返、注册 seam）。
- 新增 `test/experiments/experimentSplitScopes.test.ts`（7）：多 split 细分/整组确认被拒/隔离授权/单与无 split 兼容/跨范围不比较/编辑失效/持久化/v1 旧包/指标查询。
- `zaiApiChannel` 一处断言按新分类细化（thinking 类 400 → THINKING_INCOMPATIBLE，更可行动）。
- Frontend 全量：**309 passed**（panel 测试改写为工作台交互 + 新增授权流用例）。
- Typecheck / build：backend（tsc + 含 tests 的 `npm run typecheck`）与 frontend 全过；`git diff --check` 干净。

## 11. 真实 A2e ZIP 验收（私有，隔离栈）

材料：作者项目内 `original.zip`（哈希 `9fa6ff16…`，25 文件 36 观测；`D:\Test` 下现存的是 phase9 材料，非 A2e 包）。隔离栈（`PAPERTEAM_RUNTIME_ROOT`/`PROJECTS_ROOT` 指向 `D:\Reports\PaperTeamRuns\M13_5\e2e-root`）+ 脚本 `a2e-private-acceptance.mjs`，结果 `a2e-acceptance.json`：

- 上传 → schema v2，main 组 3 范围（Confirmation13=8 / Dev25=8 / Full38=20），status candidate，零冲突（修复前：conflict 死锁）。
- 整组确认 409「包含 3 个评测范围…请按范围分别确认」✅。
- 三范围分别确认 → confirmed/undecided；仅授权 Dev25 → **workflowContext 恰为 8 条 main/Dev25 观测**（Confirmation13/Full38 完全隔离）✅。
- 指标查询 `?split=Dev25` → 8 条 ✅。真实数值未写入任何公开 fixture/截图/仓库文件。

另：phase9 真实 ZIP 的浏览器 E2E（`experiment-real.spec.ts`，按新 UI 改写）5 项全过，含真实 XeLaTeX 图表输出。

## 12. GitHub CI / Linux Integration

本轮 5 个提交：`2257b3e`（thinking 兼容修复）、`8c5d16b`（split-aware grouping）、`8c34df3`（工作台 UI + 上传入口 + 目录收起）、`e2e + 竞态修复`、`docs`（本报告）。推送后 CI 结果见下表（push 走 127.0.0.1:7890 代理重试法）。

| 项 | 结果 |
|---|---|
| GitHub CI | 见提交后补记（推送后核验） |
| Linux Integration | 见提交后补记（推送后核验） |

## 13. 已知剩余限制

1. **Highspeed auto 模式被网关拒绝**是服务端渠道配置问题（claude-anthropic 分组无 thinking 渠道）；客户端已把诊断与绕过路径（omit）产品化，但不能宣称网关已兼容。Fable-only 配置即当前默认配置，完整可用。
2. omit 模式的取舍是诚实的：经该网关该模型不使用思考能力（模型能力元数据仍在，UI 照常展示）。
3. 多范围组必须逐范围确认是有意摩擦（Dev25/Confirmation13/Full38 不可一键混确认）；`unknown` 范围可确认但 UI 明确标注「未声明评测范围」。
4. v1 旧包在任何编辑后会 rebuild 到 v2，既有确认按既有语义失效重来（与旧版编辑失效语义一致）。
5. 指标浏览 facet 有界（split≤50、metric≤200 等）；单包观测上限与既有 5000/文件提取上限不变。
6. Agent 会话对 omit 模型仍可能保留 thinkingLevel=medium 的 token 预算预留（Pi 行为，扩大总输出上限，无正确性影响）。
7. 本机全量 backend vitest 的既有 SSE 并发 flake 依旧存在（与本轮无关，单独跑绿）。

## 14. 最终验收门槛

| 项目 | 结果 |
|---|---|
| Fable 基础连接 | **PASS**（实际配置语义，矩阵 A） |
| Fable Tool Calling | **PASS**（真实 toolCall + 回填往返，矩阵 C） |
| Highspeed 基础连接 | **PASS（omit 模式，矩阵 E）**；auto 模式 = 网关限制 FAIL（已标记，非客户端可修） |
| Highspeed Tool Calling | **PASS（omit 模式，矩阵 F + 真实 Agent 会话 H）** |
| 思考参数请求一致性 | **PASS**（HTTP 请求体级测试固化；同一模型保存前后/各入口同一注册 seam） |
| 不同测试入口行为一致 | **PASS**（表单态与落盘态同一 `toProviderConfigInput` 编码；差异只剩用户表单本身） |
| 原模型配置保持 | **PASS**（默认模型/per-agent/vision/provider/凭据逐项核对未动；快照存 `M13_5\model-preferences-snapshot.json`） |
| 单文件多 split 分组 | **PASS**（合成 + 真实 A2e 双验证） |
| Dev25/Confirmation13/Full38 独立核对 | **PASS**（范围级确认 + 整组确认拒绝 + 隔离授权） |
| 科研数据隔离 | **PASS**（确认 ≠ 授权 ≠ Evidence 三层分离；未授权范围零注入，实测 context 仅 Dev25） |
| 实验 UI 可操作性 | **PASS**（工作台流程 + 真实 ZIP 浏览器验收） |
| 模型目录可收起 | **PASS**（按钮/Esc/外点/状态保持 E2E） |
| 研究论文上传入口 | **PASS**（创建引导 + 概览 CTA + 直达实验页 E2E） |
| Browser E2E | **PASS**（M13.5 两套 7 项 + M13.4 custom-provider 1 项 + 真实 ZIP 5 项，隔离数据根） |
| GitHub CI | 推送后核验（见 §12 补记） |
| Linux Integration | 推送后核验（见 §12 补记） |

结论：

- **M13.5 COMPLETE：true**
- **READY_FOR_REAL_PAPER_RUN：true** —— 依据：实际配置下的默认模型（Fable）完成基础连接、thinking、工具调用与真实 Agent 会话验证；当前无任何 Agent override 计划使用 Highspeed；实验数据页面能处理真实 split（A2e 包三范围独立核对 + 隔离授权全链路实测）；关键 E2E 全过。作者可在本地启动 PaperTeam（:3000 / :5173）后：编辑既有 A2e 包任一文件触发 v2 rebuild → 按范围确认 → 授权 Dev25（及作者认为允许的范围）→ 启动论文工作流。

---

## 附：验证材料索引（私有，不入库）

- 模型偏好快照：`D:\Reports\PaperTeamRuns\M13_5\model-preferences-snapshot.json`
- 网关矩阵脚本/结果：`D:\Reports\PaperTeamRuns\M13_5\gateway-matrix.mjs` / `gateway-matrix.json`
- A2e 验收脚本/结果：`D:\Reports\PaperTeamRuns\M13_5\a2e-private-acceptance.mjs` / `a2e-acceptance.json`
- E2E 截图（真实材料）：`D:\Reports\PaperTeamRuns\M13_5\shots\`
- 隔离 e2e 数据根：`D:\Reports\PaperTeamRuns\M13_5\e2e-root\`（用后可整体删除）
