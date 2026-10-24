# M15.4.0 — 开源方案复用架构审计（Build-vs-Reuse，只读调查）

- 日期：2026-10-24；基线 `964359c`（== `origin/main`，工作树 clean；同步前本地 `2dd2766`，`git pull --ff-only` 快进 59 提交，无冲突）。
- 性质：**静态调研 + 架构裁决报告**。零源码/测试/阈值/编排改动、零模型调用、零 pip/npm 安装、零 Docker、零仓库克隆（全部上游源码经 gh api / 网页只读获取，敏感材料与样本不入仓库）。本报告不改变 M15.3.4 `PARTIAL` 定性，不宣称任何集成已完成。
- 任务背景：M15.3.4 后怀疑"连续扩充 `claimCertificate.ts` 规则是在重复造轮子"，本轮用源码证据裁决 Build-vs-Reuse：复用、借鉴、还是必须自研。

## 0. 一页结论

**裁决：`BUILD_THIN_ADAPTER_OVER_KEEP`——保留现有确定性证书器为地基（D），首选新增"极薄模型结构化证据候选 Adapter"（C）攻未覆盖的实体消解长尾；docling-graph（A）只借鉴设计、不引入依赖；paper-qa 式检索辅助定位（B）明确拒绝。**

1. **"重复造轮子"的判定：核心轮子市场上不存在。** 五个被查项目没有任何一个提供「论文正文 claim → LaTeX/PDF 表格单元格（tableId+row+col+span）的确定性唯一绑定 + 显示精度区间数值核验」。PaperTeam 自研的 `latexTable.ts`（内容寻址 tableId、rowKey/headerPath/parseIssues）与 `claimCertificate.ts`（UNIQUE/B2/B3/双钥匙/区间算术）在全部被查对象中是独有能力——不是轮子重复，是市场空白。
2. **真正在重复的部分是「实体/指标候选生成」这一层，而它不该继续用规则手写。** M15.3.0 六桶中最大桶 METRIC_ROW_BINDING(22)+DERIVED(15) 的共同根因是"论断不点名指标 / 缩写 / 跨段实体消解 / 跨表同名行"——这正是 docling-graph、paper-qa 各自用 LLM（有损）在做、PaperTeam 一直用别名词典与绑定规则硬追（M15.3.2 逐词裁决只剩 `oa` 一条 GO、M15.3.4 A3 真实语料零触发）的方向。规则路径边际收益已趋零；正确的外包对象是**模型生成结构化候选**（方案 C），而**不是**任何被查框架——它们到不了单元格粒度。
3. **五仓库一句话裁决**：docling-graph=**可借鉴设计**（provenance ledger 分级/守卫一流，但 `ResolutionLevel` 无 cell、表格被 chunker 拍平、数值不做 verbatim 定位、单人维护已静默 3 个月）；paper-qa=**任务不匹配**（chunk=5000字符滑窗、表格主动降维成 PNG+markdown、引用粒度止步页码区间、全链路 LLM 有损）；OpenScholar=**可借鉴设计**（否决式归因协议）；multivers=**任务不匹配**（句子级三分类研究原型，无数值比对）；SciFact=**可借鉴设计（评价参考格式）**（claims/evidence schema 与分层指标几乎可平移为本项目评测协议）。
4. **下一步**：M15.4.1 POC——「CandidateProposer：模型提出结构化证据候选，确定性证书器核验」（§8，只设计，本轮未实施、未取得任何收益）。

## 1. 调查范围与方法

- **阶段 0（同步）**：实际仓库路径 `D:\Projects\PaperTeam`，remote 核实为 `JiahongXu88/PaperTeam`；同步前 `2dd2766`（M14.3）→ fetch 后确认纯快进（落后 59、领先 0）→ `pull --ff-only` → HEAD==origin/main==`964359cd192b4e6d65906add81fe1dfb8cf1174d`（与任务书核对 SHA 一致），工作树 clean。未开新分支、未 stash/reset。
- **上游取证纪律**：全部经 `gh api`（branches/commits/contents/license/search）+ PyPI JSON API 只读；zread 未收录 docling-graph/multivers/scifact，改逐文件读取。五仓库 HEAD SHA 与 License 均由本轮独立复核（非仅 README 声明）。未 clone、未安装、未下载权重；`allenai/ursus` 404 如实记 NOT_VERIFIED。
- **本地源码**：`backend/src/review/`（claimCertificate/latexTable/derivedFormula/claimAudit/findingVerification/findingAdjudication）、`backend/src/ingestion/`、`backend/src/retrieval/`、`backend/src/quality/` 全部只读。

## 2. PaperTeam 现状（源码证据）

### 2.1 管线

```
被审稿 LaTeX 源文件
  └─ latexTable.ts:parseLatexTables ──→ 结构化表格（tableId=sha256(content)[0:16]、row/col、
  │        rowKey、headerPath(多级展开)、caption/label、unit、value+offset、parseIssues fail-closed）
  └─ Reviewer 单元审稿 ──→ claims/foundings
       └─ claimAudit.ts ──→ 论断账本（claimId=sha256(file|NFKC quote|序号)；引文逐字定位，定位失败进 rejected）
            └─ claimCertificate.ts ──→ claim-certificate/v1 证书（唯一强判来源）
                 ├─ locateAtom：span 内值+精度逐字定位（表格数值格优先）
                 ├─ bindTextAtom：列维(指标词就近+A1层级距离)+行维(方法名/本文别名)+语境维(caption/数据集)
                 │    三维打分唯一绑定；A2 值重合破平；B2=VALUE_APPEARS_IN_OTHER_TABLE；B3=限定词族防线；
                 │    respectively 位置对齐；UNEXPLAINED_TERM/QUALIFIER/DISCRIMINATING_TERM 拒绝
                 ├─ compareAtoms：显示精度区间 + 单位换算 + 10^k 量纲歧义（derivedFormula.ts）
                 ├─ recomputeDerived：措辞→运算族→受控 AST 白名单+区间算术（A3 操作数发现）
                 └─ 双钥匙：模型 check(CONSISTENT/INCONSISTENT) 与确定性结论一致才升级；
                      provenance.correspondenceProposedBy ∈ {model, deterministic}
  证据池（引用文献）: DoclingParser(PDF→块级provenance) → RetrievalService(hybrid RRF, lexical+dense)
                     ——Retrieved ≠ Verified（无 EvidenceStore 写路径）
  裁决: findingAdjudication.ts 四轴(S/V/Impact/TaskScope) + qualityDecisionV2.ts
       ——全部 shadow；生产 gates.ts/revisionTaskGate.ts 不读证书与 V2 产物（SHADOW 边界已核实：
         gates.ts 无 SHADOW 标记、不 import claimCertificate；V2 自标 SHADOW_ONLY）
```

### 2.2 已有能力清单（哪些环节不是空白）

| 能力 | 提供方 | 说明 |
|---|---|---|
| 表格结构解析（多级表头/行组/caption/label/单位/偏移） | `latexTable.ts`（LATEX_TABLE_PARSER_VERSION=latex-table/v1） | 确定性、零模型；解析失败如实记 parseIssues 拒证 |
| 数值显示精度区间算术/单位换算 | `derivedFormula.ts` | 白名单 AST，不执行任意表达式 |
| claim→单元格唯一绑定 + 跨表/限定词防线 | `claimCertificate.ts::bindTextAtom`（B2/B3/A1/A2） | fail-closed；宁弃勿错 |
| 论断账本与逐字定位 | `claimAudit.ts`（CLAIM_ID_RULE；VERIFIED_* 只来自证书） | 模型判断只能给 REVIEWER_* |
| 派生量复算 | `recomputeDerived`（A3） | 解释唯一才出证 |
| PDF 块级 provenance（page/bbox/parserBlockId） | `ingestion/DoclingParser.ts` + `types.ts::ParsedProvenance` | 证据池用；不覆盖被审稿的 LaTeX 表格 |
| 混合检索（证据池） | `retrieval/RetrievalService.ts` | 与证书路径隔离 |
| 定向复核（有界问证） | `findingVerification.ts`（shadow） | 模型引文必须逐字落在候选片段 |
| 影子四轴裁决 | `findingAdjudication.ts` / `qualityDecisionV2.ts` | 生产 Gate 不读 |

### 2.3 空白（M15.3.0 六桶 × 所需能力）

| 工程根因桶 | n | 缺的能力 | 已试路径与结论 |
|---|---|---|---|
| METRIC_ROW_BINDING | 22 | **结构化指标本体/全文实体消解**：论断不点名指标(12)、缩写词典(4)、多级表头非指标叶(2)、subset 限定(2)、比较对象(2,已修) | 别名词典：M15.3.2 全库逐词裁决仅 `oa` 一条 GO（maf1/mif1 NO_GO——会制造 TIED 平分摧毁既有收益）；层级距离：M15.3.4 A1 已做 |
| DERIVED_CALCULATION | 15 | 论断不点名派生量指标；对端是均值/份额 | A3 操作数发现：真实语料 0 触发（稀有度守卫按预登记工作） |
| TABLE_STRUCTURE | 8 | PDF 转写表 garbled（数字叶、rowKey 空）——**解析质量问题** | 属 latexTable/输入层，非绑定语义 |
| GENUINE_AMBIGUITY | 5 | 无（正确弃判） | — |
| PARSER_OR_INPUT_GAP | 6 | 注入层 | 非核验器问题 |
| DEV_TUNE 未覆盖（M15.3.4 §9.2） | 41 | 跨表同名行、行内多指标共享值、**跨段实体消解的量纲前缀** | 预登记明确"不属方案A 机制族，需要结构化指标本体/全文实体图" |

**结论**：空白集中在「论文内实体/指标的语义候选层」，不在「确定性核验层」。这决定了复用调查的问题式：*有没有人做出了"能落到单元格粒度、可确定性核验"的候选生成器？*

## 3. 开源调研结果

### 3.1 信息矩阵（本轮实测；SHA/license 已独立复核）

| 仓库 | HEAD（分支） | 最近实质提交 | License | Stars | 语言/部署门槛 | 裁决 |
|---|---|---|---|---|---|---|
| docling-project/docling-graph | `bbcd0e4`（main） | 2026-07-17（此后仅 dependabot） | MIT（IBM） | 936 | Python≥3.10；docling≥2.105、litellm、networkx；LLM 需 key 或本地端点 | **可借鉴设计**（若实测则需 Adapter） |
| Future-House/paper-qa | `57e89f7`（main） | 2026-08-12（此后维护走低） | Apache-2.0 | 9459 | Python≥3.11；fhaviary/fhlmi；OpenAI 默认 key | **任务不匹配** |
| AkariAsai/OpenScholar | `0e9b8fb`（main） | 2025-08-13（14 个月停更） | Apache-2.0 | 1675 | vLLM+8B 权重 / S2+you.com key | 可借鉴设计 |
| dwadden/multivers | `a6ce033`（main） | 2023-08-16 | MIT | 54 | torch 1.7.1 锁死、GPU、自建 checkpoint | 任务不匹配 |
| allenai/scifact | `68b98a5`（master） | 2023-10-15 | 代码 Apache-2.0 / 数据 CC BY 4.0+ODC-By | 279 | 无权重依赖；评测库 ~300 行纯 Python | 可借鉴设计（评价参考格式） |

### 3.2 docling-graph（第一梯队，深读）

**定位**：docling 官方生态（IBM 主导）"文档→可验证知识图谱"。工程卫生极好（mypy strict、semantic-release、SSRF 单测），README 声称与源码实现抽查全部兑现。

**关键源码证据**（逐文件读取）：
- **provenance 粒度（靶心问题）**：`core/provenance/models.py` 定义 `ResolutionLevel = document/page/batch/chunk/span`——**枚举无 cell**。台账是确定性 sidecar（docstring："never from LLM output"），`ItemGeometry` 到 Docling item `self_ref`（表格=`#/tables/N`）+ 页码 + bbox 为止；`SourceAnchor.span` 是 **chunk 文本内**字符偏移，不是文档偏移。`document_processor.py` 中 cell 级匹配被显式注释删除（"do_cell_matching attribute removed in docling v2.60.0+"）；HybridChunker 把表格序列化为 markdown 文本（模块 docstring "Tables (not split across chunks)"——不切但拍平）。
- **绑定双段设计（值得抄）**：记录段（解析 bookkeeping 直接产出 observed anchor）+ 绑定段（`binder.py`：identity 精确→唯一 fuzzy containment→`anchor_scan.locate_values()` 纯字符串扫描出 verbatim span，注释 "pure string search, never an LLM"；解析阶梯 "fail-empty, never fail-wrong"）。守卫：非特异词 >6 chunk 命中整组丢弃、纯数字 <4 位跳过。
- **数值不核验**：skeleton prompt 明令 "Copy numeric values digit-for-digit…never compute"；但 binder 只对 identity 与 ≤300 字符短字符串字段做 verbatim 定位，**QuantityWithUnit 数值字段不做任何"值是否真在所指位置出现"的核验**——抽取即采信。
- **实体类型**：无预置学术本体；类型来自用户 Pydantic 模板（`graph_id_fields`/`edge("LABEL")`）。最接近的官方示例是流变学材料论文模板（`docs/examples/templates/rheology_research.py`，44KB），MOT/CS 论文需自写数百行模板或 LLM 诱导。
- **查询**：networkx 内存图 + JSON/CSV/Cypher 导出；无"指标 X 在哪个表哪行哪列"式语义查询接口。
- **风险**：人工提交最后 2026-07-17（3 个月静默）；bus factor=1（ayoub-ibm 372/约440 人工提交）；全库纯 issue 仅 5 个（高star低采用信号）；9 个月冲到 v1.9.1，API 仍在演化。

**结论**：它是市面上把「确定性 provenance + LLM 结构化抽取」做得最认真完整的工程，与 claimCertificate 哲学同源；但 **cell 级绑定这个轮子它没有**——不是"能直接解决核验证书"的依赖，而是该抄的图纸。

### 3.3 paper-qa（第一梯队，深读）

- Apache-2.0 monorepo（v2026.8.12）。链路 `Docs.aadd→read_doc→retrieve_texts(MMR)→aget_evidence(RCS 摘要+0-10打分)→aquery`。
- **粒度证据**：`readers.py::chunk_pdf` 是**纯 5000 字符滑窗**（overlap 250），表格可被切在中间；`Text` 无 char offset；三个 PDF 读取器都把表格降维——pypdf 读取器 `find_tables()` 只裁 PNG+bbox；**docling 读取器把 TableItem `export_to_markdown` 拍平成字符串（cell 结构在 wrapper 层主动丢弃）**；引用粒度=chunk 名（页码区间）+ pqac key，幻觉引用会被剥离但定位止步于此。
- **确定性证据**：RCS 是"有损 LLM 重写"；`llm_parse_json` 本身就是为容错 LLM 输出而写——与确定性签发证书在设计哲学上相反。
- **分级**：可借鉴=`llm_parse_json` 防御性 JSON 修复、pqac 稳定短哈希 key+引用正反例约束+幻觉剥离、Context 预算控制（`(-score,name)` 排序+cutoff+max_sources）；需 Adapter 才可用=MMR 向量检索（~50 行 numpy 可译 TS）、pdfplumber 表格区域检测（但不如直连 docling-core 拿 cell 结构）；**明确不替**=RCS 摘要链、滑窗切分、gen_answer、agent 循环（fhaviary/fhlmi 重依赖）。

### 3.4 第二梯队（轻量）

- **OpenScholar**（Apache-2.0，停更 14 个月）：跨文献综合；自反馈=`open_scholar.py::get_feedback`，来源校验=`insert_attributions_posthoc`（本质一个 LLM prompt 让模型逐句插 `[n]`，**无确定性校验器**）。可借鉴：否决式归因协议（"未被任何段落支撑则不插引"）、feedback→补检索→再编辑闭环、检索三层模块划分。
- **multivers**（MIT，2023 研究原型）：Longformer 句级 rationale 二分类 + 文档级 SUPPORT/CONTRADICT/NEI 三分类；**无数值抽取与比对**；证据=摘要句下标。torch 1.7.1 环境在现代栈基本不可装。可记：任务分解语言（证据定位与真伪判断分离、NEI 阈值截断）。
- **SciFact**（代码 Apache-2.0/数据 CC BY 4.0）：**最有参考价值的是标注与评测格式**——`Claim = {id, claim, evidence:{doc_id:[{sentences[], label}]}, cited_doc_ids}` 与 FEVER 式分层指标（label-only vs rationalized、证据源级 vs 片段级）几乎可平移为本项目评测协议：doc_id→tableId、sentence idx→(row,col,span)。`allenai/ursus` 标注工具 404（NOT_VERIFIED）。
- **相邻提名**（仅提名不展开）：TabFact（整表级 SUPPORT/REFUTE，非单元格定位）；TAPAS（单元格选择监督信号，设计参照）；HiTab（层级表 QA 最接近 LaTeX 论文表结构，license 未标需核）；ToTTo（句子↔单元格高亮区间的现成标注格式）。

## 4. Build-vs-Reuse 四架构裁决

| 对比维 | A：docling-graph→有型实体候选→自研证书器 | B：paper-qa 式检索/重排辅助定位 | C：极薄"模型结构化证据候选"Adapter→现有 Guard/Certificate | D：保留自研规则路径，补表格/实体映射缺口 |
|---|---|---|---|---|
| Method/Dataset/Metric/Condition/Baseline/公式绑定 | 需自写 MOT 模板后可出**实体候选**；claim 概念不存在 | ✗ 不面向论文内绑定 | ✓ 模型按 claim 逐条提出全部字段候选（含派生操作数） | 部分有（别名/层级距离已到顶） |
| 落到 tableId/row/col/offset/caption/label/版本 SHA | ✗ 上限 `#/tables/N`+chunk 内 span | ✗ 上限页码区间+像素 bbox | ✓ 候选即 (tableId,row,col,sourceSpan)，核验侧已有全部锚 | ✓ 已有（本就是自研强项） |
| 新错误强判/数值巧合选证据风险 | LLM 抽取值不核验即采信；需本方防线兜底 | 高（有损重写） | **中**：候选必须过 UNIQUE/B2/B3/值核验/双钥匙；proposal 只是提示不是证据 | 低（fail-closed 设计） |
| 不破坏 UNIQUE/B2/B3/双钥匙/EvidenceStore/SHADOW 边界 | 可保持（候选只进输入侧） | 难以保持 | 可保持（加性字段 `binding.modelProposed`，合同只加不改；SHADOW 不变） | 天然保持 |
| 依赖/复杂度/成本 | +Python 子进程、litellm、HF tokenizer 下载、自写模板、单人维护静默期供应链风险 | +fhaviary/fhlmi 重依赖 | **最低**：复用现有 GLM/Pi 通道，1 次/claim 的结构化 JSON 调用，零新依赖 | 零 |
| 与现有 Docling/RAG/Pi 重叠 | 高（分块/抽取/账本皆重叠；provenance ledger 是增量） | 高（检索与 RetrievalService 重叠） | 低（增量层） | — |
| 源码证据强度 | 强（逐文件，见 §3.2） | 强（§3.3） | N/A（新建） | 强（本仓库） |

**优先级排序**：
1. **首选：C（+D 为地基）**。理由：唯一同时满足"攻进未覆盖桶（实体消解/不点名指标/跨表同名行）+ 零单元格粒度损失 + 不破坏零错误强判纪律 + 零新依赖"。模型提案**永远**只是候选：确定性核验器逐条验证值、唯一性、限定词、跨表竞争、双钥匙——本轮明确"绝不让模型直接铸造证书"。
2. **备选/实验位：A 的 Adapter 路径**。仅当 M15.4.1 POC 想对照"本地 LLM+provenance ledger 的候选生成器"时，把 docling-graph 当**实验性候选生产器**（Python 子进程出候选 JSON），row/col/数值核验仍在 TS 端。不作为生产依赖（供应链+静默期+模板维护成本）。
3. **不能做的方向**：B（检索/重排定位到单元格——粒度结构性缺失）；引入任何"模型输出即证据"的路径；为覆盖长尾继续手写别名词典（M15.3.2 已证会制造 TIED 平分回退）。
4. **未解决的未知数**：模型候选的提案质量（GLM 在结构化绑定上的 binding accuracy 未知——恰是 POC 要测的）；PDF-only 稿件的 TABLE_STRUCTURE 桶（8 例）C 也救不了，需另立解析侧工作；C 的调用成本上限。

## 5. 复用 / 借鉴 / 放弃清单（重复造轮子裁决）

**保留自研（有证据的市场空白，不动）**：`latexTable.ts` 全部；`claimCertificate.ts` 的 locateAtom/bindTextAtom 骨架、B2/B3、A1/A2、compareAtoms、recomputeDerived/受控 AST、双钥匙；claimAudit 账本纪律。**应停止的做法**：继续用 SYNONYMS/特判规则追实体消解长尾（M15.3.2 逐词裁决 1 GO、M15.3.4 A3 真实 0 触发，边际收益趋零，且每条别名都有平分回退风险）。

**外包给模型（方案 C 新增，本轮不实施）**：论文内实体/指标/条件的候选生成——这是 docling-graph 与 paper-qa 各自有损地做、但都到不了单元格的那一层；用现有模型通道+结构化 JSON 提案+确定性核验兜底。

**借鉴设计（抄图纸不引依赖）**：
- docling-graph：① provenance sidecar "never from LLM output" + anchor kind 分级（observed/verbatim/derived/reconciled）+ `approximate:true` 诚实标记；② 单一 canonical `identity()` 函数让记录与绑定永不分歧（对应本方"单一锚定函数"原则）；③ verbatim 扫描非特异守卫（>6 chunk 命中即弃、短数字跳过）——可直接加固 claim→span 定位防误绑；④ `template_schema_hash` 进台账的可复现性做法。
- paper-qa：`llm_parse_json` 防御性 JSON 修复套路；稳定短哈希引用键 + 引用键正反例约束 + 幻觉键剥离；证据预算控制。
- OpenScholar：否决式归因协议（无支撑则不引）。
- SciFact：claims/evidence 标注 schema + 分层 FEVER 式指标——作为 M15.4.1 评测产物的格式模板。

**放弃/拒绝**：paper-qa 的 RCS/滑窗/agent 循环；OpenScholar/multivers 运行时（停更原型+任务不匹配）；任何整体框架引入。

## 6. 推荐架构（C 融入后的目标形态，本轮只画图）

```
claims(账本) ──┬─ 现有规则路径 bindTextAtom（原样保留，第一优先）
               └─ CandidateProposer（新增，有界）：对规则路径弃判(UNBOUND/TIED/UNEXPLAINED_*)的 claim，
                    1 次结构化 JSON 调用 → {subject, metric, dataset/conditions, candidates[(tableId,row,col,span)], …}
                          │  （模型只提案；proposal 带 model/promptVersion 溯源）
                          ▼
               合并提示层：提案作为 bindTextAtom 的"准入提示/破平提示"进入候选池
                          ▼
               既有确定性核验（全部不变）：值 OVERLAP、UNIQUE、B2 跨表、B3 限定词、
               派生复算、双钥匙；证书加性标记 binding.modelProposed（不入 inputsSha256 配方）
                          ▼
               claim-certificate/v1（SHADOW 不变；生产 Gate 不读，如故）
```

## 7. 与"直接整套接入"的差距清单（为什么不整体接入任一框架）

1. **证据粒度**：docling-graph `ResolutionLevel` 无 cell、cell-matching 已删、表格 chunk 化拍平；paper-qa 引用止步页码区间、无 char offset；multivers/SciFact 止步摘要句子。→ 单元格粒度只能自研（已有）。
2. **确定性**：paper-qa 全链路 LLM 有损；docling-graph 结构确定性但**抽取值不核验**（数值字段不做 verbatim 定位）。→ 零错误强判纪律无法外包。
3. **claim 概念**：无任何项目有"正文论断→表格单元格"任务定义；docling-graph 的 skeleton prompt 甚至把表格单元定义为"实体间关系"而非可定位对象。
4. **供应链/部署**：docling-graph 单人维护+3 个月静默+API 快速演化；paper-qa 核心冻结+维护走低；multivers 环境锁死 2020；OpenScholar 停更 14 个月。License 均宽松（MIT/Apache），**阻塞项是功能与确定性，不是许可**。
5. **重叠成本**：docling-graph 的分块/抽取/账本与 PaperTeam latexTable/claimAudit/检索层大量重叠，整体引入等于平行维护两套。

## 8. M15.4.1 POC 计划（只设计，本轮未实施、未取得收益）

**名称**：CandidateProposer——模型结构化证据候选 × 确定性核验（方案 C 的最小验证）。

1. **样例**：从已开封语料挑 4 个家族形态做开发样例（明确其只作 DEV，不当 held-out）：①论断不点名指标（N08 族，METRIC_ROW_BINDING 主形态）；②多级表头非指标叶（N12 族）；③跨表同名行（DEV_TUNE 形态）；④派生量不点名指标（N09-P09 族）。回归口径：旧 SEALED/DEV_NEW/FROZEN_NEW 已开封，**只作 EXPOSED_REGRESSION**；另预留 ≥2 个来源独立、在提案器与核验器代码冻结后才开封的新家族作 held-out。
2. **提案 JSON schema（核验侧只读加性）**：`{claimId, proposer:{model, promptVersion}, subject:{kind:"method"|"ours", name, aliases[]}, metric:{name, aliases[]}, datasets:[{name, role}], conditions:[{term}], derivedHint?:{family, operands[]}, candidates:[{file, tableId, row, col, sourceSpan:{start,end}, expectedValue}], abstain?:{reason}}`。**Adapter 位置**：新增 `backend/src/review/candidateProposer.ts`（本轮零实现）；证书合同仅加性字段（`binding.modelProposed`，版本策略与 `valueTieBreak` 先例一致，不入 inputsSha256 配方）。
3. **确定性核验条件**：提案格必须通过——值 displayInterval 与论断值 OVERLAP（B2 跨表守卫照常）、绑定唯一性在"提示准入后的候选池"内仍成立、B3 限定词族解释、双钥匙不变。**失败/弃判原因码**：`PROPOSAL_VALUE_MISMATCH` / `PROPOSAL_NOT_UNIQUE` / `PROPOSAL_REJECTED_BY_GUARD:<原码>` / `PROPOSER_ABSTAIN` / `PROPOSAL_JSON_INVALID`。
4. **对照与指标**：基线=当前 m152 证书器单独；实验=证书器+提案器。分开报告：**Claim Certificate 口径**（正确强判/错误强判/弃判/binding accuracy=提案格==oracle 真值格/provenance 完整度/每 claim 成本与耗时）与 **Reviewer finding 检出率**（不合并）。评分产物采用 SciFact 式分层 schema（label-only vs rationalized：提案正确但核验弃判单独可见）。
5. **停止条件（任一触发即停/回退）**：任一口径新增 WRONG_STRONG>0；既有保护锚丢失（N09-P05 逐字理由、既有 7/57+6/61 正确强判）；事实源边界被破坏（Retrieved≠Verified、EvidenceStore 写路径）；每净增 1 条正确强判的模型成本超过预设上限。
6. **可快速复用的最小件**：现有 GLM 通道与 JSON 工具（借鉴 `llm_parse_json` 防御套路）、claimAudit claimId、latexTable 全套锚、`llm_parse_json` 式解析、SciFact 式评分 schema——预期 POC 体量为"1 个新文件 + 评测脚本"，不是里程碑。

## 9. 风险与待验证项

- **模型提案质量未知**：GLM 在 (tableId,row,col) 提案上的 binding accuracy 是 POC 的核心待测量；若 <50% 且核验弃判率极高，方案 C 收益不成立，回到 D。
- **数值巧合选证据**：模型可能提案"值碰巧一致"的错误格；UNIQUE/B2/值核验是防线，POC 须专门构造反例（同名行跨表+值同现）。
- **提示准入的平分副作用**：提案准入会扩池，可能把既有 UNIQUE 判成 TIED——POC 回归必须含 191 例全量零模型回放。
- **TABLE_STRUCTURE 桶（8 例）不在 C 射程内**：PDF 转写表 garbled 需另立解析侧任务（本轮不动）。
- docling-graph 若未来恢复活跃并补 cell 级 provenance，应重估 A 路径（记录其 v1.9.1 为基线）。

## 10. 可追溯性

| 项 | 值 |
|---|---|
| 本地同步 | `2dd2766` → `964359c`（ff-only，clean；origin/main==HEAD） |
| 上游 HEAD（实测 gh api） | docling-graph `bbcd0e4`；paper-qa `57e89f7`；OpenScholar `0e9b8fb`；multivers `a6ce033`；scifact `68b98a5` |
| 上游取证方式 | gh api contents/commits/branches + PyPI JSON；未 clone/未安装/未下载权重 |
| 本地只读源码 | `backend/src/review/{claimCertificate,latexTable,derivedFormula,claimAudit,findingVerification,findingAdjudication}.ts`、`backend/src/ingestion/`、`backend/src/retrieval/`、`backend/src/quality/` |
| 关联报告 | `M15_3_0_CERTIFICATE_RECALL_ROOT_CAUSE.md`（六桶）、`M15_3_4_SEMANTIC_BINDING_REPORT.md`（PARTIAL） |
| 未验证项 | `allenai/ursus`（404）；docling-graph 在本机 GLM 端点上的实际抽取效果（未运行） |
