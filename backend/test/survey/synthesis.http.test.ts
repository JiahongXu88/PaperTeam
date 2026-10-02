/**
 * M11.1.2 Survey Synthesis HTTP 端点测试：
 * GET /survey/synthesis、POST /survey/synthesis/build。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { buildSurveyRuntime, fakeTextAnalysis, FIXTURE_PAPERS } from "./fixtures.js";

let stack: TestStack;

beforeAll(async () => {
  stack = await startTestStack(buildSurveyRuntime({}));
});

afterAll(async () => {
  await stack.cleanup();
});

async function createProject(): Promise<string> {
  const { body } = await stack.request("POST", "/api/projects", {
    title: "Survey Synthesis HTTP 测试",
  });
  return (body["project"] as { id: string }).id;
}

/** seed 2 篇 fulltext + 构建矩阵（默认脚本，tracking_association 同族 → 有 LLM batch） */
async function seedMatrix(projectId: string): Promise<void> {
  for (const paper of FIXTURE_PAPERS.slice(0, 2)) {
    const { source } = await stack.stack.sources.add(projectId, {
      fileName: paper.fileName,
      content: Buffer.from(paper.body, "utf8"),
      metadata: { title: paper.title, doi: paper.doi, year: paper.year, authors: paper.authors },
    });
    await stack.stack.sources.setAnalysis(projectId, source.sourceId, fakeTextAnalysis(), {
      ...(source.contentHash !== undefined ? { contentHash: source.contentHash } : {}),
    });
  }
  const build = await stack.request("POST", `/api/projects/${projectId}/survey/matrix/build`, {});
  expect(build.status).toBe(200);
}

describe("Survey Synthesis HTTP", () => {
  it("GET /survey/synthesis：未构建 → synthesis:null（与损坏区分）", async () => {
    const projectId = await createProject();
    const { status, body } = await stack.request("GET", `/api/projects/${projectId}/survey/synthesis`);
    expect(status).toBe(200);
    expect(body["synthesis"]).toBeNull();
  });

  it("GET /survey/synthesis：损坏文件 → 500 SURVEY_SYNTHESIS_CORRUPTED", async () => {
    const projectId = await createProject();
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(
      join(stack.root, projectId, "research", "survey-synthesis.json"),
      "{ broken",
      "utf8",
    );
    const { status, body } = await stack.request("GET", `/api/projects/${projectId}/survey/synthesis`);
    expect(status).toBe(500);
    expect((body["error"] as { code: string }).code).toBe("SURVEY_SYNTHESIS_CORRUPTED");
  });

  it("POST build：无矩阵 → 400；全链路 build → GET 读取一致", async () => {
    const projectId = await createProject();
    const noMatrix = await stack.request("POST", `/api/projects/${projectId}/survey/synthesis/build`, {});
    expect(noMatrix.status).toBe(400);
    expect((noMatrix.body["error"] as { code: string }).code).toBe("INVALID_REQUEST");

    await seedMatrix(projectId);
    const build = await stack.request("POST", `/api/projects/${projectId}/survey/synthesis/build`, {});
    expect(build.status).toBe(200);
    const summary = build.body["summary"] as Record<string, unknown>;
    expect(summary["reused"]).toBe(false);
    expect((summary["byKind"] as Record<string, number>)["taxonomy"]).toBeGreaterThan(0);

    const get = await stack.request("GET", `/api/projects/${projectId}/survey/synthesis`);
    expect(get.status).toBe(200);
    const synthesis = get.body["synthesis"] as {
      items: Array<{ synthesisId: string; kind: string; groundingLevel: string }>;
    };
    expect(synthesis.items.length).toBeGreaterThan(0);
    for (const item of synthesis.items) {
      expect(item.synthesisId).toMatch(/^SYN-[0-9a-f]{10}$/);
      expect(["evidence_backed", "literature_cited", "speculative"]).toContain(item.groundingLevel);
    }

    // 幂等：再 build → 复用（零 batch）
    const reuse = await stack.request("POST", `/api/projects/${projectId}/survey/synthesis/build`, {});
    expect((reuse.body["summary"] as Record<string, unknown>)["reused"]).toBe(true);
  });

  it("POST build：kinds 过滤与非法 kinds → 400 / 生效", async () => {
    const projectId = await createProject();
    await seedMatrix(projectId);

    const badKinds = await stack.request("POST", `/api/projects/${projectId}/survey/synthesis/build`, {
      kinds: ["not_a_kind"],
    });
    expect(badKinds.status).toBe(400);

    const emptyKinds = await stack.request("POST", `/api/projects/${projectId}/survey/synthesis/build`, {
      kinds: [],
    });
    expect(emptyKinds.status).toBe(400);

    const filtered = await stack.request("POST", `/api/projects/${projectId}/survey/synthesis/build`, {
      kinds: ["taxonomy"],
    });
    expect(filtered.status).toBe(200);
    const kinds = new Set(
      ((filtered.body["synthesis"] as { items: Array<{ kind: string }> }).items).map((item) => item.kind),
    );
    expect(kinds).toEqual(new Set(["taxonomy"]));
  });
});
