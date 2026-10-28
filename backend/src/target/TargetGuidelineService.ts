/**
 * TargetGuidelineService（M15.9 · Phase E G1）：官方投稿要求工件 + 确定性符合度评估。
 *
 * 职责：
 * 1. import_：校验并冻结 VenueGuidelineArtifact（research/target-guideline.json；
 *    幂等语义：相同 venueId 重复导入 = 覆盖更新并刷新 frozenAt——指南工件是
 *    「编辑部页面的冻结快照」，更新即新快照，合规报告按 guidelineFrozenAt 失效）；
 * 2. evaluate：GuidelineFacts × requirements → 逐条 PASS/VIOLATION/NOT_EVALUATED/
 *    ADVISORY（research/target-guideline-compliance.json）。**纯确定性零模型**；
 * 3. 红线：报告是 advisory——不进任何 Quality Gate 规则（gates.ts 零改动）；
 *    无观测点 → NOT_EVALUATED（带原因），绝不冒充通过；官方未写明的要求
 *    （如量化创新性量表）不存在于工件，系统不编造。
 *
 * 读容错 fail-closed：非法 JSON/schema → TARGET_GUIDELINE_CORRUPTED。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, NotFoundError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { observeGuidelineFacts, type GuidelineFacts } from "./guidelineFacts.js";
import type {
  GuidelineComplianceReport,
  GuidelineField,
  VenueGuidelineArtifact,
  VenueGuidelineRequirement,
} from "./guidelineTypes.js";

const GUIDELINE_SCHEMA_VERSION = 1 as const;

/** 无确定性检查器的官方字段（如实 NOT_EVALUATED——渲染/排版类要求 .tex 层不可核查） */
const FIELDS_WITHOUT_DETERMINISTIC_CHECKER: ReadonlySet<GuidelineField> = new Set([
  "references.styleAuthorYear",
  "figures.tableThreeLine",
  "figures.resolutionDpi",
  "section.numberingFromZero",
]);

/** 摘要"~500 字"建议带宽（官方措辞"左右"；越带只 ADVISORY 不 VIOLATION） */
const ABSTRACT_APPROX_TOLERANCE = 0.6;

export interface TargetGuidelineServiceOptions {
  projects: ProjectStore;
  currentRevision?: (projectId: string) => Promise<number>;
  now?: () => Date;
  log?: (message: string) => void;
}

export class TargetGuidelineService {
  private readonly projects: ProjectStore;
  private readonly currentRevision: ((projectId: string) => Promise<number>) | undefined;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: TargetGuidelineServiceOptions) {
    this.projects = options.projects;
    this.currentRevision = options.currentRevision;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  private artifactPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "target-guideline.json");
  }

  private reportPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "target-guideline-compliance.json");
  }

  /** 读指南工件（未导入 → null；损坏 → 抛错 fail-closed） */
  async get(projectId: string): Promise<VenueGuidelineArtifact | null> {
    let raw: string;
    try {
      raw = await readFile(this.artifactPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return parseGuideline(projectId, raw);
  }

  async getRequired(projectId: string): Promise<VenueGuidelineArtifact> {
    const artifact = await this.get(projectId);
    if (artifact === null) {
      throw new NotFoundError(
        "target guideline 工件",
        `${projectId}（无 target-guideline.json——先通过 import 冻结官方指南证据）`,
      );
    }
    return artifact;
  }

  /** 冻结（覆盖式）：schema 校验 + frozenAt 时间戳；合规报告随新 frozenAt 失效 */
  async import_(projectId: string, artifact: VenueGuidelineArtifact): Promise<VenueGuidelineArtifact> {
    await this.projects.getRequired(projectId);
    validateGuidelineArtifact(artifact);
    const frozen: VenueGuidelineArtifact = { ...artifact, frozenAt: this.now().toISOString() };
    await writeJsonAtomic(this.artifactPath(projectId), frozen);
    this.log(`[target] projectId=${projectId} guideline 工件冻结：venueId=${artifact.venueId} requirements=${artifact.requirements.length}`);
    return frozen;
  }

  /** 读上次合规报告（未评估 → null；损坏 → 抛错） */
  async getReport(projectId: string): Promise<GuidelineComplianceReport | null> {
    let raw: string;
    try {
      raw = await readFile(this.reportPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return JSON.parse(raw) as GuidelineComplianceReport;
  }

  /** 确定性符合度评估（零模型；指南工件缺 → NotFoundError 由调用方呈现 no-guideline 态） */
  async evaluate(
    projectId: string,
    options: { manuscriptRevision?: number | null } = {},
  ): Promise<GuidelineComplianceReport> {
    await this.projects.getRequired(projectId);
    const guideline = await this.getRequired(projectId);
    const facts = await observeGuidelineFacts(this.projects, projectId, { evalYear: this.now().getFullYear() });
    const manuscriptRevision =
      options.manuscriptRevision !== undefined
        ? options.manuscriptRevision
        : this.currentRevision !== undefined
          ? await this.currentRevision(projectId)
          : null;
    const report = evaluateCompliance(guideline, facts, {
      evaluatedAt: this.now().toISOString(),
      manuscriptRevision,
    });
    await writeJsonAtomic(this.reportPath(projectId), report);
    this.log(
      `[target] projectId=${projectId} guideline 合规评估：venue=${guideline.venueId} hardViolations=${report.summary.hardViolations} notEvaluated=${report.summary.notEvaluatedCount}`,
    );
    return report;
  }
}

// ---- 纯函数判定（单测直测）----

export interface EvaluateComplianceContext {
  evaluatedAt: string;
  manuscriptRevision: number | null;
}

export function evaluateCompliance(
  guideline: VenueGuidelineArtifact,
  facts: GuidelineFacts,
  context: EvaluateComplianceContext,
): GuidelineComplianceReport {
  const checks = guideline.requirements.map((requirement) => checkRequirement(requirement, facts));
  const hardViolations = checks.filter((check) => check.status === "VIOLATION" && check.hard).length;
  const passCount = checks.filter((check) => check.status === "PASS").length;
  const notEvaluatedCount = checks.filter((check) => check.status === "NOT_EVALUATED").length;
  const advisoryCount = checks.filter((check) => check.status === "ADVISORY" || (check.status === "VIOLATION" && !check.hard)).length;
  const topStatus: GuidelineComplianceReport["summary"]["topStatus"] =
    hardViolations > 0 ? "HARD_VIOLATION" : notEvaluatedCount === checks.length ? "NOT_EVALUATED_ONLY" : "COMPLIANT";
  return {
    schemaVersion: 1,
    venueId: guideline.venueId,
    guidelineFrozenAt: guideline.frozenAt,
    evaluatedAt: context.evaluatedAt,
    manuscriptRevision: context.manuscriptRevision,
    checks,
    summary: { hardViolations, passCount, notEvaluatedCount, advisoryCount, topStatus },
    provenance: {
      basis: "official_guideline_evidence",
      disclaimer:
        "符合度逐条对照期刊官方页面明文要求（原句摘录+来源+快照见 target-guideline.json）；无手稿观测点或无确定性检查器的条目如实 NOT_EVALUATED。本报告是投稿准备度 advisory，不构成录用判断，也不进入任何质量门禁。",
      guidelineConfidence: guideline.provenance.confidence,
    },
  };
}

function checkRequirement(
  requirement: VenueGuidelineRequirement,
  facts: GuidelineFacts,
): GuidelineComplianceReport["checks"][number] {
  const base = {
    requirementId: requirement.id,
    field: requirement.field,
    hard: requirement.hard,
    officialQuote: requirement.officialQuote,
    sourceUrl: requirement.sourceUrl,
  };
  if (!facts.exists) {
    return { ...base, status: "NOT_EVALUATED", observed: "（尚无手稿）", expected: describeExpected(requirement), reason: "manuscript 目录无 .tex 文件" };
  }
  if (FIELDS_WITHOUT_DETERMINISTIC_CHECKER.has(requirement.field)) {
    return {
      ...base,
      status: "NOT_EVALUATED",
      observed: "（无确定性检查器——渲染/排版类要求不从 .tex 冒充核查）",
      expected: describeExpected(requirement),
      reason: "no_deterministic_checker",
    };
  }
  switch (requirement.field) {
    case "title.maxLengthZh": {
      if (facts.titleCjkChars === null) {
        return { ...base, status: "NOT_EVALUATED", observed: "（未识别 \\title）", expected: describeExpected(requirement), reason: "no_title" };
      }
      const observed = facts.titleCjkChars;
      const ok = observed <= (requirement.value ?? Number.POSITIVE_INFINITY);
      return {
        ...base,
        status: ok ? "PASS" : "VIOLATION",
        observed: `题目「${facts.titleRaw ?? ""}」汉字 ${observed} 个`,
        expected: describeExpected(requirement),
      };
    }
    case "title.maxLengthEnWords": {
      if (facts.titleEnWords === null) {
        // 中文题目不适用英文实词条款（观测点存在但口径不同 → NOT_EVALUATED 而非误判）
        return {
          ...base,
          status: "NOT_EVALUATED",
          observed: facts.titleCjkChars !== null && facts.titleCjkChars > 0 ? "（中文题目——英文实词条款不适用）" : "（未识别 \\title）",
          expected: describeExpected(requirement),
          reason: facts.titleCjkChars !== null && facts.titleCjkChars > 0 ? "not_applicable_zh_title" : "no_title",
        };
      }
      const ok = facts.titleEnWords <= (requirement.value ?? Number.POSITIVE_INFINITY);
      return {
        ...base,
        status: ok ? "PASS" : "VIOLATION",
        observed: `题目英文实词 ${facts.titleEnWords} 个`,
        expected: describeExpected(requirement),
      };
    }
    case "keywords.count": {
      if (facts.keywordCount === null) {
        // 官方把关键词列为论文必备要素（"论文包括…关键词…"）——要素缺失本身是
        // 硬性不符（不是"无法评估"）；软性要求保持 NOT_EVALUATED 不升级。
        return {
          ...base,
          status: requirement.hard ? "VIOLATION" : "NOT_EVALUATED",
          observed: "论文要素缺失：未识别关键词块（\\keywords{} 或 关键词： 行）",
          expected: describeExpected(requirement),
          ...(requirement.hard ? {} : { reason: "no_keywords_block" }),
        };
      }
      // 数值语义：operator=min → ≥value；max → ≤value；presence → CJIG 缺省带 [5,8]
      let ok: boolean;
      let expected: string;
      if (requirement.operator === "min") {
        ok = facts.keywordCount >= (requirement.value ?? 0);
        expected = `关键词 ≥ ${requirement.value} 个`;
      } else if (requirement.operator === "max") {
        ok = facts.keywordCount <= (requirement.value ?? Number.POSITIVE_INFINITY);
        expected = `关键词 ≤ ${requirement.value} 个`;
      } else {
        ok = facts.keywordCount >= 5 && facts.keywordCount <= 8;
        expected = "关键词 5～8 个";
      }
      return {
        ...base,
        status: ok ? "PASS" : requirement.hard ? "VIOLATION" : "ADVISORY",
        observed: `关键词 ${facts.keywordCount} 个（${(facts.keywords ?? []).join("；")}）`,
        expected,
      };
    }
    case "abstract.structuredZh4": {
      if (facts.abstractStructured === null) {
        return { ...base, status: "NOT_EVALUATED", observed: "（未识别 abstract 环境）", expected: describeExpected(requirement), reason: "no_abstract" };
      }
      const missing = (Object.entries(facts.abstractStructured) as Array<[string, boolean]>)
        .filter(([, present]) => !present)
        .map(([key]) => key);
      const ok = missing.length === 0;
      return {
        ...base,
        status: ok ? "PASS" : requirement.hard ? "VIOLATION" : "ADVISORY",
        observed: ok ? "目的/方法/结果/结论 四要素齐备" : `摘要缺少结构化小标题：${missing.join("、")}`,
        expected: "摘要按 目的/方法/结果/结论 逐项撰写",
      };
    }
    case "abstract.lengthZh": {
      if (facts.abstractCjkChars === null) {
        return { ...base, status: "NOT_EVALUATED", observed: "（未识别 abstract 环境）", expected: describeExpected(requirement), reason: "no_abstract" };
      }
      const target = requirement.value ?? 500;
      const lower = Math.round(target * (1 - ABSTRACT_APPROX_TOLERANCE));
      const upper = Math.round(target * (1 + ABSTRACT_APPROX_TOLERANCE));
      const within = facts.abstractCjkChars >= lower && facts.abstractCjkChars <= upper;
      // 官方措辞"500 字左右"是建议——越带宽只 ADVISORY
      return {
        ...base,
        status: within ? "PASS" : "ADVISORY",
        observed: `摘要 ${facts.abstractCjkChars} 汉字`,
        expected: `约 ${target} 字（建议带宽 ${lower}–${upper}）`,
      };
    }
    case "references.count": {
      if (facts.references === null) {
        return { ...base, status: "NOT_EVALUATED", observed: "（未识别参考文献——references.bib 或 thebibliography）", expected: describeExpected(requirement), reason: "no_references" };
      }
      const ok = facts.references.entryCount >= (requirement.value ?? 0);
      return {
        ...base,
        status: ok ? "PASS" : requirement.hard ? "VIOLATION" : "ADVISORY",
        observed: `参考文献 ${facts.references.entryCount} 条（${facts.bibSource === "thebibliography" ? "正文内联 thebibliography 口径" : "bib 条目口径"}）`,
        expected: `参考文献 ≥ ${requirement.value} 条`,
      };
    }
    case "references.recent10yRatio": {
      if (facts.references === null || facts.references.recent10yRatio === null) {
        return {
          ...base,
          status: "NOT_EVALUATED",
          observed: "（参考文献年份不可解析——无 year 字段样本）",
          expected: describeExpected(requirement),
          reason: "no_parseable_years",
        };
      }
      const ok = facts.references.recent10yRatio >= (requirement.value ?? 0);
      return {
        ...base,
        status: ok ? "PASS" : requirement.hard ? "VIOLATION" : "ADVISORY",
        observed: `近 10 年文献占比 ${Math.round(facts.references.recent10yRatio * 100)}%（${facts.references.recent10yCount}/${facts.references.withYearCount} 条可析年份）`,
        expected: `近 10 年占比 ≥ ${Math.round((requirement.value ?? 0) * 100)}%`,
      };
    }
    case "references.doiCoverage": {
      if (facts.references === null || facts.references.doiCoverageRatio === null) {
        return { ...base, status: "NOT_EVALUATED", observed: "（未识别参考文献）", expected: describeExpected(requirement), reason: "no_references" };
      }
      const ok = facts.references.doiCoverageRatio >= 1;
      return {
        ...base,
        status: ok ? "PASS" : requirement.hard ? "VIOLATION" : "ADVISORY",
        observed: `参考文献含 DOI ${facts.references.withDoiCount}/${facts.references.entryCount} 条`,
        expected: "所有参考文献提供 DOI（覆盖率 100%）",
      };
    }
    case "manuscript.lengthWords": {
      if (facts.bodyCjkAndWordChars === null) {
        return { ...base, status: "NOT_EVALUATED", observed: "（尚无手稿）", expected: describeExpected(requirement), reason: "no_manuscript" };
      }
      const ok = facts.bodyCjkAndWordChars >= (requirement.value ?? 0);
      // 官方措辞"建议 7500 字以上为宜"——建议级，不足只 ADVISORY
      return {
        ...base,
        status: ok ? "PASS" : "ADVISORY",
        observed: `正文约 ${facts.bodyCjkAndWordChars} 字/词元（CJK 字符 + 拉丁词元粗计）`,
        expected: `建议 ${requirement.value} 字以上`,
      };
    }
    default: {
      return { ...base, status: "NOT_EVALUATED", observed: "（未知字段）", expected: describeExpected(requirement), reason: "unknown_field" };
    }
  }
}

function describeExpected(requirement: VenueGuidelineRequirement): string {
  const value = requirement.value !== undefined ? ` ${requirement.value}${requirement.unit ?? ""}` : "";
  return `${requirement.field} ${requirement.operator}${value}`;
}

// ---- 校验与解析 ----

export function validateGuidelineArtifact(artifact: VenueGuidelineArtifact): void {
  if (artifact.schemaVersion !== GUIDELINE_SCHEMA_VERSION) {
    throw new BusinessError("INVALID_REQUEST", `guideline 工件 schemaVersion 必须为 ${GUIDELINE_SCHEMA_VERSION}`);
  }
  if (typeof artifact.venueId !== "string" || artifact.venueId.trim() === "" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(artifact.venueId)) {
    throw new BusinessError("INVALID_REQUEST", "guideline 工件 venueId 非法（小写 slug）");
  }
  if (typeof artifact.displayName !== "string" || artifact.displayName.trim() === "") {
    throw new BusinessError("INVALID_REQUEST", "guideline 工件缺 displayName");
  }
  if (!Array.isArray(artifact.requirements)) {
    throw new BusinessError("INVALID_REQUEST", "guideline 工件缺 requirements 数组");
  }
  const seen = new Set<string>();
  for (const requirement of artifact.requirements) {
    if (typeof requirement.id !== "string" || requirement.id.trim() === "") {
      throw new BusinessError("INVALID_REQUEST", "requirement.id 非法");
    }
    if (seen.has(requirement.id)) {
      throw new BusinessError("INVALID_REQUEST", `requirement.id 重复：${requirement.id}`);
    }
    seen.add(requirement.id);
    if (typeof requirement.officialQuote !== "string" || requirement.officialQuote.trim() === "") {
      throw new BusinessError("INVALID_REQUEST", `requirement ${requirement.id} 缺 officialQuote（官方原句摘录——禁止无出处要求）`);
    }
    if (typeof requirement.sourceUrl !== "string" || !/^https?:\/\//.test(requirement.sourceUrl)) {
      throw new BusinessError("INVALID_REQUEST", `requirement ${requirement.id} 缺合法 sourceUrl`);
    }
    if (requirement.operator !== "presence" && requirement.operator !== "presence_all" && requirement.value === undefined) {
      throw new BusinessError("INVALID_REQUEST", `requirement ${requirement.id} 数值型 operator 需要 value`);
    }
  }
  if (typeof artifact.provenance?.accessDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(artifact.provenance.accessDate)) {
    throw new BusinessError("INVALID_REQUEST", "guideline 工件 provenance.accessDate 非法（YYYY-MM-DD）");
  }
  if (!Array.isArray(artifact.provenance?.sourceUrls) || artifact.provenance.sourceUrls.length === 0) {
    throw new BusinessError("INVALID_REQUEST", "guideline 工件 provenance.sourceUrls 不可为空");
  }
}

function parseGuideline(projectId: string, raw: string): VenueGuidelineArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupted(projectId, "不是合法 JSON");
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (record === null || record["schemaVersion"] !== GUIDELINE_SCHEMA_VERSION || !Array.isArray(record["requirements"])) {
    throw corrupted(projectId, "schema 不符（schemaVersion/requirements）");
  }
  return parsed as VenueGuidelineArtifact;
}

function corrupted(projectId: string, detail: string): BusinessError {
  return new BusinessError(
    "TARGET_GUIDELINE_CORRUPTED",
    `项目 ${projectId} 的 target-guideline.json 损坏（${detail}）——拒绝降级解读，请重新导入官方指南证据`,
  );
}
