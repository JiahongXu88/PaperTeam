/**
 * M15.17 — TargetAuditRevisionService（审计差距 → 修订计划闭环）测试：
 * - 纯函数：LaTeX↔PDF 可比化（escape 逆变换 / \cite 与 [n] 标记对齐 / CJK），
 *   quote 投影（唯一 / 多命中 tie-break / 不猜位置），B2 确定性分类门禁；
 * - 服务编排：无审计 fail-closed / 陈旧 409（SHA / 修订号 / venue 切换 / 重新审计）/
 *   幂等生成 / 作者决策转入意见队列（rewrite=pending·section 限定；需实验=
 *   AUTHOR_DECISION_REQUIRED 永不派发）/ 闭环复评（patch lineage + 守卫投影）；
 * - 接入纪律：target_audit 指令在 buildRevisionPlan 中 priority=high（不高于真人
 *   mandatory）；externalInstructions.add 支持 pending 态受控 statusNote。
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import type { PaperDocument } from "../../src/paper/types.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import { ExternalInstructionStore } from "../../src/review/externalInstructions.js";
import { ReviewArtifactStore } from "../../src/review/reviewArtifacts.js";
import { buildRevisionPlan } from "../../src/review/revisionPlan.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import {
  TargetAuditRevisionService,
  allowedScopeText,
  authorDecisionStatusNote,
  classifyAuditGap,
  comparableContains,
  latexToComparablePlain,
  projectQuoteToManuscript,
  quoteToComparablePlain,
  rewriteInstructionText,
  type AuditGapClassification,
  type TargetAuditRevisionPlanArtifact,
} from "../../src/target/TargetAuditRevisionService.js";
import type {
  ContributionAuditArtifact,
  ContributionUnit,
  ContributionComparison,
  GapPlanItem,
} from "../../src/target/ContributionAuditService.js";

// ---- fixtures ----

const CN_CLAIM = "本文提出一种融合多层次语义特征的场景文本检测方法，在标准数据集上取得了优越性能。";

function makeDocument(): PaperDocument {
  const section = (id: string, title: string) => ({
    sectionId: id,
    title,
    level: 1,
    pageStart: 1,
    pageEnd: 2,
    charCount: 400,
    source: "toc" as const,
  });
  const chunk = (id: string, sequence: number, sectionId: string, text: string) => ({
    chunkId: id,
    sequence,
    pageStart: 1,
    pageEnd: 2,
    sectionId,
    text,
    charCount: text.length,
  });
  return {
    schemaVersion: 1,
    projectId: "p-fixture",
    documentId: "paper-1",
    title: "多层次语义融合场景文本检测",
    abstract: "场景文本检测摘要。",
    originalFileName: "fixture.pdf",
    bytes: 999,
    sha256: "a".repeat(64),
    parse: { parserId: "test", parsedAt: "2026-10-31T00:00:00.000Z", durationMs: 1, pageCount: 5, extractionQuality: "good" },
    pages: [],
    sections: [section("SEC01", "引言"), section("SEC02", "方法"), section("SEC05", "参考文献")],
    chunks: [
      chunk("C0001", 1, "SEC01", `${CN_CLAIM} ${"引".repeat(200)}`),
      chunk("C0002", 2, "SEC02", `方法：融合模块结合语义特征（见文献[1]），达到 87.5% 的 F1。${"法".repeat(200)}`),
      chunk("C0005", 5, "SEC05", "[1] Liao M. Real-time scene text detection with differentiable binarization. 2020. 10.1609/aaai.v34i07.6812"),
    ],
    abstractSectionId: undefined,
    referencesSectionId: "SEC05",
    ingestedAt: "2026-10-31T00:00:00.000Z",
  };
}

/** 重建后的 sec01.tex 形态（PaperReconstructor 转义 + \cite 映射） */
const SEC01_TEX = [
  "\\section{引言}",
  "",
  `${CN_CLAIM} 引言正文占位。`,
  "",
].join("\n");
const SEC02_TEX = [
  "\\section{方法}",
  "",
  "方法：融合模块结合语义特征（见文献\\cite{ref1}），达到 87.5\\% 的 F1。",
].join("\n");

const INVENTORY: ContributionUnit[] = [
  {
    contributionId: "C1",
    claimQuote: CN_CLAIM,
    claimType: "technical_idea",
    sectionId: "SEC01",
    supportLocations: [{ sectionId: "SEC02", kind: "experiment", quote: "达到 87.5% 的 F1", verified: true }],
    supportStatus: "located",
    anchorVerified: true,
  },
  {
    contributionId: "C2",
    claimQuote: "融合模块结合语义特征",
    claimType: "method_combination",
    sectionId: "SEC02",
    supportLocations: [],
    supportStatus: "missing",
    anchorVerified: true,
  },
  {
    contributionId: "C3",
    claimQuote: "（审计锚校验已丢弃的声称——此条 anchorVerified=false 模拟）",
    claimType: "other",
    sectionId: "SEC02",
    supportLocations: [],
    supportStatus: "missing",
    anchorVerified: false,
  },
];

const COMPARISONS: ContributionComparison[] = [
  {
    contributionId: "C1",
    nearestPriorWorks: [
      {
        candidateId: "P01",
        title: "Real-time scene text detection with differentiable binarization",
        year: 2020,
        doi: "10.1609/aaai.v34i07.6812",
        sourceLevel: "pool_fulltext",
        quote: "Differentiable Binarization",
        resolvesToPool: true,
        priorQuoteVerified: true,
      },
    ],
    commonMechanism: "可学习后处理",
    substantiveDifference: "层级语义融合",
    differenceBasis: "fulltext",
    completedVerification: "对比实验",
    missingVerification: "无消融",
    status: "SUPPORTED_DIFFERENCE",
  },
  {
    contributionId: "C2",
    nearestPriorWorks: [],
    commonMechanism: "",
    substantiveDifference: "",
    differenceBasis: "none",
    completedVerification: "",
    missingVerification: "先前工作材料不足",
    status: "INSUFFICIENT_EVIDENCE",
  },
];

const GAP_PLAN: GapPlanItem[] = [
  {
    contributionId: "C1",
    gap: "对 DB 的实现级差异声称缺少消融验证",
    actionType: "requires_real_experiment_or_author_input",
    experimentPlan: { purpose: "验证层级融合贡献", baselines: "去融合变体", metrics: "F1" },
    status: "author_decision",
  },
  {
    contributionId: "C2",
    gap: "「结合语义特征」表述与后文方法描述前后不一致，需按现有证据收敛措辞",
    actionType: "can_rewrite_from_existing_evidence",
    status: "proposed",
  },
  {
    contributionId: "C3",
    gap: "声称锚不可核验",
    actionType: "can_rewrite_from_existing_evidence",
    status: "proposed",
  },
];

// sha256Hex 与产品同口径（inputFingerprint 的 manuscriptSha256 计算）
import { sha256Hex } from "../../src/util/hash.js";

function makeArtifact(overrides: Partial<ContributionAuditArtifact> = {}): ContributionAuditArtifact {
  const document = makeDocument();
  return {
    schemaVersion: 1,
    venueId: "cjig",
    documentType: "research_article",
    promptVersion: "m1514-caudit-v1",
    evaluatedAt: "2026-10-31T01:00:00.000Z",
    manuscriptRevision: 0,
    priorWork: {
      cutoffDate: "2026-10-31",
      poolFingerprint: "poolfp0000000000",
      poolSize: 1,
      queriesUsed: [],
      candidates: [],
    },
    inventory: INVENTORY,
    comparisons: COMPARISONS,
    gapPlan: GAP_PLAN,
    findings: [],
    coverage: {
      sectionsTotal: 3,
      sectionsIndexed: 3,
      sectionsIncludedFullText: 3,
      manuscriptCharsTotal: 1000,
      manuscriptCharsIncluded: 1000,
      truncations: [],
    },
    guards: {
      anchorFailures: 0,
      unresolvedPriorWorkRefs: 0,
      cutoffViolations: 0,
      statusRuleViolations: 0,
      droppedFindings: 0,
      priorQuoteReplayFailures: 0,
      fulltextBasisDowngrades: 0,
    },
    inputFingerprint: {
      manuscriptSha256: shaOfDocument(document),
      poolFingerprint: "poolfp0000000000",
      promptVersion: "m1514-caudit-v1",
      documentType: "research_article",
      venueId: "cjig",
    },
    provenance: { basis: "model_judgment_advisory", disclaimer: "advisory" },
    ...overrides,
  };
}

function shaOfDocument(document: PaperDocument): string {
  return sha256Hex(document.chunks.map((chunk) => chunk.text).join("\n\n")).slice(0, 16);
}

// ---- 纯函数 ----

describe("可比化纯函数（PDF ↔ 重建 LaTeX）", () => {
  it("latexToComparablePlain：escape 逆变换 + \\cite / 标题命令剥离", () => {
    const plain = latexToComparablePlain("87.5\\% 的 F1（见\\cite{ref1, ref2}）\\textbackslash{} x\\_y");
    expect(plain).toContain("87.5% 的 F1");
    expect(plain).not.toContain("\\cite");
    expect(plain).toContain("\\ x_y");
  });

  it("quoteToComparablePlain：[n] 引用标记剥离", () => {
    expect(quoteToComparablePlain("结合语义特征（见文献[1]），达到")).toBe("结合语义特征（见文献 ），达到");
  });

  it("comparableContains：CJK 全空白剥离回退", () => {
    expect(comparableContains(`${CN_CLAIM} 后续文本`, CN_CLAIM)).toBe(true);
    // haystack 内被插入空白（PDF 换行形态）——剥空白后仍命中
    const spacedNeedle = CN_CLAIM.slice(0, 20).split("").join(" ");
    expect(comparableContains(`改写后的导语 ${spacedNeedle} 结尾`, CN_CLAIM.slice(0, 20))).toBe(true);
    expect(comparableContains("完全不同的内容", CN_CLAIM)).toBe(false);
  });

  it("过短 quote 不做包含判定（防平凡命中）", () => {
    expect(comparableContains("abcdefg", "abc")).toBe(false);
  });
});

describe("projectQuoteToManuscript（锚投影）", () => {
  const files = [
    { relativePath: "sections/sec01.tex", content: SEC01_TEX },
    { relativePath: "sections/sec02.tex", content: SEC02_TEX },
  ];
  it("唯一命中 → resolved（quote-replay）", () => {
    const result = projectQuoteToManuscript(CN_CLAIM, files);
    expect(result).toMatchObject({ status: "resolved", file: "sections/sec01.tex", basis: "quote-replay", ambiguous: false });
  });
  it("多文件命中且 hint 命中 → resolved（ambiguous=true，按节序）", () => {
    const duplicated = [
      ...files,
      { relativePath: "sections/sec03.tex", content: `${CN_CLAIM} 重复出现在结论。` },
    ];
    const result = projectQuoteToManuscript(CN_CLAIM, duplicated, "sections/sec01.tex");
    expect(result).toMatchObject({ status: "resolved", file: "sections/sec01.tex", ambiguous: true });
  });
  it("多文件命中且无 hint → unresolved（不猜位置）", () => {
    const duplicated = [
      ...files,
      { relativePath: "sections/sec03.tex", content: `${CN_CLAIM} 重复出现在结论。` },
    ];
    expect(projectQuoteToManuscript(CN_CLAIM, duplicated)).toMatchObject({ status: "unresolved", reason: "quote-ambiguous" });
  });
  it("零命中 / 过短 → unresolved", () => {
    expect(projectQuoteToManuscript("不存在于任何章节的引用文本内容示例", files)).toMatchObject({ status: "unresolved", reason: "quote-not-found" });
    expect(projectQuoteToManuscript("短", files)).toMatchObject({ status: "unresolved", reason: "quote-too-short" });
  });
  it("\\cite 替换后的正文仍可命中含 [n] 标记的 quote", () => {
    const result = projectQuoteToManuscript("融合模块结合语义特征（见文献[1]），达到 87.5% 的 F1", files);
    expect(result).toMatchObject({ status: "resolved", file: "sections/sec02.tex" });
  });
});

describe("classifyAuditGap（B2 确定性分类门禁）", () => {
  const resolved = { status: "resolved" as const, file: "sections/sec01.tex", basis: "quote-replay" as const, ambiguous: false };
  const gap = (actionType: GapPlanItem["actionType"]): GapPlanItem => ({
    contributionId: "C1",
    gap: "测试差距",
    actionType,
    status: actionType === "requires_real_experiment_or_author_input" ? "author_decision" : "proposed",
  });
  it("requires_real → NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT（无视锚）", () => {
    const result = classifyAuditGap({ gap: gap("requires_real_experiment_or_author_input"), contribution: INVENTORY[0], comparison: COMPARISONS[0], projection: resolved });
    expect(result.classification).toBe<AuditGapClassification>("NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT");
  });
  it("can_rewrite + 锚未核验 → EVIDENCE_INSUFFICIENT（不因模型自称可改写而放行）", () => {
    const result = classifyAuditGap({ gap: gap("can_rewrite_from_existing_evidence"), contribution: INVENTORY[2], comparison: undefined, projection: resolved });
    expect(result.classification).toBe<AuditGapClassification>("EVIDENCE_INSUFFICIENT");
  });
  it("can_rewrite + 无可编辑稿 / quote 不可投影 → UNMAPPABLE_TARGET", () => {
    const noManuscript = classifyAuditGap({
      gap: gap("can_rewrite_from_existing_evidence"),
      contribution: INVENTORY[0],
      comparison: COMPARISONS[0],
      projection: { status: "unresolved", reason: "no-editable-manuscript" },
    });
    expect(noManuscript.classification).toBe<AuditGapClassification>("UNMAPPABLE_TARGET");
    const quoteMissing = classifyAuditGap({
      gap: gap("can_rewrite_from_existing_evidence"),
      contribution: INVENTORY[0],
      comparison: COMPARISONS[0],
      projection: { status: "unresolved", reason: "quote-not-found" },
    });
    expect(quoteMissing.classification).toBe<AuditGapClassification>("UNMAPPABLE_TARGET");
  });
  it("can_rewrite + INSUFFICIENT_EVIDENCE 且无可解析先前工作 → NEEDS_TARGETED_EVIDENCE", () => {
    const result = classifyAuditGap({ gap: gap("can_rewrite_from_existing_evidence"), contribution: INVENTORY[1], comparison: COMPARISONS[1], projection: resolved });
    expect(result.classification).toBe<AuditGapClassification>("NEEDS_TARGETED_EVIDENCE");
  });
  it("can_rewrite + 锚核验 + 投影成功 → REWRITE_ELIGIBLE（含可解析先前工作）", () => {
    const result = classifyAuditGap({ gap: gap("can_rewrite_from_existing_evidence"), contribution: INVENTORY[1], comparison: COMPARISONS[0], projection: resolved });
    expect(result.classification).toBe<AuditGapClassification>("REWRITE_ELIGIBLE");
  });
  it("allowedScopeText 随先前工作可解析性分化", () => {
    expect(allowedScopeText([{ title: "t", resolvesToPool: true }])).toContain("归因");
    expect(allowedScopeText([{ title: "t", resolvesToPool: false }])).toContain("不得新增比较结论");
    expect(allowedScopeText([])).toContain("不得新增比较结论");
  });
});

// ---- 服务编排 ----

describe("TargetAuditRevisionService（generate / decide / reassess）", () => {
  let root: string;
  let projects: ProjectStore;
  let papers: PaperStore;
  let revisions: ManuscriptRevisionStore;
  let externalInstructions: ExternalInstructionStore;
  let reviewArtifacts: ReviewArtifactStore;
  let service: TargetAuditRevisionService;
  let projectId: string;

  async function writeManuscript(): Promise<void> {
    const dir = join(projects.manuscriptDir(projectId), "sections");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "sec01.tex"), SEC01_TEX, "utf8");
    await writeFile(join(dir, "sec02.tex"), SEC02_TEX, "utf8");
    await writeFile(join(projects.manuscriptDir(projectId), "references.bib"), "@misc{ref1,\n  title={DB}\n}\n", "utf8");
  }

  async function writeAudit(artifact: ContributionAuditArtifact): Promise<void> {
    await mkdir(projects.researchDir(projectId), { recursive: true });
    await writeFile(
      join(projects.researchDir(projectId), "target-contribution-audit.json"),
      JSON.stringify(artifact, null, 1),
      "utf8",
    );
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-arev-"));
    projects = new ProjectStore({ root });
    papers = new PaperStore(projects);
    revisions = new ManuscriptRevisionStore({ projects });
    externalInstructions = new ExternalInstructionStore(projects);
    reviewArtifacts = new ReviewArtifactStore(projects);
    service = new TargetAuditRevisionService({
      projects,
      papers,
      revisions,
      externalInstructions,
      reviewArtifacts,
    });
    const project = await projects.create("审计修订计划测试", { documentType: "research_article" });
    projectId = project.id;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("无审计工件 → fail-closed", async () => {
    await expect(service.generatePlan(projectId)).rejects.toMatchObject({ code: "TARGET_AUDIT_PLAN_INVALID_STATE" });
    expect(await service.getPlan(projectId)).toBeNull();
    await expect(service.reassess(projectId)).rejects.toMatchObject({ code: "TARGET_AUDIT_PLAN_INVALID_STATE" });
  });

  it("审计陈旧（稿件内容变更）→ 409 fail-closed", async () => {
    await papers.saveIngest(projectId, makeDocument());
    await writeAudit(makeArtifact());
    const changed = makeDocument();
    changed.chunks = [
      ...changed.chunks.filter((chunk) => chunk.sectionId !== "SEC02"),
      {
        chunkId: "C0002b",
        sequence: 2,
        pageStart: 2,
        pageEnd: 2,
        sectionId: "SEC02",
        text: " materially different content after revision ",
        charCount: 44,
      },
    ];
    await papers.saveIngest(projectId, changed);
    await expect(service.generatePlan(projectId)).rejects.toMatchObject({
      code: "TARGET_AUDIT_STALE",
      message: expect.stringContaining("稿件内容已变更"),
    });
    // 恢复原文稿
    await papers.saveIngest(projectId, makeDocument());
  });

  it("generatePlan：分类 / 锚投影 / 禁止项快照 / 幂等", async () => {
    await writeManuscript();
    const view = await service.generatePlan(projectId);
    const plan = view.plan;
    expect(plan).not.toBeNull();
    const byClass = new Map(plan!.items.map((item) => [item.itemId, item.classification]));
    // ta-gap-1: requires_real；ta-gap-2: C2 锚核验 + quote 在 sec02 + comparison INSUFFICIENT（无 prior）→ NEEDS_TARGETED_EVIDENCE；
    // ta-gap-3: C3 anchorVerified=false → EVIDENCE_INSUFFICIENT
    expect(byClass.get("ta-gap-1")).toBe<AuditGapClassification>("NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT");
    expect(byClass.get("ta-gap-2")).toBe<AuditGapClassification>("NEEDS_TARGETED_EVIDENCE");
    expect(byClass.get("ta-gap-3")).toBe<AuditGapClassification>("EVIDENCE_INSUFFICIENT");
    expect(plan!.items[0]!.experimentPlan?.purpose).toBe("验证层级融合贡献");
    expect(plan!.items[0]!.anchor.claimQuote).toBe(CN_CLAIM);
    expect(plan!.source.manuscriptRevisionAtPlan).toBe(0); // 无 revisions.json → 0
    // 禁止项快照：ta-gap-1 投影到 sec01（无数值）→ 空清单是合法的；投影 resolved 的项文件存在
    const first = plan!.items[0]!;
    expect(first.anchor.projection.status).toBe("resolved");
    // 幂等：同一工件 + 同修订号 → 同 planId 直接返回
    const again = await service.generatePlan(projectId);
    expect(again.plan?.planId).toBe(plan!.planId);
    expect(again.fresh).toBe(true);
  });

  it("decide：approve 需实验项 → AUTHOR_DECISION_REQUIRED 指令（pending + 受控 statusNote，无 section）", async () => {
    const view = await service.decide(projectId, { decisions: [{ itemId: "ta-gap-1", decision: "approve" }] });
    const item = view.plan.items.find((entry) => entry.itemId === "ta-gap-1");
    expect(item?.authorDecision?.decision).toBe("approve");
    expect(item?.instructionId).toBeDefined();
    const instructions = await externalInstructions.load(projectId);
    const instruction = instructions.find((entry) => entry.instructionId === item?.instructionId);
    expect(instruction?.source).toBe("target_audit");
    expect(instruction?.status).toBe("pending");
    expect(instruction?.statusNote).toMatch(/^AUTHOR_DECISION_REQUIRED: /);
    expect(instruction?.section).toBeUndefined();
    expect(instruction?.text).toContain("验证层级融合贡献");
    expect(instruction?.text).toContain("不自动执行");
    // 部分决策 → 计划保持 generated（剩余条目可补交）
    expect(view.plan.status).toBe("generated");
  });

  it("decide：幂等重试不重复建指令；reject 不建指令", async () => {
    const before = (await externalInstructions.load(projectId)).length;
    const retry = await service.decide(projectId, { decisions: [{ itemId: "ta-gap-1", decision: "approve" }] });
    expect((await externalInstructions.load(projectId)).length).toBe(before);
    expect(retry.plan.items.find((entry) => entry.itemId === "ta-gap-1")?.authorDecision?.decision).toBe("approve");
    const rejected = await service.decide(projectId, { decisions: [{ itemId: "ta-gap-3", decision: "reject" }] });
    const rejectedItem = rejected.plan.items.find((entry) => entry.itemId === "ta-gap-3");
    expect(rejectedItem?.authorDecision?.decision).toBe("reject");
    expect(rejectedItem?.instructionId).toBeUndefined();
    expect(rejected.plan.summary.rejected).toBe(1);
  });

  it("decide：未知条目 / 非法决策值 → INVALID_REQUEST", async () => {
    await expect(
      service.decide(projectId, { decisions: [{ itemId: "ta-gap-99", decision: "approve" }] }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("全部条目决策后 → decided；venue 切换 → 计划陈旧拒绝后续决策", async () => {
    const view = await service.decide(projectId, { decisions: [{ itemId: "ta-gap-2", decision: "approve" }] });
    expect(view.plan.status).toBe("decided");
    // ta-gap-2（NEEDS_TARGETED_EVIDENCE）approve → 作者裁决指令（非 rewrite 不派发）
    const item = view.plan.items.find((entry) => entry.itemId === "ta-gap-2");
    expect(item?.instructionId).toBeDefined();
    // venue 切换：冻结指南切到 CEA → 旧计划陈旧
    await writeFile(
      join(projects.researchDir(projectId), "target-guideline.json"),
      JSON.stringify({ venueId: "cea" }),
      "utf8",
    );
    const staleView = await service.getPlan(projectId);
    expect(staleView?.fresh).toBe(false);
    expect(staleView?.staleReason).toContain("目标期刊已切换");
    await expect(
      service.decide(projectId, { decisions: [{ itemId: "ta-gap-1", decision: "approve" }] }),
    ).rejects.toMatchObject({ code: "TARGET_AUDIT_STALE" });
    // 还原 venue
    await rm(join(projects.researchDir(projectId), "target-guideline.json"), { force: true });
  });

  it("重新审计（新 evaluatedAt）+ 已决策计划 → 拒绝覆盖", async () => {
    const reaudited = makeArtifact({ evaluatedAt: "2026-10-31T02:00:00.000Z" });
    await writeAudit(reaudited);
    await expect(service.generatePlan(projectId)).rejects.toMatchObject({ code: "TARGET_AUDIT_PLAN_INVALID_STATE" });
    // 还原工件
    await writeAudit(makeArtifact());
  });

  it("reassess：待作者决策 / 作者拒绝 / pending 待派发 / patch lineage 复核", async () => {
    const report = await service.reassess(projectId);
    const byClosure = new Map(report.items.map((item) => [item.itemId, item.closure]));
    expect(byClosure.get("ta-gap-1")).toBe("NEEDS_AUTHOR_DECISION"); // 需实验项：合法终态
    expect(byClosure.get("ta-gap-3")).toBe("AUTHOR_REJECTED");
    expect(report.summary.total).toBe(3);

    // 模拟执行闭环：commit 一个修订（产品中由 revision.apply 完成）→ 写 patch 校验产物
    // （commentIds 指向 gap-1 指令）→ 指令状态机置 handled → 复评应给出 VALIDATED_FIXED
    const committed = await revisions.commit(projectId, "revision.apply", "run-test");
    expect(committed.revision).toBe(1);
    const instructions = await externalInstructions.load(projectId);
    const gap1 = instructions.find((entry) => entry.text.includes("ta-gap-1"));
    expect(gap1).toBeDefined();
    await reviewArtifacts.savePatchValidation(projectId, {
      revisionId: "rev-1",
      revision: 1,
      records: [
        {
          patchId: "patch:abc123def456",
          revisionId: "rev-1",
          file: "sections/sec01.tex",
          logicalTarget: "sec01",
          planItemIds: ["external:x-gap1"],
          commentIds: [gap1!.instructionId],
          evidenceIds: [],
          beforeFileHash: "h1",
          beforeTargetHash: "h2",
          proposedReplacementHash: "h3",
          afterFileHash: "h4",
          scope: { ok: true, violations: [] },
          workspaceIntegrity: { ok: true, directMutationDetected: false, recoverySucceeded: true },
          fact: { ok: true, findingIds: [], violations: [] },
          citation: { ok: true, findingIds: [], addedKeys: [], removedKeys: [], violations: [] },
          evidence: { ok: true, violations: [] },
          apply: { ok: true, status: "applied" },
          overall: "pass",
          finalStatus: "accepted",
        },
      ],
      summary: {
        totalPatches: 1,
        passedPatches: 1,
        failedPatches: 0,
        unattributedViolations: [],
        scopeOk: true,
        factOk: true,
        citationOk: true,
        evidenceOk: true,
        publishable: true,
        patchFirstPassPassRate: 1,
        patchRepairSuccessRate: 0,
        violationsByType: {},
        escalationCount: 0,
      },
    });
    // 指令状态 → handled（产品中由 applyDispatchOutcome 完成）
    await externalInstructions.update(projectId, (current) =>
      current.map((entry) =>
        entry.instructionId === gap1!.instructionId ? { ...entry, status: "handled" as const } : entry,
      ),
    );
    const report2 = await service.reassess(projectId);
    const gap1Item = report2.items.find((item) => item.itemId === "ta-gap-1");
    expect(gap1Item?.closure).toBe("VALIDATED_FIXED");
    expect(gap1Item?.patches?.[0]).toMatchObject({ patchId: "patch:abc123def456", revision: 1, finalStatus: "accepted" });
    expect(gap1Item?.verification?.fact).toBe(true);
    expect(report2.assessedAtRevision).toBe(1);
    // 修订号已前进 → 计划陈旧（决策入口关闭；复评不受影响，auditStaleNow 如实标注）
    const planView = await service.getPlan(projectId);
    expect(planView?.fresh).toBe(false);
    expect(report2.auditStaleNow).toBe(true);
  });
});

// ---- 接入纪律 ----

describe("target_audit 指令接入纪律", () => {
  const emptySummary: ReviewSummary = {
    round: 1,
    generatedAt: "2026-10-31T00:00:00.000Z",
    issues: [],
    counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
    scores: { academicScore: null, styleRisk: null, factVerdicts: null },
    openCritical: 0,
    openMajor: 0,
    unsupportedCriticalClaims: 0,
    reportPaths: [],
  };

  it("buildRevisionPlan：target_audit → priority=high（不高于真人 mandatory）", () => {
    const plan = buildRevisionPlan({
      projectId: "p-x",
      sourceRevision: 1,
      reviewRound: 1,
      summary: emptySummary,
      externalInstructions: [
        {
          instructionId: "x-audit",
          source: "target_audit",
          text: "审计建议",
          status: "pending",
          createdAt: "2026-10-31T00:00:00.000Z",
          updatedAt: "2026-10-31T00:00:00.000Z",
        },
        {
          instructionId: "x-human",
          source: "journal_reviewer",
          text: "真人意见",
          status: "pending",
          createdAt: "2026-10-31T00:00:00.000Z",
          updatedAt: "2026-10-31T00:00:00.000Z",
        },
      ],
    });
    const audit = plan.items.find((item) => item.id === "external:x-audit");
    const human = plan.items.find((item) => item.id === "external:x-human");
    expect(audit?.priority).toBe("high");
    expect(human?.priority).toBe("mandatory");
    expect(plan.items[0]?.id).toBe("external:x-human"); // 真人意见先派发
  });

  it("buildRevisionPlan：AUTHOR_DECISION_REQUIRED statusNote → skipped + author_decision_required", () => {
    const plan = buildRevisionPlan({
      projectId: "p-x",
      sourceRevision: 1,
      reviewRound: 1,
      summary: emptySummary,
      externalInstructions: [
        {
          instructionId: "x-exp",
          source: "target_audit",
          text: "需实验",
          status: "pending",
          statusNote: "AUTHOR_DECISION_REQUIRED: 需真实实验",
          createdAt: "2026-10-31T00:00:00.000Z",
          updatedAt: "2026-10-31T00:00:00.000Z",
        },
      ],
    });
    const item = plan.items.find((entry) => entry.id === "external:x-exp");
    expect(item?.status).toBe("skipped");
    expect(item?.actionType).toBe("author_decision_required");
  });

  it("ExternalInstructionStore.add：pending 态接受 AUTHOR_DECISION 前缀 statusNote（受控白名单）", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-arev-add-"));
    const projects = new ProjectStore({ root });
    const store = new ExternalInstructionStore(projects);
    const project = await projects.create("add 测试", { documentType: "research_article" });
    const created = await store.add(project.id, {
      source: "target_audit",
      text: "需实验差距",
      statusNote: "AUTHOR_DECISION_REQUIRED: 需真实实验",
    });
    expect(created?.status).toBe("pending");
    expect(created?.statusNote).toMatch(/^AUTHOR_DECISION_REQUIRED/);
    // 非白名单前缀 → pending 态不携带 statusNote（人工通道语义不变）
    const plain = await store.add(project.id, { source: "user", text: "普通意见", statusNote: "随便写的说明" });
    expect(plain?.status).toBe("pending");
    expect(plain?.statusNote).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it("指令文案：rewrite 指令携带锚 / 禁止项 / 来源指纹；authorDecision 指令含实验计划与不伪造声明", () => {
    const plan: TargetAuditRevisionPlanArtifact = {
      schemaVersion: 1,
      planId: "tap-abc123-rev1",
      projectId: "p-x",
      source: {
        auditArtifact: "research/target-contribution-audit.json",
        inputFingerprint: {
          manuscriptSha256: "abc123def4567890",
          poolFingerprint: "pool",
          promptVersion: "m1514-caudit-v1",
          documentType: "research_article",
        },
        auditEvaluatedAt: "2026-10-31T01:00:00.000Z",
        documentType: "research_article",
        manuscriptRevisionAtPlan: 1,
      },
      createdAt: "2026-10-31T02:00:00.000Z",
      status: "generated",
      items: [],
      summary: { total: 0, rewriteEligible: 0, needsRealExperiment: 0, needsTargetedEvidence: 0, evidenceInsufficient: 0, unmappable: 0, approved: 0, rejected: 0 },
    };
    const rewriteItem = {
      itemId: "ta-gap-2",
      contributionId: "C2",
      gap: "前后不一致",
      sourceActionType: "can_rewrite_from_existing_evidence" as const,
      classification: "REWRITE_ELIGIBLE" as const,
      classificationReason: "理由",
      anchor: {
        claimQuote: CN_CLAIM,
        sectionId: "SEC01",
        anchorVerified: true,
        projection: { status: "resolved" as const, file: "sections/sec01.tex", basis: "quote-replay" as const, ambiguous: false },
      },
      priorWork: [{ title: "DB", year: 2020, doi: "10.1/x", resolvesToPool: true, priorQuoteVerified: true }],
      forbidden: { values: ["87.5"], citationKeys: ["ref1"] },
      allowedScope: allowedScopeText([{ title: "DB", resolvesToPool: true }]),
    };
    const rewriteText = rewriteInstructionText(rewriteItem, plan);
    expect(rewriteText).toContain("tap-abc123-rev1");
    expect(rewriteText).toContain("abc123def4567890");
    expect(rewriteText).toContain(CN_CLAIM);
    expect(rewriteText).toContain("sections/sec01.tex");
    expect(rewriteText).toContain("不得新增数值");
    expect(authorDecisionStatusNote(rewriteItem, plan)).toMatch(/^AUTHOR_DECISION_REQUIRED: /);
  });
});
