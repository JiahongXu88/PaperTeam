import { afterEach, describe, expect, it } from "vitest";

import type { PdfParser } from "../../src/paper/PdfParser.js";
import type { DocumentExtraction } from "../../src/ingestion/types.js";
import { stubParser } from "../ingestion/fixtures.js";
import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";
import { ABLATION_PAPER, ABLATION_THESIS } from "./fixtures.js";

const stacks: TestStack[] = [];
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.cleanup()));
});

/** 按文件名脚本化的 docling fake（HTTP 栈内 PDF 上传走后台 ingestion） */
const structuredParser = stubParser("docling-fake", (absolutePath): DocumentExtraction => {
  const paper = absolutePath.includes("cvpr19");
  return {
    parser: { id: "docling", version: "fake" },
    mode: "structured",
    quality: "full",
    pageCount: paper ? 11 : 124,
    blocks: [paper ? ABLATION_PAPER : ABLATION_THESIS],
    notes: [],
  };
});

/** PyMuPDF 文本层 fake（来源核验独立通道） */
const paperParser: PdfParser = {
  id: "pymupdf-fake",
  async parseFile(absolutePath) {
    const paper = absolutePath.includes("cvpr19");
    return {
      ok: true,
      parser: { id: "pymupdf-fake" },
      pageCount: paper ? 11 : 124,
      title: "",
      abstract: "",
      toc: [],
      blocks: [paper ? { page: 8, text: "0.724 0.603 0.092\n0.684 0.593 0.103\n0.667 0.541 0.132" } : { page: 63, text: "0.699 0.630 0.098\n0.684 0.593 0.103\n0.667 0.541 0.132" }],
      totalChars: 60,
      notes: [],
    };
  },
  async checkAvailability() {
    return { available: true, command: "fake", args: [] } as never;
  },
};

describe("M14.1b HTTP：/api/projects/:id/research-inputs", () => {
  it("注册 → 抽取 → 核验 → 冲突 → 作者决定 → planner-context 全链路（文件后端，重启可见）", async () => {
    const stack = await startTestStack(scriptedIdeaRuntime().runtime, { ingestion: { structuredParser }, paperParser });
    stacks.push(stack);
    const created = await stack.request("POST", "/api/projects", { title: "M14.1b http" });
    const projectId = (created.body["project"] as { id: string }).id;
    const upload = async (fileName: string, body: string) =>
      stack.request("POST", `/api/projects/${projectId}/sources`, { fileName, contentBase64: Buffer.from(`%PDF-1.5 ${body}`).toString("base64") });
    const paperSource = (await upload("cvpr19.pdf", "paper")).body["source"] as { sourceId: string };
    const thesisSource = (await upload("thesis.pdf", "thesis")).body["source"] as { sourceId: string };
    await stack.stack.ingestion.drainBackground();

    // 非法类型 400
    const bad = await stack.request("POST", `/api/projects/${projectId}/research-inputs`, { sourceId: paperSource.sourceId, inputType: "blog_post" });
    expect(bad.status).toBe(400);

    const reg1 = await stack.request("POST", `/api/projects/${projectId}/research-inputs`, {
      sourceId: paperSource.sourceId,
      inputType: "published_paper",
      title: "Shifting More Attention to VSOD",
      doi: "10.1109/CVPR.2019.00875",
      publicationStatus: { value: "published" },
    });
    expect(reg1.status).toBe(201);
    const paperInput = (reg1.body["input"] as { inputId: string; parse: { status: string } });
    expect(paperInput.parse.status).toBe("full_text");
    // 重复注册 → 200 created=false
    const reg1Again = await stack.request("POST", `/api/projects/${projectId}/research-inputs`, { sourceId: paperSource.sourceId, inputType: "published_paper" });
    expect(reg1Again.status).toBe(200);
    expect(reg1Again.body["created"]).toBe(false);
    const reg2 = await stack.request("POST", `/api/projects/${projectId}/research-inputs`, { sourceId: thesisSource.sourceId, inputType: "unpublished_manuscript", title: "学位论文稿", versionLabel: "defense copy" });
    const thesisInput = reg2.body["input"] as { inputId: string };

    const list = await stack.request("GET", `/api/projects/${projectId}/research-inputs`);
    expect((list.body["inputs"] as unknown[]).length).toBe(2);

    for (const id of [paperInput.inputId, thesisInput.inputId]) {
      const extract = await stack.request("POST", `/api/projects/${projectId}/research-inputs/${id}/extract`);
      expect(extract.status).toBe(200);
      expect(extract.body["created"]).toBe(9);
      const verify = await stack.request("POST", `/api/projects/${projectId}/research-inputs/${id}/verify`);
      expect(verify.body).toMatchObject({ checked: 9, verified: 9, textLayerAvailable: true });
    }
    const detect = await stack.request("POST", `/api/projects/${projectId}/research-inputs/conflicts/detect`, {});
    expect(detect.status).toBe(200);
    expect((detect.body["conflicts"] as { created: number }).created).toBe(3);
    const conflicts = (await stack.request("GET", `/api/projects/${projectId}/research-inputs/conflicts?status=unresolved`)).body["conflicts"] as Array<{ conflictId: string; parties: Array<{ factId: string; researchInputId: string }> }>;
    expect(conflicts).toHaveLength(3);

    // 作者决定：actor 缺省 user；模型不能冒充
    const decisionBad = await stack.request("POST", `/api/projects/${projectId}/research-inputs/decisions`, { payload: { type: "nonsense" } });
    expect(decisionBad.status).toBe(400);
    const include = await stack.request("POST", `/api/projects/${projectId}/research-inputs/decisions`, { decisionId: "http-include-1", payload: { type: "scope_decision", inputId: paperInput.inputId, scope: "included" } });
    expect(include.status).toBe(201);
    expect((include.body["decision"] as { actor: { kind: string } }).actor.kind).toBe("user");
    const dup = await stack.request("POST", `/api/projects/${projectId}/research-inputs/decisions`, { decisionId: "http-include-1", payload: { type: "scope_decision", inputId: paperInput.inputId, scope: "excluded" } });
    expect(dup.status).toBe(200);
    expect(dup.body["duplicate"]).toBe(true);
    const adopted = conflicts[0]!.parties.find((party) => party.researchInputId === paperInput.inputId)!.factId;
    const resolve = await stack.request("POST", `/api/projects/${projectId}/research-inputs/decisions`, {
      actor: { kind: "test_fixture", note: "HTTP 测试模拟" },
      payload: { type: "conflict_resolution", conflictId: conflicts[0]!.conflictId, decision: "adopt_fact", adoptedFactId: adopted },
    });
    expect(resolve.status).toBe(201);

    const context = (await stack.request("GET", `/api/projects/${projectId}/research-inputs/planner-context`)).body as {
      facts: Record<string, unknown[]>;
      writingBlockers: string[];
      inputs: { included: unknown[]; proposed: unknown[] };
    };
    expect(context.inputs.included).toHaveLength(1);
    expect(context.inputs.proposed).toHaveLength(1);
    // 论文 9 条事实中 2 条仍处于未决冲突（另一条已裁决）
    expect(context.facts["conflicted"]).toHaveLength(2);
    expect(context.facts["sourceVerifiedUnconfirmed"]).toHaveLength(7);
    expect(context.writingBlockers.filter((blocker) => blocker.startsWith("CONFLICT_UNRESOLVED"))).toHaveLength(2);

    const view = await stack.request("GET", `/api/projects/${projectId}/research-inputs/${paperInput.inputId}`);
    expect((view.body["factCounts"] as { total: number; conflicted: number }).total).toBe(9);
    const facts = await stack.request("GET", `/api/projects/${projectId}/research-inputs/facts?inputId=${paperInput.inputId}&verification=source_verified`);
    expect((facts.body["facts"] as unknown[]).length).toBe(9);
    const decisions = await stack.request("GET", `/api/projects/${projectId}/research-inputs/decisions`);
    expect((decisions.body["decisions"] as unknown[]).length).toBe(2);

    // 405 / 404
    expect((await stack.request("PUT", `/api/projects/${projectId}/research-inputs`)).status).toBe(405);
    expect((await stack.request("GET", `/api/projects/${projectId}/research-inputs/ri-000000000000`)).status).toBe(404);
  });
});
