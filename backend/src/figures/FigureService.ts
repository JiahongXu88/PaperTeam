/**
 * FigureService（M12.3 C4/C5）：图表产品服务编排。
 *
 * 职责（全部零 LLM；模型在本链路没有任何参与点）：
 * - 数据集候选：项目 sources 的 ParsedDocument → DatasetCandidate 列表 / 单集载荷；
 * - 校验：spec 校验（C1）+ caption 真实性预检（C6 advisory）；
 * - 生成：per-project 串行化（manifest 读-改-写互斥由本层保证）+ 来源锚
 *   反查（inlineDataset 与声称的 sourceId/blockId 不一致 → 拒绝——防数据
 *   篡改：数据必须逐字节来自其声称的来源）；
 * - 列表 / 元数据：manifest + 资产在盘状态 + 陈旧性（来源变化检测）；
 * - 插入（C5）：受控 append / replace + 修订安全边界 + caption 守卫硬闸。
 *
 * 服务形状对齐 target/services.ts 的装配纪律：构造函数只收 seam 依赖，
 * 不做 IO；每个方法自包含（无跨调用缓存态）。
 */

import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import {
  BusinessError,
  FigureAlreadyInsertedError,
  FigureAssetMissingError,
  FigureCaptionUnsupportedError,
  FigureCaptionUnverifiedError,
  FigureDatasetStaleError,
  FigureLabelConflictError,
  FigureLabelNotFoundError,
  FigureNotFoundError,
  FigureScopeViolationError,
  FigureSourceMissingError,
} from "../errors.js";
import type { ProjectStore, ProjectMetadata } from "../project/ProjectStore.js";
import type { SourceStore, SourceItem } from "../sources/SourceStore.js";
import type { ParsedDocumentStore } from "../ingestion/ParsedDocumentStore.js";
import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import { collectLatexFiles, normalizeTexPath } from "../manuscript/LatexFiles.js";
import { buildVisualInventory } from "../manuscript/visualInventory.js";
import { change, hashText, recoverInsertion, requestFingerprint, saveIntent, type InsertionIntent } from "./insertionRecovery.js";
import { FigureCompiler, figureFailureToBusinessError } from "./FigureCompiler.js";
import {
  FigureStore,
  type GeneratedFigureRecord,
} from "./figureStore.js";
import {
  extractDatasetsFromDocument,
  findDatasetByAnchor,
  toCandidate,
  type DatasetCandidate,
  type DatasetPayload,
} from "./datasets.js";
import {
  applyAppendInsertion,
  applyReplacement,
  deriveLabelBody,
  ensureGraphicxPreamble,
  existingFigureLabelBodies,
  findFigureEnvByLabel,
  normalizeLabelBody,
  renderFigureEnvironment,
  uniqueLabelBody,
} from "./insertion.js";
import { validateCaptionAgainstDataset, type CaptionValidation } from "./truthfulness.js";
import {
  validateDiagramSpec,
  validatePlotSpec,
  type NormalizedPlotSpec,
} from "./spec.js";

export interface FigureServiceDeps {
  projects: ProjectStore;
  sources: SourceStore;
  documents: ParsedDocumentStore;
  revisions: ManuscriptRevisionStore;
  compiler: FigureCompiler;
}

/** 列表视图（manifest 记录 + 派生状态） */
export interface FigureView {
  figId: string;
  kind: "plot" | "diagram";
  /** plot：plotType / semantic / title（spec 投影） */
  plotType?: string;
  semantic?: string;
  title?: string;
  caption: string;
  specHash: string;
  datasetHash?: string;
  /** source_parsed | manual | diagram（结构化分类，UI 徽章用） */
  dataOriginClass: "source_parsed" | "manual" | "diagram";
  sourceId?: string;
  blockId?: string;
  createdAt: string;
  compiler?: GeneratedFigureRecord["compiler"];
  assetPresent: boolean;
  insertedIn?: GeneratedFigureRecord["insertedIn"];
  supersededBy?: string;
  /** 陈旧性（仅 source 锚图计算；数据/来源变化 → 需重新生成） */
  stale?: { reason: "source_missing" | "source_changed" | "dataset_changed"; detail: string };
}

export interface GenerateResult {
  record: GeneratedFigureRecord;
  cached: boolean;
  /** plot：caption 真实性预检（advisory——生成不阻断，插入时成为硬闸） */
  captionValidation?: CaptionValidation;
}

export interface InsertParams {
  figId: string;
  mode: "append" | "replace";
  /** append：outline sectionId 或显式 file（须在文档图内）；replace：目标 file */
  sectionId?: string;
  file?: string;
  /** append：期望 label（显式冲突即拒；缺省从 caption 派生 + 自动消歧） */
  label?: string;
  /** 最终 caption（缺省 record.caption；不允许空） */
  caption?: string;
  widthExpression?: string;
  /** append：正文引用句（必须包含 \ref{fig:<label>}；追加在环境后） */
  referenceSentence?: string;
  /** replace：目标 label（缺省 = label 参数；保留原名不动正文 \ref） */
  replaceLabel?: string;
  /** UNVERIFIED caption 的作者确认（记录在响应中） */
  confirmUnverified?: boolean;
}

export interface InsertResult {
  record: GeneratedFigureRecord;
  file: string;
  label: string;
  environment: string;
  graphicxInjected: boolean;
  previousPath?: string;
  authorConfirmedUnverified: boolean;
  captionValidation?: CaptionValidation;
}

/** per-project 串行化（manifest 读-改-写互斥；Map 键随进程生命周期） */
const projectLocks = new Map<string, Promise<unknown>>();

async function withProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  // 尾部promise永不 reject（后续排队者不因前序失败而死锁）
  projectLocks.set(
    projectId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export class FigureService {
  private readonly projects: ProjectStore;
  private readonly sources: SourceStore;
  private readonly documents: ParsedDocumentStore;
  private readonly revisions: ManuscriptRevisionStore;
  private readonly compiler: FigureCompiler;

  constructor(deps: FigureServiceDeps) {
    this.projects = deps.projects;
    this.sources = deps.sources;
    this.documents = deps.documents;
    this.revisions = deps.revisions;
    this.compiler = deps.compiler;
  }

  private store(projectId: string): FigureStore {
    return new FigureStore(join(this.projects.manuscriptDir(projectId), "figs", "generated"));
  }

  // ---- 数据集候选 ----

  /** 全部可用数据集候选（含 reference 源——benchmark 对比图是合法语义；UI 标注角色） */
  async listDatasets(projectId: string): Promise<DatasetCandidate[]> {
    await this.projects.getRequired(projectId);
    const items = await this.sources.list(projectId);
    const candidates: DatasetCandidate[] = [];
    for (const item of items) {
      const document = await this.documents.load(projectId, item.sourceId);
      if (document === null || document.status === "failed") {
        continue;
      }
      for (const payload of extractDatasetsFromDocument(document)) {
        if (payload.rowCount === 0 || payload.columns.length === 0) {
          continue;
        }
        candidates.push({
          ...toCandidate(payload),
          sourceRole: item.sourceRole,
        });
      }
    }
    return candidates;
  }

  /** 单数据集全量载荷（生成 spec 的取数入口） */
  async getDataset(projectId: string, sourceId: string, blockId: string): Promise<DatasetPayload> {
    await this.projects.getRequired(projectId);
    const payloads = await this.datasetsOfSource(projectId, sourceId);
    const payload = findDatasetByAnchor(payloads, sourceId, blockId);
    if (payload === undefined) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `数据集不存在：source ${sourceId} 的块 ${blockId}（或无结构化数据）`,
      );
    }
    return payload;
  }

  private async datasetsOfSource(projectId: string, sourceId: string): Promise<DatasetPayload[]> {
    const items = await this.sources.list(projectId);
    const item = items.find((entry) => entry.sourceId === sourceId);
    if (item === undefined) {
      throw new FigureSourceMissingError(`source ${sourceId} 不存在于项目 ${projectId}`);
    }
    const document = await this.documents.load(projectId, sourceId);
    if (document === null) {
      throw new FigureSourceMissingError(`source ${sourceId} 无解析产物（未完成结构化解析）`);
    }
    return extractDatasetsFromDocument(document);
  }

  // ---- 校验（spec + caption 预检） ----

  async validate(projectId: string, kind: "plot" | "diagram", spec: unknown): Promise<
    | { ok: true; captionValidation?: CaptionValidation }
    | { ok: false; errors: string[] }
  > {
    await this.projects.getRequired(projectId);
    if (kind === "plot") {
      const result = validatePlotSpec(spec);
      if (!result.ok || result.spec === undefined) {
        return { ok: false, errors: result.errors };
      }
      const caption = result.spec.caption ?? result.spec.title ?? "";
      const captionValidation =
        caption.trim() === ""
          ? undefined
          : validateCaptionAgainstDataset(caption, result.spec);
      return { ok: true, ...(captionValidation !== undefined ? { captionValidation } : {}) };
    }
    const result = validateDiagramSpec(spec);
    if (!result.ok) {
      return { ok: false, errors: result.errors };
    }
    return { ok: true };
  }

  // ---- 生成 ----

  async generate(projectId: string, kind: "plot" | "diagram", spec: unknown): Promise<GenerateResult> {
    await this.projects.getRequired(projectId);
    return withProjectLock(projectId, async () => {
      await recoverInsertion(this.projects, projectId, this.store(projectId));
      // 来源锚反查：声称来自 source 的数据必须逐字节来自该 source（防篡改）
      if (kind === "plot") {
        const pre = validatePlotSpec(spec);
        if (!pre.ok || pre.spec === undefined) {
          throw new BusinessError("FIGURE_SPEC_INVALID", `图表 spec 校验失败：${pre.errors.join("；")}`);
        }
        await this.assertOriginFaithful(projectId, pre.spec);
        const caption = pre.spec.caption ?? pre.spec.title ?? "";
        const captionValidation =
          caption.trim() === ""
            ? undefined
            : validateCaptionAgainstDataset(caption, pre.spec);
        const outcome = await this.compiler.generate({ kind, spec, store: this.store(projectId) });
        if (!outcome.ok) {
          throw figureFailureToBusinessError(outcome.failure);
        }
        return {
          record: outcome.record,
          cached: outcome.cached,
          ...(captionValidation !== undefined ? { captionValidation } : {}),
        };
      }
      const outcome = await this.compiler.generate({ kind, spec, store: this.store(projectId) });
      if (!outcome.ok) {
        throw figureFailureToBusinessError(outcome.failure);
      }
      return { record: outcome.record, cached: outcome.cached };
    });
  }

  /** inlineDataset 与来源块当前内容一致性（source 锚；manual 锚跳过） */
  private async assertOriginFaithful(projectId: string, spec: NormalizedPlotSpec): Promise<void> {
    if (!("sourceId" in spec.data.origin)) {
      return;
    }
    const origin = spec.data.origin as { sourceId: string; blockId?: string };
    const payloads = await this.datasetsOfSource(projectId, origin.sourceId);
    if (origin.blockId === undefined) {
      return; // 仅锚到 source 级：存在性已由 datasetsOfSource 校验
    }
    const payload = findDatasetByAnchor(payloads, origin.sourceId, origin.blockId);
    if (payload === undefined) {
      throw new FigureSourceMissingError(
        `数据来源块不存在：source ${origin.sourceId} 的 ${origin.blockId}（数据可能被重新解析）`,
      );
    }
    if (payload.datasetHash !== spec.data.datasetHash) {
      throw new FigureDatasetStaleError(
        `inlineDataset 与来源数据不一致（source ${origin.sourceId} 块 ${origin.blockId} 的 datasetHash 不同）——` +
          "图表数据必须逐字节来自其声称的来源；如来源已更新请重新提取数据集",
      );
    }
  }

  // ---- 列表 / 元数据 ----

  async list(projectId: string): Promise<FigureView[]> {
    await this.projects.getRequired(projectId);
    return withProjectLock(projectId, async () => {
      const store = this.store(projectId);
      await recoverInsertion(this.projects, projectId, store);
      const records = await store.list();
      const sourceItems = await this.sources.list(projectId);
      const views: FigureView[] = [];
      for (const record of records) {
        views.push(await this.toView(projectId, record, sourceItems));
      }
      return views;
    });
  }

  async get(projectId: string, figId: string): Promise<FigureView & { spec: unknown; captionValidation?: CaptionValidation }> {
    await this.projects.getRequired(projectId);
    return withProjectLock(projectId, async () => {
      const store = this.store(projectId);
      await recoverInsertion(this.projects, projectId, store);
      const record = await store.get(figId);
      if (record === undefined) {
        throw new FigureNotFoundError(figId);
      }
      const spec = await store.loadSpec(figId);
      const view = await this.toView(projectId, record);
      let captionValidation: CaptionValidation | undefined;
      if (record.kind === "plot" && spec !== null) {
        const validated = validatePlotSpec(spec);
        if (validated.ok && validated.spec !== undefined) {
          const caption = record.caption.trim() === "" ? undefined : record.caption;
          if (caption !== undefined) {
            captionValidation = validateCaptionAgainstDataset(caption, validated.spec);
          }
        }
      }
      return { ...view, spec, ...(captionValidation !== undefined ? { captionValidation } : {}) };
    });
  }

  private async toView(
    projectId: string,
    record: GeneratedFigureRecord,
    preloadedItems?: SourceItem[],
  ): Promise<FigureView> {
    const store = this.store(projectId);
    const spec = await store.loadSpec(record.figId);
    let plotType: string | undefined;
    let semantic: string | undefined;
    let title: string | undefined;
    if (record.kind === "plot" && spec !== null) {
      const plotSpec = spec as { plotType?: string; semantic?: string; title?: string };
      plotType = typeof plotSpec.plotType === "string" ? plotSpec.plotType : undefined;
      semantic = typeof plotSpec.semantic === "string" ? plotSpec.semantic : undefined;
      title = typeof plotSpec.title === "string" ? plotSpec.title : undefined;
    } else if (record.kind === "diagram" && spec !== null) {
      title = typeof (spec as { title?: string }).title === "string" ? (spec as { title?: string }).title : undefined;
    }
    const stale = await this.stalenessOf(projectId, record, preloadedItems);
    return {
      figId: record.figId,
      kind: record.kind,
      ...(plotType !== undefined ? { plotType } : {}),
      ...(semantic !== undefined ? { semantic } : {}),
      ...(title !== undefined ? { title } : {}),
      caption: record.caption,
      specHash: record.specHash,
      ...(record.datasetHash !== undefined ? { datasetHash: record.datasetHash } : {}),
      dataOriginClass:
        record.kind === "diagram"
          ? "diagram"
          : "sourceId" in record.dataOrigin
            ? "source_parsed"
            : "manual",
      ...("sourceId" in record.dataOrigin
        ? { sourceId: (record.dataOrigin as { sourceId: string }).sourceId }
        : {}),
      ...("sourceId" in record.dataOrigin && record.dataOrigin.blockId !== undefined
        ? { blockId: record.dataOrigin.blockId }
        : {}),
      createdAt: record.createdAt,
      ...(record.compiler !== undefined ? { compiler: record.compiler } : {}),
      assetPresent: await store.pdfAssetExists(record),
      ...(record.insertedIn !== undefined ? { insertedIn: record.insertedIn } : {}),
      ...(record.supersededBy !== undefined ? { supersededBy: record.supersededBy } : {}),
      ...(stale !== undefined ? { stale } : {}),
    };
  }

  /** 陈旧性：来源锚图的数据是否仍与来源一致（manual / diagram 恒新鲜） */
  private async stalenessOf(
    projectId: string,
    record: GeneratedFigureRecord,
    preloadedItems?: SourceItem[],
  ): Promise<FigureView["stale"]> {
    if (!("sourceId" in record.dataOrigin) || record.datasetHash === undefined) {
      return undefined;
    }
    const origin = record.dataOrigin as { sourceId: string; blockId?: string };
    const items = preloadedItems ?? (await this.sources.list(projectId));
    const item: SourceItem | undefined = items.find((entry) => entry.sourceId === origin.sourceId);
    if (item === undefined) {
      return { reason: "source_missing", detail: `来源 source ${origin.sourceId} 已不存在` };
    }
    const document = await this.documents.load(projectId, origin.sourceId);
    if (document === null) {
      return { reason: "source_missing", detail: `来源 ${origin.sourceId} 无解析产物` };
    }
    if (item.contentHash !== undefined && document.contentHash !== item.contentHash) {
      return {
        reason: "source_changed",
        detail: `来源文件已更新（上传时间晚于解析）——解析产物过期`,
      };
    }
    if (origin.blockId === undefined) {
      return undefined;
    }
    const payload = findDatasetByAnchor(
      extractDatasetsFromDocument(document),
      origin.sourceId,
      origin.blockId,
    );
    if (payload === undefined) {
      return { reason: "dataset_changed", detail: `来源块 ${origin.blockId} 不再存在（数据被重新解析）` };
    }
    if (payload.datasetHash !== record.datasetHash) {
      return {
        reason: "dataset_changed",
        detail: "来源数据已变化——本图基于旧数据生成，如需更新请以新数据重新生成",
      };
    }
    return undefined;
  }

  // ---- 插入（C5） ----

  async insert(projectId: string, params: InsertParams): Promise<InsertResult> {
    const project = await this.projects.getRequired(projectId);
    return withProjectLock(projectId, async () => {
      const store = this.store(projectId);
      const requestHash = requestFingerprint(params);
      const recovered = await recoverInsertion(this.projects, projectId, store);
      if (recovered?.status === "complete" && recovered.requestHash === requestHash &&
          hashText(await readFile(join(this.projects.manuscriptDir(projectId), recovered.targetFile), "utf8")) === recovered.target.after &&
          hashText(await readFile(store.manifestPath, "utf8")) === recovered.manifest.after) {
        return recovered.result;
      }
      const record = await store.get(params.figId);
      if (record === undefined) {
        throw new FigureNotFoundError(params.figId);
      }
      if (!(await store.pdfAssetExists(record))) {
        throw new FigureAssetMissingError(params.figId);
      }
      if (record.supersededBy !== undefined) {
        throw new BusinessError(
          "FIGURE_ALREADY_INSERTED",
          `图表 ${params.figId} 已被 ${record.supersededBy} 替换（历史资产；请使用当前图）`,
        );
      }

      const caption = (params.caption ?? record.caption).trim();
      if (caption === "") {
        throw new BusinessError("INVALID_REQUEST", "caption 不能为空（学术图表必须带题注）");
      }

      // 文档图 + 目标文件解析
      const manuscriptDir = this.projects.manuscriptDir(projectId);
      const files = await collectLatexFiles(manuscriptDir);
      if (files.allTex.length === 0) {
        throw new BusinessError(
          "INVALID_REQUEST",
          "手稿尚不存在（无 .tex 文件）——先完成大纲/写作再插入图表",
        );
      }
      const targetFile = await this.resolveTargetFile(projectId, params, files.allTex.map((file) => file.relativePath));
      const target = files.allTex.find((file) => file.relativePath === targetFile);
      if (target === undefined) {
        throw new BusinessError("INVALID_REQUEST", `目标文件 ${targetFile} 不在手稿文档图内`);
      }
      const inventory = buildVisualInventory(
        files.allTex.map((file) => ({ file: file.relativePath, content: file.content })),
      );

      // 修订安全边界：已有论文项目不允许 append（新增图表环境必须走受控替换
      // 或修订工作流——图表动作不得成为绕过 M11 Scope Guard 的后门）
      const existingPaper = isExistingPaperKind(project);
      if (params.mode === "append" && existingPaper) {
        throw new FigureScopeViolationError(
          "已有论文（返修/评审）项目不允许直接新增图表环境：请使用 replace 模式受控替换既有图" +
            "（保留 label 与位置，只换资产与题注），或经修订工作流的获批 action 插入",
        );
      }

      // caption 真实性硬闸（plot）
      let captionValidation: CaptionValidation | undefined;
      if (record.kind === "plot") {
        const spec = await store.loadSpec(params.figId);
        if (spec !== null) {
          const validated = validatePlotSpec(spec);
          if (validated.ok && validated.spec !== undefined) {
            captionValidation = validateCaptionAgainstDataset(caption, validated.spec);
          }
        }
        if (captionValidation?.verdict === "violation") {
          throw new FigureCaptionUnsupportedError(
            captionValidation.issues
              .filter((issue) => issue.level === "violation")
              .map((issue) => `[${issue.claim}] ${issue.message}`)
              .join("；"),
          );
        }
        if (captionValidation?.verdict === "unverified" && params.confirmUnverified !== true) {
          throw new FigureCaptionUnverifiedError(
            captionValidation.issues
              .filter((issue) => issue.level === "unverified")
              .map((issue) => `[${issue.claim}] ${issue.message}`)
              .join("；") +
              "——确认无误请携带 confirmUnverified=true 重新提交（作者确认将记录在案）",
          );
        }
      }

      // 来源陈旧性硬闸：插入的图必须仍与来源数据一致
      const stale = await this.stalenessOf(projectId, record);
      if (stale !== undefined) {
        throw new FigureDatasetStaleError(`${stale.detail}（拒绝插入旧数据图）`);
      }

      let labelBody: string;
      let previousPath: string | undefined;
      let newContent: string;
      if (params.mode === "replace") {
        const rawLabel = params.replaceLabel ?? params.label;
        if (rawLabel === undefined) {
          throw new BusinessError("INVALID_REQUEST", "replace 模式必须提供 replaceLabel（或 label）");
        }
        const fullLabel = rawLabel.trim().startsWith("fig:") ? rawLabel.trim() : `fig:${rawLabel.trim()}`;
        if (record.insertedIn !== undefined &&
            (record.insertedIn.file !== targetFile || record.insertedIn.label !== fullLabel)) {
          throw new FigureAlreadyInsertedError(params.figId, record.insertedIn.file);
        }
        const found = findFigureEnvByLabel(targetFile, target.content, fullLabel);
        if (found === undefined) {
          throw new FigureLabelNotFoundError(fullLabel, targetFile);
        }
        labelBody = fullLabel.replace(/^fig:/, "");
        // 同位置重复替换（同 figId + 同 label）也是一次确定性的环境重写——
        // caption / 宽度更新经同一 apply 路径落盘（无静默跳过）
        const environment = renderFigureEnvironment({
          figId: params.figId,
          caption,
          labelBody,
          ...(params.widthExpression !== undefined ? { widthExpression: params.widthExpression } : {}),
        });
        const replaced = applyReplacement(target.content, found, environment);
        if (!replaced.ok) {
          throw new FigureLabelNotFoundError(fullLabel, targetFile);
        }
        newContent = replaced.content;
        previousPath = replaced.previousPath;
      } else {
        // append：label 分配 + 全稿冲突检查 + 重复插入检查
        const existing = existingFigureLabelBodies(inventory);
        if (record.insertedIn !== undefined) {
          throw new FigureAlreadyInsertedError(params.figId, record.insertedIn.file);
        }
        if (params.label !== undefined) {
          const normalized = normalizeLabelBody(params.label);
          if (normalized === null) {
            throw new BusinessError(
              "INVALID_REQUEST",
              `非法 label："${params.label}"（允许字母数字连字符下划线点，冒号后缀 fig: 可选）`,
            );
          }
          if (existing.has(normalized)) {
            throw new FigureLabelConflictError(`fig:${normalized}`);
          }
          labelBody = normalized;
        } else {
          labelBody = uniqueLabelBody(deriveLabelBody(caption, params.figId), existing);
        }
        if (params.referenceSentence !== undefined) {
          if (!params.referenceSentence.includes(`\\ref{fig:${labelBody}}`)) {
            throw new BusinessError(
              "INVALID_REQUEST",
              `referenceSentence 必须包含 \\ref{fig:${labelBody}}（当前 label 的正确引用）`,
            );
          }
        }
        const environment = renderFigureEnvironment({
          figId: params.figId,
          caption,
          labelBody,
          ...(params.widthExpression !== undefined ? { widthExpression: params.widthExpression } : {}),
        });
        newContent = applyAppendInsertion(target.content, environment, labelBody, params.referenceSentence);
      }

      let graphicxInjected = false;
      let mainChange: ReturnType<typeof change> | undefined;
      if (files.mainTex !== null && files.mainTex.relativePath === "main.tex") {
        const preamble = ensureGraphicxPreamble(targetFile === "main.tex" ? newContent : files.mainTex.content);
        if (preamble.injected) {
          graphicxInjected = true;
          if (targetFile === "main.tex") newContent = preamble.content;
          else mainChange = change(files.mainTex.content, preamble.content);
        }
      }
      const revision = await this.revisions.currentRevision(projectId);
      const fullLabel = `fig:${labelBody}`;
      const manifestBefore = await readFile(store.manifestPath, "utf8");
      const manifest = await store.loadManifest();
      if (params.mode === "replace") {
        const occupant = manifest.figures.filter((entry) =>
          entry.figId !== params.figId && entry.insertedIn?.file === targetFile && entry.insertedIn.label === fullLabel);
        if (occupant.length > 1 || (occupant.length === 1 && previousPath !== `figs/generated/${occupant[0]!.figId}.pdf`)) {
          throw new BusinessError("FIGURE_RECOVERY_REQUIRED", `目标 ${targetFile} 的 Figure 资产与 manifest lineage 不一致`);
        }
      }
      const planned = store.planInsertion(manifest, {
        figId: params.figId,
        insertedIn: { file: targetFile, label: fullLabel, revision },
      });
      const result: InsertResult = {
        record: planned.updated,
        file: targetFile,
        label: fullLabel,
        environment: renderFigureEnvironment({
          figId: params.figId,
          caption,
          labelBody,
          ...(params.widthExpression !== undefined ? { widthExpression: params.widthExpression } : {}),
        }),
        graphicxInjected,
        ...(previousPath !== undefined ? { previousPath } : {}),
        authorConfirmedUnverified: params.confirmUnverified === true,
        ...(captionValidation !== undefined ? { captionValidation } : {}),
      };
      const intent: InsertionIntent = {
        schemaVersion: 1, status: "pending", requestHash, targetFile,
        target: change(target.content, newContent),
        ...(mainChange !== undefined ? { main: mainChange } : {}),
        manifest: change(manifestBefore, JSON.stringify(planned.manifest, null, 2) + "\n"),
        revision, result,
      };
      // Write-ahead record precedes every manuscript, preamble and lineage write.
      await saveIntent(store, intent);
      const completed = await recoverInsertion(this.projects, projectId, store);
      return completed!.result;
    });
  }

  /** 目标文件解析：sectionId（outline）→ sections/<file>；显式 file 须在文档图内 */
  private async resolveTargetFile(
    projectId: string,
    params: InsertParams,
    knownFiles: readonly string[],
  ): Promise<string> {
    if (params.sectionId !== undefined && params.file !== undefined) {
      throw new BusinessError("INVALID_REQUEST", "sectionId 与 file 只能提供一个");
    }
    if (params.file !== undefined) {
      const normalized = normalizeTexPath(params.file);
      if (normalized === null || normalized.includes("..") || posix.isAbsolute(normalized)) {
        throw new BusinessError("INVALID_REQUEST", `非法目标文件路径："${params.file}"`);
      }
      if (!knownFiles.includes(normalized)) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `目标文件 ${normalized} 不在手稿 \input/\include 文档图内（不允许向未引用文件插入）`,
        );
      }
      return normalized;
    }
    if (params.sectionId !== undefined) {
      const outline = await this.loadOutline(projectId);
      const section = outline?.sections.find((entry) => entry.id === params.sectionId);
      if (section === undefined) {
        throw new BusinessError("INVALID_REQUEST", `大纲中不存在章节 ${params.sectionId}`);
      }
      const relative = `sections/${section.file}`;
      if (!knownFiles.includes(relative)) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `章节文件 ${relative} 尚未生成（先写作该章节再插入图表）`,
        );
      }
      return relative;
    }
    throw new BusinessError("INVALID_REQUEST", "必须提供 sectionId 或 file 之一作为插入目标");
  }

  /** 轻量 outline 读取（避免依赖 ManuscriptService 的完整装配） */
  private async loadOutline(
    projectId: string,
  ): Promise<{ sections: Array<{ id: string; file: string }> } | null> {
    try {
      const raw = await readFile(
        join(this.projects.manuscriptDir(projectId), "outline.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw) as { sections?: Array<{ id?: string; file?: string }> };
      if (!Array.isArray(parsed.sections)) {
        return null;
      }
      return {
        sections: parsed.sections
          .filter((section) => typeof section.id === "string" && typeof section.file === "string")
          .map((section) => ({ id: section.id as string, file: section.file as string })),
      };
    } catch {
      return null;
    }
  }
}

/** 已有论文类项目（返修主链路 + 快速评审）：append 受限 */
export function isExistingPaperKind(project: ProjectMetadata): boolean {
  return (
    project.workflowKind === "existing_paper_improvement" ||
    project.workflowKind === "existing_paper_review"
  );
}
