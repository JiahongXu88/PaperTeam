# M15.15 — 中文目标期刊真实证据链与先前工作可判定性验收

日期：2026-10-30 · 基线 `main@c5cab03e`（本轮变更见 git log `M15.15` 条目）· 任务书：M15.15 P0 长程任务书

## 第一屏：总裁决与回答

**总裁决：GO_EVIDENCE_AUDIT（小范围 advisory 接入；M15 整体仍 INCOMPLETE）。**

三个轮次问题的回答：

1. **中文论文能否可靠抽取参考文献并跨中英文查到对应先前工作？——能（本轮实测）。**
   7 份真实 CJIG 中文 PDF：参考文献 0 → 465 条（DOI 口径 recall 405/407 = 99.5%，无碎片、无虚构）；
   条目级 Crossref 解析 8/8 命中 R@5=100%；DOI 直查 39/40 可解析、75% 可得摘要。
   根因不是"中文 PDF 坏了"：是节标题双语形态（`参考文献（References）`）+ author-year 无编号
   条目 + DOI/URL 印刷空格 + 查询构造只取 ASCII token（空查询确定性失败）。
2. **全文证据能否把 POTENTIAL_OVERLAP/INSUFFICIENT 推进为可判定比较而不增加错误强断言？——
   能，但必须带守卫。** 7 个新家族三臂对照：P0（摘要级）实现级判定 0/7（正确弃权）→
   P1/P2（全文摘录）7/7 达成 fulltext 基判定且语义全部与预注册 oracle 吻合；
   但纯 one-shot（P1）的 quote 仅 9/21 可在给定材料内回放（不可审计风险），
   ContributionAuditService（P2）在同材料上 7/7 全核验或确定性降级
   （守卫实测：3 次 fulltextBasis 降级 + 3 次 quote 回放失败捕获 + 1 次时间因果违规）。
3. **对真实中文稿件+具体期刊能否产出指导作者的差距报告？——能（演示交付，advisory）。**
   case-R（中文研究论文）与 b1（作者综述稿）→CJIG 三层报告 + 同稿 CJIG/CEA 差分已生成
   （`D:\PaperTeamData\M15\M15_15\phase-d\out\`）；报告区分官方规范/观测带/证据分级学术风险，
   不输出录用判断。

**仍然不能的**（如实）：期刊学术质量档位判断（无独立人类标签，M15.10 事实不变）；
PDF-only 稿件的 LaTeX 类格式机检（既有产品约束）；CEA 观测带（语料仅摘要级）；
纯中文机构作者著录条目与 arXiv LaTeX 参考文献表两种版式（已知限制，见 B1/C 披露）。

**与 M15.14 的关系**：M15.14 的 NO_MEASURABLE_GAIN 裁决（结构化不提高发现覆盖率）不被推翻——
本轮增益来自**材料升级**（全文摘录）而非更多 Reviewer 调用；结构化的价值从"找更多"转为
"让全文判定可审计"。生产主路径不新增审稿链成本（P2 仅用于证据审计用途的小范围接入）。

## Phase A — 源码与事实审计（零模型）

`D:\PaperTeamData\M15\M15_15\phase-a\ROOT_CAUSE_AND_REUSE_MATRIX.md`（含 源码路径:行号 与输入输出证据）。

- 阻断 (a) 参考文献 0 条：`sectionChunking.ts` REFERENCES_TITLES 精确匹配不认双语节标题
  （实测 2021-2022 半角 `参考文献(References)`、2023+ 全角 `参考文献（References）`）→
  `referencesSectionId=undefined`；下游 author-year 无编号条目按行碎片化；DOI 全角包裹
  `［DOI：…］` 与内部印刷空格 `10. 1007 / 978-…`；U+2043 断词符不在归一化表。
- 阻断 (b) 跨语言检索 0 候选：`build-pool.mjs tfTerms` 只取 `[a-z][a-z0-9-]{3,}`——中文题名 →
  空查询 → arXiv 确定性 400（M15.14 工件 `arxiv-search-failed(arxiv:400)` 吻合）；
  而中文稿件首页/第 5-6 页自带英文题名、英文摘要、Key words、规范引用行——信号现成，无需模型。
- ContributionAuditService 当时只有 abstract|metadata 两级——Phase C 扩展为三级（见下）。

## Phase B — 中文通路修复（B1 参考文献 / B2 跨语言检索）

**B1**（样本 8 份 = 7 CJIG 中文 + 1 英文编译对照；SHA 与金标准冻结于 phase-b）：

| 指标 | before | after |
|---|---|---|
| 中文样本参考文献条数 | 7/7 全 0 | 465 条（19~121/篇） |
| DOI 口径 recall（对 DOI 终止符金标准） | 0 | **405/407 = 99.5%** |
| 条目碎片 / 图注页眉混入 / 过合并 | —（无条目） | 0 / 0 / 0 |
| 正文 author-year 引用标记 | 0 | 226 个（全/半角括号 + 等人） |
| 英文对照 b1 | 23 条 | 23 条（行为不变 ✓） |

修复要点（全部确定性、无模型）：双语节标题正则；「姓氏+缩写行首 AND 上一行终止符
（DOI 括号/URL/页码/右括号/卷号）」的 author-year 条目合并（解决长作者列表跨行误切——
ViT/Attention 等真实案例定位）；DOI/URL 印刷空格去除（despaceIdentifierSpans）；
U+2043 入 HYPHEN_VARIANTS；CJK 页眉（含「第N卷」签名）过滤；CJIG 著录解析
（Authors. Year. Title//Venue + 年份后缀 2021c/2021 d + EB/OL 剥离）。
已知残留 2 条 DOI（机构作者条目起点、1 例断行链）——按 precision 纪律不放宽，如实披露。
回归测试：referenceExtraction/pdfIngest +23 用例（真实文本层片段 fixture）。

**B2**（任务与工件 phase-b/b2-tasks）：

- 条目解析（真实产品路径）：8 任务（4 稿件 × 2 条目，查询剥离印刷 DOI 防作弊）→
  **Crossref R@5=R@10=8/8（100%）**，含 1 条查询为残缺 venue 片段仍 bibliographic 命中@2（披露）。
- DOI 直查：39/40 解析（97.5%）、30/40（75%）带摘要 → pool abstract 级材料可得。
- 主题发现（通道 B）：before（中文题名/空查询）8/8 臂全 0 条（含 arXiv）；after（确定性英文信号：
  引用格式行/首页英文题名 + Key words）在有响应的 provider 上返回在题结果（关键词重叠 0.41-0.49）。
- 环境事实（如实）：S2/OpenAlex title.search 本机 IP 级 429/fetch-failed（curl 直测复现，
  与 M15.14 工件同象）；OpenAlex works/doi 端点同窗口正常——限流按端点/主机不同，不作能力结论。

## Phase C — 全文证据可判定性（7 新家族 × P0/P1/P2 三臂）

预注册（ORACLE_PREREGISTRATION.md，运行前冻结）→ 运行 → 机械评估（eval/mechanical.json）
+ 人工语义核验 → 裁决（C_RESULTS_AND_DECISION.md）。

| 指标 | P0 abstract | P1 one-shot+全文 | P2 audit+全文 |
|---|---|---|---|
| 实现级（fulltext 基）判定 | 0/7 ✓正确弃权 | 7/7 | 7/7 |
| 目标比较 quote 材料内回放 | 5/7（摘要级） | **9/21 ⚠️** | **7/7 全核验**（+3 降级/2 捕获） |
| oracle 语义吻合（人工逐例） | 仅思想级 | 7/7 | 7/7 |
| 成本 | 7 调用/186s | 7 调用/174s | 22 调用/699s（~$0.10/族） |

家族：ByteTrack/SORT、OC-SORT/SORT、OC-SORT/DeepSORT、TrackFormer/DETR、
**case-R（中文）/DBNet**、HOTA/IDF1、MOTR/Tracktor（全部新取；M15.14 fam-q-* 未用作测试）。

真实案例摘录（完整版见 phase-d 报告）：
- **F5（中文路径）**：case-R 贡献「层级语义融合」vs DBNet（arXiv 1911.08947，2019）——
  共同机制（分割框架+二值化，quote DBNet 摘要原文）+ 实质差异（局部 SLM/全局 IGM 语义解耦
  vs 可微二值化）+ 待验证（效率对比/显著性/消融只覆盖 Total-Text）；并发现已发表论文的
  表述-证据不匹配：ICDAR2015 F 值 87.0 < DBNet++ 87.3 而结论称"3 个数据集上获得更高精度"。
- **F1**：ByteTrack（arXiv 2110.06864，2021）vs SORT（arXiv 1602.00763，2016 §3.3）——
  P0 只能 POTENTIAL_OVERLAP（abstract 基）；全文后实现级 SUPPORTED_DIFFERENCE
  （τhigh/Dhigh/Dlow 二段关联）+ SORT §3.3 逐字 quote 回放。
- **F7（摘要相似、机制不同的误判风险案例）**：MOTR vs Tracktor 摘要都宣称"免显式关联"，
  P0 给 EVIDENCE_GAP；全文后正确区分（回归传播 vs 学习式 track query）。

**不采用 GO_SIMPLE_ONE_SHOT 的理由**：P1 的 12/21 目标比较 quote 不可在给定材料内回放
（模型记忆文本或失真，输出无标记区分）——贡献级学术风险评估要求可审计，P1 形态不满足。

## Phase D — 真实目标期刊用户路径（CJIG 主 + CEA 差分）

- `report-cjig-caseR.md`：官方 12 条逐字要求（含来源 URL）+ 观测带（23 篇冻结语料确定性重算：
  正文词数 p25-p75≈7038-17310，折算口径披露）+ 五组证据分级比较 + 行动清单
  （可改写/须作者决策分类）。合规层 NOT_EVALUATED（PDF-only 需 LaTeX）如实呈现；
  但 B1 之后 references.count/doiCoverage/recent10yRatio 类要求在 PDF 上亦可机检（新增能力）。
- `report-cjig-b1.md`：作者综述稿；survey 语义（不因缺实验降档）；M15.14 基线（3 项格式违规 +
  12 候选摘要级 pool）+ 本轮 fulltext 增强 P2（HOTA/IDF1 方法节摘录入 pool，3 调用）。
- `differential-caseR-CJIG-vs-CEA.md`：同稿差分——真实差异（官方要求条数/栏目/范围、
  观测带可得性）与"不可得知"（学术质量档位）明确分列；CEA 缺全文语料如实降置信，
  不以 CJIG 带冒充。
- 三份报告全部限定性表述，无录用概率、无"达到录用水平"措辞。

## 成本、许可与数据

- 物理模型调用 **39 次**（P0 7 + P1 7 + P2 22 + b1 增强 3），预算 200 上限内；
  估算费用 ≈ $1.3；墙钟（含下载与确定性准备）约 2 小时。逐调用台账 phase-c/model-calls.jsonl。
- 原始 PDF（arXiv/CJIG OA）与样本映射留在仓库外 `D:\PaperTeamData\M15\M15_15\`，
  `MANIFEST.json` 逐文件 SHA256（phase-b/c/d）；仓库只入源码/测试/脚本/脱敏结论文档。
- 未绕过任何登录墙/反爬；S2/OpenAlex 限流按服务条款退避重试后如实降级。

## 代码变更（backend/src + tests + scripts/m1515）

- `paper/sectionChunking.ts`：双语参考文献节标题（+测试）。
- `citation/referenceText.ts`：U+2043 断词符（归一化版本 v2→v3）。
- `paper/ReferenceExtractor.ts`：author-year 条目合并（起点+终止符双信号）、非条目单元过滤、
  DOI/URL 印刷空格修复、CJIG 著录解析、全角 author-year callout（+测试 23 用例）。
- `target/ContributionAuditService.ts`：`verified_fulltext` 内容级（excerpt 渲染/指纹/提示词）、
  prior quote 回放守卫（priorQuoteVerified + priorQuoteReplayFailures）、
  fulltext 基降级守卫（fulltextBasisDowngrades）（+测试）。
- `scripts/m1515/`：b1-extract-references / b1-audit-quality / b2-cross-language-retrieval /
  c-prep-families / c-run-arms / c-evaluate / d-b1-enhance / d-generate-report（可复现）。

## 下一步（含止损）

1. 小范围 advisory 接入：target 面板加"证据审计"入口（复用现有 ContributionAuditService +
   fulltext pool 构造），Feature Flag 可回滚；**不接默认生产、不加新 Reviewer 链**。
2. B1 修复直接产品化收益：PDF-only 中文稿件的文献类官方要求机检（数量/近 10 年占比/DOI 覆盖）。
3. 剩余版式（CEA 全文语料、纯中文著录条目、arXiv LaTeX 文献表）按需求排期，不为本轮补。
4. 止损声明：若接入后真实使用中 fulltext 摘录获取成本或误判率不可接受，回退到
   one-shot+摘要级材料（M15.14 A0 形态），M15 保持 INCOMPLETE 直到有期刊级人类标签。

**M15_OVERALL = INCOMPLETE**（期刊质量校准 0 标签事实不变；本轮不声称任何"达到录用水平"）。
