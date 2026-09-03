/**
 * EvidenceStore（M3.1，file-first）。
 *
 * 存储：项目级 evidence/evidence.jsonl（每行一条 Evidence；PRD §6.9）。
 * - append 走追加写；updateVerification / markUsage 走全量原子重写
 *   （tmp → fsync → rename），规模内可接受，不提前引入数据库；
 * - 读取容忍损坏行（计入 skipped，不中断）；
 * - 项目隔离：实例按 projectId 构造，只读写本项目目录。
 *
 * 字段语义（PRD §23）：
 * - verificationStatus：unverified / verified / plausible / mismatch / unverifiable / not_found
 * - supportStrength：direct / partial / indirect / contradictory（Quality Gate 依据）
 * - verificationLevel：metadata / abstract / fulltext / user_confirmed（核验深度）
 * - confidence：仅辅助字段，不参与硬判定
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { EvidenceValidationError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeFileAtomic } from "../util/atomic.js";

export type VerificationStatus =
  | "unverified"
  | "verified"
  | "plausible"
  | "mismatch"
  | "unverifiable"
  | "not_found";

export type SupportStrength = "direct" | "partial" | "indirect" | "contradictory";

export type VerificationLevel = "metadata" | "abstract" | "fulltext" | "user_confirmed";

export interface EvidenceSourceRef {
  sourceId?: string;
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  url?: string;
}

export interface EvidenceLocation {
  page?: number;
  section?: string;
  chunk?: string;
}

export interface EvidenceRecord {
  id: string;
  claim: string;
  summary?: string;
  quote?: string;
  source?: EvidenceSourceRef;
  location?: EvidenceLocation;
  verificationStatus: VerificationStatus;
  verificationMethod?: string;
  supportStrength?: SupportStrength;
  verificationLevel?: VerificationLevel;
  /** 辅助字段（0-1）；不得成为 Quality Gate 的核心判定依据 */
  confidence?: number;
  relatedSections?: string[];
  usedBy?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
}

export interface EvidenceAppendInput {
  claim: string;
  summary?: string;
  quote?: string;
  source?: EvidenceSourceRef;
  location?: EvidenceLocation;
  verificationStatus?: VerificationStatus;
  verificationMethod?: string;
  supportStrength?: SupportStrength;
  verificationLevel?: VerificationLevel;
  confidence?: number;
  relatedSections?: string[];
}

export interface EvidenceQuery {
  status?: VerificationStatus;
  sourceId?: string;
  section?: string;
  usedBy?: string;
  claimContains?: string;
}

export interface EvidenceStats {
  total: number;
  byStatus: Record<VerificationStatus, number>;
  contradictory: number;
  skippedLines: number;
}

export interface EvidenceStoreOptions {
  now?: () => Date;
}

const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  "unverified",
  "verified",
  "plausible",
  "mismatch",
  "unverifiable",
  "not_found",
];

const SUPPORT_STRENGTHS: readonly SupportStrength[] = [
  "direct",
  "partial",
  "indirect",
  "contradictory",
];

const VERIFICATION_LEVELS: readonly VerificationLevel[] = [
  "metadata",
  "abstract",
  "fulltext",
  "user_confirmed",
];

export class EvidenceStore {
  private readonly projects: ProjectStore;
  private readonly now: () => Date;

  constructor(projects: ProjectStore, options: EvidenceStoreOptions = {}) {
    this.projects = projects;
    this.now = options.now ?? (() => new Date());
  }

  private filePath(projectId: string): string {
    return join(this.projects.evidenceDir(projectId), "evidence.jsonl");
  }

  /** 追加一条 Evidence（自动生成递增 id：E001…） */
  async append(projectId: string, input: EvidenceAppendInput, createdBy: string): Promise<EvidenceRecord> {
    const claim = requireNonEmpty(input.claim, "claim");
    const { records } = await this.loadAll(projectId);
    const id = `E${String(records.length + 1).padStart(3, "0")}`;
    const record: EvidenceRecord = {
      id,
      claim,
      ...(optionalString(input.summary, 2000) !== undefined
        ? { summary: optionalString(input.summary, 2000) }
        : {}),
      ...(optionalString(input.quote, 2000) !== undefined
        ? { quote: optionalString(input.quote, 2000) }
        : {}),
      ...(validateSource(input.source) !== undefined ? { source: validateSource(input.source) } : {}),
      ...(validateLocation(input.location) !== undefined
        ? { location: validateLocation(input.location) }
        : {}),
      verificationStatus:
        input.verificationStatus === undefined
          ? "unverified"
          : requireEnum(input.verificationStatus, VERIFICATION_STATUSES, "verificationStatus"),
      ...(optionalString(input.verificationMethod, 200) !== undefined
        ? { verificationMethod: optionalString(input.verificationMethod, 200) }
        : {}),
      ...(input.supportStrength !== undefined
        ? { supportStrength: requireEnum(input.supportStrength, SUPPORT_STRENGTHS, "supportStrength") }
        : {}),
      ...(input.verificationLevel !== undefined
        ? { verificationLevel: requireEnum(input.verificationLevel, VERIFICATION_LEVELS, "verificationLevel") }
        : {}),
      ...(typeof input.confidence === "number" && input.confidence >= 0 && input.confidence <= 1
        ? { confidence: input.confidence }
        : {}),
      ...(validateStringArray(input.relatedSections, "relatedSections") !== undefined
        ? { relatedSections: validateStringArray(input.relatedSections, "relatedSections") }
        : {}),
      createdBy,
      createdAt: this.now().toISOString(),
    };
    // id 冲突防御（损坏行导致编号回退时避免覆盖）
    const maxExisting = records.reduce((max, item) => {
      const numeric = Number(item.id.replace(/^E/, ""));
      return Number.isFinite(numeric) ? Math.max(max, numeric) : max;
    }, 0);
    record.id = `E${String(maxExisting + 1).padStart(3, "0")}`;

    await mkdir(this.projects.evidenceDir(projectId), { recursive: true });
    await appendFile(this.filePath(projectId), JSON.stringify(record) + "\n", "utf8");
    return record;
  }

  /** 按 id 读取；不存在返回 null */
  async get(projectId: string, id: string): Promise<EvidenceRecord | null> {
    const { records } = await this.loadAll(projectId);
    return records.find((record) => record.id === id) ?? null;
  }

  async list(projectId: string): Promise<EvidenceRecord[]> {
    const { records } = await this.loadAll(projectId);
    return records;
  }

  /** 查询（按状态 / 来源 / 章节 / 使用方 / claim 子串） */
  async query(projectId: string, filter: EvidenceQuery): Promise<EvidenceRecord[]> {
    const { records } = await this.loadAll(projectId);
    return records.filter((record) => {
      if (filter.status !== undefined && record.verificationStatus !== filter.status) {
        return false;
      }
      if (
        filter.sourceId !== undefined &&
        record.source?.sourceId !== filter.sourceId
      ) {
        return false;
      }
      if (
        filter.section !== undefined &&
        !(record.relatedSections ?? []).includes(filter.section)
      ) {
        return false;
      }
      if (filter.usedBy !== undefined && !(record.usedBy ?? []).includes(filter.usedBy)) {
        return false;
      }
      if (
        filter.claimContains !== undefined &&
        !record.claim.toLowerCase().includes(filter.claimContains.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }

  /** 更新核验状态（重写文件，原子落盘） */
  async updateVerification(
    projectId: string,
    id: string,
    patch: {
      verificationStatus?: VerificationStatus;
      verificationMethod?: string;
      verificationLevel?: VerificationLevel;
      supportStrength?: SupportStrength;
    },
  ): Promise<EvidenceRecord> {
    const { records } = await this.loadAll(projectId);
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) {
      throw new EvidenceValidationError(`Evidence 不存在：${id}`);
    }
    const current = records[index]!;
    const updated: EvidenceRecord = {
      ...current,
      ...(patch.verificationStatus !== undefined
        ? {
            verificationStatus: requireEnum(
              patch.verificationStatus,
              VERIFICATION_STATUSES,
              "verificationStatus",
            ),
          }
        : {}),
      ...(optionalString(patch.verificationMethod, 200) !== undefined
        ? { verificationMethod: optionalString(patch.verificationMethod, 200) }
        : {}),
      ...(patch.verificationLevel !== undefined
        ? {
            verificationLevel: requireEnum(
              patch.verificationLevel,
              VERIFICATION_LEVELS,
              "verificationLevel",
            ),
          }
        : {}),
      ...(patch.supportStrength !== undefined
        ? { supportStrength: requireEnum(patch.supportStrength, SUPPORT_STRENGTHS, "supportStrength") }
        : {}),
      updatedAt: this.now().toISOString(),
    };
    records[index] = updated;
    await this.rewrite(projectId, records);
    return updated;
  }

  /** 记录使用关系（relatedSections / usedBy 追加去重） */
  async markUsage(
    projectId: string,
    id: string,
    usage: { section?: string; usedBy?: string },
  ): Promise<EvidenceRecord> {
    const { records } = await this.loadAll(projectId);
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) {
      throw new EvidenceValidationError(`Evidence 不存在：${id}`);
    }
    const current = records[index]!;
    const updated: EvidenceRecord = {
      ...current,
      relatedSections: mergeUnique(current.relatedSections, usage.section),
      usedBy: mergeUnique(current.usedBy, usage.usedBy),
      updatedAt: this.now().toISOString(),
    };
    records[index] = updated;
    await this.rewrite(projectId, records);
    return updated;
  }

  /** 统计（供 Feasibility / Quality Gate 消费） */
  async stats(projectId: string): Promise<EvidenceStats> {
    const { records, skippedLines } = await this.loadAll(projectId);
    const byStatus = Object.fromEntries(
      VERIFICATION_STATUSES.map((status) => [status, 0]),
    ) as Record<VerificationStatus, number>;
    let contradictory = 0;
    for (const record of records) {
      byStatus[record.verificationStatus] += 1;
      if (record.supportStrength === "contradictory") {
        contradictory += 1;
      }
    }
    return { total: records.length, byStatus, contradictory, skippedLines };
  }

  // ---- 内部 ----

  private async loadAll(
    projectId: string,
  ): Promise<{ records: EvidenceRecord[]; skippedLines: number }> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(projectId), "utf8");
    } catch {
      return { records: [], skippedLines: 0 };
    }
    const records: EvidenceRecord[] = [];
    let skippedLines = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as EvidenceRecord;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.id === "string" &&
          typeof parsed.claim === "string" &&
          VERIFICATION_STATUSES.includes(parsed.verificationStatus)
        ) {
          records.push(parsed);
          continue;
        }
        skippedLines += 1;
      } catch {
        skippedLines += 1;
      }
    }
    return { records, skippedLines };
  }

  private async rewrite(projectId: string, records: EvidenceRecord[]): Promise<void> {
    const content =
      records.map((record) => JSON.stringify(record)).join("\n") +
      (records.length > 0 ? "\n" : "");
    await mkdir(this.projects.evidenceDir(projectId), { recursive: true });
    await writeFileAtomic(this.filePath(projectId), content);
  }
}

// ---- 校验辅助 ----

function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvidenceValidationError(`字段 ${field} 必须是非空字符串`);
  }
  if (value.length > 4000) {
    throw new EvidenceValidationError(`字段 ${field} 长度不能超过 4000`);
  }
  return value.trim();
}

function optionalString(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new EvidenceValidationError(`字段长度超过上限 ${maxLength}`);
  }
  return trimmed;
}

function requireEnum<T extends string>(value: T, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value)) {
    throw new EvidenceValidationError(
      `字段 ${field} 只能是 ${allowed.join(" / ")}，当前为 "${String(value)}"`,
    );
  }
  return value;
}

function validateSource(source: EvidenceSourceRef | undefined): EvidenceSourceRef | undefined {
  if (source === undefined) {
    return undefined;
  }
  if (typeof source !== "object" || source === null) {
    throw new EvidenceValidationError("source 必须是对象");
  }
  const out: EvidenceSourceRef = {};
  if (source.sourceId !== undefined) out.sourceId = optionalString(source.sourceId, 64);
  if (source.title !== undefined) out.title = optionalString(source.title, 500);
  if (source.authors !== undefined) {
    if (!Array.isArray(source.authors) || source.authors.some((a) => typeof a !== "string")) {
      throw new EvidenceValidationError("source.authors 必须是字符串数组");
    }
    out.authors = source.authors.slice(0, 20);
  }
  if (source.year !== undefined) {
    if (typeof source.year !== "number" || !Number.isInteger(source.year)) {
      throw new EvidenceValidationError("source.year 必须是整数");
    }
    out.year = source.year;
  }
  if (source.doi !== undefined) out.doi = optionalString(source.doi, 200);
  if (source.url !== undefined) out.url = optionalString(source.url, 1000);
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateLocation(location: EvidenceLocation | undefined): EvidenceLocation | undefined {
  if (location === undefined) {
    return undefined;
  }
  if (typeof location !== "object" || location === null) {
    throw new EvidenceValidationError("location 必须是对象");
  }
  const out: EvidenceLocation = {};
  if (location.page !== undefined) {
    if (typeof location.page !== "number" || !Number.isInteger(location.page) || location.page < 1) {
      throw new EvidenceValidationError("location.page 必须是正整数");
    }
    out.page = location.page;
  }
  if (location.section !== undefined) out.section = optionalString(location.section, 100);
  if (location.chunk !== undefined) out.chunk = optionalString(location.chunk, 100);
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateStringArray(value: string[] | undefined, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new EvidenceValidationError(`字段 ${field} 必须是字符串数组`);
  }
  return value.map((item) => item.trim()).filter((item) => item !== "").slice(0, 50);
}

function mergeUnique(current: string[] | undefined, addition: string | undefined): string[] {
  if (addition === undefined || addition.trim() === "") {
    return current ?? [];
  }
  const set = new Set([...(current ?? []), addition.trim()]);
  return [...set];
}
