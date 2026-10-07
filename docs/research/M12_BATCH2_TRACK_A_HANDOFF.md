# M12 Batch 2 — Track A（Target Publication Intelligence · A7–A10）交接说明

> **日期：2026-10-07。执行代理：Agent A（Track A）。接收方：主代理（负责 serviceStack / httpServer / index / ProjectPage 接线与全量集成）。**
>
> 本文包含：交付概览 / `buildTargetServices` 工厂签名与 serviceStack 接线规范 / HTTP 路由契约（主代理按此实现 httpServer 路由）/ 偏差与注意事项 / 测试与验证记录。

---

## 1. 交付概览（A7–A10 全部完成）

| 任务 | 状态 | 产物 |
|---|---|---|
| A7 TargetProfileService | ✅ | `backend/src/target/TargetProfileService.ts`（+ `quantiles.ts` / `paperStats.ts` / `aggregate.ts`；artifact `research/target-profile.json`） |
| A8 TargetGapService | ✅ | `backend/src/target/TargetGapService.ts`（+ `manuscriptStats.ts`；artifact `research/target-readiness.json`） |
| A9 消费接线 | ✅ | Feasibility / Reviewer（academic）/ Planner（planImprovement）prompt 参照块；gates `targetReadiness?` advisory；workflow `target.benchmark → target.profile → target.readiness` 三 stage（`definitions.ts`；topic_survey 未动） |
| A10 前端 | ✅ | `frontend/src/api/target.ts` + `frontend/src/components/project/TargetPanel.tsx`（自包含，props `{ projectId }`） |

核心纪律全部落地：确定性提取为主（分位带 golden 锁定）；bounded LLM 摘要仅 method/writing 两维（输入只有聚合统计，**零 benchmark 论文原文**；1 次 repair；失败 → UNAVAILABLE 不伪造）；readiness 四档判决无数值分数门；gap 恒为距离语义（每条 gap 携带「不构成稿件事实错误」限定语）；provenance 声明 benchmark 观测非官方投稿要求；无手稿 / 语料不足 → INSUFFICIENT_EVIDENCE 如实呈现。

---

## 2. 工厂签名与 serviceStack 接线规范（主代理执行）

```ts
// backend/src/target/services.ts
export interface TargetServiceDeps {
  projects: ProjectStore;
  academic: AcademicSearchService;        // search stack 既有实例
  venues: VenueResolutionService;          // A2 既有（serviceStack 若未持有则一并新建）
  candidates: CandidateStore;
  imports: SourceImportService;
  sources: SourceStore;
  parsedDocuments: ParsedDocumentStore;    // M10.1 既有
  revisions?: Pick<ManuscriptRevisionStore, "currentRevision">;  // 可选（readiness 修订号对齐）
  summaryModel?: TargetSummaryModel;       // 可选；缺省 → method/writing 两维 UNAVAILABLE
  now?: () => Date;
  log?: (message: string) => void;
}
export interface TargetServices {
  benchmark: TargetBenchmarkService;
  discovery: BenchmarkDiscoveryService;
  profile: TargetProfileService;
  gap: TargetGapService;
}
export function buildTargetServices(deps: TargetServiceDeps): TargetServices;
```

**serviceStack.ts 接线（buildServiceStack 内，全部依赖在作用域内已存在或可低成本构造）**：

```ts
import { buildTargetServices } from "./target/services.js";
// —— summaryModel 的推荐装配（文本模型即可，不需要 vision）——
// TargetSummaryModel = { caller: TargetModelCaller; catalogEntry: unknown; spec: string }
// caller 直接传 ModelRuntime 实例（completeSimple 形状满足，见 vision/types.ts 同款 seam）；
// catalogEntry/spec 取默认模型的目录条目（resolveVisionModel 的文本版：从模型设置取
// defaultModel，目录 getModel(provider, modelId) 命中即可）。不装配也安全（两维如实 UNAVAILABLE）。

const venueResolution = new VenueResolutionService({ /* A2 既有构造参数 */ });
const targets = buildTargetServices({
  projects, academic, venues: venueResolution, candidates, imports: sourceImport,
  sources, parsedDocuments, revisions,          // revisions = ManuscriptRevisionStore 实例
  ...(summaryModel !== undefined ? { summaryModel } : {}),
  log,
});
// serviceStack 返回值 / stack.workflowServices 增：targets
```

要点：
- `WorkflowServices.targets` 是**可选**字段（`definitions.ts:240` 区域）——不接线时 target.* stage 显式 no-op，全部既有测试栈零改动即兼容；
- `VenueResolutionService` 在 Batch 1 已存在（`search/venueResolution.ts`）；serviceStack 此前未持有它（Batch 1 smoke 在测试里自建）——本轮接线需要新建实例；
- `index.ts` 无需改动（definitions 工厂自动拿到 workflowServices.targets）。

---

## 3. HTTP 路由契约（主代理在 httpServer.ts 实现；TargetPanel 已按此契约编写客户端）

路径风格沿用既有 `resource = "target"`、`rest` 子路径分发（同 `/api/projects/:id/feasibility` 模式）。

### 3.1 GET `/api/projects/:id/target/benchmark`

- 200 `{ benchmark: TargetBenchmarkArtifact | null }`（未冻结 → null；**不**报错）
- 500 `{ error: { code: "TARGET_BENCHMARK_CORRUPTED", ... } }`（artifact 损坏，既有错误码）

### 3.2 POST `/api/projects/:id/target/benchmark/discover`

- body（可选）：`{ targetCount?: number }`（带内 8–15，缺省 12）
- 语义：`discovery.discoverAndFreeze(projectId, { target: <由 ProjectMetadata 组装>, targetCount })`；target 组装口径同 workflow `targetBenchmarkStage`（documentType ?? ""、targetProfile ?? ""、targetVenue（非空才带）、researchField）
- researchField 为空 → 422 `{ error: { code: "INVALID_REQUEST", message: "benchmark discovery 需要 researchField…" } }`
- 200 `{ revision, papers, savedSourceIds, venueDegraded, sufficiency, requiresAttention, alreadyFrozen }`

### 3.3 POST `/api/projects/:id/target/benchmark/refresh`

- body（可选）：`{ targetCount?: number }`
- 语义：重新 discoverAndFreeze 的结果若与冻结集合不同 → `benchmark.refresh(...)` revision+1；未冻结 → 422 INVALID_REQUEST（沿用服务语义）。响应 200 `{ benchmark }`。

### 3.4 POST `/api/projects/:id/target/benchmark/papers`

- body：`{ sourceId: string; citationCount?: number; venueRaw?: string; inclusionReason?: string }`
- 语义：`benchmark.addPaper`（源必须已以 role=reference 入库，否则 404 NOT_FOUND / 422 INVALID_REQUEST——evidence 源拒绝）
- 200 `{ benchmark }`

### 3.5 POST `/api/projects/:id/target/benchmark/papers/:sid/exclude`

- body：`{ reason: string }`（非空，≤500 字）
- 语义：`benchmark.exclude`（同 revision 剔除标记，指纹变化）；条目不存在 → 404；reason 空 → 422
- 200 `{ benchmark }`

### 3.6 POST `/api/projects/:id/target/benchmark/confirm`

- 语义：`benchmark.confirm`（幂等，首次写 confirmedAt）。200 `{ benchmark }`。

### 3.7 GET `/api/projects/:id/target/profile`

- 200 `{ profile: TargetPublicationProfile | null, fresh: boolean | null, staleReason?: "benchmark_revision_changed" | "corpus_fingerprint_changed" | "extractor_schema_version_changed" }`
  - 未生成 → `{ profile: null, fresh: null }`
  - benchmark artifact 不存在而 profile 存在 → `fresh: false, staleReason: "corpus_fingerprint_changed"`
- 500 INTERNAL_ERROR（profile 损坏；消息以「target-profile.json 损坏」开头）——**建议主代理在 errors.ts 增补专用 code `TARGET_PROFILE_CORRUPTED` / `TARGET_READINESS_CORRUPTED`（HTTP 500，union 末尾追加），本轮因 errors.ts 归主代理所有暂用 INTERNAL_ERROR**

### 3.8 POST `/api/projects/:id/target/profile/regenerate`

- 语义：`profile.ensureCurrent`（缺失/陈旧才重建；陈旧包含确定性提取 + ≤2 次摘要模型调用）
- 未冻结 benchmark → 404 NOT_FOUND；损坏 benchmark → 500 TARGET_BENCHMARK_CORRUPTED
- 200 `{ profile }`

### 3.9 GET `/api/projects/:id/target/readiness`

- 200 `{ readiness: TargetReadinessArtifact | null }`（未评估 → null）
- 500 INTERNAL_ERROR（损坏，同上建议）

### 3.10 POST `/api/projects/:id/target/readiness/evaluate`

- 语义：`gap.evaluate(projectId)`（manuscriptRevision 由 `revisions.currentRevision` 填充，工厂已接）
- 未冻结 benchmark → 404 NOT_FOUND
- 200 `{ readiness }`

> 前端客户端 `frontend/src/api/target.ts` 已按上述契约实现；主代理实现路由时以该文件为消费方对照（响应信封字段名必须一致）。

---

## 4. 实现要点 / 偏差记录（相对任务书与 M12.0 冻结稿）

1. **每维度 availability/coverage 包装（相对 §4.3 冻结 schema 的 additive 扩展）**：`DimensionCoverage { availability: available|unavailable|insufficient; coverage; reason? }` 附着在六维上——「语料论文无全文/无解析产物时统计不得发明」的直接实现。`Distribution` 形态与冻结稿一致（`{n,min,p25,median,p75,max}`，线性插值分位，round2）。Batch 1 已有 additive 先例（selection?/confirmedAt?）。
2. **visuals.figureTypeMix 未实现**：需要逐图 vision 分析；v1 以 `note` 诚实说明不伪造（frozen 稿也只说「枚举复用 FigureType」，未要求 v1 必须产出）。tableStyle 同理省略（PDF 语料无 booktabs 信息）。
3. **文献维度口径**：citationCount = 参考文献节**条目数**（`[n]` 标记优先、无标记按年份计数兜底并 note 披露）；稿件侧观测是 distinct `\cite` key 数——两侧口径差异在 readiness 的 evidenceBasis 里如实声明。medianReferenceAgeYears = 论文年（SourceMetadata.year）− 参考文献年中位数；任一缺失 → 该论文零贡献。
4. **datasetBreadth / methodDiagramPresent / ablationPresent / limitationsPresent 是确定性启发式**：`<名称> dataset/benchmark/corpus` 短语 distinct 计数（两侧同款正则）；方法图 = figure caption/所在节启发式；ablation/robustness/limitations = 字符串存在性。口径全部写入 profile.notes 与 gap 文案。
5. **method/writing 维的判决上限是 PARTIALLY_MEETS_TARGET**（确定性纪律）：确定性可比指标只有章节存在性（method 章缺失且带内多数（≥50%）设方法章 → BELOW）；深度/措辞是 model_summary 参照，不得由代码判 MEETS（过度声称）。writing 同理（limitations 存在性 + 摘要词数入 structure）。
6. **target stage 的 no-op 判定**：`services.targets` 未接线 / benchmark 已冻结（幂等返回，不重发现）/ 项目无 researchField（discovery 的确定性检索词来源）→ `{ skipped: true, reason }` 显式记录。requiresAttention 四触发只是 stage result 透传（advisory），无任何新 HITL 暂停。
7. **prompt 块缺席 = byte-identical**：三个 seam（Feasibility targetReference / Reviewer targetExpectations（仅 academic 模式消费）/ Planner targetReadinessDigest）全部为可选参数 + 尾部追加；测试断言缺席时 prompt 与旧版逐字节一致（逐行移除注入行后全等）。
8. **既有测试的两处期望更新**（预期行为变更，非回归）：`test/workflow/evidenceGroundStage.test.ts` 与 `test/workflow/httpWorkflowApi.test.ts` 的 `completedStages` 数组现以前缀包含三个 no-op target stage。其余全部既有套件零改动通过。
9. **gates advisory**：`QualityGateInput.targetReadiness?` / `QualityGateResult.targetReadiness?` 纯透传（`readinessGateAdvisory` 投影），零规则参与、零阻断（测试断言 rules 深度相等）。
10. **qualityGateStage / reviewRunStageInner / improvementPlanStage / feasibilityStage 的注入都是只读消费**：profile 只在 fresh 时注入（陈旧不注入而非就地重建——重建只发生在 target.profile stage / regenerate，防 LLM 调用意外进入审稿路径）。

---

## 5. 测试与验证（Agent A 范围内）

| 套件 | 结果 |
|---|---|
| `test/target/`（targetProfile 12 + targetReadiness 11 + targetIntegration 13 + Batch 1 既有 28） | **64 passed / 1 skipped**（skip = live smoke 门） |
| 受影响既有套件（quality 242 + agents/reviewer/writer 530 + workflow 全目录 164） | 全绿（workflow 目录首跑曾现 2 例并行 flake，复跑两次均 164/164——M11.4 已知形态） |
| backend typecheck | 0 错误（仅剩 Agent B 并行开发中的 `vision/VisualReviewService.ts` 报错，非本轨文件） |
| frontend typecheck + build | 通过（chunk >500kB 警告为既有） |

新测试覆盖清单：golden 分位带手算锁定 / 同语料确定性复现 / 部分覆盖零贡献 / n<5 insufficient / 损坏 fail-closed（profile+readiness）/ freshness 三键失效 + ensureCurrent / 摘要成功·repair·失败·未配置·零论文原文 / 四档判决（含 bandPosition 自洽）/ gap-vs-defect 分离 / 无手稿不 crash / no-target no-op / 幂等不重发现 / requiresAttention 透传 / plan 顺序与 legacy 恢复 / prompt 存在·缺席 byte-identical / gates advisory 零规则。

---

## 6. 主代理待办清单（按优先级）

1. serviceStack.ts：`buildTargetServices` 接线（§2）+ workflowServices.targets；
2. httpServer.ts：target 路由组（§3，以 `frontend/src/api/target.ts` 为对照）；
3. ProjectPage.tsx：TargetPanel 挂 tab（props `{ projectId }`）；
4. （建议）errors.ts 增补 `TARGET_PROFILE_CORRUPTED` / `TARGET_READINESS_CORRUPTED`（500）并替换两处 INTERNAL_ERROR 构造（`TargetProfileService.profileCorrupted` / `TargetGapService.readinessCorrupted`）+ 对应测试断言 code 更新（各 1 处）；
5. （建议）summaryModel 装配后跑一次真实 live smoke（discovery→profile→readiness 全链 + Feasibility prompt 参照块出现）。
