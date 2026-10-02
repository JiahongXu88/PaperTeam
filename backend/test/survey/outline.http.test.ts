/**
 * M11.1.3 Survey Outline HTTP 端点测试：
 * POST /survey/outline/build（400 路径 / 全链 / GET /:id/manuscript round-trip refs）。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, type TestStack } from "../helpers/testStack.js";
import {
  buildSurveyRuntime,
  defaultOutlineOutput,
  fakeTextAnalysis,
  FIXTURE_PAPERS,
  type SurveyScriptedRuntime,
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
    title: "Survey Outline HTTP 测试",
  });
  return (body["project"] as { id: string }).id;
}

/** seed 2 篇 fulltext（可只构建 Matrix，或继续构建 Synthesis） */
async function seedPapersThenBuild(
  projectId: string,
  options: { withSynthesis?: boolean } = {},
): Promise<void> {
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
  const matrix = await stack.request("POST", `/api/projects/${projectId}/survey/matrix/build`, {});
  expect(matrix.status).toBe(200);
  if (options.withSynthesis) {
    const synthesis = await stack.request("POST", `/api/projects/${projectId}/survey/synthesis/build`, {});
    expect(synthesis.status).toBe(200);
  }
}

describe("Survey Outline HTTP", () => {
  it("POST /survey/outline/build：缺上游 → 400（先 Matrix / 先 Synthesis 指引）", async () => {
    const projectId = await createProject();
    const noMatrix = await stack.request("POST", `/api/projects/${projectId}/survey/outline/build`, {});
    expect(noMatrix.status).toBe(400);
    expect((noMatrix.body["error"] as { code: string }).code).toBe("INVALID_REQUEST");

    await seedPapersThenBuild(projectId);
    const noSynthesis = await stack.request("POST", `/api/projects/${projectId}/survey/outline/build`, {});
    expect(noSynthesis.status).toBe(400);
    expect((noSynthesis.body["error"] as { message: string }).message).toContain("survey/synthesis/build");
  });

  it("POST build 全链 → outline 带 refs；GET /:id/manuscript round-trip；405 防御", async () => {
    const projectId = await createProject();
    await seedPapersThenBuild(projectId, { withSynthesis: true });

    const wrongMethod = await stack.request("GET", `/api/projects/${projectId}/survey/outline/build`);
    expect(wrongMethod.status).toBe(405);

    const build = await stack.request("POST", `/api/projects/${projectId}/survey/outline/build`, {
      feedback: "分类章节给出 subFamily 小节要点",
    });
    expect(build.status).toBe(200);
    const outline = build.body["outline"] as {
      sections: Array<{ id: string; synthesisRefs?: string[]; literatureRefs?: string[] }>;
    };
    expect(outline.sections.length).toBeGreaterThanOrEqual(4);
    const withRefs = outline.sections.filter((section) => section.synthesisRefs !== undefined);
    expect(withRefs.length).toBeGreaterThan(0);
    const validation = build.body["validation"] as { blocking: string[]; warnings: unknown[] };
    expect(validation.blocking).toEqual([]);

    // round-trip：既有 manuscript 端点读回同一 outline（refs 保留）
    const manuscript = await stack.request("GET", `/api/projects/${projectId}/manuscript`);
    expect(manuscript.status).toBe(200);
    const loaded = manuscript.body["outline"] as typeof outline;
    expect(loaded.sections.find((section) => section.id === "taxonomy")?.synthesisRefs?.length).toBeGreaterThan(0);
  });

  it("契约两轮失败 → 422 SURVEY_OUTLINE_INVALID（不落盘）", async () => {
    const projectId = await createProject();
    await seedPapersThenBuild(projectId, { withSynthesis: true });
    const runtime = stack.stack.runtime as SurveyScriptedRuntime;
    runtime.setOutlineScript((input) => {
      const parsed = JSON.parse(defaultOutlineOutput(input)) as {
        sections: Array<{ id: string; synthesisRefs?: string[] }>;
      };
      const taxonomy = parsed.sections.find((section) => section.id === "taxonomy")!;
      taxonomy.synthesisRefs = ["SYN-doesnotex0"];
      return JSON.stringify(parsed);
    });
    try {
      const build = await stack.request("POST", `/api/projects/${projectId}/survey/outline/build`, {});
      expect(build.status).toBe(422);
      expect((build.body["error"] as { code: string }).code).toBe("SURVEY_OUTLINE_INVALID");
      const manuscript = await stack.request("GET", `/api/projects/${projectId}/manuscript`);
      expect((manuscript.body["outline"] as unknown) ?? null).toBeNull();
    } finally {
      runtime.clearOutlineScript();
    }
  });

  it("Matrix 损坏 → 500 SURVEY_MATRIX_CORRUPTED（构建拒绝，不覆盖现场）", async () => {
    const projectId = await createProject();
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(stack.root, projectId, "research", "survey.json"), "{ broken", "utf8");
    const build = await stack.request("POST", `/api/projects/${projectId}/survey/outline/build`, {});
    expect(build.status).toBe(500);
    expect((build.body["error"] as { code: string }).code).toBe("SURVEY_MATRIX_CORRUPTED");
  });
});
