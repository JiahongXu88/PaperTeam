/**
 * M13.6 v1 → v2 自动兼容 + 「用于当前论文」一次性确认/授权 回归（合成数据）：
 * - v1 旧包（多 split 整组 conflict）经 ensureSchemaUpgraded 升级到范围级：
 *   数值 / 来源 / hash 逐字保持，Dev25 / Confirmation13 / Full38 分别识别；
 * - 升级幂等（重复调用结果不变）、落盘稳定（重读一致）；
 * - v1 已确认的单范围组：确认按内容签名保守保留（confirmed + allowed）；
 * - v1 已确认但升级后多范围 / 内容变化的组：保持待确认（不偷偷放行）；
 * - applyWorkflowUse：一次提交 = 确认 + 授权；未选范围不进入上下文；
 *   冲突范围整批拒绝（原子性）；排除立即生效于后续读取；
 * - ensure-upgraded 是显式 POST（不在普通 GET 内做副作用）。
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
    local.writeUInt16LE(0, 8);
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

/** 与真实项目同形：main 组单文件三 split + baseline 单 split */
const MULTI_SPLIT_ZIP = buildStoreZip([
  { path: "main/results.csv", data: "method,dataset,split,HOTA,IDSW\nOurs,A2e,Dev25,60.1,12\nOurs,A2e,Confirmation13,62.3,10\nOurs,A2e,Full38,61.5,11\n" },
  { path: "results/baseline-a0.csv", data: "method,dataset,split,HOTA,IDSW\nBase,A2e,Dev25,55.0,17\n" },
  { path: "notes/readme.md", data: "synthetic\n" },
]);

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

async function makeStack(): Promise<{ stack: TestStack; projectId: string }> {
  const stack = await startTestStack(undefined as never, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
  const created = await stack.request("POST", "/api/projects", { title: "M13.6 upgrade", researchIdea: "synthetic", workflowKind: "idea_to_paper" });
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
  groups: Array<{ id: string; role: string; status: string; conflicts: string[]; confirmedAt?: string; splitScopes?: ScopeView[] }>;
  observations: Array<{ groupId: string; split?: string; metric: string; value: number; path: string; sourceId: string; row?: number }>;
  observationCount?: number;
  warnings: string[];
}

function manifestPath(stack: TestStack, projectId: string, packageId: string): string {
  return join(stack.stack.projects.projectDir(projectId), "experiments", packageId, "manifest.json");
}

/**
 * 把 v2 manifest 降级回 M13.5 之前的 v1 形态（真实旧包的磁盘事实）：
 * 无 splitScopes；多 split 组按旧规则整组 conflict。
 * options.confirmBaseline / confirmMainMulti：预置 v1 的整组确认（测保留映射）。
 */
async function downgradeToV1(
  stack: TestStack,
  projectId: string,
  packageId: string,
  options: { confirmBaseline?: boolean; confirmMainMulti?: boolean } = {},
): Promise<void> {
  const path = manifestPath(stack, projectId, packageId);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> & { groups: Array<Record<string, unknown>> };
  raw["schemaVersion"] = 1;
  for (const group of raw.groups) {
    const scopes = group["splitScopes"] as ScopeView[] | undefined;
    delete group["splitScopes"];
    if ((scopes?.length ?? 0) > 1) {
      // v1 旧规则：同文件多 split 整组 conflict（真实 A2e 包死锁形状）
      group["status"] = options.confirmMainMulti === true ? "confirmed" : "conflict";
      group["conflicts"] = options.confirmMainMulti === true ? [] : [`split 不一致：${scopes!.map((scope) => scope.split).join(" / ")}`];
      if (options.confirmMainMulti === true) group["confirmedAt"] = "2026-09-01T00:00:00.000Z";
    } else if (options.confirmBaseline === true && group["id"] === "baseline-a0") {
      group["status"] = "confirmed";
      group["confirmedAt"] = "2026-09-01T00:00:00.000Z";
    }
  }
  await writeFile(path, JSON.stringify(raw), "utf8");
}

async function ensureUpgraded(stack: TestStack, projectId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return stack.request("POST", `/api/projects/${projectId}/experiment-packages/ensure-upgraded`, {});
}

describe("M13.6 v1 → v2 自动兼容（ensureSchemaUpgraded）", () => {
  it("v1 多 split 冲突包：升级到范围级、三范围分别识别、数值/来源逐字保持、幂等且落盘稳定", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "multi-split.zip");
    const before = (await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${packageId}`)).body["package"] as PackageBody;
    await downgradeToV1(stack, projectId, packageId);
    // v1 读取：无 splitScopes、main 组 conflict（旧规则）
    const legacy = (await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${packageId}`)).body["package"] as PackageBody;
    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.groups.find((group) => group.id === "main")!.splitScopes).toBeUndefined();
    expect(legacy.groups.find((group) => group.id === "main")!.status).toBe("conflict");

    const result = await ensureUpgraded(stack, projectId);
    expect(result.status).toBe(200);
    expect(result.body["upgraded"] as string[]).toEqual([packageId]);
    const upgraded = (await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${packageId}`)).body["package"] as PackageBody;
    expect(upgraded.schemaVersion).toBe(2);
    const main = upgraded.groups.find((group) => group.id === "main")!;
    expect(main.status).toBe("candidate");
    expect(main.conflicts).toEqual([]);
    expect(main.splitScopes!.map((scope) => scope.split)).toEqual(["Confirmation13", "Dev25", "Full38"]);
    // 数值 / 来源 / hash 逐字保持（与升级前 v2 基线完全一致）
    expect(upgraded.observationCount ?? upgraded.observations.length).toBe(before.observationCount ?? before.observations.length);
    const key = (observation: { sourceId: string; path: string; metric: string; value: number; row?: number }) =>
      `${observation.sourceId}|${observation.path}|${observation.metric}|${observation.value}|${observation.row ?? ""}`;
    expect(upgraded.observations.map(key).sort()).toEqual(before.observations.map(key).sort());
    // 原始 ZIP 不变（packageHash 不变）
    expect(upgraded.packageId).toBe(before.packageId);
    // 幂等：再次升级 no-op
    const again = await ensureUpgraded(stack, projectId);
    expect(again.body["upgraded"] as string[]).toEqual([]);
    // 落盘稳定：直接重读 manifest（等价于服务重启后读取）
    const persisted = JSON.parse(await readFile(manifestPath(stack, projectId, packageId), "utf8")) as { schemaVersion: number };
    expect(persisted.schemaVersion).toBe(2);
  });

  it("v1 已确认的单范围组：确认按内容签名保守保留（confirmed + allowed）；v1 已确认的多范围组保持待确认", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "multi-split.zip");
    await downgradeToV1(stack, projectId, packageId, { confirmBaseline: true, confirmMainMulti: true });
    const result = await ensureUpgraded(stack, projectId);
    const preserved = result.body["preservedConfirmations"] as Array<{ packageId: string; groupId: string }>;
    const reset = result.body["resetConfirmations"] as Array<{ groupId: string; reason: string }>;
    // baseline-a0（单一 Dev25 范围、内容未变）→ 保留 v1 确认语义（confirmed + allowed）
    expect(preserved).toContainEqual({ packageId, groupId: "baseline-a0" });
    // main（升级后 3 范围）→ 整组确认无法唯一映射，保持待确认（不偷偷放行）
    expect(reset.find((entry) => entry.groupId === "main")?.reason).toContain("评测范围");
    const upgraded = (await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${packageId}`)).body["package"] as PackageBody;
    const baseline = upgraded.groups.find((group) => group.id === "baseline-a0")!;
    expect(baseline.status).toBe("confirmed");
    expect(baseline.splitScopes![0]!.status).toBe("confirmed");
    expect(baseline.splitScopes![0]!.workflowUse).toBe("allowed");
    const main = upgraded.groups.find((group) => group.id === "main")!;
    expect(main.status).toBe("candidate");
    for (const scope of main.splitScopes!) {
      expect(scope.status).toBe("candidate");
      expect(scope.workflowUse).toBe("undecided");
    }
    // 保留的 v1 确认按旧语义进入工作流（只有 baseline 的 Dev25 观测）
    const context = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(context.observations).toHaveLength(2);
    expect(context.observations.every((entry) => entry.groupId === "baseline-a0")).toBe(true);
  });
});

describe("M13.6「用于当前论文」（applyWorkflowUse）", () => {
  it("多范围包一次提交：所选范围确认 + 授权；未选范围保持待确认且不进入上下文", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "multi-split.zip");
    const response = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/use-for-paper`, {
      groupIds: [],
      scopeIds: ["main@Dev25"],
    });
    expect(response.status).toBe(200);
    const item = response.body["package"] as PackageBody;
    const dev25 = item.groups.find((group) => group.id === "main")!.splitScopes!.find((scope) => scope.id === "main@Dev25")!;
    expect(dev25.status).toBe("confirmed");
    expect(dev25.workflowUse).toBe("allowed");
    for (const other of ["main@Confirmation13", "main@Full38"]) {
      const scope = item.groups.find((group) => group.id === "main")!.splitScopes!.find((entry) => entry.id === other)!;
      expect(scope.status).toBe("candidate");
      expect(scope.workflowUse).toBe("undecided");
    }
    const context = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(context.observations).toHaveLength(2);
    expect(context.observations.every((entry) => entry.split === "Dev25" && entry.groupId === "main")).toBe(true);
  });

  it("单范围组一次提交（groupIds）；随后排除已授权范围立即生效", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "multi-split.zip");
    const applied = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/use-for-paper`, {
      groupIds: ["baseline-a0"],
    });
    expect(applied.status).toBe(200);
    expect((await stack.stack.experimentPackages.workflowContext(projectId)).observations).toHaveLength(2);
    // 取消授权（scopeId = groupId@slug）：立即生效于后续读取
    const excluded = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/use-for-paper`, {
      groupIds: [],
      excludeScopeIds: ["baseline-a0@Dev25"],
    });
    expect(excluded.status).toBe(200);
    const scope = (excluded.body["package"] as PackageBody).groups.find((group) => group.id === "baseline-a0")!.splitScopes![0]!;
    expect(scope.workflowUse).toBe("excluded");
    expect((await stack.stack.experimentPackages.workflowContext(projectId)).observations).toHaveLength(0);
  });

  it("冲突范围整批拒绝（原子性）：合法目标不被部分应用；同一范围不能同时选择与排除", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, buildStoreZip([
      { path: "main/a.csv", data: "split,protocol,HOTA\nDev25,P1,60.0\nDev25,P2,61.0\n" }, // 同范围 protocol 矛盾
      { path: "results/baseline-a0.csv", data: "split,HOTA\nDev25,55.0\n" },
    ]), "conflict.zip");
    const detail = (await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${packageId}`)).body["package"] as PackageBody;
    expect(detail.groups.find((group) => group.id === "main")!.status).toBe("conflict");
    const rejected = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/use-for-paper`, {
      groupIds: ["baseline-a0"],
      scopeIds: ["main@Dev25"],
    });
    expect(rejected.status).toBe(409);
    // 合法目标未被部分应用
    const after = (await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${packageId}`)).body["package"] as PackageBody;
    expect(after.groups.find((group) => group.id === "baseline-a0")!.status).toBe("candidate");
    // 选择与排除重叠 → 400
    const overlap = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/use-for-paper`, {
      scopeIds: ["main@Dev25"],
      excludeScopeIds: ["main@Dev25"],
    });
    expect(overlap.status).toBe(400);
  });

  it("experimentPolicy：范围级授权视图（数值级上下文之外的共享口径）", async () => {
    const { stack, projectId } = await makeStack();
    const packageId = await upload(stack, projectId, MULTI_SPLIT_ZIP, "multi-split.zip");
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/use-for-paper`, {
      groupIds: [],
      scopeIds: ["main@Dev25"],
    });
    const policy = await stack.stack.experimentPackages.experimentPolicy(projectId);
    const dev25 = policy.entries.find((entry) => entry.scopeId === "main@Dev25")!;
    expect(dev25.workflowUse).toBe("allowed");
    expect(dev25.observationCount).toBe(2);
    const blocked = policy.entries.filter((entry) => entry.workflowUse !== "allowed");
    expect(blocked.map((entry) => entry.scopeId).sort()).toEqual(["baseline-a0@Dev25", "main@Confirmation13", "main@Full38"]);
  });
});
