# M12 Batch 1 — Deterministic Foundations 实施报告

> **日期：2026-10-07。执行：Claude Code（三路并行 subagent + 主线统一复核）。基线：`7cd9433`（M12.0 冻结），全程 main 未建分支。**
>
> **一句话结论：M12.0 §18.4 预判的并行首轮（A1–A6 + B1–B2 + C1–C3，全确定性、零相互依赖）一轮完成——backend 全量 2,704 tests 全绿（+167），三个真实 smoke 全过（真实 OpenAlex 全链冻结 / fixture 手稿视觉投影 / 真实 xelatex+pgfplots/TikZ 编译出 vector PDF）。Benchmark/Evidence 四道隔离全部落地并有 targeted 回归。M12.1/12.2/12.3 各自进入 PARTIAL（deterministic foundation 层 COMPLETE）。**

---

## 1. Implemented Scope

| Track | 任务 | 状态 | 要点 |
|---|---|---|---|
| A1 | SearchOptions venue 过滤 | ✅ | `venueSourceIds?`/`venueNames?` additive；OpenAlex 映射 `filter=...,primary_location.source.id:S1\|S2`（identity 恒 source id，非法 `S\d+` 形态 fail-fast）；其余 provider 共享 `search/venueFilter.ts` 客户端后滤（归一化全等或短侧 ≥6 包含）；arXiv 无 venue → 空（graceful）；无 venue filter 时行为不变（既有测试回归证明） |
| A2 | venueResolution | ✅ | `search/venueResolution.ts` + `backend/resources/venue-seeds.json`（21 venue；16 个经 api.openalex.org 实测核验的 source id，ICCV/KDD 双归属歧义按"宁缺勿错"省略 id）；判别联合 `resolved/ambiguous/not_found`（不 silent fallback）；miss 时 `/sources?search=` 一次 + 防错配相似判据 + per 实例缓存；JSON 经 import.meta.url 双栖定位（vitest 与 dist 均实测） |
| A3 | citationCount 持久化 | ✅ | `SourceMetadata`/`CandidateSource`/`AddCandidateInput` 增 `citationCount?`；search→fusion→saveAsCandidates→promote→SourceStore 全链透传（snapshot 路径同步）；注释红线 + 写入口审计（无按值伪造入口，LLM 不生成）；metadataMerge 层级保证 inferred 不覆盖 resolved（测试钉死） |
| A4 | benchmarkDiscovery | ✅ | `search/benchmarkDiscoveryService.ts`：venue resolved → 双发（venueSourceIds 服务端 + venueNames 客户端）；ambiguous/not_found → `venueDegraded` 降级纯关键词+引用数排序（如实标记）；确定性检索词拼装（survey 类 +" survey"）；citationCount 降序 + identity 去重；入库恒 `sourceRole="reference"`（同身份既有 evidence 源升级 both，不降级用户证据角色） |
| A5 | 语料冻结 | ✅ | `target/types.ts`（M12.0 §4.3 schema v1 + additive `selection?`/`confirmedAt?`）+ `TargetBenchmarkService`（照抄 CorpusSnapshot revision 模式）：freeze 幂等 / refresh revision+1 / exclude 同 revision 标记（指纹纳入 excluded）/ get 容错区分未冻结与损坏（`TARGET_BENCHMARK_CORRUPTED` fail-closed） |
| A6 | benchmark selection | ✅ | `target/selection.ts` 纯函数：8–15 带内默认目标 12、citationCount 降序、inclusionReason、sufficiency 恒标记（<8=insufficient 带 reason 不静默）、requiresAttention 仅四触发（<5 / ambiguous / not_found / 空检索）；`discoverAndFreeze` 一键（discover→auto-select→role=reference→freeze→返回）；optional HITL 服务端能力齐备（exclude/addPaper/confirm 幂等）；**正常流程零暂停**（产品层修正覆盖 M12.0 强制 HITL 描述） |
| B1 | visual inventory | ✅ | `manuscript/visualInventory.ts`：figure/figure\*/table/table\* 四环境保守正则 + 有限花括号平衡；caption 三态（absent/unparseable/text）fail-soft；cleveref `\Cref{a,b}` 按逗号拆多 key（防假 unresolved）；linkedSection=同文件最近前置标题；`references` per-(label,file,line) 位置清单；CRLF 归一；byte 级一致（测试锁定）；持久化 `research/manuscript-visuals.json`（`VISUAL_INVENTORY_CORRUPTED` fail-closed）；未接 revision 循环（B3 职责） |
| B2 | VisualArtifactView | ✅ | `review/visualArtifactView.ts` 纯投影（无 IO、无新持久 store）：三入口 `fromParsedBlocks`/`fromVisualInventory`/`fromGeneratedFigure`（结构接口 `GeneratedFigureLike`，不依赖 figures/ 模块）；id 确定性（`pdf:<sourceId>:<blockId>` / `tex:<file>:figure-<n>` / `gen:<figId>`）；view 字段全拷贝（变异测试证明）；freshness 四键校验=调用方职责（投影只透传） |
| C1 | PlotSpec/DiagramSpec | ✅ | `figures/spec.ts`（typebox 单一事实源 + Static 推导；校验返回 `{ok,errors[]}` 不抛异常）：plotType line/bar/grouped_bar/scatter + `semantic?`（benchmark_comparison/ablation 纯 metadata）；lineage 一等公民（`origin: {sourceId,blockId}|{manual,note}` + `datasetHash` 强制 = fingerprintJson({columns,rows}) + inlineDataset 校验一致性——数据改了 hash 没更新 → 硬拒）；missingPolicy reject/skip_row（不静默填 0）；DiagramSpec node/edge/group 模型 + DAG 强制（Kahn 判环显式拒绝）+ pipeline/comparison 两 variant |
| C2 | pgfplots/TikZ codegen | ✅ | `figures/pgfplotsCodeGen.ts` + `figures/tikzCodeGen.ts` + `figures/latexEscape.ts`（转义单一出口：全套 `% $ & # _ { } ~ ^ \`，单遍字符类无二次转义，`\`→`\textbackslash{}`；schema 层拒控制字符 + codegen 层防御性归一）；数值格式化固定（toFixed(10) 去尾零、≥1e21 BigInt 展开堵指数形态漂移）；line/scatter 坐标 x 稳定升序；TikZ 布局全 TS 侧计算（最长路径分层 + mm 坐标），golden=显式字符串（防快照漂移） |
| C3 | FigureCompiler + figureStore | ✅ | `figures/FigureCompiler.ts`（specHash 缓存命中零 runner 调用、mkdtemp 隔离、xelatex 单遍、%PDF 魔数校验、finally 清理）+ `figures/figureStore.ts`（`manuscript/figs/generated/`：manifest.json + `<figId>.spec.json/.tex/.pdf`；figId=`fig-<specHash 前 12hex>` 确定性派生、前缀碰撞退化全 hash；CommandRunner seam 独立复制（有意不改 LatexCompiler））；错误模型=结果对象五类 `invalid_spec/tool_unavailable/package_missing/compile_failed/timeout`（MiKTeX+TeX Live 双形态宏包缺失解析 + env→宏包映射）+ `figureFailureToBusinessError` 映射四个新错误类 |

## 2. Benchmark / Evidence 隔离（四道，全部落地）

现状核实：`isCorpusEligible` 排除 reference **已存在**（CorpusSnapshotService，补回归）；其余三道为本轮增补：

1. **候选链 fail-closed**：`EvidenceGroundingService.propose` 是 propose_evidence 工具 / JSON 锚定 / targeted grounding 的唯一候选入口——reference 源抛 `EVIDENCE_VALIDATION`；
2. **核验链纵深**：`ground()` Stage 1 拦截历史入队候选 → `unverifiable(reference_source_not_evidence)`（可 retry：角色恢复后重走三段核验）；`selectReviewerSourceIds` 入口即剔除 reference；
3. **vision confirm 禁令**：`VisionAnalysisService.confirmFactEvidence` 服务端校验 role（M12.0 §5 第 3 道）——reference 源视觉分析本身合法（规范参照），仅 confirm→Evidence 被禁；
4. **回归**：`test/target/benchmarkEvidenceIsolation.test.ts` 覆盖全部四道 + EvidenceStore 零记录断言。

语义：benchmark paper = SourceStore 里 role=reference 的普通 SourceItem（享受同一去重/全文/解析设施）+ 被冻结 manifest 引用；它永远不会成为 EvidenceRecord 的 source。

## 3. VisualArtifact 投影（B2 最终 schema）

```
VisualArtifactView = {
  id: string                    // 确定性三段式（见上）
  kind: "figure" | "table"
  sourceKind: "pdf_parsed" | "latex_env" | "generated"
  figureType?: string           // 可判断才填：pdf←vision FigureAnalysis；gen←plot→chart/diagram→diagram；latex 缺省
  caption? / label? / assetRef? / page? / bbox? / linkedSection?
  tableGrid?: { headers; rows } // table 专有（pdf/latex 两源同形）
  referencedBy: { file; line }[]// latex/generated；pdf 缺省空数组
  analysis?: FigureAnalysis     // 仅 pdf_parsed；freshness=调用方职责
  provenanceNote: string        // 权威源人读溯源
  extraction?: { note? }        // 如 caption 缺失 / LaTeX 表头约定
}
```

与 M12.0 §8.1 的 additive 差异：`figureType?`、`linkedSection?`、`extraction?`（任务书 §8 明确要求）。B1 inventory 与 §8.2 的差异：`environment` 字面量、`lineEnd`、`headers`/`rows`（B3 表-文数字一致性检查必需）、`references` 位置清单、`notes`、`generatedFiguresUsed` 保留。

## 4. PlotSpec / DiagramSpec 最终 schema（要点）

**PlotSpec**：`plotType(line|bar|grouped_bar|scatter)` + `semantic?(benchmark_comparison|ablation)` + `title?/caption?` + `data{origin, datasetHash, x[1], series[{name,column}]≤12, missingPolicy?, inlineDataset}` + `axis{xLabel?,yLabel?,legend?,renderOptions{widthCm 4–40, heightCm 3–40, markSizePt 0.1–10}}`。校验拒绝：列缺失/重复、series 列非有限数值、line/scatter 字符串 x（类目轴须 bar 类）、行宽不齐、datasetHash 不一致。

**DiagramSpec**：`layout(vertical|horizontal)` + `variant?(pipeline|comparison)` + `nodes[{id slug, label 多行白名单, group?, role?}]` + `edges[{from,to,label?}]` + `groups[{id,label?}]` + `title?`。校验拒绝：id 非法/重复、端点缺失/自环/重边、未声明 group、DAG 成环、comparison 无 left/right。

**规范化**：默认值物化 + 未知键丢弃——"视觉等价" spec 规范化后深度相等 → 同 specHash → 同 figId → 缓存命中。

## 5. Figure pipeline（C3 编译/缓存/谱系）

```
spec → 校验 → specHash(fingerprintJson 规范化 spec) → figId(fig-<12hex>)
  → 缓存命中（同 specHash + PDF 在盘）→ cached:true 零编译
  → codegen → mkdtemp 隔离目录 → xelatex 单遍 → %PDF 魔数校验
  → figureStore 落盘（spec.json/tex/pdf + manifest 原子写）→ finally 清理
```

`GeneratedFigureRecord`（M12.0 §13 冻结 + `compiler?{durationMs,diagnostics}`）：figId/kind/specHash/datasetHash?/dataOrigin/assets{tex,pdf}/caption/insertedIn?（C5 预留恒空）/createdAt。specHash canonical 范围=完整规范化 spec（含 datasetHash 与 inlineDataset）——**数据变化必然改变 specHash 是结构保证**，不存在"spec 同数据变"的缓存误命中。

## 6. Tests

| 套件 | 数字 |
|---|---|
| 新增测试（Track A 52 + B 28 + C 80 + 主线 smoke 7） | **167** |
| 定向套件（target/figures/search/manuscript/review 相关） | 299 passed / 5 skipped |
| backend 全量 | **242 files / 2,704 passed / 0 failed / 16 skipped**（M11.5 基线 2,553 → +167，零既有测试丢失） |
| backend typecheck / build | 0 错误 / 成功 |
| frontend typecheck / build | 成功（本轮零前端改动，chunk 警告为既有） |
| `git diff --check` | PASS |

已知 flake：全量首跑曾现 1 failed（vitest 并行 IPC，M11.4 已知形态，maxWorkers=4 下复跑全绿未复现）。

## 7. Real Smoke 结果

| Smoke | 内容 | 结果 |
|---|---|---|
| **A**（`test/target/benchmarkLive.smoke.test.ts`，`PAPERTEAM_LIVE_SMOKE=1`） | 真实 OpenAlex：CVPR 种子解析（S4210176548）→ 未种子 venue 真实 `/sources` lookup → venue 服务端过滤 discovery（2019–2025 MOT，候选>4、带引用数）→ 引用数排序 → 8 篇 role=reference 入库 → `target-benchmark.json` 冻结（revision=0/fingerprint/sufficiency）→ 全部入库源 `isCorpusEligible=false` → 重复调用幂等（fingerprint 不变） | ✅ 2.98s |
| **B**（`test/manuscript/visualInventory.e2e.test.ts`，确定性） | 提交内 fixture（`test/fixtures/manuscript/visual-sample/` 两文件手稿：3 figure + 4 table + caption 前/后置 + figure\*/table\* + 缺 caption/label + 重复/跨文件/unresolved ref）→ collectLatexFiles → inventory → persist → load → 投影 7 个 view，id 确定性 deep-equal | ✅ |
| **C**（`test/figures/figureReal.smoke.test.ts`，本机有 TeX 时执行） | 真实 xelatex + pgfplots：line 双 series 收敛曲线 → `%PDF` vector（2.0s）；grouped_bar 类目轴消融 → `%PDF`（2.1s）；TikZ pipeline DAG+annotation+group → `%PDF`（1.8s）；同 spec 二次生成 cached:true 零编译；manifest lineage（datasetHash/dataOrigin）；负例：line 字符串 x / DAG 回边均被校验层拒绝 | ✅ 5/5 |

本机工具链：MiKTeX 25.12，`kpsewhich` 确认 pgfplots.sty / tikz.sty 在位。

## 8. Regressions Found & Fixed（主线复核阶段）

1. **NUL 控制字节**：`visualInventory.ts` 的模板字符串复合键写入时含 2 个原始 NUL 字节（工具层转义坑，语义同 revisionBaseline 的 `"\x00"` 分隔符但源文件应为转义序列文本）——已替换为 `\x00` 转义序列，文件恢复纯文本形态，28/28 测试复跑绿。
2. **任务书示例纠错**（Track A 发现）：任务书给的 OpenAlex id 示例 `S4306402567` 实为 bioRxiv；CVPR 真实 id = `S4210176548`（已实测核验入种子表）。主线另行抽查 5 个种子 id（ICML/ICLR/IJCV/ECCV/TMLR）全部与线上 API 一致。
3. **既有 fixture 语义冲突**：`revisionSourceSelection.test.ts` 曾用 `sourceRole:"reference"` 构造自有实验报告 fixture——与新 role 过滤冲突，已改为 evidence 角色并补 reference 排除断言（预期行为变更，非回归）。

## 9. Remaining（后续批次）

| 项 | 内容 | 依赖 |
|---|---|---|
| A7 | TargetProfileService：确定性提取（sections/引用计数/块统计分位带）+ bounded LLM 摘要（method/writing 两维，provenance 标注）→ `target-profile.json` | A5 |
| A8 | TargetGapService：manuscript digest × profile → 四档判决 → `target-readiness.json` | A7 |
| A9 | 消费接线：Feasibility/Reviewer/Planner prompt 参照块、gates advisory 字段、workflow target.* 三 stage | A7–A8 |
| A10 | TargetPanel + HTTP 路由组 | A5–A8 |
| B3 | VisualReviewService（确定性检查全量 + vision 按 capability 降级）+ ReviewFinding `"visual"` 类目与 figure 锚 | B1–B2 |
| B4 | 图资产 HTTP 路由 `GET /sources/:sid/figures/:name`（补 G8） | — |
| B5 | ReviewAggregator visual 维度 + ReviewPanel 渲染 + capability_gap 提示 | B3 |
| C4 | HTTP + UI：`POST /:id/figures/generate`、`GET /:id/figures`、FiguresPanel | C3 |
| C5 | 手稿插入：确定性 env emitter + 模板 graphicx + Writer 禁令改资产白名单语义 + 修订计划 insert_figure 条目（**触碰修订安全边界，单独串行实现**） | C3 |
| C6 | 守卫 + doctor：caption 数值↔dataset 一致性检查、pgfplots 预检 | C5 |

**本轮未触碰**：httpServer.ts、workflow/definitions.ts、Writer TikZ 禁令（三处原样）、ManuscriptService 模板、frontend。C5 未开始，本轮 figure 均为独立 artifact。

## 10. 文件清单

**新建 src（12 + 1 资源）**：`search/venueFilter.ts`、`search/venueResolution.ts`、`search/benchmarkDiscoveryService.ts`、`target/types.ts`、`target/TargetBenchmarkService.ts`、`target/selection.ts`、`manuscript/visualInventory.ts`、`review/visualArtifactView.ts`、`figures/{spec,latexEscape,pgfplotsCodeGen,tikzCodeGen,FigureCompiler,figureStore}.ts`、`resources/venue-seeds.json`

**新建 test（11 + 1 fixture）**：`test/search/venueResolution.test.ts`、`test/sources/citationCount.test.ts`、`test/target/{targetBenchmark,benchmarkDiscovery,benchmarkEvidenceIsolation,benchmarkLive.smoke}.test.ts`、`test/manuscript/{visualInventory.test.ts,visualInventory.e2e.test.ts}`、`test/review/visualArtifactView.test.ts`、`test/figures/{spec,pgfplotsCodeGen,tikzCodeGen,FigureCompiler,figureReal.smoke}.test.ts`、`test/fixtures/manuscript/visual-sample/{main.tex,sections/method.tex}`

**修改（14）**：`errors.ts`（union 末尾追加 6 code）、`search/types.ts`、`{openalex,semanticScholar,arxiv,aminer}Provider.ts`、`researchDiscoveryService.ts`、`sources/{SourceStore,CandidateStore,SourceImportService}.ts`、`evidence/{EvidenceGroundingService,revisionSourceSelection}.ts`、`vision/VisionAnalysisService.ts`、`test/search/academicProviders.test.ts`、`test/evidence/revisionSourceSelection.test.ts`

---

**M12 Batch 1 — COMPLETE（A1–A6 / B1–B2 / C1–C3）。M12.1 PARTIAL、M12.2 PARTIAL、M12.3 PARTIAL。READY_FOR_BATCH_2 = true。**
