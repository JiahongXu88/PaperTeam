/**
 * JournalAssessmentService：目标期刊评估的读写编排（profile 解析 / 来源复核 / 评估 / 转入修订）。
 *
 * 落盘（项目 research/ 下，Agent 不可写——见 workspaceGuard 的 research/ 规则）：
 *   journal-assessment.json                     最新评估
 *   journal-assessments/<assessmentId>.json     历史（append-only）
 *   journal-profile-verifications/<id>.json     在线原句回放结果（最近一次）
 *
 * 模型调用：只有 includeModelReview=true 时调用既有 TargetRubricService（单次 + ≤1 repair）；
 * 其余全部确定性零模型。
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, NotFoundError } from "../../errors.js";
import type { ProjectStore } from "../../project/ProjectStore.js";
import type { PaperStore } from "../../paper/PaperStore.js";
import type { ReviewArtifactStore } from "../../review/reviewArtifacts.js";
import type { ExternalInstruction, ExternalInstructionStore } from "../../review/externalInstructions.js";
import { qualityReportOf } from "../../quality/qualityReport.js";
import { writeJsonAtomic } from "../../util/atomic.js";
import type { TargetBenchmarkService } from "../TargetBenchmarkService.js";
import type { TargetGapService } from "../TargetGapService.js";
import type { TargetRubricArtifact, TargetRubricService } from "../TargetRubricService.js";
import type { VenueGuidelineArtifact } from "../guidelineTypes.js";
import { buildJournalAssessment, manuscriptRevisionHash, type BenchmarkReferenceInput, type JournalAssessment } from "./assessment.js";
import { evaluateProfileRules } from "./criteria.js";
import { observeJournalFacts } from "./journalFacts.js";
import { isArticleType, journalProfileHash, listBuiltinJournalProfiles, resolveJournalProfile } from "./profileRegistry.js";
import type { JournalArticleType, JournalProfile, JournalProfileVerification } from "./profileTypes.js";
import { fetchProfilePages, profileTrust, verifyProfileAgainstPages } from "./profileVerification.js";

export interface JournalAssessmentServiceOptions {
  projects: ProjectStore;
  papers?: PaperStore;
  currentRevision?: (projectId: string) => Promise<number>;
  reviewArtifacts?: ReviewArtifactStore;
  rubric?: TargetRubricService;
  benchmark?: TargetBenchmarkService;
  gap?: TargetGapService;
  externalInstructions?: ExternalInstructionStore;
  fetchImpl?: typeof fetch;
  /** 来源复核时页面之间的间隔（PLOS robots Crawl-delay=30） */
  fetchDelayMs?: number;
  profiles?: readonly JournalProfile[];
  now?: () => Date;
  log?: (message: string) => void;
}

export interface EvaluateJournalAssessmentInput {
  journalId?: string;
  name?: string;
  issn?: string;
  articleType: JournalArticleType;
  includeModelReview?: boolean;
  runId?: string;
}

export interface JournalProfileSummary {
  journalId: string;
  displayName: string;
  nameEn?: string;
  issn: string[];
  language: "zh" | "en";
  rulesVersion: string;
  ruleCount: number;
  articleTypes: JournalProfile["articleTypes"];
  verification: ReturnType<typeof profileTrust>;
  sourcePages: JournalProfile["source"]["pages"];
}

export class JournalAssessmentService {
  private readonly options: JournalAssessmentServiceOptions;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly profiles: readonly JournalProfile[];

  constructor(options: JournalAssessmentServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.profiles = options.profiles ?? listBuiltinJournalProfiles();
  }

  private research(projectId: string): string {
    return this.options.projects.researchDir(projectId);
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw new BusinessError("JOURNAL_ASSESSMENT_CORRUPTED", `${path} 不是合法 JSON——拒绝降级解读`);
      throw error;
    }
  }

  private verificationPath(projectId: string, journalId: string): string {
    return join(this.research(projectId), "journal-profile-verifications", `${journalId}.json`);
  }

  async getVerification(projectId: string, journalId: string): Promise<JournalProfileVerification | null> {
    return this.readJson<JournalProfileVerification>(this.verificationPath(projectId, journalId));
  }

  async listProfiles(projectId: string): Promise<JournalProfileSummary[]> {
    await this.options.projects.getRequired(projectId);
    const now = this.now();
    return Promise.all(
      this.profiles.map(async (profile) => ({
        journalId: profile.journalId,
        displayName: profile.identity.nameZh ?? profile.identity.nameEn ?? profile.journalId,
        ...(profile.identity.nameEn !== undefined ? { nameEn: profile.identity.nameEn } : {}),
        issn: [profile.identity.issnPrint, profile.identity.issnOnline].filter((value): value is string => value !== undefined),
        language: profile.language,
        rulesVersion: profile.rulesVersion,
        ruleCount: profile.rules.length,
        articleTypes: profile.articleTypes,
        verification: profileTrust(profile, await this.getVerification(projectId, profile.journalId), now),
        sourcePages: profile.source.pages,
      })),
    );
  }

  getProfile(journalId: string): JournalProfile | null {
    return this.profiles.find((profile) => profile.journalId === journalId) ?? null;
  }

  /** 在线原句回放：抓取官方页面，逐条核对 officialQuote（只读公开页面，不登录） */
  async refreshProfile(projectId: string, journalId: string): Promise<{ verification: JournalProfileVerification; trust: ReturnType<typeof profileTrust> }> {
    await this.options.projects.getRequired(projectId);
    const profile = this.getProfile(journalId);
    if (profile === null) throw new NotFoundError("期刊 profile", journalId);
    if (this.options.fetchImpl === undefined) throw new BusinessError("JOURNAL_PROFILE_FETCH_UNAVAILABLE", "未配置网络访问：无法在线复核期刊来源");
    const pages = await fetchProfilePages(profile, this.options.fetchImpl, { delayMs: this.options.fetchDelayMs ?? 0 });
    const verification = verifyProfileAgainstPages(profile, pages, this.now().toISOString());
    await mkdir(join(this.research(projectId), "journal-profile-verifications"), { recursive: true });
    await writeJsonAtomic(this.verificationPath(projectId, journalId), verification);
    this.log(`[journal] projectId=${projectId} profile=${journalId} 在线复核：${verification.status} quotes=${verification.quotes.filter((q) => q.found).length}/${verification.quotes.length}`);
    return { verification, trust: profileTrust(profile, verification, this.now()) };
  }

  async get(projectId: string): Promise<JournalAssessment | null> {
    return this.readJson<JournalAssessment>(join(this.research(projectId), "journal-assessment.json"));
  }

  async evaluate(projectId: string, input: EvaluateJournalAssessmentInput): Promise<JournalAssessment> {
    await this.options.projects.getRequired(projectId);
    if (!isArticleType(input.articleType)) throw new BusinessError("INVALID_REQUEST", `articleType 非法：${String(input.articleType)}`);
    const query = {
      ...(input.journalId !== undefined ? { journalId: input.journalId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.issn !== undefined ? { issn: input.issn } : {}),
    };
    if (Object.keys(query).length === 0) throw new BusinessError("INVALID_REQUEST", "需要 journalId / name / issn 至少一项");
    const resolved = resolveJournalProfile(query, this.profiles);
    if (resolved.ambiguous.length > 1) throw new BusinessError("JOURNAL_AMBIGUOUS", `匹配到多个期刊：${resolved.ambiguous.join("、")}——请用 journalId 或 ISSN 指定`);
    const profile = resolved.profile;
    const now = this.now();
    const verification = profile !== null ? await this.getVerification(projectId, profile.journalId) : null;
    const trust =
      profile !== null
        ? profileTrust(profile, verification, now)
        : { status: "UNVERIFIED" as const, verifiedAt: null, ageDays: null, trusted: false, note: "注册表中没有该期刊的官方规则 profile" };

    const facts = await observeJournalFacts(this.options.projects, projectId, {
      evalYear: now.getFullYear(),
      ...(this.options.papers !== undefined ? { loadPaperDocument: (pid: string) => this.options.papers!.loadDocument(pid) } : {}),
    });
    const manuscriptRevision = this.options.currentRevision !== undefined ? await this.options.currentRevision(projectId) : null;
    const criteria = profile !== null ? evaluateProfileRules(profile, facts, input.articleType, verification, now) : [];

    // B：最新一轮 QualityReport（只读）
    let qualityReport: { report: ReturnType<typeof qualityReportOf>; round: number } | null = null;
    if (this.options.reviewArtifacts !== undefined) {
      const rounds = await this.options.reviewArtifacts.gateRounds(projectId);
      const latest = rounds[0];
      if (latest !== undefined) {
        const artifact = await this.options.reviewArtifacts.loadGate(projectId, latest);
        if (artifact !== null) qualityReport = { report: qualityReportOf(artifact.gate), round: artifact.round };
      }
    }

    // B：可选模型意见（既有期刊 rubric；advisory，永不影响结论）
    let rubric: TargetRubricArtifact | null = null;
    if (profile !== null && this.options.rubric !== undefined) {
      if (input.includeModelReview === true && facts.fidelity === "latex") {
        rubric = await this.options.rubric.evaluate(projectId, toGuidelineArtifact(profile), { omitBenchmarkBands: true, manuscriptRevision });
      } else {
        rubric = await this.options.rubric.get(projectId);
      }
    }
    const rubricFresh =
      rubric !== null && profile !== null && rubric.venueId === profile.journalId && rubric.inputFingerprint.guidelineFrozenAt === profile.rulesVersion && rubric.manuscriptRevision === manuscriptRevision && rubric.summaryFailure === undefined;

    const assessment = buildJournalAssessment({
      projectId,
      now,
      articleType: input.articleType,
      query,
      profile,
      profileHash: profile !== null ? journalProfileHash(profile) : null,
      trust,
      criteria,
      facts,
      manuscriptRevision,
      qualityReport,
      rubric,
      rubricFresh,
      benchmark: profile !== null ? await this.benchmarkReference(projectId, profile) : null,
      runId: input.runId ?? null,
    });
    await mkdir(join(this.research(projectId), "journal-assessments"), { recursive: true });
    await writeJsonAtomic(join(this.research(projectId), "journal-assessments", `${assessment.assessmentId}.json`), assessment);
    await writeJsonAtomic(join(this.research(projectId), "journal-assessment.json"), assessment);
    this.log(`[journal] projectId=${projectId} assessment=${assessment.assessmentId} journal=${assessment.journal.journalId ?? "none"} verdict=${assessment.summary.verdict}`);
    return assessment;
  }

  private async benchmarkReference(projectId: string, profile: JournalProfile): Promise<BenchmarkReferenceInput | null> {
    if (this.options.benchmark === undefined) return null;
    const benchmark = await this.options.benchmark.get(projectId).catch(() => null);
    if (benchmark === null) return null;
    const venue = (benchmark.target.targetVenue ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    const names = [profile.identity.nameZh, profile.identity.nameEn, ...profile.identity.aliases].filter((v): v is string => v !== undefined).map((v) => v.normalize("NFKC").toLowerCase().replace(/\s+/g, ""));
    const readiness = this.options.gap !== undefined ? await this.options.gap.get(projectId).catch(() => null) : null;
    return {
      venueMatchesJournal: venue !== "" && names.includes(venue),
      corpusSize: benchmark.papers.filter((paper) => paper.excluded === undefined).length,
      sufficiency: benchmark.selection?.sufficiency ?? "unknown",
      ...(readiness !== null ? { overall: readiness.overall.verdict } : {}),
      dimensions: (readiness?.dimensions ?? []).map((d) => ({ dimension: d.dimension, band: d.targetRange, observed: d.observed })),
    };
  }

  /**
   * 可改写条目 → 外部修改意见队列（source=target_journal，advisory）。
   * 约束：assessmentId 必须是最新评估、稿件内容未变（revisionHash 一致）；只接受
   * VIOLATED + actionability=rewrite 的条目；进入队列后仍走既有修订流程与 EditContract
   * （本入口不授权任何数值修改）。
   */
  async convertToRevision(projectId: string, input: { assessmentId: string; criterionIds: string[] }): Promise<{ created: ExternalInstruction[]; skipped: Array<{ criterionId: string; reason: string }> }> {
    if (this.options.externalInstructions === undefined) throw new BusinessError("JOURNAL_REVISION_UNAVAILABLE", "修订意见队列未装配");
    const latest = await this.get(projectId);
    if (latest === null || latest.assessmentId !== input.assessmentId) {
      throw new BusinessError("JOURNAL_ASSESSMENT_STALE", "评估不是最新一次：请重新生成评估后再转入修订");
    }
    const facts = await observeJournalFacts(this.options.projects, projectId, {});
    if (manuscriptRevisionHash(facts.manuscriptFiles) !== latest.manuscript.revisionHash) {
      throw new BusinessError("JOURNAL_ASSESSMENT_STALE", "稿件在评估之后已变化：请重新评估后再转入修订");
    }
    if (input.criterionIds.length === 0) throw new BusinessError("INVALID_REQUEST", "criterionIds 不可为空（逐条选择，不支持全部转入）");
    const created: ExternalInstruction[] = [];
    const skipped: Array<{ criterionId: string; reason: string }> = [];
    for (const criterionId of input.criterionIds) {
      const criterion = latest.criteria.find((c) => c.criterionId === criterionId);
      if (criterion === undefined) {
        skipped.push({ criterionId, reason: "评估中不存在该条目" });
        continue;
      }
      if (!criterion.convertible) {
        skipped.push({ criterionId, reason: criterion.status !== "VIOLATED" ? "该条目未判定为不符" : "该条目需要作者提供信息 / 实验 / 外部素材，不能由自动修订完成" });
        continue;
      }
      const text = [
        `【目标期刊评估 ${latest.journal.displayName} · ${criterion.title}】`,
        `官方要求（${criterion.sourceUrl}）：${criterion.officialQuote}`,
        `当前稿件：${criterion.observed}（位置：${criterion.location}）`,
        `建议：${criterion.suggestion}`,
        "约束：只做文字 / 结构修改；不得新增、删除或改动任何实验数值、结果、引用事实；本意见不构成任何数值修改授权。",
        `（评估 ${latest.assessmentId}，规则版本 ${latest.journal.rulesVersion}）`,
      ].join("\n");
      const instruction = await this.options.externalInstructions.add(projectId, { source: "target_journal", reviewerLabel: latest.journal.journalId ?? "journal", text });
      if (instruction === null) skipped.push({ criterionId, reason: "同一意见已在队列中" });
      else created.push(instruction);
    }
    this.log(`[journal] projectId=${projectId} assessment=${latest.assessmentId} 转入修订：created=${created.length} skipped=${skipped.length}`);
    return { created, skipped };
  }
}

/** profile → 既有 rubric 服务的 guideline 输入（只用 scope / articleTypes；requirements 不参与模型判断） */
export function toGuidelineArtifact(profile: JournalProfile): VenueGuidelineArtifact {
  return {
    schemaVersion: 1,
    venueId: profile.journalId,
    displayName: profile.identity.nameZh ?? profile.identity.nameEn ?? profile.journalId,
    identity: {
      ...(profile.identity.issnPrint !== undefined ? { issnPrint: profile.identity.issnPrint } : {}),
      ...(profile.identity.issnOnline !== undefined ? { issnOnline: profile.identity.issnOnline } : {}),
      officialSite: `https://${profile.identity.officialDomain}/`,
      ...(profile.identity.openalexSourceId !== undefined ? { openalexSourceId: profile.identity.openalexSourceId } : {}),
    },
    scope: { scopeStatement: profile.scope.statement, columnsZh: profile.scope.topics, quote: profile.scope.officialQuote, sourceUrl: profile.scope.sourceUrl },
    articleTypes: profile.articleTypes.filter((t) => t.accepted === true).map((t) => ({ id: t.type, labelZh: t.labelOfficial })),
    requirements: [],
    provenance: { sourceUrls: profile.source.pages.map((p) => p.url), accessDate: profile.source.retrievedAt.slice(0, 10), confidence: "high" },
    // rubric 的 inputFingerprint.guidelineFrozenAt 以规则版本绑定（规则变化 → rubric 陈旧）
    frozenAt: profile.rulesVersion,
  };
}
