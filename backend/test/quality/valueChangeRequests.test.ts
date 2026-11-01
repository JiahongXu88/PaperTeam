/**
 * M15 长程 A3（R4）：审稿驱动修订改动作者冻结数值的逐项结构化授权。
 *
 * 负例：无批准 → 拒绝；Planner / 模型文本不产生批准；伪造 / 陈旧 boundHash、计划外请求 → 409；硬禁改下不生成请求；
 *       含越界等其它违规的候选不生成请求；旧值多次出现（批准范围不唯一）不生成请求。
 * 正例：作者经 HTTP 决策通道批准该值对 → 后续写入的系统修订契约精确放行该值对，其它值仍受保护。
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import { systemRevisionPolicyContract, validateCandidateEdit, buildEditContract } from "../../src/quality/editContract.js";
import { saveEditContracts, updateEditContractStore, loadEditContractStore } from "../../src/quality/editContractStore.js";
import {
  applyValueChangeDecisions,
  approvedValueChangesForWrite,
  deriveValueChangeRequests,
  mergeValueChangeRequests,
} from "../../src/quality/valueChangeRequests.js";
import { contractsForWrite } from "../../src/workflow/editContractEnforcement.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 60_000 });

const TARGET = "sections/results.tex";
const BASE = "Our tracker reaches 61.2 MOTA and 58.4 IDF1. Training uses 30 epochs.";
const CANDIDATE = "Our tracker reaches 61.7 MOTA and 58.4 IDF1. Training uses 30 epochs.";

function tail(baseline: string, approved: ReturnType<typeof approvedValueChangesForWrite> = []) {
  return contractsForWrite({
    projectId: "p", runId: "w-1", stageId: "revision.revise", target: TARGET, carrier: "file",
    baseContent: baseline, frozenContent: baseline, auditContracts: [], improvementContracts: [], approvedValueChanges: approved,
  });
}

function derive(baseline: string, candidate: string, contracts = tail(baseline)) {
  const verdict = validateCandidateEdit({ target: TARGET, baseline, candidate, contracts });
  return { verdict, requests: deriveValueChangeRequests({ target: TARGET, baseline, candidate, verdict, contracts, runId: "w-1", stageId: "revision.revise", baseRevision: 3, now: "2026-11-01T00:00:00.000Z" }) };
}

describe("R4 纯函数：请求派生 / 决策 / 生效", () => {
  it("无批准 → 拒绝并登记 pending 请求（旧值 / 新值 / 所在句 / 基线哈希）；请求本身不授权", () => {
    const { verdict, requests } = derive(BASE, CANDIDATE);
    expect(verdict.ok).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ target: TARGET, before: "61.2", after: "61.7", status: "pending", baseRevision: 3 });
    expect(requests[0]!.context).toContain("61.2 MOTA");
    // pending 请求不生效
    expect(approvedValueChangesForWrite(requests, TARGET, BASE)).toEqual([]);
  });

  it("作者批准（boundHash 匹配）→ 后续写入精确放行该值对；其它冻结值仍受保护", () => {
    const { requests } = derive(BASE, CANDIDATE);
    const decided = applyValueChangeDecisions(requests, [{ requestId: requests[0]!.requestId, decision: "approve", boundHash: requests[0]!.boundHash }], "appr-vcr-1", "2026-11-01T01:00:00.000Z");
    const approved = approvedValueChangesForWrite(decided, TARGET, BASE);
    expect(approved).toEqual([expect.objectContaining({ before: "61.2", after: "61.7", approvalId: "appr-vcr-1" })]);
    expect(validateCandidateEdit({ target: TARGET, baseline: BASE, candidate: CANDIDATE, contracts: tail(BASE, approved) }).ok).toBe(true);
    const alsoOther = "Our tracker reaches 61.7 MOTA and 59.0 IDF1. Training uses 30 epochs.";
    expect(validateCandidateEdit({ target: TARGET, baseline: BASE, candidate: alsoOther, contracts: tail(BASE, approved) }).ok).toBe(false);
    // 其它目标不生效；批准后旧值已改掉 → 自然失效
    expect(approvedValueChangesForWrite(decided, "sections/other.tex", BASE)).toEqual([]);
    expect(approvedValueChangesForWrite(decided, TARGET, CANDIDATE)).toEqual([]);
  });

  it("伪造 / 陈旧 boundHash、计划外 requestId、重复决策 → 拒绝（整批不生效）", () => {
    const { requests } = derive(BASE, CANDIDATE);
    const id = requests[0]!.requestId;
    expect(() => applyValueChangeDecisions(requests, [{ requestId: id, decision: "approve", boundHash: "0".repeat(64) }], "a", "t")).toThrow(/哈希不符/);
    expect(() => applyValueChangeDecisions(requests, [{ requestId: "vcr-forged", decision: "approve", boundHash: requests[0]!.boundHash }], "a", "t")).toThrow(/不存在/);
    const tampered = [{ ...requests[0]!, after: "99.9" }];
    expect(() => applyValueChangeDecisions(tampered, [{ requestId: id, decision: "approve", boundHash: tampered[0]!.boundHash }], "a", "t")).toThrow(/哈希不符/);
    const once = applyValueChangeDecisions(requests, [{ requestId: id, decision: "reject", boundHash: requests[0]!.boundHash }], "a", "t");
    expect(() => applyValueChangeDecisions(once, [{ requestId: id, decision: "approve", boundHash: requests[0]!.boundHash }], "a", "t")).toThrow(/不可再决策/);
  });

  it("不生成请求的情形：硬禁改 / 其它违规 / 旧值多次出现 / 无法配对", () => {
    const hard = buildEditContract({
      projectId: "p", source: { kind: "target_audit_rewrite", ref: "x" }, authority: [{ kind: "frozen_protocol", ref: "t" }],
      target: { carrier: "file", file: TARGET, baseContent: BASE },
      constraints: { numericProtect: "all_existing", allowNewValues: false, hardNumericFreeze: true, citationPolicy: "preserve_existing_no_new" },
    });
    expect(derive(BASE, CANDIDATE, [...tail(BASE), hard]).requests).toEqual([]);
    const anchored = buildEditContract({
      projectId: "p", source: { kind: "improvement_plan_item", ref: "x" }, authority: [{ kind: "user_approval", ref: "a" }],
      target: { carrier: "file", file: TARGET, baseContent: BASE }, anchors: ["Our tracker reaches 61.2 MOTA and 58.4 IDF1."],
      constraints: { numericProtect: "all_existing", allowNewValues: true, hardNumericFreeze: false, citationPolicy: "preserve_existing" },
    });
    expect(derive(BASE, "Our tracker reaches 61.7 MOTA and 58.4 IDF1. Training uses 40 epochs.", [...tail(BASE), anchored]).requests).toEqual([]);
    const twice = "MOTA is 61.2 on A and 61.2 on B.";
    expect(derive(twice, "MOTA is 61.7 on A and 61.2 on B.").requests).toEqual([]);
    expect(derive(BASE, "Our tracker reaches 61.7 MOTA and 58.4 IDF1 with 2 seeds. Training uses 30 epochs.").requests).toEqual([]);
  });

  it("删除冻结数值 → after 为空的删除请求；新请求取代同目标同旧值的旧 pending 请求", () => {
    const removal = derive(BASE, "Our tracker reaches 58.4 IDF1. Training uses 30 epochs.").requests;
    expect(removal).toEqual([expect.objectContaining({ before: "61.2", after: "" })]);
    const first = derive(BASE, CANDIDATE).requests;
    const merged = mergeValueChangeRequests(first, removal);
    expect(merged.map((request) => request.status)).toEqual(["superseded", "pending"]);
  });
});

describe("R4 HTTP 决策通道", () => {
  let t: TestStack;
  afterAll(async () => t?.cleanup());

  it("GET 列出请求；POST decide：错误哈希 409、正确批准 → 状态 approved + 批准事件（actor=author）", async () => {
    t = await startTestStack(scriptedIdeaRuntime());
    const project = await t.store.create("R4", {});
    const { requests } = derive(BASE, CANDIDATE);
    await saveEditContracts(t.store, project.id, []);
    await updateEditContractStore(t.store, project.id, (store) => ({ ...store, valueChangeRequests: requests }));

    const listed = await t.request("GET", `/api/projects/${project.id}/value-change-requests`);
    expect(listed.status).toBe(200);
    expect((listed.body["requests"] as unknown[]).length).toBe(1);

    const bad = await t.request("POST", `/api/projects/${project.id}/value-change-requests/decide`, {
      decisions: [{ requestId: requests[0]!.requestId, decision: "approve", boundHash: "f".repeat(64) }],
    });
    expect(bad.status).toBe(409);
    expect((await loadEditContractStore(t.store, project.id)).valueChangeRequests?.[0]?.status).toBe("pending");

    const ok = await t.request("POST", `/api/projects/${project.id}/value-change-requests/decide`, {
      decisions: [{ requestId: requests[0]!.requestId, decision: "approve", boundHash: requests[0]!.boundHash }],
    });
    expect(ok.status).toBe(200);
    const store = await loadEditContractStore(t.store, project.id);
    expect(store.valueChangeRequests?.[0]?.status).toBe("approved");
    expect(store.approvals.at(-1)).toMatchObject({ kind: "value_change_request_approve", actor: "author" });
    expect(approvedValueChangesForWrite(store.valueChangeRequests ?? [], TARGET, BASE)).toHaveLength(1);
  });
});

// systemRevisionPolicyContract 与 contractsForWrite 同口径（防止两处构造漂移）
it("contractsForWrite 传入的批准值对与直接构造的系统契约等价", () => {
  const approved = [{ before: "61.2", after: "61.7", approvalId: "x" }];
  const direct = systemRevisionPolicyContract({ projectId: "p", runId: "w-1", file: TARGET, carrier: "file", baseContent: BASE, frozenContent: BASE, stageId: "revision.revise", approvedValueChanges: approved });
  expect(tail(BASE, approved)[0]!.allowedValueChanges).toEqual(direct.allowedValueChanges);
});
