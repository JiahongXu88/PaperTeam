import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
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
}
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
  metric: string;
  value: number;
  unit: "percentage" | "unknown";
  direction: "higher" | "lower" | "unknown";
  groupId: string;
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

export interface ConfirmedExperimentWorkflowContext {
  schemaVersion: 1;
  status: "author_confirmed_not_externally_verified";
  truncated: boolean;
  observations: Array<{
    packageId: string;
    packageHash: string;
    groupId: string;
    sourceId: string;
    blockId: string;
    path: string;
    metric: string;
    value: number;
    unit: "percentage" | "unknown";
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
const CONTEXT_COLUMNS = /^(method|model|dataset|seed|split|epoch|run|variant|protocol|step|iteration|fold|id)$/i;
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

/** 指标名 → 标准方向（词表未收录返回 unknown——不猜）。leaf = 路径最后一段 */
function directionOf(metric: string): "higher" | "lower" | "unknown" {
  const leaf = metric.split(/[./]/).pop() ?? metric;
  return METRIC_DIRECTION.get(leaf.toUpperCase()) ?? "unknown";
}

function metricObservations(file: PackageFile, document: ParsedDocument): MetricObservation[] {
  if (!["main_result", "baseline_result", "ablation_result"].includes(file.role)) return [];
  // JSONL 行流是逐事件/逐机会的特征记录（score、cosine、frame…），不是
  // 实验级指标表：即便作者把它标成结果角色，也不提取指标观测——它的
  // 首要用途是图表数据集（见 figures/datasets.ts），进 context 会以
  // 数千条特征值淹没真正的实验指标。
  if (document.parser.id === "jsonl") return [];
  const observations: MetricObservation[] = [];
  for (const block of document.blocks) {
    if (block.type === "structured_record") {
      const record = block as ParsedRecordBlock;
      const context = new Map(record.cells.map((cell) => [cell.header.toLowerCase(), cell.value]));
      for (const cell of record.cells) {
        if (CONTEXT_COLUMNS.test(cell.header) || SECRET_PATTERN.test(cell.header)) continue;
        const numeric = cell.value.trim();
        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric)) continue;
        const value = Number(numeric);
        if (!Number.isFinite(value) || observations.length >= 5000) continue;
        const metric = cell.header.startsWith("$.") ? cell.header.replace(/^\$\./, "") : cell.header;
        observations.push({
          sourceId: file.sourceId!, path: file.path, blockId: block.blockId,
          ...(block.provenance.row !== undefined ? { row: block.provenance.row } : {}),
          ...(block.provenance.sheet !== undefined ? { sheet: block.provenance.sheet } : {}),
          ...(cell.letter !== undefined ? { column: cell.letter } : {}),
          ...(block.provenance.jsonPath !== undefined ? { jsonPath: block.provenance.jsonPath } : {}),
          ...(context.get("method") ?? context.get("model") ? { method: context.get("method") ?? context.get("model") } : {}),
          ...(context.get("dataset") ? { dataset: context.get("dataset") } : {}),
          ...(context.get("seed") ? { seed: context.get("seed") } : {}),
          ...(context.get("protocol") ? { protocol: context.get("protocol") } : {}),
          ...(context.get("split") ? { split: context.get("split") } : {}),
          metric, value, unit: "unknown", direction: directionOf(metric), groupId: file.groupId,
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
        for (let index = 0; index < table.headers.length; index += 1) {
          const header = table.headers[index]!;
          if (CONTEXT_COLUMNS.test(header) || SECRET_PATTERN.test(header)) continue;
          const numeric = (row[index] ?? "").trim();
          if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric)) continue;
          const value = Number(numeric);
          if (!Number.isFinite(value) || observations.length >= 5000) continue;
          observations.push({
            sourceId: file.sourceId!, path: file.path, blockId: block.blockId,
            row: baseRow + 1 + rowIndex,
            column: header,
            ...(table.provenance.sheet !== undefined ? { sheet: table.provenance.sheet } : {}),
            ...(context.get("method") ?? context.get("model") ? { method: context.get("method") ?? context.get("model") } : {}),
            ...(context.get("dataset") ? { dataset: context.get("dataset") } : {}),
            ...(context.get("seed") ? { seed: context.get("seed") } : {}),
            ...(context.get("protocol") ? { protocol: context.get("protocol") } : {}),
            ...(context.get("split") ? { split: context.get("split") } : {}),
            metric: header, value, unit: "unknown", direction: directionOf(header), groupId: file.groupId,
          });
        }
      });
    }
  }
  return observations;
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
export function selectWorkflowObservations(candidates: WorkflowObservationCandidate[]): WorkflowObservationCandidate[] {
  if (candidates.length === 0) return [];
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
  const selected: WorkflowObservationCandidate[] = [];
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

export class ExperimentPackageService {
  private readonly queues = new Map<string, Promise<unknown>>();
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
    const item = await this.get(projectId, packageId);
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
          item.observations.push(...metricObservations(file, document));
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
    const item = await this.get(projectId, packageId);
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

  async workflowContext(projectId: string): Promise<ConfirmedExperimentWorkflowContext> {
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
    const selected = selectWorkflowObservations(candidates);
    return {
      schemaVersion: 1,
      status: "author_confirmed_not_externally_verified",
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
}
