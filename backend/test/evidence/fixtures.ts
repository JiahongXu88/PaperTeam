/**
 * M6.5 Evidence Grounding 测试共享 fixture：
 * 临时项目 + 真实 SourceStore/ChunkStore 落盘（手工写 chunk，不经 chunker）+
 * 可脚本化的 scholarly provider / citation judge runtime。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { ChunkStore } from "../../src/retrieval/ChunkStore.js";
import type { SourceChunk } from "../../src/retrieval/types.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { EvidenceCandidateStore } from "../../src/evidence/candidates.js";
import { ChunkAccess } from "../../src/evidence/chunkAccess.js";
import { EvidenceGroundingService } from "../../src/evidence/EvidenceGroundingService.js";
import { ScholarlyResolver, type ScholarlyProvider, type ScholarlyQuery, type LookupOutcome } from "../../src/citation/scholarly.js";
import type { CanonicalPaperRecord } from "../../src/citation/integrity.js";
import type { AgentRuntime } from "../../src/runtime/types.js";
import { sha256Hex } from "../../src/util/hash.js";

export const CHUNK_TEXT =
  "Retrieval-augmented generation mitigates hallucination in open-domain question answering. " +
  "The average factual error rate drops by 42 percent when retrieval is introduced at inference time.";

export const SOURCE_TITLE = "A Survey of Retrieval-Augmented Generation";

export interface GroundingFixture {
  projects: ProjectStore;
  sources: SourceStore;
  chunkStore: ChunkStore;
  evidence: EvidenceStore;
  candidates: EvidenceCandidateStore;
  chunkAccess: ChunkAccess;
  grounding: EvidenceGroundingService;
  projectId: string;
  root: string;
  /** 可用 chunk 的 chunkId（内容 = CHUNK_TEXT） */
  chunkId: string;
  judgeCalls: Array<{ scope: string; task: string }>;
  setJudge: (script: JudgeScript) => void;
  cleanup: () => Promise<void>;
}

/** judge 脚本：按 scope 返回输出；{ fail } → 任务失败；{ raw } → 任意原始输出 */
export type JudgeScript = (
  scope: string,
) => string | { fail: true; error?: string } | { raw: string };

function buildJudgeRuntime(calls: Array<{ scope: string; task: string }>, initial: JudgeScript) {
  let script: JudgeScript = initial;
  const runtime: AgentRuntime = {
    provider: "pi",
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "judge fixture",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    startAgent: async (input) => {
      const task = await runtime.runAgent(input);
      return {
        taskId: task.taskId,
        sessionKey: `agent:${input.agentId}:evidence-judge-fixture`,
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    runAgent: async (input) => {
      const scope = input.contextScope ?? "";
      calls.push({ scope, task: input.task });
      const now = new Date().toISOString();
      const outcome = script(scope);
      const base = {
        taskId: `judge-${calls.length}`,
        agentId: input.agentId,
        createdAt: now,
        updatedAt: now,
      };
      if (typeof outcome === "string") {
        return { ...base, status: "completed" as const, output: outcome };
      }
      if ("fail" in outcome) {
        return { ...base, status: "failed" as const, error: outcome.error ?? "judge 任务失败（fixture）" };
      }
      return { ...base, status: "completed" as const, output: outcome.raw };
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    modelStatusSnapshot: async () => ({
      phase: "unknown" as const,
      providers: [],
      detail: "fixture",
    }),
    runtimeStats: () => ({ activeRuns: 0, managedSessions: 0 }),
    close: async () => {},
  };
  return {
    runtime,
    setJudge: (next: JudgeScript) => {
      script = next;
    },
  };
}

/** 可脚本化 scholarly provider（单源；not_found 需两源才定论——单源 not_found → unresolved） */
export function fakeScholarlyProvider(
  respond: (query: ScholarlyQuery) => LookupOutcome,
): ScholarlyProvider {
  return {
    name: "crossref",
    lookup: async (query) => respond(query),
  };
}

export function canonicalRecord(overrides: Partial<CanonicalPaperRecord> = {}): CanonicalPaperRecord {
  return {
    provider: "crossref",
    recordId: "10.1000/survey",
    title: SOURCE_TITLE,
    authors: ["Gao, Yunfan"],
    year: 2023,
    doi: "10.1000/survey",
    retrievedAt: new Date().toISOString(),
    ...overrides,
  };
}

export interface FixtureOptions {
  /** scholarly provider（缺省 = 无 provider：离线部署形态，metadata=unresolved） */
  provider?: ScholarlyProvider;
  /** judge 脚本（缺省 = supported） */
  judge?: JudgeScript;
  /** 不注入 judge runtime（Stage 3 不可用形态） */
  withoutJudge?: boolean;
}

export async function newGroundingFixture(
  options: FixtureOptions = {},
): Promise<GroundingFixture> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-ground-"));
  const projects = new ProjectStore({ root });
  const project = await projects.create("Grounding 测试");
  const projectId = project.id;

  const sources = new SourceStore(projects);
  const chunkStore = new ChunkStore(projects);
  const evidence = new EvidenceStore(projects);
  const candidates = new EvidenceCandidateStore(projects);
  const chunkAccess = new ChunkAccess({ projects, chunkStore, sources });

  // 文献 S001 入库（带完整 metadata 供 Stage 2 比对）
  await sources.add(projectId, {
    fileName: "survey.txt",
    content: Buffer.from(`# Introduction\n\n${CHUNK_TEXT}\n`, "utf8"),
    metadata: {
      title: SOURCE_TITLE,
      authors: ["Gao, Yunfan"],
      year: 2023,
      doi: "10.1000/survey",
    },
  });
  // 手工落盘一个 chunk（quote 校验锚点；不经 chunker——本测试不关心切分）
  const contentHash = sha256Hex(CHUNK_TEXT).slice(0, 10);
  const chunkId = `S001:SEC01:0001:${contentHash}`;
  const chunk: SourceChunk = {
    chunkId,
    projectId,
    sourceId: "S001",
    sectionId: "SEC01",
    sectionTitle: "Introduction",
    pageStart: 3,
    ordinal: 1,
    text: CHUNK_TEXT,
    charCount: CHUNK_TEXT.length,
    tokenCount: 60,
    contentHash,
    generatedAt: new Date().toISOString(),
  };
  await chunkStore.writeChunks(projectId, "S001", [chunk]);

  const judgeCalls: Array<{ scope: string; task: string }> = [];
  const judge = buildJudgeRuntime(judgeCalls, options.judge ?? (() => supportedJson()));
  const grounding = new EvidenceGroundingService({
    projects,
    candidates,
    evidence,
    chunkAccess,
    scholarly: new ScholarlyResolver({
      providers: options.provider !== undefined ? [options.provider] : [],
    }),
    ...(options.withoutJudge === true ? {} : { runtime: judge.runtime, citationAgentId: "citation" }),
    log: () => {},
  });

  return {
    projects,
    sources,
    chunkStore,
    evidence,
    candidates,
    chunkAccess,
    grounding,
    projectId,
    root,
    chunkId,
    judgeCalls,
    setJudge: judge.setJudge,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function supportedJson(keyQuote?: string): string {
  return JSON.stringify({
    verdict: "supported",
    reason: "原文段落明确支撑该论断",
    ...(keyQuote !== undefined ? { keyQuote } : {}),
  });
}
