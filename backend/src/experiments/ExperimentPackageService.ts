import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { BusinessError, NotFoundError } from "../errors.js";
import { assetKindOfFileName } from "../ingestion/parserRegistry.js";
import type { IngestionService } from "../ingestion/IngestionService.js";
import type { ParsedDocumentStore } from "../ingestion/ParsedDocumentStore.js";
import type { ParsedDocument, ParsedRecordBlock } from "../ingestion/types.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { SourceStore } from "../sources/SourceStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { sha256Hex } from "../util/hash.js";
import { hashArchive, sourceNameFor, visitArchive, type ArchiveEntryInfo } from "./archive.js";

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
}
export interface ExperimentRelationCandidate {
  configPath: string;
  groupId: string;
  status: "candidate" | "conflict";
  basis: string;
  matchedFields: string[];
  conflictingFields: string[];
}
export interface ExperimentPackage {
  schemaVersion: 1;
  packageId: string;
  packageHash: string;
  originalName: string;
  importedAt: string;
  status: "inventory" | "importing" | "ready" | "partial";
  files: PackageFile[];
  groups: ExperimentGroup[];
  observations: MetricObservation[];
  relationCandidates: ExperimentRelationCandidate[];
  warnings: string[];
}

const RESULT_EXTENSIONS = new Set([".csv", ".xlsx", ".json", ".yaml", ".yml"]);
const SOURCE_EXTENSIONS = new Set([".csv", ".xlsx", ".json", ".yaml", ".yml", ".md", ".txt", ".ipynb"]);
const SECRET_PATTERN = /(api.?key|secret|password|token|credential|authorization)/i;
const CONTEXT_COLUMNS = /^(method|model|dataset|seed|split|epoch|run|variant|protocol|step|iteration|fold|id)$/i;

function classify(path: string): Pick<PackageFile, "role" | "roleBasis" | "roleConfidence" | "groupId"> {
  const lower = path.toLowerCase();
  const file = basename(lower);
  const ext = extname(file);
  const tokens = lower.split(/[\/_.\-\s]+/).filter(Boolean);
  let role: ExperimentRole = "unknown";
  let basis = "缺少可判定的文件名或路径线索";
  if (ext === ".ipynb") { role = "notebook"; basis = "Notebook 扩展名"; }
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

function metricObservations(file: PackageFile, document: ParsedDocument): MetricObservation[] {
  if (!["main_result", "baseline_result", "ablation_result"].includes(file.role)) return [];
  const observations: MetricObservation[] = [];
  for (const block of document.blocks) {
    if (block.type !== "structured_record") continue;
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
        metric, value, unit: "unknown", direction: "unknown", groupId: file.groupId,
      });
    }
  }
  return observations;
}

export class ExperimentPackageService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly projects: ProjectStore, private readonly sources: SourceStore, private readonly ingestion: IngestionService, private readonly documents: ParsedDocumentStore) {}

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
      if (item.schemaVersion !== 1 || item.packageId !== packageId || !Array.isArray(item.files) || !Array.isArray(item.groups) || !Array.isArray(item.observations)) throw new Error();
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
      let item: ExperimentPackage;
      try { item = await this.get(projectId, packageId); if (item.status === "ready" || item.status === "partial") return { item, created: false }; }
      catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        const displayName = originalName.replaceAll("\\", "/").split("/").pop()?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "experiment.zip";
        item = { schemaVersion: 1, packageId, packageHash: hash, originalName: displayName, importedAt: new Date().toISOString(), status: "inventory", files: inventory.map((entry) => ({ path: entry.path, hash: "", bytes: entry.size, compressedBytes: entry.compressedSize, kind: assetKindOfFileName(entry.path), parseStatus: "pending", ...classify(entry.path) })), groups: [], observations: [], relationCandidates: [], warnings: [] };
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
        if (document) item.observations.push(...metricObservations(file, document));
      }
    }
    for (const group of groups.values()) if (group.conflicts.length) group.status = "conflict";
    for (const group of groups.values()) {
      for (const field of ["protocol", "split"] as const) {
        const values = new Set(item.observations.filter((observation) => observation.groupId === group.id).map((observation) => observation[field]).filter((value): value is string => !!value));
        if (values.size > 1) group.conflicts.push(`${field} 不一致：${[...values].join(" / ")}`);
      }
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
        const comparisons: Array<[string, string | undefined]> = [["model", observation.method], ["method", observation.method], ["dataset", observation.dataset], ["seed", observation.seed], ["protocol", observation.protocol], ["split", observation.split]];
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
  async confirm(projectId: string, packageId: string, groupIds: string[]): Promise<ExperimentPackage> {
    return this.enqueue(projectId, async () => {
      const item = await this.get(projectId, packageId);
      if (item.status !== "ready" && item.status !== "partial") throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", "实验包尚未完成解析");
      for (const id of groupIds) {
        const group = item.groups.find((entry) => entry.id === id);
        if (!group) throw new BusinessError("INVALID_REQUEST", `不存在实验组 ${id}`);
        for (const path of group.filePaths) {
          const file = item.files.find((entry) => entry.path === path)!;
          if (!file.sourceId || file.parseStatus === "failed") continue;
          const source = await this.sources.get(projectId, file.sourceId);
          if (!source || source.contentHash !== file.hash) throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${path} 来源已删除或变化`);
        }
        if (group.conflicts.length) throw new BusinessError("EXPERIMENT_CONFIRM_CONFLICT", `${id} 有未解决冲突`);
        group.status = "confirmed"; group.confirmedAt ??= new Date().toISOString();
      }
      await this.save(projectId, item);
      return item;
    });
  }
  async isConfirmedSource(projectId: string, sourceId: string): Promise<boolean> {
    const items = await this.list(projectId);
    const source = await this.sources.get(projectId, sourceId);
    if (!source) return false;
    return items.some((item) => item.groups.some((group) => group.status === "confirmed" && group.filePaths.some((path) => item.files.some((file) => file.path === path && file.sourceId === sourceId && file.hash === source.contentHash))));
  }
}
