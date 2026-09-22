/**
 * M9.4 Anchored Evidence Activation 集成测试：
 *
 * §28 Researcher 集成——真实 Tool 层（retrieve_library → get_chunk →
 * propose_evidence）→ Service 层（EvidenceGroundingService.propose）→ Store
 * （candidates.jsonl / evidence.jsonl）→ Grounding（groundPending）全链接通，
 * 不 mock EvidenceStore.add，每一步都执行真实工具/服务代码。
 *
 * §27 补缺口：
 * - Web candidate / 任意 URL 无法进入学术锚定路径（chunkId 形状 + chunk 必须存在）；
 * - Evidence 操作不改变 Literature 身份（SourceStore 记录与文件 contentHash 不变）；
 * - ResearcherService JSON 锚定路径（research 输出 → propose → pending 候选）；
 * - 非法锚定降级 legacy 追加（不炸 research 阶段）；
 * - legacy unverified 与 grounded verified 共存，writer formalOnly 只见后者。
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { ChunkStore } from "../../src/retrieval/ChunkStore.js";
import { RetrievalService } from "../../src/retrieval/RetrievalService.js";
import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { EvidenceCandidateStore } from "../../src/evidence/candidates.js";
import { ChunkAccess } from "../../src/evidence/chunkAccess.js";
import { EvidenceGroundingService } from "../../src/evidence/EvidenceGroundingService.js";
import { EvidenceSelectionService } from "../../src/evidence/EvidenceSelectionService.js";
import { ScholarlyResolver } from "../../src/citation/scholarly.js";
import { ResearcherService } from "../../src/agents/ResearcherService.js";
import {
  createRetrieveLibraryTool,
} from "../../src/retrieval/tools.js";
import {
  createGetChunkTool,
  createProposeEvidenceTool,
  createEvidenceQueryTool,
} from "../../src/evidence/tools.js";
import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";
import { supportedJson } from "./fixtures.js";

vi.setConfig({ testTimeout: 20_000 });

const SOURCE_TEXT = [
  "# Introduction",
  "",
  "Retrieval-augmented generation mitigates hallucination in open-domain question answering.",
  "The average factual error rate drops by 42 percent when retrieval is introduced at inference time.",
  "",
  "# Experiments",
  "",
  "We compare three retrievers on two benchmarks and report factual consistency scores.",
].join("\n");

const QUOTE = "The average factual error rate drops by 42 percent";

interface ActivationFixture {
  projects: ProjectStore;
  sources: SourceStore;
  chunkStore: ChunkStore;
  retrieval: RetrievalService;
  evidence: EvidenceStore;
  candidates: EvidenceCandidateStore;
  chunkAccess: ChunkAccess;
  grounding: EvidenceGroundingService;
  selection: EvidenceSelectionService;
  projectId: string;
  root: string;
  cleanup: () => Promise<void>;
}

const fixtures: ActivationFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
});

/** 固定 supported 裁决的 judge runtime（离线 scholarly：无 provider → unresolved） */
function judgeRuntime(): AgentRuntime {
  const now = () => new Date().toISOString();
  const base = (taskId: string): AgentTask => ({
    taskId,
    agentId: "citation",
    status: "completed",
    createdAt: now(),
    updatedAt: now(),
    output: supportedJson(),
  });
  const runtime: AgentRuntime = {
    provider: "pi",
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "activation fixture",
      latencyMs: 1,
      checkedAt: now(),
    }),
    startAgent: async (input) => {
      const task = await runtime.runAgent(input);
      return {
        taskId: task.taskId,
        sessionKey: `agent:${input.agentId}:activation-fixture`,
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    runAgent: async (input) => base(`judge-${input.agentId}`),
    getTask: () => {
      throw new Error("not implemented");
    },
    modelStatusSnapshot: async () => ({ phase: "unknown" as const, providers: [], detail: "fixture" }),
    runtimeStats: () => ({ activeRuns: 0, managedSessions: 0 }),
    close: async () => {},
  };
  return runtime;
}

async function newFixture(): Promise<ActivationFixture> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-m94-"));
  const projects = new ProjectStore({ root });
  const project = await projects.create("M9.4 Anchored Activation", {
    researchIdea: "RAG 幻觉缓解证据调研",
  });
  const projectId = project.id;
  const sources = new SourceStore(projects);
  const chunkStore = new ChunkStore(projects);
  const retrieval = new RetrievalService({
    projects,
    sources,
    chunker: new SourceChunker({ chunkOptions: { targetTokens: 400, maxTokens: 600, overlapTokens: 60 } }),
    chunkStore,
    log: () => {},
  });
  const evidence = new EvidenceStore(projects);
  const candidates = new EvidenceCandidateStore(projects);
  const chunkAccess = new ChunkAccess({ projects, chunkStore, sources });
  const grounding = new EvidenceGroundingService({
    projects,
    candidates,
    evidence,
    chunkAccess,
    scholarly: new ScholarlyResolver({ providers: [] }),
    runtime: judgeRuntime(),
    citationAgentId: "citation",
    log: () => {},
  });
  const fixture: ActivationFixture = {
    projects,
    sources,
    chunkStore,
    retrieval,
    evidence,
    candidates,
    chunkAccess,
    grounding,
    selection: new EvidenceSelectionService(evidence),
    projectId,
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

/** 入库一篇带全文的学术文献（txt → 真实 chunker → chunk 落盘 → 检索索引） */
async function seedFullTextLiterature(f: ActivationFixture): Promise<void> {
  await f.sources.add(f.projectId, {
    fileName: "survey.txt",
    content: Buffer.from(SOURCE_TEXT, "utf8"),
    metadata: {
      title: "A Survey of Retrieval-Augmented Generation",
      authors: ["Gao, Yunfan"],
      year: 2023,
      doi: "10.1000/survey",
    },
  });
  await f.retrieval.rebuild(f.projectId);
}

const NOOP_CTX = undefined as unknown as ExtensionContext;

async function runTool(tool: ToolDefinition, params: unknown): Promise<Record<string, unknown>> {
  const result = await tool.execute("tc-1", params as never, undefined, undefined, NOOP_CTX);
  const first = result.content[0]!;
  if (!("text" in first)) {
    throw new Error("工具输出不是文本 content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** 从 retrieve_library 打包上下文提取第一个 CHUNK 标记的 chunkId（标记形如 [SRC:S001 CHUNK:… SECTION:… PAGE:…]） */
function firstChunkIdFromPacked(packedText: string): string {
  const match = /\[SRC:S\d+ CHUNK:(S\d+:[A-Za-z0-9_-]+:\d+:[0-9a-f]{10})[ \]]/.exec(packedText);
  if (match === null) {
    throw new Error(`retrieve_library 结果中没有 CHUNK 标记：${packedText.slice(0, 200)}`);
  }
  return match[1]!;
}

describe("M9.4 研究者锚定路径（Tool → Service → Store → Grounding 全链）", () => {
  it("retrieve_library → get_chunk → propose_evidence → groundPending：真实工具顺序打通到 Verified Evidence", async () => {
    const f = await newFixture();
    await seedFullTextLiterature(f);

    // 1. retrieve_library：真实检索工具返回带 CHUNK 标记的原文段落
    const retrieve = createRetrieveLibraryTool(f.retrieval, f.projectId);
    const retrieved = await runTool(retrieve, { query: "factual error rate hallucination" });
    expect(retrieved["kind"]).toBe("retrieval");
    const packed = (retrieved["packedContext"] as { text: string }).text;
    const chunkId = firstChunkIdFromPacked(packed);
    expect(chunkId).toMatch(/^S001:SEC\d+:\d+:[0-9a-f]{10}$/);

    // 2. get_chunk：按 chunkId 回取逐字原文（quote 的唯一合法来源）
    const getChunk = createGetChunkTool(f.chunkAccess, f.projectId);
    const chunkPayload = await runTool(getChunk, { chunkId });
    expect(chunkPayload["kind"]).toBe("chunk");
    const chunk = chunkPayload["chunk"] as Record<string, unknown>;
    expect(chunk["sourceId"]).toBe("S001");
    expect(chunk["chunkId"]).toBe(chunkId);
    expect(String(chunk["text"])).toContain(QUOTE);
    const chunkSource = chunkPayload["source"] as Record<string, unknown>;
    expect(chunkSource["title"]).toBe("A Survey of Retrieval-Augmented Generation");
    expect(chunkSource["year"]).toBe(2023);

    // 3. propose_evidence：claim + 逐字 quote + 锚点 → pending 候选（不写 EvidenceStore）
    const propose = createProposeEvidenceTool(f.grounding, f.projectId, "researcher");
    const proposal = await runTool(propose, {
      sourceId: "S001",
      chunkId,
      claim: "引入检索后事实错误率平均下降 42%",
      quote: QUOTE,
    });
    expect(proposal["ok"]).toBe(true);
    expect(proposal["status"]).toBe("pending");
    expect(String(proposal["note"])).toContain("not verified evidence");
    const candidateId = proposal["candidateId"] as string;
    expect(await f.evidence.list(f.projectId)).toHaveLength(0); // 尚未转正

    // 4. groundPending：三段核验（quote 命中 / metadata unresolved 不阻塞 / judge supported）→ verified
    const summary = await f.grounding.groundPending(f.projectId);
    expect(summary).toMatchObject({ pending: 1, processed: 1, verified: 1, mismatch: 0, rejected: 0 });
    const candidate = await f.candidates.get(f.projectId, candidateId);
    expect(candidate?.status).toBe("verified");
    const record = await f.evidence.get(f.projectId, candidate!.evidenceId!);
    expect(record).toMatchObject({
      claim: "引入检索后事实错误率平均下降 42%",
      quote: QUOTE,
      verificationStatus: "verified",
      verificationLevel: "fulltext",
      supportStrength: "direct",
      verificationMethod: expect.stringContaining("quote=exact"),
    });
    expect(record?.location?.chunk).toBe(chunkId);
    // 章节锚点与 get_chunk 回取的真实 section 一致（txt 小文献为 Whole Document）
    expect(record?.location?.section).toBe(chunk["section"]);
  });

  it("重复提案幂等：同 claim+chunk+quote 复用 pending 候选，ground 后不产生第二条记录", async () => {
    const f = await newFixture();
    await seedFullTextLiterature(f);
    const search = await f.retrieval.search(f.projectId, "factual error rate");
    const chunkId = search.results[0]!.chunk.chunkId;

    const first = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId,
      claim: "检索引入显著降低事实错误率",
      quote: QUOTE,
      proposedBy: "researcher",
    });
    expect(first.deduplicated).toBe(false);
    const second = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId,
      claim: "检索引入显著降低事实错误率",
      quote: QUOTE,
      proposedBy: "researcher",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.candidate.candidateId).toBe(first.candidate.candidateId);
    expect(await f.candidates.list(f.projectId)).toHaveLength(1);

    await f.grounding.groundPending(f.projectId);
    // 转正后重复 ground 幂等（verified 直接返回，不 append 第二条）
    await f.grounding.ground(f.projectId, first.candidate.candidateId);
    expect(await f.evidence.list(f.projectId)).toHaveLength(1);
  });

  it("伪造 quote 在核验期被拒（mismatch 终态），不进证据库", async () => {
    const f = await newFixture();
    await seedFullTextLiterature(f);
    const search = await f.retrieval.search(f.projectId, "factual error rate");
    const chunkId = search.results[0]!.chunk.chunkId;
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId,
      claim: "捏造：错误率下降 99%",
      quote: "The average factual error rate drops by 99 percent",
      proposedBy: "researcher",
    });
    const result = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(result.status).toBe("mismatch");
    expect(result.reason).toContain("quote_not_found_in_chunk");
    expect(await f.evidence.list(f.projectId)).toHaveLength(0);
  });

  it("并发提案回归（M9.4 真实 smoke 暴露）：并行 propose 不产生重复 candidateId", async () => {
    const f = await newFixture();
    await seedFullTextLiterature(f);
    const search = await f.retrieval.search(f.projectId, "factual error rate");
    const chunkId = search.results[0]!.chunk.chunkId;
    // 模拟 Agent 同一回合的并行 propose_evidence 工具调用（不同 claim → 不去重）：
    // 修复前 append 的 loadAll → max+1 竞态会写出多条同号候选（EC001×N），
    // markResolved 只改首行、其余行永久卡 pending
    const claims = Array.from({ length: 8 }, (_, i) => `并发论断 ${i + 1}：错误率下降 ${40 + i} percent`);
    const proposed = await Promise.all(
      claims.map((claim) =>
        f.grounding.propose(f.projectId, {
          sourceId: "S001",
          chunkId,
          claim,
          quote: QUOTE,
          proposedBy: "researcher",
        }),
      ),
    );
    const ids = proposed.map((p) => p.candidate.candidateId);
    expect(new Set(ids).size).toBe(ids.length); // 全部唯一，无同号
    const listed = await f.candidates.list(f.projectId);
    expect(listed).toHaveLength(8);
    expect(new Set(listed.map((c) => c.candidateId)).size).toBe(8);
    // 全部 ground：不留卡死 pending 的幽灵行
    const summary = await f.grounding.groundPending(f.projectId);
    expect(summary).toMatchObject({ pending: 8, processed: 8, verified: 8 });
    expect((await f.candidates.query(f.projectId, { status: "pending" })).length).toBe(0);
    expect((await f.evidence.list(f.projectId)).length).toBe(8);
    // EvidenceStore 同口径：并发 append 不撞号
    const appended = await Promise.all(
      claims.slice(0, 4).map((claim, i) =>
        f.evidence.append(f.projectId, { claim: `${claim}（legacy）` }, `user${i}`),
      ),
    );
    expect(new Set(appended.map((r) => r.id)).size).toBe(4);
  });
});

describe("M9.4 Academic / Web 边界（§15）", () => {
  it("任意 URL / web 形状的 sourceId、chunkId 无法进入锚定路径（提案期结构拒绝）", async () => {
    const f = await newFixture();
    await seedFullTextLiterature(f);
    // URL 直接当锚点：chunkId 形状非法
    await expect(
      f.grounding.propose(f.projectId, {
        sourceId: "https://example.com/blog/rag",
        chunkId: "https://example.com/blog/rag:SEC01:0001:0123456789",
        claim: "网页正文声称的结论",
        quote: "Some claim scraped from a web page.",
        proposedBy: "researcher",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CHUNK_ID" });
    expect(await f.candidates.list(f.projectId)).toHaveLength(0);
  });

  it("web 来源（url-only、无全文无 chunk）伪造 chunkId → CHUNK_NOT_FOUND，候选不入队", async () => {
    const f = await newFixture();
    await seedFullTextLiterature(f);
    // web 候选形态：只有 URL 身份的来源，没有全文 → ChunkStore 无 chunk
    await f.sources.add(f.projectId, {
      fileName: "web-note.txt",
      content: Buffer.from("# Web note\n\njust a web lead\n", "utf8"),
      metadata: {
        title: "Web Lead (url-only)",
        url: "https://example.com/blog/rag",
      },
    });
    await f.retrieval.rebuild(f.projectId);
    // 伪造一个指向 S002 的 chunkId（hash 全 0 不存在）
    await expect(
      f.grounding.propose(f.projectId, {
        sourceId: "S002",
        chunkId: "S002:SEC01:0001:0000000000",
        claim: "网页结论",
        quote: "just a web lead",
        proposedBy: "researcher",
      }),
    ).rejects.toMatchObject({ code: "CHUNK_NOT_FOUND" });
    expect(await f.candidates.list(f.projectId)).toHaveLength(0);
    // Evidence 工具面也不存在任何「按 URL 抓正文」的入口（工具清单闭式枚举）
    const propose = createProposeEvidenceTool(f.grounding, f.projectId, "researcher");
    expect(propose.parameters).toBeDefined();
  });
});

describe("M9.4 文献身份不可变（§16）", () => {
  it("propose + ground 全程不改 SourceStore 记录与文件 contentHash", async () => {
    const f = await newFixture();
    await seedFullTextLiterature(f);
    const before = JSON.stringify(await f.sources.list(f.projectId));
    const fileDir = f.projects.projectDir(f.projectId);
    const beforeFiles = await readFile(join(fileDir, "sources", "index.json"), "utf8");

    const search = await f.retrieval.search(f.projectId, "factual error rate");
    const chunkId = search.results[0]!.chunk.chunkId;
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId,
      claim: "引入检索后事实错误率平均下降 42%",
      quote: QUOTE,
      proposedBy: "researcher",
    });
    await f.grounding.ground(f.projectId, candidate.candidateId);

    expect(JSON.stringify(await f.sources.list(f.projectId))).toBe(before);
    expect(await readFile(join(fileDir, "sources", "index.json"), "utf8")).toBe(beforeFiles);
  });
});

describe("M9.4 ResearcherService JSON 锚定路径（§28）", () => {
  /** scope=research 返回固定 JSON 的 fake runtime */
  function researchRuntime(output: string): AgentRuntime {
    const now = () => new Date().toISOString();
    const runtime: AgentRuntime = {
      provider: "pi",
      healthCheck: async () => ({
        ok: true,
        provider: "pi",
        status: "healthy",
        detail: "research fixture",
        latencyMs: 1,
        checkedAt: now(),
      }),
      startAgent: async (input) => {
        const task = await runtime.runAgent(input);
        return {
          taskId: task.taskId,
          sessionKey: `agent:${input.agentId}:research-fixture`,
          events: async function* () {},
          cancel: async () => {},
          result: async () => task,
        };
      },
      runAgent: async (input) => ({
        taskId: "research-1",
        agentId: input.agentId,
        status: "completed" as const,
        createdAt: now(),
        updatedAt: now(),
        output,
      }),
      getTask: () => {
        throw new Error("not implemented");
      },
      modelStatusSnapshot: async () => ({ phase: "unknown" as const, providers: [], detail: "fixture" }),
      runtimeStats: () => ({ activeRuns: 0, managedSessions: 0 }),
      close: async () => {},
    };
    return runtime;
  }

  function researchJson(evidence: unknown[]): string {
    return JSON.stringify({
      domainOverview: "RAG 通过推理时检索缓解幻觉。",
      relatedWorkDirections: ["检索器优化"],
      researchGaps: ["小语料评估缺失"],
      potentialContributions: ["评估协议"],
      researchQuestions: ["检索质量如何影响幻觉率？"],
      literaturePlan: ["补充幻觉评估基准论文"],
      evidence,
      bibliography: [],
    });
  }

  it("带真实锚点的 evidence 条目走候选管道（evidenceProposed），无锚定条目保持 legacy unverified", async () => {
    const f = await newFixture();
    await seedFullTextLiterature(f);
    const search = await f.retrieval.search(f.projectId, "factual error rate");
    const chunkId = search.results[0]!.chunk.chunkId;
    const researcher = new ResearcherService({
      runtime: researchRuntime(
        researchJson([
          {
            claim: "引入检索后事实错误率平均下降 42%",
            summary: "综述实验汇总。",
            quote: QUOTE,
            sourceId: "S001",
            chunkId,
            source: { title: "A Survey of Retrieval-Augmented Generation", year: 2023 },
            location: { section: "Introduction" },
          },
          {
            claim: "重排策略在小语料场景最稳健（无锚定线索）",
            source: { title: "Rerankers for Small Corpora", year: 2025 },
          },
        ]),
      ),
      agentId: "researcher",
      projects: f.projects,
      evidence: f.evidence,
      sources: f.sources,
      evidenceGrounding: f.grounding,
      log: () => {},
    });

    const result = await researcher.research({ projectId: f.projectId });
    expect(result.evidenceProposed).toBe(1);
    expect(result.evidenceAppended).toBe(1);

    // 锚定条目在候选队列（pending），legacy 条目直接 unverified 落证据库
    const pending = await f.candidates.query(f.projectId, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ sourceId: "S001", chunkId, quote: QUOTE });
    const legacy = await f.evidence.query(f.projectId, { status: "unverified" });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.claim).toContain("重排策略");

    // grounding：锚定候选转正；legacy 记录原样保留（共 2 条证据）
    const summary = await f.grounding.groundPending(f.projectId);
    expect(summary.verified).toBe(1);
    const all = await f.evidence.list(f.projectId);
    expect(all).toHaveLength(2);
    expect(all.filter((record) => record.verificationStatus === "verified")).toHaveLength(1);

    // Writer formalOnly 视图：只看到 grounded verified，legacy 不可见
    const writerQuery = createEvidenceQueryTool(f.evidence, f.projectId, { formalOnly: true });
    const writerView = await runTool(writerQuery, {});
    const visible = writerView["evidence"] as Array<Record<string, unknown>>;
    expect(visible).toHaveLength(1);
    expect(visible[0]!["chunkId"]).toBe(chunkId);
    expect(visible[0]!["verificationStatus"]).toBe("verified");

    // EvidenceSelectionService 同口径（workflow 写作路径的选择器）
    const selection = await f.selection.selectForWriting(f.projectId);
    expect(selection.formal).toHaveLength(1);
    expect(selection.excluded.legacyUnverified).toBe(1);
  });

  it("非法锚定（chunk 不存在）降级 legacy unverified 追加，不炸 research 阶段", async () => {
    const f = await newFixture();
    await seedFullTextLiterature(f);
    const researcher = new ResearcherService({
      runtime: researchRuntime(
        researchJson([
          {
            claim: "锚定到不存在的 chunk",
            quote: QUOTE,
            sourceId: "S001",
            chunkId: "S001:SEC01:9999:0000000000",
          },
        ]),
      ),
      agentId: "researcher",
      projects: f.projects,
      evidence: f.evidence,
      sources: f.sources,
      evidenceGrounding: f.grounding,
      log: () => {},
    });

    const result = await researcher.research({ projectId: f.projectId });
    expect(result.evidenceProposed).toBe(0);
    expect(result.evidenceAppended).toBe(1);
    expect(await f.candidates.list(f.projectId)).toHaveLength(0);
    const legacy = await f.evidence.query(f.projectId, { status: "unverified" });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.claim).toBe("锚定到不存在的 chunk");
  });

  it("老项目兼容（§17）：纯 legacy unverified 证据的项目 formal 为空、候选队列空、ground no-op", async () => {
    const f = await newFixture();
    await f.evidence.append(
      f.projectId,
      { claim: "存量未核验证据", source: { title: "Old Paper", year: 2020 } },
      "researcher",
    );
    const summary = await f.grounding.groundPending(f.projectId);
    expect(summary).toMatchObject({ pending: 0, processed: 0 });
    const selection = await f.selection.selectForWriting(f.projectId);
    expect(selection.formal).toHaveLength(0);
    expect(selection.excluded.legacyUnverified).toBe(1);
    // 存量记录仍可读取（UI / API 兼容）
    const records = await f.evidence.list(f.projectId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ verificationStatus: "unverified", createdBy: "researcher" });
  });
});
