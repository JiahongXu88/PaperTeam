/**
 * M15.10 独立专家期刊级质量标签——校验与冻结核心（确定性、零模型）。
 *
 * 定位：Phase B 标签交付 → Phase C 冻结 → Phase D 盲测前置门之间的唯一数据通道。
 * 不接 HTTP、不进 gates/工作流（Phase E 红线：不建第二套 Verdict 系统）；
 * 仅供 `scripts/m1510-label-tools.mjs` CLI 与单元测试消费。
 *
 * 语义边界（任务书 §7 测试要求逐条落地）：
 *  - 标签导入校验（V1-V7：枚举/必填/唯一/包归属/跨包独立/COI 剔除/证据启发）；
 *  - 重复 family / 泄漏拒绝（V9：manifest 族与 M15.9 benchmark DOI 交叉核对，
 *    benchmark 族强制 DEV_ANALYSIS_ONLY、不得计入 held-out 指标）；
 *  - 不完整标签不触发盲测（V8：每刊 ≥10 个 held-out 族 × 每族 ≥2 名独立评审，
 *    未达标 → blindTestTriggered=false，Phase D 禁止启动）；
 *  - 正确 abstention（V7：UNDECIDABLE / INSUFFICIENT_EVIDENCE 合法并计分母）；
 *  - 确定性复现（V10：同输入 → 逐字节相同报告/冻结产物；报告不含时间戳）。
 */

import { createHash } from "node:crypto";

export const EXPERT_LABEL_SCHEMA_VERSION = "m1510-expert-labels/v1";

export const DIMENSIONS = [
  "novelty",
  "contribution",
  "technical_soundness",
  "experimental_adequacy",
  "relevance",
  "clarity",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_TIERS = ["STRONG", "ADEQUATE", "WEAK", "INSUFFICIENT_EVIDENCE"] as const;
export type DimensionTier = (typeof DIMENSION_TIERS)[number];

export const OVERALL_TIERS = ["REACHES_VENUE_LEVEL", "NEAR_WITH_GAPS", "CLEARLY_BELOW", "UNDECIDABLE"] as const;
export type OverallTier = (typeof OVERALL_TIERS)[number];

export const VENUES = ["cjig", "cea"] as const;
export type Venue = (typeof VENUES)[number];

export const DOC_TYPES = ["survey", "research", "other"] as const;
export const CONFIDENCE_TIERS = ["HIGH", "MEDIUM", "LOW"] as const;

export const CSV_COLUMNS = [
  "reviewer_id",
  "packet_id",
  "sample_id",
  "venue",
  "document_type_read",
  ...DIMENSIONS.flatMap((d) => [d, `${d}_evidence`]),
  "overall",
  "overall_rationale",
  "confidence",
  "missing_info",
  "coi_disclosure",
  "notes",
  "review_date",
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

export interface ManifestSample {
  sampleId: string;
  familyKey: string;
}
export interface ManifestFamily {
  doi: string | null;
  source: string;
  /** DEV_ONLY（如 MOT 族）或 DEV_ANALYSIS_ONLY（如 benchmark 族）：不计入 held-out 指标 */
  devOnly?: boolean;
  devReason?: string;
}
export interface SampleManifest {
  schemaVersion: number;
  /** packets[prefix] = 该包内全部样本（sampleId 以 `<prefix>-` 开头） */
  packets: Record<string, { samples: ManifestSample[] }>;
  families: Record<string, ManifestFamily>;
  /** M15.9 benchmark 24 DOI（小写）——泄漏核对的事实源 */
  benchmarkDois: string[];
  /** 协调人确认评审员签署独立性/授权声明的时间（LABEL_RIGHTS_VERIFIED 的输入） */
  rightsVerifiedAt?: string;
}

export type RawRow = {
  /** 行号（1-based，指向 CSV 文件中的真实行） */
  __line?: number;
  // eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
  [column: string]: string | number | undefined;
};

export interface Finding {
  rule: string;
  severity: "REJECT" | "WARNING" | "INFO";
  line?: number;
  column?: string;
  message: string;
}

export interface RowResolution {
  line: number;
  reviewerId: string;
  packetId: string;
  sampleId: string;
  familyKey: string;
  venue: Venue;
  status: "OK" | "EXCLUDED_COI";
  heldoutEligible: boolean;
}

export interface ValidationReport {
  ok: boolean;
  findings: Finding[];
  stats: {
    rowsTotal: number;
    rowsRejected: number;
    rowsExcludedCoi: number;
    rowsOk: number;
    reviewers: string[];
    perVenueFamiliesWithTwoReviewers: Record<Venue, number>;
    heldoutFamiliesPerVenue: Record<Venue, number>;
  };
  blindTestTriggered: boolean;
  blockers: string[];
}

// ---------------------------------------------------------------------------
// CSV 解析（RFC4180 子集：引号包裹字段可含逗号/换行；CRLF/LF 归一）
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") {
      if (src[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

export function parseLabelsCsv(text: string): { rows: RawRow[]; findings: Finding[] } {
  const table = parseCsv(text);
  const findings: Finding[] = [];
  if (table.length === 0) {
    return { rows: [], findings: [{ rule: "V0", severity: "REJECT", message: "CSV 为空" }] };
  }
  const header = (table[0] ?? []).map((h) => h.trim());
  const expected = [...CSV_COLUMNS];
  if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
    return {
      rows: [],
      findings: [
        {
          rule: "V0",
          severity: "REJECT",
          message: `表头不符：期望 ${expected.length} 列 [${expected.join(",")}]，实际 [${header.join(",")}]`,
        },
      ],
    };
  }
  const rows: RawRow[] = [];
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i] ?? [];
    const row: RawRow = { __line: i + 1 }; // 1-based，指向数据在 CSV 文件中的真实行号
    for (let c = 0; c < expected.length; c += 1) {
      row[expected[c] ?? ""] = (cells[c] ?? "").trim();
    }
    rows.push(row);
  }
  return { rows, findings };
}

/** 行读取 helper：RawRow/FrozenLabelRow 值域归一为 string（数字/布尔字段转字符串）。 */
const cell = (row: { [column: string]: unknown }, column: string): string => {
  const value = row[column];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
};

// ---------------------------------------------------------------------------
// 校验（V1–V10）
// ---------------------------------------------------------------------------

const enumMember = <T extends readonly string[]>(list: T, value: string) =>
  (list as readonly string[]).includes(value);

/** V6 证据启发：定位特征（页码数字 / § / 表 / 图 / 页 / sec / fig / table / p\d） */
const EVIDENCE_LOCATOR = /(\d|§|表\s*\d|图\s*\d|页|fig|table|sec|abstract|摘要|引言|结论|参考文献)/i;

export function validateManifest(manifest: SampleManifest): Finding[] {
  const findings: Finding[] = [];
  if (manifest.schemaVersion !== 1) {
    findings.push({ rule: "M1", severity: "REJECT", message: `manifest schemaVersion 必须为 1（实际 ${manifest.schemaVersion}）` });
  }
  const benchmark = new Set((manifest.benchmarkDois ?? []).map((d) => d.toLowerCase()));
  for (const [familyKey, family] of Object.entries(manifest.families ?? {})) {
    if (family.doi && benchmark.has(family.doi.toLowerCase()) && !family.devOnly) {
      findings.push({
        rule: "V9",
        severity: "REJECT",
        message: `族 ${familyKey} 的 DOI 命中 M15.9 benchmark 集但未标 devOnly——泄漏冒充 held-out，manifest 拒绝`,
      });
    }
  }
  for (const [prefix, packet] of Object.entries(manifest.packets ?? {})) {
    for (const sample of packet.samples ?? []) {
      if (!sample.sampleId.startsWith(`${prefix}-`)) {
        findings.push({
          rule: "M2",
          severity: "REJECT",
          message: `样本 ${sample.sampleId} 不在包前缀 ${prefix}- 命名空间内`,
        });
      }
      if (!manifest.families?.[sample.familyKey]) {
        findings.push({ rule: "M3", severity: "REJECT", message: `样本 ${sample.sampleId} 引用不存在的族 ${sample.familyKey}` });
      }
    }
  }
  return findings;
}

export function validateLabels(rows: RawRow[], manifest: SampleManifest): ValidationReport {
  const findings: Finding[] = [...validateManifest(manifest)];
  const sampleIndex = new Map<string, string>(); // `${packetId}|${sampleId}` → familyKey
  for (const [prefix, packet] of Object.entries(manifest.packets ?? {})) {
    for (const sample of packet.samples ?? []) {
      sampleIndex.set(`${prefix}|${sample.sampleId}`, sample.familyKey);
    }
  }
  const familyInfo = (key: string): ManifestFamily | undefined => manifest.families?.[key];

  const seenKeys = new Map<string, number>();
  const reviewerPackets = new Map<string, Set<string>>();
  const resolutions: RowResolution[] = [];
  let rejected = 0;
  let excludedCoi = 0;
  let okRows = 0;
  const reviewers = new Set<string>();

  for (const row of rows) {
    const line = row.__line ?? 0;
    let rowRejected = false;
    const reject = (rule: string, column: string, message: string) => {
      findings.push({ rule, severity: "REJECT", line, column, message });
      rowRejected = true;
    };

    // V1：必填 + 枚举
    const required: Array<[CsvColumn, readonly string[] | null]> = [
      ["reviewer_id", null],
      ["packet_id", null],
      ["sample_id", null],
      ["venue", VENUES],
      ["document_type_read", DOC_TYPES],
      ["overall", OVERALL_TIERS],
      ["overall_rationale", null],
      ["confidence", CONFIDENCE_TIERS],
      ["coi_disclosure", null],
      ["review_date", null],
      ...DIMENSIONS.flatMap((d): Array<[CsvColumn, readonly string[] | null]> => [
        [d, DIMENSION_TIERS],
        [`${d}_evidence`, null],
      ]),
    ];
    for (const [column, enums] of required) {
      const value = cell(row, column);
      if (value === "") {
        reject("V1", column, `必填列为空：${column}`);
      } else if (enums && !enumMember(enums, value)) {
        reject("V1", column, `${column} 枚举非法：${value}（合法：${enums.join("/")})`);
      }
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(cell(row, "review_date")) === false) {
      reject("V1", "review_date", `review_date 须为 YYYY-MM-DD（实际 ${cell(row, "review_date")}）`);
    }

    // V3：包归属
    const packetId = cell(row, "packet_id");
    const sampleId = cell(row, "sample_id");
    const familyKey = sampleIndex.get(`${packetId}|${sampleId}`);
    if (!familyKey) {
      reject("V3", "sample_id", `sample_id ${sampleId} 不存在于包 ${packetId || "(空)"} 的 manifest`);
    }

    // V2：唯一键
    const key = `${cell(row, "reviewer_id")}|${packetId}|${sampleId}|${cell(row, "venue")}`;
    const prev = seenKeys.get(key);
    if (prev !== undefined) {
      reject("V2", "sample_id", `重复评分行（与第 ${prev} 行同键 reviewer|packet|sample|venue）`);
    } else {
      seenKeys.set(key, line);
    }

    if (rowRejected) {
      rejected += 1;
      continue;
    }

    // V4：跨包独立（同一评审员出现在两个包前缀 → 全量拒绝）
    const pk = reviewerPackets.get(cell(row, "reviewer_id")) ?? new Set<string>();
    pk.add(packetId);
    reviewerPackets.set(cell(row, "reviewer_id"), pk);

    // V5：COI
    const coi = cell(row, "coi_disclosure").trim();
    const coiHit = coi !== "" && coi.toUpperCase() !== "NONE";

    // V6：证据启发（WARNING 不阻断）
    for (const d of DIMENSIONS) {
      const evidence = cell(row, `${d}_evidence`);
      if (evidence !== "" && !EVIDENCE_LOCATOR.test(evidence)) {
        findings.push({
          rule: "V6",
          severity: "WARNING",
          line,
          column: `${d}_evidence`,
          message: `证据缺定位特征（页码/§/表/图）：${evidence.slice(0, 40)}`,
        });
      }
    }

    const family = familyInfo(familyKey ?? "") as ManifestFamily | undefined;
    const heldoutEligible = family ? family.devOnly !== true : false;
    if (coiHit) excludedCoi += 1;
    else okRows += 1;
    reviewers.add(cell(row, "reviewer_id"));
    resolutions.push({
      line,
      reviewerId: cell(row, "reviewer_id"),
      packetId,
      sampleId,
      familyKey: familyKey as string,
      venue: cell(row, "venue") as Venue,
      status: coiHit ? "EXCLUDED_COI" : "OK",
      heldoutEligible,
    });
  }

  // V4 汇总判定（延迟到全表扫描后：前缀集合完整）
  for (const [reviewer, prefixes] of reviewerPackets) {
    if (prefixes.size > 1) {
      findings.push({
        rule: "V4",
        severity: "REJECT",
        message: `评审员 ${reviewer} 同时出现在多个包（${[...prefixes].join(",")}）——违反双包独立设计，其全部行拒绝`,
      });
      for (const r of resolutions) if (r.reviewerId === reviewer) r.status = "EXCLUDED_COI";
    }
  }
  const v4Rejected = findings.some((f) => f.rule === "V4");
  if (v4Rejected) {
    // V4 触发时相应行从 OK 移入拒绝口径
    okRows = resolutions.filter((r) => r.status === "OK").length;
    excludedCoi = resolutions.filter((r) => r.status === "EXCLUDED_COI").length;
  }

  // V8：盲测前置门（每刊 ≥10 held-out 族 × 每族 ≥2 独立评审；COI 行不计）
  const perVenue: Record<Venue, number> = { cjig: 0, cea: 0 };
  const heldoutFamilies: Record<Venue, number> = { cjig: 0, cea: 0 };
  for (const venue of VENUES) {
    const familyReviewers = new Map<string, Set<string>>();
    for (const r of resolutions) {
      if (r.venue !== venue || r.status !== "OK" || !r.heldoutEligible) continue;
      const set = familyReviewers.get(r.familyKey) ?? new Set<string>();
      set.add(r.reviewerId);
      familyReviewers.set(r.familyKey, set);
    }
    heldoutFamilies[venue] = familyReviewers.size;
    perVenue[venue] = [...familyReviewers.values()].filter((s) => s.size >= 2).length;
  }
  const blockers: string[] = [];
  const minFamilies = 10;
  if (perVenue.cjig < minFamilies) blockers.push(`cjig 双评审 held-out 族 ${perVenue.cjig}/${minFamilies}`);
  if (perVenue.cea < minFamilies) blockers.push(`cea 双评审 held-out 族 ${perVenue.cea}/${minFamilies}`);
  if (!manifest.rightsVerifiedAt) blockers.push("LABEL_RIGHTS_VERIFIED=false（manifest.rightsVerifiedAt 未登记）");
  if (findings.some((f) => f.severity === "REJECT")) blockers.push("存在 REJECT 行/manifest 问题（见 findings）");

  return {
    ok: !findings.some((f) => f.severity === "REJECT"),
    findings,
    stats: {
      rowsTotal: rows.length,
      rowsRejected: rejected,
      rowsExcludedCoi: excludedCoi,
      rowsOk: okRows,
      reviewers: [...reviewers].sort(),
      perVenueFamiliesWithTwoReviewers: perVenue,
      heldoutFamiliesPerVenue: heldoutFamilies,
    },
    blindTestTriggered: blockers.length === 0,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// 冻结（freeze）
// ---------------------------------------------------------------------------

export interface FrozenLabelRow {
  [column: string]: string | number | boolean | undefined;
  __line?: number;
  __familyKey: string;
  __heldoutEligible: boolean;
  __status: "OK" | "EXCLUDED_COI";
  __rowSha256: string;
}

export interface FrozenLabels {
  schemaVersion: string;
  rubricVersion: string;
  frozenAt: string;
  sourceRows: number;
  rows: FrozenLabelRow[];
  perFamilyVenue: Record<string, { venue: Venue; familyKey: string; heldoutEligible: boolean; reviewers: string[]; complete: boolean }>;
  blindTestTriggered: boolean;
  totalSha256: string;
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
};

export const sha256Of = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

export function freezeLabels(
  rows: RawRow[],
  manifest: SampleManifest,
  options: { frozenAt: string },
): { error?: string; frozen?: FrozenLabels } {
  const report = validateLabels(rows, manifest);
  if (!report.ok) {
    return { error: `存在 ${report.findings.filter((f) => f.severity === "REJECT").length} 条 REJECT——禁止冻结（先修复导入问题）` };
  }
  const sampleIndex = new Map<string, string>();
  for (const [prefix, packet] of Object.entries(manifest.packets ?? {})) {
    for (const sample of packet.samples ?? []) sampleIndex.set(`${prefix}|${sample.sampleId}`, sample.familyKey);
  }
  const frozenRows: FrozenLabelRow[] = rows.map((row) => {
    const familyKey = sampleIndex.get(`${cell(row, "packet_id")}|${cell(row, "sample_id")}`) as string;
    const family = manifest.families?.[familyKey];
    const coi = cell(row, "coi_disclosure").trim();
    const status = coi !== "" && coi.toUpperCase() !== "NONE" ? "EXCLUDED_COI" : "OK";
    const enriched: FrozenLabelRow = Object.assign(Object.create(null), row, {
      __familyKey: familyKey,
      __heldoutEligible: family ? family.devOnly !== true : false,
      __status: status,
    }) as FrozenLabelRow;
    enriched.__rowSha256 = sha256Of(enriched);
    return enriched;
  });
  const perFamilyVenue: FrozenLabels["perFamilyVenue"] = {};
  for (const r of frozenRows) {
    if (r.__status !== "OK") continue;
    const key = `${r.__familyKey}|${r.venue}`;
    const entry = perFamilyVenue[key] ?? {
      venue: r.venue as Venue,
      familyKey: r.__familyKey,
      heldoutEligible: r.__heldoutEligible,
      reviewers: [],
      complete: false,
    };
    const reviewerId = cell(r, "reviewer_id");
    if (!entry.reviewers.includes(reviewerId)) entry.reviewers.push(reviewerId);
    entry.complete = entry.reviewers.length >= 2;
    perFamilyVenue[key] = entry;
  }
  const frozen: FrozenLabels = {
    schemaVersion: EXPERT_LABEL_SCHEMA_VERSION,
    rubricVersion: "m1510-rubric-v1",
    frozenAt: options.frozenAt,
    sourceRows: rows.length,
    rows: frozenRows,
    perFamilyVenue,
    blindTestTriggered: report.blindTestTriggered,
    totalSha256: "",
  };
  frozen.totalSha256 = sha256Of({ rows: frozenRows, perFamilyVenue, blindTestTriggered: frozen.blindTestTriggered });
  return { frozen };
}
