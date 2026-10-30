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
import type { PaperStore } from "../paper/PaperStore.js";
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
  /** M15.16 P0-B：PDF-only 稿件的参考文献观测来源（缺省不观测——保持既有 NOT_EVALUATED 行为） */
  papers?: PaperStore;
  currentRevision?: (projectId: string) => Promise<number>;
  now?: () => Date;
  log?: (message: string) => void;
}

export class TargetGuidelineService {
  private readonly projects: ProjectStore;
  private readonly papers: PaperStore | undefined;
  private readonly currentRevision: ((projectId: string) => Promise<number>) | undefined;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: TargetGuidelineServiceOptions) {
    this.projects = options.projects;
    this.papers = options.papers;
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
    const facts = await observeGuidelineFacts(this.projects, projectId, {
      evalYear: this.now().getFullYear(),
      ...(this.papers !== undefined
        ? { loadPaperDocument: (pid: string) => this.papers!.loadDocument(pid) }
        : {}),
    });
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
      `[target] projectId=${projectId} guideline 合规评估：venue=${guideline.venueId} factsSource=${facts.source ?? "none"} hardViolations=${report.summary.hardViolations} notEvaluated=${report.summary.notEvaluatedCount}`,
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
    return {
      ...base,
      status: "NOT_EVALUATED",
      observed: "（尚无可观测手稿事实源——manuscript 目录无 .tex，且无 PDF 参考文献解析产物）",
      expected: describeExpected(requirement),
      reason: "no_manuscript_facts",
    };
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
  // M15.16 P0-B：PDF-only 事实源只承载参考文献类观测——其余字段（题目/关键词/
  // 摘要结构/正文长度）无 PDF 确定性观测点，如实 NOT_EVALUATED（缺要素 ≠ 可
  // 判违规：PDF 上"未观测到"与"不存在"不可区分）
  if (facts.source === "pdf" && !requirement.field.startsWith("references.")) {
    return {
      ...base,
      status: "NOT_EVALUATED",
      observed: "（PDF-only 稿件：该字段无确定性观测点，不从 PDF 冒充核查）",
      expected: describeExpected(requirement),
      reason: "pdf_no_observation_point",
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
        const reason = facts.source === "pdf" ? "no_references_section_on_pdf" : "no_references";
        return {
          ...base,
          status: "NOT_EVALUATED",
          observed: facts.source === "pdf" ? "（PDF 解析产物未识别参考文献章节）" : "（未识别参考文献——references.bib 或 thebibliography）",
          expected: describeExpected(requirement),
          reason,
        };
      }
      const ok = facts.references.entryCount >= (requirement.value ?? 0);
      const observed =
        facts.references.basis === "pdf"
          ? `参考文献 ${facts.references.entryCount} 条（PDF ReferenceExtractor 条目口径；${facts.references.style ?? "unknown"} 风格${facts.references.extractorNotes?.length ? `；${facts.references.extractorNotes[0]}` : ""}）`
          : `参考文献 ${facts.references.entryCount} 条（${facts.bibSource === "thebibliography" ? "正文内联 thebibliography 口径" : "bib 条目口径"}）`;
      return {
        ...base,
        status: ok ? "PASS" : requirement.hard ? "VIOLATION" : "ADVISORY",
        observed,
        expected: `参考文献 ≥ ${requirement.value} 条`,
      };
    }
    case "references.recent10yRatio": {
      const refs = facts.references;
      if (refs === null || refs.withYearCount === null || refs.recent10yRatio === null) {
        return {
          ...base,
          status: "NOT_EVALUATED",
          observed: "（参考文献年份不可解析——无 year 字段样本）",
          expected: describeExpected(requirement),
          reason: "no_parseable_years",
        };
      }
      const threshold = requirement.value ?? 0;
      // M15.16 P0-B PDF 口径：年份未解析条目既不当旧文献也不当新文献——
      // 区间分析（最差/最好界），不确定区间跨越阈值 → NOT_EVALUATED（带区间披露）
      if (refs.basis === "pdf") {
        const total = refs.entryCount;
        const unparsed = refs.yearUnparsedCount ?? 0;
        const recent = refs.recent10yCount ?? 0;
        if (total <= 0) {
          return { ...base, status: "NOT_EVALUATED", observed: "（PDF 参考文献条目为空）", expected: describeExpected(requirement), reason: "no_references" };
        }
        const low = recent / total;
        const high = (recent + unparsed) / total;
        const pct = (value: number) => `${Math.round(value * 100)}%`;
        const observed = `近 10 年占比（可析年份口径）${pct(refs.recent10yRatio)}（${recent}/${refs.withYearCount} 条可析年份）；未解析 ${unparsed} 条的区间分析 [${pct(low)}, ${pct(high)}]`;
        if (low >= threshold) {
          return { ...base, status: "PASS", observed: `${observed}——任意取值均 ≥ ${pct(threshold)}`, expected: `近 10 年占比 ≥ ${pct(threshold)}` };
        }
        if (high < threshold) {
          return {
            ...base,
            status: requirement.hard ? "VIOLATION" : "ADVISORY",
            observed: `${observed}——任意取值均 < ${pct(threshold)}`,
            expected: `近 10 年占比 ≥ ${pct(threshold)}`,
          };
        }
        return {
          ...base,
          status: "NOT_EVALUATED",
          observed: `${observed}——区间跨越阈值 ${pct(threshold)}，无法确定达/不达`,
          expected: `近 10 年占比 ≥ ${pct(threshold)}`,
          reason: "pdf_year_parse_indeterminate",
        };
      }
      const ok = refs.recent10yRatio >= threshold;
      return {
        ...base,
        status: ok ? "PASS" : requirement.hard ? "VIOLATION" : "ADVISORY",
        observed: `近 10 年文献占比 ${Math.round(refs.recent10yRatio * 100)}%（${refs.recent10yCount}/${refs.withYearCount} 条可析年份）`,
        expected: `近 10 年占比 ≥ ${Math.round(threshold * 100)}%`,
      };
    }
    case "references.doiCoverage": {
      const refs = facts.references;
      if (refs === null || refs.doiCoverageRatio === null) {
        return { ...base, status: "NOT_EVALUATED", observed: "（未识别参考文献）", expected: describeExpected(requirement), reason: "no_references" };
      }
      // M15.16 P0-B PDF 口径：未识别 DOI 的条目可能是印刷 DOI 解析失败（M15.15
      // 实测 CJIG 召回 405/407）而非作者未提供——只有 100% 可辨识才判 PASS，
      // 不足时 NOT_EVALUATED（绝不把"没认出 DOI"当"没提供 DOI"判违规）
      if (refs.basis === "pdf") {
        const withDoi = refs.withDoiCount ?? 0;
        if (withDoi >= refs.entryCount) {
          return {
            ...base,
            status: "PASS",
            observed: `参考文献 ${refs.entryCount} 条全部辨识出 DOI（PDF 口径：逐条可辨识 = 每条印有 DOI）`,
            expected: "所有参考文献提供 DOI（覆盖率 100%）",
          };
        }
        return {
          ...base,
          status: "NOT_EVALUATED",
          observed: `参考文献含可辨识 DOI ${withDoi}/${refs.entryCount} 条（${refs.entryCount - withDoi} 条未识别——印刷 DOI 解析失败与作者未提供 DOI 在 PDF 上不可区分）`,
          expected: "所有参考文献提供 DOI（覆盖率 100%）",
          reason: "pdf_doi_coverage_indeterminate",
        };
      }
      const ok = refs.doiCoverageRatio >= 1;
      return {
        ...base,
        status: ok ? "PASS" : requirement.hard ? "VIOLATION" : "ADVISORY",
        observed: `参考文献含 DOI ${refs.withDoiCount}/${refs.entryCount} 条`,
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
