/**
 * M16 后续 · 生产入口验收：POST /review → POST /quality-gate → GET /quality-gate 的真实链路中，
 * 审稿 finding 经确定性证书核验后作为 L1 已核验缺陷出现在 gate 规则、QualityReport 与 API 摘要中；
 * 证书核验不成立的 finding 不升级（零模型，scripted runtime 注入审稿 finding）。
 */
import { afterAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";
import { SAMCP_TEX } from "../review/fixtures/verifiedFindingsFixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const MISMATCH = {
  category: "fact",
  severity: "major",
  section: "Experiments",
  description: "Text–table numeric mismatch for COCO→Cityscapes: the prose states 40.6 PQ and 47.5 mIoU, but Table 1's SAM-CP row lists PQ 41.0 and mIoU 47.9.",
  suggestedAction: "Reconcile prose and Table 1.",
  reason: "Table 1 contradicts the prose.",
  evidenceRequirement: "required",
  blocking: false,
  verification: "VERIFIED_IN_TEXT",
  quote: "SAM-CP achieves a $40.6\\%$ PQ, a $29.3\\%$ AP and a $47.5\\%$ mIoU",
  file: "main.tex",
};

async function runGate(issue: Record<string, unknown>, tex: string): Promise<{ stack: TestStack; projectId: string; body: Record<string, unknown> }> {
  const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"], everyRoundFactIssue: issue });
  const stack = await startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
  const created = await stack.request("POST", "/api/projects", { title: "verified findings", workflowKind: "idea_to_paper" });
  const projectId = (created.body["project"] as { id: string }).id;
  const imported = await stack.request("POST", `/api/projects/${projectId}/import`, {
    files: [{ path: "main.tex", contentBase64: Buffer.from(tex, "utf8").toString("base64") }],
  });
  expect(imported.status).toBe(200);
  expect((await stack.request("POST", `/api/projects/${projectId}/review`)).status).toBe(200);
  expect((await stack.request("POST", `/api/projects/${projectId}/quality-gate`)).status).toBe(200);
  const got = await stack.request("GET", `/api/projects/${projectId}/quality-gate`);
  expect(got.status).toBe(200);
  return { stack, projectId, body: got.body };
}

type Rule = { rule: string; status: string; required: boolean; detail: string };

describe("verified findings · production gate entry", () => {
  it("certified text–table contradiction → review_findings_certified FAIL (L1 deterministic) + API summary with certificate", async () => {
    const { body, stack, projectId } = await runGate(MISMATCH, SAMCP_TEX);
    const gate = body["gate"] as { rules: Rule[]; passed: boolean; verifiedFindings?: { status: string; summary: { verifiedContradicted: number; sourceVerification: string }; records: Array<{ status: string; statement: string | null; checks: Array<{ kind: string; outcome: string; counterpart?: { raw: string } }> }> } };
    const rule = gate.rules.find((entry) => entry.rule === "review_findings_certified");
    expect(rule).toMatchObject({ status: "FAIL", required: true });
    expect(rule!.detail).toContain("41.0");
    expect(gate.passed).toBe(false);
    expect(gate.verifiedFindings?.status).toBe("EVALUATED");
    expect(gate.verifiedFindings?.summary).toMatchObject({ verifiedContradicted: 1, sourceVerification: "AUTHOR_SOURCE" });
    const record = gate.verifiedFindings!.records.find((entry) => entry.status === "VERIFIED_CONTRADICTED")!;
    expect(record.checks.some((check) => check.kind === "TEXT_TABLE_VALUE" && check.outcome === "CONTRADICTED" && check.counterpart?.raw === "41.0")).toBe(true);
    const report = body["qualityReport"] as { layers: Record<string, { status: string; items: Array<{ id: string; status: string; evidenceGrade: string }> }> };
    const l1 = report.layers["L1"]!;
    expect(l1.items.find((item) => item.id === "review_findings_certified")).toMatchObject({ status: "FAIL", evidenceGrade: "deterministic" });
    expect(l1.status).toBe("FAIL");
    // Journal Assessment 消费同一 QualityReport：已核验缺陷 → 阻断，且不会宣称达刊
    const evaluated = await stack.request("POST", `/api/projects/${projectId}/target/journal-assessment`, { name: "中国图象图形学报", articleType: "research" });
    expect(evaluated.status).toBe(200);
    const assessment = evaluated.body["assessment"] as { summary: { verdict: string; reasons?: string[] }; riskFindings?: Array<{ source: string; evidenceLevel: string; qualityLayer?: string; title: string }> };
    expect(assessment.summary.verdict).toBe("BLOCKED_BY_VERIFIED_ISSUE");
    expect(assessment.riskFindings?.some((risk) => risk.source === "quality_report" && risk.evidenceLevel === "verified" && risk.qualityLayer === "L1")).toBe(true);
  });

  it("finding whose numbers agree with the table is not upgraded; rule never reports PASS", async () => {
    const consistent = SAMCP_TEX.replace("$40.6\\%$ PQ", "$41.0\\%$ PQ").replace("$47.5\\%$ mIoU", "$47.9\\%$ mIoU");
    const { body } = await runGate({ ...MISMATCH, quote: "SAM-CP achieves a $41.0\\%$ PQ, a $29.3\\%$ AP and a $47.9\\%$ mIoU" }, consistent);
    const gate = body["gate"] as { rules: Rule[]; verifiedFindings?: { summary: { verifiedContradicted: number } } };
    const rule = gate.rules.find((entry) => entry.rule === "review_findings_certified")!;
    expect(rule.status).toBe("NOT_APPLICABLE");
    expect(gate.verifiedFindings?.summary.verifiedContradicted).toBe(0);
  });
});
