/**
 * M14.1b 测试共用 fixture：离线服务栈（fake docling 表格块 + 静态文本层），
 * 不 spawn python。每个 PDF "文件" 的解析结果按文件名脚本化。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { IngestionService } from "../../src/ingestion/IngestionService.js";
import { ParsedDocumentStore } from "../../src/ingestion/ParsedDocumentStore.js";
import type { DocumentExtraction, ParsedBlock } from "../../src/ingestion/types.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { AuthorDecisionStore } from "../../src/thesis/AuthorDecisionStore.js";
import { ResearchInputRegistry } from "../../src/thesis/ResearchInputRegistry.js";
import { ResearchInputService } from "../../src/thesis/ResearchInputService.js";
import { ScientificFactStore } from "../../src/thesis/ScientificFactStore.js";
import type { ResearchInputType } from "../../src/thesis/researchInputTypes.js";
import { StaticTextLayerProvider } from "../../src/thesis/textLayer.js";
import type { TextLayerPage } from "../../src/thesis/sourceVerification.js";
import { stubParser } from "../ingestion/fixtures.js";

const tempRoots: string[] = [];

export async function cleanupThesisFixtures(): Promise<void> {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export interface FakePdf {
  /** 文件名（.pdf） */
  fileName: string;
  /** 文件字节（决定 contentHash；缺省用 fileName 派生） */
  bytes?: string;
  blocks: ParsedBlock[];
  pageCount?: number;
  /** PyMuPDF 文本层（按页） */
  textLayer?: TextLayerPage[];
  /** 解析行为（缺省 ok） */
  parse?: "ok" | "failed" | "unavailable";
  quality?: "full" | "partial";
}

export interface ThesisFixture {
  root: string;
  projectId: string;
  projects: ProjectStore;
  sources: SourceStore;
  documents: ParsedDocumentStore;
  evidence: EvidenceStore;
  ingestion: IngestionService;
  service: ResearchInputService;
  textLayers: Map<string, TextLayerPage[]>;
  /** 上传假 PDF → 登记为 ResearchInput（同步解析）；返回 inputId / sourceId */
  importPdf: (pdf: FakePdf, inputType: ResearchInputType, extra?: Record<string, unknown>) => Promise<{ inputId: string; sourceId: string; created: boolean }>;
  /** 用同一 root 重建服务（模拟进程重启） */
  reopen: () => ThesisFixture;
}

export async function newThesisFixture(options: { now?: () => Date } = {}): Promise<ThesisFixture> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-thesis-"));
  tempRoots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("M14.1b 测试");
  return buildFixture(root, project.id, options.now);
}

function buildFixture(root: string, projectId: string, now?: () => Date): ThesisFixture {
  const projects = new ProjectStore({ root });
  const sources = new SourceStore(projects);
  const evidence = new EvidenceStore(projects);
  const documents = new ParsedDocumentStore(projects);
  const scripts = new Map<string, FakePdf>();
  const textLayers = new Map<string, TextLayerPage[]>();
  const parser = stubParser("docling-fake", (absolutePath) => {
    const name = basename(absolutePath).replace(/^S\d{3}-/, "");
    const script = scripts.get(name);
    if (script === undefined) throw new Error(`fixture 未脚本化的 PDF：${name}`);
    if (script.parse === "failed") {
      throw new (class extends Error {})("fake parse failure");
    }
    const extraction: DocumentExtraction = {
      parser: { id: "docling", version: "fake" },
      mode: "structured",
      quality: script.quality ?? "full",
      pageCount: script.pageCount ?? Math.max(1, ...script.blocks.map((block) => block.provenance.page ?? 1)),
      blocks: script.blocks,
      notes: [],
    };
    return extraction;
  });
  const ingestion = new IngestionService({ projects, sources, documents, structuredParser: parser, evidence, log: () => {} });
  const nowFn = now ?? (() => new Date());
  const service = new ResearchInputService({
    registry: new ResearchInputRegistry(projects, sources, documents, evidence, { now: nowFn }),
    facts: new ScientificFactStore(projects, { now: nowFn }),
    decisions: new AuthorDecisionStore(projects, { now: nowFn }),
    documents,
    ingestion,
    textLayer: new StaticTextLayerProvider(textLayers),
    now: nowFn,
  });
  const fixture: ThesisFixture = {
    root,
    projectId,
    projects,
    sources,
    documents,
    evidence,
    ingestion,
    service,
    textLayers,
    importPdf: async (pdf, inputType, extra = {}) => {
      scripts.set(pdf.fileName, pdf);
      const { source } = await sources.add(projectId, {
        fileName: pdf.fileName,
        content: Buffer.from(`%PDF-1.5\n${pdf.bytes ?? pdf.fileName}`, "utf8"),
      });
      if (pdf.textLayer !== undefined) textLayers.set(source.sourceId, pdf.textLayer);
      const result = await service.register(projectId, { sourceId: source.sourceId, inputType, ...(extra as object) }, { ensureParsed: pdf.parse !== "unavailable" });
      return { inputId: result.input.inputId, sourceId: source.sourceId, created: result.created };
    },
    reopen: () => buildFixture(root, projectId, now),
  };
  return fixture;
}

/** 文本块 */
export function textBlock(blockId: string, page: number, text: string, textKind: "paragraph" | "caption" | "section_header" = "paragraph"): ParsedBlock {
  return { blockId, type: "text", provenance: { fileName: "x.pdf", page }, text, textKind };
}

/** 表格块（docling 形状） */
export function tableBlock(blockId: string, page: number, headers: string[], rows: string[][], caption?: string): ParsedBlock {
  return {
    blockId,
    type: "table",
    provenance: { fileName: "x.pdf", page, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
    ...(caption !== undefined ? { caption } : {}),
    headers,
    rows,
    rowCount: rows.length,
    columnCount: headers.length,
  };
}

/** 文本层页（把表格数值平铺成 token，模拟 PyMuPDF 页文本） */
export function textLayerPage(page: number, ...tokens: string[]): TextLayerPage {
  return { page, text: tokens.join("\n") };
}

/** 范登平案例形状的消融表（与 CVPR19 Table 5 / 学位论文 表4.3 相同结构，数值为真实观察值） */
export const ABLATION_PAPER = tableBlock("B0007", 8, ["Type", "Baseline", "S ↑", "max F ↑", "M↓"], [
  ["SSAA", "explicit", "0.724", "0.603", "0.092"],
  ["SSAA", "implicit", "0.684", "0.593", "0.103"],
  ["SSLSTM", "w/o SSLSTM", "0.667", "0.541", "0.132"],
]);
export const ABLATION_THESIS = tableBlock("B0042", 63, ["Type", "Baseline", "S ↑", "max F ↑", "M↓"], [
  ["SSAA", "explicit implicit", "0.699", "0.630", "0.098"],
  ["SSAA", "", "0.684", "0.593", "0.103"],
  ["SSLSTM", "w/o SSLSTM", "0.667", "0.541", "0.132"],
]);
