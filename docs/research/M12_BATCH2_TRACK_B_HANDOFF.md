# M12 Batch 2 · Track B（多模态 Review B3–B5）主线路线图与契约

> **日期：2026-10-07。执行：Agent B。状态：B3/B4/B5 实现完成（backend 定向测试 + frontend typecheck/build/test 全绿）。
> 本文件是主线（serviceStack / httpServer / ProjectPage / workflow definitions）接线的唯一契约来源。**

## 0. 交付物一览

| 任务 | 文件 | 说明 |
|---|---|---|
| B3 检查核心 | `backend/src/vision/visualChecks.ts` | 纯函数确定性检查（六项）；数值一致性规则在文件头精确文档化 |
| B3 服务 | `backend/src/vision/VisualReviewService.ts` | `buildVisualReviewService(deps)` 工厂；确定性恒运行 + vision 按 capability 降级；落盘 `reviews/visual-review-r<n>.json` |
| B3 finding 扩展 | `backend/src/review/finding.ts` | `"visual"` 类目 + `figureEnvRef`/`assetRef`/`visualConfidence`/`verificationStatus`（全部 additive optional，旧 JSON 兼容） |
| B3 聚合 | `backend/src/review/ReviewAggregator.ts` | `summarizeVisualFindings()` + `ReviewSummary.visual?`（单列，零稀释既有口径） |
| B4 资产解析 | `backend/src/vision/figureAssets.ts` | 纯逻辑 + 受控读取：扁平名白名单 / 双重包含校验 / MIME 白名单 / 登记校验 |
| B5 前端 API | `frontend/src/api/visuals.ts` | 本契约的消费者（类型自持，未动 types/api.ts） |
| B5 前端 UI | `frontend/src/components/project/ReviewPanel.tsx` | `VisualReviewSection`（追加；既有 9 项 ReviewPanel 测试与 281 项前端全量不回归） |
| 测试 | `backend/test/vision/{visualReviewChecks,VisualReviewService,figureAssets}.test.ts`、`backend/test/review/{visualFinding,visualAggregation}.test.ts` | 47 项新增 |
| fixture | `backend/test/fixtures/manuscript/visual-review-sample/main.tex` | 数值冲突 / 题注不符 / 未解析引用 / 假阳性守卫（本批 Smoke B 断言面已锁定：恰 5 findings） |

## 1. 工厂签名与 serviceStack 接线（主线照抄）

```ts
import { buildVisualReviewService } from "./vision/VisualReviewService.js";
import { FigureStore } from "./figures/figureStore.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

// serviceStack.ts 内（VisionAnalysisService 装配点之后）：
const visualReview = buildVisualReviewService({
  projects: options.projects,
  // vision seam：与 stack.vision 同源（options.vision 由构造注入）
  ...(options.vision?.modelRuntime !== undefined ? { modelRuntime: options.vision.modelRuntime } : {}),
  ...(options.vision?.modelCandidates !== undefined ? { modelCandidates: options.vision.modelCandidates } : {}),
  // pdf_parsed 权威源（可选；缺省 = 视觉评审只看 latex + 生成图）：
  parsedSources: {
    // 建议角色过滤：视觉评审审的是手稿相关源，benchmark reference 源不进
    listSourceIds: async (projectId) =>
      (await sources.list(projectId))
        .filter((item) => item.sourceRole !== "reference")
        .map((item) => item.sourceId),
    loadDocument: (projectId, sourceId) => documents.load(projectId, sourceId),
    readFigureAsset: async (projectId, sourceId, assetName) => {
      try {
        return await readFile(join(documents.figuresDir(projectId, sourceId), assetName));
      } catch {
        return null;
      }
    },
  },
  // 生成图清单（可选；M12.3 figureStore 视图——注意 assetRef 需带 figs/generated/ 前缀）
  generatedFigures: async (projectId) => {
    const store = new FigureStore(
      join(options.projects.manuscriptDir(projectId), "figs", "generated"),
    );
    try {
      return (await store.list()).map((record) => ({
        figId: record.figId,
        kind: record.kind,
        caption: record.caption,
        ...(record.insertedIn?.label !== undefined ? { label: record.insertedIn.label } : {}),
        assetRef: `figs/generated/${record.assets.pdf}`,
        createdAt: record.createdAt,
      }));
    } catch {
      return []; // manifest 损坏不阻断视觉评审（生成图侧如实缺席）
    }
  },
});
// stack 暴露：visualReview
```

要点：
- **vision seam 零新建**：`modelRuntime`/`modelCandidates` 与 `stack.vision` 同一来源（`options.vision`）。测试注入 `scriptedVisionRuntime`（已扩展：prompt 含「四项一致性检查」marker 时返回视觉检查 schema，否则保持 M10.2 FigureAnalysis 形状——现有 M10.2 测试不受影响）。
- **vision 不可用是常态**（GLM-5.3 部署）：`modelRuntime` 缺省或 `resolveVisionModel` 不可用 → 四项 vision 检查 skipped + capability 报告原因码，确定性检查照常。**绝不让视觉评审失败**。
- 服务三个方法：`runVisualReview(input)`（核心，workflow review stage 可直接调用，支持显式注入 texFiles/pdfViews/figureAssetBytes）、`runForProject(projectId)`（HTTP 用，自动装配 + 落盘 + 返回 round/reportPath）、`latestVisualReview(projectId)`（HTTP GET）。
- 落盘产物：`reviews/visual-review-r<n>.json`（round = 目录内最大编号 + 1）；同时把 `research/manuscript-visuals.json` 随评审重建落盘（derived 与当前 .tex 同步）。

### workflow review stage 接入（可选，本批不强制）

review stage 拿到 findings 后，visual 单列进 summary：

```ts
import { summarizeVisualFindings } from "../review/ReviewAggregator.js";
const visualReport = await stack.visualReview.runVisualReview({ projectId });
// findings 可并入 review 产物；summary 单列：
summary.visual = summarizeVisualFindings(visualReport.findings);
```

**语义红线**：visual findings 不进 `counts` / `openCritical` / `openMajor` / 任何 gate 规则（M12.0 §10.3：v1 零新阻断）。

## 2. HTTP 路由契约（httpServer.ts 照此实现）

统一前缀 `/api/projects/:projectId/...`（projectId 校验沿用现行 `getRequired`）。
所有 JSON 响应经 `sendJson`；资产路由直发字节。

### 2.1 `GET /api/projects/:id/visual-reviews/latest`

| 项 | 值 |
|---|---|
| 200（从未运行） | `{ "report": null }`（**不是 404**——前端以 null 区分「尚未运行」） |
| 200（有产物） | `{ "report": VisualReviewReport }`（见 §3 shape） |
| 404 | 项目不存在（PROJECT_NOT_FOUND） |

实现：`const report = await stack.visualReview.latestVisualReview(projectId); sendJson(res, 200, { report });`

### 2.2 `POST /api/projects/:id/visual-reviews/run`

| 项 | 值 |
|---|---|
| 200 | `{ "report": VisualReviewReport }`（已落盘，含 `round`） |
| 404 | 项目不存在 |
| 409 | 建议：活跃 run 期间可拒（PROJECT_BUSY，与 build 同口径；不拒也可接受——视觉评审只读不写稿） |

实现：`const result = await stack.visualReview.runForProject(projectId); sendJson(res, 200, { report: result });`
说明：同步执行。确定性-only 部署耗时毫秒级（纯解析）；vision 可用时每图一次模型调用（上限 = figure 数；建议 `?skipVision=true` 透传为 input.skipVision 供调试，非必需）。

### 2.3 `GET /api/projects/:id/sources/:sid/figures/:name`（B4 主路由，补 G8）

source 抽图资产。实现：

```ts
const result = await resolveSourceFigureAsset({
  projects: stack.projects,
  documents: { load: (pid, sid) => stack.documents.load(pid, sid) },
  projectId, sourceId: sid, assetName: decodeURIComponent(name),
});
if (!result.ok) { sendJson(res, result.failure.httpStatus, { error: { code: result.failure.code, message: result.failure.message } }); return; }
res.writeHead(200, { "Content-Type": result.asset.mimeType, "Content-Length": result.asset.byteLength, "Cache-Control": "private, max-age=3600" });
res.end(result.asset.bytes);
```

### 2.4 `GET /api/projects/:id/figures/generated/:name`（生成图 PDF）

```ts
const result = await resolveGeneratedFigureAsset({
  projects: stack.projects, projectId, fileName: decodeURIComponent(name),
  registry: { listFigIds: async () => (await figureStoreOf(projectId).list()).map(r => r.figId) },
});
// 成功：Content-Type: application/pdf；错误映射同 2.3
```

### 2.5 错误码映射（figureAssets 失败 → HTTP；code 即对外契约，勿改）

| failure.code | httpStatus | 语义 |
|---|---|---|
| `invalid_project` | 404 | 项目不存在 |
| `invalid_path` | 400 | 资产名非法（遍历 / 分隔符 / 控制字符 / 形态不符） |
| `unsupported_asset` | 400 | 扩展名不在白名单（source: png/jpg/jpeg；generated: fig-<hex>.pdf） |
| `missing_artifact` | 404 | 登记存在但文件不在盘（或源无解析产物） |
| `stale_asset` | 404 | 文件在盘但不在权威登记（重解析残留 / manifest 外） |

安全语义（攻击面测试已覆盖 13 类）：扁平名白名单 `^[A-Za-z0-9][A-Za-z0-9._-]*$`、拒绝 `/`、`\`、`..`、前导点、NUL/控制字符、绝对路径；词法 + realpath 双重包含校验；登记（ParsedDocument figure 块 assetName / figureStore manifest）先于读盘。

## 3. VisualReviewReport shape（前后端共同契约；frontend/src/api/visuals.ts 已按此实现）

```ts
{
  schemaVersion: 1,
  projectId: string,
  runAt: string,                      // ISO
  round?: number,                     // 落盘轮次（runForProject 填）
  inputs: { texFiles: string[]; pdfSourceIds: string[]; generatedFigureIds: string[] },
  artifacts: { total: number; figures: number; tables: number; bySourceKind: Record<string, number> },
  findings: ReviewFinding[],          // category 恒 "visual"；source ∈ {deterministic-visual, vision-assisted}
  checks: Array<{                     // 每项子检查执行结果
    checkId: string,                  // 确定性六项 + vision 四项（id 见下）
    kind: "deterministic" | "vision",
    status: "passed" | "finding" | "skipped" | "failed",
    detail?: string, findingIds?: string[], visualArtifactIds?: string[]
  }>,
  capability: {
    visionAvailable: boolean,
    modelSpec?: string, source?: "vision_setting" | "default_model",
    reason?: string,                  // VisionUnavailableReason（not_configured / no_vision_model / model_not_in_catalog / auth_missing）
    detail: string,
    skippedChecks: string[],          // vision 不可用时 = 全部四项
    skippedFigures: Array<{ visualArtifactId: string; reason: string }>,
    visionFiguresCompleted: number, visionFiguresFailed: number,
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number }
  },
  notes: string[]
}
```

checkId 清单：确定性 `label-ref-resolution` / `duplicate-label` / `missing-caption` / `unreferenced-artifact` / `table-text-numeric` / `caption-reference-mismatch`；vision `figure-caption-consistency` / `figure-claim-consistency` / `legend-axis-consistency` / `diagram-method-consistency`。

ReviewFinding 视觉扩展字段（additive）：`figureEnvRef?`（VisualArtifactView id，如 `tex:main.tex:table-1`）、`assetRef?`、`visualConfidence?: high|medium|low`、`verificationStatus?: verified_deterministic | model_observation | needs_author_review`（vision 观察恒非 verified）。

## 4. 前端契约（已实现，主线无需改动）

- `frontend/src/api/visuals.ts`：`getVisualReviewReport` / `runVisualReview` / `sourceFigureUrl` / `generatedFigureUrl` / `assetPreviewOf`。
- ReviewPanel 追加 `VisualReviewSection`（testid：`visual-review-section` / `run-visual-review` / `visual-not-run` / `visual-review-report` / `visual-vision-unavailable` / `visual-deterministic-group` / `visual-vision-group` / `visual-finding-card` / `visual-asset-preview` / `visual-asset-unavailable`）。确定性 / Vision 两组严格分栏；vision 不可用显式原因 + 「确定性-only 模式」标注；图片资产 `<img>` 预览、PDF 资产链接、不可预览给原因。
- ProjectPage 无需改动（ReviewPanel 自取数）；如需在无 PDF 的 latex-only 项目也显示，主线可自行决定渲染位置（当前在 doc 存在时渲染）。

## 5. 行为细节与已知边界（诚实清单）

1. **数值一致性规则**（假阳性优先）：句子必须同时绑定「表头指标词 + 行标签词」才比较；每个指标出现位置只取**最近一个** ≤60 字符数值（防 "A is 118 while B is 79" 错位）；差值语（by/±/约/了/到）、|整数| ≤ 12、字母相邻数字（MOT17）跳过；多表同 (行,指标) 并集消歧；latex 表只与 latex 正文比、pdf 表只与同源 pdf 正文比（分组隔离）。规则全文在 `visualChecks.ts` 文件头。
2. **题注-描述匹配是启发式**：词面 token（拉丁 ≥3 字符去停用/泛词 + 中文字符）零重叠才报，severity=minor + `needs_author_review`（绝不冒充确定性结论）；描述/题注无内容词 → skip。
3. **missing-caption 只覆盖 latex**（inventory.captionMissing）；PDF 侧 caption 缺失常为 parser 能力边界，不制造噪声 finding（视图 extraction.note 已透明）。
4. **unreferenced-artifact** 仅当全文存在 ≥1 个 `\ref` 类视觉引用时运行（纯字面引用风格手稿不误报）。
5. **vision 只送 PNG/JPEG**：生成图（PDF 资产）如实跳过（`skippedFigures` 给原因），不转换、不伪装；latex includegraphics 路径做 manuscript/ 包含校验后读盘。
6. **模型输出**：typebox schema 校验 + 至多 1 次 repair；仍失败 → 该图四项检查记 `failed`（无 finding、不抛异常、无无限重试）。
7. **inventory 同步**：视觉评审每次运行都从当前 .tex 重建并落盘 `research/manuscript-visuals.json`（derived 与权威源同步；落盘失败只记 note 不阻断）。
8. **label-ref-resolution 对 pdf 侧无意义**（无 \ref 语义）：inventory 为 null（无 manuscript）时该检查 skipped。
9. 图片资产路由的 `documents` 登记访问器是**可选**的：不传 = 纯文件系统模式（跳过 stale 检查）；生产建议传（防重解析残留外发）。

## 6. 测试与验收

- backend 定向：`npx vitest run --maxWorkers=4 test/vision test/review` → **373 passed / 0 failed / 4 skipped**（skipped = 既有 visionLive smoke 门）；邻接 `test/paper/domainModel + test/manuscript` → 55 passed。
- frontend：typecheck ✓ / build ✓（chunk 警告为既有）/ `npm test` → **281 passed**。
- backend typecheck：Track B 文件零错误（全仓 typecheck 当前有 `src/target/*` 错误，属并行 Track A 进行中文件，非本轨产物）。
- Smoke B（本批）：`visual-review-sample` fixture 断言面已锁定——恰 5 findings（1 数值冲突 + 1 题注不符 + 1 未解析引用 + 1 缺 caption + 1 未引用 info），全部假阳性守卫零误报。主线真实 smoke：`POST /api/projects/:id/visual-reviews/run` 于任一含手稿项目。

## 7. 主线待办（唯一剩余接线点）

1. serviceStack：§1 工厂装配 + stack 暴露 `visualReview`。
2. httpServer：§2 四条路由。
3. （可选）workflow review stage：`summary.visual = summarizeVisualFindings(...)`。
4. （可选）`FINDING_CATEGORY_LABELS`（frontend/src/components/common/status.ts）补 `visual: "视觉"`——当前 ReviewPanel 视觉区用自己的标签，不影响功能；若主线把 visual findings 并入 existing-review 报告则需补。
