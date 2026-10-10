# M13.5.2 Agent Output Truncation Handling

## Scope

修复真实 Idea-to-Paper run（`p-14afa81bd7fa` / `w-b06991bbe160`，2026-10-10）在
`research.idea` 阶段的失败：Researcher 最终 JSON 被模型输出上限截断，却被当作
正常产出进入解析，报出误导性的「缺少非空字符串字段 domainOverview」，并按
transient 原样重试一次（再次截断），总计浪费 6.5 分钟与约 2.4M cache-read tokens。

## 复现与根因

run-trace 显示两次尝试的最后一个 `model.turn` 的 `stopReason` 都是 `length`，
`outputTokens` 都恰好是 8192。链路上三处叠加导致误报：

1. **Provider 配置**：自定义 Provider（公司 GLM 网关）里 `claude-fable-5-1` 的
   `maxTokens` 为保守默认值 8192，且未经上游验证（`metadataVerified` 缺省）。
   Pi 对自定义 anthropic-messages 模型走 budget-based thinking，默认档位 medium
   的 thinking 预算（8192）与正文共用 `max_tokens`，Pi 只保证正文至少 1024 tokens。
   Researcher 报告（plan + 需求 + 检索词 + 领域综述 + evidence + ≤30 条
   bibliography，中文）本身就接近或超过 8k tokens，必然截断。
2. **Runtime 终态归因**：`PiRuntimeAdapter` 只区分 `error` / `aborted`，
   `length` 被当作正常完成，截断文本作为 `completed` 任务的 output 返回。
3. **结构化解析回退**：`extractJsonObject` 在顶层 `{` 无法闭合后继续从后续
   `{` 回退匹配，于是抓到了 `plan` 嵌套子对象并成功解析，下游随即报
   「缺少 domainOverview」——错误信息指向了不存在的问题。

## 修复

- 新增 `AgentOutputTruncatedError`（`AGENT_OUTPUT_TRUNCATED`，HTTP 502）。
  Runtime 在最终 assistant 消息 `stopReason === "length"` 时 reject 该错误，
  不再把截断文本当产出；任务终态 `errorCode` 为 `OUTPUT_TRUNCATED`（与
  provider error 的 `RUN_FAILED` 区分）。错误消息携带模型标签与生效的
  `maxTokens`，并直接给出修复路径（提高「最大输出」或降低 thinking 档位）。
- Workflow 分类：`AGENT_OUTPUT_TRUNCATED` → `permanent`，首次失败即终止、
  不进入 transient 重试——原样重跑同一 prompt 只会再次撞上同一上限。
- `extractJsonObject`：顶层对象直到文本末尾未闭合时，视为确定性的截断信号，
  抛出「JSON 不完整（对象未闭合，疑似被模型输出上限截断）」，不再回退到
  嵌套子对象。说明文字里闭合的花括号仍按原逻辑跳过。
- 前端自定义 Provider 面板的「最大输出」增加说明：推理模型 thinking 与正文
  共用该上限，调研 / 写作等结构化长输出建议 ≥ 32768，过低会被截断导致任务失败。
- `docs/ARCHITECTURE.md` 终态归因补充 `length` 分支。

未改动：自定义 Provider 的 `maxTokens` 默认值仍为 8192（网关真实上限未知，
由用户在 Settings 中按上游能力确认），Pi 默认 thinking 档位不变。

## 验证

- `backend/test/agents/outputParsing.test.ts`（新增）：截断样本（含真实 run 形态的
  plan 子对象 + 被切断的 domainOverview）抛 json_parse 且消息不含
  `domainOverview`；深层嵌套截断同样判定不完整；围栏 / 说明文字 / 花括号占位符
  仍能正确提取。
- `backend/test/PiRuntimeAdapter.test.ts`：fake session 新增 `lengthStop` 行为，
  断言 `handle.result()` reject `AgentOutputTruncatedError`、消息含修复路径、
  任务终态 `OUTPUT_TRUNCATED`。
- `backend/test/workflow/WorkflowOrchestrator.test.ts`：stage 抛
  `AgentOutputTruncatedError` → attempts = 1、category = permanent、run 失败
  消息含 8192 与「最大输出」。
- 定向回归：outputParsing / reviewerRepair / WriterService / AgentServices /
  WorkflowOrchestrator / orchestratorHardening / PiRuntimeAdapter 共 199 项通过；
  backend 与 frontend typecheck 通过；frontend CustomProviderPanel 14 项通过。

## 用户侧操作

重新运行该项目前，需在「设置 → 模型 → 自定义 Provider」把 `claude-fable-5-1`
的「最大输出」提高到网关允许的值（建议 ≥ 32768；Claude 4+ 系列官方上限均不低于
32k），保存后再启动 workflow。若网关拒绝更大的 `max_tokens`，provider 会返回
明确的 400 错误，而不会再出现误导性的「缺少字段」。
