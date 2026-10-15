/**
 * M14.3 — InheritedTableAsset：研究成果表格的受控继承（ResearchInput →
 * ParsedTable → Verified Cells → Asset Candidate → Authorization → Thesis
 * Table → Guard）。
 *
 * 纪律（任务 §8）：
 *   - 候选只来自已入选输入的解析表格，且数值单元格有 sourceCheck=verified 的
 *     table_cell 事实背书（未核验 / 未裁决冲突的事实不进继承资产）；
 *   - 授权只能经作者决定（table_inheritance 决定类型；actor 可审计）；
 *   - 渲染确定性：插入与复核用同一 renderer，数据语义不变只允许排版差异；
 *   - 插入后的表格块带守卫标记，数值 / 行列 / 结构漂移在 gate 与 build 复核
 *     中确定性检出（inherited_tables_intact）。
 *
 * 落盘：research/inherited-table-assets.json（原子写）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import { sha256Hex } from "../util/hash.js";
import type { ExtractedTable } from "./factExtraction.js";
import type { ResearchInput, ScientificFact } from "./researchInputTypes.js";

export const INHERITED_TABLE_ASSETS_VERSION = "m14.3-v1";

export type InheritedTableStatus = "candidate" | "authorized" | "inserted" | "rejected";

export interface InheritedTableAsset {
  schemaVersion: 1;
  /** 确定性：ita- + sha256(projectId|inputId|contentHash|blockId|dataHash)[0:12] */
  assetId: string;
  projectId: string;
  status: InheritedTableStatus;
  source: {
    researchInputId: string;
    inputTitle?: string;
    contentHash: string;
    sourceId: string;
    blockId: string;
    page?: number;
    label?: string;
    labelBasis: ExtractedTable["labelBasis"];
    caption?: string;
    provenanceUri?: string;
  };
  structure: {
    headerRow: string[];
    rows: string[][];
    labelColumnCount: number;
  };
  /** 学位论文题注（授权时可改写；缺省 = 来源题注） */
  captionZh: string;
  /** 归一化单元格数据的 sha256（数值 / 行列变更即失配） */
  dataHash: string;
  /** 数值单元格的已核验事实 id（追溯链） */
  cellFactIds: string[];
  verification: {
    /** 候选构建时数值单元格核验统计 */
    numericCells: number;
    verifiedCells: number;
    conflictingCells: number;
  };
  authorization?: { decisionId: string; actorKind: "user" | "test_fixture"; authorizedAt: string };
  insertion?: { sectionFile: string; chapterId: string; insertedAt: string; latexHash: string };
  createdAt: string;
  updatedAt: string;
}

export interface InheritedTableAssetFile {
  schemaVersion: 1;
  projectId: string;
  assets: InheritedTableAsset[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function inheritedTableAssetsPath(projects: ProjectStore, projectId: string): string {
  return join(projects.researchDir(projectId), "inherited-table-assets.json");
}

export class InheritedTableAssetStore {
  constructor(private readonly projects: ProjectStore) {}

  async load(projectId: string): Promise<InheritedTableAssetFile | null> {
    const path = inheritedTableAssetsPath(this.projects, projectId);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as InheritedTableAssetFile;
      if (parsed.projectId !== projectId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async save(projectId: string, file: InheritedTableAssetFile): Promise<void> {
    const path = inheritedTableAssetsPath(this.projects, projectId);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(file, null, 2), "utf8");
    await rename(temp, path);
  }

  async get(projectId: string, assetId: string): Promise<InheritedTableAsset | null> {
    const file = await this.load(projectId);
    return file?.assets.find((asset) => asset.assetId === assetId) ?? null;
  }

  /** upsert（by assetId）+ 原子写 */
  async upsert(projectId: string, assets: InheritedTableAsset[], now: string): Promise<InheritedTableAssetFile> {
    const file = (await this.load(projectId)) ?? { schemaVersion: 1, projectId, assets: [], updatedAt: now };
    const byId = new Map(file.assets.map((asset) => [asset.assetId, asset]));
    for (const asset of assets) {
      const existing = byId.get(asset.assetId);
      if (existing === undefined) {
        byId.set(asset.assetId, asset);
        continue;
      }
      // 已授权 / 已插入的资产不被候选重建降级（作者决定优先；内容版本变化产生新 assetId）
      if (existing.status === "candidate" && asset.status === "candidate") {
        byId.set(asset.assetId, { ...asset, createdAt: existing.createdAt });
      }
    }
    const merged: InheritedTableAssetFile = { ...file, assets: [...byId.values()], updatedAt: now };
    await this.save(projectId, merged);
    return merged;
  }
}

// ---------------------------------------------------------------------------
// 候选构建（确定性）
// ---------------------------------------------------------------------------

/**
 * 从一个输入的解析表格构建继承候选。入选条件：
 *   - 非噪声表格、≥2 数据行、≥1 数值列；
 *   - 数值单元格中 ≥50% 有 sourceCheck=verified 的 table_cell 事实；
 *   - 无未裁决冲突事实参与（conflicting 计数如实记录，>0 时该单元格不背书）。
 */
export function buildInheritedTableCandidates(input: {
  projectId: string;
  researchInput: ResearchInput;
  tables: ExtractedTable[];
  facts: ScientificFact[];
  now: string;
}): InheritedTableAsset[] {
  const { projectId, researchInput, tables, facts, now } = input;
  // (blockId | rowIndex | columnIndex) → fact
  const factByCell = new Map<string, ScientificFact>();
  for (const fact of facts) {
    if (fact.kind !== "table_cell" || fact.researchInputId !== researchInput.inputId) continue;
    if (fact.provenance.contentHash !== researchInput.version.contentHash) continue;
    const table = fact.provenance.table;
    if (table === undefined || fact.provenance.blockId === undefined) continue;
    factByCell.set(`${fact.provenance.blockId}|${table.rowIndex}|${table.columnIndex}`, fact);
  }
  const assets: InheritedTableAsset[] = [];
  for (const table of tables) {
    if (table.noise?.likely === true) continue;
    if (table.rows.length < 2) continue;
    let numericCells = 0;
    let verifiedCells = 0;
    let conflictingCells = 0;
    const cellFactIds: string[] = [];
    for (const row of table.rows) {
      for (let column = table.labelColumnCount; column < table.headers.length; column += 1) {
        const fact = factByCell.get(`${table.blockId}|${row.rowIndex}|${column}`);
        if (fact === undefined) continue;
        numericCells += 1;
        if (fact.conflict.status === "unresolved") {
          conflictingCells += 1;
          continue;
        }
        if (fact.verification.sourceCheck === "verified") {
          verifiedCells += 1;
          cellFactIds.push(fact.factId);
        }
      }
    }
    if (numericCells === 0 || verifiedCells < numericCells * 0.5) continue;
    const headerRow = table.headers;
    const rows = table.rows.map((row) => row.cells);
    const dataHash = computeTableDataHash(headerRow, rows);
    const assetId = `ita-${sha256Hex(`${projectId}|${researchInput.inputId}|${researchInput.version.contentHash}|${table.blockId}|${dataHash}`).slice(0, 12)}`;
    assets.push({
      schemaVersion: 1,
      assetId,
      projectId,
      status: "candidate",
      source: {
        researchInputId: researchInput.inputId,
        ...(researchInput.title !== "" ? { inputTitle: researchInput.title } : {}),
        contentHash: researchInput.version.contentHash,
        sourceId: researchInput.version.sourceId,
        blockId: table.blockId,
        ...(table.page !== undefined ? { page: table.page } : {}),
        ...(table.label !== undefined ? { label: table.label } : {}),
        labelBasis: table.labelBasis,
        ...(table.caption !== undefined ? { caption: table.caption } : {}),
        ...(researchInput.provenanceUri !== undefined ? { provenanceUri: researchInput.provenanceUri } : {}),
      },
      structure: { headerRow, rows, labelColumnCount: table.labelColumnCount },
      captionZh: defaultThesisCaption(table, researchInput),
      dataHash,
      cellFactIds,
      verification: { numericCells, verifiedCells, conflictingCells },
      createdAt: now,
      updatedAt: now,
    });
  }
  return assets;
}

function defaultThesisCaption(table: ExtractedTable, input: ResearchInput): string {
  const base = table.caption !== undefined && table.caption.trim() !== "" ? table.caption.trim() : `研究成果表格（${table.label ?? table.blockId}）`;
  return `${base}（继承自 ${input.title}，数据未改动）`;
}

export function computeTableDataHash(headerRow: string[], rows: string[][]): string {
  return sha256Hex(
    JSON.stringify([headerRow.map((cell) => cell.trim()), rows.map((row) => row.map((cell) => cell.trim()))]),
  );
}

// ---------------------------------------------------------------------------
// LaTeX 渲染（确定性；插入与复核共用）
// ---------------------------------------------------------------------------

const LATEX_TEXT_ESCAPES: Array<[RegExp, string]> = [
  [/&/g, "\\&"],
  [/%/g, "\\%"],
  [/\$/g, "\\$"],
  [/#/g, "\\#"],
  [/_/g, "\\_"],
  [/\{/g, "\\{"],
  [/\}/g, "\\}"],
  [/~/g, "\\textasciitilde{}"],
  [/\^/g, "\\textasciicircum{}"],
];

/** 反斜杠占位（转义顺序解耦：textbackslash 的花括号不被二次转义） */
const BACKSLASH_SENTINEL = "\u0000";

export function escapeLatexText(value: string): string {
  let out = value.replace(/\\/g, BACKSLASH_SENTINEL);
  for (const [pattern, replacement] of LATEX_TEXT_ESCAPES) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\u0000/g, "\\textbackslash{}");
}

const LATEX_TEXT_UNESCAPES: Array<[RegExp, string]> = [
  [/\\textasciitilde\{\}/g, "~"],
  [/\\textasciicircum\{\}/g, "^"],
  [/\\&/g, "&"],
  [/\\%/g, "%"],
  [/\\\$/g, "$"],
  [/\\#/g, "#"],
  [/\\_/g, "_"],
  [/\\\{/g, "{"],
  [/\\\}/g, "}"],
];

export function unescapeLatexText(value: string): string {
  let out = value.replace(/\\textbackslash\{\}/g, BACKSLASH_SENTINEL);
  for (const [pattern, replacement] of LATEX_TEXT_UNESCAPES) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\u0000/g, "\\");
}

export function inheritedTableLabel(assetId: string): string {
  return `tab:${assetId}`;
}

/** 数值列右对齐、标签列左对齐（确定性） */
function columnSpec(asset: InheritedTableAsset): string {
  return asset.structure.headerRow
    .map((_, column) => (column < asset.structure.labelColumnCount ? "l" : "r"))
    .join("");
}

export function inheritedTableGuardBegin(assetId: string): string {
  return `% inherited-table:${assetId} begin（系统继承表格：数据受守卫保护，禁止修改数值/行列；排版变更须经作者决定）`;
}

export function inheritedTableGuardEnd(assetId: string): string {
  return `% inherited-table:${assetId} end`;
}

export function renderInheritedTableLatex(asset: InheritedTableAsset): string {
  const header = asset.structure.headerRow.map((cell) => escapeLatexText(cell.trim()));
  const rows = asset.structure.rows.map((row) => row.map((cell) => escapeLatexText(cell.trim())));
  const lines: string[] = [
    inheritedTableGuardBegin(asset.assetId),
    "\\begin{table}[htbp]",
    "\\centering",
    `\\caption{${escapeLatexText(asset.captionZh)}}`,
    `\\label{${inheritedTableLabel(asset.assetId)}}`,
    `\\begin{tabular}{${columnSpec(asset)}}`,
    "\\hline",
    `${header.join(" & ")} \\\\`,
    "\\hline",
    ...rows.map((row) => `${row.join(" & ")} \\\\`),
    "\\hline",
    "\\end{tabular}",
    "\\end{table}",
    inheritedTableGuardEnd(asset.assetId),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 守卫复核（gate / build 复核共用）
// ---------------------------------------------------------------------------

export interface InheritedTableVerification {
  assetId: string;
  ok: boolean;
  violations: string[];
}

/** 从 LaTeX 文本提取守卫块（assetId → 块内容；标记缺失的资产不在结果中） */
export function extractGuardedTableBlocks(latex: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const pattern = /^[ \t]*% inherited-table:(ita-[0-9a-f]{12}) begin[^\n]*\n([\s\S]*?)^[ \t]*% inherited-table:\1 end/gm;
  for (const match of latex.matchAll(pattern)) {
    blocks.set(match[1]!, match[2]!);
  }
  return blocks;
}

/**
 * 单资产守卫复核：解析当前文件中的守卫块，数值单元格与结构必须与资产一致。
 * 允许的合法差异：题注文本改写、列宽 / 对齐 / 表格样式命令差异（非数据 token）。
 */
export function verifyInheritedTableBlock(asset: InheritedTableAsset, block: string | undefined): InheritedTableVerification {
  const violations: string[] = [];
  if (block === undefined) {
    return { assetId: asset.assetId, ok: false, violations: ["guard_block_missing（守卫标记块缺失或被删除）"] };
  }
  if (!block.includes(`\\label{${inheritedTableLabel(asset.assetId)}}`)) {
    violations.push(`label_missing（\\label{${inheritedTableLabel(asset.assetId)}} 不在守卫块内）`);
  }
  if (!/\\caption\{/.test(block)) {
    violations.push("caption_missing（守卫块内无 \\caption）");
  }
  const tabular = /\\begin\{tabular\}(\{[^}]*\})?\n([\s\S]*?)\\end\{tabular\}/.exec(block);
  if (tabular === null) {
    violations.push("tabular_missing（守卫块内无 tabular 环境）");
    return { assetId: asset.assetId, ok: false, violations };
  }
  const body = tabular[2] ?? "";
  // 注意：不做行级 trim——首列为空的表头行以 " & " 开头，trim 会吃掉前导分隔符
  // 造成列数误判（真实案例：S-measure Table 1 首列空 → 13 列被数成 12）。
  const rows = body
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "" && !/^\s*(\\hline|\\toprule|\\midrule|\\bottomrule)/.test(line))
    .map((line) =>
      line
        .replace(/\\\\$/, "")
        .split(" & ")
        .map((cell) => unescapeLatexText(cell.trim()).replace(/\s+/g, " ").trim()),
    );
  const expected = [asset.structure.headerRow, ...asset.structure.rows].map((row) =>
    row.map((cell) => cell.replace(/\s+/g, " ").trim()),
  );
  if (rows.length !== expected.length) {
    violations.push(`row_count_drift（守卫块 ${rows.length} 行 ≠ 资产 ${expected.length} 行——行列不得静默增删）`);
  }
  const width = Math.max(...expected.map((row) => row.length));
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, expected.length); rowIndex += 1) {
    const actualRow = rows[rowIndex]!;
    const expectedRow = expected[rowIndex]!;
    if (actualRow.length !== expectedRow.length) {
      violations.push(`column_count_drift@row${rowIndex}（${actualRow.length} 列 ≠ ${expectedRow.length} 列）`);
      continue;
    }
    for (let column = 0; column < expectedRow.length && column < width; column += 1) {
      const actual = actualRow[column] ?? "";
      const want = expectedRow[column] ?? "";
      if (actual !== want) {
        violations.push(`cell_drift@row${rowIndex},col${column}（"${want}" → "${actual}"）`);
      }
    }
  }
  return { assetId: asset.assetId, ok: violations.length === 0, violations };
}

/** 多资产批量复核（gate 输入装配用） */
export function verifyInheritedTables(assets: InheritedTableAsset[], sectionFiles: ReadonlyArray<{ file: string; latex: string }>): {
  checked: number;
  intact: number;
  findings: InheritedTableVerification[];
} {
  const byAsset = new Map<string, { file: string; block: string }>();
  for (const { file, latex } of sectionFiles) {
    for (const [assetId, block] of extractGuardedTableBlocks(latex)) {
      byAsset.set(assetId, { file, block });
    }
  }
  const findings = assets.map((asset) => {
    const located = byAsset.get(asset.assetId);
    return verifyInheritedTableBlock(asset, located?.block);
  });
  return {
    checked: assets.length,
    intact: findings.filter((finding) => finding.ok).length,
    findings,
  };
}
