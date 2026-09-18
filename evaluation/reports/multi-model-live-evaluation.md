# Multi-model Live Evaluation — Evidence Grounding（M6.9.3）

- 问题：Plain LLM 的 citation hallucination 是否跨模型族普遍；Evidence Pipeline 能否跨模型阻断错误证据
- protocol：scenario `g1-rag-survey` × 2 臂 × 每臂 5 提案（与 M6.9.1 / M6.9.2.1 逐项一致）
- dataset：claude-compatible（M6.9.2.1 派生集；因 Claude 通道 bio 过滤，全批统一用该变体消除数据集混杂）
- execution：serial（模型间停 4000ms；单模型失败不终止批次）
- judge：**same-model per target**——每个模型的 judge 与生成模型同体（same-model judge bias，见 Limitations）
- run: 2026-09-18T10:11:33.917Z → 2026-09-18T10:21:39.993Z（606s）

## Model Matrix

| model | provider | family | ArmA fabricated | ArmB fabricated | ArmB intercepted | ArmB verified | error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-fable-5-1 | gw-anthropic | anthropic | 5 条 100.0% | 0.0%（leak 0） | -（无捏造） | 60.0% | 0 |
| gpt-5.4 | gw-openai | openai | 5 条 100.0% | 0.0%（leak 0） | -（无捏造） | 80.0% | 0 |
| GLM-5.3 | gw-anthropic | glm | 5 条 100.0% | 0.0%（leak 0） | -（无捏造） | 80.0% | 0 |
| deepseek-v4-pro | gw-anthropic | deepseek | 5 条 100.0% | 0.0%（leak 0） | -（无捏造） | 80.0% | 0 |
| qwen3.7-max | gw-anthropic | qwen | 5 条 100.0% | 0.0%（leak 0） | -（无捏造） | 80.0% | 0 |
| **aggregate（completed 5/5）** | - | - | 25 条中 25 fabricated | 0 条 fabricated | -（无捏造） | 19/25 | 0 条 |

## 每模型明细

### claude-fable-5-1（gw-anthropic/claude-fable-5-1，anthropic-messages）

- status: completed
- judge: same-model（gw-anthropic/claude-fable-5-1）
- modelCalls: 7，duration: 369s
- Arm A: proposals=5，fabricated=100.0%，misattributed=0.0%
- Arm B: pipelined=5，fabricated（机械口径）=0，dispositions={"verified":3,"metadata_mismatch":2}，fabricatedLeaked=0
- 原始报告：`D:\Projects\PaperTeam\evaluation\reports\multi-model\claude-fable-5-1-exp1.json`

### gpt-5.4（gw-openai/gpt-5.4，openai-completions）

- status: completed
- judge: same-model（gw-openai/gpt-5.4）
- modelCalls: 7，duration: 25s
- Arm A: proposals=5，fabricated=100.0%，misattributed=0.0%
- Arm B: pipelined=5，fabricated（机械口径）=0，dispositions={"verified":4,"metadata_mismatch":1}，fabricatedLeaked=0
- 原始报告：`D:\Projects\PaperTeam\evaluation\reports\multi-model\gpt-5.4-exp1.json`

### GLM-5.3（gw-anthropic/GLM-5.3，anthropic-messages）

- status: completed
- judge: same-model（gw-anthropic/GLM-5.3）
- modelCalls: 7，duration: 84s
- Arm A: proposals=5，fabricated=100.0%，misattributed=0.0%
- Arm B: pipelined=5，fabricated（机械口径）=0，dispositions={"verified":4,"metadata_mismatch":1}，fabricatedLeaked=0
- 原始报告：`D:\Projects\PaperTeam\evaluation\reports\multi-model\GLM-5.3-exp1.json`

### deepseek-v4-pro（gw-anthropic/deepseek-v4-pro，anthropic-messages）

- status: completed
- judge: same-model（gw-anthropic/deepseek-v4-pro）
- modelCalls: 7，duration: 67s
- Arm A: proposals=5，fabricated=100.0%，misattributed=0.0%
- Arm B: pipelined=5，fabricated（机械口径）=0，dispositions={"verified":4,"metadata_mismatch":1}，fabricatedLeaked=0
- 原始报告：`D:\Projects\PaperTeam\evaluation\reports\multi-model\deepseek-v4-pro-exp1.json`

### qwen3.7-max（gw-anthropic/qwen3.7-max，anthropic-messages）

- status: completed
- judge: same-model（gw-anthropic/qwen3.7-max）
- modelCalls: 7，duration: 46s
- Arm A: proposals=5，fabricated=100.0%，misattributed=0.0%
- Arm B: pipelined=5，fabricated（机械口径）=0，dispositions={"verified":4,"metadata_mismatch":1}，fabricatedLeaked=0
- 原始报告：`D:\Projects\PaperTeam\evaluation\reports\multi-model\qwen3.7-max-exp1.json`

## Aggregate Analysis

- Plain LLM（Arm A，无库自报）：可测模型 5/5 中 5 个产生至少一条 fabricated quote（quote 不在所声称来源）——逐模型捏造率：claude-fable-5-1 100.0%、gpt-5.4 100.0%、GLM-5.3 100.0%、deepseek-v4-pro 100.0%、qwen3.7-max 100.0%。在 evaluated models 范围内，citation hallucination 不局限于单一模型族。
- Evidence Pipeline（Arm B，全文提案 + 三段核验）：全文在场条件下，completed 模型的全部 25 条提案 quote 均逐字命中所声称来源（机械 fabricated 0）——本批没有需要拦截的捏造 quote，quote 拦截路径未被触发（不能据此声称「拦截有效」，只能说无泄漏：fabricated 泄漏为 verified 0 条）。管道本批实际拦截的是 metadata 陷阱：metadata_mismatch 6 条（年份错位，Stage 2 权威记录裁决），全部未转正。对照 Arm A：25/25 条 fabricated 未经任何核验直接入池。最终转正 19/25（76.0%）。
- 模型差异（Arm B 逐模型）：claude-fable-5-1 v=60.0%/leak=0；gpt-5.4 v=80.0%/leak=0；GLM-5.3 v=80.0%/leak=0；deepseek-v4-pro v=80.0%/leak=0；qwen3.7-max v=80.0%/leak=0。差异主要体现在引用复制精度（quote_mismatch）与 metadata 陷阱敏感度（metadata_mismatch），而非拦截有效性——这与三段核验中前两段为确定性机械核验的设计一致。

## Gateway 模型目录（扫描快照）

- GET https://api-gateway.glm.ai/v1/models（Bearer） @ 2026-09-18T18:00:00+08:00，共 32 项
- 网关不提供：provider 归属（owned_by 恒为内部值）；context window——family 按 id 前缀推断，context window 以运行配置（200k）为准

- anthropic: claude-fable-5-1、claude-opus-5、claude-fable-5-cc（-cc = Claude Code 专用通道，裸 Messages 请求 400（M6.9.2 实测），不适合普通 chat）、claude-sonnet-5-cc（-cc 通道，同上）、claude-opus-4-6-cc（-cc 通道，同上）、claude-opus-4-7-cc（-cc 通道，同上）、claude-opus-4-8-cc（-cc 通道，同上）、claude-sonnet-4-6-cc（-cc 通道，同上）、claude-haiku-4-5-20251001-cc（-cc 通道，同上）
- openai: gpt-5.3-codex、gpt-5.4、gpt-5.4-mini、gpt-5.4-pro、gpt-5.5、gpt-5.5-vibe、gpt-5.6-sol、gpt-5.6-sol-vibe、gpt-5.6-sol-flex、gpt-5.6-terra、gpt-5.6-luna、gpt-6-astra、gpt-6-astra-vibe、gpt-6-astra-flex
- glm: glm-5.2、GLM-5.3
- deepseek: deepseek-v4-pro、deepseek-v4-flash
- qwen: qwen3.7-max、qwen3.8-max（目录在列但当前凭据无权限（2026-09-18 实测 AccessDenied.Unpurchased，两种协议均拒））
- kimi: kimi-k2.7-code-highspeed、kimi-k3
- grok: grok-4.6

## Limitations

- 样本规模有限：每模型 1 场景 × 每臂 5 提案，比例指标不具统计效力（方向性证据，非显著性检验）
- scenario 有限：仅 g1-rag-survey（RAG 综述域），未覆盖其他领域
- same-model judge bias：judge 与生成同模型（报告显式标记），verifiedRate 跨模型对比含自评偏差
- Arm B 本批无捏造 quote 进入管道（全文在场时 completed 模型 quote 复制均逐字命中）：quote 拦截路径未被触发，管道有效性证据来自 metadata 陷阱拦截与零泄漏，不是 fabricated 拦截率
- 全部模型经同一网关（api-gateway.glm.ai）：网关侧行为（内容过滤、协议翻译、限流）是公共混杂因子；qwen3.8-max 等目录内模型因当前凭据权限未纳入
- 全批使用 claude-compatible 数据集（noise token 派生集）：与 M6.8 frozen 有字符量漂移（M6.9.2.1 实测 chunk 结构一致、零误锚），但与 M6.9.1 在 frozen 上跑的 GLM-5.3 结果直接对比时需注意
- 结论限定于 evaluated models（本批 5 个），不应表述为「所有模型」