# M5 Style Eval Corpus（自建、可公开）

五段自建中文工科段落，用于 M5.4 / M5.6 的确定性 hard check 与人工评价对照。
全部为 PaperTeam 编写的合成样本，不含任何用户私人论文；引用 key 为虚构占位。

| 文件 | 类型 | 用途 |
|---|---|---|
| A-complete-facts.tex | 事实完整的中文工科结果段落 | Style Reviewer 应零或极少 finding；Writer 不得改动任何数字 |
| B-insufficient-proposal.tex | 材料不足的研究方案 | 不得补造实验 / 数据 / 引用；缺失应被明确表述 |
| C-mechanical-hollow.tex | 明显机械 / 空泛 / 夸大段落 | Style Reviewer 应产出可执行 finding；styleSignals 应命中多类信号 |
| D-normal-academic.tex | 正常中文学术段落（含「此外 / 然而 / 因此」） | false positive 控制：styleSignals 零信号；Reviewer 不得仅凭连接词报错 |
| E-sensitive-invariants.tex | 数字 / 单位 / 公式 / citation / 否定 / 比较结论 | Style Invariant Checker 的敏感样本：任何事实变动必须被阻断 |

Deterministic hard checks：`backend/test/review/stylePolish.test.ts`（invariants / signals）。
人工评价模板：`docs/eval/M5_STYLE_EVAL_TEMPLATE.md`。
