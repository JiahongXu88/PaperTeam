# M15.3.2 — 指标缩写绑定可行性验证（OA / EM / MaF1）

- 日期：2026-10-23；基线 `29e2e79`（== `origin/main`，工作树 clean；`claimCertificate.ts` sha256 `f6985317…5c0a1`、`dist/review/claimCertificate.js` `fc894fe3…3e74f0c7`，均与 M15.3.1 报告 §6 记录值逐字节一致，未重建）。
- 性质：**只读研究 + 零模型沙箱重放**。零付费模型调用、零真实 E2E、零生产代码改动（backend/src / backend/test / Gate / Runtime / Prompt / UI / 阈值未触碰）；全部试验脚本、沙箱 dist 副本与产物在 `D:\PaperTeamData\M15\M15_3_2\`（仓库外，不入 Git）。预登记 `PRE_REGISTERED_PLAN.md`（sha256 `912b388d…905011f`，见任何候选结果之前冻结）。
- 裁决：**GO_ONE_ALIAS** —— 仅 `oa: "accuracy"` 单条目值得进入下一轮单点实现（本轮不实施）；`em` 无独立收益；`maf1` 触发预登记停止条件 2，NO_GO。

## 1. 一句话结论

指标缩写别名**作为全局 SYNONYMS 单条目**（与既有 `acc: "accuracy"` 同机制、同调用路径）对 OA 这一具体缩写可行：191 例零模型重放 SEALED 3/57→**5/57** 正确强判（+2，均绑定到 oracle 真值单元格）、WRONG_STRONG 0、DEV_NEW 98 **零翻转**；但同一机制对 EM 因「重复列名 + 子集语境缺失」只产生误导性绑定（0 收益），对 MaF1 直接摧毁 M15.3.1 的两条强判——**缩写词典只能逐词裁决，不能成批铺开**。

## 2. 被测机制与沙箱方法

- 唯一被测实现形态：`backend/src/review/claimCertificate.ts` L52 `SYNONYMS` 追加单条目。`canonical()` 作用于 `contextTokens`/`orderedTokens` 的每个词元，单条目自动传播到 metricDistance（列维）、rowMentionScore/headerEntityScore（行维）、rowCoverage、contextScore、headingScore、UNEXPLAINED_TERM 解释检查全部路径（**全局作用域**，无法用字典条目收窄到表头；「表头作用域变体」需新代码，仅当出现行维污染时才设计——本轮未出现）。
- 沙箱：`sandbox\dist_{oa,em,maf1}\` = 仓库 dist 完整副本 + 仅 SYNONYMS 一行补丁（补丁哈希见 `sandbox\PATCH_MANIFEST.md`）；`M152_DIST` 指向沙箱跑 `M15_2\scripts\eval_pairs.mjs`（原封不动），逐例差分 verdict/status/reasons/绑定单元格（`diff_replay.py`）。
- 基线核对（预算内 1 次）：仓库 dist 重放与 M15.3.1 结果**双侧 0 翻转**（`analysis/diff_baseline_check.json`），8 条既有正确强判在位。

## 3. 191 例结果（三个候选，按预登记顺序）

| 候选（冻结条目） | SEALED 93 | DEV_NEW 98 | WRONG_STRONG | 翻转明细 |
|---|---|---|---|---|
| C1 `oa: "accuracy"` | CORRECT_STRONG 3→**5**（3/57→**5/57**），ABSTAIN 84→82* | **0 翻转**（5/61 不变） | **0** | **5 例**（全 N03，逐例见 §4） |
| C2 `em: "exact"` | 3/57 不变 | 0 翻转 | 0 | 2 例（N07-P01/P05，均仅理由码变化） |
| C3 `maf1: "macro-f1"` | （探针层确认停止条件 2，**未耗全量重放**） | — | — | N09-P01/P03 丢失 UNIQUE（探针取证） |

\* SEALED 基线口径 {CORRECT_STRONG 3, ABSTAIN 82, NOT_INJECTABLE 8}；C1 后 {CORRECT_STRONG 5, ABSTAIN 80, NOT_INJECTABLE 8}。分母：SEALED 可证 57、非可证 36、NOT_INJECTABLE 单列（8，注入层非核验器拒绝）；DEV_NEW 可证 61。「ABSTAIN 减少 2」全部来自可证桶且全部转为正确强判，无弃判→错判。

## 4. C1（OA）逐例翻转清单（唯一产生强判变化的候选）

| caseId | 真值 | 旧 | 新 | 绑定单元格 | 正确性 |
|---|---|---|---|---|---|
| N03-P01 | SAME_OBSERVABLE_CONSISTENT | ABSTAIN / REVIEWER_CONSISTENT（NO_CELL_MATCHES） | **CORRECT_STRONG / VERIFIED_SUPPORTED** | `(Ours)|[ModelNet40,OA]=99.05@2e84e8c2:22,1` | ✓ == oracle 对端真值格 |
| N03-P03 | SAME_OBSERVABLE_CONTRADICTED | ABSTAIN / REVIEWER_SUSPECTED | **CORRECT_STRONG / VERIFIED_CONTRADICTED** | 同上（论断值 98.05 与格值 99.05 DISJOINT，B2 扫描 98.05 无他表命中） | ✓ |
| N03-P04 | DIFFERENT_OBSERVABLE | ABSTAIN（NO_CELL_MATCHES） | ABSTAIN（`PROPOSED_COUNTERPART_IS_NOT_THE_UNIQUE_BINDING`） | 论断侧唯一绑定 99.05 格 ≠ 模型对端格 → 双钥匙正确拒绝 | ✓ 理由码更精确 |
| N03-P07 | SAME_OBSERVABLE_CONSISTENT | ABSTAIN（NO_CELL_MATCHES） | ABSTAIN（**TIED_CANDIDATES**：PointNet/PointNet++ 跨表并列 (98,2,3)） | 未绑定 | 弃判安全（见 §5） |
| N03-P12 | NOT_DETERMINABLE | ABSTAIN（DERIVED_SUBJECT/REFERENCE/RATIO_AMBIGUOUS） | ABSTAIN（新增首位 `DERIVED_COLUMN_AMBIGUOUS`） | — | ✓ 弃判不变 |

回归锚全部保持：SEALED N03-P02、N09-P01、N09-P03 强判逐字不变；N09-P05 保持 ABSTAIN 且 `VALUE_APPEARS_IN_OTHER_TABLE:4b44c3069fef0a56,57c97dbb30f5999e` + `UNEXPLAINED_QUALIFIER:reproduced` 逐字不变；N09-P12 `PROPOSED_COUNTERPART_IS_NOT_THE_UNIQUE_BINDING` 不变；DEV_NEW 5 强判不变。静态词元扫描（`analysis/alias_token_scan.json`）：独立 `oa` 词元仅出现在 N01/N03/N15（N01/N15 为 DEV_NEW，C1 下零变化——词元暴露 ≠ 判定变化，只有出现在绑定相关位置才生效）。

## 5. 三个必答题

**Q1 哪个机制可行？** 只有「全局 SYNONYMS 单条目」这一形态被测且对 OA 通过。调用路径：`SYNONYMS` → `canonical()`（L66）→ `contextTokens`/`orderedTokens` → `metricDistance`（列维窗口匹配）+ `bindTextAtom` 可解释性检查（`mentions(explain, …)`）。「表头上下文作用域」字典表达不了；本轮无行维污染证据，故无需该变体。**可行 ≠ 成批可行**：OA 是 2 字母缩写中语义最稳的（remote sensing/点云分类里 OA 几乎只指 overall accuracy），且 N03 两张 99.05 竞争表恰好被 contextScore 唯一化——这是语料运气成分，见 §7。

**Q2 谁获益、谁受损？** 获益：N03-P01/P03（+2 正确强判，绑定格 == 真值格）。受损：无（C1 下 191 例无任何 verdict 受损；N03-P07 从「无候选」变「平局弃判」，同为 ABSTAIN 但暴露了既有弱点——「including CurveNet, PointNet…」基线列举被 comparator 剥离止于逗号，残存行名给无关行 +2 行分）。C2/C3 的受损见 §6。

**Q3 候选池/平局变化？** C1：N03-P01/P03 候选池从 0 → 4+（`[ModelNet40,OA]` 97/1/10 首位，XGBoost 表 `OA (%)` 同值 99.05 以低 contextScore 落后——caption 与分句同现 accuracy+ModelNet40 的表胜出）；N03-P07 新增跨表 TIED（判列 98 相同 + 残存基线行名同行分）。N09-P01/P03/P05/P12 候选与理由零变化（MaF1/MiF1 表头不受 `oa` 影响）。C2：N07-P01/P05 候选池 0 → 1，但 top 绑定到**错误子集列** `GPT-5|[Non-ambig. Question,EM]=0.21`（论断说 ambiguous questions 的 0.13；0.21 是 non-ambiguous 列），靠 B2（0.13 出现于他表 3fe42350）兜住——EM 在 Non-ambig/Ambig 两列重复，「exact」到两列距离同为 1，无子集维无法区分。C3：N09 复现表（4b44c306，叶 `MaF1`，上层层级 = 模型名×数据集）整表获得列维入口，RGCN/RGCN* 行 × 10+ 模型列以 (99,2,21) 并列，N09-P01 3 路平局、N09-P03 6 路平局——M15.3.0 预警的负交互实测成立。

## 6. C2 / C3 裁决依据

- **C2（`em: "exact"`）NEEDS_MORE_THAN_ALIAS**：全量重放 SEALED 3/57→3/57、DEV_NEW 0 翻转；仅有的 2 处变化是理由码（NO_CELL_MATCHES → UNEXPLAINED_CONTEXT + B2），且新 top 绑定指向错误子集列（§5 Q3）。净收益 0 + 误导性绑定面增大 → 按预登记停止条件 5 不建议实施。要救 N07-P01 需「子集语境匹配」（"ambiguous questions" ↔ "Ambig. Question"），即 M15.3.0 候选 C（subset 限定词），独立方向、另立轮次。
- **C3（`maf1: "macro-f1"`）NO_GO**：探针层（claim 侧 `bindTextAtom`）即确认 N09-P01 `UNIQUE→TIED_CANDIDATES`（3 候选并列）、N09-P03 `UNIQUE→TIED`（6 候选）——直接摧毁 M15.3.1 获得的两条正确强判，命中预登记停止条件 2（既有正确强判丢失 verdict），按预登记 §5 立即停止，不耗全量重放预算。N09-P05/P12 锚在探针下不变（B2/B3 与双钥匙防线未被穿透）。**缩写词典中任何 MaF1/MiF1 类条目，只要语料含「转置复现表 + 同名行」就必然重演此平局，不应以任何分数路径补丁强修。**

## 7. 局限

- 收益验证限于已开封 SEALED 的 191 计分行（EXPOSED_REGRESSION 语义），**不构成泛化声明**；`oa: "accuracy"` 在本语料仅 N03 一个家族真实生效，N03-P01/P03 的唯一化依赖该文 caption 措辞（"Classification accuracy (%) results on ModelNet40"），换一篇 caption 不含全称的论文可能落到 TIED（= 安全弃判，非错判）。
- 差分为 verdict/status/reasons/绑定单元格级；「进入候选池但未改变 top」的次级候选增量不可观测（eval 输出不含全候选列表），其上界由 191 例零判定变化 + 静态词元扫描共同约束。
- `automated_truth` 非人工金标准；未测 OA 与后续任何改动的组合效应；未跑真实 Reviewer E2E。

## 8. 最小下一步（唯一建议，未获批准不实施）

在 `backend/src/review/claimCertificate.ts` L53 `SYNONYMS` 追加单条 `oa: "accuracy",`（+1 行，可与 1 行注释），同 M15.3.1 流程：预登记 → 单点 diff → 191 例零模型重放（预期翻转全集恰为 §4 的 5 例）→ 合成测试。必须保留的既有防线：UNIQUE/TIED_CANDIDATES、B2 `VALUE_APPEARS_IN_OTHER_TABLE`、B3 限定词（segmentContext）、`MULTIPLE_METRICS_BEFORE_VALUE`、`PROPOSED_COUNTERPART_IS_NOT_THE_UNIQUE_BINDING` 双钥匙、以及 M15.3.1 的比较对象剥离。建议新增合成反例（不复制 N03 原文）：(a) 两表同列同值、caption 一含全称一不含 → 必须平局弃判或被 contextScore 唯一化；(b) 行键含缩写（如方法名 "OA-Net"）+ 正文 "accuracy" → 不得行维误绑；(c) OA 与其他指标列并存、正文两指标并列数值 → MULTIPLE_METRICS 防线不放松；(d) N03-P07 型「including …」基线列举 → 允许保持 TIED 弃判。下一轮候选记账（不实施）：MiF1↔Micro-F1（同 C3 风险）、R↔recall、CB/BV/SC2 数据集缩写、subset 限定词。

## 附录 A：可追溯性（全部在 `D:\PaperTeamData\M15\M15_3_2\`，仓库外）

| 项 | 值 |
|---|---|
| 预登记 | `PRE_REGISTERED_PLAN.md` sha256 `912b388dee4fb791b9a5fa34eabf4cbd8e4029db668ac7f7a9a941b13905011f` |
| 沙箱补丁清单 | `sandbox\PATCH_MANIFEST.md`（dist_oa `d6ba6195…697c4`、dist_em `510fdff2…91a8e`、dist_maf1 `6c658cf4…bd71c`） |
| 基线核对 | `analysis\eval_pairs_{sealed,devnew}_baseline_check.json` + `diff_baseline_check.json`（双侧 0 翻转） |
| C1 全量 | `analysis\eval_pairs_{sealed,devnew}_oa.json` + `diff_c1_oa.json`（sealed `192e9171…f1aa6` / devnew `d8b3ad1f…5b32`） |
| C2 全量 | `analysis\eval_pairs_{sealed,devnew}_em.json` + `diff_c2_em.json`（sealed `ae96fddf…36357`） |
| C3 探针 | `probe_maf1_key.json`（`7af5c0f9…fa9611`）；C1/C2 关键例探针 `probe_{baseline,oa,em}_key.json` |
| 静态扫描 | `analysis\alias_token_scan.json`（`d96576b7…216020`）；工具 `inspect_tables.py`/`scan_alias_tokens.py`/`probe_binding.mjs`/`diff_replay.py`/`make_sandbox.py` |
