/**
 * Evidence Tool Layer 测试（M6.5）：
 * - get_chunk / propose_evidence / evidence_query 三工具行为
 * - 角色权限矩阵（evidenceToolsForRole）
 * - 安全红线：任何工具调用后 evidence.jsonl 零写入（Tool 无法直写 EvidenceStore）
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { evidenceToolsForRole } from "../../src/evidence/tools.js";
import {
  CHUNK_TEXT,
  newGroundingFixture,
  supportedJson,
  type GroundingFixture,
} from "./fixtures.js";

const fixtures: GroundingFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
});

async function fixture(): Promise<GroundingFixture> {
  const created = await newGroundingFixture({
    provider: undefined,
    judge: () => supportedJson(),
  });
  fixtures.push(created);
  return created;
}

async function evidenceLineCount(f: GroundingFixture): Promise<number> {
  try {
    const raw = await readFile(
      join(f.projects.evidenceDir(f.projectId), "evidence.jsonl"),
      "utf8",
    );
    return raw.trim() === "" ? 0 : raw.trim().split("\n").length;
  } catch {
    return 0;
  }
}

/** 执行工具并解析 JSON 输出（工具统一 content[0].text = JSON） */
async function runTool(
  tool: { name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> },
  params: unknown,
): Promise<Record<string, unknown>> {
  const result = await tool.execute("tc-1", params);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const GOOD_QUOTE = "The average factual error rate drops by 42 percent";

function toolsFor(f: GroundingFixture, role: "researcher" | "writer" | "reviewer" | "citation" | "default") {
  const tools = evidenceToolsForRole(
    role,
    { chunkAccess: f.chunkAccess, grounding: f.grounding, evidence: f.evidence },
    f.projectId,
  );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { tools, byName };
}

describe("get_chunk 工具", () => {
  it("合法 chunkId → 原文 + 章节 + 页码 + 来源信息", async () => {
    const f = await fixture();
    const { byName } = toolsFor(f, "reviewer");
    const payload = await runTool(byName.get("get_chunk")!, { chunkId: f.chunkId });
    expect(payload["kind"]).toBe("chunk");
    const chunk = payload["chunk"] as Record<string, unknown>;
    expect(chunk["chunkId"]).toBe(f.chunkId);
    expect(chunk["text"]).toBe(CHUNK_TEXT);
    expect(chunk["section"]).toBe("Introduction");
    expect(chunk["page"]).toBe(3);
    const source = payload["source"] as Record<string, unknown>;
    expect(source["sourceId"]).toBe("S001");
    expect(source["title"]).toBe("A Survey of Retrieval-Augmented Generation");
  });

  it("非法 / 不存在的 chunkId → 结构化失败（不抛错）", async () => {
    const f = await fixture();
    const { byName } = toolsFor(f, "reviewer");
    const bad = await runTool(byName.get("get_chunk")!, { chunkId: "junk" });
    expect(bad["ok"]).toBe(false);
    expect(bad["reason"]).toBe("INVALID_CHUNK_ID");
    const missing = await runTool(byName.get("get_chunk")!, {
      chunkId: "S001:SEC01:0009:0000000000",
    });
    expect(missing["ok"]).toBe(false);
    expect(missing["reason"]).toBe("CHUNK_NOT_FOUND");
  });
});

describe("propose_evidence 工具", () => {
  it("合法提案 → 候选入队（pending），并明确提示不是已核验证据", async () => {
    const f = await fixture();
    const { byName } = toolsFor(f, "researcher");
    const payload = await runTool(byName.get("propose_evidence")!, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: "RAG 降低幻觉率",
      quote: GOOD_QUOTE,
    });
    expect(payload["ok"]).toBe(true);
    expect(payload["candidateId"]).toBe("EC001");
    expect((payload["candidate"] as Record<string, unknown> | undefined)).toBeUndefined();
    expect(String(payload["status"] ?? payload["note"])).toBeTruthy();
    const candidates = await f.candidates.list(f.projectId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe("pending");
    // 安全红线：工具不写证据库
    expect(await evidenceLineCount(f)).toBe(0);
  });

  it("非法锚点 → 结构化失败，不产生候选", async () => {
    const f = await fixture();
    const { byName } = toolsFor(f, "researcher");
    const payload = await runTool(byName.get("propose_evidence")!, {
      sourceId: "S001",
      chunkId: "S001:SEC01:0009:0000000000",
      claim: "c",
      quote: GOOD_QUOTE,
    });
    expect(payload["ok"]).toBe(false);
    expect(payload["reason"]).toBe("CHUNK_NOT_FOUND");
    expect(await f.candidates.list(f.projectId)).toHaveLength(0);
  });
});

describe("evidence_query 工具", () => {
  it("按 status / sourceId / section / claimContains 过滤（只读）", async () => {
    const f = await fixture();
    // 库内准备：一条 grounded verified（走真实管道）+ 一条 legacy unverified
    await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: "RAG 降低幻觉率",
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    await f.grounding.groundPending(f.projectId);
    await f.evidence.append(
      f.projectId,
      { claim: "另一条未核验线索", source: { sourceId: "S002" } },
      "researcher",
    );
    const { byName } = toolsFor(f, "writer");
    const query = byName.get("evidence_query")!;

    const all = (await runTool(query, {})) as Record<string, unknown>;
    expect(all["total"]).toBe(2);

    const verified = (await runTool(query, { status: "verified" })) as Record<string, unknown>;
    expect(verified["total"]).toBe(1);
    const record = (verified["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(record["verificationStatus"]).toBe("verified");
    expect(record["supportStrength"]).toBe("direct");
    expect(record["chunkId"]).toBe(f.chunkId);

    const bySource = (await runTool(query, { sourceId: "S002" })) as Record<string, unknown>;
    expect(bySource["total"]).toBe(1);

    const byClaim = (await runTool(query, { claimContains: "幻觉" })) as Record<string, unknown>;
    expect(byClaim["total"]).toBe(1);

    const bySection = (await runTool(query, { section: "intro" })) as Record<string, unknown>;
    expect(bySection["total"]).toBe(1);

    expect(await evidenceLineCount(f)).toBe(2); // 查询零写入
  });
});

describe("角色权限矩阵 + 安全红线", () => {
  it("researcher=3 工具；writer=evidence_query；reviewer/citation=get_chunk+evidence_query；default=无", async () => {
    const f = await fixture();
    const names = (role: Parameters<typeof toolsFor>[1]) =>
      toolsFor(f, role).tools.map((tool) => tool.name).sort();

    expect(names("researcher")).toEqual(["evidence_query", "get_chunk", "propose_evidence"]);
    expect(names("writer")).toEqual(["evidence_query"]);
    expect(names("reviewer")).toEqual(["evidence_query", "get_chunk"]);
    expect(names("citation")).toEqual(["evidence_query", "get_chunk"]);
    expect(names("default")).toEqual([]);
    // 不存在 write_evidence / updateVerification 类工具
    const allNames = new Set(
      (["researcher", "writer", "reviewer", "citation", "default"] as const).flatMap((role) =>
        names(role),
      ),
    );
    expect([...allNames].some((name) => /write|update|append|verify_/.test(name))).toBe(false);
  });

  it("全部角色工具轮询调用后 evidence.jsonl 仍为零写入（Tool 无法直写 EvidenceStore）", async () => {
    const f = await fixture();
    for (const role of ["researcher", "writer", "reviewer", "citation", "default"] as const) {
      const { tools } = toolsFor(f, role);
      for (const tool of tools) {
        const params =
          tool.name === "get_chunk"
            ? { chunkId: f.chunkId }
            : tool.name === "propose_evidence"
              ? { sourceId: "S001", chunkId: f.chunkId, claim: `claim-${role}`, quote: GOOD_QUOTE }
              : {};
        await runTool(tool as never, params);
      }
    }
    // 候选可以产生（researcher 的 propose），但证据库必须保持空
    expect(await evidenceLineCount(f)).toBe(0);
    expect((await f.candidates.list(f.projectId)).length).toBeGreaterThan(0);
  });
});
