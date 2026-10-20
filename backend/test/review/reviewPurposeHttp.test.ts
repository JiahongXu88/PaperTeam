/**
 * M14.9.3：POST /api/projects/:id/workflows 的 reviewPurpose 字段。
 * - 缺省不写入 request（作者稿件口径，行为不变）；
 * - published_paper_assessment 只接受 idea_to_paper，并随 run request 持久化；
 * - 已有论文返修 / Quick Review / 非法值 → 400（作者稿件流程不得借只读口径放宽实验事实守卫）；
 * - M14.9.4：只读评估 run 的规划只有 review.run → quality.gate，不进入调研 / 写作 / 修订 / 构建。
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function newStack(): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
  return startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
}

describe("POST /workflows reviewPurpose", () => {
  it("idea_to_paper 接受 published_paper_assessment 并持久化；缺省不写入；其他工作流与非法值 400", async () => {
    const stack = await newStack();
    const project = await stack.store.create("已发表论文只读评估", { researchIdea: "x" });
    const accepted = await stack.request("POST", `/api/projects/${project.id}/workflows`, { kind: "idea_to_paper", reviewPurpose: "published_paper_assessment" });
    expect(accepted.status).toBe(202);
    const run = (await stack.request("GET", `/api/runs/${accepted.body["runId"] as string}`)).body["run"] as WorkflowState;
    expect(run.request?.["reviewPurpose"]).toBe("published_paper_assessment");
    await stack.request("POST", `/api/runs/${run.runId}/cancel`, {});

    const other = await stack.store.create("缺省", { researchIdea: "y" });
    const plain = await stack.request("POST", `/api/projects/${other.id}/workflows`, { kind: "idea_to_paper" });
    expect(plain.status).toBe(202);
    const plainRun = (await stack.request("GET", `/api/runs/${plain.body["runId"] as string}`)).body["run"] as WorkflowState;
    expect(plainRun.request?.["reviewPurpose"]).toBeUndefined();
    await stack.request("POST", `/api/runs/${plainRun.runId}/cancel`, {});

    const third = await stack.store.create("返修", { researchIdea: "z" });
    for (const kind of ["existing_paper_improvement", "existing_paper_review", "topic_survey"]) {
      const rejected = await stack.request("POST", `/api/projects/${third.id}/workflows`, { kind, reviewPurpose: "published_paper_assessment" });
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.body)).toContain("reviewPurpose");
    }
    const invalid = await stack.request("POST", `/api/projects/${third.id}/workflows`, { kind: "idea_to_paper", reviewPurpose: "lenient" });
    expect(invalid.status).toBe(400);
  });

  it("M14.9.4：published_paper_assessment run 只走 review.run → quality.gate 后以 review 结束，不调研 / 写作 / 修订，稿件逐字节不变", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["fail"] });
    const stack = await startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const project = await stack.store.create("第三方已发表论文", { researchIdea: "只读评估" });
    const tex = [
      "\\documentclass{ctexart}", "\\begin{document}", "\\section*{1 对象与方法}", "调查对象为 1 200 名居民（合成文本）。",
      "\\section*{2 结果}", "患病率为 25.0\\%（300/1 200）。", "\\section*{3 讨论}", "与既往研究一致。", "\\end{document}", "",
    ].join("\n");
    const mainTex = join(stack.store.manuscriptDir(project.id), "main.tex");
    await writeFile(mainTex, tex, "utf8");
    // M14.9.5：随项目附送审前保真报告（人工 QA 疑点 1 条）与哈希绑定的人工 QA 证明
    const finding = { code: "TABLE_UNVERIFIED", severity: "soft", page: 2, detail: "T1：表头无法在文本层逐列定位" };
    const report = { schema: "paperteam.input-fidelity.report/v1", status: "REQUIRES_HUMAN_QA", sourceSha256: "a".repeat(64), projectionSha256: "b".repeat(64), reasons: ["TABLE_UNVERIFIED×1"], findings: [finding] };
    const { fidelityFindingKey } = await import("../../src/review/inputFidelityAttestation.js");
    const attestation = {
      schema: "paperteam.input-qa-attestation/v1", sourceSha256: "a".repeat(64), projectionSha256: "b".repeat(64),
      manuscriptSha256: createHash("sha256").update(tex).digest("hex"), attestedBy: "qa", attestedAt: "2026-10-20T08:00:00.000Z", method: "对照原 PDF",
      items: [{ findingKey: fidelityFindingKey(finding), code: finding.code, page: 2, region: [50, 300, 300, 360], result: "MATCHES_SOURCE" }],
    };
    const artifacts = join(stack.store.projectDir(project.id), "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "input-fidelity-report.json"), JSON.stringify(report), "utf8");
    await writeFile(join(artifacts, "input-qa-attestation.json"), JSON.stringify(attestation), "utf8");
    const started = await stack.request("POST", `/api/projects/${project.id}/workflows`, { kind: "idea_to_paper", reviewPurpose: "published_paper_assessment" });
    expect(started.status).toBe(202);
    const runId = started.body["runId"] as string;
    let run: WorkflowState;
    const deadline = Date.now() + 30_000;
    for (;;) {
      run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as WorkflowState;
      if (run.status === "completed" || run.status === "failed" || run.status === "awaiting_input") break;
      if (Date.now() > deadline) throw new Error(`run 未结束：${run.status} @ ${run.currentStage}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(run.status).toBe("completed");
    expect(run.completion?.label).toBe("review");
    expect(run.completion?.summary["reviewPurpose"]).toBe("published_paper_assessment");
    expect(run.completedStages).toEqual(["review.run", "quality.gate"]);
    expect(scripted.calls.every((call) => (call.contextScope ?? "").startsWith("review/"))).toBe(true);
    expect(await readFile(mainTex, "utf8")).toBe(tex);
    const gate = run.stageResults["quality.gate"] ?? {};
    expect(gate["passed"]).toBe(false);
    expect(String(gate["terminalMessage"])).toContain("已发表论文只读评估完成");
    expect(String(gate["terminalMessage"])).not.toContain("Draft 可用");
    const reviews = await readdir(stack.store.reviewsDir(project.id));
    expect(reviews).toContain("published-assessment-r1.json");
    const view = JSON.parse(await readFile(join(stack.store.reviewsDir(project.id), "published-assessment-r1.json"), "utf8"));
    expect(view.schema).toBe("paperteam.published-assessment/v2");
    expect(view.inputFidelity).toMatchObject({ status: "REQUIRES_HUMAN_QA", attestation: "VALID", effectiveStatus: "VALID_FOR_SCORING" });
    expect(view.academicScore.calibration).toBe("UNVALIDATED");
  });
});
