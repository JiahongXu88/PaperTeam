# M14.1b — Research Input & Scientific Fact Management（收口报告）

- 日期：2026-10-14
- 基线：`a3e1f7811a67091043998b7e8f8e170c7696e305`（M14.1a COMPLETE）
- 范围：P0 ResearchInput 注册与版本管理；P0 FrozenFact 三态生命周期；P0 冲突检测与裁决；P0 表格单元格 Provenance；P1 Finding → targetQuote；P1 Author Decision 契约；下游 Planner 可消费输入；真实本地材料验证
- 方法纪律：复用既有 SourceStore / Ingestion（docling）/ EvidenceStore / logicalSpan / HITL 机制；全部科研事实边界以确定性代码实现，模型只能提出候选；所有"作者确认"在验证中显式标 `test_fixture`；不提交原始 PDF / 全文解析结果

---

## 1. 最终状态

**M14.1b：COMPLETE**（§15 列出的限制均为如实披露的设计边界，不构成完成标准中的阻断项；真实材料验证中的"作者确认"全部是测试模拟，公开论文未被标为任何用户的个人成果）。

| 完成标准 | 结论 | 证据 |
| --- | --- | --- |
| 五类研究输入可注册；版本链 / 入选状态持久化；版本不互相覆盖；导入 / 重放幂等；下游读取选定版本 | ✅ | §4、`researchInputRegistry.test.ts`、真实材料场景 A（7 个真实 PDF，重复导入 created=false，arXiv v1/v3 自动 same_work） |
| extracted / source_verified / author_confirmed 三态真实可用；晋升只经可靠来源或作者操作；原始事实有 Provenance；未验证内容不能冒充 | ✅ | §5、`factLifecycle.test.ts`、真实材料 1,816 条表格事实 1,801 条文本层核验通过 / 15 条 fail closed |
| 同实验同指标异值可检测；不同协议不被粗暴判冲突；双方来源保留；未裁决冲突不被模型隐式消除；作者决定可持久化追溯 | ✅ | §6、`conflictDetection.test.ts`（8 项）、真实材料场景 B（范登平 表4.3 vs CVPR19 Table 5：3/3 oracle 命中） |
| ≥1 张真实可解析表格实现单元格级来源验证；解析失败有明确状态；不编造无法提取的值 | ✅ | §7、场景 C（表5.1 / Table 1 的 0.452、表4.3 的 0.699、李谨杰 表9 的 1.0523 均到页 / 块 / 行 / 列 + 文本层核验）；13 个私用区字形单元格 + 2 个 docling 畸形单元格拒绝核验 |
| Existing Paper Revision 不回归；M14.1a logicalSpan 不回归；Finding → targetQuote 可验证；可供 Planner 消费；HITL 边界正确 | ✅ | §8–§9、§12（后端全量回归） |
| 本地测试 / Typecheck / Build 通过；至少一组真实材料端到端；无 Mock 冒充；无归属冒认；已提交推送；声明与证据一致 | ✅ | §12–§13、§17 |

## 2. 初始能力审计（Phase A）

对照 `a3e1f78` 源码（三组只读审计子代理 + 主会话复核）：

**已有、直接复用（不重复开发）**
- `SourceStore`（文件 + contentHash 去重 + S### id）、`IngestionService` + docling `ParsedTableBlock`（表格网格 + 页码 / bbox provenance）、`ParsedDocumentStore`、`PyMuPdfParser` 文本层；
- `EvidenceStore`（`verified / user_confirmed` 等级、`location.chunk` 锚）、`EvidenceGroundingService` 候选 → 正式晋升语义；
- `ExperimentPackageService` 的"作者确认 ≠ 外部验证"口径与 per-project 写队列 + `writeJsonAtomic` 模式；
- M14.1a `logicalSpan`（唯一锚点、unresolved 不猜）、`RevisionSpan` Patch Guard、Fact / Citation Preservation；
- 通用 HITL 机制（`awaiting_input` + `POST /runs/:id/resume {decision,payload}`）。

**真正缺失（本轮新增）**
- 无任何 ResearchInput / 版本链 / 成果入选模型（`grep thesis|FrozenFact|ResearchInput backend/src` 为空）；
- 无作者成果事实的三态生命周期：`revisionBaseline` 的事实是无类型 token，无来源核验与作者确认；
- 多来源事实冲突零检测（M14.0 审计 P1-4 原文）；
- 表格只有 `ParsedTableBlock` 网格，无单元格级事实 / Provenance / 跨版本比较；
- `hitl.author_decision` 只存在于设计文档，代码中仅有 Gate 的 `AUTHOR_DECISION_REQUIRED` 终态；
- `ReviewIssue` 没有 quote / 位置字段，`findingItem` 从不设置 `targetQuote`（M14.1a 遗留的 unresolved 主要来源）。

**不开发**：新 PDF parser、thesis workflow stage、学位论文 UI、第二套 EvidenceStore、ConsistencyLedger、Figure 渲染后端。

## 3. 核心模型（`backend/src/thesis/researchInputTypes.ts`，冻结契约）

五个概念严格分离：**Document Source**（SourceStore 条目）→ **ResearchInput** → **ScientificFact** → **Evidence**（既有，只读关联）→ **Author Confirmation**。三种标识分离：`inputId`（身份，`ri-sha256(sourceId|contentHash)[0:12]`）、`sourceId`（来源）、`contentHash`（内容版本）。

| 实体 | 落盘 | 要点 |
| --- | --- | --- |
| `ResearchInput` | `research/research-inputs.json` | `inputType ∈ {published_paper, preprint, submitted_manuscript, unpublished_manuscript, experiment_report}`（材料类型 ≠ 学术验证状态）；`identifiers{doi,arxivId,arxivVersion}`；`versionLabel`；`publicationStatus{value,asOf}`；`workId` 成果分组；`version{sourceId,contentHash,bytes,importedAt}`；`parse{status: pending/full_text/partial/failed/metadata_only/unsupported}`；`scope{status: proposed/included/excluded/superseded, decisionId}`；`unpublishedMaterialPolicy`；`evidenceLinks` |
| `VersionRelation` | 同上 | `kind ∈ {same_work, supersedes, supplements, derived_from}`；`basis ∈ {arxiv_identifier, doi_identifier, content_match, title_similarity, model_candidate, author_decision}`；`status ∈ {candidate, confirmed, rejected}` |
| `WorkGroupState` | 同上 | `inputIds`、`preferredInputId`（只能由 `version_selection` 决定写入） |
| `TableAlignment` | 同上 | `status ∈ {comparable, candidate, not_comparable}` + 结构 / 内容证据（列标签一致、行数、相同单元格、共享标识符、行对标签兼容性） |
| `ScientificFact` | `research/scientific-facts.json` | `kind`（table_cell / numeric_result / dataset / metric / method / parameter / protocol / research_question / conclusion）；`key{subject,dataset,metric,condition,protocol}`；`value{raw,numeric,unit,normalized,glyphIssues}`；`provenance{inputId,sourceId,contentHash,blockId,page,pageBasis: parser/unknown,table{label,labelBasis,rowIndex,columnIndex,rowLabel,columnLabel,headerRowDerived},quote,surfaceHash}`；`extraction{method: deterministic_table/model_candidate/manual}`；`verification{status: extracted/source_verified/author_confirmed, sourceCheck: unchecked/verified/failed, confirmation{decisionId,actor}}`；`conflict{status: none/unresolved/resolved/not_comparable, conflictIds}` |
| `FactConflict` | 同上 | `classification ∈ {value_mismatch, rounding_difference, unit_incomparable, equal_after_unit_normalization}`；`severity`；`parties[]`（双来源定位）；`resolution{decision: adopt_fact/keep_both/request_material/defer, adoptedFactId, decisionId, actor, appliesToContentHashes}` |
| `AuthorDecision` | `research/author-decisions.jsonl`（append-only） | 七类 payload；`actor.kind ∈ {user, test_fixture}`；`applied.effects` |
| `ResearchFactContext` | 派生（不落盘） | 下游分区：`authorConfirmed / sourceVerifiedUnconfirmed / extractedOnly / conflicted` + `pendingDecisions` + `writingBlockers` |

## 4. ResearchInput 版本链

- 注册以 `sourceId + contentHash` 派生身份：同文件重复上传 → SourceStore 去重 → 同 inputId、`created=false`；内容不同的新文件 → 新条目，旧条目及其事实 / 裁决全部保留。
- 确定性元数据关系：同 arXiv 基础 id（`1901.09993` v1 / v3）或同 DOI 且内容不同 → `same_work` 由系统 `confirmed`（这是来源记录的事实，不是推断）并合并成果分组；标题相似 / 内容对账 / 模型建议 → 只能 `candidate`，确认须 `relation_confirmation` 决定；确认 `same_work` 才合并分组，拒绝不合并。
- 跟随哪个版本 = `version_selection` 决定（必须属于该分组）；"发布时间最新"不自动等价权威。
- `parse` 摘要如实区分 pending / full_text / partial（text_only 降级或 parser 自报不完整）/ failed（原始材料仍登记）/ metadata_only（拒绝登记为研究输入）。

## 5. Fact 生命周期

```
extracted ──(确定性来源核验通过)──▶ source_verified ──(作者决定 fact_confirmation)──▶ author_confirmed
    ▲                                        │                                            │
    └──────────── 核验失败 / 撤销 ◀───────────┘◀──────────── revoked ◀─────────────────────┘
```

- **extracted**：`factExtraction.ts` 把 docling 表格的数值单元格抽成 `table_cell` 事实（标签列 = 对所有行都非数值的前导列；标签来自 parser caption，否则同页相邻题注文本块（`labelBasis=adjacent_text`），否则 `none`；parser 表头是 `0..n` 占位符时以首行为表头并标 `headerRowDerived`；私用区字形标 `glyphIssues`）。模型候选经 `addStatementFacts(method=model_candidate)` 也只以 extracted 入库。
- **source_verified**：`sourceVerification.ts` 用 PyMuPDF 文本层（`PdfTextLayerProvider`，独立于 docling 的字符通道，按 contentHash 缓存）核验：表格事实要求 surface 以独立 token 出现在 parser 报告的同一页（页码未知不盲搜；`0.72` 不能冒充 `0.724`）；语句事实要求 quote 在文档全文逐字（空白不敏感）出现。失败一律 `sourceCheck=failed` 并留言，事实保持 extracted。**语义：只证明抽取与来源一致，不证明实验真实。**
- **author_confirmed**：唯一路径是 `AuthorDecision(fact_confirmation)`；处于未裁决冲突的事实拒绝确认（400）；允许确认未通过文本层核验的事实，但 `sourceCheck=failed` 如实保留可见；`revoked` 回退到核验状态。actor 只能是 `user`（HTTP 真实操作缺省）或 `test_fixture`（测试显式），其它 kind 拒绝。
- 重放幂等：factId 由 inputId + contentHash + 块 + 行列确定；重抽取不新增、不改已确认状态（surface 变化时才回退核验并留言）。

## 6. 冲突识别规则（`tableAlignment.ts`，确定性）

1. **表格对齐**（跨输入两两、同 contentHash 跳过）：`comparable` = 数据列标签归一后一致 ∧ 行数相等 ∧ 已比较单元格 ≥ 4 ∧ 相同比例 ≥ 50% ∧ 无"标签不兼容"的行对；`candidate` = 列标签一致且 ≥ 30% 相同，或共享 ≥ 2 个标识符 token（DAVSOD / SSAV …）且 ≥ 30% 相同——只记录供作者确认，**不进入冲突检测**；其余不产生记录。行配对：行数相等按下标（兼容性 equal / contains / empty / mismatch），否则按归一化行标签唯一匹配。
2. **单元格比较**（只在 comparable 对齐、标签兼容的行对上逐列）：`compareFactValues` → `equal`（无记录）/ `value_mismatch`（blocking）/ `rounding_difference`（按较粗精度四舍五入后相等，advisory；0.049 s vs 0.05 s）/ `equal_after_unit_normalization`（同量纲可靠换算：ms↔s、%↔[0,1] 比率、KB↔MB，advisory）/ `unit_incomparable`（量纲不同或未知单位，advisory，需人工）/ `non_numeric`（含字形问题，不比较）。
3. **不同协议不是冲突**：不同数据集 / 指标 / 划分出现在不同表格或不同列标签 → 不会被对齐；同列标签但单元格 0% 相同（白烨 CER 11.4 vs 7.6 的基线替换）→ 不对齐，不自动判冲突。
4. **幂等与版本**：conflictId 由双方 factId 确定；重放 `created=0 existing=n`；裁决记录 `appliesToContentHashes`，任一方版本变化 → 新事实 → 新冲突 unresolved，旧裁决只绑定旧版本。
5. **裁决**：`adopt_fact`（必须指向双方之一）/ `keep_both` / `request_material` / `defer`（deferred 仍阻断）；被排除版本的原始事实不删不改，只在 `conflict.status` 反映；事实 `conflict.status` 由所有关联冲突的最严重状态决定。

确定性测试矩阵（`conflictDetection.test.ts`）：同实验异值 ✓；同数值异协议不冲突 ✓；单位可规范化比较 ✓；单位不可换算 ✓；作者指定权威版本 ✓；新版本后旧裁决不适用 ✓；Writer / 模型无法清除冲突（无 API；确认被拒；planner 隔离；defer 仍阻断）✓；双方原始事实完整保留 ✓；行标签不兼容不配对 ✓。

## 7. Table Provenance

每条 `table_cell` 事实携带：来源 inputId + contentHash、ParsedDocument `blockId`、页码（`pageBasis=parser`，parser 未报告则 `unknown` 且不盲搜）、表格标签与标签来源（parser_caption / adjacent_text / none）、题注、行列下标、行列标签、`headerRowDerived`、`surfaceHash`、验证状态与核验方法。只有可解析为数值的单元格成为事实；文本 / 范围（`0.654∼0.898`）/ 勾选不进入数值比较（计入 `skippedCells` 透明报告）。

真实材料实测（§10）：范登平学位论文 表5.1 `AP × PASCAL-S MM1 = 0.452`（p87，B0564，行 0 列 1）与 ICCV17 Table 1 同单元格 `0.452`（p7，B0106，行 0 列 1）均到页 / 块 / 行列并经文本层核验；表4.3 `SSAA explicit × S = 0.699`（p63，B0408）；李谨杰 表9 `损失Loss × γ=4 = 1.0523`（p64，B0481，`headerRowDerived=true`）。表9 的 γ 符号在 PDF 中是私用区字形 `U+F067`，含该字形的列头 `(无γ)` 对应单元格 `0.6185` 被标 `glyphIssues` 并拒绝核验（保持 extracted）——不编造。

与 Figure 体系的关系：未扩展 pgfplots / TikZ / Figure 资产；`TableAlignment` 与 `FactProvenance.table` 是面向事实保护的最小接口，继承表格的受控插入属 M14.3。

## 8. Finding → targetQuote（P1，`review/findingProjection.ts`）

- `ReviewIssue` 新增 `quote`（Reviewer 逐字摘出的 ≥12 字片段，单元审查 prompt 显式要求）、`file` / `logicalSection`（`review.run` 单元模式确定性附加，模型不产出）。
- `revision.plan` 读取**被审修订的快照**（`readSnapshotTex(snapshotDir(sourceRevision))`，不是当前工作树），对每条 planned review finding 做 `projectFindingTarget`：候选锚点 = `quote` → 描述 / 建议中的引号片段；范围按已知 file / span 收窄；范围内恰好一次命中 → `targetQuote` 取**文档原文切片**、`logicalSection` 取命中位置的 span id，并记 `targetProjection{status:resolved, basis, file, scope}`；0 次 → `ANCHOR_NOT_FOUND`，多次 → `ANCHOR_AMBIGUOUS`，无锚点 → `NO_ANCHOR`，范围不存在 → `SCOPE_NOT_FOUND`，均不投影（`targetProjection.status=unresolved`）。
- 无词法相似度猜测；M14.1a 的派发（`directiveAnchors` 读 `item.targetQuote`）、重定位、stale 拒绝、Patch Guard 全部不变。
- 测试：`findingProjection.test.ts`（唯一命中返回文档形态；描述片段回退；同名章节共享句歧义 → 给定 file / span 后唯一；文档变化后旧 quote `NOT_FOUND`；无锚点 / 范围不存在 unresolved；多锚点按优先级）；`findingTargetProjection.test.ts`（真实 `review.run` 单元模式 → `revision.plan`：3 条 planned finding 中 1 条 resolved（targetQuote 在快照 ch2 中恰好出现一次，span `section:Chapter 2`）、1 条 ambiguous、1 条 no-anchor）。

## 9. HITL 接口

- 不存在可挂接的 thesis workflow stage（M14.2 范围），本轮建设数据与 API 契约：`POST /api/projects/:id/research-inputs/decisions`（七类 payload；`decisionId` 幂等——同 id 重复返回 `duplicate:true` 不再应用；应用失败不落账；actor 缺省 `user`）。
- `authorDecisionFromResumeInput({decision, payload})` 把 workflow `ResumeInput` 映射到同一应用层（`include/exclude/supersede`、`select_version`、`confirm_relation/reject_relation`、`adopt_fact/keep_both/request_material/defer`、`confirm_facts/revoke_facts`、`allow_unpublished/deny_unpublished`、`pause/write_as_limitation/defer_chapter/attach_experiment_package`），非法载荷抛 `INVALID_REQUEST`——供 M14.2 的 `hitl.scope_and_version / hitl.fact_conflicts` 的 `onInput` 复用。
- 中断恢复：决定账本 append-only，注册表 / 事实文件原子写；`authorDecisions.test.ts` 用新服务实例重开验证状态与账本一致，重放同 decisionId 为 duplicate。

## 10. 真实材料验证过程（Phase F）

材料：`D:\PaperTeamData\M14_0_1_RealThesisPaperStudy`（M14.0.1 合法获取的公开材料）。运行：`PAPERTEAM_M141B_REAL_MATERIAL=1 npx vitest run test/thesis/m141bRealMaterial.smoke.test.ts`；真实 docling 2.130.0（TableFormer）+ PyMuPDF 1.28；持久项目根 `D:\PaperTeamData\M14_1b_ResearchInputFacts\projects`；报告 `…\report\m141b-real-material-report.json`；墙钟 16 min 39 s（11:40:08 → 11:56:47 UTC），docling 串行 maxConcurrency=1。

| 输入 | 类型（验证用） | 页数 | docling 表格 | 事实 | 文本层核验 |
| --- | --- | ---: | ---: | ---: | --- |
| 范登平 CVPR19 SSAV（CVF 版，DOI） | published_paper | 11 | 5 | 275 | 273 ✓ / 2 ✗（docling 畸形单元格 `** .564`、`.064 **`） |
| 范登平 ICCV17 S-measure（arXiv v1） | preprint | 10 | 1 | 48 | 48 ✓ |
| 范登平 南开博士论文（作者主页副本） | unpublished_manuscript | 124 | 15 | 1,063 | 1,063 ✓ |
| 李谨杰 CDC23 NMPC（arXiv v2，答辩时 Submitted） | submitted_manuscript | 7 | 3 | 10 | 10 ✓ |
| 李谨杰 北航硕士论文 | experiment_report | 123 | 24 | 253 | 240 ✓ / 13 ✗（私用区字形拒绝核验） |
| Li Qimai GLP arXiv v1 | preprint | 14 | 5 | 105 | 105 ✓ |
| Li Qimai GLP arXiv v3 | published_paper | 10 | 3 | 62 | 62 ✓ |

- **场景 A**：7 个 PDF 全部 `full_text`；重复导入 CVPR19 → SourceStore `created=false`、同 inputId；GLP v1/v3 同 arXiv 记录 → 系统自动 `same_work`（basis `arxiv_identifier`）并合并分组（6 个成果分组）；其余 5 个输入各自成组。contentHash 与 M14.0.1 manifest 的 sha256 一致（如学位论文 `a885d95a1071…`）。
- **场景 B**：对范登平三份输入检测，产出 4 条对齐：**1 条 comparable**（CVPR19 Table 5 p8 ↔ 学位论文 表4.3 p63：列标签一致、3×3 行、6/9 相同、共享标识符 SSAV / DAVSOD、行兼容 contains / contains / equal）→ **3 条 blocking value_mismatch**：S 0.724↔0.699、max F 0.603↔0.630、M 0.092↔0.098，与 M14.0.1 人工核对 oracle 3/3 一致，双方均 `source_verified`、双来源定位到页 / 表 / 行 / 列；**3 条 candidate**（Table1↔表2.2、Table2↔表2.3、Table4↔表4.2：列标签不一致或行数不等 22 vs 49）正确地**未**进入比较——表2.3 正是 M14.0.1 记录的"新增一列的扩展表"，必须由作者确认对应关系。
- **场景 C**：见 §7（四个单元格溯源全部到位且核验通过；γ 列头字形问题如实降级）。表5.1 ↔ ICCV17 Table 1 布局不同（学位论文把 13 列拆成两段 7 列 × 10 行），不产生对齐 → 不自动断言跨版本一致，但两侧 `0.452` 各自可追溯（PARTIAL 口径：跨版本一致性在此表需作者确认对齐）。
- **场景 D**：`test_fixture` 模拟 4 个决定（CVPR19 included、学位论文 included、未发表材料 allowed、S 冲突 adopt 学位论文值）；重复 decisionId 返回 duplicate 且 scope 未被改写；未裁决冲突的事实确认被拒（`/未裁决冲突/`）；新进程重开后账本与状态一致；actorKinds = `["test_fixture"]`。
- **场景 E**：planner-context：included 2 / proposed 5；facts：authorConfirmed 0、sourceVerifiedUnconfirmed 1,332、extractedOnly 2、conflicted 4；conflicts unresolved 2 / resolved 1；`writingBlockers` 含 2 个 `CONFLICT_UNRESOLVED`；pendingDecisions 列出 5 个 proposed 输入 + 2 个冲突。

## 11. 具体成功与失败案例

成功：
- 范登平 表4.3 的三处冲突由真实解析 + 确定性对齐自动发现，无任何硬编码；两行相同单元格（implicit / w/o SSLSTM）零误报；docling 把学位论文行标签合并为 `explicit implicit` / 空，对齐靠列标签 + 行下标 + 标签兼容性（contains / empty）而非猜测。
- GLP v1/v3 版本链自动建立且不覆盖；重复导入幂等。
- 1,801 / 1,816 真实表格事实经独立文本层核验。

失败 / 如实降级：
- CVPR19 Table 4 两个畸形单元格（docling 把 `**` 脚注记号并入数值）→ 核验失败保持 extracted（不猜）。
- 李谨杰学位论文 13 个单元格含私用区字形（γ、∞ 等）→ 拒绝核验；表9 ↔ CDC23 Fig. 6（1.6288/1.0523 vs 1.589/1.022）的真实冲突**未检测**：论文一侧的数值在图内文字，不是表格，当前只做表格对齐（设计内漏判，见 §15）。
- 学位论文前 3 页（封面 / 目录）被 docling 识别为表格（`labelBasis=none`、`headerRowDerived`），产生少量无业务意义的数值事实（日期 / 页码）；不影响正确性，属噪声（§15）。
- 表5.1 ↔ Table 1 因布局重排不对齐 → 跨版本一致性需作者确认（当前无"确认候选对齐"的决定类型，§15）。

## 12. 自动化测试结果

新增 10 个测试文件 / 58 个确定性用例（`test/thesis/*` 34、`test/review/findingProjection.test.ts` 6、`test/workflow/findingTargetProjection.test.ts` 1 + 复用 17、以及两个 env 门控 smoke），全部通过。既有回归：review / revision / agents / manuscript 定向回归 60 文件 838 用例全绿；后端全量 `npm test`：318 文件 / 3,505 用例通过、23 个 env 门控 smoke 跳过（158.7 s，exit 0）；`npm run typecheck`（前后端）、`npm run build`（后端）、`git diff --check` 通过。前端未改动。

## 13. 新增模型调用与可观察成本

`PAPERTEAM_M141B_MODEL_SMOKE=1 npx vitest run test/thesis/m141bRealModel.smoke.test.ts`：**2 次**调用（预算 ≤4），`glm/claude-fable-5-1`（公司网关，Pi SDK 自管凭据，不经仓库）。

| 调用 | 输入（≤6k 字） | 延迟 | usage | 候选 | 入库 | 引文核验 |
| --- | --- | ---: | --- | ---: | ---: | --- |
| CVPR19 p1–2 文本块 | 英文 | 16.2 s | in 4 / out 908 / cacheWrite 3,892 / cost 0 | 8 | 8（extracted） | 8/8 → source_verified |
| 学位论文 p62–63 文本块 | 中文 | 18.5 s | in 4 / out 866 / cacheWrite 2,984 / cost 0 | 8 | 8（extracted） | 8/8 → source_verified |

16 条候选（研究问题 / 数据集 226 videos, 23,938 frames / 协议 / 方法 SSAV / 数值 S>0.9、S<0.7、0.049 秒 / 结论）全部以 `model_candidate` extracted 入库，quote 逐字命中后晋升 source_verified，**0 条 author_confirmed**。网关渠道按量费用 0（list-price 估算 `estimatedCost=0`）。真实材料 smoke 本身零模型调用。

## 14. 对既有 Workflow 的兼容性

- 新能力全部是加法：新目录 `backend/src/thesis/`、新路由 `research-inputs`、新 `research/*.json(l)` 文件；既有 stage / Gate / Writer prompt 不读取这些文件。
- `ReviewIssue` 三个可选字段；`RevisionPlanItem.targetProjection` 可选字段；`buildRevisionPlan.projectFinding` 缺省不投影 = M14.1a 行为；`review.run` 单元模式只给 finding 附加 file / span（digest 模式零变化）。
- Coverage Ledger 的 unitId 方案、`partitionSpanIntoUnits` 语义、writing-plan 恢复均未触碰。

## 15. 剩余限制

1. 确定性抽取只覆盖表格单元格；正文数值 / 图内文字数值不抽取（李谨杰 表9 vs Fig. 6 漏判）——正文数值事实属 M14.1c。
2. 候选对齐（列重排 / 增删行 / 拆表）没有"作者确认对齐"的决定类型；`TableAlignment.basis=author_decision` 已预留并在 upsert 时受保护，但无写入口（M14.1c）。
3. docling 噪声：封面 / 目录被识别为表格、脚注记号并入单元格；均 fail closed，但会产生无意义事实条目；可在抽取端加"全表 ≥N 数值且有标签"过滤。
4. `research/scientific-facts.json` 单文件（真实项目 3.7 MB / 1,832 条）读-改-写在队列内串行；更大语料需分文件（按 inputId）——文件后端仍可满足，不触发数据库复评。
5. HITL：只有 API + ResumeInput 适配器，无 workflow stage / 前端页面（任务范围内）。
6. `unit_incomparable` / `rounding_difference` 为 advisory，不阻断写作；是否应阻断由 M14.2 的 Gate 规则决定。
7. 来源核验的"独立通道"对 docling 与 PyMuPDF 同样读取 PDF 文本层——扫描件 / 无文本层 PDF 两者都失效（如实 failed）。

## 16. 下一步建议

- **M14.1c**：正文 / 图内数值与数据集 / 指标 / 基线名的确定性抽取（ConsistencyLedger 的最小确定性部分）；候选对齐的作者确认决定；噪声表格过滤；分文件事实存储；`existing_paper_review` 接入同一 Coverage Ledger。
- **M14.2**：`thesis_from_papers` stage 定义（`thesis.import_inputs → thesis.freeze_facts → hitl.scope_and_version → hitl.fact_conflicts → …`）直接消费 `ResearchInputService` 与 `ResearchFactContext`；Gate 规则 `published_facts_zero_drift` 三态（相同 / 已授权变更 / 未授权差异）消费 `author_confirmed` 事实；前端最小入选 / 版本 / 冲突面板。
- 延后：继承表格受控插入与图继承（M14.3）、ConsistencyLedger 完整版、中文高校模板。

## 17. Git 交付状态

提交（`main`，不新建分支）：
- `e6baf75` feat(m14.1b): ResearchInput registry, scientific fact lifecycle, deterministic conflict detection, author decisions
- `f3e28d2` feat(m14.1b): Finding → targetQuote projection + HTTP contract docs
- 收口提交（本报告 + PROJECT_STATUS + smoke 门控测试）见 PROJECT_STATUS 条目所记 SHA。

不提交：原始 PDF、`D:\PaperTeamData\M14_1b_ResearchInputFacts\{projects,report,docling}` 下的全文解析 / 事实 / 文本层缓存 / 运行日志。远端 CI 不作为本轮本地验收门槛。
