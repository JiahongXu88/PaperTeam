/**
 * M10.2 vision 测试共用 fixture：项目 / 文献库 / Evidence / 解析产物 /
 * Ingestion（fake parser 落真实图片资产）/ FigureAnalysisStore /
 * VisionAnalysisService / RetrievalService 全链装配。
 *
 * 模型侧注入 FakeVisionModelRuntime（确定性、离线、零网络）；parser 侧
 * stubParser 与 ingestion 测试同型，但会把 PNG 资产真实写入 figures 目录
 * （Vision 分析要读资产字节做 freshness / 输入）。
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore, type SourceItem } from "../../src/sources/SourceStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { ParsedDocumentStore } from "../../src/ingestion/ParsedDocumentStore.js";
import { IngestionService } from "../../src/ingestion/IngestionService.js";
import type {
  DocumentExtraction,
  DocumentParser,
  DocumentParseOptions,
  ParsedBlock,
} from "../../src/ingestion/types.js";
import { FigureAnalysisStore } from "../../src/vision/FigureAnalysisStore.js";
import { VisionAnalysisService } from "../../src/vision/VisionAnalysisService.js";
import type {
  VisionModelCandidates,
  VisionModelRuntime,
} from "../../src/vision/types.js";
import { ChunkStore } from "../../src/retrieval/ChunkStore.js";
import { RetrievalService } from "../../src/retrieval/RetrievalService.js";
import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import { makePng } from "../ingestion/binaryFixtures.js";

// ---- fake 模型运行时 ----

/** 单次调用的脚本化响应 */
export type FakeVisionResponse =
  | { kind: "json"; output: Record<string, unknown>; usage?: { input?: number; output?: number; totalTokens?: number; costTotal?: number } }
  | { kind: "raw"; text: string } // 非 JSON 文本（结构化失败场景）
  | { kind: "throw"; message: string } // 调用抛异常（网络 / 超时类）
  | { kind: "stopError"; errorMessage: string } // stopReason=error
  | { kind: "empty" }; // 空内容

export interface FakeVisionCall {
  callIndex: number;
  model: unknown;
  systemPrompt?: string;
  promptText: string;
  image: { data: string; mimeType: string } | null;
  isRepair: boolean;
}

export class FakeVisionModelRuntime implements VisionModelRuntime {
  readonly calls: FakeVisionCall[] = [];
  /** provider/model-id → input 能力声明（缺省全部 ["text","image"]） */
  readonly catalogInputs = new Map<string, string[]>();
  readonly authProviders = new Set<string>(["prov-a", "prov-b"]);

  constructor(
    private readonly script: (call: FakeVisionCall) => FakeVisionResponse = () => ({
      kind: "json",
      output: validVisionOutput(),
    }),
  ) {}

  getModel(providerId: string, modelId: string): { input?: readonly string[] } | undefined {
    const inputs = this.catalogInputs.get(`${providerId}/${modelId}`) ?? ["text", "image"];
    return { input: inputs };
  }

  hasConfiguredAuth(providerId: string): boolean {
    return this.authProviders.has(providerId);
  }

  async completeSimple(
    model: unknown,
    context: { systemPrompt?: string; messages: unknown[] },
    _options?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
    stopReason: string;
    errorMessage?: string;
  }> {
    void _options;
    const first = context.messages[0] as { content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }> } | undefined;
    const parts = first?.content ?? [];
    const textPart = parts.find((part) => part.type === "text")?.text ?? "";
    const imagePart = parts.find((part) => part.type === "image");
    const call: FakeVisionCall = {
      callIndex: this.calls.length,
      model,
      systemPrompt: context.systemPrompt,
      promptText: textPart,
      image:
        imagePart !== undefined && typeof imagePart.data === "string"
          ? { data: imagePart.data, mimeType: imagePart.mimeType ?? "" }
          : null,
      isRepair: textPart.includes("你上一轮输出未通过 schema 校验"),
    };
    this.calls.push(call);
    const response = this.script(call);
    switch (response.kind) {
      case "json":
        return {
          content: [{ type: "text", text: JSON.stringify(response.output) }],
          ...(response.usage !== undefined
            ? {
                usage: {
                  ...(response.usage.input !== undefined ? { input: response.usage.input } : {}),
                  ...(response.usage.output !== undefined ? { output: response.usage.output } : {}),
                  ...(response.usage.totalTokens !== undefined ? { totalTokens: response.usage.totalTokens } : {}),
                  ...(response.usage.costTotal !== undefined ? { cost: { total: response.usage.costTotal } } : {}),
                },
              }
            : {}),
          stopReason: "stop",
        };
      case "raw":
        return { content: [{ type: "text", text: response.text }], stopReason: "stop" };
      case "throw":
        throw new Error(response.message);
      case "stopError":
        return { content: [], stopReason: "error", errorMessage: response.errorMessage };
      case "empty":
        return { content: [], stopReason: "stop" };
    }
  }
}

/** 合法的最小模型输出（多数测试的默认响应） */
export function validVisionOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: "折线图：MOTA 与 IDF1 随 threshold 变化；蓝线在中段达到峰值。",
    figureType: "chart",
    observations: ["横轴为 threshold（0.1 至 0.7）", "蓝线峰值约 82.4，高于红线峰值"],
    candidateFacts: [
      { claim: "MOTA 在 threshold=0.5 时达到 82.4", value: "82.4", confidence: "high" },
      { claim: "IDF1 峰值约为 79.1", value: "79.1", confidence: "medium" },
    ],
    warnings: [],
    confidence: "high",
    ...overrides,
  };
}

// ---- 全链 fixture ----

export interface VisionFixture {
  projects: ProjectStore;
  sources: SourceStore;
  evidence: EvidenceStore;
  documents: ParsedDocumentStore;
  ingestion: IngestionService;
  analyses: FigureAnalysisStore;
  vision: VisionAnalysisService;
  retrieval: RetrievalService;
  model: FakeVisionModelRuntime;
  projectId: string;
  root: string;
  addFileSource: (fileName: string, content: Buffer | string) => Promise<SourceItem>;
  /** 直接替换某 source 的解析产物 + 落图片资产（绕过 parser 精确控制块形状） */
  seedDocument: (sourceId: string, blocks: ParsedBlock[], assets: Record<string, Buffer>) => Promise<void>;
}

const tempRoots: string[] = [];

export async function newVisionFixture(options: {
  modelScript?: (call: FakeVisionCall) => FakeVisionResponse;
  modelCandidates?: () => VisionModelCandidates;
  requestTimeoutMs?: number;
} = {}): Promise<VisionFixture> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-vision-"));
  tempRoots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("Vision 测试");
  const projectId = project.id;
  const sources = new SourceStore(projects);
  const evidence = new EvidenceStore(projects);
  const documents = new ParsedDocumentStore(projects);
  const model = new FakeVisionModelRuntime(options.modelScript);
  // 简单 stub parser：图片类文件登记为 figure；其余文本（多数测试直接
  // seedDocument 控制块形状）
  const parser: DocumentParser = {
    id: "vision-stub",
    async parseFile(path: string, parseOptions?: DocumentParseOptions): Promise<DocumentExtraction> {
      const fileName = path.split(/[\\/]/).pop() ?? "asset.png";
      const bytes = makePng(40, 30);
      if (parseOptions?.figuresDir !== undefined && /\.png$/.test(fileName)) {
        await mkdir(parseOptions.figuresDir, { recursive: true });
        await writeFile(join(parseOptions.figuresDir, "img-001.png"), bytes);
      }
      return {
        parser: { id: "vision-stub" },
        mode: "structured",
        quality: "full",
        mimeType: "image/png",
        blocks: [
          {
            blockId: "B0001",
            type: "figure",
            provenance: { fileName },
            assetName: "img-001.png",
            width: 40,
            height: 30,
          },
        ],
        notes: [],
      };
    },
  };
  const ingestion = new IngestionService({
    projects,
    sources,
    documents,
    structuredParser: parser,
    evidence,
    log: () => {},
  });
  const analyses = new FigureAnalysisStore(projects);
  const vision = new VisionAnalysisService({
    projects,
    sources,
    documents,
    analyses,
    ingestion,
    evidence,
    modelRuntime: model,
    modelCandidates:
      options.modelCandidates ?? (() => ({ visionModel: "prov-a/model-v" })),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    log: () => {},
  });
  // 检索层与 serviceStack 同型接线（documentProvider + figureAnalysisProvider）
  const chunkStore = new ChunkStore(projects);
  const retrieval = new RetrievalService({
    projects,
    sources,
    chunker: new SourceChunker({
      documentProvider: (pid, item) => ingestion.getDocument(pid, item.sourceId),
      figureAnalysisProvider: async (pid, item) => {
        const stored = await analyses.load(pid, item.sourceId);
        if (stored === null) {
          return null;
        }
        return stored.analyses.filter(
          (entry) =>
            entry.status === "completed" &&
            entry.sourceContentHash !== undefined &&
            entry.sourceContentHash === item.contentHash,
        );
      },
      log: () => {},
    }),
    chunkStore,
    log: () => {},
  });
  vision.attachAnalyzedHook(async (pid, sourceId) => {
    await retrieval.rebuildSource(pid, sourceId);
  });
  const addFileSource: VisionFixture["addFileSource"] = async (fileName, content) => {
    const { source } = await sources.add(projectId, {
      fileName,
      content: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"),
    });
    return source;
  };
  const seedDocument: VisionFixture["seedDocument"] = async (sourceId, blocks, assets) => {
    const item = await sources.getRequired(projectId, sourceId);
    const figuresDir = documents.figuresDir(projectId, sourceId);
    await mkdir(figuresDir, { recursive: true });
    for (const [name, bytes] of Object.entries(assets)) {
      await writeFile(join(figuresDir, name), bytes);
    }
    const counts: Record<string, number> = { text: 0, table: 0, figure: 0, formula: 0, structured_record: 0, code: 0, output: 0 };
    for (const block of blocks) {
      const key = block.type as string;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    await documents.save(projectId, {
      schemaVersion: 1,
      sourceId,
      fileName: item.originalName ?? item.fileName ?? sourceId,
      storedFileName: item.fileName ?? "",
      kind: "pdf",
      mimeType: "application/pdf",
      parser: { id: "vision-stub" },
      parseMode: "structured",
      status: "ok",
      blocks,
      counts: counts as never,
      notes: [],
      contentHash: item.contentHash ?? "",
      parsedAt: new Date().toISOString(),
    });
  };
  return {
    projects,
    sources,
    evidence,
    documents,
    ingestion,
    analyses,
    vision,
    retrieval,
    model,
    projectId,
    root,
    addFileSource,
    seedDocument,
  };
}

export async function cleanupVisionFixtures(): Promise<void> {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
}

/** PDF figure 块（带 caption / page / bbox / 资产） */
export function pdfFigureBlock(overrides: Partial<Extract<ParsedBlock, { type: "figure" }>> = {}): Extract<ParsedBlock, { type: "figure" }> {
  return {
    blockId: "B0005",
    type: "figure",
    provenance: {
      fileName: "paper.pdf",
      page: 3,
      bbox: { x0: 5, y0: 5, x1: 50, y1: 50 },
      parserBlockId: "/pictures/0",
    },
    caption: "Figure 1: Impact of threshold on MOTA and IDF1.",
    assetName: "fig-001.png",
    ...overrides,
  };
}

/** Notebook 图片输出 figure 块 */
export function notebookFigureBlock(overrides: Partial<Extract<ParsedBlock, { type: "figure" }>> = {}): Extract<ParsedBlock, { type: "figure" }> {
  return {
    blockId: "B0007",
    type: "figure",
    provenance: { fileName: "analysis.ipynb", cellIndex: 2, cellId: "cell-2", outputIndex: 0 },
    assetName: "cell-2-output-0.png",
    width: 640,
    height: 480,
    ...overrides,
  };
}

/** 文本块（context 构造用） */
export function textBlock(blockId: string, text: string, page = 3): Extract<ParsedBlock, { type: "text" }> {
  return { blockId, type: "text", provenance: { fileName: "paper.pdf", page }, text, textKind: "paragraph" };
}
