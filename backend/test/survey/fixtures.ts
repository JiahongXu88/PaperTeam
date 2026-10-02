/**
 * M11.1.1 Survey Matrix 测试共享 fixture：
 * 临时项目 + 真实 SourceStore/ChunkStore/RetrievalService/ChunkAccess/
 * EvidenceStore（.txt 全文走真实 chunk 管线懒加载）+ 可按 sourceId 脚本化
 * 的 researcher runtime（contextScope=research/survey-matrix）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import type { PdfAnalysis } from "../../src/sources/PdfAnalyzer.js";
import { ChunkStore } from "../../src/retrieval/ChunkStore.js";
import { RetrievalService } from "../../src/retrieval/RetrievalService.js";
import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { ChunkAccess } from "../../src/evidence/chunkAccess.js";
import { MatrixService } from "../../src/survey/MatrixService.js";
import type { AgentRuntime } from "../../src/runtime/types.js";

/** 固定时钟（updatedAt 确定性；entryId 本身不含时间成分） */
export const FIXED_NOW = () => new Date("2026-10-02T08:00:00.000Z");

/**
 * 脚本输入：prompt 解析出的当前文献 sourceId + prompt 中出现的全部 chunkId
 * （CHUNK: 标记；镜像真实模型「从检索段落标记里取锚点」的行为）。
 */
export interface SurveyScriptInput {
  sourceId: string;
  prompt: string;
  chunkIds: string[];
}

/** 脚本输出：JSON 字符串（合法输出）| { raw }（任意原始输出）| { fail }（任务失败） */
export type SurveyScriptResult = string | { raw: string } | { fail: true; error?: string };

export type SurveyScript = (input: SurveyScriptInput) => SurveyScriptResult;

export interface SurveyScriptedRuntime extends AgentRuntime {
  calls: Array<{ agentId: string; contextScope?: string; sourceId: string }>;
  setScript: (sourceId: string, script: SurveyScript) => void;
}

const SOURCE_ID_PATTERN = /^- sourceId: (S\d{2,})$/m;
const CHUNK_MARKER_PATTERN = /CHUNK:([A-Z]\d{2,}:[A-Za-z0-9_-]+:\d{1,6}:[0-9a-f]{10})/g;

/** 可按 sourceId 脚本化的 fake researcher runtime（只消费 research/survey-matrix） */
export function buildSurveyRuntime(
  scripts: Record<string, SurveyScript> = {},
): SurveyScriptedRuntime {
  const calls: SurveyScriptedRuntime["calls"] = [];
  const runtime: SurveyScriptedRuntime = {
    provider: "pi",
    calls,
    setScript(sourceId, script) {
      scripts[sourceId] = script;
    },
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "survey fixture",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    startAgent: async (input) => {
      const task = await runtime.runAgent(input);
      return {
        taskId: task.taskId,
        sessionKey: `agent:${input.agentId}:survey-fixture`,
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    runAgent: async (input) => {
      const sourceId = SOURCE_ID_PATTERN.exec(input.task)?.[1] ?? "?";
      calls.push({ agentId: input.agentId, contextScope: input.contextScope, sourceId });
      const chunkIds = [...input.task.matchAll(CHUNK_MARKER_PATTERN)].map((match) => match[1]!);
      const script = scripts[sourceId];
      const outcome = script !== undefined ? script({ sourceId, prompt: input.task, chunkIds }) : undefined;
      const now = new Date().toISOString();
      const base = {
        taskId: `survey-${sourceId}-${calls.length}`,
        agentId: input.agentId,
        createdAt: now,
        updatedAt: now,
      };
      if (outcome === undefined) {
        return { ...base, status: "completed" as const, output: defaultMatrixJson(chunkIds) };
      }
      if (typeof outcome === "string") {
        return { ...base, status: "completed" as const, output: outcome };
      }
      if ("fail" in outcome) {
        return { ...base, status: "failed" as const, error: outcome.error ?? "矩阵抽取任务失败（fixture）" };
      }
      return { ...base, status: "completed" as const, output: outcome.raw };
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    modelStatusSnapshot: async () => ({
      phase: "unknown" as const,
      providers: [],
      detail: "survey fixture",
    }),
    runtimeStats: () => ({ activeRuns: 0, managedSessions: 0 }),
    close: async () => {},
  };
  return runtime;
}

/** 缺省脚本输出（合法最小矩阵 JSON；chunkIds 可用时锚定 mainIdea） */
export function defaultMatrixJson(chunkIds: string[]): string {
  return JSON.stringify({
    researchProblem: "如何在不引入外观模型的情况下保持多目标跟踪的关联精度",
    methodFamily: "tracking_association",
    mainIdea: "利用检测置信度做两段式关联，低分检测框参与第二段匹配以减少漏检。",
    keyFindings: ["低分检测框的二次关联减少了轨迹断裂"],
    comparedMethods: ["SORT", "DeepSORT"],
    anchors: chunkIds.length > 0 ? [{ field: "mainIdea", chunkIds: [chunkIds[0]!] }] : [],
  });
}

/** 文本型全文条目用的最小合法分析产物（status=ok → available） */
export function fakeTextAnalysis(): PdfAnalysis {
  return {
    analyzer: "survey-fixture",
    status: "ok",
    pageCount: 5,
    imageCount: 0,
    extractedChars: 2048,
    extractionQuality: "good",
    headings: [],
    citationMarkers: 3,
    textPreview: "Multi-object tracking by associating every detection box...",
    analyzedAt: FIXED_NOW().toISOString(),
  };
}

export interface SurveyFixture {
  projects: ProjectStore;
  sources: SourceStore;
  retrieval: RetrievalService;
  chunkAccess: ChunkAccess;
  evidence: EvidenceStore;
  matrix: MatrixService;
  runtime: SurveyScriptedRuntime;
  projectId: string;
  root: string;
  cleanup: () => Promise<void>;
}

export interface FixturePaper {
  fileName: string;
  title: string;
  body: string;
  doi: string;
  year: number;
  authors: string[];
}

/** .txt 全文入库 + setAnalysis（available）→ fulltext 条目 */
export async function addFulltextPaper(
  sources: SourceStore,
  projectId: string,
  paper: FixturePaper,
): Promise<string> {
  const { source } = await sources.add(projectId, {
    fileName: paper.fileName,
    content: Buffer.from(paper.body, "utf8"),
    metadata: { title: paper.title, doi: paper.doi, year: paper.year, authors: paper.authors },
  });
  await sources.setAnalysis(projectId, source.sourceId, fakeTextAnalysis(), {
    ...(source.contentHash !== undefined ? { contentHash: source.contentHash } : {}),
  });
  return source.sourceId;
}

/** metadata-only 条目（带 abstract）→ abstract_only 条目 */
export async function addMetadataOnlyPaper(
  sources: SourceStore,
  projectId: string,
  paper: { title: string; doi: string; year: number; authors: string[]; abstract: string },
): Promise<string> {
  const source = await sources.addRecord(projectId, {
    sourceType: "doi",
    origin: "DOI_IMPORT",
    metadata: {
      title: paper.title,
      doi: paper.doi,
      year: paper.year,
      authors: paper.authors,
      abstract: paper.abstract,
    },
  });
  return source.sourceId;
}

export async function newSurveyFixture(
  scripts: Record<string, SurveyScript> = {},
): Promise<SurveyFixture> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-survey-"));
  const projects = new ProjectStore({ root });
  const project = await projects.create("Survey Matrix 测试");
  const projectId = project.id;

  const sources = new SourceStore(projects);
  const chunkStore = new ChunkStore(projects);
  const retrieval = new RetrievalService({
    projects,
    sources,
    chunker: new SourceChunker({ log: () => {} }),
    chunkStore,
    log: () => {},
  });
  const chunkAccess = new ChunkAccess({ projects, chunkStore, sources });
  const evidence = new EvidenceStore(projects);
  const runtime = buildSurveyRuntime(scripts);
  const matrix = new MatrixService({
    projects,
    sources,
    retrieval,
    chunkAccess,
    runtime,
    researcherAgentId: "researcher",
    evidence,
    now: FIXED_NOW,
    log: () => {},
  });

  return {
    projects,
    sources,
    retrieval,
    chunkAccess,
    evidence,
    matrix,
    runtime,
    projectId,
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** fixture 文献正文（≥ 数百字符，含标题词保证 lexical 检索可命中） */
export function paperBody(title: string, ...paragraphs: string[]): string {
  return [
    `${title}. This paper studies multi-object tracking and detection association.`,
    "",
    ...paragraphs.flatMap((paragraph) => [paragraph, ""]),
    `Conclusion: the proposed association approach in ${title} improves identity preservation.`,
  ].join("\n");
}

/** 5 篇固定文献（4 fulltext + 1 abstract-only；覆盖 ≥3 taxonomy family） */
export const FIXTURE_PAPERS: FixturePaper[] = [
  {
    fileName: "bytetrack.txt",
    title: "ByteTrack Multi-Object Tracking by Associating Every Detection Box",
    doi: "10.1000/bytetrack",
    year: 2022,
    authors: ["Zhang, Yifu"],
    body: paperBody(
      "ByteTrack",
      "We associate every detection box including low-score ones in two stages, keeping high-confidence tracks first and recovering missed detections second.",
      "Experiments on MOT17 show identity switches drop without any appearance model, using only IoU-based cascaded matching with detection confidence.",
    ),
  },
  {
    fileName: "deepsort.txt",
    title: "Deep SORT Appearance Embedding for Online Multi-Object Tracking",
    doi: "10.1000/deepsort",
    year: 2017,
    authors: ["Wojke, Nicolai"],
    body: paperBody(
      "DeepSORT",
      "We extend SORT with a learned appearance embedding and a cascade matching stage, combining motion prediction with ReID cosine distance.",
      "The appearance feature is trained offline on a person re-identification corpus; association cost fuses Kalman prediction and embedding distance.",
    ),
  },
  {
    fileName: "osnet.txt",
    title: "OSNet Omnidirectional Scale-Invariant Person Re-Identification",
    doi: "10.1000/osnet",
    year: 2019,
    authors: ["Zhou, Kaiyang"],
    body: paperBody(
      "OSNet",
      "We propose an omni-scale feature learning network for person re-identification with unified aggregation gates.",
      "Benchmark evaluation on Market-1501 and DukeMTMC shows the learned embeddings transfer across camera views with small parameter count.",
    ),
  },
  {
    fileName: "motchallenge.txt",
    title: "MOTChallenge A Benchmark for Multi-Object Tracking Evaluation",
    doi: "10.1000/motchallenge",
    year: 2016,
    authors: ["Milan, Anton"],
    body: paperBody(
      "MOTChallenge",
      "We present a standardized benchmark protocol with public ground truth, evaluation metrics including MOTA, MOTP and IDF1, and a leaderboard.",
      "The evaluation protocol clarifies how identity switches and fragmentation are counted so that trackers are comparable.",
    ),
  },
];

export const FIXTURE_ABSTRACT_ONLY = {
  title: "A Survey of Multi-Object Tracking Methods",
  doi: "10.1000/motsurvey",
  year: 2024,
  authors: ["Chen, Wei"],
  abstract:
    "This survey reviews multi-object tracking methods, covering tracking-by-detection, joint detection and embedding, and association strategies, and discusses open challenges in crowded scenes and real-time deployment.",
};
