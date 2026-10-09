/**
 * M13.3 真实材料驱动的确定性修复回归：
 * - JSONL 行流解析（.jsonl → 每行一条 structured_record；不参与指标提取）
 * - TXT 空白对齐表（TrackEval 式原生输出 → table 块 → 可提取指标观测）
 * - 兄弟目录同名文件 → 候选平行实验臂分组
 * - 指标方向词表 / 同组小数-百分数标度混用告警
 * - 源材料判定（verdict 字符串）原样登记
 * - GLM 辅助理解：有界上下文 + 确定性校验 + 未装配时结构化 503
 * 全部数值为合成测试输入，非真实研究结论。
 */

import { crc32 } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import { buildUnderstandingContext, validateSuggestions, SEMANTIC_LIMITS } from "../../src/experiments/semanticUnderstanding.js";
import type { ExperimentModelRuntime } from "../../src/experiments/semanticUnderstanding.js";
import type { ExperimentPackage } from "../../src/experiments/ExperimentPackageService.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

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
    central.writeUInt32LE(0, 38);
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

const ARM_TABLE = (hota: string, idsw: string) =>
  `HOTA DetA AssA IDF1 IDSW Frag\n${hota} ${Number(hota) - 11} ${Number(hota) + 11} ${Number(hota) + 9} ${idsw} 4\n`;

const M133_ZIP = buildStoreZip([
  { path: "results/A0/summary.txt", data: ARM_TABLE("51.2", "12") },
  { path: "results/A1/summary.txt", data: ARM_TABLE("52.7", "11") },
  { path: "results/A2/summary.txt", data: ARM_TABLE("51.9", "12") },
  { path: "notes/about.txt", data: "This is prose, not a table.\nIt has sentences of varying word counts that do not align.\n" },
  { path: "events/stream.jsonl", data: '{"clip":"c1","frame":1,"score":0.5,"door":"T1"}\n{"clip":"c1","frame":2,"score":0.7,"door":"T2"}\n{"clip":"c2","frame":1,"score":0.9,"door":"T1"}\n' },
  { path: "verdict.json", data: JSON.stringify({ verdict: "SYNTHETIC TEST NO-GO", gate: false }) },
  { path: "main/metrics.json", data: JSON.stringify({ HOTA: 0.6261, IDSW: 12 }) },
  { path: "main/summary_metrics.json", data: JSON.stringify({ HOTA: 62.61 }) },
]);

async function upload(stack: TestStack, projectId: string) {
  const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/experiment-packages`, {
    method: "POST", headers: { "Content-Type": "application/zip", "X-Package-Name": "m13-3.zip" }, body: M133_ZIP,
  });
  expect(response.status).toBe(201);
  return (await response.json() as { package: ExperimentPackage }).package;
}

describe("M13.3 deterministic experiment understanding", () => {
  it("parses whitespace tables, JSONL row streams, arm groups, verdicts, directions and scale warnings", async () => {
    const stack = await startTestStack(undefined as never, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const created = await stack.request("POST", "/api/projects", { title: "M13.3 synthetic" });
    const projectId = (created.body["project"] as { id: string }).id;
    const item = await upload(stack, projectId);

    // TXT 空白表：解析 ok + table 块；兄弟目录 → arm-* 候选分组
    const a0 = item.files.find((file) => file.path === "results/A0/summary.txt")!;
    const a1 = item.files.find((file) => file.path === "results/A1/summary.txt")!;
    expect(a0.parseStatus).toBe("ok");
    expect(a0.groupId).toBe("arm-a0");
    expect(a1.groupId).toBe("arm-a1");
    expect(a0.roleBasis).toContain("候选平行实验臂");
    const prose = item.files.find((file) => file.path === "notes/about.txt")!;
    expect(prose.groupId).toBe("unresolved");

    // JSONL：解析 ok、登记为行流、不建结果角色
    const stream = item.files.find((file) => file.path === "events/stream.jsonl")!;
    expect(stream.parseStatus).toBe("ok");
    expect(stream.role).toBe("unknown");
    expect(stream.roleBasis).toContain("JSONL 行流");

    // 源材料判定原样登记
    expect(item.reportedVerdicts).toContainEqual({ path: "verdict.json", field: "$.verdict", value: "SYNTHETIC TEST NO-GO" });

    // 指标方向词表 + 标度混用告警
    const hota = item.observations.find((observation) => observation.metric.endsWith("HOTA") && observation.value === 0.6261)!;
    expect(hota.direction).toBe("higher");
    const idsw = item.observations.find((observation) => observation.metric.endsWith("IDSW") && observation.value === 12)!;
    expect(idsw.direction).toBe("lower");
    expect(item.warnings).toContainEqual(expect.stringContaining("指标 HOTA 在实验组 main 内同时存在小数（0.6261）与百分数量级（62.61）"));

    // JSONL 即便被作者标成结果角色也不产生指标观测（行流 ≠ 指标表）
    await stack.request("PATCH", `/api/projects/${projectId}/experiment-packages/${item.packageId}`, { path: "events/stream.jsonl", role: "main_result", groupId: "main" });
    let current = (await (await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/experiment-packages/${item.packageId}`)).json() as { package: ExperimentPackage }).package;
    expect(current.observations.some((observation) => observation.path === "events/stream.jsonl")).toBe(false);

    // 作者把 A0 表格标为 baseline 后：表格数值进入观测（行/列锚 + 方向）
    await stack.request("PATCH", `/api/projects/${projectId}/experiment-packages/${item.packageId}`, { path: "results/A0/summary.txt", role: "baseline_result", groupId: "baseline-a0" });
    current = (await (await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/experiment-packages/${item.packageId}`)).json() as { package: ExperimentPackage }).package;
    const tableObservation = current.observations.find((observation) => observation.path === "results/A0/summary.txt" && observation.column === "HOTA")!;
    expect(tableObservation.value).toBe(51.2);
    expect(tableObservation.row).toBe(2);
    expect(tableObservation.direction).toBe("higher");
    const idswTable = current.observations.find((observation) => observation.path === "results/A0/summary.txt" && observation.column === "IDSW")!;
    expect(idswTable.value).toBe(12);
    expect(idswTable.direction).toBe("lower");
  });

  it("surfaces structured 503 when semantic model is not wired", async () => {
    const stack = await startTestStack(undefined as never, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const created = await stack.request("POST", "/api/projects", { title: "M13.3 no model" });
    const projectId = (created.body["project"] as { id: string }).id;
    const item = await upload(stack, projectId);
    const response = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${item.packageId}/understand`, {});
    expect(response.status).toBe(503);
    expect((response.body["error"] as { code: string }).code).toBe("SEMANTIC_MODEL_UNAVAILABLE");
  });

  it("runs bounded GLM understanding through the deterministic validator", async () => {
    const runtime: ExperimentModelRuntime = {
      getModel: () => ({ id: "fake" }),
      hasConfiguredAuth: () => true,
      completeSimple: async () => ({
        content: [{ type: "text", text: JSON.stringify({
          roleSuggestions: [
            { path: "results/A0/summary.txt", suggestedRole: "baseline_result", suggestedGroupId: "baseline-a0", rationale: "同名表分布于兄弟目录 A0", anchors: ["results/A0/summary.txt"] },
            { path: "not/in/package.txt", suggestedRole: "main_result", suggestedGroupId: "x", rationale: "幻觉路径", anchors: ["also/fake"] },
            { path: "results/A1/summary.txt", suggestedRole: "not_a_role", suggestedGroupId: "bad id!", rationale: "非法枚举", anchors: ["results/A1/summary.txt"] },
          ],
          findings: [
            { claim: "SYNTHETIC TEST NO-GO 判定记录在 verdict.json", confidence: "high", anchors: ["verdict.json"] },
            { claim: "HOTA 从 0.6261 变为 0.9999", confidence: "high", anchors: ["main/metrics.json"] },
            { claim: "IDSW 为 12", confidence: "medium", anchors: ["main/metrics.json"] },
          ],
        }) }],
        usage: { input: 2100, output: 380 },
        stopReason: "stop",
      }),
    };
    const stack = await startTestStack(undefined as never, { registerCleanup: (cleanup) => cleanups.push(cleanup), experimentSemanticModel: { runtime, defaultModel: () => "fake/model-a" } });
    const created = await stack.request("POST", "/api/projects", { title: "M13.3 semantic" });
    const projectId = (created.body["project"] as { id: string }).id;
    const item = await upload(stack, projectId);
    const response = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${item.packageId}/understand`, {});
    expect(response.status).toBe(200);
    const suggestions = (response.body["package"] as ExperimentPackage).semanticSuggestions!;
    expect(suggestions.model).toBe("fake/model-a");
    expect(suggestions.usage?.input).toBe(2100);
    // 合法角色建议保留；幻觉路径 / 非法枚举丢弃
    expect(suggestions.roleSuggestions).toHaveLength(1);
    expect(suggestions.roleSuggestions[0]).toMatchObject({ path: "results/A0/summary.txt", suggestedRole: "baseline_result", status: "needs_author_confirmation" });
    // 无数值 / 数值可核验的 finding 保留；捏造 0.9999 的丢弃
    expect(suggestions.findings.map((finding) => finding.claim)).toContain("IDSW 为 12");
    expect(suggestions.findings.some((finding) => finding.claim.includes("0.9999"))).toBe(false);
    expect(suggestions.notes.join(" ")).toContain("数值未在锚定文件观测中找到");
    // 上下文有界：观测摘要每文件 ≤ 上限
    const context = JSON.parse(buildUnderstandingContext(item));
    for (const sample of Object.values(context.metricObservations as Record<string, { sample: unknown[] }>)) {
      expect(sample.sample.length).toBeLessThanOrEqual(SEMANTIC_LIMITS.contextObservationsPerFile);
    }
  });

  it("validator keeps verdict-only claims without numeric anchors and drops unanchored numbers", () => {
    const item = {
      files: [{ path: "v.json" }, { path: "m.json" }],
      observations: [{ path: "m.json", metric: "$.HOTA", value: 0.5, groupId: "main" }],
      groups: [], relationCandidates: [], warnings: [],
    } as unknown as ExperimentPackage;
    const { suggestions } = validateSuggestions({
      findings: [
        { claim: "verdict says STOP", anchors: ["v.json"] },
        { claim: "value is 0.7", anchors: ["v.json"] },
        { claim: "value is 0.5", anchors: ["m.json"] },
        { claim: "K is 3", anchors: ["v.json"] },
      ],
    }, item);
    expect(suggestions.findings.map((finding) => finding.claim)).toEqual(["verdict says STOP", "value is 0.5", "K is 3"]);
  });
});
