/**
 * Survey artifact 持久化（M11.1.1 Matrix + M11.1.2 Synthesis）。
 *
 * 布局（均为 Research 阶段派生产物，与 research.json 同级）：
 * - `<project>/research/survey.json`：Survey Matrix（per-paper 结构化理解）；
 * - `<project>/research/survey-synthesis.json`：Structured Synthesis（跨论文
 *   综合）。独立文件而非并入 survey.json：两者构建节奏不同（Matrix 随文献
 *   增量、Synthesis 基于 Matrix 快照全量重建）、schemaVersion 独立演化、
 *   Matrix 的 tolerant read 不需要理解 synthesis 形状。
 *
 * 纪律（对齐 CandidateStore / SourceStore 的既有口径）：
 * - 原子写（writeJsonAtomic：tmp → fsync → rename）；
 * - 序列化确定性：entries 按 sourceId 升序 / items 按 synthesisId 升序 +
 *   固定缩进，同内容恒同字节（updatedAt 等时间戳由调用方决定，不在这里注入）；
 * - 读容错：文件不存在 = null（还没构建过）；JSON 损坏 / 形状不完整 =
 *   结构化 SURVEY_*_CORRUPTED（绝不静默当空 artifact——「数据损坏」与
 *   「还没有构建」是两种事实）；schemaVersion 高于当前 = 同码拒绝（未来
 *   版本 artifact 由未来的迁移逻辑处理，不降级解读）；
 * - 条目防御性过滤：核心标识字段缺形的老行剔除（tolerant read；不中断
 *   整份读取）。
 * - 单一写入口：各 store 的 write()（服务层调用；HTTP 层不直接读写 JSON）。
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import {
  normalizeTaxonomy,
  type SurveyMatrixArtifact,
  type SurveyMatrixEntry,
} from "./matrixTypes.js";
import {
  SURVEY_SYNTHESIS_KINDS,
  type SurveySynthesisArtifact,
  type SurveySynthesisItem,
  type SynthesisGroundingLevel,
} from "./synthesisTypes.js";

const SURVEY_MATRIX_SCHEMA_VERSION = 1 as const;
const SURVEY_SYNTHESIS_SCHEMA_VERSION = 1 as const;

const GROUNDING_LEVELS: readonly SynthesisGroundingLevel[] = [
  "evidence_backed",
  "literature_cited",
  "speculative",
];

export class SurveyMatrixArtifactStore {
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  private artifactPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "survey.json");
  }

  /** 读 artifact；未构建 → null；损坏 / 未来版本 → SURVEY_MATRIX_CORRUPTED */
  async read(projectId: string): Promise<SurveyMatrixArtifact | null> {
    let raw: string;
    try {
      raw = await readFile(this.artifactPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw surveyMatrixCorrupted(projectId, "不是合法 JSON（疑似并发写残留或外部改动）");
    }
    const record =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    if (record === null || !Array.isArray(record["entries"])) {
      throw surveyMatrixCorrupted(projectId, "缺少 entries 数组（结构不完整）");
    }
    const version = record["schemaVersion"];
    if (version !== SURVEY_MATRIX_SCHEMA_VERSION) {
      throw surveyMatrixCorrupted(
        projectId,
        `schemaVersion 不受支持（文件为 ${String(version)}，当前代码支持 ${SURVEY_MATRIX_SCHEMA_VERSION}；可能由更新版本的 PaperTeam 写入）`,
      );
    }
    const taxonomyRaw = record["taxonomy"];
    let taxonomy: SurveyMatrixArtifact["taxonomy"];
    try {
      taxonomy = normalizeTaxonomy(taxonomyRaw as never);
    } catch (error) {
      throw surveyMatrixCorrupted(
        projectId,
        `taxonomy 不可用（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    const updatedAt =
      typeof record["updatedAt"] === "string" && record["updatedAt"] !== ""
        ? record["updatedAt"]
        : new Date(0).toISOString();
    const entries = (record["entries"] as unknown[]).filter(
      (entry): entry is SurveyMatrixEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as SurveyMatrixEntry).entryId === "string" &&
        typeof (entry as SurveyMatrixEntry).sourceId === "string" &&
        ((entry as SurveyMatrixEntry).interpretationDepth === "fulltext" ||
          (entry as SurveyMatrixEntry).interpretationDepth === "abstract_only") &&
        Array.isArray((entry as SurveyMatrixEntry).anchors),
    );
    return {
      schemaVersion: SURVEY_MATRIX_SCHEMA_VERSION,
      updatedAt,
      taxonomy,
      entries,
    };
  }

  /** 原子写（单一写入口；调用方负责条目排序与内容合法性） */
  async write(projectId: string, artifact: SurveyMatrixArtifact): Promise<void> {
    // projectId 合法性 + 项目存在性（避免对不存在项目静默建目录）
    await this.projects.getRequired(projectId);
    const sorted: SurveyMatrixArtifact = {
      ...artifact,
      entries: [...artifact.entries].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    };
    await mkdir(this.projects.researchDir(projectId), { recursive: true });
    await writeJsonAtomic(this.artifactPath(projectId), sorted);
  }
}

export class SurveySynthesisArtifactStore {
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  private artifactPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "survey-synthesis.json");
  }

  /** 读 artifact；未构建 → null；损坏 / 未来版本 → SURVEY_SYNTHESIS_CORRUPTED */
  async read(projectId: string): Promise<SurveySynthesisArtifact | null> {
    let raw: string;
    try {
      raw = await readFile(this.artifactPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw surveySynthesisCorrupted(projectId, "不是合法 JSON（疑似并发写残留或外部改动）");
    }
    const record =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    if (record === null || !Array.isArray(record["items"])) {
      throw surveySynthesisCorrupted(projectId, "缺少 items 数组（结构不完整）");
    }
    const version = record["schemaVersion"];
    if (version !== SURVEY_SYNTHESIS_SCHEMA_VERSION) {
      throw surveySynthesisCorrupted(
        projectId,
        `schemaVersion 不受支持（文件为 ${String(version)}，当前代码支持 ${SURVEY_SYNTHESIS_SCHEMA_VERSION}；可能由更新版本的 PaperTeam 写入）`,
      );
    }
    const matrixFingerprint =
      typeof record["matrixFingerprint"] === "string" && record["matrixFingerprint"] !== ""
        ? record["matrixFingerprint"]
        : "";
    const updatedAt =
      typeof record["updatedAt"] === "string" && record["updatedAt"] !== ""
        ? record["updatedAt"]
        : new Date(0).toISOString();
    const items = (record["items"] as unknown[]).filter(
      (item): item is SurveySynthesisItem =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as SurveySynthesisItem).synthesisId === "string" &&
        (SURVEY_SYNTHESIS_KINDS as readonly string[]).includes(
          (item as SurveySynthesisItem).kind,
        ) &&
        typeof (item as SurveySynthesisItem).claim === "string" &&
        GROUNDING_LEVELS.includes((item as SurveySynthesisItem).groundingLevel) &&
        Array.isArray((item as SurveySynthesisItem).sourceIds) &&
        Array.isArray((item as SurveySynthesisItem).evidenceIds) &&
        typeof (item as SurveySynthesisItem).derivedFrom === "object",
    );
    return {
      schemaVersion: SURVEY_SYNTHESIS_SCHEMA_VERSION,
      updatedAt,
      matrixFingerprint,
      items,
    };
  }

  /** 原子写（单一写入口；items 排序收口在此） */
  async write(projectId: string, artifact: SurveySynthesisArtifact): Promise<void> {
    await this.projects.getRequired(projectId);
    const sorted: SurveySynthesisArtifact = {
      ...artifact,
      items: [...artifact.items].sort((a, b) => a.synthesisId.localeCompare(b.synthesisId)),
    };
    await mkdir(this.projects.researchDir(projectId), { recursive: true });
    await writeJsonAtomic(this.artifactPath(projectId), sorted);
  }
}

function surveyMatrixCorrupted(projectId: string, reason: string): BusinessError {
  return new BusinessError(
    "SURVEY_MATRIX_CORRUPTED",
    `Survey Matrix 数据损坏（${projectId}/research/survey.json ${reason}）：这不是「还没有矩阵」，` +
      `而是存储文件本身不可读。请检查该 JSON 是否被外部改动，或从项目备份恢复；修复前的构建会被拒绝，不会覆盖现场。`,
    reason,
  );
}

function surveySynthesisCorrupted(projectId: string, reason: string): BusinessError {
  return new BusinessError(
    "SURVEY_SYNTHESIS_CORRUPTED",
    `Survey Synthesis 数据损坏（${projectId}/research/survey-synthesis.json ${reason}）：这不是「还没有综合产物」，` +
      `而是存储文件本身不可读。请检查该 JSON 是否被外部改动，或从项目备份恢复；修复前的构建会被拒绝，不会覆盖现场。`,
    reason,
  );
}
