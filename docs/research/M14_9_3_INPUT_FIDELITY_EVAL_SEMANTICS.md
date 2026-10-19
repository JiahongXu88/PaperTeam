# M14.9.3 — 论文输入保真门与已发表论文只读评估语义

> 基线 `aa2838f`（M14.9.2）。本文只记录机制、契约与汇总结论；16 篇真实期刊论文的 PDF、转写稿、源证据、
> 逐篇审计与冻结的模型输出都在仓库外（`D:\PaperTeamData\M14_9_3_InputFidelity_EvalSemantics`），不入库。
> 本轮 **0 次真实模型调用**：所有结论来自确定性校验、零模型回放与 scripted runtime 链路验收。

## 1. 为什么 M14.9.2 的等价门没发现 6 篇正文被删

| 缺陷 | 产生位置 | 机制 | 等价门漏判原因 |
|---|---|---|---|
| 引言被删（P002/P003/P005/P006/P014，356–2 010 字） | 仓库外转写器 v1 | 首页脚注「作者简介」命中后进入「删到下一标题」模式 | 等价门清单 = 原文 − 转写器自己声明的「授权删除」；被误删的引言从未进入应保留集合（自证循环） |
| 表题 / 2.3 节 / 讨论句被删（P008） | 同上 | 题名前 10 字在版边块中子串命中即判页眉 | 同上 |
| 勾选列错位（P005/P011） | docling 表格网格 | √ 基线偏移，被并入错误单元格 / 重复展开 | 逐表只比数值多重集，√ 不是数值、位置不查 |
| 公式乱码 / 上下标拍平 | 文本层无 LaTeX | 分式、上下限、Symbol 分段字形无法线性化 | PDF 清单 `math: []`，词元覆盖照样 100% |

## 2. 输入保真联合门（`backend/src/review/inputFidelity*.ts`）

输入：**独立源证据**（`paperteam.input-fidelity.source/v1`，由不共享转写器任何字段分类 / 删除 / 合并逻辑的抽取器从
PDF 文本层生成）× 投影 Markdown × 删除清单。检查：

- **删除侧审计**：每个未出现在投影中的源块必须由删除条目（页 + bbox / 摘录）解释；被删文本取自**源**，扣除字段片段后
  仍像正文 → `ILLEGITIMATE_DELETION`。标题 / 题注 / 参考文献永不可作为元数据删除。字段签名分强弱：邮箱、收稿日期、
  中图号 / DOI、「男 / 女 + 出生年」、基金编号、邮编等强签名才能把一句话判成元数据；「大学」「基金」「作者」这类弱词
  只在 ≤30 字的短片段里生效——正文「某大学发布的数据集」「得到国家自然科学基金支持」必须保留。删除种类是闭集。
- **有序覆盖**：源块按独立版面阅读顺序（通栏 / 居中行分带，带内左栏→右栏）在投影中的唯一锚点做 LIS；同一投影段落只能
  拼接源顺序相邻的正文块（跨越 ≥2 个已放置正文块 = 不相邻段落被拼成一个论证链）。版面顺序不可靠或单块不单调只要求
  人工 QA；拉丁文为主的块按词袋 / 双词覆盖判定，不参与顺序证据。
- **反向可追溯**：续页标记界定的他文区域不得出现在投影中；参考文献条目覆盖与编号序列一致。
- **表格**：文本层逐词坐标独立复原列位置（表头叶子 / 跨行表头前缀定位列中心，符号行并入最近数据行），逐行逐列比较数值
  与 √ × ①… 符号；数值多出 / 缺失、勾选错位、解析器补出的列序号表头 = 硬失败；表头无法定位 / 换行单元格 = 人工 QA。
  多级表头组标题按子列重复、千分组 / 跨行表头的分词差异按可解释差异处理。
- **公式**：只有「无叠行 / 分段字形 / 位移空括号 / 私用区字形，且全部上下标按顺序以 `^{}` / `_{}` 显式编码」才
  `VERIFIED`；其余必须标 `FORMULA_UNVERIFIED`（人工 QA），未标记而以普通公式呈现 = `STRUCTURE_LOST` / `GARBLED`
  硬失败。源证据公式区无内容 = `UNVERIFIABLE_SOURCE`（人工 QA）。
- **图 / 行内上下标 / 身份残留**：图占位缺失、正文行内上下标被拍平、身份词 / 投稿元数据字段残留 → 人工 QA。

状态：`VALID_FOR_SCORING` / `REQUIRES_HUMAN_QA` / `INVALID_INPUT` / `SOURCE_INCOMPLETE`；兼容字段 `legacyStatus`
只有 `VALID_FOR_SCORING` 映射为 `VALID`；`fullPaperQuantitativeScoring=false` 时只允许带未审范围说明的局部只读审阅。
M14.9.1 的 `checkEquivalence` 同步补上逐行删除侧审计（`auditAuthorizedRemovals`），旧门在 v1 上也能拦截。
CLI：`node scripts/m1493-input-fidelity.mjs --source … --projection … --deletions … --out …`（退出码 0 / 2 / 3）。

## 3. 第三方已发表论文只读评估（`backend/src/review/reviewPurpose.ts`）

- run request `reviewPurpose`：缺省 `author_manuscript`（不写入 request，prompt / Gate 逐字节不变）；
  `published_paper_assessment` 只在 `idea_to_paper` 生效，其他工作流 HTTP 400、stage 级 fail-closed。
- Reviewer：以「论文自报（PAPER_REPORTED）/ 未独立核验」口径替换 Experiment Policy；稿内算术、表文一致、统计方向、
  显著性、引用与逻辑照常按严重度报告；只有缺原始数据确实阻碍某个结论时才以 minor / 非阻断的
  `EXTERNAL_VALIDATION_REQUIRED` 单列；fact 模式不再要求把自报结果判 UNSUPPORTED。
- Quality Gate：生产规则、80 分阈值原样执行；另落盘 `reviews/published-assessment-r{n}.json`：
  `PUBLICATION_GATE_NOT_APPLICABLE`、科研 finding / 证据可得性限制 / 投稿清单 / 转写伪影分列，逐规则 applicability
  （无 citation 报告 / 证据库 / claims / 可行性 → `NOT_EVALUATED`，不是 PASS；80 分 → `REPORTED_ONLY`）。

## 4. 真实语料零模型回放（16 篇，汇总）

| 版本 | VALID_FOR_SCORING | REQUIRES_HUMAN_QA | INVALID_INPUT |
|---|---|---|---|
| v1（M14.9.2 冻结、已评分） | 0 | 4 | 12（6 篇误删全部 `ILLEGITIMATE_DELETION`） |
| v2（M14.9.2 修复稿，未评分） | 0 | 4 | 12（P008/P009 英文摘要、P011/P014 中文关键词仍被删；公式未标记） |
| v3（本轮转写器） | 0 | 14 | 2（P005 / P011 勾选表网格错误，人工看图确认） |

- v3 只改 root-cause 表列出的缺陷：片段级字段删除、删除清单带来源锚点、他文区域不回填、可证明顺序时才显式编码上下标、
  不可核验公式一律标 `FORMULA_UNVERIFIED`（不生成 LaTeX）、docling 列序号表头还原、可疑勾选网格标 `TABLE_UNVERIFIED`；
  其余 10 篇规范化文本与 v2 基本一致（P001/P004/P010/P012/P016 逐字符相同）。
- `READY_FOR_NEW_BENCHMARK=false`：没有一篇达到 `VALID_FOR_SCORING`（公式结构、表格单元位置无法自动可信核验）。
- 冻结的 M14.9.2 结论（53.6 vs 53.1、AUROC 0.66、4/4 Gate FAIL）保持为「受缺陷输入影响的历史结果」，本轮未重评、未覆盖。
