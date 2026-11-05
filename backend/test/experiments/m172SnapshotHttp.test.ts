/**
 * M17.2 实验事实链路 HTTP 集成（真实 HTTP 服务 + 真实 Store / 解析器，零模型；SYNTHETIC 夹具）：
 * ZIP 上传（幂等）→ 文件 metadata 补充 → 范围确认 → 标度未确认冲突 409 → 声明单位 → 冻结 efs-0001 →
 * workflowContext / Writer 上下文消费快照对比 → 同键不同值的新包 → 作者排除 → 授权撤回使快照失效 → 重新冻结 efs-0002（旧版本不变）→
 * thesis「附实验包」门禁只在有效快照存在时放行（通过 activeSnapshotState 口径验证）。
 */

import { afterAll, describe, expect, it } from "vitest";

import { buildStoreZip } from "../helpers/storeZip.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { renderExperimentContextLines } from "../../src/writer/WriterService.js";
import { auditExperimentFacts } from "../../src/review/experimentFactAudit.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

// SYNTHETIC：形状参照 TrackEval summary / detailed，数值为人工构造
const PACKAGE = buildStoreZip([
  { path: "baseline/summary.csv", data: "method,dataset,protocol,HOTA (%),IDSW\nbase,DS-A,TrackEval-v1,47.250,820\n" },
  { path: "main/summary.csv", data: "method,dataset,protocol,HOTA (%),IDSW\nours,DS-A,TrackEval-v1,49.830,778\n" },
  { path: "main/other_ds.csv", data: "method,dataset,protocol,HOTA (%)\nours,DS-B,TrackEval-v1,70.5\n" },
  { path: "main/detailed.csv", data: "seq,HOTA\nseq-01,0.5\nCOMBINED,0.49830\n" },
  { path: "ablation/no_gate.csv", data: "method,dataset,protocol,HOTA (%)\nours-lite,DS-A,TrackEval-v1,49.970\n" },
]);
const RERUN = buildStoreZip([
  { path: "baseline/summary_rerun.csv", data: "method,dataset,protocol,HOTA (%)\nbase,DS-A,TrackEval-v1,48.250\n" },
]);

async function upload(stack: TestStack, projectId: string, zip: Buffer, name: string): Promise<{ status: number; packageId: string }> {
  const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/experiment-packages`, {
    method: "POST", headers: { "Content-Type": "application/zip", "X-Package-Name": name }, body: zip,
  });
  return { status: response.status, packageId: ((await response.json()) as { package: { packageId: string } }).package.packageId };
}

describe("M17.2 experiment fact snapshot over HTTP", () => {
  it("imports, resolves scale ambiguity by author metadata, freezes, feeds the writer, and invalidates on change", async () => {
    const stack = await startTestStack(undefined as never, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const created = await stack.request("POST", "/api/projects", { title: "M17.2 synthetic", researchIdea: "synthetic tracking study", workflowKind: "idea_to_paper" });
    const projectId = (created.body["project"] as { id: string }).id;
    const api = `/api/projects/${projectId}/experiment-packages`;

    const first = await upload(stack, projectId, PACKAGE, "synthetic.zip");
    expect(first.status).toBe(201);
    const again = await upload(stack, projectId, PACKAGE, "synthetic-again.zip");
    expect(again).toEqual({ status: 200, packageId: first.packageId });

    // 无快照：workflowContext 无 snapshot 字段（兼容）
    expect((await stack.stack.experimentPackages.workflowContext(projectId)).snapshot).toBeUndefined();

    // detailed.csv 缺方法 / 数据集 / 协议：作者补 metadata（文件内无这些列 → 填补，不覆盖）
    const metadata = await stack.request("POST", `${api}/${first.packageId}/file-metadata`, { path: "main/detailed.csv", metadata: { method: "ours", dataset: "DS-A", protocol: "TrackEval-v1" } });
    expect(metadata.status).toBe(200);
    const invalid = await stack.request("POST", `${api}/${first.packageId}/file-metadata`, { path: "main/detailed.csv", metadata: { units: { HOTA: "percent-ish" } } });
    expect(invalid.status).toBe(400);

    const groups = ["baseline", "main", "ablation-no-gate"];
    const confirm = async () => {
      const response = await stack.request("POST", `${api}/${first.packageId}/confirm`, { groupIds: groups });
      expect(response.status).toBe(200);
    };
    await confirm();
    const preview1 = await stack.request("GET", `${api}/snapshot-preview`);
    const p1 = preview1.body["preview"] as { conflicts: Array<{ code: string; sides: Array<{ rawText: string }> }>; freezable: boolean };
    expect(p1.freezable).toBe(false);
    expect(p1.conflicts.map((entry) => entry.code)).toEqual(["UNIT_SCALE_UNRESOLVED"]);
    expect(p1.conflicts[0]!.sides.map((side) => side.rawText).sort()).toEqual(["0.49830", "49.830"]);
    const blocked = await stack.request("POST", `${api}/snapshots`, {});
    expect(blocked.status).toBe(409);
    expect((blocked.body["error"] as { code: string }).code).toBe("EXPERIMENT_FACT_CONFLICT");

    // 作者声明 detailed.csv 的 HOTA 是 0–1 比例 → 规范化后与 summary 相等，冲突解除（编辑重建观测，需重新确认）
    await stack.request("POST", `${api}/${first.packageId}/file-metadata`, { path: "main/detailed.csv", metadata: { units: { HOTA: "ratio" } } });
    expect((await stack.request("GET", `${api}/snapshot-preview`)).body["preview"]).toMatchObject({ factCount: 0 });
    await confirm();
    const preview2 = (await stack.request("GET", `${api}/snapshot-preview`)).body["preview"] as {
      conflicts: unknown[]; freezable: boolean; comparisons: Array<{ context: { metricKey: string; dataset: string }; subject: { method: string }; reference: { method: string }; absoluteDifference: { value: number; unitLabel: string }; relativeChange: { value: number } | null; outcome: string }>;
      notComparable: Array<{ code: string }>;
    };
    expect(preview2.conflicts).toEqual([]);
    expect(preview2.freezable).toBe(true);
    const hota = preview2.comparisons.find((entry) => entry.context.metricKey === "HOTA" && entry.subject.method === "ours" && entry.reference.method === "base")!;
    expect(hota.absoluteDifference.unitLabel).toBe("pp");
    expect(hota.absoluteDifference.value).toBeCloseTo(2.58, 9);
    expect(hota.relativeChange!.value).toBeCloseTo(5.4603, 3);
    const idsw = preview2.comparisons.find((entry) => entry.context.metricKey === "IDSW")!;
    expect(idsw).toMatchObject({ outcome: "subject_better", absoluteDifference: { value: -42, unitLabel: "count" } });
    expect(preview2.notComparable.some((entry) => entry.code === "PROTOCOL_NOT_COMPARABLE")).toBe(true);
    expect(preview2.comparisons.some((entry) => entry.context.dataset === "DS-B")).toBe(false);

    const frozen = await stack.request("POST", `${api}/snapshots`, { note: "synthetic freeze" });
    expect(frozen.status).toBe(201);
    const snapshot = frozen.body["snapshot"] as { snapshotId: string; contentHash: string; factCount: number };
    expect(snapshot.snapshotId).toBe("efs-0001");

    // 写作上下文：只读快照；Writer prompt 带确定性对比
    const context = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(context.snapshot).toMatchObject({ snapshotId: "efs-0001", status: "valid" });
    expect(context.observations.length).toBe(snapshot.factCount);
    const writerText = renderExperimentContextLines(context).join("\n");
    expect(writerText).toContain("+2.580 个百分点（pp）");
    expect(writerText).toContain("+5.46%（相对变化）");

    // 审稿「作者实验数据」披露：快照整体事实 + 确定性差值（M17.2 真实运行：沿用 100 条上下文时与快照一致的结论被记为 opaque）
    const disclosure = (await stack.stack.experimentPackages.snapshotDisclosureValues(projectId))!;
    const has = (value: number) => disclosure.some((entry) => Math.abs(entry.value - value) < 1e-9);
    expect(has(47.250) && has(49.830) && has(2.58) && has(5.46) && has(42)).toBe(true);

    // Reviewer 核查：错误的 % 幅度被拦截，并能反查到源文件哈希定位
    const state = await stack.stack.experimentPackages.activeSnapshotState(projectId);
    expect(state?.status).toBe("valid");
    const audit = auditExperimentFacts([{ file: "sections/results.tex", content: "ours 的 HOTA 比 base 提升了 2.6\\%，且显著优于 base。\n" }], state!.snapshot, state!.status);
    expect(audit.findings.map((entry) => entry.code).sort()).toEqual(["EXP_PP_PERCENT_CONFUSION", "EXP_UNTESTED_SIGNIFICANCE"]);
    expect(audit.findings.find((entry) => entry.code === "EXP_PP_PERCENT_CONFUSION")!.operandLocators.join(" ")).toMatch(/main\/summary\.csv|main\/detailed\.csv/);

    // 同键不同值的重传（N4 合成）：新包确认后快照预览出现冲突；冲突未裁决不得冻结；作者排除新值后可冻结
    const rerun = await upload(stack, projectId, RERUN, "rerun.zip");
    expect(rerun.status).toBe(201);
    await stack.request("POST", `${api}/${rerun.packageId}/confirm`, { groupIds: ["baseline"] });
    // 已冻结快照不受新确认影响（仍有效：快照事实未变）
    expect((await stack.stack.experimentPackages.activeSnapshotState(projectId))?.status).toBe("valid");
    const preview3 = (await stack.request("GET", `${api}/snapshot-preview`)).body["preview"] as { conflicts: Array<{ code: string; factIds: string[]; sides: Array<{ factId: string; rawText: string }> }> };
    expect(preview3.conflicts.map((entry) => entry.code)).toEqual(["SAME_KEY_DIFFERENT_VALUE"]);
    expect((await stack.request("POST", `${api}/snapshots`, {})).status).toBe(409);
    const rerunFact = preview3.conflicts[0]!.sides.find((side) => side.rawText === "48.250")!.factId;
    const rejectUnknown = await stack.request("POST", `${api}/fact-decisions`, { exclude: ["f-0000000000000000"] });
    expect(rejectUnknown.status).toBe(400);
    const decided = await stack.request("POST", `${api}/fact-decisions`, { exclude: [rerunFact], reason: "作者确认原始运行为最终版本" });
    expect(decided.status).toBe(200);
    expect((await stack.request("GET", `${api}/snapshot-preview`)).body["preview"]).toMatchObject({ freezable: true });

    // 授权撤回：基线范围排除出工作流 → efs-0001 失效；写作上下文清空且不回落到实时数据
    const baselinePackage = await stack.stack.experimentPackages.get(projectId, first.packageId);
    const baselineScope = baselinePackage.groups.find((group) => group.id === "baseline")!.splitScopes![0]!.id;
    await stack.request("POST", `${api}/${first.packageId}/workflow-use`, { scopeId: baselineScope, use: "excluded" });
    const stale = await stack.request("GET", `${api}/snapshots/active`);
    expect((stale.body["active"] as { status: string; staleReasons: string[] }).status).toBe("stale");
    const staleContext = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(staleContext.observations).toEqual([]);
    expect(staleContext.snapshot?.status).toBe("stale");
    expect(renderExperimentContextLines(staleContext).join("\n")).toContain("已失效");
    expect(await stack.stack.experimentPackages.snapshotDisclosureValues(projectId)).toEqual([]);

    // 重新授权 → 重新冻结 efs-0002；efs-0001 内容与哈希不变（历史版本不被静默改写）
    await stack.request("POST", `${api}/${first.packageId}/workflow-use`, { scopeId: baselineScope, use: "allowed" });
    const refrozen = await stack.request("POST", `${api}/snapshots`, {});
    expect((refrozen.body["snapshot"] as { snapshotId: string }).snapshotId).toBe("efs-0002");
    const history = await stack.request("GET", `${api}/snapshots`);
    const list = history.body["snapshots"] as Array<{ snapshotId: string; contentHash: string; active: boolean }>;
    expect(list.map((entry) => [entry.snapshotId, entry.active])).toEqual([["efs-0002", true], ["efs-0001", false]]);
    expect(list.find((entry) => entry.snapshotId === "efs-0001")!.contentHash).toBe(snapshot.contentHash);
  }, 60_000);
});
