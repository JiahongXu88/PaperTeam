/**
 * M17.2.1 作者方法事实链路 HTTP 集成（真实 HTTP 服务 + 真实 Store，零模型；SYNTHETIC 夹具）：
 * 研究想法候选（未确认，不约束）→ 作者确认 mfs-0001 → workflowContext / Writer 上下文消费 → 撤销失效 →
 * 重新确认 mfs-0002 → 修改研究想法使其失效（旧事实不再支撑）。
 */

import { afterAll, describe, expect, it } from "vitest";

import { startTestStack } from "../helpers/testStack.js";
import { renderExperimentContextLines } from "../../src/writer/WriterService.js";
import { auditMethodFacts } from "../../src/experiments/methodFacts.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

const IDEA = "SYNTHETIC 研究：门控过滤模块，去掉邻域门控、λ=0.35 的规则（cfg-a）。";
const DRAFT = "本方法的规则由融合系数与邻域门控组成，其中 $\\lambda=35$。";

describe("M17.2.1 method facts over HTTP", () => {
  it("candidates do not constrain; author confirmation does; revocation and idea edits invalidate", async () => {
    const stack = await startTestStack(undefined as never, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const created = await stack.request("POST", "/api/projects", { title: "M17.2.1 synthetic", researchIdea: IDEA, workflowKind: "idea_to_paper" });
    const projectId = (created.body["project"] as { id: string }).id;
    const api = `/api/projects/${projectId}/experiment-packages/method-facts`;

    const initial = await stack.request("GET", api);
    expect(initial.status).toBe(200);
    const initialState = initial.body["state"] as { status: string; candidates: Array<{ subject: string; confirmationStatus: string }> };
    expect(initialState.status).toBe("none");
    expect(initialState.candidates.map((candidate) => candidate.subject)).toEqual(["λ", "邻域门控"]);
    const candidateContext = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(candidateContext.methodFacts?.status).toBe("none");
    expect(renderExperimentContextLines(candidateContext).join("\n")).toContain("未经作者确认");
    // 候选不约束：同一草稿无冲突 finding
    expect(auditMethodFacts([{ file: "m.tex", content: DRAFT }], await stack.stack.experimentPackages.methodFactState(projectId), { stage: "review", researchIdea: IDEA }).findings.map((finding) => finding.code)).toEqual(["METHOD_PARAM_UNSOURCED"]);

    const bad = await stack.request("PUT", api, { facts: [{ factKind: "parameter", subject: "λ", valueText: "about half" }] });
    expect(bad.status).toBe(400);

    const confirmed = await stack.request("PUT", api, { facts: [
      { factKind: "parameter", subject: "λ", aliases: ["融合系数"], valueText: "0.35", scope: ["cfg-a"] },
      { factKind: "component", subject: "邻域门控", status: "REMOVED" },
    ] });
    expect(confirmed.status).toBe(201);
    expect((confirmed.body["sheet"] as { sheetId: string }).sheetId).toBe("mfs-0001");
    const state = await stack.stack.experimentPackages.methodFactState(projectId);
    expect(state.status).toBe("valid");
    const context = await stack.stack.experimentPackages.workflowContext(projectId);
    const rendered = renderExperimentContextLines(context).join("\n");
    expect(rendered).toContain("作者确认的研究方法事实 mfs-0001");
    expect(rendered).toContain("参数 λ（又写作 融合系数） = 0.35（适用：cfg-a）");
    expect(rendered).toContain("组件「邻域门控」");
    expect(auditMethodFacts([{ file: "m.tex", content: DRAFT }], state, { stage: "review", researchIdea: IDEA }).findings.map((finding) => finding.code).sort()).toEqual(["METHOD_COMPONENT_CONFLICT", "METHOD_PARAM_CONFLICT"]);

    const revoked = await stack.request("POST", `${api}/revoke`, { reason: "方法改版" });
    expect(revoked.status).toBe(200);
    expect((revoked.body["state"] as { status: string }).status).toBe("revoked");
    const revokedContext = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(revokedContext.methodFacts?.facts).toEqual([]);
    expect(renderExperimentContextLines(revokedContext).join("\n")).toContain("已撤销");
    const revokedAudit = auditMethodFacts([{ file: "m.tex", content: DRAFT }], await stack.stack.experimentPackages.methodFactState(projectId), { stage: "review" });
    expect(revokedAudit.evaluated).toBe(false);
    expect(revokedAudit.findings.some((finding) => finding.code === "METHOD_PARAM_CONFLICT")).toBe(false);

    const again = await stack.request("PUT", api, { facts: [{ factKind: "parameter", subject: "λ", valueText: "0.35" }] });
    expect((again.body["sheet"] as { sheetId: string }).sheetId).toBe("mfs-0002");
    expect(((await stack.request("GET", api)).body["sheets"] as unknown[]).length).toBe(2);

    const patched = await stack.request("PATCH", `/api/projects/${projectId}`, { researchIdea: `${IDEA} 已改版。` });
    expect(patched.status).toBe(200);
    const stale = await stack.stack.experimentPackages.methodFactState(projectId);
    expect(stale.status).toBe("stale");
    expect((await stack.stack.experimentPackages.workflowContext(projectId)).methodFacts?.facts).toEqual([]);
  });
});
