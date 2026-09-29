/**
 * M10.1.1 检索管线集成测试：新资产类型 → ParsedDocument → chunk → 搜索。
 *
 * 验证的不只是 parser 能跑：README 事实、JSON value、YAML 配置、源码参数、
 * Notebook cell / 输出都能进入 chunk/search 并携带 provenance（行号 /
 * 路径 / cell），CSV/XLSX/PDF 既有路径不受影响。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { ParsedDocumentStore } from "../../src/ingestion/ParsedDocumentStore.js";
import { IngestionService } from "../../src/ingestion/IngestionService.js";
import { ChunkStore } from "../../src/retrieval/ChunkStore.js";
import { RetrievalService } from "../../src/retrieval/RetrievalService.js";
import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import { stubParser } from "./fixtures.js";

interface Stack {
  projects: ProjectStore;
  sources: SourceStore;
  ingestion: IngestionService;
  retrieval: RetrievalService;
  projectId: string;
  addSource: (fileName: string, content: Buffer | string) => Promise<string>;
}

const roots: string[] = [];

async function newStack(): Promise<Stack> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-m1011-rag-"));
  roots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("M10.1.1 检索测试");
  const sources = new SourceStore(projects);
  const evidence = new EvidenceStore(projects);
  const documents = new ParsedDocumentStore(projects);
  const ingestion = new IngestionService({
    projects,
    sources,
    documents,
    structuredParser: stubParser("unavailable-stub", "unavailable"),
    evidence,
    log: () => {},
  });
  const chunkStore = new ChunkStore(projects);
  const retrieval = new RetrievalService({
    projects,
    sources,
    chunker: new SourceChunker({
      documentProvider: (projectId, item) => ingestion.getDocument(projectId, item.sourceId),
      log: () => {},
    }),
    chunkStore,
    log: () => {},
  });
  const addSource: Stack["addSource"] = async (fileName, content) => {
    const { source } = await sources.add(project.id, {
      fileName,
      content: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"),
    });
    // 上传即内联解析 + 钩子重建（与生产上传链路同口径）
    await ingestion.ingest(project.id, source.sourceId);
    return source.sourceId;
  };
  return { projects, sources, ingestion, retrieval, projectId: project.id, addSource };
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const TRAIN_PY = [
  "# MOT17 training script",
  "import torch",
  "",
  "def main():",
  "    learning_rate = 0.001",
  "    epochs = 100",
  "    batch_size = 8",
  "    backbone = 'resnet50'",
  "    print('training starts')",
  "",
].join("\n");

const NOTEBOOK = JSON.stringify({
  cells: [
    { cell_type: "markdown", id: "intro", source: ["# Result Analysis\n", "训练完成后分析 MOT17 结果。\n"] },
    {
      cell_type: "code",
      execution_count: 5,
      source: "import pandas as pd\nprint('MOTA = 82.4')",
      outputs: [{ output_type: "stream", name: "stdout", text: "MOTA = 82.4\n" }],
    },
  ],
  metadata: { kernelspec: { language: "python" } },
  nbformat: 4,
});

describe("M10.1.1 检索管线：新资产 → chunk → search", () => {
  it("README 事实可检索（markdown section 进 chunk 标题）", async () => {
    const s = await newStack();
    await s.addSource(
      "README.md",
      "# MOT17 Tracking\n\n我们在 MOT17 数据集上复现跟踪实验，使用 ByteTrack 基线。\n\n## Setup\n\n依赖 PyTorch 2.x。\n",
    );
    const result = await s.retrieval.search(s.projectId, "MOT17 复现 跟踪");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.chunk.text).toContain("MOT17");
    expect(result.results[0]!.chunk.sectionTitle).toBe("MOT17 Tracking");
    expect(result.results[0]!.chunk.lineStart).toBeDefined();
  });

  it("config.json 的 value 可检索（[$.path] 标记进 chunk 文本）", async () => {
    const s = await newStack();
    await s.addSource("config.json", JSON.stringify({ dataset: "MOT17", training: { epochs: 100, batch_size: 8 } }));
    const result = await s.retrieval.search(s.projectId, "epochs 100");
    expect(result.results.length).toBeGreaterThan(0);
    const hit = result.results.find((r) => r.chunk.text.includes("epochs"));
    expect(hit).toBeDefined();
    expect(hit!.chunk.text).toContain("$.training.epochs=100");
    expect(hit!.source.sourceType).toBe("json");
  });

  it("experiment.yaml 的配置可检索（路径 + 行号标记）", async () => {
    const s = await newStack();
    await s.addSource("experiment.yaml", "dataset: MOT17\ntraining:\n  epochs: 100\n  batch_size: 8\n");
    const result = await s.retrieval.search(s.projectId, "batch_size");
    const hit = result.results.find((r) => r.chunk.text.includes("batch_size"));
    expect(hit).toBeDefined();
    expect(hit!.chunk.text).toContain("$.training.batch_size=8");
    expect(hit!.chunk.text).toContain("line 4");
  });

  it("train.py 的参数可检索；chunk 带行定位（learning_rate 在第 5 行）", async () => {
    const s = await newStack();
    await s.addSource("train.py", TRAIN_PY);
    const result = await s.retrieval.search(s.projectId, "learning_rate");
    expect(result.results.length).toBeGreaterThan(0);
    const hit = result.results[0]!;
    expect(hit.chunk.text).toContain("learning_rate = 0.001");
    // 行定位：learning_rate 物理行 5 → chunk 覆盖范围包含 5
    expect(hit.chunk.lineStart).toBeLessThanOrEqual(5);
    expect(hit.chunk.lineEnd).toBeGreaterThanOrEqual(5);
    // 源码行完整性：缩进保留（chunk 未做空白压扁）
    expect(hit.chunk.text).toContain("    learning_rate = 0.001");
  });

  it("Notebook markdown / code / 输出都可检索（Cell 分节标题）", async () => {
    const s = await newStack();
    await s.addSource("analysis.ipynb", NOTEBOOK);
    const md = await s.retrieval.search(s.projectId, "结果分析");
    expect(md.results.some((r) => r.chunk.sectionTitle.startsWith("Cell 0"))).toBe(true);
    const output = await s.retrieval.search(s.projectId, "MOTA = 82.4");
    const hit = output.results.find((r) => r.chunk.text.includes("MOTA = 82.4"));
    expect(hit).toBeDefined();
    // stdout 输出块挂在 code cell 节
    expect(hit!.chunk.sectionTitle.startsWith("Cell 1")).toBe(true);
    const code = await s.retrieval.search(s.projectId, "import pandas");
    expect(code.results.some((r) => r.chunk.text.includes("import pandas"))).toBe(true);
  });

  it("跨格式同库检索：epochs 同时命中 JSON 与 YAML 与源码", async () => {
    const s = await newStack();
    await s.addSource("config.json", JSON.stringify({ training: { epochs: 100 } }));
    await s.addSource("experiment.yaml", "training:\n  epochs: 100\n");
    await s.addSource("train.py", TRAIN_PY);
    const result = await s.retrieval.search(s.projectId, "epochs", { topK: 20 });
    const fileNames = new Set(result.results.map((r) => r.source.sourceId));
    expect(fileNames.size).toBeGreaterThanOrEqual(3);
  });

  it("CSV 既有路径回归（[row N] 标记不受影响）", async () => {
    const s = await newStack();
    await s.addSource("results.csv", "Method,MOTA,IDF1\nOurs,82.4,79.1\n");
    const result = await s.retrieval.search(s.projectId, "MOTA");
    const hit = result.results.find((r) => r.chunk.text.includes("MOTA"));
    expect(hit).toBeDefined();
    expect(hit!.chunk.text).toContain("[row 2]");
    expect(hit!.chunk.text).toContain("MOTA=82.4");
  });

  it("TXT 整档文本可检索（行 provenance 保留）", async () => {
    const s = await newStack();
    await s.addSource("notes.txt", "实验日志\n\nbackbone 使用 resnet50，输入分辨率 1088x608。\n");
    const result = await s.retrieval.search(s.projectId, "resnet50");
    expect(result.results[0]!.chunk.text).toContain("resnet50");
    // resnet50 在物理行 3；两个小段合并进同一 chunk → 范围覆盖行 3
    expect(result.results[0]!.chunk.lineStart).toBeLessThanOrEqual(3);
    expect(result.results[0]!.chunk.lineEnd).toBeGreaterThanOrEqual(3);
  });
});
