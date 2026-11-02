/**
 * M15 Target Journal Assessment：profile 注册表 / 原句回放验真 / 规则判定 / 五态结论 / 转入受控修订。
 *
 * 关键红线（每条都有正反例）：
 * - 官方原句消失 → 规则不再按旧版判（NOT_EVALUATED）且结论 JOURNAL_PROFILE_UNVERIFIED；
 * - 超过 TTL 的快照不是现行规则；
 * - L1 已证实缺陷不能被模型「整体不错」抵消；模型意见不影响结论；
 * - PDF-only / 缺质量门禁 / 质量门禁陈旧 → INSUFFICIENT_EVIDENCE（不冒充通过）；
 * - 只有 VIOLATED + rewrite 条目可转入修订；稿件变化后转入 → 409；转入意见为 advisory 优先级。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ExternalInstructionStore } from "../../src/review/externalInstructions.js";
import { buildRevisionPlan } from "../../src/review/revisionPlan.js";
import { buildQualityReport } from "../../src/quality/qualityReport.js";
import type { QualityGateResult } from "../../src/quality/gates.js";
import { BUILTIN_JOURNAL_PROFILES, journalProfileHash, resolveJournalProfile } from "../../src/target/journal/profileRegistry.js";
import { htmlToText, profileQuotes, profileTrust, quoteKey, verifyProfileAgainstPages } from "../../src/target/journal/profileVerification.js";
import { evaluateProfileRules } from "../../src/target/journal/criteria.js";
import { observeJournalFacts } from "../../src/target/journal/journalFacts.js";
import { POSITIVE_RUBRIC_CAVEAT, buildJournalAssessment } from "../../src/target/journal/assessment.js";
import { JournalAssessmentService } from "../../src/target/journal/JournalAssessmentService.js";
import type { JournalArticleType, JournalProfile } from "../../src/target/journal/profileTypes.js";
import type { TargetRubricArtifact } from "../../src/target/TargetRubricService.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const NOW = new Date("2026-11-10T00:00:00.000Z");
const cjig = BUILTIN_JOURNAL_PROFILES.find((p) => p.journalId === "cjig")!;
const plos = BUILTIN_JOURNAL_PROFILES.find((p) => p.journalId === "plos-one")!;

function bib(count: number, year = 2022, doi = true): string {
  return Array.from({ length: count }, (_, i) => `@article{r${i},\n  title={T${i}},\n  author={A, B},\n  year={${year}},\n${doi ? `  doi={10.1000/x${i}},\n` : ""}}\n`).join("\n");
}

const ZH_FILLER = "本研究针对复杂交通场景中的目标遮挡与相机运动问题展开分析并给出系统化的处理流程。".repeat(3);

function cjigTex(overrides: { title?: string; keywords?: string | null; abstract?: string; clc?: boolean } = {}): string {
  const abstract =
    overrides.abstract ??
    `目的：${ZH_FILLER}方法：${ZH_FILLER}结果：在公开数据集上 HOTA 指标提升 3.1 个百分点。结论：${ZH_FILLER}`;
  return [
    "\\documentclass{article}",
    `\\title{${overrides.title ?? "多目标跟踪中的运动补偿研究"}}`,
    overrides.clc === false ? "" : "中图分类号：TP391",
    "\\begin{document}",
    "\\maketitle",
    `\\begin{abstract}${abstract}\\end{abstract}`,
    overrides.keywords === null ? "" : `\\keywords{${overrides.keywords ?? "多目标跟踪；运动补偿；数据关联；视频分析；目标检测"}}`,
    "\\section{引言}",
    ZH_FILLER.repeat(8),
    "\\section{实验}",
    "\\begin{table}\\caption{结果}\\end{table}",
    ZH_FILLER.repeat(8),
    "\\bibliography{references}",
    "\\end{document}",
  ].join("\n");
}

const EN_BODY = "We study motion compensation for multi object tracking in traffic videos and report experiments. ".repeat(20);

function plosTex(overrides: { abstract?: string; footnote?: boolean; ack?: boolean } = {}): string {
  return [
    "\\documentclass{article}",
    "\\title{Motion compensation for multi-object tracking}",
    "\\begin{document}",
    `\\begin{abstract}${overrides.abstract ?? "We propose a motion compensation module. Results improve tracking accuracy on public benchmarks."}\\end{abstract}`,
    "\\section{Introduction}",
    EN_BODY,
    overrides.footnote === true ? "Extra detail\\footnote{a footnote}." : "",
    "\\section{Materials and Methods}",
    EN_BODY,
    "\\section{Results}",
    "\\begin{table}\\caption{Results}\\end{table}",
    EN_BODY,
    overrides.ack === false ? "" : "\\section*{Acknowledgments}\nWe thank colleagues.",
    "\\bibliography{references}",
    "\\end{document}",
  ].join("\n");
}

async function project(tex: string | null, bibContent: string | null = bib(16)): Promise<{ store: ProjectStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-tja-"));
  roots.push(root);
  const store = new ProjectStore({ root });
  const created = await store.create("期刊评估测试", { documentType: "conference_paper" });
  const dir = store.manuscriptDir(created.id);
  await mkdir(dir, { recursive: true });
  if (tex !== null) await writeFile(join(dir, "main.tex"), tex, "utf8");
  if (bibContent !== null && tex !== null) await writeFile(join(dir, "references.bib"), bibContent, "utf8");
  return { store, projectId: created.id };
}

function gate(rules: Array<{ rule: string; status: "PASS" | "FAIL" | "NOT_EVALUATED"; required?: boolean }>, reviewedRevision = 1): QualityGateResult {
  return {
    passed: rules.every((r) => r.status === "PASS"),
    reasons: [],
    rules: rules.map((r) => ({ rule: r.rule, passed: r.status === "PASS", detail: `${r.rule} ${r.status}`, status: r.status, ...(r.required !== undefined ? { required: r.required } : {}) })),
    thresholds: {} as never,
    checkedAt: NOW.toISOString(),
    evaluation: { entry: "manual", workflowKind: null, reviewPurpose: "author_manuscript", reviewRound: 1, reviewedRevision, runId: null, inputFingerprint: "fp", contextGaps: [] },
  } as QualityGateResult;
}

const PASS_GATE = gate([
  { rule: "review_coverage_complete", status: "PASS" },
  { rule: "cross_section_numeric_consistency", status: "PASS" },
]);

async function assess(
  p: { store: ProjectStore; projectId: string },
  profile: JournalProfile | null,
  articleType: JournalArticleType,
  extra: { gate?: QualityGateResult | null; revision?: number; rubric?: TargetRubricArtifact | null; verification?: Parameters<typeof profileTrust>[1]; now?: Date } = {},
) {
  const now = extra.now ?? NOW;
  const facts = await observeJournalFacts(p.store, p.projectId, { evalYear: 2026 });
  const verification = extra.verification ?? null;
  const g = extra.gate === undefined ? PASS_GATE : extra.gate;
  return buildJournalAssessment({
    projectId: p.projectId,
    now,
    articleType,
    query: profile !== null ? { journalId: profile.journalId } : { name: "某未知期刊" },
    profile,
    profileHash: profile !== null ? journalProfileHash(profile) : null,
    trust: profile !== null ? profileTrust(profile, verification, now) : { status: "UNVERIFIED", verifiedAt: null, ageDays: null, trusted: false, note: "none" },
    criteria: profile !== null ? evaluateProfileRules(profile, facts, articleType, verification, now) : [],
    facts,
    manuscriptRevision: extra.revision ?? 1,
    qualityReport: g !== null ? { report: buildQualityReport(g), round: 1 } : null,
    rubric: extra.rubric ?? null,
    rubricFresh: extra.rubric !== undefined && extra.rubric !== null,
    benchmark: null,
  });
}

const status = (a: Awaited<ReturnType<typeof assess>>, ruleId: string) => a.criteria.find((c) => c.ruleId === ruleId)?.status;

describe("profile 注册表与来源验真", () => {
  it("按 journalId / 中英文名 / ISSN 解析；未知名称 → null", () => {
    expect(resolveJournalProfile({ name: "中国图象图形学报" }).profile?.journalId).toBe("cjig");
    expect(resolveJournalProfile({ name: "plos one" }).profile?.journalId).toBe("plos-one");
    expect(resolveJournalProfile({ issn: "1932-6203" }).profile?.journalId).toBe("plos-one");
    expect(resolveJournalProfile({ issn: "10068961" }).profile?.journalId).toBe("cjig");
    expect(resolveJournalProfile({ name: "计算机学报" }).profile).toBeNull();
  });

  it("每条规则都有官方原句与官方域名来源（禁止无出处规则）", () => {
    for (const profile of BUILTIN_JOURNAL_PROFILES) {
      for (const quote of profileQuotes(profile)) {
        expect(quote.quote.trim().length).toBeGreaterThan(5);
        expect(new URL(quote.sourceUrl).hostname).toBe(profile.identity.officialDomain);
      }
      for (const rule of profile.rules) {
        if (rule.kind === "hard_deterministic") expect(rule.checker, rule.id).toBeDefined();
      }
    }
  });

  it("原句回放：全部命中 → VERIFIED_LIVE；一条消失 → SOURCE_CHANGED（不可信）；抓取失败 → UNREACHABLE", () => {
    const page = (quotes: string[]) => `<html><body><script>var x="noise";</script>${quotes.map((q) => `<p>${q.replace(/，/g, "&#65292;")}</p>`).join("\n")}</body></html>`;
    const byUrl = new Map<string, string[]>();
    for (const quote of profileQuotes(cjig)) byUrl.set(quote.sourceUrl, [...(byUrl.get(quote.sourceUrl) ?? []), quote.quote]);
    const ok = new Map<string, { httpStatus: number | null; html: string | null; error?: string }>([...byUrl].map(([url, quotes]) => [url, { httpStatus: 200, html: page(quotes) }]));
    const live = verifyProfileAgainstPages(cjig, ok, NOW.toISOString());
    expect(live.status).toBe("VERIFIED_LIVE");
    expect(live.pages.every((p) => p.identicalToSnapshot === false)).toBe(true); // 页面字节变化 ≠ 规则变化
    expect(profileTrust(cjig, live, NOW).trusted).toBe(true);

    const writing = "http://www.cjig.cn/zh/info/13448/";
    const changed = new Map(ok);
    changed.set(writing, { httpStatus: 200, html: page(byUrl.get(writing)!.filter((q) => !q.includes("15篇以上"))) });
    const v2 = verifyProfileAgainstPages(cjig, changed, NOW.toISOString());
    expect(v2.status).toBe("SOURCE_CHANGED");
    expect(v2.quotes.find((q) => q.ref === "rule:cjig-refs-15")?.found).toBe(false);
    expect(profileTrust(cjig, v2, NOW).trusted).toBe(false);

    const down = new Map(ok);
    down.set(writing, { httpStatus: null, html: null, error: "ECONNRESET" });
    expect(verifyProfileAgainstPages(cjig, down, NOW.toISOString()).status).toBe("UNREACHABLE");
  });

  it("quoteKey 对空白 / 全角标点 / 实体稳定", () => {
    expect(quoteKey(htmlToText("数量要求 15 篇&nbsp;以上&#65292;近10年"))).toBe(quoteKey("数量要求15篇以上，近10年"));
  });

  it("内置快照 TTL：90 天内 VERIFIED_SNAPSHOT（披露不是即时规则）；超期 STALE 不可信", () => {
    const fresh = profileTrust(cjig, null, NOW);
    expect(fresh.status).toBe("VERIFIED_SNAPSHOT");
    expect(fresh.note).toContain("不是即时规则");
    const stale = profileTrust(cjig, null, new Date("2027-03-01T00:00:00.000Z"));
    expect(stale.status).toBe("STALE");
    expect(stale.trusted).toBe(false);
  });
});

describe("规则判定（A 块）与五态结论（D 块）", () => {
  it("合规 CJIG 研究论文 + 新鲜 PASS 质量门禁 → READY_FOR_AUTHOR_SUBMISSION_REVIEW；evidence_based 项列为作者确认、主观项不判", async () => {
    const a = await assess(await project(cjigTex()), cjig, "research");
    expect(a.summary.reasons).toEqual(["可检查的必需要求全部满足；已证实缺陷 0"]);
    expect(a.summary.verdict).toBe("READY_FOR_AUTHOR_SUBMISSION_REVIEW");
    expect(status(a, "cjig-abstract-quant")).toBe("SATISFIED");
    expect(status(a, "cjig-figures-dpi-3line")).toBe("NOT_EVALUATED");
    expect(status(a, "cjig-content-quality")).toBe("NOT_EVALUATED");
    expect(a.criteria.find((c) => c.ruleId === "cjig-content-quality")?.evidenceLevel).toBe("unassessed");
    expect(a.summary.observableRequirements.violated).toBe(0);
    expect(a.summary.observableRequirements.denominator).toBe(a.summary.observableRequirements.satisfied);
    expect(a.capabilities.HISTORICAL_DECISION_PREDICTION).toBe("DISABLED_NO_VALIDATED_DATA");
    expect(a.externalValidity.status).toBe("EXTERNAL_CALIBRATION_NOT_VALIDATED");
    expect(JSON.stringify(a)).not.toMatch(/录用概率\s*\d|acceptance probability/i);
    // 图表视觉质量如实未审阅
    expect(a.riskFindings.some((r) => r.findingId === "fidelity:figures" && r.evidenceLevel === "unassessed")).toBe(true);
  });

  it("违规 CJIG 稿：摘要含 \\cite、缺关键词、缺中图号、文献不足 → BLOCKED，且每条 VIOLATED 带官方原句与来源", async () => {
    const tex = cjigTex({ title: "基于深度学习的一种复杂交通场景多目标跟踪方法研究与实现", keywords: null, clc: false, abstract: `目的：${ZH_FILLER}方法：见\\cite{r1}与图1。结果：提升 3.1。结论：${ZH_FILLER}` });
    const a = await assess(await project(tex, bib(10)), cjig, "research");
    expect(a.summary.verdict).toBe("BLOCKED_BY_VERIFIED_ISSUE");
    for (const id of ["cjig-abstract-no-refs", "cjig-keywords-present", "cjig-frontmatter-clc", "cjig-refs-15", "cjig-title-zh-20", "cjig-title-avoid"]) {
      expect(status(a, id), id).toBe("VIOLATED");
    }
    const noRefs = a.criteria.find((c) => c.ruleId === "cjig-abstract-no-refs")!;
    expect(noRefs.observed).toContain("\\cite{r1}");
    expect(noRefs.observed).toContain("图1");
    expect(noRefs.officialQuote).toContain("参考文献号");
    expect(noRefs.sourceUrl).toBe("http://www.cjig.cn/zh/info/13448/");
    expect(noRefs.convertible).toBe(true);
    // 题目超长是「一般」措辞 → 建议级，不阻断；文献不足需作者补真实文献 → 不可自动改写
    expect(a.criteria.find((c) => c.ruleId === "cjig-title-zh-20")!.blocking).toBe(false);
    expect(a.criteria.find((c) => c.ruleId === "cjig-refs-15")!.convertible).toBe(false);
  });

  it("只有建议级不符 → CHANGES_REQUIRED（不是 BLOCKED）", async () => {
    const a = await assess(await project(cjigTex({ title: "复杂交通场景下面向遮挡与相机运动的多目标跟踪运动补偿" })), cjig, "research");
    expect(status(a, "cjig-title-zh-20")).toBe("VIOLATED");
    expect(a.summary.verdict).toBe("CHANGES_REQUIRED");
  });

  it("稿型差异：综述投 CJIG → 「结果段定量」NOT_APPLICABLE；叙述性综述投 PLOS ONE → 官方明文不受理（BLOCKED）", async () => {
    const zh = await assess(await project(cjigTex()), cjig, "survey");
    expect(status(zh, "cjig-abstract-quant")).toBe("NOT_APPLICABLE");
    const en = await assess(await project(plosTex()), plos, "survey");
    expect(en.criteria.find((c) => c.category === "article_type")?.status).toBe("VIOLATED");
    expect(en.fitEvidence.find((f) => f.aspect === "article_type")?.status).toBe("VERIFIED_MISMATCH");
    expect(en.summary.verdict).toBe("BLOCKED_BY_VERIFIED_ISSUE");
    const sys = await assess(await project(plosTex()), plos, "systematic_review");
    expect(sys.criteria.find((c) => c.category === "article_type")?.status).toBe("SATISFIED");
  });

  it("CJIG 系统综述：官方未写明 → NOT_EVALUATED + INSUFFICIENT_EVIDENCE（不推断接受或拒绝）", async () => {
    const a = await assess(await project(cjigTex()), cjig, "systematic_review");
    expect(a.criteria.find((c) => c.category === "article_type")?.status).toBe("NOT_EVALUATED");
    expect(a.summary.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("中文稿投 PLOS ONE → 语言 VIOLATED（verified scope mismatch）；英文合规稿 → 数据可用性 / 伦理只作作者确认", async () => {
    const zh = await assess(await project(cjigTex()), plos, "research");
    expect(status(zh, "plos-language-en")).toBe("VIOLATED");
    expect(zh.fitEvidence.find((f) => f.aspect === "language")?.status).toBe("VERIFIED_MISMATCH");
    expect(zh.summary.verdict).toBe("BLOCKED_BY_VERIFIED_ISSUE");

    const en = await assess(await project(plosTex()), plos, "research");
    expect(en.summary.verdict).toBe("READY_FOR_AUTHOR_SUBMISSION_REVIEW");
    const das = en.criteria.find((c) => c.ruleId === "plos-data-availability")!;
    expect(das.status).toBe("NOT_EVALUATED");
    expect(das.evidenceLevel).toBe("author-check");
    expect(en.summary.authorChecks.some((s) => s.includes("数据可用性"))).toBe(true);
  });

  it("回归（E2E-1 暴露）：PDF 重建稿把 Acknowledgements 渲染为独立文本行 → 要素存在、满足并注明；正文句子不被当作标题", async () => {
    const BIB_CMD = String.raw`\bibliography{references}`;
    const tex = plosTex({ ack: false }).replace(BIB_CMD, ["Acknowledgements", "We are grateful to colleagues.", BIB_CMD].join("\n"));
    const a = await assess(await project(tex), plos, "research");
    const c = a.criteria.find((x) => x.ruleId === "plos-required-sections")!;
    expect(c.status).toBe("SATISFIED");
    expect(c.observed).toContain("以独立文本行出现");
    const prose = plosTex({ ack: false }).replace(BIB_CMD, ["We acknowledge nothing here in this sentence.", BIB_CMD].join("\n"));
    expect((await assess(await project(prose), plos, "research")).criteria.find((x) => x.ruleId === "plos-required-sections")!.status).toBe("VIOLATED");
  });

  it("PLOS：脚注 / 缺 Acknowledgments / 摘要含引用 → 逐条 VIOLATED", async () => {
    const a = await assess(await project(plosTex({ footnote: true, ack: false, abstract: "We improve tracking [3] as shown by \\cite{r1}." })), plos, "research");
    expect(status(a, "plos-no-footnotes")).toBe("VIOLATED");
    expect(status(a, "plos-required-sections")).toBe("VIOLATED");
    expect(a.criteria.find((c) => c.ruleId === "plos-required-sections")!.observed).toContain("Acknowledgments");
    expect(status(a, "plos-abstract-no-cite")).toBe("VIOLATED");
    expect(a.summary.verdict).toBe("BLOCKED_BY_VERIFIED_ISSUE");
  });

  it("未知期刊 → JOURNAL_PROFILE_UNVERIFIED（A 块为空、不编造规则）", async () => {
    const a = await assess(await project(cjigTex()), null, "research");
    expect(a.summary.verdict).toBe("JOURNAL_PROFILE_UNVERIFIED");
    expect(a.criteria).toEqual([]);
    expect(a.capabilities.SUBMISSION_REQUIREMENTS_CHECKED).toBe("NO_PROFILE");
  });

  it("来源原句已变化 → 该规则 NOT_EVALUATED 且结论 JOURNAL_PROFILE_UNVERIFIED；过期快照同样不可信", async () => {
    const p = await project(cjigTex());
    const verification = {
      schemaVersion: "journal-profile-verification/v1" as const, journalId: "cjig", rulesVersion: cjig.rulesVersion, checkedAt: NOW.toISOString(), pages: [],
      quotes: profileQuotes(cjig).map((q) => ({ ref: q.ref, sourceUrl: q.sourceUrl, found: q.ref !== "rule:cjig-refs-15" })),
      status: "SOURCE_CHANGED" as const,
    };
    const a = await assess(p, cjig, "research", { verification });
    expect(status(a, "cjig-refs-15")).toBe("NOT_EVALUATED");
    expect(a.criteria.find((c) => c.ruleId === "cjig-refs-15")!.sourceStatus).toBe("QUOTE_NOT_FOUND");
    expect(a.summary.verdict).toBe("JOURNAL_PROFILE_UNVERIFIED");
    const stale = await assess(p, cjig, "research", { now: new Date("2027-06-01T00:00:00.000Z") });
    expect(stale.summary.verdict).toBe("JOURNAL_PROFILE_UNVERIFIED");
  });

  it("L1 已证实缺陷 + 模型 rubric 全 STRONG → 仍 BLOCKED（模型意见不能抵消、也不影响结论）", async () => {
    const rubric = {
      schemaVersion: 1, venueId: "cjig", promptVersion: "m159-rubric-v1", evaluatedAt: NOW.toISOString(), manuscriptRevision: 1, documentType: "x", withBenchmarkBands: false,
      dimensions: ["novelty", "contribution", "technicalSoundness"].map((d) => ({ dimension: d, verdict: "STRONG" as const, evidenceQuotes: ["引文"], gaps: [], needsExpertReview: true })),
      scopeRelevance: { inScope: true, evidence: "图像分析" }, overall: { verdict: "STRONG" as const, rationale: "整体不错" },
      inputFingerprint: { guidelineFrozenAt: cjig.rulesVersion, manuscriptDigestSha256: "x", scopeStatementSha256: "y", benchmarkBandsIncluded: false, promptVersion: "m159-rubric-v1" },
      provenance: { basis: "model_judgment_advisory" as const, disclaimer: "" },
    } as TargetRubricArtifact;
    const a = await assess(await project(cjigTex()), cjig, "research", { gate: gate([{ rule: "cross_section_numeric_consistency", status: "FAIL" }]), rubric });
    expect(a.summary.verdict).toBe("BLOCKED_BY_VERIFIED_ISSUE");
    expect(a.riskFindings.find((r) => r.findingId.includes("cross_section_numeric_consistency"))?.evidenceLevel).toBe("verified");
    expect(a.subjectiveEstimates).toHaveLength(3);
    expect(a.fitEvidence.find((f) => f.aspect === "scope")?.status).toBe("MODEL_OPINION");
    expect(a.capabilities.SUBJECTIVE_QUALITY_ESTIMATE).toBe("MODEL_OPINION_UNCALIBRATED");
  });

  it("M16：模型 rubric 有正向维度判断 → uncertainty 加入正向偏差限定；只有 WEAK / 无 rubric → 不加；结论不变", async () => {
    const rubricWith = (verdicts: Array<"STRONG" | "ADEQUATE" | "WEAK" | "INSUFFICIENT_EVIDENCE">) =>
      ({
        schemaVersion: 1, venueId: "cjig", promptVersion: "m159-rubric-v1", evaluatedAt: NOW.toISOString(), manuscriptRevision: 1, documentType: "x", withBenchmarkBands: false,
        dimensions: verdicts.map((verdict, i) => ({ dimension: `d${i}`, verdict, evidenceQuotes: ["引文"], gaps: verdict === "WEAK" ? ["缺口"] : [], needsExpertReview: true })),
        scopeRelevance: { inScope: true, evidence: "图像分析" }, overall: { verdict: verdicts[0], rationale: "r" },
        inputFingerprint: { guidelineFrozenAt: cjig.rulesVersion, manuscriptDigestSha256: "x", scopeStatementSha256: "y", benchmarkBandsIncluded: false, promptVersion: "m159-rubric-v1" },
        provenance: { basis: "model_judgment_advisory" as const, disclaimer: "" },
      }) as TargetRubricArtifact;
    const p = await project(cjigTex());
    const none = await assess(p, cjig, "research");
    const positive = await assess(p, cjig, "research", { rubric: rubricWith(["ADEQUATE", "WEAK"]) });
    const weakOnly = await assess(p, cjig, "research", { rubric: rubricWith(["WEAK", "INSUFFICIENT_EVIDENCE"]) });
    expect(positive.uncertainty).toContain(POSITIVE_RUBRIC_CAVEAT);
    expect(weakOnly.uncertainty).not.toContain(POSITIVE_RUBRIC_CAVEAT);
    expect(none.uncertainty).not.toContain(POSITIVE_RUBRIC_CAVEAT);
    // 展示限定不改结论、不产生 passed
    expect(positive.summary.verdict).toBe(none.summary.verdict);
    expect(weakOnly.summary.verdict).toBe(none.summary.verdict);
    expect(positive.externalValidity.status).toBe("EXTERNAL_CALIBRATION_NOT_VALIDATED");
    expect(JSON.stringify(positive)).not.toMatch(/"passed"/);
  });

  it("缺质量门禁 / 门禁对应旧修订 / 必需未评估 → INSUFFICIENT_EVIDENCE", async () => {
    const p = await project(cjigTex());
    expect((await assess(p, cjig, "research", { gate: null })).summary.verdict).toBe("INSUFFICIENT_EVIDENCE");
    const stale = await assess(p, cjig, "research", { revision: 3 });
    expect(stale.summary.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(stale.capabilities.EVIDENCE_GROUNDED_QUALITY_RISKS).toBe("STALE_QUALITY_REPORT");
    const ne = await assess(p, cjig, "research", { gate: gate([{ rule: "cross_section_numeric_consistency", status: "NOT_EVALUATED", required: true }]) });
    expect(ne.summary.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("无 LaTeX（无稿件 / PDF-only）→ 格式类 NOT_EVALUATED + INSUFFICIENT_EVIDENCE", async () => {
    const a = await assess(await project(null), cjig, "research");
    expect(a.manuscript.fidelity).toBe("none");
    expect(status(a, "cjig-abstract-structured")).toBe("NOT_EVALUATED");
    expect(a.summary.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("JournalAssessmentService：落盘、转入受控修订、陈旧拒绝", () => {
  it("evaluate 落盘最新 + 历史；只有 VIOLATED+rewrite 条目可转入；转入意见 source=target_journal 且为 advisory 优先级；稿件变化后 409", async () => {
    const p = await project(cjigTex({ keywords: null, abstract: `目的：${ZH_FILLER}方法：见\\cite{r1}。结果：提升 3.1。结论：${ZH_FILLER}` }));
    const instructions = new ExternalInstructionStore(p.store);
    const service = new JournalAssessmentService({ projects: p.store, externalInstructions: instructions, currentRevision: async () => 1, now: () => NOW });
    const a = await service.evaluate(p.projectId, { name: "中国图象图形学报", articleType: "research" });
    expect(a.journal.journalId).toBe("cjig");
    expect(a.summary.verdict).toBe("BLOCKED_BY_VERIFIED_ISSUE");
    expect(a.capabilities.EVIDENCE_GROUNDED_QUALITY_RISKS).toBe("NO_QUALITY_REPORT");
    const history = JSON.parse(await readFile(join(p.store.researchDir(p.projectId), "journal-assessments", `${a.assessmentId}.json`), "utf8"));
    expect(history.assessmentId).toBe(a.assessmentId);
    expect((await service.get(p.projectId))?.assessmentId).toBe(a.assessmentId);

    const result = await service.convertToRevision(p.projectId, { assessmentId: a.assessmentId, criterionIds: ["rule:cjig-abstract-no-refs", "rule:cjig-refs-doi", "rule:cjig-frontmatter-clc", "rule:nope"] });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.source).toBe("target_journal");
    expect(result.created[0]!.text).toContain("不构成任何数值修改授权");
    expect(result.skipped.map((s) => s.criterionId).sort()).toEqual(["rule:cjig-frontmatter-clc", "rule:cjig-refs-doi", "rule:nope"]);
    const plan = buildRevisionPlan({ projectId: p.projectId, sourceRevision: 1, reviewRound: 1, createdAt: NOW.toISOString(), summary: { generatedAt: NOW.toISOString(), round: 1, reviewedRevision: 1, issues: [], counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 }, scores: { academicScore: 80, styleRisk: 0, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0 } }, openCritical: 0, openMajor: 0, unsupportedCriticalClaims: 0, reportPaths: [] }, externalInstructions: await instructions.load(p.projectId) } as never);
    expect(plan.items.find((item) => item.kind === "external_instruction")?.priority).toBe("high");

    await expect(service.convertToRevision(p.projectId, { assessmentId: "ja-old", criterionIds: ["rule:cjig-abstract-no-refs"] })).rejects.toMatchObject({ code: "JOURNAL_ASSESSMENT_STALE" });
    await writeFile(join(p.store.manuscriptDir(p.projectId), "main.tex"), cjigTex(), "utf8");
    await expect(service.convertToRevision(p.projectId, { assessmentId: a.assessmentId, criterionIds: ["rule:cjig-abstract-no-refs"] })).rejects.toMatchObject({ code: "JOURNAL_ASSESSMENT_STALE" });
  });

  it("refreshProfile：fetch 注入；SOURCE_CHANGED 落盘后评估结论 JOURNAL_PROFILE_UNVERIFIED；无 fetch → 503 语义错误", async () => {
    const p = await project(cjigTex());
    const fetchImpl = (async (url: string) => {
      const quotes = profileQuotes(cjig).filter((q) => q.sourceUrl === url && q.ref !== "rule:cjig-refs-doi").map((q) => q.quote);
      return new Response(`<p>${quotes.join("</p><p>")}</p>`, { status: 200 });
    }) as typeof fetch;
    const service = new JournalAssessmentService({ projects: p.store, fetchImpl, now: () => NOW });
    const refreshed = await service.refreshProfile(p.projectId, "cjig");
    expect(refreshed.verification.status).toBe("SOURCE_CHANGED");
    expect(refreshed.trust.trusted).toBe(false);
    const a = await service.evaluate(p.projectId, { journalId: "cjig", articleType: "research" });
    expect(a.summary.verdict).toBe("JOURNAL_PROFILE_UNVERIFIED");
    await expect(new JournalAssessmentService({ projects: p.store, now: () => NOW }).refreshProfile(p.projectId, "cjig")).rejects.toMatchObject({ code: "JOURNAL_PROFILE_FETCH_UNAVAILABLE" });
  });

  it("名称歧义 / 缺期刊标识 / 非法稿型 → 拒绝", async () => {
    const p = await project(cjigTex());
    const dup = { ...cjig, journalId: "cjig-copy" };
    const service = new JournalAssessmentService({ projects: p.store, profiles: [cjig, dup], now: () => NOW });
    await expect(service.evaluate(p.projectId, { name: "中国图象图形学报", articleType: "research" })).rejects.toMatchObject({ code: "JOURNAL_AMBIGUOUS" });
    await expect(service.evaluate(p.projectId, { articleType: "research" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(service.evaluate(p.projectId, { journalId: "cjig", articleType: "letter" as never })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
