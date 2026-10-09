/**
 * M13.3.1 Workflow Context 代表性选择回归（合成数据，无真实 Phase 9.0 数值）：
 * - 原实现按登记顺序截断前 100 条 → 单文件大结果集把其他作者确认组完全
 *   挤出 Researcher 上下文；新实现为确定性两阶段选择（组覆盖 → metric/
 *   path 覆盖 → 组轮转填充），总量预算 100 不变。
 * - 单元层直接测选择纯函数（幂等 / 顺序无关 / 组数超预算截断）；
 * - e2e 层走真实 ZIP 导入 + 作者确认链路，验证资格边界（未确认组、JSONL
 *   特征流、无观测组）与来源追踪（返回值与 manifest 原始观测逐字段一致）。
 */

import { crc32 } from "node:zlib";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { selectWorkflowObservations, type MetricObservation, type WorkflowObservationCandidate } from "../../src/experiments/ExperimentPackageService.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

// ---- 合成观测工厂（单元层） ----

let blockSeq = 0;
function syntheticObservation(groupId: string, metric: string, overrides: Partial<MetricObservation> = {}): MetricObservation {
  blockSeq += 1;
  return {
    sourceId: "S0001", path: "results/synthetic.csv", blockId: `B${String(blockSeq).padStart(4, "0")}`,
    metric, value: blockSeq, unit: "unknown", direction: "unknown", groupId, ...overrides,
  };
}
function candidate(groupId: string, metric: string, overrides: Partial<MetricObservation> = {}): WorkflowObservationCandidate {
  return { packageId: `ep-${"a".repeat(32)}`, packageHash: "a".repeat(64), observation: syntheticObservation(groupId, metric, overrides) };
}
const groupCounts = (selected: WorkflowObservationCandidate[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const entry of selected) counts.set(entry.observation.groupId, (counts.get(entry.observation.groupId) ?? 0) + 1);
  return counts;
};

describe("selectWorkflowObservations (unit)", () => {
  it("keeps smaller confirmed groups represented when one group exceeds the budget", () => {
    const candidates = [
      ...Array.from({ length: 120 }, () => candidate("main", "m")),
      ...Array.from({ length: 3 }, () => candidate("baseline-a0", "m")),
    ];
    const selected = selectWorkflowObservations(candidates);
    expect(selected).toHaveLength(100);
    const counts = groupCounts(selected);
    expect([...counts.keys()].sort()).toEqual(["baseline-a0", "main"]);
    expect(counts.get("baseline-a0")).toBeGreaterThanOrEqual(1);
  });

  it("gives every valid group balanced coverage when six groups compete", () => {
    const groups = ["main", "baseline-a0", "main-a1", "main-a2", "ablation-a3", "opp-universe"];
    const candidates = groups.flatMap((groupId) => Array.from({ length: 30 }, () => candidate(groupId, "m")));
    const selected = selectWorkflowObservations(candidates);
    expect(selected).toHaveLength(100);
    const counts = groupCounts(selected);
    for (const groupId of groups) expect(counts.get(groupId)).toBeGreaterThanOrEqual(1);
    const values = [...counts.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });

  it("covers distinct metrics of a group before filling with repeats", () => {
    const candidates = [
      ...Array.from({ length: 60 }, () => candidate("main", "HOTA")),
      candidate("main", "MOTA"),
      ...Array.from({ length: 40 }, () => candidate("baseline-b", "HOTA")),
    ];
    const selected = selectWorkflowObservations(candidates);
    expect(selected).toHaveLength(100);
    expect(selected.some((entry) => entry.observation.metric === "MOTA")).toBe(true);
  });

  it("covers observations from a second source file of the same group", () => {
    const candidates = [
      ...Array.from({ length: 60 }, () => candidate("main", "HOTA", { path: "results/a.json" })),
      ...Array.from({ length: 60 }, () => candidate("main", "HOTA", { path: "results/b.json" })),
      candidate("baseline-c", "HOTA"),
    ];
    const selected = selectWorkflowObservations(candidates);
    expect(selected).toHaveLength(100);
    expect(selected.filter((entry) => entry.observation.path === "results/b.json").length).toBeGreaterThanOrEqual(1);
  });

  it("keeps everything when candidates fit within the budget", () => {
    const candidates = ["main", "baseline-a0", "ablation-no-attn"].flatMap((groupId) => Array.from({ length: 10 }, () => candidate(groupId, "m")));
    expect(selectWorkflowObservations(candidates)).toHaveLength(30);
  });

  it("caps selection at the budget when candidates exceed it", () => {
    const candidates = Array.from({ length: 150 }, () => candidate("main", "m"));
    expect(selectWorkflowObservations(candidates)).toHaveLength(100);
  });

  it("is idempotent and independent of candidate registration order", () => {
    const candidates = [
      ...Array.from({ length: 80 }, () => candidate("main", "HOTA")),
      ...Array.from({ length: 20 }, () => candidate("baseline-r", "HOTA")),
      ...Array.from({ length: 50 }, () => candidate("baseline-s", "HOTA")),
    ];
    const first = selectWorkflowObservations(candidates);
    expect(selectWorkflowObservations(candidates)).toEqual(first);
    // 登记顺序颠倒（含跨组交错）不改变选择：组序与组内锚点序均与输入顺序无关
    expect(selectWorkflowObservations([...candidates].reverse())).toEqual(first);
  });

  it("truncates by stable group order when there are more groups than budget", () => {
    const candidates: WorkflowObservationCandidate[] = [];
    for (let index = 0; index < 105; index += 1) {
      const groupId = `g${String(index).padStart(3, "0")}`;
      candidates.push(candidate(groupId, "m", { blockId: "B0001" }), candidate(groupId, "m", { blockId: "B0002" }));
    }
    const selected = selectWorkflowObservations(candidates);
    expect(selected).toHaveLength(100);
    const counts = groupCounts(selected);
    expect(counts.size).toBe(100); // 组键码位序保留前 100 组，每组恰好一条
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
    for (let index = 100; index < 105; index += 1) expect(counts.has(`g${String(index).padStart(3, "0")}`)).toBe(false);
  });

  it("treats same-named groups in different packages as distinct groups", () => {
    const first: WorkflowObservationCandidate = { ...candidate("main", "m"), packageId: `ep-${"1".repeat(32)}` };
    const second: WorkflowObservationCandidate = { ...candidate("main", "m"), packageId: `ep-${"2".repeat(32)}` };
    const selected = selectWorkflowObservations([first, second]);
    expect(selected.map((entry) => entry.packageId).sort()).toEqual([`ep-${"1".repeat(32)}`, `ep-${"2".repeat(32)}`]);
  });
});

// ---- e2e：真实 ZIP 导入 + 作者确认链路 ----

/** 极简 store-method ZIP 写入（无压缩；archive.ts 接受 method 0） */
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

// main 组单文件 120 条观测（每个数值叶子一条）——复现"大结果集吞噬预算"的真实形状
const MAIN_METRICS = JSON.stringify(Object.fromEntries(
  Array.from({ length: 120 }, (_, index) => [`m${String(index + 1).padStart(3, "0")}`, Number(((index + 1) / 10).toFixed(1))]),
));
const SELECTION_ZIP = buildStoreZip([
  { path: "main/metrics.json", data: MAIN_METRICS },
  { path: "results/baseline-a0.csv", data: "HOTA,IDSW\n51.2,12\n" },
  { path: "results/baseline-a1.csv", data: "HOTA,IDSW\n52.7,11\n" },
  { path: "results/no-attn.csv", data: "HOTA,IDSW\n50.1,14\n" },
  { path: "results/no-fuse.csv", data: "HOTA,IDSW\n49.8,15\n" },
  { path: "events/stream.jsonl", data: '{"clip":"c1","frame":1,"score":0.5}\n{"clip":"c1","frame":2,"score":0.7}\n' },
  { path: "docs/readme.md", data: "synthetic notes\n" },
]);
const SECOND_PACKAGE_ZIP = buildStoreZip([
  { path: "results/baseline-zz.csv", data: "HOTA,IDSW\n48.3,17\n" },
]);
const SMALL_ZIP = buildStoreZip([
  { path: "main/small.csv", data: "HOTA,IDSW\n60.0,9\n" },
  { path: "results/baseline-s.csv", data: "HOTA,IDSW\n55.0,13\n" },
  { path: "notes/readme.md", data: "synthetic\n" },
]);

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

async function upload(stack: TestStack, projectId: string, zip: Buffer, name: string) {
  const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/experiment-packages`, {
    method: "POST", headers: { "Content-Type": "application/zip", "X-Package-Name": name }, body: zip,
  });
  expect(response.status).toBe(201);
  return (await response.json() as { package: { packageId: string } }).package;
}

describe("workflowContext representative selection (e2e)", () => {
  it("covers every confirmed group across packages while capping the budget, and stays faithful to raw observations", async () => {
    const stack = await startTestStack(undefined as never, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const created = await stack.request("POST", "/api/projects", { title: "M13.3.1 selection", researchIdea: "synthetic", workflowKind: "idea_to_paper" });
    const projectId = (created.body["project"] as { id: string }).id;
    const item = await upload(stack, projectId, SELECTION_ZIP, "selection.zip");
    // JSONL 即便被作者标成结果角色也不产生指标观测（既有排除规则）
    const patched = await stack.request("PATCH", `/api/projects/${projectId}/experiment-packages/${item.packageId}`, { path: "events/stream.jsonl", role: "main_result", groupId: "main" });
    expect(patched.status).toBe(200);

    // 只确认 main：未确认臂组被排除；main 120 条观测 → 预算内 100 条、truncated
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${item.packageId}/confirm`, { groupIds: ["main"] });
    const mainOnly = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(mainOnly.truncated).toBe(true);
    expect(mainOnly.observations).toHaveLength(100);
    expect(new Set(mainOnly.observations.map((entry) => entry.groupId))).toEqual(new Set(["main"]));
    expect(mainOnly.observations.every((entry) => entry.path !== "events/stream.jsonl")).toBe(true);

    // 确认全部 5 个组：每个组都有代表进入上下文（修复前臂组会被完全挤掉）
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${item.packageId}/confirm`, { groupIds: ["baseline-a0", "baseline-a1", "ablation-no-attn", "ablation-no-fuse"] });
    const fiveGroups = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(fiveGroups.truncated).toBe(true);
    expect(fiveGroups.observations).toHaveLength(100);
    const counts = new Map<string, number>();
    for (const entry of fiveGroups.observations) counts.set(entry.groupId, (counts.get(entry.groupId) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual(["ablation-no-attn", "ablation-no-fuse", "baseline-a0", "baseline-a1", "main"]);
    for (const count of counts.values()) expect(count).toBeGreaterThanOrEqual(1);
    // 臂组两条指标（HOTA / IDSW）都进入：指标多样性在容量允许时得到覆盖
    for (const arm of ["baseline-a0", "baseline-a1", "ablation-no-attn", "ablation-no-fuse"]) {
      const metrics = fiveGroups.observations.filter((entry) => entry.groupId === arm).map((entry) => entry.metric).sort();
      expect(metrics).toEqual(["HOTA", "IDSW"]);
    }
    // 来源追踪：每条返回观测与 manifest 原始记录逐字段一致（值未被修改/聚合）
    const manifest = JSON.parse(await readFile(join(stack.store.projectDir(projectId), "experiments", item.packageId, "manifest.json"), "utf8")) as {
      observations: Array<{ metric: string; value: number; groupId: string; sourceId: string; blockId: string; path: string; row?: number; column?: string; jsonPath?: string }>;
    };
    for (const entry of fiveGroups.observations) {
      // jsonPath 为 undefined 是既有清洗行为（$. 前缀不匹配安全标签正则被省略）；
      // 其余锚点字段必须与原始观测逐字一致——值未被修改、聚合或虚构
      const anchored = manifest.observations.some((raw) =>
        raw.metric === entry.metric && raw.value === entry.value && raw.groupId === entry.groupId &&
        raw.sourceId === entry.sourceId && raw.blockId === entry.blockId && raw.path === entry.path &&
        raw.row === entry.row && raw.column === entry.column && (entry.jsonPath === undefined || raw.jsonPath === entry.jsonPath));
      expect(anchored, `${entry.groupId}/${entry.metric}/${entry.value}`).toBe(true);
    }
    // 幂等：相同输入重复调用输出完全一致
    expect(JSON.stringify(await stack.stack.experimentPackages.workflowContext(projectId))).toBe(JSON.stringify(fiveGroups));

    // 跨包公平：第二个包的确认组同样获得覆盖（包顺序由 importedAt 决定，与组覆盖无关）
    const second = await upload(stack, projectId, SECOND_PACKAGE_ZIP, "second.zip");
    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${second.packageId}/confirm`, { groupIds: ["baseline-zz"] });
    const twoPackages = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(twoPackages.observations).toHaveLength(100);
    expect(twoPackages.truncated).toBe(true);
    const packageIds = new Set(twoPackages.observations.map((entry) => entry.packageId));
    expect(packageIds).toEqual(new Set([item.packageId, second.packageId]));
    const groupsNow = new Set(twoPackages.observations.map((entry) => entry.groupId));
    for (const groupId of ["main", "baseline-a0", "baseline-a1", "ablation-no-attn", "ablation-no-fuse", "baseline-zz"]) expect(groupsNow.has(groupId)).toBe(true);
  });

  it("returns everything under budget and gives confirmed-but-empty groups no slot", async () => {
    const stack = await startTestStack(undefined as never, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const created = await stack.request("POST", "/api/projects", { title: "M13.3.1 small", researchIdea: "synthetic", workflowKind: "idea_to_paper" });
    const projectId = (created.body["project"] as { id: string }).id;
    const item = await upload(stack, projectId, SMALL_ZIP, "small.zip");
    // unresolved 组只含 documentation 文件：可确认，但没有结果角色观测——不占名额
    const confirmed = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${item.packageId}/confirm`, { groupIds: ["main", "baseline-s", "unresolved"] });
    expect(confirmed.status).toBe(200);
    const context = await stack.stack.experimentPackages.workflowContext(projectId);
    expect(context.truncated).toBe(false);
    expect(context.observations).toHaveLength(4);
    expect(new Set(context.observations.map((entry) => entry.groupId))).toEqual(new Set(["main", "baseline-s"]));
  });
});
