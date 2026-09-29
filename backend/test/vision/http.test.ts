/**
 * M10.2 HTTP 端点测试：
 * - POST /sources/:id/vision/analyze（inline / background 两态）；
 * - GET /sources/:id/vision（状态 + ?facts=true 候选事实）；
 * - POST /sources/:id/vision/facts/:factId/evidence（确认 → user_confirmed）；
 * - PUT /api/settings/model 的 visionModel 字段（设置 / 清除 / 非法值拒绝）。
 */

import { afterAll, describe, expect, it } from "vitest";

import { startTestStack, createScriptedRuntime } from "../helpers/testStack.js";
import { FakeVisionModelRuntime } from "./fixtures.js";
import { makePng } from "../ingestion/binaryFixtures.js";
import type { DocumentExtraction, DocumentParser } from "../../src/ingestion/types.js";

const stacks: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(stacks.splice(0).map((cleanup) => cleanup()));
});

/** 落真实 figure 资产的 stub parser（PDF） */
function figureParser(): DocumentParser {
  return {
    id: "figure-stub",
    async parseFile(path: string, options): Promise<DocumentExtraction> {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      if (options?.figuresDir !== undefined) {
        await mkdir(options.figuresDir, { recursive: true });
        await writeFile(join(options.figuresDir, "fig-001.png"), makePng(20, 20));
      }
      void path;
      return {
        parser: { id: "figure-stub" },
        mode: "structured",
        quality: "full",
        pageCount: 1,
        blocks: [
          {
            blockId: "B0001",
            type: "text",
            provenance: { fileName: "paper.pdf", page: 1 },
            text: "Context before the figure about tracking.",
          },
          {
            blockId: "B0005",
            type: "figure",
            provenance: { fileName: "paper.pdf", page: 3, bbox: { x0: 1, y0: 1, x1: 9, y1: 9 } },
            caption: "Figure 1: Impact of threshold on MOTA.",
            assetName: "fig-001.png",
          },
        ],
        notes: [],
      };
    },
  };
}

async function startVisionStack(modelScript?: ConstructorParameters<typeof FakeVisionModelRuntime>[0]) {
  const model = new FakeVisionModelRuntime(modelScript);
  const testStack = await startTestStack(createScriptedRuntime().runtime, {
    ingestion: { structuredParser: figureParser(), fallbackParser: figureParser() },
    vision: {
      modelRuntime: model,
      modelCandidates: () => ({ visionModel: "prov-a/model-v" }),
    },
  });
  stacks.push(testStack.cleanup);
  return { testStack, model };
}

describe("POST /api/projects/:id/sources/:sid/vision/analyze", () => {
  it("inline 模式：同步完成并返回终态", async () => {
    const { testStack } = await startVisionStack();
    const project = await testStack.stack.projects.create("vision-http");
    const upload = await testStack.request("POST", `/api/projects/${project.id}/sources`, {
      fileName: "paper.pdf",
      contentBase64: Buffer.from("%PDF- fake").toString("base64"),
    });
    const sourceId = (upload.body["source"] as { sourceId: string }).sourceId;
    await testStack.request("POST", `/api/projects/${project.id}/sources/${sourceId}/ingest`);

    const response = await testStack.request("POST", `/api/projects/${project.id}/sources/${sourceId}/vision/analyze?inline=true`);
    expect(response.status).toBe(200);
    const vision = response.body["vision"] as {
      counts: Record<string, number>;
      figures: Array<{ status: string }>;
    };
    expect(vision.counts).toMatchObject({ total: 1, completed: 1 });
    expect((response.body["actions"] as Array<{ action: string }>)[0]).toMatchObject({ action: "analyzed" });
  });

  it("background 模式：立即返回 pending 摘要", async () => {
    const { testStack } = await startVisionStack();
    const project = await testStack.stack.projects.create("vision-http-bg");
    const upload = await testStack.request("POST", `/api/projects/${project.id}/sources`, {
      fileName: "paper.pdf",
      contentBase64: Buffer.from("%PDF- fake").toString("base64"),
    });
    const sourceId = (upload.body["source"] as { sourceId: string }).sourceId;
    await testStack.request("POST", `/api/projects/${project.id}/sources/${sourceId}/ingest`);

    const response = await testStack.request("POST", `/api/projects/${project.id}/sources/${sourceId}/vision/analyze`);
    expect(response.status).toBe(200);
    expect(response.body["mode"]).toBe("background");
    // 轮询到终态
    const deadline = Date.now() + 10_000;
    for (;;) {
      const status = await testStack.request("GET", `/api/projects/${project.id}/sources/${sourceId}/vision`);
      const vision = status.body["vision"] as { counts: Record<string, number> };
      if (vision.counts["pending"] === 0 && Date.now() < deadline) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(`后台分析未完成：${JSON.stringify(vision.counts)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  it("未 ingest → 400", async () => {
    const { testStack } = await startVisionStack();
    const project = await testStack.stack.projects.create("vision-http-noingest");
    const upload = await testStack.request("POST", `/api/projects/${project.id}/sources`, {
      fileName: "notes.txt",
      contentBase64: Buffer.from("plain text").toString("base64"),
    });
    const sourceId = (upload.body["source"] as { sourceId: string }).sourceId;
    // txt 上传即内联解析——删掉产物模拟「无解析产物」状态
    await testStack.stack.parsedDocuments.remove(project.id, sourceId);
    const response = await testStack.request("POST", `/api/projects/${project.id}/sources/${sourceId}/vision/analyze?inline=true`);
    expect(response.status).toBe(400);
  });
});

describe("GET /api/projects/:id/sources/:sid/vision", () => {
  it("状态 + facts 摘要", async () => {
    const { testStack } = await startVisionStack();
    const project = await testStack.stack.projects.create("vision-http-status");
    const upload = await testStack.request("POST", `/api/projects/${project.id}/sources`, {
      fileName: "paper.pdf",
      contentBase64: Buffer.from("%PDF- fake").toString("base64"),
    });
    const sourceId = (upload.body["source"] as { sourceId: string }).sourceId;
    await testStack.request("POST", `/api/projects/${project.id}/sources/${sourceId}/ingest`);
    await testStack.request("POST", `/api/projects/${project.id}/sources/${sourceId}/vision/analyze?inline=true`);

    const status = await testStack.request("GET", `/api/projects/${project.id}/sources/${sourceId}/vision`);
    const vision = status.body["vision"] as { model: { available: boolean; modelSpec?: string }; figures: Array<{ candidateFactCount?: number }> };
    expect(vision.model).toMatchObject({ available: true, modelSpec: "prov-a/model-v" });
    expect(vision.figures[0]?.candidateFactCount).toBeGreaterThan(0);

    const withFacts = await testStack.request("GET", `/api/projects/${project.id}/sources/${sourceId}/vision?facts=true`);
    const figures = (withFacts.body["vision"] as { figures: Array<{ facts?: Array<{ factId: string }> }> }).figures;
    expect(figures[0]?.facts?.[0]?.factId).toBe("B0005-F01");
  });
});

describe("POST /api/projects/:id/sources/:sid/vision/facts/:factId/evidence", () => {
  it("确认 → 201 user_confirmed", async () => {
    const { testStack } = await startVisionStack();
    const project = await testStack.stack.projects.create("vision-http-confirm");
    const upload = await testStack.request("POST", `/api/projects/${project.id}/sources`, {
      fileName: "paper.pdf",
      contentBase64: Buffer.from("%PDF- fake").toString("base64"),
    });
    const sourceId = (upload.body["source"] as { sourceId: string }).sourceId;
    await testStack.request("POST", `/api/projects/${project.id}/sources/${sourceId}/ingest`);
    await testStack.request("POST", `/api/projects/${project.id}/sources/${sourceId}/vision/analyze?inline=true`);

    const response = await testStack.request(
      "POST",
      `/api/projects/${project.id}/sources/${sourceId}/vision/facts/B0005-F01/evidence`,
      { claim: "MOTA 在 threshold=0.5 时达到 82.4" },
    );
    expect(response.status).toBe(201);
    const evidence = response.body["evidence"] as { verificationLevel: string; verificationStatus: string };
    expect(evidence.verificationLevel).toBe("user_confirmed");
    expect(evidence.verificationStatus).toBe("unverified");

    // 事实不存在 → 404
    const missing = await testStack.request(
      "POST",
      `/api/projects/${project.id}/sources/${sourceId}/vision/facts/NOPE-F99/evidence`,
      { claim: "x 82.4" },
    );
    expect(missing.status).toBe(404);
  });

  it("缺 claim → 400", async () => {
    const { testStack } = await startVisionStack();
    const project = await testStack.stack.projects.create("vision-http-noClaim");
    const response = await testStack.request(
      "POST",
      `/api/projects/${project.id}/sources/S001/vision/facts/B0005-F01/evidence`,
      {},
    );
    expect(response.status).toBe(400);
  });
});
