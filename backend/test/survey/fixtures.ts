/**
 * M11.1.1 / M11.1.2 Survey 测试共享 fixture：
 * 临时项目 + 真实 SourceStore/ChunkStore/RetrievalService/ChunkAccess/
 * EvidenceStore/EvidenceGroundingService（.txt 全文走真实 chunk 管线懒加载）
 * + 按 contextScope 分派的可脚本化 researcher runtime：
 *   research/survey-matrix（按 sourceId 脚本）/ research/survey-synthesis
 * （按 kind 脚本）/ citation/evidence/*（judge，缺省 supported）。
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
import { EvidenceCandidateStore } from "../../src/evidence/candidates.js";
import { ChunkAccess } from "../../src/evidence/chunkAccess.js";
import { EvidenceGroundingService } from "../../src/evidence/EvidenceGroundingService.js";
import { ScholarlyResolver } from "../../src/citation/scholarly.js";
import { MatrixService } from "../../src/survey/MatrixService.js";
import { SynthesisService } from "../../src/survey/SynthesisService.js";
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

/** synthesis 脚本输入：kind + 本 batch 可用的 entryIds 与各自的锚点 chunkIds */
export interface SynthesisScriptInput {
  kind: string;
  prompt: string;
  entryIds: string[];
  chunkIdsByEntry: Record<string, string[]>;
}

export type SynthesisScript = (input: SynthesisScriptInput) => SurveyScriptResult;

export interface SurveyScriptedRuntime extends AgentRuntime {
  calls: Array<{ agentId: string; contextScope?: string; sourceId: string }>;
  setScript: (sourceId: string, script: SurveyScript) => void;
  setSynthesisScript: (kind: string, script: SynthesisScript) => void;
  clearSynthesisScript: (kind: string) => void;
  setJudge: (script: (scope: string) => SurveyScriptResult) => void;
}

const SOURCE_ID_PATTERN = /^- sourceId: (S\d{2,})$/m;
const CHUNK_MARKER_PATTERN = /CHUNK:([A-Z]\d{2,}:[A-Za-z0-9_-]+:\d{1,6}:[0-9a-f]{10})/g;
const SYNTHESIS_KIND_PATTERN = /本批次 kind = "([a-z_]+)"/;
const SYNTHESIS_ENTRY_PATTERN = /^- (M-S\d+)｜/gm;
const SYNTHESIS_ANCHOR_PATTERN = /^- (M-S\d+)｜[^\n]*\n(?:  [^\n]*\n)*?  锚点chunk: ([^\n（]*)/gm;

/**
 * 可按 contextScope 分派的 fake runtime：
 * - research/survey-matrix：按 sourceId 脚本（M11.1.1 行为不变）
 * - research/survey-synthesis：按 kind 脚本（缺省 defaultSynthesisOutput）
 * - citation/evidence/*：judge（缺省 supported）
 */
export function buildSurveyRuntime(
  scripts: Record<string, SurveyScript> = {},
  synthesisScripts: Record<string, SynthesisScript> = {},
): SurveyScriptedRuntime {
  let judgeScript: ((scope: string) => SurveyScriptResult) | undefined;
  const calls: SurveyScriptedRuntime["calls"] = [];
  const runtime: SurveyScriptedRuntime = {
    provider: "pi",
    calls,
    setScript(sourceId, script) {
      scripts[sourceId] = script;
    },
    setSynthesisScript(kind, script) {
      synthesisScripts[kind] = script;
    },
    clearSynthesisScript(kind) {
      delete synthesisScripts[kind];
    },
    setJudge(script) {
      judgeScript = script;
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
      const scope = input.contextScope ?? "";
      const task = input.task;
      const now = new Date().toISOString();
      const mkBase = (key: string) => ({
        taskId: `survey-${key}-${calls.length}`,
        agentId: input.agentId,
        createdAt: now,
        updatedAt: now,
      });
      const toOutcome = (base: ReturnType<typeof mkBase>, outcome: SurveyScriptResult | undefined, fallback: string) => {
        if (outcome === undefined) {
          return { ...base, status: "completed" as const, output: fallback };
        }
        if (typeof outcome === "string") {
          return { ...base, status: "completed" as const, output: outcome };
        }
        if ("fail" in outcome) {
          return { ...base, status: "failed" as const, error: outcome.error ?? "fixture 任务失败" };
        }
        return { ...base, status: "completed" as const, output: outcome.raw };
      };

      // evidence judge（citation/evidence/<candidateId>）
      if (scope.startsWith("citation/evidence/")) {
        calls.push({ agentId: input.agentId, contextScope: scope, sourceId: "judge" });
        const outcome = judgeScript?.(scope);
        return toOutcome(
          mkBase("judge"),
          outcome,
          JSON.stringify({ verdict: "supported", reason: "原文段落明确支撑该论断（fixture 默认）" }),
        );
      }

      // synthesis（research/survey-synthesis）
      if (scope === "research/survey-synthesis") {
        const kind = SYNTHESIS_KIND_PATTERN.exec(task)?.[1] ?? "?";
        const entryIds = [...task.matchAll(SYNTHESIS_ENTRY_PATTERN)].map((match) => match[1]!);
        const chunkIdsByEntry: Record<string, string[]> = {};
        for (const match of task.matchAll(SYNTHESIS_ANCHOR_PATTERN)) {
          chunkIdsByEntry[match[1]!] = (match[2] ?? "")
            .trim()
            .split(/\s+/)
            .filter((id) => id !== "");
        }
        calls.push({ agentId: input.agentId, contextScope: scope, sourceId: kind });
        const script = synthesisScripts[kind];
        const outcome =
          script !== undefined
            ? script({ kind, prompt: task, entryIds, chunkIdsByEntry })
            : undefined;
        return toOutcome(mkBase(kind), outcome, defaultSynthesisOutput({ kind, prompt: task, entryIds, chunkIdsByEntry }));
      }

      // matrix（research/survey-matrix；M11.1.1 行为不变）
      const sourceId = SOURCE_ID_PATTERN.exec(task)?.[1] ?? "?";
      calls.push({ agentId: input.agentId, contextScope: scope, sourceId });
      const chunkIds = [...task.matchAll(CHUNK_MARKER_PATTERN)].map((match) => match[1]!);
      const script = scripts[sourceId];
      const outcome = script !== undefined ? script({ sourceId, prompt: task, chunkIds }) : undefined;
      return toOutcome(mkBase(sourceId), outcome, defaultMatrixJson(chunkIds));
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

/**
 * 缺省 synthesis 脚本输出：按 kind 返回引用 batch 内真实 entryIds / chunkIds
 * 的合法候选（trend/comparison/consensus/disagreement 各 1 条 + gap 1 条 +
 * future 2 条）。各测试用 setSynthesisScript 覆盖特定 kind 的行为。
 */
export function defaultSynthesisOutput(input: SynthesisScriptInput): string {
  const ids = input.entryIds;
  const anchored = ids.filter((id) => (input.chunkIdsByEntry[id] ?? []).length > 0);
  const proposal = (entryId: string, claim: string) => ({
    entryId,
    chunkId: input.chunkIdsByEntry[entryId]?.[0],
    evidenceClaim: claim,
  });
  switch (input.kind) {
    case "trend":
      return JSON.stringify({
        candidates: [
          {
            kind: "trend",
            claim: "2017 至 2023 年间，多目标跟踪的数据关联从依赖外观嵌入转向利用低分检测框的运动 / 联合关联",
            detail: { period: "2017-2023", direction: "外观嵌入依赖 → 低分检测框利用与联合关联" },
            entryIds: ids,
            evidenceProposals: anchored.slice(0, 2).map((id) => proposal(id, "该文献的方法参与上述演进")),
          },
        ],
      });
    case "comparison":
      return JSON.stringify({
        candidates: [
          {
            kind: "comparison",
            claim: "外观依赖维度的两类关联方法在锚定证据与适用场景上形成对照",
            detail: {
              dimension: "appearance dependency",
              sides: [
                { label: "外观依赖方法", entryIds: ids.slice(0, 1), basis: "依赖离线训练的外观嵌入做长时再关联" },
                { label: "无外观方法", entryIds: ids.slice(1), basis: "仅用运动 / IoU 与检测置信度完成关联" },
              ],
            },
            entryIds: ids,
            evidenceProposals: [],
          },
        ],
      });
    case "consensus":
      return JSON.stringify({
        candidates: [
          {
            kind: "consensus",
            claim: "多篇独立工作一致报告：让低分检测框参与二次关联能减少身份切换与轨迹断裂",
            detail: {},
            entryIds: ids.slice(0, 3),
            evidenceProposals: anchored.slice(0, 3).map((id) => proposal(id, "该文献报告低分检测框参与关联带来身份保持收益")),
          },
        ],
      });
    case "disagreement":
      return JSON.stringify({
        candidates: [
          {
            kind: "disagreement",
            claim: "外观模型对长时遮挡下的身份保持是否必要存在分歧",
            detail: {
              issue: "外观模型是否为长时身份保持所必需",
              sideA: { label: "外观不必要", entryIds: ids.slice(0, Math.max(1, Math.floor(ids.length / 2))) },
              sideB: { label: "外观必要", entryIds: ids.slice(Math.max(1, Math.floor(ids.length / 2))) },
            },
            entryIds: ids,
            evidenceProposals: anchored.slice(0, 2).map((id) => proposal(id, "该文献对上述分歧持明确立场")),
          },
        ],
      });
    case "research_gap":
      return JSON.stringify({
        candidates: [
          {
            kind: "research_gap",
            claim: "现有方法在低照度场景的外观退化与基准覆盖不足上存在明确研究空缺",
            detail: { trigger: "literature_limitation", basis: "多篇文献明确 limitation 聚合：外观特征在低照度下退化，且评测基准未覆盖该场景" },
            entryIds: ids,
            evidenceProposals: [],
          },
        ],
      });
    case "future_direction": {
      const citedEntries = anchored.slice(0, 2);
      return JSON.stringify({
        candidates: [
          ...(citedEntries.length > 0
            ? [
                {
                  kind: "future_direction",
                  claim: "有文献明确提出：把评测基准扩展到拥挤与低照度场景是公开的未来工作",
                  detail: { origin: "cited_future_work" },
                  entryIds: citedEntries.map((id) => id),
                  evidenceProposals: citedEntries.map((id) =>
                    proposal(id, "该文献明确提出把基准扩展到拥挤与低照度场景的 future work"),
                  ),
                },
              ]
            : []),
          {
            kind: "future_direction",
            claim: "综合趋势与空缺推断：低照度 / 拥挤场景下的无外观关联是值得投入的方向",
            detail: { origin: "inferred" },
            entryIds: ids.slice(0, 2),
            evidenceProposals: [],
          },
        ],
      });
    }
    default:
      return JSON.stringify({ candidates: [] });
  }
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
  evidenceGrounding: EvidenceGroundingService;
  matrix: MatrixService;
  synthesis: SynthesisService;
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
  synthesisScripts: Record<string, SynthesisScript> = {},
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
  const runtime = buildSurveyRuntime(scripts, synthesisScripts);
  // 真实核验管道（quote 逐字 → scholarly 离线 unresolved → judge 脚本化 supported）
  const evidenceGrounding = new EvidenceGroundingService({
    projects,
    candidates: new EvidenceCandidateStore(projects),
    evidence,
    chunkAccess,
    scholarly: new ScholarlyResolver({ providers: [] }),
    runtime,
    citationAgentId: "citation",
    log: () => {},
  });
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
  const synthesis = new SynthesisService({
    projects,
    sources,
    chunkAccess,
    runtime,
    researcherAgentId: "researcher",
    evidenceGrounding,
    now: FIXED_NOW,
    log: () => {},
  });

  return {
    projects,
    sources,
    retrieval,
    chunkAccess,
    evidence,
    evidenceGrounding,
    matrix,
    synthesis,
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
      "Future work: extending the benchmark to crowded and low-light scenarios remains open, and no current protocol systematically covers identity preservation under severe illumination change.",
    ),
  },
  {
    fileName: "ocsort.txt",
    title: "Observation-Centric SORT Motion Association without Appearance",
    doi: "10.1000/ocsort",
    year: 2022,
    authors: ["Cao, Jinkun"],
    body: paperBody(
      "OC-SORT",
      "We restore association from observation-centric re-update instead of appearance embedding, recovering from Kalman estimation error during occlusion.",
      "Experiments show low-score detection boxes help bridge fragmented trajectories and identity switches decrease without any ReID model.",
    ),
  },
  {
    fileName: "strongsort.txt",
    title: "Strong SORT Deep Appearance Association with Adaptive Embedding",
    doi: "10.1000/strongsort",
    year: 2023,
    authors: ["Du, Yunhao"],
    body: paperBody(
      "StrongSORT",
      "We enhance the appearance association pipeline with adaptive embedding update and confidence-stratified matching, fusing appearance similarity with motion prior.",
      "On MOT17 and MOT20 the appearance-enhanced association keeps identity stable through long occlusion; however appearance features degrade under low illumination and add real-time cost.",
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
