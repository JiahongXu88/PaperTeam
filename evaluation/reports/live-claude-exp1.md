# Live Evaluation — Exp1 Evidence Grounding（M6.9.2）

- model: `claude-gateway/claude-fable-5-1`（provider `claude-gateway`，来源 cli）
- runtime: pi（PiRuntimeAdapter，无新增调用链）
- run: 2026-09-18T08:55:19.612Z → 2026-09-18T08:57:20.020Z（120s）
- errors: 1

| scenario | arm | proposals | fabricated | misattributed | intercepted | verified |
| --- | --- | --- | --- | --- | --- | --- |
| g1-rag-survey | plain-llm-live | 5 | 100.0% | 0.0% | - | - |
| g1-rag-survey | paperteam-live | 0 | 0.0% | 0.0% | - | - |
| **aggregate** | plain-llm-live | 5 | 100.0% | 0.0% | - | - |
| **aggregate** | paperteam-live | 0 | 0.0% | 0.0% | 0.0% | 0.0% |

## Errors

- `other` @ g1-rag-survey/paperteam-live：任务终态 failed：The model refused to complete the request（errorCode=RUN_FAILED）（taskId=pi-4760acba-0808-409e-9104-52cdc8d6d6bf）

## Limitations

- 首轮 plumbing 冒烟：样本小（每臂 ≤5 提案）、单场景起步，指标不具统计效力
- judge 与生成同用 claude-gateway/claude-fable-5-1（同模型自评偏差；正式实验应引入异模型 judge）
- 对齐良好的模型可能在无库条件下拒绝编造引文（refused 结果）——这是合法测量结果，此时 plain-llm 基线的捏造率不可测（分母为 0），不应解读为 0%
- metadata 核验的权威记录是数据集内置 ground-truth provider（与 M6.8 scripted 同口径），不是真实 Crossref/OpenAlex
- Arm B 锚点规则：quote 命中 chunk 用该 chunk，未命中落到来源首个 chunk（Stage 1 拦截）；chunk 边界截断可能造成误拦（报告保留逐条机械判定供审计）
- quote 机械核验与产品 Stage 1 同用 normalizeForQuoteMatch 归一化口径（大小写/空白不敏感）