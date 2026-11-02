# M16 后续 · 已核验发现进入产品（verified-findings/v1）

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）· 起点 `757d74b` · 产品提交 `5c07413`
- 外部证据：`D:\PaperTeamData\M16\VerifiedFindingsHybridReview\`（`A/dev-replay/`、`PROTOCOL.md`、`E/`）
- 本报告只讲工作包 A（确定性科学缺陷 → 产品 L1）。整稿审查对照见 `M16_WHOLE_PAPER_REVIEW_OPTION_STUDY.md`，总验收见 `M16_FOLLOWUP_FINAL_ACCEPTANCE.md`。

## 1. 起点：为什么 7 个已复算缺陷在产品里仍是「AI 待核验」

上一轮报告把原因写成「产品没有把模型 finding 接到确定性复算」。按源码和 12 篇真实运行工件复核，实际情况更具体：

| 层 | 现状（`757d74b`） | 对 7 个案例的影响 |
|---|---|---|
| `review/claimCertificate.ts`（claim-certificate/v1） | 成熟的唯一绑定 / 区间判别 / 派生量复算 | 只作用于**单独抽取的论断账本**，不作用于审稿 finding |
| `review/claimAudit.ts` + `findingAdjudication.ts` | 论断 → 证书 → 四轴裁决（含 VERIFIED_BY_CERTIFICATE） | 产物标 `NONE_SHADOW` / `SHADOW_ONLY`：Gate、UI、Journal Assessment 都不读 |
| 来源门 `resolveClaimAuditSource` | 只读评估无 `input-provenance` → SOURCE_UNKNOWN | 12 篇全部 SOURCE_UNKNOWN，任何证书都会被 SOURCE_NOT_VERIFIED / PARSE_ARTIFACT_SUSPECTED 阻断 |
| 跨节一致性 `cross_section_numeric_consistency`（L1） | 只扫摘要 / 结论 ↔ 表格 | 正文段落的文表不符不在范围；「up to N×」→ NOT_EVALUATED |
| 输入（评测侧适配器 v1） | HTML 表格 rowspan / colspan 展平，题注不进浮动体 | UiEjzBRYeI 的 Table 1 表头整体错位；表号无法解析 |

12 篇真实论断账本里 VERIFIED_* 计数为 0。所以在这些输入上，产品「没把它们标成已核验」大体是**正确的 fail-closed**：表格确实被转写弄坏了，来源确实未知。真正的产品缺口是：即使输入可信，审稿 finding 本身也从不经过证书核对，也没有任何 L1 出口。

## 2. 七个根因 + 一个反证的逐条复核（A1）

| 论文 | 发现 | 复核结论 | 本轮自动化 |
|---|---|---|---|
| orr5uPZY28 | 「9.4× 延迟降低」无法由 Table 3 推出 | **成立**。Table 3 是每 token 延迟，Baseline/Ours 各行比 10.42 / 6.78 / 7.07 / 6.06 / 6.50 / 5.94；吞吐倍数与延迟倍数在该表口径下应相同；9.1 恰等于括号内接受 token 数 9.10。正文明确「as demonstrated in Table 3」「compared to auto-regressive」。仍不排除作者另有测量口径 → 证书措辞为「所引表格不支持」 | **支持**（TABLE_MULTIPLIER） |
| UiEjzBRYeI | 正文 PQ 40.6 / mIoU 47.5 vs Table 1 同列 41.0 / 47.9 | **成立**（原 MD 的 HTML 表头有 colspan，COCO→Cityscapes 三列为 PQ / AP / mIoU，AP 29.3 一致） | **支持**（TEXT_TABLE_VALUE，作者源稿形态）；真实转写文本上仍不判（见 §5） |
| orr5uPZY28 | 「consistently … higher number of accepted tokens」与 Table 1 矛盾 | 成立（OWT/0 3.79 < 3.81 等） | 不支持：全称比较论断需要语义解析比较对象集合 |
| J9VogDTa1W | 「k ≠ 4 时准确率高于 80%」与 Table 1 矛盾 | 成立（k=3, d=0.0 为 22/32 = 68.75%）；需理解「判定准确率」定义 | 不支持：派生口径来自模型，非确定性 |
| 6Ire5JaobL | 正文 a_t = 0、b_t = t vs Table 1 OT-VF 行 a_t = t、b_t = 0 | 成立（符号字面量互换） | 不支持：证书只做数值比较；符号绑定需要另设计 |
| x9gCQC3rVA | 「Direct Policy Optimization (DPO)」vs 自身参考文献「Direct preference optimization」 | 成立为**文内不一致**；不构成伪造文献 | 不支持：缩写全称核对需区分合理简称 / 版本名，留作作者核对 |
| uAFHCZRmXk | Table 1 题注「dataset size 相关性强于 modality gap」的反例 | 成立（普遍性论断的反例） | 不支持：全称论断 |
| J9VogDTa1W | 「0.036% 无法复现」（硬负例） | **反证**：按原文假设 4!·(1/4)^8 = 0.0366% | 回归测试断言永不升级（无可绑定表格 → NOT_CERTIFIED） |

结论：**7 个复核正确 7 个；本轮真正自动化支持 2 类（2 个根因）；5 个不支持**，原因都是需要模型给出比较口径 / 符号语义 / 全称范围——这些交给确定性检查器只会把模型的解释包装成「已证实」。

## 3. 设计：单一受控证书路径（不新造验证器）

`backend/src/review/verifiedFindings.ts`（verified-findings/v1）只对「可定位（引文逐字在原文）+ 实质性类别」的 finding，在其引文内、且 finding 文字点名的数值上做两类检查，全部复用 claim-certificate/v1：

1. **TEXT_TABLE_VALUE**：测量值（≥ 1 位小数、无约数 / 不等式 / 派生限定）→ `bindTextAtom` 唯一绑定 → `certifyClaim` 原子比较（显示精度区间、单位、量纲歧义 fail-closed）。双钥匙：finding 必须写出绑定单元格的数值。finding 恰好点名一张可解析的表时只在该表内要求唯一绑定；全文绑定若不靠格值平局裁决就唯一落在另一张表 → 冲突，不判。
2. **TABLE_MULTIPLIER**（新增能力）：「N×」「up to N×」，所在句（或全文中显式引表的同值重述句）唯一引用一张表；候选 = 单元格值（含括号内次要值）、同行 / 同列同序两数之比（排除实验因子列）、列对跨行均值比；全部候选与论断显示精度区间不相交 → 「所引表格不支持该数字」。约数、下界、聚合措辞、表号不可证、表格行宽不一致 → 不判。双钥匙：finding 必须点名该表。

状态与出口：

| 状态 | 条件 | 层 |
|---|---|---|
| VERIFIED_CONTRADICTED | 证书成立 + 来源 AUTHOR_SOURCE / SOURCE_ATTESTED | **L1 已核验缺陷**（`review_findings_certified` FAIL，required） |
| CERTIFIED_ON_TRANSCRIPT | 证书在被审文本上成立，但被审文本是转写 / 来源未知 | NOT_EVALUATED（需对照原件，作者核对） |
| NOT_CERTIFIED / NOT_APPLICABLE | 其余 | 规则 NOT_APPLICABLE，**从不 PASS**（未证实 ≠ 没问题） |

另外：finding 点名的 Table / Figure / Eq. / [n] 在原文不存在 → `danglingReferences`，只作定位质量提示，不删除、不降级 finding。

调用链（真实入口）：`evaluateProjectQualityGate`（workflow `quality.gate` 与 `POST /quality-gate` 共用）→ 被审修订快照 + 同轮 `review.issues` + `resolveClaimAuditSource` → `verifyFindings` → `reviews/verified-findings-r{n}.json` → `evaluateQualityGate` 规则 → `buildQualityReport`（L1 deterministic）→ `gate.verifiedFindings` → API → `VerifiedFindingsPanel`；Journal Assessment 经既有 QualityReport L1 风险项进入 `BLOCKED_BY_VERIFIED_ISSUE`。证书不授权任何修改（修订仍走 EditContract），旧产物无本字段 → UI 显示「未评估」。

## 4. 零模型验收（先红后绿）

| 证据 | 结果 |
|---|---|
| 旧证书器对「9.4×」 | NOT_CERTIFIED（DERIVED_COLUMN_UNBOUND）——红 |
| 新路径（作者源稿形态夹具） | 9.4× VERIFIED_CONTRADICTED（最接近候选 9.1，区间 [9.35, 9.45]）；40.6 / 47.5 vs 41.0 / 47.9 VERIFIED；AP 29.3 CONSISTENT——绿 |
| 硬负例 0.036% | 永不升级 |
| 合法差异 | 舍入相容（41.0 vs 41.04）CONSISTENT；可复现倍数（10.4× = 5.59650/0.53696）CONSISTENT；约数 / 下界 / 无表引用 / 表头展平 / 未点名单元格 / 竞争表冲突 → 不判 |
| 来源门 | SOURCE_UNKNOWN / SOURCE_UNVERIFIED → CERTIFIED_ON_TRANSCRIPT；SOURCE_ATTESTED → VERIFIED |
| 生产入口 | `verifiedFindingsGate.test.ts`：真实 HTTP `/review` → `/quality-gate` → GET：规则 FAIL、QualityReport L1 FAIL（deterministic）、API 证书含单元格 41.0、Journal Assessment BLOCKED_BY_VERIFIED_ISSUE；数值一致时规则 NOT_APPLICABLE（非 PASS） |
| 前端 | L1 与转写证书可区分；旧产物 / 未执行 → 未评估；无达刊措辞 |

测试：`verifiedFindings.test.ts` 18、`verifiedFindingsGate.test.ts` 2、`VerifiedFindingsPanel.test.tsx` 4。

**夹具声明**：两段夹具是手工改写的摘录（加了 caption / label / \multicolumn，「Table 3」改为 `\ref`，删去行与表），只证明算法在规范 LaTeX 上的行为，不是真实论文检出率证据。

## 5. 真实文本回放（已开封 12 篇，只作开发 / 回归）

| 输入 | finding | 可定位 | 含可核对数值 | 证书 | DANGLING |
|---|---|---|---|---|---|
| 上一轮真实被审 main.tex（v1 展平表格，SOURCE_UNKNOWN） | 464 | 423 | 17 | **0** | 6 |
| 同一 finding 放到 md-to-tex v2 文本（表格跨度还原；7 篇题注可移入） | 464 | 412 | 17 | **1**（orr5 #29「9.4×」→ CERTIFIED_ON_TRANSCRIPT） | 6 |

- 0 个错误证书：v1 输入上全部 fail-closed；v2 上唯一的证书就是已人工复核成立的 9.4×。
- UiEjzBRYeI 的 40.6 / 41.0 在真实 v2 文本上**仍不出证书**：题注编号无法与表格一一对应（v2 不加 caption），finding 点名的「Table 1」无法解析，全文绑定不唯一。这是正确的不判，但也说明「作者源稿夹具上能判」不等于「真实转写稿上能判」。
- 一次纠偏（协议允许的唯一一次）：真实回放暴露一条错误关联——一条「引言缺 up to 限定」的 minor finding 继承了同句 9.4× 的证书。修复为倍数检查也要求 finding 点名该表，并加回归测试。同时修了 v2 题注配对与「点名表内唯一绑定」。此后停止调整，避免在已开封集上过拟合。
- DANGLING 只检出 6 条，远低于上一轮评测脚本的 6.8%（约 34 条）：产品检测只看 finding 描述 / 理由中的显式编号且要求编号超过原文对象数，比评测脚本保守。

## 6. 诚实边界

1. 适用范围很窄：两类数值检查。全称论断、派生口径、符号字面量、缩写全称、公式推导都不判。
2. 倍数候选规则中的「排除实验因子列」与「同序限制」是在 DYSPEC 开发样例上为消除巧合匹配（5.34781 / 温度 0.6 ≈ 8.9）而加的事后规则；缩小候选会让矛盾更容易成立，其假阳性率没有独立样本证据。
3. 已发表论文只读评估的输入几乎都是 PDF 转写；来源门使其最多到 CERTIFIED_ON_TRANSCRIPT。L1 VERIFIED 实际只会出现在作者源稿工作流（或有效人工 QA 证明）。
4. 「anchored（引文逐字存在）」≠「verified（证书成立）」：UI 与 API 分开呈现，计数分开。
5. 证书说明的是被审文本内部的数值关系，不是学术判断，也不授权改稿。

## 7. 新留出 12 篇上的真实适用率（生产入口，PDF 转写输入）

| finding | 可定位 | 含可核对数值 | VERIFIED_CONTRADICTED | CERTIFIED_ON_TRANSCRIPT | NOT_CERTIFIED | DANGLING |
|---|---|---|---|---|---|---|
| 520 | 471 | 12 | **0** | **0** | 12 | 22 |

- 12 条 finding 共 19 项检查全部 fail-closed：`BINDING_UNBOUND:NO_CELL_MATCHES_METRIC_AND_ROW` 13（表格 / 指标绑定不唯一）、`QUALIFIER_INEQUALITY` 3、`QUALIFIER_AGGREGATE` 1、`TABLE_MULTIPLIER/NO_TABLE_REFERENCE` 2（其中一处是图注里的分辨率 4096×2048，确被倍数检查当作候选，靠无表引用才拦下）。
- 没有证书，因此协议要求的「逐条人工核对证书」为空集：**新集上证书误报率没有证据，只有「未产生证书」这一事实。**
- 含义：L1 / 证书路径在真实生产入口上已接通并有测试证明，但在 PDF 转写输入上适用率很低（本集 0 / 520，已开封集 1 / 464）。它的主要价值场景是作者 LaTeX 源稿工作流，而非只读评估已发表论文的转写稿。
- 同批 findings 的参考外独立核验见 `M16_WHOLE_PAPER_REVIEW_OPTION_STUDY.md` §3（盲化规格 + 脚本计算，83 条中 7 条 INDEPENDENTLY_VERIFIED、0 条 REFUTED）：产品检查器的覆盖面明显窄于脚本 + 人工写规格。
