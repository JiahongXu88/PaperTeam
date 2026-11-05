import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { BusinessError, NotFoundError } from "../errors.js";
import { assetKindOfFileName } from "../ingestion/parserRegistry.js";
import type { IngestionService } from "../ingestion/IngestionService.js";
import type { ParsedDocumentStore } from "../ingestion/ParsedDocumentStore.js";
import type { ParsedDocument, ParsedRecordBlock, ParsedTableBlock } from "../ingestion/types.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { SourceStore } from "../sources/SourceStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { sha256Hex } from "../util/hash.js";
import { hashArchive, sourceNameFor, visitArchive, type ArchiveEntryInfo } from "./archive.js";
import { EXPERIMENT_UNITS, headerUnit, parseMetricCell, toCanonical, type ExperimentUnit, type UnitBasis } from "./metricUnits.js";
import {
  FACT_SNAPSHOT_SCHEMA, buildFactSnapshotContent, factIdOf, formatDerived, snapshotContentHash,
  type FactComparison, type FactSnapshot, type FactSnapshotBuild, type SnapshotInputObservation,
} from "./factSnapshot.js";
import {
  CLAIM_CHECK_PLAN_FILE,
  evaluateClaimCheckPlan,
  validateClaimCheckPlan,
  type ClaimCheckEnvironment,
  type ClaimCheckLedger,
  type ClaimCheckPlan,
} from "./claimChecks.js";
import {
  SEMANTIC_LIMITS,
  UNDERSTANDING_SYSTEM_PROMPT,
  buildUnderstandingContext,
  minimumReasoningLevel,
  parseUnderstandingOutput,
  validateSuggestions,
  type ExperimentModelRuntime,
  type SemanticSuggestions,
} from "./semanticUnderstanding.js";

export type ExperimentRole = "main_result" | "baseline_result" | "ablation_result" | "experiment_config" | "training_log" | "evaluation_log" | "dataset_description" | "figure_asset" | "notebook" | "source_code" | "documentation" | "unknown";
export interface PackageFile {
  path: string;
  hash: string;
  bytes: number;
  compressedBytes: number;
  kind: string;
  parseStatus: "pending" | "ok" | "partial" | "failed" | "unsupported";
  sourceId?: string;
  role: ExperimentRole;
  roleBasis: string;
  roleConfidence: "high" | "candidate";
  groupId: string;
  warning?: string;
  /**
   * M17.2 作者补充的文件级实验 metadata：只**填补**文件内缺失的上下文字段（文件内显式值优先；两者矛盾 → 组冲突，
   * 不覆盖）；units 按指标名（或 "*" = 该文件全部未知单位指标）声明标度。编辑即重建观测，既有确认失效。
   */
  metadata?: FileExperimentMetadata;
}
export interface FileExperimentMetadata {
  method?: string;
  dataset?: string;
  split?: string;
  protocol?: string;
  seed?: string;
  version?: string;
  units?: Record<string, ExperimentUnit>;
  /** 作者备注（如评测器版本 / 阈值）；只展示，不参与计算 */
  note?: string;
}
export const FILE_METADATA_FIELDS = ["method", "dataset", "split", "protocol", "seed", "version"] as const;
export interface MetricObservation {
  sourceId: string;
  path: string;
  blockId: string;
  row?: number;
  sheet?: string;
  column?: string;
  jsonPath?: string;
  method?: string;
  dataset?: string;
  seed?: string;
  protocol?: string;
  split?: string;
  /** M17.2：行级子集（序列 / 片段，如 TrackEval 的 seq 列；COMBINED = 评测器汇总行） */
  subset?: string;
  version?: string;
  metric: string;
  value: number;
  unit: ExperimentUnit;
  direction: "higher" | "lower" | "unknown";
  groupId: string;
  /** M17.2：原始单元格文本（保真：66.9% 与 0.669 的区别在此可查） */
  rawText?: string;
  /** M17.2：单位判定依据（显式证据类型；none = 未知） */
  unitBasis?: UnitBasis;
  /** M17.2：由作者文件 metadata 填补的上下文字段名 */
  authorFilled?: string[];
}
export interface ExperimentGroup {
  id: string;
  role: "main" | "baseline" | "ablation" | "other";
  filePaths: string[];
  basis: string;
  status: "candidate" | "confirmed" | "conflict";
  conflicts: string[];
  confirmedAt?: string;
  /**
   * 观测级实验范围划分（M13.5，schema v2）：同组观测按 split 值细分为
   * 可独立确认的范围。同一结果文件含多个 split（如 Dev25 / Confirmation13 /
   * Full38）不再整组判 conflict——按范围分别管理与确认。无观测的组
   * （documentation 等）没有该字段。
   */
  splitScopes?: ExperimentSplitScope[];
}
/**
 * 实验范围（split scope）。语义边界（M13.5）：
 * - status=confirmed 表示「作者确认该范围的观测记录真实、归属正确」；
 * - workflowUse 表示「允许进入当前论文工作流上下文」——与确认是两个独立
 *   决策：多范围组的 confirmation/held-out 范围即便确认真实，也必须经作者
 *   显式授权才进入 Researcher 上下文（科研隔离边界）；
 * - conflicts 只承载真正的协议矛盾（同一范围内 protocol 互相矛盾）与
 *   来源失效；「不同 split 共存」本身不是冲突。
 */
export interface ExperimentSplitScope {
  /** 稳定标识 `${groupId}@${slug}`；groupId 合法字符集不含 @、slug 不含 @ */
  id: string;
  /** split 原值；未声明 split 的观测归入 "unknown"（不自动补全、不推断） */
  split: string;
  status: "candidate" | "confirmed" | "conflict";
  conflicts: string[];
  confirmedAt?: string;
  /** allowed = 允许进入当前工作流上下文；excluded = 明确排除；undecided = 未决（多范围组确认后的缺省） */
  workflowUse: "allowed" | "excluded" | "undecided";
  workflowUseDecidedAt?: string;
  observationCount: number;
  metricCount: number;
  filePaths: string[];
  /** 该范围内出现的 protocol 值（展示用；跨范围差异不算冲突） */
  protocols: string[];
}
export interface ExperimentRelationCandidate {
  configPath: string;
  groupId: string;
  status: "candidate" | "conflict";
  basis: string;
  matchedFields: string[];
  conflictingFields: string[];
}
/** 源材料报告的判定（M13.3：从 verdict/decision 类字符串字段原样提取；
 * 系统不重算、不解读，仅保留原始表述与锚点） */
export interface ReportedVerdict {
  path: string;
  field: string;
  value: string;
}
export interface ExperimentPackage {
  /** v1 = 文件级分组（无 splitScopes）；v2 = rebuild 后带观测级实验范围 */
  schemaVersion: 1 | 2;
  packageId: string;
  packageHash: string;
  originalName: string;
  importedAt: string;
  status: "inventory" | "importing" | "ready" | "partial";
  files: PackageFile[];
  groups: ExperimentGroup[];
  observations: MetricObservation[];
  relationCandidates: ExperimentRelationCandidate[];
  reportedVerdicts?: ReportedVerdict[];
  /** GLM 辅助理解（M13.3）：候选建议 + 模型归因；全部 needs_author_confirmation */
  semanticSuggestions?: SemanticSuggestions;
  warnings: string[];
}

/** M17.2：写作上下文中的确定性对比（来自冻结快照；数值由 PaperTeam 复算，模型只能引用） */
export interface WorkflowComparison {
  comparisonId: string;
  dataset: string;
  split: string;
  protocol: string;
  subset: string;
  metric: string;
  kind: FactComparison["kind"];
  /** 规范标度（比例统一为百分数、时间统一为秒）；canonicalValue 为该标度下的取值（ratio ×100 等确定性换算） */
  canonicalUnit: ExperimentUnit;
  subject: { method: string; role: string; value: number; canonicalValue: number; factId: string };
  reference: { method: string; role: string; value: number; canonicalValue: number; factId: string };
  absoluteDifference: string;
  relativeChange: string | null;
  outcome: FactComparison["outcome"];
  limitations: string[];
}
export interface WorkflowSnapshotRef {
  snapshotId: string;
  version: number;
  contentHash: string;
  createdAt: string;
  status: "valid" | "stale";
  staleReasons?: string[];
  factCount: number;
  comparisonCount: number;
}
export interface ConfirmedExperimentWorkflowContext {
  schemaVersion: 1;
  status: "author_confirmed_not_externally_verified";
  truncated: boolean;
  /** M17.2：存在冻结快照时的快照引用（无快照 = 缺省，行为与 M17.1 一致） */
  snapshot?: WorkflowSnapshotRef;
  /** M17.2：快照中的确定性对比（≤ 60 条）；stale 快照为空 */
  comparisons?: WorkflowComparison[];
  observations: Array<{
    packageId: string;
    packageHash: string;
    groupId: string;
    sourceId: string;
    blockId: string;
    path: string;
    metric: string;
    value: number;
    unit: ExperimentUnit;
    direction: "higher" | "lower" | "unknown";
    row?: number;
    sheet?: string;
    column?: string;
    jsonPath?: string;
    method?: string;
    dataset?: string;
    seed?: string;
    protocol?: string;
    split?: string;
  }>;
}

const RESULT_EXTENSIONS = new Set([".csv", ".xlsx", ".json", ".yaml", ".yml"]);
const SOURCE_EXTENSIONS = new Set([".csv", ".xlsx", ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".md", ".txt", ".ipynb"]);
const SECRET_PATTERN = /(api.?key|secret|password|token|credential|authorization)/i;
const CONTEXT_COLUMNS = /^(method|model|dataset|seed|split|epoch|run|variant|protocol|step|iteration|fold|id|seq|sequence|clip|scene|version)$/i;
/** 单文件观测上限（M17.2：5000 → 20000，TrackEval detailed.csv 单臂即 ~7000 条；超限显式告警，不静默截断） */
const MAX_FILE_OBSERVATIONS = 20_000;
const MAX_WORKFLOW_OBSERVATIONS = 100;
const SAFE_CONTEXT_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._+:/%()\-]{0,95}$/u;
const SECRET_VALUE_PATTERN = /(?:\bsk-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/;

/**
 * 标准多目标跟踪评测指标方向词表（TrackEval / MOT Challenge 通行语义；
 * 按指标名全词匹配填充 direction，未收录指标保持 unknown——不猜方向）。
 */
const METRIC_DIRECTION: ReadonlyMap<string, "higher" | "lower"> = new Map([
  ["HOTA", "higher"], ["HOTA(0)", "higher"], ["DETA", "higher"], ["ASSA", "higher"],
  ["MOTA", "higher"], ["MOTP", "higher"], ["MODA", "higher"], ["SMOTA", "higher"],
  ["IDF1", "higher"], ["IDR", "higher"], ["IDP", "higher"], ["IDTP", "higher"],
  ["DETRE", "higher"], ["DETPR", "higher"], ["ASSRE", "higher"], ["ASSPR", "higher"],
  ["LOCA", "higher"], ["OWTA", "higher"], ["CLR_RE", "higher"], ["CLR_PR", "higher"],
  ["IDSW", "lower"], ["FRAG", "lower"],
]);
/** 源材料判定字段名（JSON 叶子键 / 表列名的全词匹配；只取字符串值） */
const VERDICT_FIELD = /^(?:verdict|final_verdict|overall_verdict|decision|conclusion)$/i;
const MAX_REPORTED_VERDICTS = 8;

function safeContextLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return SAFE_CONTEXT_LABEL.test(normalized) && !SECRET_PATTERN.test(normalized) && !SECRET_VALUE_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

function classify(path: string): Pick<PackageFile, "role" | "roleBasis" | "roleConfidence" | "groupId"> {
  const lower = path.toLowerCase();
  const file = basename(lower);
  const ext = extname(file);
  const tokens = lower.split(/[\/_.\-\s]+/).filter(Boolean);
  let role: ExperimentRole = "unknown";
  let basis = "缺少可判定的文件名或路径线索";
  if (ext === ".ipynb") { role = "notebook"; basis = "Notebook 扩展名"; }
  else if ([".jsonl", ".ndjson"].includes(ext)) { role = "unknown"; basis = "JSONL 行流；按记录流登记（角色待定，不参与指标提取）"; }
  else if ([".png", ".jpg", ".jpeg", ".pdf", ".svg"].includes(ext)) { role = "figure_asset"; basis = "图像扩展名"; }
  else if ([".py", ".sh", ".ps1", ".r", ".ts"].includes(ext)) { role = "source_code"; basis = "源码扩展名；仅登记，不执行"; }
  else if (ext === ".log" || tokens.includes("log")) { role = tokens.includes("eval") || tokens.includes("evaluation") ? "evaluation_log" : "training_log"; basis = "日志路径/扩展名"; }
  else if (tokens.includes("config") || tokens.includes("configuration") || file.startsWith("model.")) { role = "experiment_config"; basis = "配置路径/文件名"; }
  else if (tokens.includes("dataset") || tokens.includes("data") && ext === ".md") { role = "dataset_description"; basis = "数据集说明路径"; }
  else if (RESULT_EXTENSIONS.has(ext) && tokens.some((token) => token.startsWith("baseline"))) { role = "baseline_result"; basis = "baseline 路径/文件名"; }
  else if (RESULT_EXTENSIONS.has(ext) && tokens.some((token) => token.startsWith("ablation") || token === "no")) { role = "ablation_result"; basis = "ablation 路径/文件名"; }
  else if (RESULT_EXTENSIONS.has(ext) && tokens.some((token) => ["main", "result", "results", "metrics"].includes(token))) { role = "main_result"; basis = "结果路径/文件名"; }
  else if ([".md", ".txt"].includes(ext)) { role = "documentation"; basis = "文档扩展名"; }
  const baseline = /(?:^|\/)(?:baselines?\/)?(baseline[_-]?[a-z0-9]+)\./.exec(lower);
  const ablation = /(?:^|\/)(?:ablation\/)?(no[_-]?[a-z0-9_-]+|ablation[_-]?[a-z0-9]+)\./.exec(lower);
  const groupToken = tokens.find((token) => token === "main" || token.startsWith("baseline") || token.startsWith("ablation"));
  const groupId = baseline?.[1]?.replaceAll("_", "-") ?? (role === "ablation_result" ? `ablation-${ablation?.[1]?.replaceAll("_", "-") ?? "candidate"}` : groupToken ?? (role === "main_result" ? "main" : role === "experiment_config" ? "shared-config" : "unresolved"));
  return { role, roleBasis: basis, roleConfidence: groupToken || role === "source_code" || role === "figure_asset" ? "high" : "candidate", groupId };
}

/**
 * 兄弟目录同名文件 → 候选平行实验臂（M13.3，确定性）：
 * 同一 basename 出现在 ≥2 个互为兄弟的目录（如 results/A0/summary.txt 与
 * results/A1/summary.txt）时，把这些文件的 groupId 细化为 arm-<目录名>。
 * 只细化原本 unresolved 的文件；目录名须为短 slug。这是候选分组——
 * 臂的语义角色（baseline / 主方法 / 消融）不由此推断，由作者确认。
 */
function refineSiblingArmGroups(files: Array<Pick<PackageFile, "path" | "groupId" | "roleBasis">>): void {
  const byBase = new Map<string, Array<{ path: string; dir: string }>>();
  for (const file of files) {
    const base = basename(file.path);
    const entries = byBase.get(base) ?? [];
    entries.push({ path: file.path, dir: dirname(file.path) });
    byBase.set(base, entries);
  }
  const armDirs = new Map<string, string>(); // file path -> arm groupId
  for (const entries of byBase.values()) {
    if (entries.length < 2) continue;
    const dirs = [...new Set(entries.map((entry) => entry.dir))];
    if (dirs.length < 2) continue;
    const grandparents = new Set(dirs.map((dir) => dirname(dir)));
    if (grandparents.size !== 1) continue;
    for (const dir of dirs) {
      const name = basename(dir);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) continue;
      for (const entry of entries.filter((candidate) => candidate.dir === dir)) {
        armDirs.set(entry.path, `arm-${name.toLowerCase()}`);
      }
    }
  }
  for (const file of files) {
    const arm = armDirs.get(file.path);
    if (arm !== undefined && file.groupId === "unresolved") {
      file.groupId = arm;
      file.roleBasis = `${file.roleBasis}；兄弟目录同名文件（候选平行实验臂）`;
    }
  }
}

/**
 * 源材料判定提取（M13.3）：JSON/YAML 顶层叶子中字段名为 verdict/decision/
 * conclusion 且值为非空字符串（≤200 字符）→ 原样登记。
 * 排除两类噪声（Phase 9.0 真实材料实证）：数组内的逐条 decision（如
 * $.decisions[N].decision = "commit"——那是逐记录动作，不是实验判定）与
 * JSONL 行流字段（同一理由）。这是 Source-Reported Verdict——只引用原始
 * 表述，系统不重算、不解读，也不把它变成任何自动化结论。
 */
function collectReportedVerdicts(item: ExperimentPackage, file: PackageFile, document: ParsedDocument): void {
  if (document.parser.id === "jsonl") return;
  const verdicts = item.reportedVerdicts ?? [];
  for (const block of document.blocks) {
    if (verdicts.length >= MAX_REPORTED_VERDICTS) break;
    if (block.type !== "structured_record") continue;
    for (const cell of block.cells) {
      if (verdicts.length >= MAX_REPORTED_VERDICTS) break;
      if (cell.header.includes("[") || block.provenance.jsonPath?.includes("[")) continue;
      const leaf = cell.header.startsWith("$.") ? (cell.header.split(".").pop() ?? "") : cell.header;
      if (!VERDICT_FIELD.test(leaf)) continue;
      const value = cell.value.trim();
      if (value === "" || value.length > 200 || value === "null" || value === "undefined") continue;
      if (SECRET_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value)) continue;
      // rebuild 会在每次导入/编辑后重跑：同锚点同值的判定只登记一次，
      // 不随重建次数累积（真实材料实证：编辑两次后出现 5 份重复）
      if (verdicts.some((verdict) => verdict.path === file.path && verdict.field === cell.header && verdict.value === value)) continue;
      verdicts.push({ path: file.path, field: cell.header, value });
    }
  }
  if (verdicts.length > 0) item.reportedVerdicts = verdicts;
}

/**
 * 同组同名指标的小数/百分数标度混用告警（M13.3）：仅适用于比率型指标
 * （标准 MOT 词表中 direction=higher 的 HOTA/IDF1 一类——0.626 与 62.613
 * 两种标度并存是真实事故路径）。计数型指标（IDSW/Frag 的逐片段 1/2/3
 * 对池化 79/284）与未知指标不适用——Phase 9.0 真实材料实证的假阳性
 * 路径。两值都来自真实文件，不判错——只提醒作者在确认与出图前核对口径。
 */
function pushScaleConflictWarnings(item: ExperimentPackage): void {
  const byKey = new Map<string, number[]>();
  for (const observation of item.observations) {
    if (observation.value <= 0) continue;
    const leaf = observation.metric.split(/[./]/).pop() ?? observation.metric;
    if (METRIC_DIRECTION.get(leaf.toUpperCase()) !== "higher") continue;
    // M13.5：标度混用告警收敛到同一实验范围（groupId × split）内——
    // 不同 split 的同名指标本就不可直接比较，跨范围数值差异不告警
    const key = `${observation.groupId}\0${observationScopeKey(observation)}\0${leaf}`;
    const values = byKey.get(key) ?? [];
    values.push(observation.value);
    byKey.set(key, values);
  }
  for (const [key, values] of byKey) {
    if (values.length < 2) continue;
    const [groupId, scopeKey, leaf] = key.split("\0") as [string, string, string];
    const hasFraction = values.some((value) => value <= 1);
    const hasPercent = values.some((value) => value >= 30);
    if (!hasFraction || !hasPercent) continue;
    const min = Math.min(...values.filter((value) => value <= 1));
    const max = Math.max(...values.filter((value) => value >= 30));
    const ratio = max / Math.max(min, 1e-12);
    if (ratio < 30 || ratio > 300) continue;
    item.warnings.push(
      `指标 ${leaf} 在实验组 ${groupId}${scopeKey !== SPLIT_UNKNOWN ? `（范围 ${scopeKey}）` : ""} 内同时存在小数（${min}）与百分数量级（${max}）数值：疑似标度混用；确认与出图前请核对各来源口径`,
    );
  }
}

/**
 * 指标名 → 标准方向（词表未收录返回 unknown——不猜）。leaf = 路径最后一段；
 * M17.2：TrackEval detailed.csv 的 HOTA___AUC 即 HOTA（α 积分值），与 metricKey 同一归一规则
 */
function directionOf(metric: string): "higher" | "lower" | "unknown" {
  const leaf = (metric.split(/[./]/).pop() ?? metric).replace(/___AUC$/i, "");
  return METRIC_DIRECTION.get(leaf.toUpperCase()) ?? "unknown";
}

/** 行上下文 + 作者 metadata → 观测上下文字段（文件内显式值优先；矛盾登记为冲突，不覆盖） */
function observationContext(file: PackageFile, context: Map<string, string>, conflicts: Set<string>): Partial<MetricObservation> {
  const fromRow: Record<string, string | undefined> = {
    method: context.get("method") ?? context.get("model"),
    dataset: context.get("dataset"),
    seed: context.get("seed"),
    protocol: context.get("protocol"),
    split: context.get("split"),
    version: context.get("version"),
  };
  const result: Partial<MetricObservation> = {};
  const authorFilled: string[] = [];
  for (const field of FILE_METADATA_FIELDS) {
    const rowValue = fromRow[field];
    const authorValue = file.metadata?.[field];
    if (rowValue !== undefined && rowValue !== "") {
      result[field] = rowValue;
      if (authorValue !== undefined && authorValue !== rowValue) conflicts.add(`${file.path} 的 ${field}：文件内为「${rowValue}」，作者 metadata 为「${authorValue}」`);
    } else if (authorValue !== undefined && authorValue !== "") {
      result[field] = authorValue;
      authorFilled.push(field);
    }
  }
  const subset = context.get("seq") ?? context.get("sequence") ?? context.get("clip") ?? context.get("scene");
  if (subset !== undefined && subset !== "") result.subset = subset;
  if (authorFilled.length > 0) result.authorFilled = authorFilled;
  return result;
}

/** 表头单位 + 单元格显式单位 + 作者声明 → 最终单位（显式证据之间矛盾 → 冲突；作者只填补 unknown） */
function resolveUnit(file: PackageFile, metric: string, cellUnit: ExperimentUnit, cellBasis: UnitBasis, header: { unit: ExperimentUnit; basis: UnitBasis }, conflicts: Set<string>): { unit: ExperimentUnit; basis: UnitBasis } {
  let unit = cellUnit;
  let basis = cellBasis;
  if (header.unit !== "unknown") {
    if (unit === "unknown") { unit = header.unit; basis = header.basis; }
    else if (unit !== header.unit && !(unit === "ratio" && header.unit === "percentage" && cellBasis === "xlsx_percent_format")) {
      conflicts.add(`${file.path} 指标 ${metric}：单元格单位 ${unit} 与表头单位 ${header.unit} 矛盾`);
    }
  }
  const leaf = metric.split(/[./]/).pop() ?? metric;
  // 逐指标声明与显式证据矛盾 → 冲突；"*" 只填补未知单位（不与显式单位比对）
  const specific = file.metadata?.units?.[metric] ?? file.metadata?.units?.[leaf];
  const declared = specific ?? file.metadata?.units?.["*"];
  if (declared !== undefined && declared !== "unknown") {
    if (unit === "unknown") { unit = declared; basis = "author_metadata"; }
    else if (specific !== undefined && unit !== specific) {
      conflicts.add(`${file.path} 指标 ${metric}：作者声明单位 ${specific} 与文件内显式单位 ${unit} 矛盾`);
    }
  }
  return { unit, basis };
}

export interface MetricExtraction {
  observations: MetricObservation[];
  /** 不可当作事实的单元格（小数逗号 / 无缓存公式 / 合并从格）与截断——如实登记为告警 */
  issues: string[];
  /** 文件内显式值与作者 metadata / 单位矛盾 → 组冲突 */
  conflicts: string[];
}

export function metricObservations(file: PackageFile, document: ParsedDocument): MetricExtraction {
  const empty: MetricExtraction = { observations: [], issues: [], conflicts: [] };
  if (!["main_result", "baseline_result", "ablation_result"].includes(file.role)) return empty;
  // JSONL 行流是逐事件/逐机会的特征记录（score、cosine、frame…），不是
  // 实验级指标表：即便作者把它标成结果角色，也不提取指标观测——它的
  // 首要用途是图表数据集（见 figures/datasets.ts），进 context 会以
  // 数千条特征值淹没真正的实验指标。
  if (document.parser.id === "jsonl") return empty;
  const observations: MetricObservation[] = [];
  const issueCounts = new Map<string, { count: number; example: string }>();
  const conflicts = new Set<string>();
  let truncated = false;
  const noteIssue = (kind: string, where: string) => {
    const entry = issueCounts.get(kind) ?? { count: 0, example: where };
    entry.count += 1;
    issueCounts.set(kind, entry);
  };
  const push = (observation: MetricObservation): void => {
    if (observations.length >= MAX_FILE_OBSERVATIONS) { truncated = true; return; }
    observations.push(observation);
  };
  for (const block of document.blocks) {
    if (block.type === "structured_record") {
      const record = block as ParsedRecordBlock;
      const context = new Map(record.cells.filter((cell) => CONTEXT_COLUMNS.test(cell.header)).map((cell) => [cell.header.toLowerCase(), cell.value]));
      const ctx = observationContext(file, context, conflicts);
      for (const cell of record.cells) {
        if (CONTEXT_COLUMNS.test(cell.header) || SECRET_PATTERN.test(cell.header)) continue;
        const where = `${block.provenance.sheet !== undefined ? `${block.provenance.sheet}!` : ""}${cell.letter ?? ""}${block.provenance.row ?? ""}${block.provenance.jsonPath ?? ""}`;
        const parsed = parseMetricCell(cell.value, cell);
        if (parsed.kind === "skip") continue;
        if (parsed.kind === "issue") { noteIssue(parsed.issue, `${where}「${parsed.rawText}」`); continue; }
        const rawMetric = cell.header.startsWith("$.") ? cell.header.replace(/^\$\./, "") : cell.header;
        const header = headerUnit(rawMetric);
        const metric = header.metric;
        const { unit, basis } = resolveUnit(file, metric, parsed.unit, parsed.basis, header, conflicts);
        push({
          sourceId: file.sourceId!, path: file.path, blockId: block.blockId,
          ...(block.provenance.row !== undefined ? { row: block.provenance.row } : {}),
          ...(block.provenance.sheet !== undefined ? { sheet: block.provenance.sheet } : {}),
          ...(cell.letter !== undefined ? { column: cell.letter } : {}),
          ...(block.provenance.jsonPath !== undefined ? { jsonPath: block.provenance.jsonPath } : {}),
          ...ctx,
          metric, value: parsed.value, unit, direction: directionOf(metric), groupId: file.groupId,
          rawText: parsed.rawText, unitBasis: basis,
        });
      }
    } else if (block.type === "table") {
      // 空白对齐表 / PDF 表格中的结果表（M13.3）：表头 = 指标名，每行一条观测；
      // 行号 = 表头物理行 + 行序（与 Excel 1-based 行号约定一致）。
      const table = block as ParsedTableBlock;
      const baseRow = table.provenance.row ?? 1;
      table.rows.forEach((row, rowIndex) => {
        const context = new Map<string, string>();
        table.headers.forEach((header, index) => {
          if (CONTEXT_COLUMNS.test(header)) context.set(header.toLowerCase(), row[index] ?? "");
        });
        const ctx = observationContext(file, context, conflicts);
        for (let index = 0; index < table.headers.length; index += 1) {
          const rawHeader = table.headers[index]!;
          if (CONTEXT_COLUMNS.test(rawHeader) || SECRET_PATTERN.test(rawHeader)) continue;
          const parsed = parseMetricCell(row[index] ?? "");
          if (parsed.kind === "skip") continue;
          if (parsed.kind === "issue") { noteIssue(parsed.issue, `行 ${baseRow + 1 + rowIndex} 列 ${rawHeader}「${parsed.rawText}」`); continue; }
          const header = headerUnit(rawHeader);
          const { unit, basis } = resolveUnit(file, header.metric, parsed.unit, parsed.basis, header, conflicts);
          push({
            sourceId: file.sourceId!, path: file.path, blockId: block.blockId,
            row: baseRow + 1 + rowIndex,
            column: rawHeader,
            ...(table.provenance.sheet !== undefined ? { sheet: table.provenance.sheet } : {}),
            ...ctx,
            metric: header.metric, value: parsed.value, unit, direction: directionOf(header.metric), groupId: file.groupId,
            rawText: parsed.rawText, unitBasis: basis,
          });
        }
      });
    }
  }
  const issueLabels: Record<string, string> = {
    locale_decimal: "疑似小数逗号数值（未解析，不猜测）",
    formula_no_cached_value: "公式无缓存计算结果（值未知，不执行公式）",
    merged_copy: "合并单元格从格（复制自主格，不作为独立事实）",
  };
  const issues = [...issueCounts.entries()].map(([kind, entry]) => `${file.path}：${issueLabels[kind] ?? kind} ${entry.count} 处，例 ${entry.example}`);
  if (truncated) issues.push(`${file.path}：指标观测超过单文件上限 ${MAX_FILE_OBSERVATIONS} 条，其余单元格未提取（不是全部数据）`);
  return { observations, issues, conflicts: [...conflicts] };
}

/** workflowContext 代表性选择的内部候选：携带包上下文的原始观测（选择在原始数据上进行，输出时才做标签清洗） */
export interface WorkflowObservationCandidate {
  packageId: string;
  packageHash: string;
  observation: MetricObservation;
}

/** 码位全序：不用 localeCompare——跨平台 CI（Windows/Linux）必须逐字节一致 */
function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** M13.5：未声明 split 的观测归入的范围值（保留 Unknown，不自动补全、不推断） */
export const SPLIT_UNKNOWN = "unknown";

/** scope id 片段：split 原值 → 稳定 slug；不可映射时用序号兜底（确定性） */
function scopeSlug(split: string, index: number): string {
  if (split === SPLIT_UNKNOWN) return SPLIT_UNKNOWN;
  const slug = split.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug !== "" ? slug : `split-${index + 1}`;
}

/**
 * 由组观测构建观测级实验范围（M13.5，确定性）：
 * - 范围键 = 观测 split 原值（缺失 → unknown）；slug 冲突（两个不同原值
 *   折叠出同一 slug）按码位序追加 -2/-3 消解，绝不合并不同 split；
 * - 范围内 protocol 互相矛盾（B 类真冲突）→ scope.conflicts + status=conflict；
 *   不同 split 共存本身不是冲突（A 类，可分别确认）。
 */
function buildSplitScopes(groupId: string, observations: MetricObservation[]): ExperimentSplitScope[] {
  const bySplit = new Map<string, MetricObservation[]>();
  for (const observation of observations) {
    const key = observation.split ?? SPLIT_UNKNOWN;
    const list = bySplit.get(key) ?? [];
    list.push(observation);
    bySplit.set(key, list);
  }
  const usedSlugs = new Set<string>();
  const scopes: ExperimentSplitScope[] = [];
  for (const [rawSplit, scopeObservations] of [...bySplit.entries()].sort((a, b) => compareCodepoints(a[0], b[0]))) {
    let slug = scopeSlug(rawSplit, scopes.length);
    if (usedSlugs.has(slug)) {
      for (let suffix = 2; ; suffix += 1) {
        const candidate = `${slug}-${suffix}`;
        if (!usedSlugs.has(candidate)) {
          slug = candidate;
          break;
        }
      }
    }
    usedSlugs.add(slug);
    const protocols = [...new Set(scopeObservations.map((observation) => observation.protocol).filter((value): value is string => value !== undefined && value !== ""))];
    const conflicts: string[] = [];
    if (protocols.length > 1) {
      conflicts.push(`该范围内 protocol 不一致：${protocols.join(" / ")}`);
    }
    scopes.push({
      id: `${groupId}@${slug}`,
      split: rawSplit,
      status: conflicts.length > 0 ? "conflict" : "candidate",
      conflicts,
      workflowUse: "undecided",
      observationCount: scopeObservations.length,
      metricCount: new Set(scopeObservations.map((observation) => observation.metric)).size,
      filePaths: [...new Set(scopeObservations.map((observation) => observation.path))],
      protocols,
    });
  }
  return scopes;
}

/** scope id → groupId + 范围定位（groupId 合法字符集不含 @，首个 @ 前即组 id） */
function parseScopeId(scopeId: string): { groupId: string } | undefined {
  const at = scopeId.indexOf("@");
  if (at <= 0 || at === scopeId.length - 1) return undefined;
  return { groupId: scopeId.slice(0, at) };
}

/**
 * 组观测内容签名（M13.6 v1→v2 兼容用）：该组全部观测的锚点 + 数值逐条
 * 序列化后按码位排序拼接。确定性（与登记顺序无关）；升级前后签名一致 =
 * 「来源、范围和内容仍一致」，旧确认可以映射；不一致 = 提取层曾变化，
 * 保持待确认（不偷偷放行）。
 */
function groupObservationSignature(item: ExperimentPackage, groupId: string): string {
  return item.observations
    .filter((observation) => observation.groupId === groupId)
    .map((observation) =>
      [
        observation.sourceId, observation.path, observation.blockId,
        observation.row ?? "", observation.sheet ?? "", observation.column ?? "", observation.jsonPath ?? "",
        observation.metric, observation.value,
      ].join("\u0000"),
    )
    .sort(compareCodepoints)
    .join("\u0001");
}

/** 观测所属范围的 split 键（与 buildSplitScopes 的键一致） */
function observationScopeKey(observation: Pick<MetricObservation, "split">): string {
  return observation.split ?? SPLIT_UNKNOWN;
}

/** 组内稳定锚点全序：先来源文件（sourceId/path），再块内物理位置（row/column/jsonPath），
 * 兜底 metric/value——与文件登记顺序无关；同组观测集合不变则选择不变 */
function compareObservationAnchors(a: MetricObservation, b: MetricObservation): number {
  return compareCodepoints(a.sourceId, b.sourceId)
    || compareCodepoints(a.path, b.path)
    || compareCodepoints(a.blockId, b.blockId)
    || (a.row ?? 0) - (b.row ?? 0)
    || compareCodepoints(a.column ?? "", b.column ?? "")
    || compareCodepoints(a.jsonPath ?? "", b.jsonPath ?? "")
    || compareCodepoints(a.metric, b.metric)
    || a.value - b.value;
}

/**
 * Workflow Context 代表性选择（M13.3.1，确定性两阶段；导出仅供测试）：
 * 原实现按登记顺序截断前 100 条，单文件大结果集会把其他作者确认组完全
 * 挤出 Researcher 上下文（真实验收：2,311 条观测只进了 main 组 JSON 的
 * 前 100 条）。改为：
 * - 覆盖阶段：按组键（packageId\0groupId 码位序）先保证每个有效组至少
 *   一条——组数超出预算时按同一组序截断（明确、稳定、可解释，不声称
 *   全覆盖）；随后组间轮转，依次补齐各组尚未覆盖的 metric、来源文件
 *   （path）。只按锚点与标签的覆盖面选择：绝不按数值大小/方向挑"更好"
 *   的结果，不聚合、不改写、不虚构任何观测。
 * - 填充阶段：按组轮转、组内按锚点序填充剩余容量。
 * 返回顺序即选择顺序（组序 × 轮转序）；全程无随机源、无时钟、无输入
 * 枚举顺序依赖——包/文件登记顺序变化不会让某个有效组失去覆盖。
 */
export function selectWorkflowObservations(
  candidates: WorkflowObservationCandidate[],
  options: { anchorNumbers?: ReadonlySet<string> } = {},
): WorkflowObservationCandidate[] {
  if (candidates.length === 0) return [];
  // M14.8-MOT 锚定阶段（仅 existing-paper 传入稿件数值集时启用）：先选「数值在
  // 稿件正文里出现」的授权观测——真实论文 34,244 条观测 / 预算 100 条时，纯覆盖面
  // 选择几乎选不到论文实际引用的数值，Writer 的数值表与 review.run 的作者数据披露
  // 都与稿件脱节。以稿件数值（锚点）为单位轮转：每个锚点取一条最佳观测（聚合层级
  // 优先 = jsonPath 更浅），锚点按「精度类（≥3 位整数 / ≥4 位有效数字的小数 → 3 位小数 → 两位整数）→ 聚合层级 →
  // 特异性（命中它的观测越少越可信）→ 正文首次出现位置」排序。只看锚点特征，
  // 不看数值大小 / 方向；剩余预算回到原有覆盖面选择。
  const anchors = options.anchorNumbers;
  const anchored: WorkflowObservationCandidate[] = [];
  if (anchors !== undefined && anchors.size > 0) {
    const order = [...anchors];
    const position = new Map(order.map((token, index) => [token, index]));
    const byAnchor = new Map<string, WorkflowObservationCandidate[]>();
    for (const candidate of candidates) {
      for (const token of anchoredTokens(candidate.observation.value, anchors)) {
        const list = byAnchor.get(token) ?? [];
        list.push(candidate);
        byAnchor.set(token, list);
      }
    }
    const ranked = [...byAnchor.entries()]
      .map(([token, list]) => ({
        token,
        list: [...list].sort((a, b) => jsonPathDepth(a.observation.jsonPath) - jsonPathDepth(b.observation.jsonPath)
          || compareCodepoints(a.packageId, b.packageId)
          || compareObservationAnchors(a.observation, b.observation)),
      }))
      .sort((a, b) => anchorPrecisionClass(a.token) - anchorPrecisionClass(b.token)
        || jsonPathDepth(a.list[0]!.observation.jsonPath) - jsonPathDepth(b.list[0]!.observation.jsonPath)
        || a.list.length - b.list.length
        || (position.get(a.token) ?? 0) - (position.get(b.token) ?? 0));
    const taken = new Set<WorkflowObservationCandidate>();
    for (const { list } of ranked) {
      if (anchored.length >= MAX_WORKFLOW_OBSERVATIONS) break;
      const best = list.find((candidate) => !taken.has(candidate));
      if (best !== undefined) { taken.add(best); anchored.push(best); }
    }
    if (anchored.length >= MAX_WORKFLOW_OBSERVATIONS) return anchored;
    candidates = candidates.filter((candidate) => !taken.has(candidate));
    if (candidates.length === 0) return anchored;
  }
  const byGroup = new Map<string, { packageId: string; groupId: string; items: WorkflowObservationCandidate[]; picked: Set<number> }>();
  for (const candidate of candidates) {
    const key = `${candidate.packageId}\0${candidate.observation.groupId}`;
    const group = byGroup.get(key) ?? { packageId: candidate.packageId, groupId: candidate.observation.groupId, items: [], picked: new Set<number>() };
    group.items.push(candidate);
    byGroup.set(key, group);
  }
  const groups = [...byGroup.values()]
    .map((group) => ({ ...group, items: [...group.items].sort((a, b) => compareObservationAnchors(a.observation, b.observation)) }))
    .sort((a, b) => compareCodepoints(a.packageId, b.packageId) || compareCodepoints(a.groupId, b.groupId));
  const selected: WorkflowObservationCandidate[] = [...anchored];
  const hasBudget = () => selected.length < MAX_WORKFLOW_OBSERVATIONS;
  /** 组内锚点序第一条未选且满足需要的观测下标 */
  const nextUnpicked = (group: (typeof groups)[number], wanted: (index: number) => boolean): number => {
    for (let index = 0; index < group.items.length; index += 1) if (!group.picked.has(index) && wanted(index)) return index;
    return -1;
  };
  const pick = (group: (typeof groups)[number], index: number): void => { group.picked.add(index); selected.push(group.items[index]!); };
  for (const group of groups) {
    if (!hasBudget()) break;
    const index = nextUnpicked(group, () => true);
    if (index !== -1) pick(group, index);
  }
  // metric → path 两个覆盖维度 + 无差别填充，统一为组间轮转（每轮每组至多一条）
  for (const dimension of ["metric", "path"] as const) {
    let progress = true;
    while (progress && hasBudget()) {
      progress = false;
      for (const group of groups) {
        if (!hasBudget()) break;
        const covered = new Set([...group.picked].map((index) => group.items[index]!.observation[dimension]));
        const index = nextUnpicked(group, (candidate) => !covered.has(group.items[candidate]!.observation[dimension]));
        if (index !== -1) { pick(group, index); progress = true; }
      }
    }
  }
  let progress = true;
  while (progress && hasBudget()) {
    progress = false;
    for (const group of groups) {
      if (!hasBudget()) break;
      const index = nextUnpicked(group, () => true);
      if (index !== -1) { pick(group, index); progress = true; }
    }
  }
  return selected;
}

/**
 * 稿件数值锚点（M14.8-MOT）：从 LaTeX 正文提取有效数字 ≥3 位的数值串
 * （"700"、"57.97"、"0.669"、"597{,}152"→"597152"）。少于 3 位有效数字的
 * 数（5、12、0.8…）与海量观测巧合相等的概率太高，不作为锚点。
 */
export function manuscriptNumberAnchors(text: string): Set<string> {
  const normalized = text
    // 参考文献（年份 / 卷期页）、注释、引用 key、长度参数都不是实验数值
    .replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/g, " ")
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\(?:cite[pt]?|ref|label|eqref|includegraphics|url|bibliography)\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:pt|em|ex|cm|mm|in|bp|\\(?:linewidth|textwidth|columnwidth|hsize|baselineskip))/g, " ")
    .replace(/(\d)\{,\}(?=\d{3})/g, "$1")
    .replace(/(\d)\\,(?=\d{3})/g, "$1")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  const anchors = new Set<string>();
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?/g)) {
    const token = match[0];
    // 两位整数（10–99，如 IDSW 80 / 43）保留为最低精度锚点；其余要求 ≥3 位有效数字
    if (significantDigits(token) < 3 && !/^[1-9]\d$/.test(token)) continue;
    // 四位整数 1900–2099 几乎都是年份（发表年 / 数据集年份）
    if (/^(19|20)\d{2}$/.test(token)) continue;
    anchors.add(token);
  }
  return anchors;
}

function significantDigits(token: string): number {
  return token.replace(".", "").replace(/^0+/, "").length;
}

/** 观测值的文本渲染（原尺度 1–4 位小数；(0,1] 的比例值另试百分数尺度）中命中的锚点 */
function anchoredTokens(value: number, anchors: ReadonlySet<string>): string[] {
  if (!Number.isFinite(value)) return [];
  const renderings = new Set<string>();
  const abs = Math.abs(value);
  if (Number.isInteger(abs)) renderings.add(String(abs));
  for (let digits = 1; digits <= 4; digits += 1) {
    renderings.add(abs.toFixed(digits));
    if (abs > 0 && abs <= 1) renderings.add((abs * 100).toFixed(digits));
  }
  return [...renderings].filter((rendering) => anchors.has(rendering));
}

/** 0 = 精确锚点（≥3 位整数或 ≥4 位有效数字的小数），1 = 3 位有效数字小数，2 = 两位整数（巧合相等概率最高） */
function anchorPrecisionClass(token: string): number {
  if (!token.includes(".")) return significantDigits(token) >= 3 ? 0 : 2;
  return significantDigits(token) >= 4 ? 0 : 1;
}

function jsonPathDepth(path: string | undefined): number {
  return path === undefined ? 0 : (path.match(/[.[]/g) ?? []).length;
}

/**
 * M14.9.1 C2：只读路径共享的已解析 Manifest 的空闲保留时长。真实 R5.1 审查包（916 文件、
 * 59 万条观测）manifest 约 247 MB：view / list / workflowContext / queryObservations 每次都
 * 重新 JSON.parse，3 个并发 workflowContext 实测堆峰值 2.3 GB（单次 ≈ 1.1 GB）。只读调用方
 * 在文件 mtime / size 未变时共享同一份解析结果（并发请求共享同一个解析 Promise）；写路径
 * （get → 修改 → save）仍各自解析独立副本，save 后立即失效共享副本。
 */
const SHARED_MANIFEST_IDLE_MS = 120_000;

interface SharedManifest {
  mtimeMs: number;
  size: number;
  item: Promise<ExperimentPackage>;
  timer: ReturnType<typeof setTimeout>;
}

export class ExperimentPackageService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly shared = new Map<string, SharedManifest>();
  private readonly semanticModel?: { runtime: ExperimentModelRuntime; defaultModel: () => string | undefined | Promise<string | undefined> };
  constructor(private readonly projects: ProjectStore, private readonly sources: SourceStore, private readonly ingestion: IngestionService, private readonly documents: ParsedDocumentStore, options?: { semanticModel?: { runtime: ExperimentModelRuntime; defaultModel: () => string | undefined | Promise<string | undefined> } }) {
    this.semanticModel = options?.semanticModel;
  }

  private root(projectId: string): string { return join(this.projects.projectDir(projectId), "experiments"); }
  private dir(projectId: string, packageId: string): string { return join(this.root(projectId), packageId); }
  private path(projectId: string, packageId: string): string { return join(this.dir(projectId, packageId), "manifest.json"); }
  private enqueue<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(run);
    this.queues.set(projectId, task);
    task.finally(() => { if (this.queues.get(projectId) === task) this.queues.delete(projectId); }).catch(() => {});
    return task;
  }
  private async save(projectId: string, item: ExperimentPackage): Promise<void> {
    await writeJsonAtomic(this.path(projectId, item.packageId), item);
    this.dropShared(projectId, item.packageId);
  }
  private sharedKey(projectId: string, packageId: string): string { return `${projectId}\0${packageId}`; }
  private dropShared(projectId: string, packageId: string): void {
    const key = this.sharedKey(projectId, packageId);
    const entry = this.shared.get(key);
    if (entry !== undefined) clearTimeout(entry.timer);
    this.shared.delete(key);
  }
  /**
   * 只读调用方共享的 Manifest（调用方**不得修改**返回对象；需要修改请用 get() 取独立副本）。
   * 文件 mtime / size 与缓存不一致 → 重新解析；解析失败不缓存（错误照常抛出）。
   */
  private async readShared(projectId: string, packageId: string): Promise<ExperimentPackage> {
    if (!/^ep-[a-f0-9]{32}$/.test(packageId)) return this.get(projectId, packageId);
    let info: { mtimeMs: number; size: number };
    try { info = await stat(this.path(projectId, packageId)); }
    catch { return this.get(projectId, packageId); }
    const key = this.sharedKey(projectId, packageId);
    const cached = this.shared.get(key);
    const timer = () => {
      const handle = setTimeout(() => this.shared.delete(key), SHARED_MANIFEST_IDLE_MS);
      handle.unref?.();
      return handle;
    };
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      clearTimeout(cached.timer);
      cached.timer = timer();
      return cached.item;
    }
    if (cached !== undefined) this.dropShared(projectId, packageId);
    const item = this.get(projectId, packageId);
    const entry: SharedManifest = { mtimeMs: info.mtimeMs, size: info.size, item, timer: timer() };
    this.shared.set(key, entry);
    item.catch(() => { if (this.shared.get(key) === entry) this.dropShared(projectId, packageId); });
    return item;
  }
  async get(projectId: string, packageId: string): Promise<ExperimentPackage> {
    await this.projects.getRequired(projectId);
    if (!/^ep-[a-f0-9]{32}$/.test(packageId)) throw new BusinessError("INVALID_REQUEST", "非法 packageId");
    let raw: string;
    try { raw = await readFile(this.path(projectId, packageId), "utf8"); }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") throw new NotFoundError("实验包", packageId); throw error; }
    try {
      const item = JSON.parse(raw) as ExperimentPackage;
      if ((item.schemaVersion !== 1 && item.schemaVersion !== 2) || item.packageId !== packageId || !/^[a-f0-9]{64}$/.test(item.packageHash) || typeof item.originalName !== "string" ||
        !["inventory", "importing", "ready", "partial"].includes(item.status) || !Array.isArray(item.files) || !Array.isArray(item.groups) ||
        !Array.isArray(item.observations) || !Array.isArray(item.relationCandidates) || !Array.isArray(item.warnings) ||
        (item.reportedVerdicts !== undefined && (!Array.isArray(item.reportedVerdicts) || item.reportedVerdicts.some((verdict) =>
          !verdict || typeof verdict.path !== "string" || typeof verdict.field !== "string" || typeof verdict.value !== "string"))) ||
        (item.semanticSuggestions !== undefined && (typeof item.semanticSuggestions !== "object" || item.semanticSuggestions === null ||
          !Array.isArray(item.semanticSuggestions.roleSuggestions) || !Array.isArray(item.semanticSuggestions.findings) || !Array.isArray(item.semanticSuggestions.notes) ||
          typeof item.semanticSuggestions.model !== "string")) ||
        item.groups.some((group) => group.splitScopes !== undefined && (!Array.isArray(group.splitScopes) || group.splitScopes.some((scope) =>
          !scope || typeof scope.id !== "string" || typeof scope.split !== "string" ||
          !["candidate", "confirmed", "conflict"].includes(scope.status) || !Array.isArray(scope.conflicts) ||
          !["allowed", "excluded", "undecided"].includes(scope.workflowUse) || typeof scope.observationCount !== "number"))) ||
        item.files.some((file) => !file || typeof file.path !== "string" || typeof file.bytes !== "number" || typeof file.role !== "string" || typeof file.groupId !== "string")) throw new Error();
      return item;
    } catch { throw new BusinessError("EXPERIMENT_MANIFEST_CORRUPTED", "实验包 Manifest 损坏，已停止读写"); }
  }
  async list(projectId: string): Promise<ExperimentPackage[]> {
    await this.projects.getRequired(projectId);
    let ids: string[];
    try { ids = await readdir(this.root(projectId)); }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return []; throw error; }
    const result: ExperimentPackage[] = [];
    for (const id of ids.filter((id) => /^ep-[a-f0-9]{32}$/.test(id))) result.push(await this.view(projectId, id));
    return result.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }
  async view(projectId: string, packageId: string): Promise<ExperimentPackage> {
    await this.projects.getRequired(projectId);
    const item = await this.readShared(projectId, packageId);
    const invalid = new Set<string>();
    for (const file of item.files) {
      if (!file.sourceId) continue;
      const source = await this.sources.get(projectId, file.sourceId);
      if (!source || source.contentHash !== file.hash) invalid.add(file.path);
    }
    if (!invalid.size) return item;
    return {
      ...item,
      groups: item.groups.map((group) => group.filePaths.some((path) => invalid.has(path))
        ? { ...group, status: "conflict", conflicts: [...group.conflicts, "已确认的来源已删除或内容变化；需重新导入并确认"] }
        : group),
      warnings: [...item.warnings, ...[...invalid].map((path) => `${path}: Source 已删除或内容变化`)],
    };
  }
  async importZip(projectId: string, archivePath: string, originalName: string): Promise<{ item: ExperimentPackage; created: boolean }> {
    return this.enqueue(projectId, async () => {
      await this.projects.getRequired(projectId);
      const { hash } = await hashArchive(archivePath);
      const packageId = `ep-${hash.slice(0, 32)}`;
      const inventory = await visitArchive(archivePath);
      // Validate every compressed stream and CRC before creating any Source or manifest.
      await visitArchive(archivePath, async () => {});
      let item: ExperimentPackage;
      try { item = await this.get(projectId, packageId); if (item.status === "ready" || item.status === "partial") return { item, created: false }; }
      catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        const displayName = originalName.replaceAll("\\", "/").split("/").pop()?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "experiment.zip";
        const files = inventory.map((entry) => ({ path: entry.path, hash: "", bytes: entry.size, compressedBytes: entry.compressedSize, kind: assetKindOfFileName(entry.path), parseStatus: "pending" as const, ...classify(entry.path) }));
        refineSiblingArmGroups(files);
        item = { schemaVersion: 1, packageId, packageHash: hash, originalName: displayName, importedAt: new Date().toISOString(), status: "inventory", files, groups: [], observations: [], relationCandidates: [], warnings: [] };
        await mkdir(this.dir(projectId, packageId), { recursive: true });
        await copyFile(archivePath, join(this.dir(projectId, packageId), "original.zip"));
        await this.save(projectId, item);
      }
      item.status = "importing";
      await this.save(projectId, item);
      await visitArchive(join(this.dir(projectId, packageId), "original.zip"), async (entry: ArchiveEntryInfo, data) => {
        const file = item.files.find((candidate) => candidate.path === entry.path)!;
        const hash = sha256Hex(data);
        if (file.hash && file.hash !== hash) throw new BusinessError("EXPERIMENT_ARCHIVE_UNSAFE", "归档内容与已存 Manifest 不一致");
        file.hash = hash;
        const extension = extname(entry.path).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(extension)) {
          file.parseStatus = "unsupported";
          await this.save(projectId, item);
          return;
        }
        try {
          const existing = await this.sources.findByContentHash(projectId, hash);
          const source = existing ?? (await this.sources.add(projectId, { fileName: sourceNameFor(entry.path, hash), content: data, origin: "EXPERIMENT_PACKAGE", sourceRole: "evidence" })).source;
          file.sourceId = source.sourceId;
          const document = await this.ingestion.ingest(projectId, source.sourceId);
          file.parseStatus = document.status === "ok" ? "ok" : document.status;
          if (document.status === "failed") file.warning = "解析器未能读取此文件";
        } catch {
          file.parseStatus = "failed";
          file.warning = "文件解析失败；原始 ZIP 和其他文件仍可用";
        }
        await this.save(projectId, item);
      });
      await this.rebuild(projectId, item);
      item.status = item.files.some((file) => file.parseStatus === "failed") ? "partial" : "ready";
      await this.save(projectId, item);
      return { item, created: true };
    });
  }
  private async rebuild(projectId: string, item: ExperimentPackage): Promise<void> {
    const groups = new Map<string, ExperimentGroup>();
    item.observations = [];
    item.relationCandidates = [];
    const extractionIssues: string[] = [];
    for (const file of item.files) {
      const role = file.groupId.startsWith("baseline") ? "baseline" : file.groupId.startsWith("ablation") ? "ablation" : file.groupId === "main" ? "main" : "other";
      const group = groups.get(file.groupId) ?? { id: file.groupId, role, filePaths: [], basis: "路径/文件名候选；共同数据集不证明协议一致", status: "candidate", conflicts: [] } satisfies ExperimentGroup;
      group.filePaths.push(file.path);
      groups.set(file.groupId, group);
      if (file.sourceId && file.parseStatus !== "failed") {
        const source = await this.sources.get(projectId, file.sourceId);
        if (!source || source.contentHash !== file.hash) { group.conflicts.push(`来源 ${file.path} 已删除或内容变化`); continue; }
        const document = await this.documents.load(projectId, file.sourceId);
        if (document) {
          const extraction = metricObservations(file, document);
          item.observations.push(...extraction.observations);
          extractionIssues.push(...extraction.issues);
          group.conflicts.push(...extraction.conflicts);
          collectReportedVerdicts(item, file, document);
        }
      }
    }
    // M13.5 观测级实验范围：同组观测按 split 细分为可独立确认的范围。
    // 「split 不一致」不再整组判 conflict（真实 A2e 包 main 组三范围曾被
    // 此规则死锁）；真正的协议矛盾只看同一范围内。
    for (const group of groups.values()) {
      const groupObservations = item.observations.filter((observation) => observation.groupId === group.id);
      group.splitScopes = buildSplitScopes(group.id, groupObservations);
      if (group.splitScopes.some((scope) => scope.status === "conflict")) group.status = "conflict";
      if (group.conflicts.length) group.status = "conflict";
    }
    for (const file of item.files.filter((entry) => entry.role === "experiment_config" && entry.sourceId && entry.parseStatus !== "failed")) {
      const document = await this.documents.load(projectId, file.sourceId!);
      if (!document) continue;
      const config = new Map<string, string>();
      for (const block of document.blocks) {
        if (block.type !== "structured_record") continue;
        for (const cell of block.cells) {
          const field = cell.header.replace(/^\$\./, "").toLowerCase();
          if (["model", "method", "dataset", "seed", "protocol", "split"].includes(field) && !SECRET_PATTERN.test(field)) config.set(field, cell.value);
        }
      }
      for (const group of groups.values()) {
        if (group.role === "other") continue;
        const observation = item.observations.find((entry) => entry.groupId === group.id);
        if (!observation) continue;
        // 多范围组的 split 字段与单一观测比较无意义（范围内 split 恒定，
        // 跨范围差异是预期而非冲突）——跳过 split 字段，其余字段照常逐值比较
        const multiScope = (group.splitScopes?.length ?? 0) > 1;
        const comparisons: Array<[string, string | undefined]> = multiScope
          ? [["model", observation.method], ["method", observation.method], ["dataset", observation.dataset], ["seed", observation.seed], ["protocol", observation.protocol]]
          : [["model", observation.method], ["method", observation.method], ["dataset", observation.dataset], ["seed", observation.seed], ["protocol", observation.protocol], ["split", observation.split]];
        const matchedFields = comparisons.filter(([field, value]) => value !== undefined && config.get(field) === value).map(([field]) => field);
        const conflictingFields = comparisons.filter(([field, value]) => value !== undefined && config.has(field) && config.get(field) !== value).map(([field]) => field);
        if (matchedFields.length === 0 && conflictingFields.length === 0) continue;
        item.relationCandidates.push({ configPath: file.path, groupId: group.id, status: conflictingFields.length ? "conflict" : "candidate", basis: "配置字段与结果行逐值比较；候选关联须作者确认", matchedFields, conflictingFields });
        if (conflictingFields.length && file.groupId === group.id) { group.conflicts.push(`配置 ${file.path} 的 ${conflictingFields.join(", ")} 与结果不一致`); group.status = "conflict"; }
      }
    }
    item.groups = [...groups.values()];
    item.warnings = item.files.filter((file) => file.parseStatus === "failed").map((file) => `${file.path}: 解析失败`);
    if (item.files.some((file) => file.groupId === "unresolved")) item.warnings.push("部分文件的实验分组未确定，需作者核对");
    item.warnings.push(...extractionIssues);
    item.schemaVersion = 2;
    pushScaleConflictWarnings(item);
  }
  async editFile(projectId: string, packageId: string, path: string, role: ExperimentRole, groupId: string): Promise<ExperimentPackage> {
    return this.enqueue(projectId, async () => {
      const item = await this.get(projectId, packageId);
      const file = item.files.find((entry) => entry.path === path);
      if (!file) throw new BusinessError("INVALID_REQUEST", "实验包内无此文件");
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(groupId)) throw new BusinessError("INVALID_REQUEST", "非法实验组 ID");
      file.role = role; file.roleBasis = "作者修改"; file.roleConfidence = "high"; file.groupId = groupId;
      await this.rebuild(projectId, item);
      await this.save(projectId, item);
      return item;
    });
  }
  /**
   * M17.2 作者补充文件级 metadata（方法 / 数据集 / 划分 / 协议 / seed / 版本 / 指标单位）。
   * 只填补文件内缺失字段，矛盾登记冲突；编辑会重建观测——与 editFile 相同，既有组 / 范围确认随重建失效，需作者重新核对。
   * 传 null 的字段被清除。值经标签白名单校验（不接受控制字符 / 疑似密钥）。
   */
  async editFileMetadata(projectId: string, packageId: string, path: string, patch: Record<string, unknown>): Promise<ExperimentPackage> {
    return this.enqueue(projectId, async () => {
      const item = await this.get(projectId, packageId);
      if (item.status === "inventory" || item.status === "importing") throw new BusinessError("INVALID_REQUEST", "实验包仍在解析中，暂不能编辑 metadata");
      const file = item.files.find((entry) => entry.path === path);
      if (!file) throw new BusinessError("INVALID_REQUEST", "实验包内无此文件");
      const next: FileExperimentMetadata = { ...(file.metadata ?? {}) };
      for (const field of [...FILE_METADATA_FIELDS, "note"] as const) {
        if (!(field in patch)) continue;
        const value = patch[field];
        if (value === null || value === "") { delete next[field]; continue; }
        const label = typeof value === "string" ? safeContextLabel(value) : undefined;
        if (label === undefined) throw new BusinessError("INVALID_REQUEST", `metadata 字段 ${field} 不是合法标签：只允许文字、数字、空格与 . _ + : / % ( ) -，以文字或数字开头，最长 96 字符，且不能含疑似密钥`);
        next[field] = label;
      }
      if ("units" in patch) {
        const units = patch["units"];
        if (units === null) delete next.units;
        else {
          if (typeof units !== "object" || Array.isArray(units)) throw new BusinessError("INVALID_REQUEST", "units 必须是 指标名 → 单位 的对象");
          const parsed: Record<string, ExperimentUnit> = {};
          for (const [metric, unit] of Object.entries(units as Record<string, unknown>)) {
            if (!(metric === "*" || safeContextLabel(metric) === metric) || metric.length > 96) throw new BusinessError("INVALID_REQUEST", `非法指标名：${metric.slice(0, 40)}`);
            if (typeof unit !== "string" || !(EXPERIMENT_UNITS as readonly string[]).includes(unit)) throw new BusinessError("INVALID_REQUEST", `非法单位：${String(unit).slice(0, 20)}（允许 ${EXPERIMENT_UNITS.join(" / ")}）`);
            if (unit !== "unknown") parsed[metric] = unit as ExperimentUnit;
          }
          if (Object.keys(parsed).length > 200) throw new BusinessError("INVALID_REQUEST", "单位声明过多（上限 200）");
          if (Object.keys(parsed).length > 0) next.units = parsed; else delete next.units;
        }
      }
      if (Object.keys(next).length > 0) file.metadata = next; else delete file.metadata;
      await this.rebuild(projectId, item);
      await this.save(projectId, item);
      return item;
    });
  }
  /**
   * 重新整理分组（M13.5.3）：用当前分组规则（观测级 split 范围）重建整包的
   * 组 / 范围 / 观测 / 关联候选，并把 manifest 升级到 schema v2。
   *
   * 场景：M13.5 之前导入的 v1 包把「同一结果文件含多个 split」整组判为
   * conflict，而 v1 包只在作者编辑某个文件分类后才会 rebuild——作者面对
   * 「有冲突」却没有任何不改数据的出口。本操作是显式、作者触发的重建：
   * 不改任何文件角色 / 分组归属 / 观测值，只重算派生结构。
   *
   * 代价与编辑文件一致：既有的组确认与工作流授权全部失效（组是重建的），
   * 需按范围重新核对——这是有意的，重建后的范围是新的确认对象。
   */
  async rebuildPackage(projectId: string, packageId: string): Promise<ExperimentPackage> {
    return this.enqueue(projectId, async () => {
      const item = await this.get(projectId, packageId);
      if (item.status === "inventory" || item.status === "importing") throw new BusinessError("INVALID_REQUEST", "实验包仍在解析中，暂不能重新整理分组");
      await this.rebuild(projectId, item);
      await this.save(projectId, item);
      return item;
    });
  }
  /**
   * v1 → v2 自动兼容（M13.6）：把 M13.5 之前导入的 schema v1 包确定性升级到
   * 观测级范围（splitScopes）。幂等：v2 包原样跳过；重复调用结果不变。
   *
   * 触发时机（均显式 POST / 运行前检查，不在普通 GET 里做副作用）：
   * 实验数据页打开时 / 论文工作流启动前。升级不改任何文件分类与归属、
   * 不重创建 Source、原始 ZIP 不变（rebuild 只重算派生结构，指标来自
   * 已落盘的解析产物）。
   *
   * 旧确认映射（保守）：仅当重建后该组无冲突、观测内容签名与升级前一致、
   * 且恰好落在单一范围（或无观测的组）时，把 v1 的「整组确认 = 进入工作流」
   * 语义映射为 scope confirmed + workflowUse=allowed。多范围 / 内容变化 /
   * 出现冲突的组保持待确认——不偷偷放行，作者按范围重新核对。
   */
  async ensureSchemaUpgraded(projectId: string): Promise<{
    upgraded: string[];
    preservedConfirmations: Array<{ packageId: string; groupId: string }>;
    resetConfirmations: Array<{ packageId: string; groupId: string; reason: string }>;
  }> {
    return this.enqueue(projectId, async () => {
      await this.projects.getRequired(projectId);
      let ids: string[];
      try { ids = await readdir(this.root(projectId)); }
      catch (error) { if ((error as { code?: string }).code === "ENOENT") return { upgraded: [], preservedConfirmations: [], resetConfirmations: [] }; throw error; }
      const upgraded: string[] = [];
      const preservedConfirmations: Array<{ packageId: string; groupId: string }> = [];
      const resetConfirmations: Array<{ packageId: string; groupId: string; reason: string }> = [];
      for (const id of ids.filter((candidate) => /^ep-[a-f0-9]{32}$/.test(candidate))) {
        let item: ExperimentPackage;
        try { item = await this.get(projectId, id); } catch { continue; }
        if (item.schemaVersion !== 1 || (item.status !== "ready" && item.status !== "partial")) continue;
        const confirmedBefore = new Map(
          item.groups
            .filter((group) => group.status === "confirmed")
            .map((group) => [group.id, { confirmedAt: group.confirmedAt, signature: groupObservationSignature(item, group.id) }]),
        );
        await this.rebuild(projectId, item);
        for (const [groupId, snapshot] of confirmedBefore) {
          const group = item.groups.find((entry) => entry.id === groupId);
          if (group === undefined) {
            resetConfirmations.push({ packageId: id, groupId, reason: "重建后该实验组不再存在" });
            continue;
          }
          const scopes = group.splitScopes ?? [];
          if (group.conflicts.length > 0 || scopes.some((scope) => scope.status === "conflict")) {
            resetConfirmations.push({ packageId: id, groupId, reason: "按范围级规则重查后存在冲突，需作者处理" });
            continue;
          }
          if (scopes.length > 1) {
            resetConfirmations.push({ packageId: id, groupId, reason: `升级后划分为 ${scopes.length} 个评测范围（${scopes.map((scope) => scope.split).join(" / ")}），原整组确认无法唯一映射——请按范围分别确认` });
            continue;
          }
          if (scopes.length === 1 && groupObservationSignature(item, groupId) !== snapshot.signature) {
            resetConfirmations.push({ packageId: id, groupId, reason: "重建后的观测内容与升级前不一致（提取层曾变化），需作者重新核对" });
            continue;
          }
          // v1 语义映射：整组确认 = 该组（唯一）范围确认并进入工作流
          group.status = "confirmed"; group.confirmedAt ??= snapshot.confirmedAt;
          const scope = scopes[0];
          if (scope !== undefined) {
            scope.status = "confirmed"; scope.confirmedAt ??= snapshot.confirmedAt;
            if (scope.workflowUse === "undecided") { scope.workflowUse = "allowed"; scope.workflowUseDecidedAt = new Date().toISOString(); }
          }
          preservedConfirmations.push({ packageId: id, groupId });
        }
        await this.save(projectId, item);
        upgraded.push(id);
      }
      return { upgraded, preservedConfirmations, resetConfirmations };
    });
  }
  /**
   * 「用于当前论文」一次性确认 + 授权（M13.6）：把「确认记录真实」与「允许
   * 进入工作流」合并为一次作者操作（普通单范围包一次点击；多 split 包一次
   * 勾选提交）。服务端仍走正式状态机：
   * - groupIds：单（零）范围组——确认 + allowed（与 v1 整组确认语义一致）；
   * - scopeIds：多范围组的范围——确认该范围 + allowed；
   * - excludeScopeIds：已确认范围的显式排除（取消授权立即生效于后续 run）。
   * 全部目标先校验后应用（任一目标非法 → 整批拒绝，不产生半应用状态）；
   * 未选中的范围保持 undecided（不进入上下文，也不标成明确排除）。
   */
  async applyWorkflowUse(
    projectId: string,
    packageId: string,
    selection: { groupIds?: string[]; scopeIds?: string[]; excludeScopeIds?: string[] },
  ): Promise<ExperimentPackage> {
    return this.enqueue(projectId, async () => {
      const item = await this.get(projectId, packageId);
      if (item.status !== "ready" && item.status !== "partial") throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", "实验包尚未完成解析");
      const groupIds = [...new Set(selection.groupIds ?? [])];
      const scopeIds = [...new Set(selection.scopeIds ?? [])];
      const excludeScopeIds = [...new Set(selection.excludeScopeIds ?? [])];
      if (groupIds.length === 0 && scopeIds.length === 0 && excludeScopeIds.length === 0) {
        throw new BusinessError("INVALID_REQUEST", "需要至少一个 groupIds / scopeIds / excludeScopeIds");
      }
      const checkSourcesAlive = async (paths: string[]): Promise<void> => {
        for (const path of paths) {
          const file = item.files.find((entry) => entry.path === path);
          if (!file || !file.sourceId || file.parseStatus === "failed") continue;
          const source = await this.sources.get(projectId, file.sourceId);
          if (!source || source.contentHash !== file.hash) throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${path} 来源已删除或变化`);
        }
      };
      const overlap = scopeIds.filter((scopeId) => excludeScopeIds.includes(scopeId));
      if (overlap.length > 0) throw new BusinessError("INVALID_REQUEST", `同一范围不能同时选择与排除：${overlap.join("、")}`);
      // ---- 校验阶段（不改动任何状态） ----
      const groupTargets: ExperimentGroup[] = [];
      for (const id of groupIds) {
        const group = item.groups.find((entry) => entry.id === id);
        if (!group) throw new BusinessError("INVALID_REQUEST", `不存在实验组 ${id}`);
        const scopeCount = group.splitScopes?.length ?? 0;
        if (scopeCount > 1) {
          throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `实验组 ${id} 包含 ${scopeCount} 个评测范围（${group.splitScopes!.map((scope) => scope.split).join(" / ")}），请在范围级选择中勾选`);
        }
        await checkSourcesAlive(group.filePaths);
        if (group.conflicts.length) throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${id} 有未解决冲突`);
        if ((group.splitScopes ?? []).some((scope) => scope.conflicts.length > 0)) {
          throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${id} 存在范围内协议矛盾，需先解决`);
        }
        groupTargets.push(group);
      }
      const scopeTargets: ExperimentSplitScope[] = [];
      for (const scopeId of scopeIds) {
        const parsed = parseScopeId(scopeId);
        const group = parsed === undefined ? undefined : item.groups.find((entry) => entry.id === parsed.groupId);
        const scope = group?.splitScopes?.find((entry) => entry.id === scopeId);
        if (group === undefined || scope === undefined) throw new BusinessError("INVALID_REQUEST", `不存在实验范围 ${scopeId}`);
        await checkSourcesAlive(scope.filePaths);
        if (scope.status === "conflict" || scope.conflicts.length > 0) throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${scopeId} 有未解决冲突（${scope.conflicts.join("；")}）`);
        if (group.conflicts.length > 0) throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${group.id} 有组级未解决冲突（${group.conflicts.join("；")}）`);
        scopeTargets.push(scope);
      }
      const excludeTargets: ExperimentSplitScope[] = [];
      for (const scopeId of excludeScopeIds) {
        const parsed = parseScopeId(scopeId);
        const group = parsed === undefined ? undefined : item.groups.find((entry) => entry.id === parsed.groupId);
        const scope = group?.splitScopes?.find((entry) => entry.id === scopeId);
        if (group === undefined || scope === undefined) throw new BusinessError("INVALID_REQUEST", `不存在实验范围 ${scopeId}`);
        if (scope.status !== "confirmed" && !scopeTargets.includes(scope)) {
          throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `范围 ${scopeId} 尚未确认；排除只对已确认范围有意义`);
        }
        excludeTargets.push(scope);
      }
      // ---- 应用阶段（校验全部通过） ----
      const decidedAt = new Date().toISOString();
      for (const group of groupTargets) {
        group.status = "confirmed"; group.confirmedAt ??= decidedAt;
        const only = group.splitScopes?.[0];
        if (only !== undefined && only.status !== "conflict") {
          only.status = "confirmed"; only.confirmedAt ??= decidedAt;
          only.workflowUse = "allowed"; only.workflowUseDecidedAt = decidedAt;
        }
      }
      for (const scope of scopeTargets) {
        scope.status = "confirmed"; scope.confirmedAt ??= decidedAt;
        scope.workflowUse = "allowed"; scope.workflowUseDecidedAt = decidedAt;
        const parsed = parseScopeId(scope.id)!;
        const group = item.groups.find((entry) => entry.id === parsed.groupId)!;
        if ((group.splitScopes ?? []).every((entry) => entry.status === "confirmed")) {
          group.status = "confirmed"; group.confirmedAt ??= decidedAt;
        }
      }
      for (const scope of excludeTargets) {
        scope.workflowUse = "excluded"; scope.workflowUseDecidedAt = decidedAt;
      }
      await this.save(projectId, item);
      return item;
    });
  }
  /**
   * Experiment Policy 摘要（M13.6，只读）：全部包的范围级授权视图（供
   * Feasibility / Reviewer / Revision 等角色共享同一实验数据口径——不注入
   * 原始数值表）。v1 旧包只有整组确认信号（legacyConfirmedGroupIds）。
   */
  async experimentPolicy(projectId: string): Promise<{
    entries: Array<{
      packageId: string; groupId: string; scopeId: string; split: string;
      status: "candidate" | "confirmed" | "conflict"; workflowUse: "allowed" | "excluded" | "undecided";
      observationCount: number; metricCount: number;
    }>;
    legacyConfirmedGroupIds: string[];
  }> {
    const items = await this.list(projectId);
    const entries: Array<{
      packageId: string; groupId: string; scopeId: string; split: string;
      status: "candidate" | "confirmed" | "conflict"; workflowUse: "allowed" | "excluded" | "undecided";
      observationCount: number; metricCount: number;
    }> = [];
    const legacyConfirmedGroupIds: string[] = [];
    for (const item of items) {
      for (const group of item.groups) {
        if (group.splitScopes === undefined) {
          if (group.status === "confirmed") legacyConfirmedGroupIds.push(group.id);
          continue;
        }
        for (const scope of group.splitScopes) {
          entries.push({
            packageId: item.packageId, groupId: group.id, scopeId: scope.id, split: scope.split,
            status: scope.status, workflowUse: scope.workflowUse,
            observationCount: scope.observationCount, metricCount: scope.metricCount,
          });
        }
      }
    }
    return { entries, legacyConfirmedGroupIds };
  }
  /**
   * 作者确认（M13.5 双粒度）：
   * - groupIds（v1 兼容路径）：整组确认。组含多个实验范围时拒绝——
   *   「split 不一致」已不是冲突，但也不允许把多个评测范围当成一个结果
   *   集合一键确认（Dev25 / Confirmation13 / Full38 必须分别核对）。
   *   单范围组确认后该范围自动允许进入工作流（与 v1 行为一致）。
   * - scopeIds（v2 路径）：按范围确认（`groupId@slug`）。确认只声明
   *   「该范围观测记录真实、归属正确」；多范围组是否允许进入当前工作流
   *   是独立决策（setScopeWorkflowUse），不会因确认而隐式放行。
   */
  async confirm(projectId: string, packageId: string, groupIds: string[], scopeIds?: string[]): Promise<ExperimentPackage> {
    return this.enqueue(projectId, async () => {
      const item = await this.get(projectId, packageId);
      if (item.status !== "ready" && item.status !== "partial") throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", "实验包尚未完成解析");
      const checkSourcesAlive = async (paths: string[]): Promise<void> => {
        for (const path of paths) {
          const file = item.files.find((entry) => entry.path === path);
          if (!file || !file.sourceId || file.parseStatus === "failed") continue;
          const source = await this.sources.get(projectId, file.sourceId);
          if (!source || source.contentHash !== file.hash) throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${path} 来源已删除或变化`);
        }
      };
      for (const id of groupIds) {
        const group = item.groups.find((entry) => entry.id === id);
        if (!group) throw new BusinessError("INVALID_REQUEST", `不存在实验组 ${id}`);
        const scopeCount = group.splitScopes?.length ?? 0;
        if (scopeCount > 1) {
          throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `实验组 ${id} 包含 ${scopeCount} 个评测范围（${group.splitScopes!.map((scope) => scope.split).join(" / ")}），请按范围分别确认`);
        }
        await checkSourcesAlive(group.filePaths);
        if (group.conflicts.length) throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${id} 有未解决冲突`);
        if ((group.splitScopes ?? []).some((scope) => scope.conflicts.length > 0)) {
          throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${id} 存在范围内协议矛盾，需先解决（${group.splitScopes!.filter((scope) => scope.conflicts.length > 0).map((scope) => scope.id).join("、")}）`);
        }
        group.status = "confirmed"; group.confirmedAt ??= new Date().toISOString();
        // 单范围组：确认即允许进入工作流（沿用 v1「确认 = 可用于写作」语义；
        // 多范围组的隔离边界靠 scopeIds + setScopeWorkflowUse 显式表达）
        const only = group.splitScopes?.[0];
        if (only !== undefined && only.status !== "conflict") {
          only.status = "confirmed"; only.confirmedAt ??= new Date().toISOString();
          if (only.workflowUse === "undecided") { only.workflowUse = "allowed"; only.workflowUseDecidedAt = new Date().toISOString(); }
        }
      }
      for (const scopeId of scopeIds ?? []) {
        const parsed = parseScopeId(scopeId);
        const group = parsed === undefined ? undefined : item.groups.find((entry) => entry.id === parsed.groupId);
        const scope = group?.splitScopes?.find((entry) => entry.id === scopeId);
        if (group === undefined || scope === undefined) throw new BusinessError("INVALID_REQUEST", `不存在实验范围 ${scopeId}`);
        await checkSourcesAlive(scope.filePaths);
        if (scope.status === "conflict" || scope.conflicts.length > 0) throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${scopeId} 有未解决冲突（${scope.conflicts.join("；")}）`);
        if (group.conflicts.length > 0) throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${group.id} 有组级未解决冲突（${group.conflicts.join("；")}）`);
        scope.status = "confirmed"; scope.confirmedAt ??= new Date().toISOString();
        // 范围全部确认后组整体置 confirmed（图表等组级消费方沿用该信号）
        if ((group.splitScopes ?? []).every((entry) => entry.status === "confirmed")) {
          group.status = "confirmed"; group.confirmedAt ??= new Date().toISOString();
        }
      }
      await this.save(projectId, item);
      return item;
    });
  }

  /**
   * 范围级工作流授权（M13.5）：confirmed 范围是否允许进入当前论文工作流
   * 上下文（Researcher / 写作）。与「确认记录真实」是两个独立决策：
   * confirmation / held-out 范围即便确认真实，未经显式授权也不会被注入
   * 模型上下文。excluded 可随时改回 allowed（作者显式更改隔离边界）。
   */
  async setScopeWorkflowUse(projectId: string, packageId: string, scopeId: string, use: "allowed" | "excluded"): Promise<ExperimentPackage> {
    return this.enqueue(projectId, async () => {
      const item = await this.get(projectId, packageId);
      if (item.status !== "ready" && item.status !== "partial") throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", "实验包尚未完成解析");
      const parsed = parseScopeId(scopeId);
      const group = parsed === undefined ? undefined : item.groups.find((entry) => entry.id === parsed.groupId);
      const scope = group?.splitScopes?.find((entry) => entry.id === scopeId);
      if (group === undefined || scope === undefined) throw new BusinessError("INVALID_REQUEST", `不存在实验范围 ${scopeId}`);
      if (scope.status !== "confirmed") throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `范围 ${scopeId} 尚未确认；请先按范围确认再授权工作流使用`);
      scope.workflowUse = use; scope.workflowUseDecidedAt = new Date().toISOString();
      await this.save(projectId, item);
      return item;
    });
  }
  /**
   * M14.9.5.4：预先登记的实验论断复算计划（experiments/claim-checks.json；不在 ep- 包目录内，list() 不受影响）。
   * 文件缺失 = 未登记（null）；文件存在但不合法 = error（调用方如实呈现为 NOT_EVALUATED，不静默当作未登记）。
   */
  async loadClaimCheckPlan(projectId: string): Promise<{ plan: ClaimCheckPlan | null; error?: string }> {
    await this.projects.getRequired(projectId);
    let raw: string;
    try { raw = await readFile(join(this.root(projectId), CLAIM_CHECK_PLAN_FILE), "utf8"); }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return { plan: null }; throw error; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { plan: null, error: "claim-checks.json 不是合法 JSON" }; }
    const problems = validateClaimCheckPlan(parsed);
    return problems.length > 0 ? { plan: null, error: problems.slice(0, 5).join("；") } : { plan: parsed as ClaimCheckPlan };
  }

  /** 已导入实验包数量（只读目录，不解析 manifest） */
  async packageCount(projectId: string): Promise<number> {
    try { return (await readdir(this.root(projectId))).filter((id) => /^ep-[a-f0-9]{32}$/.test(id)).length; }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return 0; throw error; }
  }

  async saveClaimCheckPlan(projectId: string, plan: unknown): Promise<ClaimCheckPlan> {
    await this.projects.getRequired(projectId);
    const problems = validateClaimCheckPlan(plan);
    if (problems.length > 0) throw new BusinessError("INVALID_REQUEST", `复算计划不合法：${problems.slice(0, 8).join("；")}`);
    await mkdir(this.root(projectId), { recursive: true });
    await writeJsonAtomic(join(this.root(projectId), CLAIM_CHECK_PLAN_FILE), plan);
    return plan as ClaimCheckPlan;
  }

  /**
   * M14.9.5.4：按登记计划对给定稿件修订做确定性复算（只读：包 manifest 原样读取，Source 存活与解析产物哈希
   * 逐一核对；不调用模型，不修改任何产物）。
   */
  async evaluateClaimChecks(projectId: string, manuscript: ClaimCheckEnvironment["manuscript"]): Promise<{ ledger: ClaimCheckLedger; experimentPackages: number }> {
    const { plan, error } = await this.loadClaimCheckPlan(projectId);
    let ids: string[] = [];
    try { ids = (await readdir(this.root(projectId))).filter((id) => /^ep-[a-f0-9]{32}$/.test(id)); }
    catch (readError) { if ((readError as { code?: string }).code !== "ENOENT") throw readError; }
    const packages = [];
    // 未登记计划时不读取包 manifest（大包可达数百 MB）：只需要包数量
    if (plan !== null) for (const id of ids.sort()) packages.push(await this.readShared(projectId, id));
    const ledger = await evaluateClaimCheckPlan(plan, {
      packages,
      loadDocument: (sourceId) => this.documents.load(projectId, sourceId),
      sourceHash: async (sourceId) => (await this.sources.get(projectId, sourceId))?.contentHash ?? null,
      manuscript,
    }, error !== undefined ? { planError: error } : {});
    return { ledger, experimentPackages: ids.length };
  }

  async isConfirmedSource(projectId: string, sourceId: string): Promise<boolean> {
    const items = await this.list(projectId);
    const source = await this.sources.get(projectId, sourceId);
    if (!source) return false;
    return items.some((item) => item.groups.some((group) => group.status === "confirmed" && group.filePaths.some((path) => item.files.some((file) =>
      file.path === path && file.sourceId === sourceId && file.hash === source.contentHash &&
      ["main_result", "baseline_result", "ablation_result"].includes(file.role) &&
      (file.parseStatus === "ok" || file.parseStatus === "partial")
    ))));
  }

  /**
   * GLM 辅助语义理解（M13.3）：一次有界模型调用 → 确定性校验 → 存入
   * manifest（needs_author_confirmation）。不修改 files/groups/observations；
   * 作者仍通过 editFile / confirm 消费建议。模型不可用 / 输出不合法 →
   * 结构化失败，不伪装成功。
   */
  async understand(projectId: string, packageId: string): Promise<ExperimentPackage> {
    return this.enqueue(projectId, async () => {
      const item = await this.get(projectId, packageId);
      if (item.status !== "ready" && item.status !== "partial") throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", "实验包尚未完成解析");
      const semantic = this.semanticModel;
      if (semantic === undefined) throw new BusinessError("SEMANTIC_MODEL_UNAVAILABLE", "语义理解模型未装配（模型未配置或服务未启用）");
      const spec = (await semantic.defaultModel())?.trim();
      const separator = spec?.indexOf("/") ?? -1;
      if (!spec || separator <= 0 || separator >= spec.length - 1) throw new BusinessError("SEMANTIC_MODEL_UNAVAILABLE", "生效默认模型规格非法，无法执行语义理解");
      const provider = spec.slice(0, separator);
      const modelId = spec.slice(separator + 1);
      const model = semantic.runtime.getModel(provider, modelId);
      if (model === undefined) throw new BusinessError("SEMANTIC_MODEL_UNAVAILABLE", `模型 ${spec} 不在注册表`);
      if (!semantic.runtime.hasConfiguredAuth(provider)) throw new BusinessError("SEMANTIC_MODEL_UNAVAILABLE", `provider ${provider} 无可用凭据`);
      const context = buildUnderstandingContext(item);
      const signal = AbortSignal.timeout(SEMANTIC_LIMITS.requestTimeoutMs);
      const startedAt = Date.now();
      // GLM-5.3 类不支持 off 的模型必须显式给最低 thinking 档位（否则 400 code 1210）
      const reasoning = minimumReasoningLevel(model);
      const message = await semantic.runtime.completeSimple(model, {
        systemPrompt: UNDERSTANDING_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: context }], timestamp: Date.now() }],
      }, { maxTokens: SEMANTIC_LIMITS.maxOutputTokens, ...(reasoning !== undefined ? { reasoning } : {}), signal });
      const durationMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new BusinessError("SEMANTIC_MODEL_FAILED", `语义理解模型调用失败（${signal.aborted ? "超时" : message.errorMessage ?? message.stopReason}）`);
      }
      const text = (message.content ?? []).map((part) => part.type === "text" ? part.text ?? "" : "").join("");
      let parsed: Record<string, unknown>;
      try {
        parsed = parseUnderstandingOutput(text);
      } catch (error) {
        throw new BusinessError("SEMANTIC_MODEL_FAILED", `语义理解输出不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
      }
      const { suggestions, notes } = validateSuggestions(parsed, item);
      item.semanticSuggestions = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        model: spec,
        durationMs,
        ...(message.usage !== undefined ? { usage: message.usage } : {}),
        roleSuggestions: suggestions.roleSuggestions,
        findings: suggestions.findings,
        notes,
      };
      await this.save(projectId, item);
      return item;
    });
  }

  /**
   * 指标浏览查询（M13.5 UI 支撑；只读）：按 split / 实验组 / method /
   * metric / 来源路径过滤 + 分页。展示真实观测（不选优、不聚合）；
   * 每条保留完整来源锚。facet 数量有界（码位序前 N）。
   */
  async queryObservations(
    projectId: string,
    packageId: string,
    filters: { split?: string; groupId?: string; method?: string; metric?: string; path?: string; page?: number; pageSize?: number },
  ): Promise<{
    total: number;
    page: number;
    pageSize: number;
    observations: MetricObservation[];
    facets: { splits: string[]; groupIds: string[]; methods: string[]; metrics: string[]; paths: string[] };
  }> {
    await this.projects.getRequired(projectId);
    const item = await this.readShared(projectId, packageId);
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
    const normalized = (value: string | undefined) => value?.trim().toLowerCase() || undefined;
    const wantSplit = normalized(filters.split);
    const wantGroup = normalized(filters.groupId);
    const wantMethod = normalized(filters.method);
    const wantMetric = normalized(filters.metric);
    const wantPath = normalized(filters.path);
    const filtered = item.observations.filter((observation) =>
      (wantSplit === undefined || observationScopeKey(observation).toLowerCase() === wantSplit) &&
      (wantGroup === undefined || observation.groupId.toLowerCase() === wantGroup) &&
      (wantMethod === undefined || (observation.method ?? "").toLowerCase().includes(wantMethod)) &&
      (wantMetric === undefined || observation.metric.toLowerCase().includes(wantMetric)) &&
      (wantPath === undefined || observation.path.toLowerCase().includes(wantPath)));
    const sorted = [...filtered].sort(compareObservationAnchors);
    const start = (page - 1) * pageSize;
    const facet = (values: string[], limit: number) => [...new Set(values)].sort(compareCodepoints).slice(0, limit);
    return {
      total: sorted.length,
      page,
      pageSize,
      observations: sorted.slice(start, start + pageSize),
      facets: {
        splits: facet(item.observations.map(observationScopeKey), 50),
        groupIds: facet(item.observations.map((observation) => observation.groupId), 50),
        methods: facet(item.observations.map((observation) => observation.method ?? "").filter((value) => value !== ""), 100),
        metrics: facet(item.observations.map((observation) => observation.metric), 200),
        paths: facet(item.observations.map((observation) => observation.path), 200),
      },
    };
  }

  async workflowContext(projectId: string, options: { anchorText?: string } = {}): Promise<ConfirmedExperimentWorkflowContext> {
    const snapshotState = await this.activeSnapshotState(projectId);
    const candidates = await this.eligibleWorkflowCandidates(projectId, snapshotState);
    const selected = selectWorkflowObservations(candidates, options.anchorText !== undefined ? { anchorNumbers: manuscriptNumberAnchors(options.anchorText) } : {});
    return {
      schemaVersion: 1,
      status: "author_confirmed_not_externally_verified",
      ...(snapshotState !== null ? { snapshot: snapshotRef(snapshotState), comparisons: snapshotState.status === "valid" ? workflowComparisons(snapshotState.snapshot) : [] } : {}),
      // truncated 只反映总量限制（有合格观测因预算未被选中）；未确认/不合格
      // 观测不进入候选，也不计入截断判断
      truncated: selected.length < candidates.length,
      observations: selected.map(({ packageId, packageHash, observation }) => ({
        packageId,
        packageHash,
        groupId: observation.groupId,
        sourceId: observation.sourceId,
        blockId: observation.blockId,
        path: safeContextLabel(observation.path) ?? "[path omitted]",
        metric: safeContextLabel(observation.metric) ?? "[metric label omitted]",
        value: observation.value,
        unit: observation.unit,
        direction: observation.direction,
        ...(observation.row !== undefined ? { row: observation.row } : {}),
        ...(observation.sheet !== undefined ? { sheet: safeContextLabel(observation.sheet) } : {}),
        ...(observation.column !== undefined ? { column: safeContextLabel(observation.column) } : {}),
        ...(observation.jsonPath !== undefined ? { jsonPath: safeContextLabel(observation.jsonPath) } : {}),
        ...(safeContextLabel(observation.method) !== undefined ? { method: safeContextLabel(observation.method) } : {}),
        ...(safeContextLabel(observation.dataset) !== undefined ? { dataset: safeContextLabel(observation.dataset) } : {}),
        ...(safeContextLabel(observation.seed) !== undefined ? { seed: safeContextLabel(observation.seed) } : {}),
        ...(safeContextLabel(observation.protocol) !== undefined ? { protocol: safeContextLabel(observation.protocol) } : {}),
        ...(safeContextLabel(observation.split) !== undefined ? { split: safeContextLabel(observation.split) } : {}),
      })),
    };
  }

  /**
   * M14.8-MOT：稿件数值命中的**全部**授权观测（不受 100 条上下文预算限制）。
   * 只供确定性消费（review.run 的作者实验数据披露）——不进入任何模型 prompt；
   * 资格边界与 workflowContext 完全相同（确认 + 授权范围 + 结果角色文件）。
   */
  async manuscriptMatchedObservations(projectId: string, anchorText: string): Promise<MetricObservation[]> {
    const anchors = manuscriptNumberAnchors(anchorText);
    if (anchors.size === 0) return [];
    return (await this.eligibleWorkflowCandidates(projectId, await this.activeSnapshotState(projectId)))
      .filter((candidate) => anchoredTokens(candidate.observation.value, anchors).length > 0)
      .map((candidate) => candidate.observation);
  }

  /**
   * M17.2 单点切换：存在冻结快照时，工作流（Researcher / Outline / Writer / Revision / Reviewer 披露）只读快照事实；
   * 快照失效（源变化 / 授权撤回 / metadata 变化）→ 空（不悄悄回落到实时数据，作者须重新冻结）。无快照 = 原实时口径。
   */
  private async eligibleWorkflowCandidates(projectId: string, snapshotState: ActiveSnapshotState | null): Promise<WorkflowObservationCandidate[]> {
    if (snapshotState === null) return this.liveEligibleCandidates(projectId);
    if (snapshotState.status === "stale") return [];
    return snapshotState.snapshot.facts.map((fact) => ({ packageId: fact.packageId, packageHash: fact.packageHash, observation: fact }));
  }

  private async liveEligibleCandidates(projectId: string): Promise<WorkflowObservationCandidate[]> {
    const items = await this.list(projectId);
    // 资格边界与原先一致：作者确认组内的结果角色文件 + 存活 Source + ok/partial
    // 解析状态（JSONL 特征流在指标提取层就不产生观测）。合格观测先全量收集，
    // 再交给确定性代表性选择——不再按登记顺序截断（M13.3.1）。
    // M13.5 范围门禁：组带 splitScopes（schema v2）时，观测还必须落在
    // 「已确认 且 workflowUse=allowed」的范围内——confirmation / held-out
    // 范围未经作者显式授权不得进入 Researcher 上下文。单范围组在整组确认
    // 时已自动 allowed（与 v1 行为一致）；v1 旧包（无 scopes）整组沿用
    // 确认即进入的旧语义，不受影响。
    const candidates: WorkflowObservationCandidate[] = [];
    for (const item of items) {
      for (const group of item.groups) {
        const scopes = group.splitScopes;
        // v1 旧包（无 scopes）：整组确认即进入（既有语义，不因升级失效）
        // v2：范围级资格——scope confirmed + workflowUse=allowed 的观测进入；
        // 组级状态不参与（作者可以只确认/只授权部分范围，其余范围永不进入）
        const groupEligible = scopes === undefined ? group.status === "confirmed" : undefined;
        const allowedSplits = scopes !== undefined
          ? new Set(scopes.filter((scope) => scope.status === "confirmed" && scope.workflowUse === "allowed").map((scope) => scope.split))
          : undefined;
        if (groupEligible === false || allowedSplits?.size === 0) continue;
        const allowedFiles = new Set(item.files
          .filter((file) => file.groupId === group.id &&
            ["main_result", "baseline_result", "ablation_result"].includes(file.role) &&
            file.sourceId !== undefined && ["ok", "partial"].includes(file.parseStatus))
          .map((file) => `${group.id}\0${file.path}\0${file.sourceId}`));
        for (const observation of item.observations) {
          if (observation.groupId !== group.id) continue;
          if (!allowedFiles.has(`${observation.groupId}\0${observation.path}\0${observation.sourceId}`)) continue;
          if (allowedSplits !== undefined && !allowedSplits.has(observationScopeKey(observation))) continue;
          candidates.push({ packageId: item.packageId, packageHash: item.packageHash, observation });
        }
      }
    }
    return candidates;
  }

  // ---------------------------------------------------------------------------
  // M17.2 实验事实快照（预览 / 作者排除 / 冻结 / 失效）
  // ---------------------------------------------------------------------------

  private snapshotsDir(projectId: string): string { return join(this.root(projectId), "snapshots"); }

  /** 快照输入：当前「已确认 + 已授权」范围内的结果角色文件观测（与 workflowContext 实时口径同一资格边界） */
  private async snapshotInputs(projectId: string): Promise<SnapshotInputObservation[]> {
    const items = await this.list(projectId);
    const inputs: SnapshotInputObservation[] = [];
    const byPackage = new Map(items.map((item) => [item.packageId, item]));
    for (const candidate of await this.liveEligibleCandidates(projectId)) {
      const item = byPackage.get(candidate.packageId)!;
      const observation = candidate.observation;
      const file = item.files.find((entry) => entry.path === observation.path && entry.sourceId === observation.sourceId);
      const group = item.groups.find((entry) => entry.id === observation.groupId);
      if (file === undefined || group === undefined) continue;
      const scope = group.splitScopes?.find((entry) => entry.split === observationScopeKey(observation));
      inputs.push({
        ...observation,
        packageId: item.packageId, packageHash: item.packageHash, fileHash: file.hash,
        groupRole: group.role, scopeId: scope?.id ?? group.id,
        ...(scope?.confirmedAt ?? group.confirmedAt ? { confirmedAt: scope?.confirmedAt ?? group.confirmedAt } : {}),
      });
    }
    return inputs;
  }

  private async readFactDecisions(projectId: string): Promise<FactDecisionFile> {
    try {
      const parsed = JSON.parse(await readFile(join(this.snapshotsDir(projectId), "decisions.json"), "utf8")) as FactDecisionFile;
      if (parsed.schema !== FACT_DECISIONS_SCHEMA || typeof parsed.excluded !== "object" || !Array.isArray(parsed.log)) throw new BusinessError("EXPERIMENT_MANIFEST_CORRUPTED", "实验事实决定文件损坏");
      return parsed;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { schema: FACT_DECISIONS_SCHEMA, excluded: {}, log: [] };
      if (error instanceof BusinessError) throw error;
      throw new BusinessError("EXPERIMENT_MANIFEST_CORRUPTED", "实验事实决定文件损坏");
    }
  }

  /** 预览（不落盘）：快照内容 + 冲突 + 对比 + 不可比 + 是否可冻结 */
  async previewSnapshot(projectId: string): Promise<FactSnapshotBuild & { freezable: boolean; blockingReasons: string[] }> {
    await this.projects.getRequired(projectId);
    const decisions = await this.readFactDecisions(projectId);
    const build = buildFactSnapshotContent(await this.snapshotInputs(projectId), new Map(Object.entries(decisions.excluded).map(([id, entry]) => [id, entry.reason])));
    const blockingReasons = [
      ...(build.facts.length === 0 ? ["没有可冻结的事实（需先确认并授权至少一个实验范围）"] : []),
      ...build.conflicts.map((conflict) => `${conflict.code}：${conflict.detail}`),
    ];
    return { ...build, freezable: blockingReasons.length === 0, blockingReasons };
  }

  /**
   * 作者排除 / 恢复事实（append-only 决定日志；原始文件与观测不变）。排除冲突的一方 = 选择另一方。
   * 只接受当前输入中存在的 factId（防止为不存在的事实写决定）。
   */
  async decideFacts(projectId: string, decision: { exclude?: string[]; include?: string[]; reason?: string }): Promise<FactDecisionFile> {
    return this.enqueue(projectId, async () => {
      await this.projects.getRequired(projectId);
      const known = new Set((await this.snapshotInputs(projectId)).map(factIdOf));
      const decisions = await this.readFactDecisions(projectId);
      const reason = (decision.reason ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) || "作者排除";
      const at = new Date().toISOString();
      const exclude = decision.exclude ?? [];
      const include = decision.include ?? [];
      if (exclude.length + include.length === 0 || exclude.length + include.length > 5000) throw new BusinessError("INVALID_REQUEST", "需要 1–5000 个 factId");
      for (const factId of [...exclude, ...include]) {
        if (typeof factId !== "string" || !/^f-[a-f0-9]{16}$/.test(factId)) throw new BusinessError("INVALID_REQUEST", "非法 factId");
      }
      for (const factId of exclude) {
        if (!known.has(factId)) throw new BusinessError("INVALID_REQUEST", `事实 ${factId} 不在当前已确认范围内`);
        decisions.excluded[factId] = { reason, at };
        decisions.log.push({ action: "exclude", factId, reason, at, actor: "author" });
      }
      for (const factId of include) {
        if (decisions.excluded[factId] === undefined) continue;
        delete decisions.excluded[factId];
        decisions.log.push({ action: "include", factId, reason, at, actor: "author" });
      }
      await mkdir(this.snapshotsDir(projectId), { recursive: true });
      await writeJsonAtomic(join(this.snapshotsDir(projectId), "decisions.json"), decisions);
      return decisions;
    });
  }

  /** 冻结：无阻断冲突且至少一条事实 → 新版本快照（不可变文件）并设为当前；冲突未裁决 → 409 */
  async freezeSnapshot(projectId: string, note?: string): Promise<FactSnapshot> {
    return this.enqueue(projectId, async () => {
      const preview = await this.previewSnapshot(projectId);
      if (preview.facts.length === 0) throw new BusinessError("EXPERIMENT_SNAPSHOT_EMPTY", "没有可冻结的实验事实：请先确认并授权至少一个实验范围");
      if (preview.conflicts.length > 0) {
        throw new BusinessError("EXPERIMENT_FACT_CONFLICT", `存在 ${preview.conflicts.length} 处未裁决的实验事实冲突，不能冻结：${preview.conflicts.slice(0, 3).map((conflict) => conflict.code).join("、")}`);
      }
      const { freezable: _freezable, blockingReasons: _blocking, ...build } = preview;
      const existing = await this.listSnapshotIds(projectId);
      const version = existing.length + 1;
      const snapshot: FactSnapshot = {
        schema: FACT_SNAPSHOT_SCHEMA,
        snapshotId: `efs-${String(version).padStart(4, "0")}`,
        version,
        createdAt: new Date().toISOString(),
        createdBy: "author",
        basedOn: [...new Map(build.facts.map((fact) => [fact.packageId, { packageId: fact.packageId, packageHash: fact.packageHash }])).values()],
        contentHash: snapshotContentHash(build),
        ...(note !== undefined && note.trim() !== "" ? { note: note.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300) } : {}),
        ...build,
      };
      await mkdir(this.snapshotsDir(projectId), { recursive: true });
      await writeJsonAtomic(join(this.snapshotsDir(projectId), `${snapshot.snapshotId}.json`), snapshot);
      await writeJsonAtomic(join(this.snapshotsDir(projectId), "active.json"), { snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash, activatedAt: snapshot.createdAt });
      return snapshot;
    });
  }

  private async listSnapshotIds(projectId: string): Promise<string[]> {
    try { return (await readdir(this.snapshotsDir(projectId))).filter((name) => /^efs-\d{4}\.json$/.test(name)).map((name) => name.slice(0, -5)).sort(); }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return []; throw error; }
  }

  async getSnapshot(projectId: string, snapshotId: string): Promise<FactSnapshot> {
    await this.projects.getRequired(projectId);
    if (!/^efs-\d{4}$/.test(snapshotId)) throw new NotFoundError("实验事实快照", snapshotId);
    try {
      const snapshot = JSON.parse(await readFile(join(this.snapshotsDir(projectId), `${snapshotId}.json`), "utf8")) as FactSnapshot;
      if (snapshot.schema !== FACT_SNAPSHOT_SCHEMA || snapshotContentHash(snapshot) !== snapshot.contentHash) throw new BusinessError("EXPERIMENT_MANIFEST_CORRUPTED", `实验事实快照 ${snapshotId} 内容与哈希不符（文件被改动或损坏）`);
      return snapshot;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") throw new NotFoundError("实验事实快照", snapshotId);
      throw error;
    }
  }

  async listSnapshots(projectId: string): Promise<Array<Pick<FactSnapshot, "snapshotId" | "version" | "createdAt" | "contentHash"> & { factCount: number; comparisonCount: number; active: boolean }>> {
    const active = await this.readActivePointer(projectId);
    const result = [];
    for (const id of await this.listSnapshotIds(projectId)) {
      const snapshot = await this.getSnapshot(projectId, id);
      result.push({ snapshotId: snapshot.snapshotId, version: snapshot.version, createdAt: snapshot.createdAt, contentHash: snapshot.contentHash, factCount: snapshot.facts.length, comparisonCount: snapshot.comparisons.length, active: active?.snapshotId === id });
    }
    return result.reverse();
  }

  private async readActivePointer(projectId: string): Promise<{ snapshotId: string; contentHash: string } | null> {
    try {
      const pointer = JSON.parse(await readFile(join(this.snapshotsDir(projectId), "active.json"), "utf8")) as { snapshotId?: unknown; contentHash?: unknown };
      return typeof pointer.snapshotId === "string" && typeof pointer.contentHash === "string" ? { snapshotId: pointer.snapshotId, contentHash: pointer.contentHash } : null;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * 当前快照 + 有效性：快照中每条事实必须仍在「已确认 + 已授权」范围内、源文件哈希不变、metadata / 单位 / 值不变；
   * 否则 stale（列出原因）。fail-closed：快照文件损坏 / 指针哈希不符同样 stale，不回落到实时数据。
   */
  async activeSnapshotState(projectId: string): Promise<ActiveSnapshotState | null> {
    const pointer = await this.readActivePointer(projectId);
    if (pointer === null) return null;
    let snapshot: FactSnapshot;
    try {
      snapshot = await this.getSnapshot(projectId, pointer.snapshotId);
    } catch (error) {
      return { status: "stale", snapshot: emptySnapshot(pointer.snapshotId), staleReasons: [`快照文件不可用：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`] };
    }
    if (snapshot.contentHash !== pointer.contentHash) return { status: "stale", snapshot, staleReasons: ["当前快照指针与快照内容哈希不符"] };
    const signature = (fact: SnapshotInputObservation) => JSON.stringify([fact.fileHash, fact.value, fact.unit, fact.method ?? "", fact.dataset ?? "", fact.split ?? "", fact.protocol ?? "", fact.seed ?? "", fact.subset ?? "", fact.version ?? "", fact.groupRole]);
    const live = new Map((await this.snapshotInputs(projectId)).map((input) => [factIdOf(input), signature(input)]));
    const reasons: string[] = [];
    const missing = snapshot.facts.filter((fact) => !live.has(fact.factId));
    const changed = snapshot.facts.filter((fact) => live.has(fact.factId) && live.get(fact.factId) !== signature(fact));
    if (missing.length > 0) reasons.push(`${missing.length} 条快照事实已不在已确认 + 已授权范围内（范围撤回 / 重新整理分组 / 来源删除），例 ${missing[0]!.sourceLocator}`);
    if (changed.length > 0) reasons.push(`${changed.length} 条快照事实的来源哈希、取值、单位或 metadata 已变化，例 ${changed[0]!.sourceLocator}`);
    for (const sourceId of [...new Set(snapshot.facts.map((fact) => fact.sourceId))]) {
      const fact = snapshot.facts.find((entry) => entry.sourceId === sourceId)!;
      const source = await this.sources.get(projectId, sourceId);
      if (source === null || source === undefined || source.contentHash !== fact.fileHash) reasons.push(`源文件 ${fact.path}（sha256 ${fact.fileHash.slice(0, 12)}）已删除或内容变化`);
    }
    return reasons.length > 0 ? { status: "stale", snapshot, staleReasons: reasons } : { status: "valid", snapshot };
  }

}

const FACT_DECISIONS_SCHEMA = "paperteam.experiment-fact-decisions/v1";
export interface FactDecisionFile {
  schema: typeof FACT_DECISIONS_SCHEMA;
  excluded: Record<string, { reason: string; at: string }>;
  log: Array<{ action: "exclude" | "include"; factId: string; reason: string; at: string; actor: "author" }>;
}

export type ActiveSnapshotState =
  | { status: "valid"; snapshot: FactSnapshot }
  | { status: "stale"; snapshot: FactSnapshot; staleReasons: string[] };

function emptySnapshot(snapshotId: string): FactSnapshot {
  return {
    schema: FACT_SNAPSHOT_SCHEMA, snapshotId, version: 0, createdAt: "", createdBy: "author", basedOn: [], contentHash: "",
    facts: [], excluded: [], conflicts: [], comparisons: [], notComparable: [], seedAggregates: [], statisticalTests: [], limitations: [],
  };
}

function snapshotRef(state: ActiveSnapshotState): WorkflowSnapshotRef {
  return {
    snapshotId: state.snapshot.snapshotId, version: state.snapshot.version, contentHash: state.snapshot.contentHash, createdAt: state.snapshot.createdAt,
    status: state.status, ...(state.status === "stale" ? { staleReasons: state.staleReasons } : {}),
    factCount: state.snapshot.facts.length, comparisonCount: state.snapshot.comparisons.length,
  };
}

const MAX_WORKFLOW_COMPARISONS = 60;

function canonicalOf(snapshot: FactSnapshot, factId: string, value: number): number {
  const fact = snapshot.facts.find((entry) => entry.factId === factId);
  return fact !== undefined ? toCanonical(fact.value, fact.unit)?.value ?? value : value;
}

/**
 * 写作上下文的对比选择（确定性）：整体结果（无子集）优先；主指标（非 TrackEval 逐阈值分量 *___<α>）优先；
 * 方向已知优先；对基线优先于消融；按指标 / 方法码位序
 */
export function workflowComparisons(snapshot: FactSnapshot): WorkflowComparison[] {
  const rank = (comparison: FactComparison) => [
    comparison.context.subset === "" || /^(combined|all|overall|total|pooled)$/i.test(comparison.context.subset) ? 0 : 1,
    /___\d+$/.test(comparison.context.metricKey) ? 1 : 0,
    comparison.direction === "unknown" ? 1 : 0,
    comparison.kind === "vs_baseline" ? 0 : 1,
  ];
  const ordered = [...snapshot.comparisons].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    const ka = [a.context.dataset, a.context.metricKey, a.subject.method, a.reference.method].join("\u0000");
    const kb = [b.context.dataset, b.context.metricKey, b.subject.method, b.reference.method].join("\u0000");
    return compareCodepoints(ka, kb);
  });
  // 类别配额：消融对主方法至少 16 条、其余给对基线，任一类不足时余量给另一类（消融结论同样需要可引用的确定性差值）
  const vsBaseline = ordered.filter((comparison) => comparison.kind === "vs_baseline");
  const ablation = ordered.filter((comparison) => comparison.kind === "ablation_vs_main");
  const ablationTake = Math.min(ablation.length, Math.max(16, MAX_WORKFLOW_COMPARISONS - vsBaseline.length));
  const chosen = new Set([...ablation.slice(0, ablationTake), ...vsBaseline.slice(0, MAX_WORKFLOW_COMPARISONS - ablationTake)]);
  return ordered
    .filter((comparison) => chosen.has(comparison))
    .map((comparison) => ({
      comparisonId: comparison.comparisonId,
      dataset: safeContextLabel(comparison.context.dataset) ?? "[omitted]",
      split: safeContextLabel(comparison.context.split) ?? "",
      protocol: safeContextLabel(comparison.context.protocol) ?? "[omitted]",
      subset: safeContextLabel(comparison.context.subset) ?? "",
      metric: comparison.context.metricKey,
      kind: comparison.kind,
      canonicalUnit: comparison.canonicalUnit,
      subject: { method: safeContextLabel(comparison.subject.method) ?? "[omitted]", role: comparison.subject.role, value: comparison.subject.value, canonicalValue: canonicalOf(snapshot, comparison.subject.factId, comparison.subject.value), factId: comparison.subject.factId },
      reference: { method: safeContextLabel(comparison.reference.method) ?? "[omitted]", role: comparison.reference.role, value: comparison.reference.value, canonicalValue: canonicalOf(snapshot, comparison.reference.factId, comparison.reference.value), factId: comparison.reference.factId },
      absoluteDifference: formatDerived(comparison.absoluteDifference),
      relativeChange: comparison.relativeChange !== null ? formatDerived(comparison.relativeChange) : null,
      outcome: comparison.outcome,
      limitations: comparison.limitations,
    }));
}
