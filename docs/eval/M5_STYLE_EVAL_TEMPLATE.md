# M5 Style / Quality 人工评价模板（M5.4 建立，M5.6 A/B 使用）

> 用途：对 PaperTeam 产出（Review finding、Style Polish 修订、A/B 两组稿件）做
> 人工评价。PaperTeam Reviewer 自己给的分数**不能**作为唯一裁判；本模板的
> 人工评分与 `backend/src/review/styleInvariants.ts` / `styleSignals.ts` 的
> deterministic hard check 一起构成 M5 的质量口径。

## 0. 样本与环境（每份评价必填）

| 字段 | 值 |
|---|---|
| 样本 id（corpus 文件 / 项目 id + 章节 + 修订号） | |
| 评价日期 | |
| 评价人（可匿名代号） | |
| 是否 blind（评价时不知道 A/B 归属） | 是 / 否 |
| 模型 / provider / 参数 | |
| Git SHA | |

## 1. Deterministic hard checks（先跑代码，再人评）

| 检查 | 结果 | 备注 |
|---|---|---|
| citation key 多重集保持 | PASS / FAIL | `checkStyleInvariants` |
| 数字 + 单位保持 | PASS / FAIL | |
| 公式片段保持 | PASS / FAIL | |
| \ref / \label / 环境结构保持 | PASS / FAIL | |
| 受保护术语不减少 | PASS / FAIL | glossary.json 或调用方传入 |
| 否定 / 比较 / 结论强度哨兵词计数 | PASS / FAIL | 保守哨兵，非语义证明 |
| styleSignals 信号数（修改前 → 修改后） | n → m | 仅表面模式计数 |
| Quick Review 修订号（前 == 后） | 是 / 否 | 必须相等 |

## 2. 人工评价维度（1–5 分；1 = 很差，3 = 可接受，5 = 很好）

| 维度 | 分 | 依据（引用具体句子 / 位置） |
|---|---|---|
| 事实保持（数值 / 结论 / 因果与比较方向未被改变） | | |
| 术语一致（同一概念只用一个术语；缩写规范） | | |
| 表达清晰（句子边界、主语明确、无翻译腔） | | |
| Review 建议可执行性（位置 / 问题 / 原因 / 动作 / 严重度齐全，可直接交给 Writer） | | |
| Style false positive（正常段落被误报的数量：0 → 5 分；≥ 3 → 1 分） | | |
| 是否过度润色（改动了不该改的句子 / 风格漂移 / 为变化而变化） | | |
| 中文自然度（仅 M5.6 pairwise） | | |
| 学术表达（仅 M5.6 pairwise） | | |
| unnecessary rewrite（仅 M5.6 pairwise：不必要的重写句数） | | |

## 3. 工程指标（从 run / task 记录抄录，不估算）

| 指标 | 值 |
|---|---|
| 耗时（stage / run，秒） | |
| input tokens | |
| output tokens | |
| cache read / write tokens | |
| estimated cost（provider list-price 估算；缺省则写「未返回」） | |
| run 数 / session rotation 数 | |
| assigned skills（id@hash） / accessed skills（或 unknown） | |

## 4. 结论

- 该样本的主要问题属于：论文真实质量问题 / Reviewer false positive / Writer regression / Runtime failure / Provider failure / 环境失败（多选）
- 是否建议采纳该修订：是 / 否 / 部分（说明哪些句）
- 备注：

> 纪律：不为让结果好看而修改阈值、删除 finding、替换样本。FAIL 就记录 FAIL。
