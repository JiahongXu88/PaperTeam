/**
 * M14.9.5.4 预先登记的实验论断复算（experiments/claimChecks.ts）——零模型、合成夹具。
 *
 * 必须区分的结局（任务书验收 A）：
 *   - 真矛盾 → CONTRADICTED（复算值 ≠ 稿件值）；正确对照 → CONSISTENT；
 *   - 错协议 / 缺列 / 过期修订（哈希不符）/ 冲突版本 / 越界数据 / 未授权输入 / 包外路径 / 稿件锚点失效
 *     一律 NOT_EVALUATED，且证据等级永远到不了 verified（最高 RECOMPUTED_FROM_AUTHOR_DATA）。
 *   - 白名单表达式：任何代码 / 未知函数都被拒绝；同一输入 → 同一账本哈希。
 */
import { describe, expect, it } from "vitest";

import {
  CLAIM_CHECK_PLAN_SCHEMA,
  claimCheckFinding,
  claimChecksInText,
  evaluateClaimCheckPlan,
  parseExpression,
  renderClaimCheckBlock,
  summarizeClaimChecksForGate,
  validateClaimCheckPlan,
  type ClaimCheckEnvironment,
  type ClaimCheckPlan,
  type ClaimCheckSpec,
} from "../../src/experiments/claimChecks.js";
import type { ParsedDocument } from "../../src/ingestion/types.js";

const H = (char: string) => char.repeat(64);
const EVENTS_HASH = H("a");
const PARAMS_HASH = H("b");
const MANIFEST_HASH = H("c");
const OTHER_EVENTS_HASH = H("d");
const CONFIG_HASH = H("e");

const EVENTS_CSV = [
  // kind, in_pool, gap, cost_without, cost_with, victim_cost_without, victim_cost_with, split
  ["TAKEOVER", "True", "5", "0.40", "0.70", "0.30", "0.90", "dev"],
  ["TAKEOVER", "True", "9", "0.50", "0.60", "0.20", "0.95", "dev"],
  ["TAKEOVER", "True", "3", "0.45", "0.80", "0.35", "0.50", "conf"], // victim 更便宜但运动项后也更便宜 → 不由运动项决定
  ["TAKEOVER", "False", "4", "0.50", "0.50", "0.10", "0.10", "dev"],
  ["BIRTH", "True", "7", "", "", "", "", "dev"],
];
const HEADERS = ["kind", "in_pool", "gap", "nt", "wt", "nv", "wv", "split"];

function tabular(sourceId: string, contentHash: string, rows: string[][], headers = HEADERS): ParsedDocument {
  return {
    schemaVersion: 1, sourceId, fileName: `${sourceId}.csv`, storedFileName: `${sourceId}.csv`, kind: "tabular", mimeType: "text/csv",
    parser: { id: "csv" }, parseMode: "structured", status: "ok",
    sheets: [{ name: "csv", rowCount: rows.length, columnCount: headers.length, headers }],
    blocks: rows.map((row, index) => ({
      blockId: `B${String(index + 1).padStart(4, "0")}`, type: "structured_record" as const,
      provenance: { fileName: `${sourceId}.csv`, row: index + 2 },
      cells: row.flatMap((value, column) => (value === "" ? [] : [{ header: headers[column]!, value }])),
    })),
    counts: { text: 0, table: 0, figure: 0, formula: 0, structured_record: rows.length, code: 0, output: 0 },
    notes: [], contentHash, parsedAt: "2026-10-21T00:00:00Z",
  } as unknown as ParsedDocument;
}

function json(sourceId: string, contentHash: string, cells: Record<string, string>): ParsedDocument {
  return {
    schemaVersion: 1, sourceId, fileName: `${sourceId}.json`, storedFileName: `${sourceId}.json`, kind: "text", mimeType: "application/json",
    parser: { id: "json" }, parseMode: "structured", status: "ok",
    blocks: Object.entries(cells).map(([header, value], index) => ({
      blockId: `B${String(index + 1).padStart(4, "0")}`, type: "structured_record" as const,
      provenance: { fileName: `${sourceId}.json`, jsonPath: header }, cells: [{ header, value }],
    })),
    counts: { text: 0, table: 0, figure: 0, formula: 0, structured_record: Object.keys(cells).length, code: 0, output: 0 },
    notes: [], contentHash, parsedAt: "2026-10-21T00:00:00Z",
  } as unknown as ParsedDocument;
}

const MANUSCRIPT = [
  "\\section{诊断}",
  "在 3 起可判定吞并中，有 3 起去掉运动项后改判给合法轨迹，即 3 起由运动项决定。",
  "冻结参数下 IoU 项的幅度上限为 0.45（候选对受 IoU 门控 0.3 约束）。",
].join("\n");

function environment(overrides: Partial<{ documents: Record<string, ParsedDocument | null>; liveHashes: Record<string, string | null>; manuscript: string; extraFiles: ClaimCheckEnvironment["packages"][number]["files"]; groupStatus: Record<string, string> }> = {}): ClaimCheckEnvironment {
  const documents: Record<string, ParsedDocument | null> = {
    S1: tabular("S1", EVENTS_HASH, EVENTS_CSV),
    S2: json("S2", PARAMS_HASH, { "$.frozen.alpha_iou": "0.45", "$.frozen.iou_gate": "0.3", "$.frozen.tau": "9.4877", "$.schema": "forensics.v1" }),
    S3: json("S3", MANIFEST_HASH, { "$.files[\"events.csv\"].sha256": EVENTS_HASH }),
    S4: tabular("S4", OTHER_EVENTS_HASH, EVENTS_CSV.slice(0, 2)),
    S5: json("S5", CONFIG_HASH, { "$.tau": "9.49" }),
    ...overrides.documents,
  };
  const live: Record<string, string | null> = { S1: EVENTS_HASH, S2: PARAMS_HASH, S3: MANIFEST_HASH, S4: OTHER_EVENTS_HASH, S5: CONFIG_HASH, ...overrides.liveHashes };
  const groupStatus = { main: "confirmed", "shared-config": "candidate", ...overrides.groupStatus };
  return {
    packages: [{
      packageId: `ep-${"1".repeat(32)}`, packageHash: H("1"),
      files: [
        { path: "results/events.csv", hash: EVENTS_HASH, sourceId: "S1", parseStatus: "ok", groupId: "main", role: "main_result" },
        { path: "results/persistence.json", hash: PARAMS_HASH, sourceId: "S2", parseStatus: "ok", groupId: "main", role: "main_result" },
        { path: "results/SOURCES.json", hash: MANIFEST_HASH, sourceId: "S3", parseStatus: "ok", groupId: "main", role: "main_result" },
        { path: "results/h1h4_events.csv", hash: OTHER_EVENTS_HASH, sourceId: "S4", parseStatus: "ok", groupId: "main", role: "main_result" },
        { path: "config/tracker.json", hash: CONFIG_HASH, sourceId: "S5", parseStatus: "ok", groupId: "shared-config", role: "experiment_config" },
        ...(overrides.extraFiles ?? []),
      ],
      groups: Object.entries(groupStatus).map(([id, status]) => ({ id, status, ...(id === "main" ? { splitScopes: [{ status: "confirmed", workflowUse: "allowed", filePaths: ["results/events.csv", "results/persistence.json", "results/SOURCES.json", "results/h1h4_events.csv"] }] } : {}) })),
    }],
    loadDocument: async (sourceId) => documents[sourceId] ?? null,
    sourceHash: async (sourceId) => live[sourceId] ?? null,
    manuscript: { revision: 3, files: [{ file: "sections/diag.tex", content: overrides.manuscript ?? MANUSCRIPT }] },
  };
}

const ref = (path: string, sha256: string, jsonPath: string) => ({ path, sha256, jsonPath });
const BASE_PROTOCOL = { id: "base-forensics", assertions: [{ kind: "source_manifest_sha256" as const, manifest: ref("results/SOURCES.json", MANIFEST_HASH, "$.files[\"events.csv\"].sha256") }] };
const PAIRWISE: Omit<ClaimCheckSpec, "id" | "title" | "claim"> = {
  materiality: "core",
  source: { path: "results/events.csv", sha256: EVENTS_HASH },
  protocol: BASE_PROTOCOL,
  filters: [{ column: "kind", equals: "TAKEOVER" }, { column: "in_pool", equals: "True" }],
  calculation: { aggregate: "count", where: "nv < nt && wt <= wv", description: "去掉运动项后合法轨迹更便宜且加上运动项后吞并者不更贵" },
  conditions: "成对反事实",
};
const L1_COUNT: ClaimCheckSpec = {
  id: "L1", title: "去掉运动项后改判", materiality: "core",
  claim: { quote: "有 3 起去掉运动项后改判给合法轨迹", value: 3 },
  source: { path: "results/events.csv", sha256: EVENTS_HASH }, protocol: BASE_PROTOCOL,
  filters: PAIRWISE.filters!, calculation: { aggregate: "count", where: "nv < nt", description: "去掉运动项后合法轨迹更便宜" },
};
const MOTION_DECIDED: ClaimCheckSpec = { ...PAIRWISE, id: "MOT", title: "由运动项决定", claim: { quote: "即 3 起由运动项决定", value: 3 } };
const IOU_BOUND: ClaimCheckSpec = {
  id: "IOU", title: "IoU 项上限", materiality: "supporting",
  claim: { quote: "IoU 项的幅度上限为 0.45（候选对受 IoU 门控 0.3 约束）", value: 0.45 },
  parameters: { alpha_iou: [ref("results/persistence.json", PARAMS_HASH, "$.frozen.alpha_iou")], gate: [ref("results/persistence.json", PARAMS_HASH, "$.frozen.iou_gate")] },
  protocol: { id: "frozen-params", assertions: [{ kind: "json_equals", ref: ref("results/persistence.json", PARAMS_HASH, "$.schema"), equals: "forensics.v1" }] },
  calculation: { aggregate: "scalar", value: "$alpha_iou * (1 - $gate)", description: "门控后 IoU 项最大值 α_iou·(1−gate)" },
};
const plan = (...checks: ClaimCheckSpec[]): ClaimCheckPlan => ({ schema: CLAIM_CHECK_PLAN_SCHEMA, checks });

describe("实验论断复算：已知真矛盾与正确对照可区分", () => {
  it("同一数据：L1 计数 3 = 稿件 3（CONSISTENT）；「由运动项决定」只有 2 起 ≠ 稿件 3（CONTRADICTED）；IoU 上限 0.315 ≠ 0.45", async () => {
    const ledger = await evaluateClaimCheckPlan(plan(L1_COUNT, MOTION_DECIDED, IOU_BOUND), environment());
    const byId = new Map(ledger.results.map((result) => [result.id, result]));
    expect(byId.get("L1")).toMatchObject({ verdict: "CONSISTENT", derivedValue: 3, manuscriptValue: 3 });
    expect(byId.get("MOT")).toMatchObject({ verdict: "CONTRADICTED", derivedValue: 2, manuscriptValue: 3 });
    expect(byId.get("IOU")).toMatchObject({ verdict: "CONTRADICTED", derivedValue: 0.315 });
    for (const result of ledger.results) {
      expect(result.evidence.level).toBe("RECOMPUTED_FROM_AUTHOR_DATA");
      expect(result.evidence.sourceAuthenticity).toBe("AUTHOR_SUPPLIED_UNVERIFIED");
      expect(result.evidence.externalVerification).toBe("NOT_EXTERNALLY_VERIFIED");
      expect(result.protocol.status).toBe("VERIFIED_BY_SOURCE");
      expect(result.claimAnchor).toMatchObject({ found: true, file: "sections/diag.tex", manuscriptRevision: 3 });
    }
    expect(byId.get("MOT")!.rows).toEqual({ total: 5, afterFilters: 3, selected: 2 });
    expect(ledger.counts).toEqual({ registered: 3, consistent: 1, contradicted: 2, notEvaluated: 0 });
    // 确定性：同一输入 → 同一账本哈希
    expect((await evaluateClaimCheckPlan(plan(L1_COUNT, MOTION_DECIDED, IOU_BOUND), environment())).ledgerHash).toBe(ledger.ledgerHash);
  });

  it("Gate 摘要 / prompt 块 / 确定性 finding 引用同一账本", async () => {
    const ledger = await evaluateClaimCheckPlan(plan(L1_COUNT, MOTION_DECIDED), environment());
    const summary = summarizeClaimChecksForGate(ledger, 1);
    expect(summary).toMatchObject({ registered: 2, consistent: 1, notEvaluated: [], ledgerHash: ledger.ledgerHash, experimentPackages: 1 });
    expect(summary.contradicted).toEqual([{ id: "MOT", materiality: "core", manuscriptValue: 3, derivedValue: 2 }]);
    const block = renderClaimCheckBlock(claimChecksInText(ledger.results, MANUSCRIPT)).join("\n");
    expect(block).toContain("[CC-MOT]");
    expect(block).toContain("复算值 2 → 与稿件不一致（CONTRADICTED）");
    expect(block).toContain("[CC-L1]");
    expect(block).toContain("与稿件一致（CONSISTENT）");
    expect(block).not.toContain("TAKEOVER,True"); // 不塞原始数据行
    expect(claimChecksInText(ledger.results, "无关的单元文本")).toEqual([]);
    // alsoAt：同一论断在别处的逐字复述（摘要 / 讨论）所在单元同样附上复算结果
    const withEcho = await evaluateClaimCheckPlan(plan({ ...MOTION_DECIDED, claim: { ...MOTION_DECIDED.claim, alsoAt: ["摘要：3 起由运动项决定。"] } }), environment({ manuscript: `${MANUSCRIPT}
摘要：3 起由运动项决定。` }));
    expect(withEcho.results[0]!.claimAnchor.alsoAt).toEqual([{ quote: "摘要：3 起由运动项决定。", found: true }]);
    expect(claimChecksInText(withEcho.results, "摘要：3 起由运动项决定。")).toHaveLength(1);
    expect(renderClaimCheckBlock([])).toEqual([]);
    const finding = claimCheckFinding(ledger.results.find((result) => result.id === "MOT")!, "诊断", ledger.ledgerHash);
    expect(finding).toMatchObject({ category: "fact", severity: "major", rootCauseKey: "claim-check:MOT", blocking: false });
    expect(finding.description).toContain("复算为 2");
    expect(finding.claimCheck).toMatchObject({ manuscriptValue: 3, derivedValue: 2, dataSha256: EVENTS_HASH });
  });

  it("布尔论断（结论在更紧上界下仍成立）是正确对照", async () => {
    const env = environment({ manuscript: `${MANUSCRIPT}\n运动项超过其余两项之和（1.90 对 0.80）。` });
    const ledger = await evaluateClaimCheckPlan(plan({
      ...IOU_BOUND, id: "DOM", materiality: "core", claim: { quote: "运动项超过其余两项之和（1.90 对 0.80）", value: 1, kind: "boolean" },
      parameters: { ...IOU_BOUND.parameters!, tau: [ref("results/persistence.json", PARAMS_HASH, "$.frozen.tau")] },
      calculation: { aggregate: "scalar", value: "0.2 * $tau > $alpha_iou * (1 - $gate) + 0.35", description: "门控后紧上界下运动项仍大于其余两项之和" },
    }), env);
    expect(ledger.results[0]).toMatchObject({ verdict: "CONSISTENT", derivedValue: 1, valueKind: "boolean" });
  });
});

describe("数据缺口一律 NOT_EVALUATED（不猜、不换相似实验、不升级为已核验）", () => {
  const expectGap = async (spec: ClaimCheckSpec, code: string, env = environment()) => {
    const ledger = await evaluateClaimCheckPlan(plan(spec), env);
    const result = ledger.results[0]!;
    expect(result.verdict).toBe("NOT_EVALUATED");
    expect(result.derivedValue).toBeNull();
    expect(result.evidence.level).toBe("NOT_EVALUATED");
    expect(result.evidence.derivation).toBe("NOT_RECOMPUTED");
    expect(result.gaps.map((gap) => gap.code)).toContain(code);
    return result;
  };

  it("缺列（不匹配相似列）", async () => {
    await expectGap({ ...MOTION_DECIDED, calculation: { aggregate: "count", where: "motion_flip == 1", description: "x" } }, "COLUMN_MISSING");
  });

  it("错协议：另一实验臂的事件表（来源清单记录的哈希不是它）", async () => {
    await expectGap({ ...MOTION_DECIDED, source: { path: "results/h1h4_events.csv", sha256: OTHER_EVENTS_HASH } }, "PROTOCOL_MISMATCH");
  });

  it("越界数据：选中行的 split 超出登记范围", async () => {
    await expectGap({ ...MOTION_DECIDED, protocol: { id: "dev-only", assertions: [{ kind: "column_values_in", column: "split", values: ["dev"] }] } }, "PROTOCOL_MISMATCH");
  });

  it("过期修订：登记哈希与包内文件哈希不符；Source / 解析产物已变化", async () => {
    await expectGap({ ...MOTION_DECIDED, source: { path: "results/events.csv", sha256: H("9") } }, "SOURCE_HASH_MISMATCH");
    await expectGap(MOTION_DECIDED, "SOURCE_HASH_MISMATCH", environment({ liveHashes: { S1: H("8") } }));
    await expectGap(MOTION_DECIDED, "SOURCE_HASH_MISMATCH", environment({ documents: { S1: tabular("S1", H("7"), EVENTS_CSV) } }));
  });

  it("冲突版本：同一参数两个来源取值不同（9.4877 vs 9.49）", async () => {
    await expectGap({
      ...IOU_BOUND, parameters: { ...IOU_BOUND.parameters!, tau: [ref("results/persistence.json", PARAMS_HASH, "$.frozen.tau"), ref("results/persistence.json", PARAMS_HASH, "$.frozen.alpha_iou")] },
      calculation: { aggregate: "scalar", value: "$tau", description: "x" },
    }, "CONFLICTING_VERSIONS");
  });

  it("未授权输入：所在实验组未经作者确认", async () => {
    const result = await expectGap({ ...IOU_BOUND, parameters: { ...IOU_BOUND.parameters!, alpha_iou: [ref("config/tracker.json", CONFIG_HASH, "$.tau")] } }, "UNAUTHORIZED_INPUT");
    expect(result.evidence.authorization).toBe("UNAUTHORIZED");
  });

  it("包外 / 越界路径与不存在的文件", async () => {
    await expectGap({ ...MOTION_DECIDED, source: { path: "../../secrets.csv", sha256: EVENTS_HASH } }, "OUT_OF_PACKAGE");
    await expectGap({ ...MOTION_DECIDED, source: { path: "D:/data/events.csv", sha256: EVENTS_HASH } }, "OUT_OF_PACKAGE");
    await expectGap({ ...MOTION_DECIDED, source: { path: "results/missing.csv", sha256: EVENTS_HASH } }, "SOURCE_NOT_AVAILABLE");
  });

  it("稿件锚点失效（论断已修改 / 登记针对旧版本）：不沿用旧结论", async () => {
    await expectGap(MOTION_DECIDED, "MANUSCRIPT_ANCHOR_NOT_FOUND", environment({ manuscript: "\\section{诊断}\n改写后的句子：14 起由运动项决定。" }));
  });

  it("选中行缺值：不按 0 处理", async () => {
    await expectGap({ ...MOTION_DECIDED, filters: [{ column: "kind", equals: "BIRTH" }] }, "VALUE_MISSING");
  });
});

describe("计划校验与白名单表达式", () => {
  it("拒绝代码、未知函数与成员访问", () => {
    expect(() => parseExpression("process.exit(1)")).toThrow();
    expect(() => parseExpression("require('fs')")).toThrow();
    expect(() => parseExpression("eval(1)")).toThrow();
    expect(() => parseExpression("a; b")).toThrow();
    expect(() => parseExpression("min(a, b) + abs(-c) * 2 >= $x && !(d != 1) || e < 3")).not.toThrow();
  });

  it("validateClaimCheckPlan：schema / id / 哈希 / 表达式 / 逐行计算需要 source", () => {
    expect(validateClaimCheckPlan(plan(L1_COUNT, MOTION_DECIDED, IOU_BOUND))).toEqual([]);
    const problems = validateClaimCheckPlan({ schema: "x", checks: [{ ...L1_COUNT, id: "bad id", source: undefined, calculation: { aggregate: "count", where: "a +", description: "d" } }, { ...L1_COUNT, source: { path: "a.csv", sha256: "short" } }] });
    expect(problems.join("\n")).toMatch(/schema/);
    expect(problems.join("\n")).toMatch(/id 非法/);
    expect(problems.join("\n")).toMatch(/逐行计算需要 source/);
    expect(problems.join("\n")).toMatch(/sha256/);
    expect(problems.join("\n")).toMatch(/表达式/);
  });

  it("未登记计划 → 空账本（Gate：有实验包 → NOT_EVALUATED 不阻断）；计划损坏 → 必需 NOT_EVALUATED", async () => {
    const empty = await evaluateClaimCheckPlan(null, environment());
    expect(empty.results).toEqual([]);
    expect(summarizeClaimChecksForGate(empty, 2)).toMatchObject({ registered: 0, experimentPackages: 2 });
    const broken = await evaluateClaimCheckPlan(null, environment(), { planError: "claim-checks.json 不是合法 JSON" });
    expect(summarizeClaimChecksForGate(broken, 1).notEvaluated).toEqual([expect.objectContaining({ id: "(plan)", required: true })]);
  });
});
