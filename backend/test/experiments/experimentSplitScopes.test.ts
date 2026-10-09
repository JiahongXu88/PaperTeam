/**
 * M13.5 split-aware grouping 回归（合成数据；无真实 A2e 数值）：
 * - 单文件多 split（真实事故形状）：main 组三范围不再整组 conflict，
 *   可按范围分别确认；整组一键确认被拒（Dev25 / Confirmation13 / Full38
 *   必须分别核对）；
 * - 科研隔离边界：范围确认 ≠ 允许进入工作流；多范围组即便确认真实，
 *   未经显式 workflowUse 授权也不进 Researcher 上下文；
 * - 同名指标不同 split 不比较（跨范围标度差异不告警；同范围内才告警）；
 * - 单 split / 缺 split 组沿用 v1「整组确认即进入」语义（兼容）；
 * - 编辑失效、持久化重读、v1 旧包读取、指标浏览查询。
 */

import { crc32 } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { startTestStack, type TestStack } from "../helpers/testStack.js";

function buildStoreZip(entries: Array<{ path: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}

/** 单文件多 split（A2e 事故形状：同一结果文件含 Dev25 / Confirmation13 / Full38） */
const MULTI_SPLIT_ZIP = buildStoreZip([
  { path: "main/results.csv", data: "method,dataset,split,HOTA,IDSW\nOurs,A2e,Dev25,60.1,12\nOurs,A2e,Confirmation13,62.3,10\nOurs,A2e,Full38,61.5,11\n" },
  { path: "results/baseline-a0.csv", data: "method,dataset,split,HOTA,IDSW\nBase,A2e,Dev25,55.0,17\n" },
  { path: "notes/readme.md", data: "synthetic\n" },
]);
/** 同名指标跨范围不同标度（不应告警：跨范围不比较） */
const CROSS_SCOPE_SCALE_ZIP = buildStoreZip([
  { path: "main/mixed.csv", data: "split,HOTA\nDev25,0.62\nFull38,62.3\n" },
]);
/** 同范围内标度混用（应告警） */
const WITHIN_SCOPE_SCALE_ZIP = buildStoreZip([
  { path: "main/a.csv", data: "split,HOTA\nDev25,0.62\n" },
  { path: "main/b.csv", data: "split,HOTA\nDev25,62.3\n" },
]);
/** 无 split 列 → 全部归 unknown 范围 */
const NO_SPLIT_ZIP = buildStoreZip([
  { path: "main/plain.csv", data: "HOTA,IDSW\n60.0,9\n" },
]);

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

async function makeStack(): Promise<{ stack: TestStack; projectId: string }> {
  const stack = await startTestStack(undefined as never, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
  const created = await stack.request("POST", "/api/projects", { title: "M13.5 split scopes", researchIdea: "synthetic", workflowKind: "idea_to_paper" });
  return { stack, projectId: (created.body["project"] as { id: string }).id };
}

async function upload(stack: TestStack, projectId: string, zip: Buffer, name: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/experiment-packages`, {
    method: "POST", headers: { "Content-Type": "application/zip", "X-Package-Name": name }, body: zip,
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { package: { packageId: string } };
  return body.package.packageId;
}

interface ScopeView {
  id: string; split: string; status: string; workflowUse: string;
  observationCount: number; metricCount: number; conflicts: string[];
  confirmedAt?: string; workflowUseDecidedAt?: string;
}
interface PackageBody {
  packageId: string; schemaVersion: number;
  groups: Array<{ id: string; role: string; status: string; conflicts: string[]; splitScopes?: ScopeView[] }>;
  observations: Array<{ groupId: string; split?: string; metric: string; value: number; path: string }>;
  observationCount?: number;
  warnings: string[];
}

describe("M13.5 观测级实验范围（split scopes）", () => {
  it("单文件多 split：按范围细分、不再整组 conflict、整组确认被拒并给出范围清单", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "multi-split.zip");
    const detail = await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${packageId}`);
    const item = detail.body["package"] as PackageBody;
    expect(item.schemaVersion).toBe(2);
    const main = item.groups.find((group) => group.id === "main")!;
    // 修复前：status=conflict + "split 不一致：Dev25 / Confirmation13 / Full38"
    expect(main.status).toBe("candidate");
    expect(main.conflicts).toEqual([]);
    expect(main.splitScopes!.map((scope) => scope.split)).toEqual(["Confirmation13", "Dev25", "Full38"]);
    expect(main.splitScopes!.map((scope) => scope.id)).toEqual(["main@Confirmation13", "main@Dev25", "main@Full38"]);
    for (const scope of main.splitScopes!) {
      expect(scope.status).toBe("candidate");
      expect(scope.workflowUse).toBe("undecided");
    }
    expect(main.splitScopes!.find((scope) => scope.split === "Full38")!.observationCount).toBe(2); // 1 行 × 2 指标
    // 整组一键确认被拒：多范围必须分别核对
    const groupConfirm = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/confirm`, { groupIds: ["main"] });
    expect(groupConfirm.status).toBe(409);
    expect((groupConfirm.body["error"] as { message: string }).message).toContain("Dev25");
    // 单 split 组（baseline-a0）沿用 v1 整组确认语义
    const baseline = item.groups.find((group) => group.id === "baseline-a0")!;
    expect(baseline.splitScopes!.map((scope) => scope.split)).toEqual(["Dev25"]);
  });

  it("科研隔离：范围确认 ≠ 进入工作流；显式授权后才进入；未授权范围始终隔离", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "multi-split.zip");
    // 未确认：上下文为空
    expect((await stack.stack.experimentPackages.workflowContext(projectId)).observations).toHaveLength(0);
    // 确认 dev25：仍不进入（workflowUse=undecided 的隔离缺省）
    const dev25 = "main@Dev25";
    const confirmed = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/confirm`, { groupIds: [], scopeIds: [dev25] });
    expect(confirmed.status).toBe(200);
    const afterConfirm = (confirmed.body["package"] as PackageBody).groups.find((group) => group.id === "main")!.splitScopes!.find((scope) => scope.id === dev25)!;
    expect(afterConfirm.status).toBe("confirmed");
    expect(afterConfirm.workflowUse).toBe("undecided");
    expect((await stack.stack.experimentPackages.workflowContext(projectId)).observations).toHaveLength(0);
    // 未确认范围不能授权
    const premature = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/workflow-use`, { scopeId: "main@Full38", use: "allowed" });
    expect(premature.status).toBe(409);
    // 显式授权 dev25 → 仅 dev25 观测进入
    const allowed = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/workflow-use`, { scopeId: dev25, use: "allowed" });
    expect(allowed.status).toBe(200);
    let context = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(context.observations).toHaveLength(2); // HOTA + IDSW
    expect(context.observations.every((entry) => entry.split === "Dev25")).toBe(true);
    // 确认 + 授权其余两范围 → 全部进入（组整体 confirmed）
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/confirm`, { groupIds: [], scopeIds: ["main@Confirmation13", "main@Full38"] });
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/workflow-use`, { scopeId: "main@Confirmation13", use: "allowed" });
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/workflow-use`, { scopeId: "main@Full38", use: "allowed" });
    context = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(context.observations).toHaveLength(6);
    const detail = await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${packageId}`);
    const main = (detail.body["package"] as PackageBody).groups.find((group) => group.id === "main")!;
    expect(main.status).toBe("confirmed");
    // 排除一个范围：可随时收紧（作者显式更改隔离边界）
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/workflow-use`, { scopeId: "main@Full38", use: "excluded" });
    context = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(context.observations).toHaveLength(4);
  });

  it("单 split / 无 split 组：整组确认即自动进入工作流（v1 行为保留）", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "multi-split.zip");
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/confirm`, { groupIds: ["baseline-a0"] });
    const context = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(context.observations).toHaveLength(2);
    expect(context.observations.every((entry) => entry.split === "Dev25")).toBe(true);

    const noSplitId = await upload(stack, projectId, NO_SPLIT_ZIP, "no-split.zip");
    const detail = await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${noSplitId}`);
    const main = (detail.body["package"] as PackageBody).groups.find((group) => group.id === "main")!;
    expect(main.splitScopes!.map((scope) => scope.split)).toEqual(["unknown"]);
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${noSplitId}/confirm`, { groupIds: ["main"] });
    expect((await stack.stack.experimentPackages.workflowContext(projectId)).observations).toHaveLength(4); // 2 + 2
  });

  it("同名指标跨范围不同标度不告警；同范围内标度混用仍告警", async () => {
    const { stack, projectId } = await makeStack();
    const crossId = await upload(stack, projectId, CROSS_SCOPE_SCALE_ZIP, "cross-scope-scale.zip");
    const cross = (await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${crossId}`)).body["package"] as PackageBody;
    expect(cross.warnings.some((warning) => warning.includes("标度混用"))).toBe(false);
    const withinId = await upload(stack, projectId, WITHIN_SCOPE_SCALE_ZIP, "within-scope-scale.zip");
    const within = (await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${withinId}`)).body["package"] as PackageBody;
    expect(within.warnings.some((warning) => warning.includes("标度混用") && warning.includes("Dev25"))).toBe(true);
  });

  it("编辑文件后确认与授权失效（rebuild 重建范围）；持久化重读保留决策", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "multi-split.zip");
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/confirm`, { groupIds: [], scopeIds: ["main@Dev25"] });
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/workflow-use`, { scopeId: "main@Dev25", use: "allowed" });
    // 持久化重读：manifest 落盘的确认与授权字段完整
    const manifestPath = join(stack.store.projectDir(projectId), "experiments", packageId, "manifest.json");
    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as PackageBody;
    const persistedScope = persisted.groups.find((group) => group.id === "main")!.splitScopes!.find((scope) => scope.id === "main@Dev25")!;
    expect(persistedScope.status).toBe("confirmed");
    expect(persistedScope.confirmedAt).toBeDefined();
    expect(persistedScope.workflowUse).toBe("allowed");
    expect(persistedScope.workflowUseDecidedAt).toBeDefined();
    // 任何文件编辑 → rebuild：确认与授权全部失效（既有的编辑失效语义）
    const edited = await stack.request("PATCH", `/api/projects/${projectId}/experiment-packages/${packageId}`, { path: "main/results.csv", role: "main_result", groupId: "main" });
    expect(edited.status).toBe(200);
    const after = (edited.body["package"] as PackageBody).groups.find((group) => group.id === "main")!.splitScopes!.find((scope) => scope.id === "main@Dev25")!;
    expect(after.status).toBe("candidate");
    expect(after.workflowUse).toBe("undecided");
    expect(after.confirmedAt).toBeUndefined();
    expect((await stack.stack.experimentPackages.workflowContext(projectId)).observations).toHaveLength(0);
  });

  it("v1 旧包（无 splitScopes）读取与工作流语义不受影响", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "legacy-v1.zip");
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/confirm`, { groupIds: ["baseline-a0"] });
    // 手工把 manifest 降级成 v1 形状（去掉 splitScopes、schemaVersion=1）
    const manifestPath = join(stack.store.projectDir(projectId), "experiments", packageId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageBody & { schemaVersion: number };
    manifest.schemaVersion = 1;
    for (const group of manifest.groups) delete (group as { splitScopes?: unknown }).splitScopes;
    manifest.groups.find((group) => group.id === "main")!.status = "confirmed";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const detail = await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${packageId}`);
    expect(detail.status).toBe(200);
    // v1 语义：confirmed 组的观测全部进入（含多 split 的 main）
    const context = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(context.observations).toHaveLength(8); // main 3 行×2 指标 + baseline 1 行×2 指标
  });

  it("指标浏览查询：按范围过滤、分页有界、facet 有界", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "query.zip");
    const query = async (search: string) => {
      const response = await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${packageId}/observations${search}`);
      expect(response.status).toBe(200);
      return response.body as { total: number; page: number; pageSize: number; observations: PackageBody["observations"]; facets: { splits: string[]; groupIds: string[] } };
    };
    const all = await query("");
    expect(all.total).toBe(8);
    expect(all.facets.splits).toEqual(["Confirmation13", "Dev25", "Full38"]);
    expect(all.facets.groupIds.sort()).toEqual(["baseline-a0", "main"]);
    const devOnly = await query("?split=Dev25");
    expect(devOnly.total).toBe(4);
    expect(devOnly.observations.every((entry) => entry.split === "Dev25")).toBe(true);
    const paged = await query("?pageSize=2&page=2");
    expect(paged.total).toBe(8);
    expect(paged.observations).toHaveLength(2);
  });
});
