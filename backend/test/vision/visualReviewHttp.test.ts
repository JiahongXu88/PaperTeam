/**
 * M12.2 B3/B4 HTTP 路由测试：visual-reviews（latest/run）+ 图资产服务
 * （source 抽图 / 生成图 PDF）——契约见 docs/research/M12_BATCH2_TRACK_B_HANDOFF.md §2。
 * 使用完整服务栈（scripted runtime；未配置 vision → 确定性-only 合法路径）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";
import type { ParsedDocument } from "../../src/ingestion/types.js";
import type { GeneratedFigureRecord } from "../../src/figures/figureStore.js";
import { FigureStore } from "../../src/figures/figureStore.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime();
  return startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
}

/** 1×1 PNG（最小合法头 + IHDR + IEND；内容无关紧要，路由只按字节返回） */
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

function minimalParsedDocument(sourceId: string, assetName: string): ParsedDocument {
  return {
    schemaVersion: 1,
    sourceId,
    fileName: "sample.txt",
    storedFileName: `${sourceId}-sample.txt`,
    kind: "text",
    mimeType: "text/plain",
    parser: { id: "fixture" },
    parseMode: "structured",
    status: "ok",
    blocks: [
      {
        blockId: "B0001",
        type: "text",
        text: "Figure 1 shows the pipeline.",
        provenance: { fileName: `${sourceId}-sample.pdf`, page: 1 },
      },
      {
        blockId: "B0002",
        type: "figure",
        caption: "The sample pipeline.",
        assetName,
        provenance: { fileName: `${sourceId}-sample.pdf`, page: 1 },
      },
    ],
    counts: { text: 1, table: 0, figure: 1, formula: 0, structured_record: 0, code: 0, output: 0 },
    notes: [],
    contentHash: "fixture-hash",
    parsedAt: new Date("2026-10-07T00:00:00Z").toISOString(),
  };
}

describe("visual-reviews 路由", () => {
  it("从未运行 → latest 返回 {report:null}；非法项目 404", async () => {
    const stack = await newStack();
    const created = await stack.request("POST", "/api/projects", {
      title: "视觉路由测试",
      researchIdea: "idea",
      workflowKind: "idea_to_paper",
    });
    expect(created.status).toBe(201);
    const projectId = (created.body["project"] as { id: string }).id;

    const missing = await stack.request("GET", "/api/projects/p-nonexistent00/visual-reviews/latest");
    expect(missing.status).toBe(404);

    const latest = await stack.request("GET", `/api/projects/${projectId}/visual-reviews/latest`);
    expect(latest.status).toBe(200);
    expect(latest.body["report"]).toBeNull();
  });

  it("run 产出确定性-only 报告并落盘；latest 随后可读", async () => {
    const stack = await newStack();
    const created = await stack.request("POST", "/api/projects", {
      title: "视觉运行测试",
      researchIdea: "idea",
      workflowKind: "idea_to_paper",
    });
    const projectId = (created.body["project"] as { id: string }).id;

    // 手稿：Agent B 的 visual-review-sample 夹具（恰 5 findings 断言面的同一份）
    const fixture = readFileSync(
      join(import.meta.dirname, "..", "fixtures", "manuscript", "visual-review-sample", "main.tex"),
      "utf8",
    );
    const manuscriptDir = stack.stack.projects.manuscriptDir(projectId);
    await mkdir(manuscriptDir, { recursive: true });
    await writeFile(join(manuscriptDir, "main.tex"), fixture, "utf8");

    const run = await stack.request("POST", `/api/projects/${projectId}/visual-reviews/run`);
    expect(run.status).toBe(200);
    const report = run.body["report"] as {
      round: number;
      findings: Array<{ category: string }>;
      capability: { visionAvailable: boolean; skippedChecks: string[] };
      checks: Array<{ kind: string }>;
    };
    expect(report.round).toBe(1);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every((finding) => finding.category === "visual")).toBe(true);
    // 测试栈未配置 vision → 确定性-only（capability 如实，四项 vision 检查 skipped）
    expect(report.capability.visionAvailable).toBe(false);
    expect(report.capability.skippedChecks.length).toBe(4);
    expect(report.checks.some((check) => check.kind === "deterministic")).toBe(true);

    const latest = await stack.request("GET", `/api/projects/${projectId}/visual-reviews/latest`);
    expect(latest.status).toBe(200);
    expect((latest.body["report"] as { round: number } | null)?.round).toBe(1);
  });
});

describe("图资产路由（B4）", () => {
  it("登记内的 source 抽图 → 200 PNG；遍历/未登记 → 400/404", async () => {
    const stack = await newStack();
    const created = await stack.request("POST", "/api/projects", {
      title: "图资产路由测试",
      researchIdea: "idea",
      workflowKind: "idea_to_paper",
    });
    const projectId = (created.body["project"] as { id: string }).id;

    const uploaded = await stack.request("POST", `/api/projects/${projectId}/sources`, {
      fileName: "sample.txt",
      contentBase64: Buffer.from("plain text source for figure asset route test", "utf8").toString(
        "base64",
      ),
      sourceRole: "evidence",
    });
    expect(uploaded.status).toBe(201);
    const sourceId = (uploaded.body["source"] as { sourceId: string }).sourceId;

    await stack.stack.parsedDocuments.save(projectId, minimalParsedDocument(sourceId, "fig-001.png"));
    const figuresDir = stack.stack.parsedDocuments.figuresDir(projectId, sourceId);
    await mkdir(figuresDir, { recursive: true });
    await writeFile(join(figuresDir, "fig-001.png"), TINY_PNG);

    const ok = await fetch(
      `http://127.0.0.1:${stack.port()}/api/projects/${projectId}/sources/${sourceId}/figures/fig-001.png`,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await ok.arrayBuffer()).equals(TINY_PNG)).toBe(true);

    // 遍历 / 非法形态 → 400 invalid_path（注：裸 ".." / "%2E%2E" 点段会被
    // URL 解析层归一化吞掉、到不了路由——无害；这里测能到达 handler 的形态）
    for (const name of ["..%2Ffig-001.png", "a%2Fb.png", ".hidden.png"]) {
      const bad = await fetch(
        `http://127.0.0.1:${stack.port()}/api/projects/${projectId}/sources/${sourceId}/figures/${name}`,
      );
      expect(bad.status, `case ${name}`).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_path");
    }

    // 未在 ParsedDocument 登记（重解析残留）→ 404 stale_asset
    await writeFile(join(figuresDir, "fig-999.png"), TINY_PNG);
    const stale = await fetch(
      `http://127.0.0.1:${stack.port()}/api/projects/${projectId}/sources/${sourceId}/figures/fig-999.png`,
    );
    expect(stale.status).toBe(404);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("stale_asset");

    // 扩展名不在白名单 → 400 unsupported_asset
    await writeFile(join(figuresDir, "fig-001.svg"), Buffer.from("<svg/>"));
    const unsupported = await fetch(
      `http://127.0.0.1:${stack.port()}/api/projects/${projectId}/sources/${sourceId}/figures/fig-001.svg`,
    );
    expect(unsupported.status).toBe(400);
    expect(((await unsupported.json()) as { error: { code: string } }).error.code).toBe(
      "unsupported_asset",
    );
  });

  it("manifest 登记内的生成图 PDF → 200；未登记 → 404", async () => {
    const stack = await newStack();
    const created = await stack.request("POST", "/api/projects", {
      title: "生成图路由测试",
      researchIdea: "idea",
      workflowKind: "idea_to_paper",
    });
    const projectId = (created.body["project"] as { id: string }).id;

    const store = new FigureStore(
      join(stack.stack.projects.manuscriptDir(projectId), "figs", "generated"),
    );
    const record: GeneratedFigureRecord = {
      figId: "fig-abcdef123456",
      kind: "plot",
      specHash: "a".repeat(64),
      datasetHash: "b".repeat(64),
      dataOrigin: { origin: "manual", note: "fixture" },
      assets: { tex: "fig-abcdef123456.tex", pdf: "fig-abcdef123456.pdf" },
      caption: "fixture plot",
      createdAt: new Date("2026-10-07T00:00:00Z").toISOString(),
    };
    await store.persistFigure({
      record,
      spec: {},
      tex: "% fixture",
      pdfBytes: Buffer.from("%PDF-1.4\n%%EOF\n"),
    });

    const ok = await fetch(
      `http://127.0.0.1:${stack.port()}/api/projects/${projectId}/figures/generated/fig-abcdef123456.pdf`,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");

    // 盘上存在但不在 manifest → stale_asset（404）
    const genDir = join(stack.stack.projects.manuscriptDir(projectId), "figs", "generated");
    await writeFile(join(genDir, "fig-000000000000.pdf"), Buffer.from("%PDF-1.4\n%%EOF\n"));
    const stale = await fetch(
      `http://127.0.0.1:${stack.port()}/api/projects/${projectId}/figures/generated/fig-000000000000.pdf`,
    );
    expect(stale.status).toBe(404);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("stale_asset");
  });
});
