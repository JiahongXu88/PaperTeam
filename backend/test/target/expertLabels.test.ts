import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_TIERS,
  DIMENSIONS,
  DIMENSION_TIERS,
  EXPERT_LABEL_SCHEMA_VERSION,
  OVERALL_TIERS,
  CSV_COLUMNS,
  freezeLabels,
  parseCsv,
  parseLabelsCsv,
  validateLabels,
  sha256Of,
  type SampleManifest,
} from "../../src/target/expertLabels.js";

/** 构造合法行（可覆盖任意列） */
function makeRow(overrides: Record<string, string> = {}): Record<string, string> {
  const row: Record<string, string> = {
    reviewer_id: "R1",
    packet_id: "P1",
    sample_id: "P1-S01",
    venue: "cjig",
    document_type_read: "research",
    overall: "NEAR_WITH_GAPS",
    overall_rationale: "实验支撑是主导差距",
    confidence: "MEDIUM",
    missing_info: "",
    coi_disclosure: "NONE",
    notes: "",
    review_date: "2026-11-20",
  };
  for (const d of DIMENSIONS) {
    row[d] = "ADEQUATE";
    row[`${d}_evidence`] = `p3 §${d.length} 有对照`;
  }
  return { ...row, ...overrides };
}

const csvLine = (row: Record<string, string>) =>
  CSV_COLUMNS.map((c) => {
    const v = row[c] ?? "";
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",");

function toCsv(rows: Array<Record<string, string>>): string {
  return [CSV_COLUMNS.join(","), ...rows.map(csvLine)].join("\n") + "\n";
}

/** 13 族 × 2 刊 × 2 评审的合法 manifest + 行集（P1/P2 双包同一批族） */
function makeFullFixture() {
  const families: SampleManifest["families"] = {};
  const packets: SampleManifest["packets"] = {
    P1: { samples: [] },
    P2: { samples: [] },
  };
  for (let i = 1; i <= 13; i += 1) {
    const familyKey = `fresh-${String(i).padStart(2, "0")}`;
    families[familyKey] = { doi: `10.11834/jig.fresh${i}`, source: "corpus-fresh", devOnly: false };
    (packets.P1 ?? { samples: [] }).samples.push({ sampleId: `P1-S${String(i).padStart(2, "0")}`, familyKey });
    (packets.P2 ?? { samples: [] }).samples.push({ sampleId: `P2-A${String(i).padStart(2, "0")}`, familyKey });
  }
  families["mot-b1"] = { doi: null, source: "author-manuscript", devOnly: true, devReason: "M15.9 rubric 开发语料" };
  const manifest: SampleManifest = {
    schemaVersion: 1,
    packets,
    families,
    benchmarkDois: ["10.11834/jig.210794"],
    rightsVerifiedAt: "2026-12-01T00:00:00.000Z",
  };
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i <= 13; i += 1) {
    for (const reviewer of ["RA", "RB"]) {
      const packet = reviewer === "RA" ? "P1" : "P2";
      const sample = reviewer === "RA" ? `P1-S${String(i).padStart(2, "0")}` : `P2-A${String(i).padStart(2, "0")}`;
      for (const venue of ["cjig", "cea"] as const) {
        rows.push(makeRow({ reviewer_id: reviewer, packet_id: packet, sample_id: sample, venue }));
      }
    }
  }
  return { manifest, rows };
}

describe("M15.10 expertLabels：CSV 解析", () => {
  it("引号字段内的逗号与换线不破坏列对齐", () => {
    const table = parseCsv('a,"b,c",\n"d\ne",f,g');
    expect(table).toEqual([
      ["a", "b,c", ""],
      ["d\ne", "f", "g"],
    ]);
  });
  it("BOM 与 CRLF 归一", () => {
    const table = parseCsv("﻿a,b\r\nc,d\r\n");
    expect(table).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
  it("表头不符整体拒绝（V0）", () => {
    const { rows, findings } = parseLabelsCsv("wrong,header\n1,2\n");
    expect(rows).toHaveLength(0);
    expect(findings[0]?.rule).toBe("V0");
    expect(findings[0]?.severity).toBe("REJECT");
  });
});

describe("M15.10 expertLabels：行级校验 V1-V7", () => {
  const baseManifest = (): SampleManifest => ({
    schemaVersion: 1,
    packets: { P1: { samples: [{ sampleId: "P1-S01", familyKey: "f1" }] } },
    families: { f1: { doi: null, source: "test", devOnly: false } },
    benchmarkDois: [],
    rightsVerifiedAt: "2026-12-01T00:00:00.000Z",
  });

  it("合法行通过且 abstention（V7）合法", () => {
    const rows = [
      makeRow({
        overall: "UNDECIDABLE",
        novelty: "INSUFFICIENT_EVIDENCE",
        novelty_evidence: "综述缺近三年文献明细，无法判新颖度",
        overall_rationale: "材料不足",
      }),
    ];
    const report = validateLabels(rows, baseManifest());
    expect(report.findings.filter((f) => f.severity === "REJECT")).toHaveLength(0);
    expect(report.stats.rowsOk).toBe(1);
  });

  it("V1：枚举非法与必填空被拒", () => {
    const rows = [makeRow({ novelty: "较好", clarity: "" })];
    const report = validateLabels(rows, baseManifest());
    const rejects = report.findings.filter((f) => f.rule === "V1");
    expect(rejects.map((r) => r.column).sort()).toEqual(["clarity", "novelty"]);
    expect(report.ok).toBe(false);
  });

  it("V2：同键重复行被拒", () => {
    const rows = [makeRow(), makeRow()];
    const report = validateLabels(rows, baseManifest());
    expect(report.findings.some((f) => f.rule === "V2" && f.severity === "REJECT")).toBe(true);
  });

  it("V3：sample 不在包内被拒", () => {
    const rows = [makeRow({ sample_id: "P1-S99" })];
    const report = validateLabels(rows, baseManifest());
    expect(report.findings.some((f) => f.rule === "V3")).toBe(true);
  });

  it("V4：同一评审员出现在两个包 → 全行拒绝", () => {
    const manifest: SampleManifest = {
      schemaVersion: 1,
      packets: {
        P1: { samples: [{ sampleId: "P1-S01", familyKey: "f1" }] },
        P2: { samples: [{ sampleId: "P2-A01", familyKey: "f1" }] },
      },
      families: { f1: { doi: null, source: "test", devOnly: false } },
      benchmarkDois: [],
      rightsVerifiedAt: "2026-12-01T00:00:00.000Z",
    };
    const rows = [
      makeRow({ reviewer_id: "RX", packet_id: "P1", sample_id: "P1-S01" }),
      makeRow({ reviewer_id: "RX", packet_id: "P2", sample_id: "P2-A01" }),
    ];
    const report = validateLabels(rows, manifest);
    expect(report.findings.some((f) => f.rule === "V4" && f.severity === "REJECT")).toBe(true);
    expect(report.stats.rowsOk).toBe(0);
  });

  it("V5：COI 行保留但排除出金标准", () => {
    const rows = [makeRow({ coi_disclosure: "疑似合作者稿件" })];
    const report = validateLabels(rows, baseManifest());
    expect(report.ok).toBe(true);
    expect(report.stats.rowsExcludedCoi).toBe(1);
    expect(report.stats.rowsOk).toBe(0);
    expect(report.stats.perVenueFamiliesWithTwoReviewers.cjig).toBe(0);
  });

  it("V6：证据缺定位特征 → WARNING 不阻断", () => {
    const rows = [makeRow({ novelty_evidence: "感觉一般" })];
    const report = validateLabels(rows, baseManifest());
    expect(report.findings.some((f) => f.rule === "V6")).toBe(true);
    expect(report.ok).toBe(true);
  });
});

describe("M15.10 expertLabels：盲测前置门 V8 与泄漏拒绝 V9", () => {
  it("满配 13 族 × 2 评审 × 2 刊 → blindTestTriggered=true", () => {
    const { manifest, rows } = makeFullFixture();
    const report = validateLabels(rows, manifest);
    expect(report.findings.filter((f) => f.severity === "REJECT")).toHaveLength(0);
    expect(report.stats.perVenueFamiliesWithTwoReviewers).toEqual({ cjig: 13, cea: 13 });
    expect(report.blindTestTriggered).toBe(true);
  });

  it("缺第二名评审（仅 9/13 族双评审）→ 不触发且给出 blocker", () => {
    const { manifest, rows } = makeFullFixture();
    const trimmed = rows.filter(
      (r) => !(r.reviewer_id === "RB" && ["P2-A10", "P2-A11", "P2-A12", "P2-A13"].includes(String(r.sample_id))),
    );
    const report = validateLabels(trimmed, manifest);
    expect(report.blindTestTriggered).toBe(false);
    expect(report.blockers.join(" ")).toContain("9/10");
  });

  it("只评 cjig 一刊 → cea 侧不达标", () => {
    const { manifest, rows } = makeFullFixture();
    const report = validateLabels(rows.filter((r) => r.venue === "cjig"), manifest);
    expect(report.blindTestTriggered).toBe(false);
    expect(report.blockers.join(" ")).toContain("cea 双评审 held-out 族 0/10");
  });

  it("rightsVerifiedAt 缺失 → 不触发（LABEL_RIGHTS_VERIFIED=false）", () => {
    const { manifest, rows } = makeFullFixture();
    delete manifest.rightsVerifiedAt;
    const report = validateLabels(rows, manifest);
    expect(report.blindTestTriggered).toBe(false);
    expect(report.blockers.join(" ")).toContain("LABEL_RIGHTS_VERIFIED=false");
  });

  it("V9：manifest 中 benchmark DOI 未标 devOnly → manifest 级 REJECT", () => {
    const { manifest, rows } = makeFullFixture();
    manifest.families["fresh-01"] = { doi: "10.11834/JIG.210794", source: "benchmark", devOnly: false };
    const report = validateLabels(rows, manifest);
    const v9 = report.findings.find((f) => f.rule === "V9");
    expect(v9?.severity).toBe("REJECT");
    expect(v9?.message).toContain("泄漏");
  });

  it("devOnly 族（MOT）不计入 held-out 覆盖", () => {
    const { manifest, rows } = makeFullFixture();
    (manifest.packets.P1 ?? { samples: [] }).samples.push({ sampleId: "P1-S14", familyKey: "mot-b1" });
    (manifest.packets.P2 ?? { samples: [] }).samples.push({ sampleId: "P2-A14", familyKey: "mot-b1" });
    rows.push(
      makeRow({ reviewer_id: "RA", packet_id: "P1", sample_id: "P1-S14" }),
      makeRow({ reviewer_id: "RB", packet_id: "P2", sample_id: "P2-A14" }),
    );
    const report = validateLabels(rows, manifest);
    expect(report.stats.heldoutFamiliesPerVenue.cjig).toBe(13); // 14 行族中 mot-b1 不计
  });
});

describe("M15.10 expertLabels：冻结与确定性（V10）", () => {
  it("REJECT 存在时禁止冻结", () => {
    const manifest: SampleManifest = {
      schemaVersion: 1,
      packets: { P1: { samples: [{ sampleId: "P1-S01", familyKey: "f1" }] } },
      families: { f1: { doi: null, source: "test", devOnly: false } },
      benchmarkDois: [],
      rightsVerifiedAt: "2026-12-01T00:00:00.000Z",
    };
    const { error } = freezeLabels([makeRow({ novelty: "较好" })], manifest, { frozenAt: "2026-12-02T00:00:00.000Z" });
    expect(error).toContain("REJECT");
  });

  it("冻结产物结构 + 行级/总 SHA；同输入两次冻结逐字节一致", () => {
    const { manifest, rows } = makeFullFixture();
    const a = freezeLabels(rows, manifest, { frozenAt: "2026-12-02T00:00:00.000Z" });
    const b = freezeLabels(rows, manifest, { frozenAt: "2026-12-02T00:00:00.000Z" });
    expect(a.frozen).toBeTruthy();
    expect(a.frozen?.schemaVersion).toBe(EXPERT_LABEL_SCHEMA_VERSION);
    expect(a.frozen?.blindTestTriggered).toBe(true);
    expect(a.frozen?.rows.every((r) => r.__rowSha256.length === 64)).toBe(true);
    expect(JSON.stringify(a.frozen)).toBe(JSON.stringify(b.frozen));

    // 校验报告确定性：无时间戳，两次运行逐字节相同
    const reportA = JSON.stringify(validateLabels(rows, manifest));
    const reportB = JSON.stringify(validateLabels(rows, manifest));
    expect(reportA).toBe(reportB);
  });

  it("canonicalJson：键序无关、undefined 剔除", () => {
    expect(sha256Of({ b: 1, a: 2 })).toBe(sha256Of({ a: 2, b: 1 }));
    expect(sha256Of({ a: undefined, b: 1 })).toBe(sha256Of({ b: 1 }));
  });

  it("合法 CSV 文本端到端：parse → validate 全绿", () => {
    const { manifest, rows } = makeFullFixture();
    const parsed = parseLabelsCsv(toCsv(rows));
    expect(parsed.findings).toHaveLength(0);
    const report = validateLabels(parsed.rows, manifest);
    expect(report.ok).toBe(true);
    expect(report.blindTestTriggered).toBe(true);
  });
});

describe("M15.10 expertLabels：枚举完整性（防拼写漂移）", () => {
  it("档位枚举与任务书/rubric 一致", () => {
    expect([...DIMENSION_TIERS]).toEqual(["STRONG", "ADEQUATE", "WEAK", "INSUFFICIENT_EVIDENCE"]);
    expect([...OVERALL_TIERS]).toEqual([
      "REACHES_VENUE_LEVEL",
      "NEAR_WITH_GAPS",
      "CLEARLY_BELOW",
      "UNDECIDABLE",
    ]);
    expect([...CONFIDENCE_TIERS]).toEqual(["HIGH", "MEDIUM", "LOW"]);
    expect(CSV_COLUMNS).toHaveLength(24);
  });
});
