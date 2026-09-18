# Live Evaluation — Exp1 Evidence Grounding（M6.9.3）

- model: `gw-anthropic/glm-5.3-highspeed`（provider `gw-anthropic`，来源 cli）
- dataset: claude-compatible（M6.9.2.1 noise-token 兼容变体）
- runtime: pi（PiRuntimeAdapter，无新增调用链）
- run: 2026-09-18T10:18:15.534Z → 2026-09-18T10:19:39.861Z（84s）
- errors: 0

| scenario | arm | proposals | fabricated | misattributed | intercepted | verified |
| --- | --- | --- | --- | --- | --- | --- |
| g1-rag-survey | plain-llm-live | 5 | 100.0% | 0.0% | - | - |
| g1-rag-survey | paperteam-live | 5 | 0.0% | 0.0% | 0.0% | 80.0% |
| **aggregate** | plain-llm-live | 5 | 100.0% | 0.0% | - | - |
| **aggregate** | paperteam-live | 5 | 0.0% | 0.0% | 0.0% | 80.0% |

## Limitations

- 数据集为 claude-compatible 变体（M6.9.2.1）：corpus 防记忆噪声 token 由随机串（fqj0 式，触发网关 Claude 通道 bio 过滤）替换为 word-form synthetic marker（random-term-N，项目统一定义、场景内唯一）；claim/evidence/citation/fault 注入结构与 M6.8 frozen 逐字段一致（运行期 SHA-256 快照校验）。marker 与原 token 长度不同，chunk 边界与 prompt 长度有轻微漂移——与 frozen 数据集上的 GLM-5.3 结果比较时需注意
- 首轮 plumbing 冒烟：样本小（每臂 ≤5 提案）、单场景起步，指标不具统计效力
- judge 与生成同用 gw-anthropic/glm-5.3-highspeed（同模型自评偏差；正式实验应引入异模型 judge）
- 对齐良好的模型可能在无库条件下拒绝编造引文（refused 结果）——这是合法测量结果，此时 plain-llm 基线的捏造率不可测（分母为 0），不应解读为 0%
- metadata 核验的权威记录是数据集内置 ground-truth provider（与 M6.8 scripted 同口径），不是真实 Crossref/OpenAlex
- Arm B 锚点规则：quote 命中 chunk 用该 chunk，未命中落到来源首个 chunk（Stage 1 拦截）；chunk 边界截断可能造成误拦（报告保留逐条机械判定供审计）
- quote 机械核验与产品 Stage 1 同用 normalizeForQuoteMatch 归一化口径（大小写/空白不敏感）