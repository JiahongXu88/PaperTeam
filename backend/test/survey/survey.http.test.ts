/**
 * M11.1.1 Survey Matrix HTTP 端点测试：
 * GET /survey/matrix、POST /survey/matrix/build、PUT /survey/matrix/:entryId。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, type TestStack } from "../helpers/testStack.js";
import {
  FIXTURE_ABSTRACT_ONLY,
  FIXTURE_PAPERS,
  buildSurveyRuntime,
  fakeTextAnalysis,
} from "./fixtures.js";

let stack: TestStack;

beforeAll(async () => {
  stack = await startTestStack(buildSurveyRuntime({}));
});

afterAll(async () => {
  await stack.cleanup();
});

async function createProject(): Promise<string> {
  const { body } = await stack.request("POST", "/api/projects", {
    title: "Survey HTTP 测试",
  });
  return (body["project"] as { id: string }).id;
}

async function seedProject(projectId: string): Promise<void> {
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
  await stack.stack.sources.addRecord(projectId, {
    sourceType: "doi",
    origin: "DOI_IMPORT",
    metadata: {
      title: FIXTURE_ABSTRACT_ONLY.title,
      doi: FIXTURE_ABSTRACT_ONLY.doi,
      year: FIXTURE_ABSTRACT_ONLY.year,
      authors: FIXTURE_ABSTRACT_ONLY.authors,
      abstract: FIXTURE_ABSTRACT_ONLY.abstract,
    },
  });
}

describe("Survey Matrix HTTP", () => {
  it("GET /survey/matrix：未构建 → matrix:null（与损坏区分）", async () => {
    const projectId = await createProject();
    const { status, body } = await stack.request("GET", `/api/projects/${projectId}/survey/matrix`);
    expect(status).toBe(200);
    expect(body["matrix"]).toBeNull();
  });

  it("GET /survey/matrix：损坏文件 → 500 SURVEY_MATRIX_CORRUPTED", async () => {
    const projectId = await createProject();
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(
      join(stack.root, projectId, "research", "survey.json"),
      "{ broken",
      "utf8",
    );
    const { status, body } = await stack.request("GET", `/api/projects/${projectId}/survey/matrix`);
    expect(status).toBe(500);
    expect((body["error"] as { code: string }).code).toBe("SURVEY_MATRIX_CORRUPTED");
  });

  it("POST build → GET matrix → PUT 修正与确认的完整 HTTP 链路", async () => {
    const projectId = await createProject();
    await seedProject(projectId);

    const build = await stack.request("POST", `/api/projects/${projectId}/survey/matrix/build`, {});
    expect(build.status).toBe(200);
    const summary = build.body["summary"] as Record<string, number>;
    expect(summary).toMatchObject({ total: 3, built: 3, failed: 0 });

    const get = await stack.request("GET", `/api/projects/${projectId}/survey/matrix`);
    expect(get.status).toBe(200);
    const matrix = get.body["matrix"] as {
      entries: Array<{ entryId: string; sourceId: string; interpretationDepth: string }>;
    };
    expect(matrix.entries.length).toBe(3);
    expect(matrix.entries.map((entry) => entry.entryId)).toEqual([
      "M-S001",
      "M-S002",
      "M-S003",
    ]);
    expect(matrix.entries[2]!.interpretationDepth).toBe("abstract_only");

    // HITL：修正 unclassified → 合法标签并确认
    const put = await stack.request("PUT", `/api/projects/${projectId}/survey/matrix/M-S003`, {
      methodFamily: "survey",
      status: "confirmed",
    });
    expect(put.status).toBe(200);
    expect((put.body["entry"] as { methodFamily: string }).methodFamily).toBe("survey");
    expect((put.body["entry"] as { status: string }).status).toBe("confirmed");

    // 幂等重建：全部 skipped，不产生重复行
    const rebuild = await stack.request("POST", `/api/projects/${projectId}/survey/matrix/build`, {});
    expect(rebuild.status).toBe(200);
    expect((rebuild.body["summary"] as Record<string, number>).skippedExisting).toBe(3);
    const after = await stack.request("GET", `/api/projects/${projectId}/survey/matrix`);
    expect(
      ((after.body["matrix"] as { entries: unknown[] }).entries).length,
    ).toBe(3);
  });

  it("PUT：非法 taxonomy 标签 → 400；不存在的条目 → 404", async () => {
    const projectId = await createProject();
    await seedProject(projectId);
    await stack.request("POST", `/api/projects/${projectId}/survey/matrix/build`, {});

    const bad = await stack.request("PUT", `/api/projects/${projectId}/survey/matrix/M-S001`, {
      methodFamily: "made_up_family",
    });
    expect(bad.status).toBe(400);
    expect((bad.body["error"] as { code: string }).code).toBe("INVALID_REQUEST");

    const missing = await stack.request("PUT", `/api/projects/${projectId}/survey/matrix/M-S099`, {
      methodFamily: "survey",
    });
    expect(missing.status).toBe(404);
  });

  it("POST build：非法 sourceIds / 非法 taxonomy → 400", async () => {
    const projectId = await createProject();
    const badIds = await stack.request("POST", `/api/projects/${projectId}/survey/matrix/build`, {
      sourceIds: ["S099"],
    });
    expect(badIds.status).toBe(400);

    const badTaxonomy = await stack.request(
      "POST",
      `/api/projects/${projectId}/survey/matrix/build`,
      { taxonomy: { families: "not-array" } },
    );
    expect(badTaxonomy.status).toBe(400);
  });

  it("build 响应携带 matrix（typed result，不吞异常）", async () => {
    const projectId = await createProject();
    const response = await stack.request("POST", `/api/projects/${projectId}/survey/matrix/build`, {});
    expect(response.status).toBe(200);
    const body = response.body as {
      results: Array<{ sourceId: string; outcome: string }>;
      matrix: { entries: unknown[]; taxonomy: { families: unknown[] } };
    };
    expect(body.results).toEqual([]);
    expect(body.matrix.entries).toEqual([]);
    expect(body.matrix.taxonomy.families.length).toBeGreaterThan(0);
  });
});
