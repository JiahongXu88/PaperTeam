/**
 * M6.4 retrieval 测试共用 fixture：项目 / 文献库 / RetrievalService 装配
 * （text / markdown source 为主——确定性、离线、无需 Python；PDF 路径由
 * 注入 fake PdfParser 或真实 fixture PDF 的专项测试覆盖）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore, type SourceItem } from "../../src/sources/SourceStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { ChunkStore } from "../../src/retrieval/ChunkStore.js";
import { RetrievalService } from "../../src/retrieval/RetrievalService.js";
import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import type { ChunkBuildOptions, ResolvedSection } from "../../src/retrieval/chunking.js";
import { buildSourceChunks } from "../../src/retrieval/chunking.js";
import type { EmbeddingProvider, SourceChunk } from "../../src/retrieval/types.js";
import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import type { PdfToolchainStatus } from "../../src/paper/pdfToolchain.js";

export interface RetrievalFixture {
  projects: ProjectStore;
  sources: SourceStore;
  evidence: EvidenceStore;
  chunkStore: ChunkStore;
  retrieval: RetrievalService;
  projectId: string;
  root: string;
  addTextSource: (fileName: string, content: string, metadata?: { title?: string; year?: number; sourceRole?: "evidence" | "reference" | "both" }) => Promise<SourceItem>;
}

const tempRoots: string[] = [];
export function registerTempRoot(root: string): void {
  tempRoots.push(root);
}
export async function cleanupTempRoots(): Promise<void> {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function newRetrievalFixture(options: {
  embedding?: EmbeddingProvider;
  parser?: PdfParser;
  chunkOptions?: Partial<ChunkBuildOptions>;
} = {}): Promise<RetrievalFixture> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-rag-"));
  registerTempRoot(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("检索测试");
  const sources = new SourceStore(projects);
  const chunkStore = new ChunkStore(projects);
  const chunkOptions: ChunkBuildOptions = {
    targetTokens: options.chunkOptions?.targetTokens ?? 400,
    maxTokens: options.chunkOptions?.maxTokens ?? 600,
    overlapTokens: options.chunkOptions?.overlapTokens ?? 60,
  };
  const retrieval = new RetrievalService({
    projects,
    sources,
    chunker: new SourceChunker({ parser: options.parser, chunkOptions }),
    chunkStore,
    ...(options.embedding !== undefined ? { embedding: options.embedding } : {}),
    log: () => {},
  });
  const addTextSource: RetrievalFixture["addTextSource"] = async (fileName, content, metadata = {}) => {
    const { source } = await sources.add(project.id, {
      fileName,
      content: Buffer.from(content, "utf8"),
      ...(metadata.sourceRole !== undefined ? { sourceRole: metadata.sourceRole } : {}),
      metadata: {
        ...(metadata.title !== undefined ? { title: metadata.title } : {}),
        ...(metadata.year !== undefined ? { year: metadata.year } : {}),
      },
    });
    return source;
  };
  return {
    projects,
    sources,
    evidence: new EvidenceStore(projects),
    chunkStore,
    retrieval,
    projectId: project.id,
    root,
    addTextSource,
  };
}

/** fake PdfParser：注入式 RawPdfExtraction（确定性，无 Python） */
export class FakePdfParser implements PdfParser {
  readonly id = "fake";
  constructor(
    private readonly extractions: Record<string, RawPdfExtraction>,
    private readonly failFor: Record<string, "unavailable" | "failed"> = {},
  ) {}
  async parseFile(absolutePath: string): Promise<RawPdfExtraction> {
    const fileName = absolutePath.split(/[\\/]/).pop() ?? "";
    // SourceStore 存储名是 "<sourceId>-<原名>"，两种键都查
    const key =
      Object.keys(this.extractions).find((candidate) => fileName === candidate) ??
      Object.keys(this.extractions).find((candidate) => fileName.endsWith(candidate) || candidate.endsWith(fileName)) ??
      fileName;
    const failure = this.failFor[key];
    if (failure === "unavailable") {
      const { PdfParserUnavailableError } = await import("../../src/errors.js");
      throw new PdfParserUnavailableError("fake: 工具链不可用");
    }
    if (failure === "failed") {
      const { PdfParseFailedError } = await import("../../src/errors.js");
      throw new PdfParseFailedError("fake: 单文件解析失败");
    }
    const extraction = this.extractions[key];
    if (extraction === undefined) {
      const { PdfParseFailedError } = await import("../../src/errors.js");
      throw new PdfParseFailedError(`fake: 未注册的 PDF ${fileName}`);
    }
    return extraction;
  }
  async checkAvailability(): Promise<PdfToolchainStatus> {
    return {
      available: true,
      command: "fake",
      args: [],
      pythonVersion: "fake",
      pymupdfVersion: "fake",
    };
  }
}

/** 快速构造 RawPdfExtraction（TOC + blocks） */
export function fakeExtraction(params: {
  pageCount: number;
  toc?: Array<[number, string, number]>;
  blocks: Array<{ page: number; text: string }>;
}): RawPdfExtraction {
  return {
    ok: true,
    parser: { id: "fake" },
    pageCount: params.pageCount,
    title: "",
    abstract: "",
    toc: params.toc ?? [],
    blocks: params.blocks,
    totalChars: params.blocks.reduce((sum, block) => sum + block.text.length, 0),
    notes: [],
  };
}

/** 直接构造 chunks（packer / benchmark 单元层用，不经 IO） */
export function makeChunks(
  params: {
    projectId: string;
    sourceId: string;
  },
  sections: ResolvedSection[],
  options: ChunkBuildOptions = { targetTokens: 400, maxTokens: 600, overlapTokens: 60 },
): SourceChunk[] {
  return buildSourceChunks({ ...params, sections, options, now: () => new Date("2026-09-17T00:00:00Z") }).chunks;
}

/** 手工构造的最小可解析 PDF（builtin 文本层回退路径用；同 literatureLibrary.test） */
export function minimalPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts: string[] = ["%PDF-1.4"];
  let offset = parts[0]!.length + 1;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(object);
    offset += object.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
  return Buffer.from(parts.join("\n"), "latin1");
}
