/**
 * M11.3（Phase C）Corpus Snapshot / Resume 语义单元 + 接线测试（§13–§19）。
 *
 * 覆盖任务书 §19 的判定矩阵：
 * - 初次 fulltext 完成 → freeze（幂等；basisDepth 跟随 matrix）；
 * - 普通 resume（快照在）→ survey.fulltext 是确定性 no-op（不重试解析——
 *   模拟网络恢复也不补齐）；
 * - 显式 refresh → 补齐 + revision+1 + 指纹变化 + matrix 可升级条目失效；
 * - matrix 重建后 basisDepth 同步（指纹变化、revision 不动）；
 * - 损坏快照 fail-closed（CORPUS_SNAPSHOT_CORRUPTED）。
 * MatrixService.invalidateUpgradableEntries 用真实 stores 验证。
 */

import { describe, expect, it, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import {
  CorpusSnapshotService,
  buildCorpusRows,
  corpusFingerprint,
  type CorpusRefreshOutcome,
  type CorpusSnapshotDeps,
  type CorpusSourceLike,
} from "../../src/survey/CorpusSnapshotService.js";
import { MatrixService } from "../../src/survey/MatrixService.js";
import { startTestStack } from "../helpers/testStack.js";
import { runtimeFromScript } from "../helpers/fakeRuntime.js";
import { createTopicSurveyDefinition, type WorkflowServices } from "../../src/workflow/definitions.js";

const NOW = () => new Date("2026-10-04T08:00:00.000Z");

interface DepStub {
  deps: CorpusSnapshotDeps;
  calls: { resolved: string[][]; ingested: string[]; invalidated: number };
  sources: CorpusSourceLike[];
}

function stubDeps(projects: ProjectStore, sources: CorpusSourceLike[]): DepStub {
  const calls = { resolved: [] as string[][], ingested: [] as string[], invalidated: 0 };
  return {
    calls,
    sources,
    deps: {
      projects,
      listSources: async () => sources,
      resolveFullTextBatch: async (_pid: string, sourceIds: string[]) => {
        calls.resolved.push(sourceIds);
        // 模拟网络恢复：缺失源全部补齐（磁盘状态变化由调用方改 sources 数组）
        return { summary: { resolved: sourceIds.length, notFound: 0, failed: 0, notResolvable: 0, skipped: 0 } };
      },
      ingest: async (_pid: string, sourceId: string) => {
        calls.ingested.push(sourceId);
        return {};
      },
      invalidateUpgradableMatrixEntries: async () => {
        calls.invalidated += 1;
        return 2;
      },
      now: NOW,
      log: () => {},
    },
  };
}

function sourceRow(
  sourceId: string,
  options: { fileName?: string; status?: string; role?: string } = {},
): CorpusSourceLike {
  return {
    sourceId,
    sourceRole: options.role ?? "literature",
    status: options.status ?? (options.fileName !== undefined ? "available" : "metadata_only"),
    ...(options.fileName !== undefined ? { fileName: options.fileName } : {}),
  };
}

async function newProject(): Promise<{ projects: ProjectStore; projectId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-corpus-"));
  const projects = new ProjectStore({ root });
  const project = await projects.create("Corpus Snapshot 测试");
  return { projects, projectId: project.id, root };
}

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("CorpusSnapshotService（freeze / refresh / syncBasisDepth）", () => {
  it("初次 freeze：行来自 sources + matrix，revision=0，指纹确定性，幂等", async () => {
    const { projects, projectId, root } = await newProject();
    roots.push(root);
    const stub = stubDeps(projects, [
      sourceRow("S001", { fileName: "a.pdf" }),
      sourceRow("S002", { fileName: "b.pdf" }),
      sourceRow("S003"),
    ]);
    const service = new CorpusSnapshotService(stub.deps);
    const matrix = {
      schemaVersion: 1 as const,
      updatedAt: NOW().toISOString(),
      taxonomy: { families: [] },
      entries: [
        { entryId: "M-S001", sourceId: "S001", interpretationDepth: "fulltext" as const },
        { entryId: "M-S002", sourceId: "S002", interpretationDepth: "abstract_only" as const },
        { entryId: "M-S003", sourceId: "S003", interpretationDepth: "abstract_only" as const },
      ],
    };
    const frozen = await service.freeze(projectId, { matrix: matrix as never });
    expect(frozen.revision).toBe(0);
    expect(frozen.counts).toEqual({ total: 3, hasFulltext: 2, fulltextBasis: 1, abstractBasis: 2 });
    expect(frozen.fingerprint).toBe(
      corpusFingerprint([
        { sourceId: "S001", status: "available", hasFulltext: true, basisDepth: "fulltext" },
        { sourceId: "S002", status: "available", hasFulltext: true, basisDepth: "abstract_only" },
        { sourceId: "S003", status: "metadata_only", hasFulltext: false, basisDepth: "abstract_only" },
      ]),
    );
    // 幂等：再次 freeze 返回既有快照（不重写）
    const again = await service.freeze(projectId, { matrix: null });
    expect(again.revision).toBe(0);
    expect(again.fingerprint).toBe(frozen.fingerprint);
  });

  it("refresh：未冻结 → INVALID_REQUEST；已冻结 → 补齐 + revision+1 + 指纹变化 + matrix 失效", async () => {
    const { projects, projectId, root } = await newProject();
    roots.push(root);
    const sources = [sourceRow("S001", { fileName: "a.pdf" }), sourceRow("S002")];
    const stub = stubDeps(projects, sources);
    const service = new CorpusSnapshotService(stub.deps);
    await expect(service.refresh(projectId)).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const frozen = await service.freeze(projectId, { matrix: null });
    expect(frozen.counts.hasFulltext).toBe(1);
    // 模拟网络恢复 + refresh：S002 补齐（磁盘状态变化）
    stub.sources[1] = sourceRow("S002", { fileName: "b.pdf" });
    const outcome: CorpusRefreshOutcome = await service.refresh(projectId);
    expect(outcome).toMatchObject({
      attempted: 1,
      resolved: 1,
      stillMissing: 0,
      invalidatedMatrixEntries: 2,
      revision: 1,
      fingerprintChanged: true,
    });
    expect(stub.calls.resolved).toEqual([["S002"]]);
    expect(stub.calls.ingested).toEqual(["S002"]);
    const after = await service.get(projectId);
    expect(after?.counts.hasFulltext).toBe(2);
    expect(after?.revision).toBe(1);
  });

  it("refresh 无补齐（全部仍缺失）：revision 仍 +1，指纹不变（如实呈现）", async () => {
    const { projects, projectId, root } = await newProject();
    roots.push(root);
    const stub = stubDeps(projects, [sourceRow("S001", { fileName: "a.pdf" }), sourceRow("S002")]);
    // 覆盖 resolve 结果：0 补齐
    stub.deps.resolveFullTextBatch = async () => ({
      summary: { resolved: 0, notFound: 1, failed: 0, notResolvable: 0, skipped: 0 },
    });
    const service = new CorpusSnapshotService(stub.deps);
    const frozen = await service.freeze(projectId, { matrix: null });
    const outcome = await service.refresh(projectId);
    expect(outcome).toMatchObject({ attempted: 1, resolved: 0, stillMissing: 1, revision: 1, fingerprintChanged: false });
    expect((await service.get(projectId))?.fingerprint).toBe(frozen.fingerprint);
  });

  it("syncBasisDepth：matrix 重建升级 basisDepth → 指纹变化、revision 不动；无变化 → 原样", async () => {
    const { projects, projectId, root } = await newProject();
    roots.push(root);
    const stub = stubDeps(projects, [sourceRow("S001", { fileName: "a.pdf" }), sourceRow("S002", { fileName: "b.pdf" })]);
    const service = new CorpusSnapshotService(stub.deps);
    await service.freeze(projectId, { matrix: null });
    const upgraded = {
      schemaVersion: 1 as const,
      updatedAt: NOW().toISOString(),
      taxonomy: { families: [] },
      entries: [
        { entryId: "M-S001", sourceId: "S001", interpretationDepth: "fulltext" as const },
        { entryId: "M-S002", sourceId: "S002", interpretationDepth: "fulltext" as const },
      ],
    };
    const synced = await service.syncBasisDepth(projectId, upgraded as never);
    expect(synced?.counts.fulltextBasis).toBe(2);
    expect(synced?.revision).toBe(0); // 不是新的语料修订
    const again = await service.syncBasisDepth(projectId, upgraded as never);
    expect(again?.fingerprint).toBe(synced?.fingerprint); // 幂等
  });

  it("损坏快照 fail-closed（CORPUS_SNAPSHOT_CORRUPTED），不降级解读", async () => {
    const { projects, projectId, root } = await newProject();
    roots.push(root);
    const stub = stubDeps(projects, [sourceRow("S001")]);
    const service = new CorpusSnapshotService(stub.deps);
    await service.freeze(projectId, { matrix: null });
    await writeFile(
      join(projects.researchDir(projectId), "corpus-snapshot.json"),
      "{ not-json",
      "utf8",
    );
    await expect(service.get(projectId)).rejects.toMatchObject({ code: "CORPUS_SNAPSHOT_CORRUPTED" });
  });

  it("buildCorpusRows：reference / rejected 源不进快照（资格口径与 fulltext/matrix 同源）", () => {
    const rows = buildCorpusRows(
      [
        sourceRow("S001", { fileName: "a.pdf" }),
        sourceRow("R001", { fileName: "ref.pdf", role: "reference" }),
        sourceRow("X001", { fileName: "x.pdf", status: "rejected" }),
      ],
      null,
    );
    expect(rows.map((row) => row.sourceId)).toEqual(["S001"]);
  });
});

describe("MatrixService.invalidateUpgradableEntries（真实 stores）", () => {
  it("abstract_only 条目在源获得全文后被失效；fulltext 条目保留；无 matrix = 0", async () => {
    const { projects, projectId, root } = await newProject();
    roots.push(root);
    const sources = new SourceStore(projects);
    const matrix = new MatrixService({
      projects,
      sources,
      retrieval: { search: async () => ({ hits: [] }) } as never,
      chunkAccess: {} as never,
      runtime: {} as never,
      researcherAgentId: "researcher",
      evidence: {} as never,
      now: NOW,
      log: () => {},
    });
    expect(await matrix.invalidateUpgradableEntries(projectId)).toBe(0);
    const full = await sources.add(projectId, {
      fileName: "a.txt",
      content: Buffer.from("full text of paper one", "utf8"),
      metadata: { title: "Paper One" },
    });
    const record = await sources.addRecord(projectId, {
      sourceType: "doi",
      origin: "DOI_IMPORT",
      metadata: { title: "Paper Two", doi: "10.1/x", year: 2024, authors: [] },
    });
    // 直接写 matrix artifact（绕过抽取）：full 条目 + abstract_only 条目
    const artifact = {
      schemaVersion: 1,
      updatedAt: NOW().toISOString(),
      taxonomy: { families: [{ label: "tracking_association", description: "测试用最小 taxonomy" }] },
      entries: [
        { entryId: `M-${full.source.sourceId}`, sourceId: full.source.sourceId, interpretationDepth: "fulltext", anchors: [], issues: [] },
        { entryId: `M-${record.sourceId}`, sourceId: record.sourceId, interpretationDepth: "abstract_only", anchors: [], issues: [] },
      ],
    };
    await writeFile(join(projects.researchDir(projectId), "survey.json"), JSON.stringify(artifact), "utf8");
    // S002 尚无全文 → 无可升级
    expect(await matrix.invalidateUpgradableEntries(projectId)).toBe(0);
    expect((await matrix.getMatrix(projectId))?.entries).toHaveLength(2);
    // S002 补挂全文（PDF 语义）→ 其 abstract_only 条目失效，fulltext 条目保留
    await sources.attachFile(projectId, record.sourceId, {
      fileName: "b.pdf",
      content: Buffer.from("%PDF-1.4 fake", "utf8"),
    });
    expect(await matrix.invalidateUpgradableEntries(projectId)).toBe(1);
    const remaining = await matrix.getMatrix(projectId);
    expect(remaining?.entries.map((entry) => entry.sourceId)).toEqual([full.source.sourceId]);
  });
});

describe("survey.fulltext 冻结语义（workflow 接线，真实 stack + fake runtime）", () => {
  it("快照存在 → stage 是确定性 no-op：不 promote / 不 resolve / 不 ingest（网络恢复也不补齐）", async () => {
    const runtime = runtimeFromScript(() => "");
    const stack = await startTestStack(runtime);
    try {
      const services: WorkflowServices = stack.stack.workflowServices;
      const projectId = (await stack.stack.projects.create("Corpus Freeze 接线测试")).id;
      // 预置语料 + 快照（5/25 语义：S001 有全文、S002 缺失）
      await services.sources.add(projectId, {
        fileName: "a.txt",
        content: Buffer.from("paper one", "utf8"),
        metadata: { title: "Paper One" },
      });
      await services.sources.addRecord(projectId, {
        sourceType: "doi",
        origin: "DOI_IMPORT",
        metadata: { title: "Paper Two", doi: "10.1/y", year: 2024, authors: [] },
      });
      const frozen = await services.corpus.freeze(projectId, { matrix: null });
      expect(frozen.counts).toEqual({ total: 2, hasFulltext: 1, fulltextBasis: 0, abstractBasis: 0 });

      const definition = createTopicSurveyDefinition(services);
      const stage = definition.stages.find((entry) => entry.id === "survey.fulltext");
      if (stage === undefined || "hitl" in stage) {
        throw new Error("survey.fulltext must be an execution stage");
      }
      const result = (await stage.execute({
        runId: "w-test",
        projectId,
        signal: new AbortController().signal,
        state: {
          schemaVersion: 1,
          runId: "w-test",
          projectId,
          workflowKind: "topic_survey",
          status: "running",
          createdAt: NOW().toISOString(),
          updatedAt: NOW().toISOString(),
          completedStages: [],
          stageResults: { "hitl.literature_selection": { decision: "approve", candidateIds: [] } },
          stageHistory: [],
          inputs: {},
          counters: {},
          eventsSeq: 0,
        },
        emitProgress: async () => {},
        log: () => {},
      } as never)) as Record<string, unknown>;
      expect(result["frozen"]).toBe(true);
      expect(result["corpusRevision"]).toBe(0);
      expect(result["fulltextResolved"]).toBe(1); // 快照口径，不触发新解析
      const after = await services.corpus.get(projectId);
      expect(after?.fingerprint).toBe(frozen.fingerprint); // resume 未改变冻结基线
    } finally {
      await stack.cleanup();
    }
  });
});
