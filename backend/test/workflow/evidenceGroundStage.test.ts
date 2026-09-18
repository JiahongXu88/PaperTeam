/**
 * evidence.ground workflow stage E2E（M6.5）：
 * idea_to_paper 中 research → **evidence.ground** → feasibility 的接线。
 *
 * 场景：预置真实文献 + chunk 索引 + 一条 chunk 锚定候选 → workflow 推进到
 * feasibility HITL 时断言：
 * - completedStages 含 evidence.ground（位于 research.idea 之后）；
 * - 候选已被三段核验转正（verified + EvidenceRecord 落盘）；
 * - scripted research 的 legacy（无锚定）evidence 仍走 unverified 追加（兼容）；
 * - HTTP API（candidates 列表 / ground 触发）可用。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 20_000 });

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 10_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const SOURCE_TEXT = [
  "# Introduction",
  "",
  "Retrieval-augmented generation mitigates hallucination in open-domain question answering.",
  "The average factual error rate drops significantly when retrieval is introduced.",
  "",
  "# Experiments",
  "",
  "We compare three retrievers on two benchmarks and report factual consistency scores.",
].join("\n");

describe("evidence.ground stage（idea_to_paper）", () => {
  it("research → evidence.ground → feasibility：锚定候选核验转正，legacy evidence 兼容保留", async () => {
    const scripted = scriptedIdeaRuntime();
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const project = await stack.store.create("Evidence Grounding E2E", {
      researchIdea: "小语料 RAG 评估",
    });

    // 真实文献 + chunk 索引（.txt 走 text 解析路径，无需 pymupdf）
    await stack.stack.sources.add(project.id, {
      fileName: "survey.txt",
      content: Buffer.from(SOURCE_TEXT, "utf8"),
      metadata: {
        title: "RAG Hallucination Survey",
        authors: ["Gao, Yunfan"],
        year: 2023,
      },
    });
    await stack.stack.retrieval.rebuild(project.id);
    const search = await stack.stack.retrieval.search(project.id, "hallucination error rate");
    expect(search.results.length).toBeGreaterThan(0);
    const chunk = search.results[0]!.chunk;
    const quote = "mitigates hallucination in open-domain question answering";

    // 预置一条 chunk 锚定候选（模拟 Researcher 在 session 内用 propose_evidence 提案）
    const { candidate } = await stack.stack.evidenceGrounding.propose(project.id, {
      sourceId: chunk.sourceId,
      chunkId: chunk.chunkId,
      claim: "RAG 能缓解开放域问答的幻觉问题",
      quote,
      proposedBy: "researcher",
    });

    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    expect(created.status).toBe(202);
    const runId = created.body["runId"] as string;

    const run = await pollRun(stack, runId, ["awaiting_input", "failed", "cancelled"]);
    expect(run.status).toBe("awaiting_input");
    expect(run.awaiting?.stageId).toBe("hitl.feasibility_confirm");
    expect(run.completedStages).toEqual(["research.idea", "evidence.ground", "research.feasibility"]);

    // 候选转正：verified + EvidenceRecord
    const stored = await stack.stack.evidenceCandidates.get(project.id, candidate.candidateId);
    expect(stored?.status).toBe("verified");
    expect(stored?.evidenceId).toMatch(/^E\d{3,}$/);
    expect(stored?.judgeVerdict).toBe("supported");
    const record = await stack.stack.evidence.get(project.id, stored!.evidenceId!);
    expect(record).toMatchObject({
      claim: "RAG 能缓解开放域问答的幻觉问题",
      quote,
      verificationStatus: "verified",
      verificationLevel: "fulltext",
      supportStrength: "direct",
      createdBy: "researcher",
    });
    expect(record?.location?.chunk).toBe(chunk.chunkId);

    // scripted research 的 legacy evidence（无锚定）仍以 unverified 追加（兼容路径）
    const evidenceRaw = await readFile(
      join(stack.root, project.id, "evidence", "evidence.jsonl"),
      "utf8",
    );
    const records = evidenceRaw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.some((r) => r["verificationStatus"] === "verified" && r["quote"] === quote)).toBe(true);
    expect(records.some((r) => r["verificationStatus"] === "unverified" && r["createdBy"] === "researcher")).toBe(true);

    // HTTP API：候选列表 + ground 幂等触发
    const listed = await stack.request(
      "GET",
      `/api/projects/${project.id}/evidence/candidates?status=verified`,
    );
    expect(listed.status).toBe(200);
    expect((listed.body["candidates"] as unknown[])).toHaveLength(1);

    const grounded = await stack.request("POST", `/api/projects/${project.id}/evidence/ground`, {});
    expect(grounded.status).toBe(200);
    expect((grounded.body["summary"] as Record<string, unknown>)["processed"]).toBe(0);

    const groundedOne = await stack.request("POST", `/api/projects/${project.id}/evidence/ground`, {
      candidateId: candidate.candidateId,
    });
    expect(groundedOne.status).toBe(200);
    expect((groundedOne.body["result"] as Record<string, unknown>)["status"]).toBe("verified");
  });

  it("零候选项目：evidence.ground no-op 通过，不阻塞流程", async () => {
    const scripted = scriptedIdeaRuntime();
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const project = await stack.store.create("零候选项目", { researchIdea: "空证据测试" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    const run = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    expect(run.status).toBe("awaiting_input");
    expect(run.completedStages).toContain("evidence.ground");
  });
});
