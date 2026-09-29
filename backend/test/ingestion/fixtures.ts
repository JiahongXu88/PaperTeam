/**
 * M10.1 ingestion 测试共用 fixture：项目 / 文献库 / Evidence / 文档产物 /
 * IngestionService 装配（注入式 fake DocumentParser——确定性、离线、无 Python）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore, type SourceItem } from "../../src/sources/SourceStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { ParsedDocumentStore } from "../../src/ingestion/ParsedDocumentStore.js";
import { IngestionService } from "../../src/ingestion/IngestionService.js";
import {
  DocumentParseFailedError,
  DocumentParserUnavailableError,
} from "../../src/errors.js";
import type {
  DocumentExtraction,
  DocumentParser,
  DocumentParseOptions,
} from "../../src/ingestion/types.js";

export interface IngestionFixture {
  projects: ProjectStore;
  sources: SourceStore;
  evidence: EvidenceStore;
  documents: ParsedDocumentStore;
  ingestion: IngestionService;
  projectId: string;
  root: string;
  addFileSource: (fileName: string, content: Buffer | string) => Promise<SourceItem>;
}

const tempRoots: string[] = [];

export async function newIngestionFixture(options: {
  structuredParser?: DocumentParser;
  fallbackParser?: DocumentParser;
  now?: () => Date;
} = {}): Promise<IngestionFixture> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-ing-"));
  tempRoots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("Ingestion 测试");
  const sources = new SourceStore(projects);
  const evidence = new EvidenceStore(projects);
  const documents = new ParsedDocumentStore(projects);
  const ingestion = new IngestionService({
    projects,
    sources,
    documents,
    structuredParser:
      options.structuredParser ?? stubParser("structured-stub", "unavailable"),
    fallbackParser: options.fallbackParser,
    evidence,
    ...(options.now !== undefined ? { now: options.now } : {}),
    log: () => {},
  });
  const addFileSource: IngestionFixture["addFileSource"] = async (fileName, content) => {
    const { source } = await sources.add(project.id, {
      fileName,
      content: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"),
    });
    return source;
  };
  return { projects, sources, evidence, documents, ingestion, projectId: project.id, root, addFileSource };
}

export async function cleanupIngestionFixtures(): Promise<void> {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/** 行为脚本化的 fake DocumentParser（unavailable / failed / 按 path 返回 extraction） */
export function stubParser(
  id: string,
  behavior:
    | "unavailable"
    | "failed"
    | ((absolutePath: string) => DocumentExtraction),
): DocumentParser {
  return {
    id,
    async parseFile(_path: string, _options?: DocumentParseOptions): Promise<DocumentExtraction> {
      if (behavior === "unavailable") {
        throw new DocumentParserUnavailableError(`${id}：测试注入的不可用状态`);
      }
      if (behavior === "failed") {
        throw new DocumentParseFailedError(`${id}：测试注入的解析失败`);
      }
      return behavior(_path);
    },
  };
}

/** 结构化 PDF extraction（docling 形状的最小样例） */
export function fakeStructuredExtraction(overrides: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return {
    parser: { id: "docling", version: "test" },
    mode: "structured",
    quality: "full",
    pageCount: 3,
    blocks: [
      {
        blockId: "B0001",
        type: "text",
        provenance: { fileName: "paper.pdf", page: 1, parserBlockId: "/texts/0" },
        text: "Attention mechanisms let models focus on relevant tokens.",
        textKind: "paragraph",
      },
      {
        blockId: "B0002",
        type: "text",
        provenance: { fileName: "paper.pdf", page: 1, section: "Introduction" },
        text: "Introduction",
        textKind: "section_header",
      },
      {
        blockId: "B0003",
        type: "text",
        provenance: { fileName: "paper.pdf", page: 1, section: "Introduction" },
        text: "We study tracking in crowded scenes.",
        textKind: "paragraph",
      },
      {
        blockId: "B0004",
        type: "table",
        provenance: {
          fileName: "paper.pdf",
          page: 2,
          section: "Experiments",
          bbox: { x0: 10, y0: 20, x1: 80, y1: 40 },
          parserBlockId: "/tables/0",
        },
        caption: "Table 1: MOT17 results",
        headers: ["Method", "MOTA", "IDF1"],
        rows: [
          ["Ours", "82.4", "79.1"],
          ["Baseline", "78.2", "75.0"],
        ],
        rowCount: 2,
        columnCount: 3,
      },
      {
        blockId: "B0005",
        type: "figure",
        provenance: { fileName: "paper.pdf", page: 3, bbox: { x0: 5, y0: 5, x1: 50, y1: 50 } },
        caption: "Figure 1: Qualitative results",
        assetName: "fig-001.png",
      },
      {
        blockId: "B0006",
        type: "formula",
        provenance: { fileName: "paper.pdf", page: 2, section: "Method" },
        latex: "L = \\sum_i l_i",
      },
    ],
    notes: [],
    ...overrides,
  };
}
