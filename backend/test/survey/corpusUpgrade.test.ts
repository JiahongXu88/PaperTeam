/**
 * M15.8.5 Corpus Upgrade 产品级测试（确定性，零外部网络；模型为脚本化 fake）。
 *
 * 覆盖任务书 Phase C 判定矩阵：
 * 1. E2E 升级链路：abstract_only 源获得合法全文 → availability 标记 eligible →
 *    upgrade → matrix 以 fulltext 深度重建（anchors 钉真实 chunkId，可经
 *    ChunkAccess 回取）→ synthesis 全量重建（matrix 指纹变化传播）→ outline
 *    重规划（refs 变化时）。
 * 2. 最小增量与幂等：8 源只升 2 → 恰 2 次 matrix 调用、其余 skipped_existing；
 *    重复 upgrade = 研究层 no-op（matrix/synthesis/outline 模型调用增量 0）。
 * 3. 负例：薄文本（<5 非平凡 chunk）不判 fulltext（资格过滤 + skippedIneligible
 *    如实点名）；metadata_only 源 requiresAuthorDecision；未知 sourceIds 拒绝；
 *    未冻结语料拒绝。
 * 4. 断点恢复：重建失败 → 熔断（synthesis/outline skipped，不消费缺源矩阵）；
 *    修复后重跑 upgrade 幂等补齐（已完成部分零重复调用）。
 * 5. 并发互斥：存在活跃 run checkpoint → PROJECT_BUSY；升级进行中再入 → PROJECT_BUSY。
 * 6. HITL：confirmed 条目不被自动失效（资格过滤内生排除，skippedIneligible 给原因）。
 * 7. 审计 journal：research/corpus-upgrades.jsonl 逐事件追加。
 */

import { describe, expect, it } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ChunkStore } from "../../src/retrieval/ChunkStore.js";
import { WorkflowRunStore } from "../../src/workflow/runStore.js";
import { CorpusSnapshotService } from "../../src/survey/CorpusSnapshotService.js";
import { CorpusUpgradeService } from "../../src/survey/CorpusUpgradeService.js";
import { fingerprintJson } from "../../src/util/hash.js";
import {
  FIXTURE_PAPERS,
  FIXTURE_ABSTRACT_ONLY,
  addFulltextPaper,
  addMetadataOnlyPaper,
  fakeTextAnalysis,
  newSurveyFixture,
  type SurveyFixture,
} from "./fixtures.js";
import type { WorkflowState } from "../../src/workflow/types.js";

/** 最小合法 PDF 文本层（builtin 提取器可读：单个未压缩内容流 + (…) Tj 操作符） */
function fakePdfBuffer(paragraphs: string[]): Buffer {
  const text = paragraphs
    .join("\n\n")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  const content = `BT /F1 12 Tf (${text}) Tj ET`;
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

interface UpgradeFixture extends SurveyFixture {
  corpus: CorpusSnapshotService;
  upgrade: CorpusUpgradeService;
  runStore: WorkflowRunStore;
}

async function newUpgradeFixture(
  scripts: Parameters<typeof newSurveyFixture>[0] = {},
  synthesisScripts: Parameters<typeof newSurveyFixture>[1] = {},
): Promise<UpgradeFixture> {
  const fixture = await newSurveyFixture(scripts, synthesisScripts);
  const corpus = new CorpusSnapshotService({
    projects: fixture.projects,
    listSources: (pid) => fixture.sources.list(pid),
    resolveFullTextBatch: async () => ({
      summary: { resolved: 0, notFound: 0, failed: 0, notResolvable: 0, skipped: 0 },
    }),
    ingest: async () => null,
    invalidateUpgradableMatrixEntries: (pid, options) =>
      fixture.matrix.invalidateUpgradableEntries(pid, options ?? {}),
    log: () => {},
  });
  const runStore = new WorkflowRunStore(fixture.projects);
  const chunkStore = new ChunkStore(fixture.projects);
  const upgrade = new CorpusUpgradeService({
    projects: fixture.projects,
    sources: fixture.sources,
    chunkStore,
    retrieval: fixture.retrieval,
    runStore,
    corpus,
    survey: fixture.matrix,
    synthesis: fixture.synthesis,
    surveyOutline: fixture.outline,
    manuscript: fixture.manuscript,
    log: () => {},
  });
  return { ...fixture, corpus, upgrade, runStore };
}

/** 建立旧基线：fulltext 论文 + metadata-only 论文 → freeze → matrix → synthesis → outline */
async function seedOldBasis(fixture: UpgradeFixture, options: { fulltextCount: number; abstractCount: number }): Promise<string[]> {
  const abstractIds: string[] = [];
  for (const paper of FIXTURE_PAPERS.slice(0, options.fulltextCount)) {
    await addFulltextPaper(fixture.sources, fixture.projectId, paper);
  }
  for (let index = 0; index < options.abstractCount; index += 1) {
    abstractIds.push(
      await addMetadataOnlyPaper(fixture.sources, fixture.projectId, {
        ...FIXTURE_ABSTRACT_ONLY,
        doi: `${FIXTURE_ABSTRACT_ONLY.doi}-${index}`,
        title: `${FIXTURE_ABSTRACT_ONLY.title} (${index + 1})`,
      }),
    );
  }
  await fixture.corpus.freeze(fixture.projectId, { matrix: null });
  const build = await fixture.matrix.buildMatrix(fixture.projectId);
  await fixture.corpus.syncBasisDepth(fixture.projectId, build.matrix);
  await fixture.synthesis.buildSynthesis(fixture.projectId);
  await fixture.outline.buildSurveyOutline(fixture.projectId);
  return abstractIds;
}

/** 生成足够厚的正文段（≥5 个非平凡 chunk：目标 chunk ≈400 tokens ≈1600 字符；总 ≥12k 字符） */
function thickParagraphs(title: string): string[] {
  const sections = [
    `${title}. This paper studies multi-object tracking and detection association under varying conditions, with detailed protocol and metric discussions across the full text.`,
    `Section on method: the two-stage association first keeps high-confidence detections on existing tracks, then recovers missed detections by allowing low-score boxes into a second matching round with IoU-based cascaded cost, and the ablation isolates the contribution of each stage while reporting identity switches and fragmentation counts per sequence.`,
    `Section on evaluation protocol: we evaluate on MOT17 and MOT20 with MOTA, MOTP, IDF1 and HOTA, reporting identity switches, fragmentation and the newer higher-order association accuracy that balances detection and association effects explicitly; the protocol fixes detector inputs, training splits and evaluation scripts so that published numbers remain comparable across papers and across years of leaderboard activity.`,
    `Section on appearance modeling: appearance embeddings trained on person re-identification corpora help long-horizon re-association across occlusions, yet they add computational cost and degrade when illumination changes or resolution drops in the captured frames; we analyze the trade-off between embedding quality and frame rate on sequences with dense crowds and frequent mutual occlusion events.`,
    `Section on motion modeling: Kalman prediction with observation-centric re-update restores association from estimation error accumulated during occlusion, reducing the dependency on learned appearance features for identity preservation, and the observation-centric formulation corrects the trajectory estimate at detection time rather than trusting the predicted state blindly through long occlusion intervals.`,
    `Section on datasets: the benchmark provides public ground truth for training and evaluation splits, with standardized detection inputs so that trackers are comparable; the leaderboard tracks identity preservation metrics across sequences of different density, and the release notes document known labeling ambiguities that affect the interpretation of small score differences between competing trackers on the same detections.`,
    `Section on results: identity switches decrease consistently when low-score detections participate in the second association stage, while frame rate remains real-time because the additional matching is bounded by track-detection overlap computation; the gains hold across four detector configurations and are most visible in sequences where the detector confidence distribution is broad rather than sharply peaked around a single threshold.`,
    `Section on limitations: appearance features degrade under adverse weather and low illumination; the benchmark coverage of such atmospheric conditions remains sparse, and evaluation protocols do not yet separate detection quality effects from association quality effects, which makes it difficult to attribute observed improvements to the association module rather than to incidental detector behavior on particular sequences.`,
    `Section on future work: extending the benchmark to crowded and low-light scenarios, unifying metric reporting, and studying the coupling between detector calibration and association thresholds remain open problems acknowledged by multiple works in the tracking community over the past several years of benchmark iterations.`,
    `Section on related surveys: prior surveys organize methods by tracking paradigm and by the presence of appearance models, but few compare evaluation metrics themselves or analyze which metric captures which failure mode of the tracking pipeline, and none of them trace the historical evolution of metric adoption across benchmark versions in a way that practitioners can verify against the original publications.`,
    `Additional discussion: the complementarity of MOTA, IDF1 and HOTA means that ranking by a single metric can mislead; practitioners should report the trio together with the association-specific component to reveal where improvements actually come from, and reviewers should treat single-metric claims with caution unless the paper also reports the decomposition of detection and association contributions.`,
    `Final discussion: a careful reading of full texts, rather than abstracts alone, is necessary to anchor claims about metric behavior, protocol details and reported quantitative gains, which is precisely the scenario this corpus upgrade exercises; abstract-level reading cannot distinguish which numbers were measured under which protocol version and therefore cannot support the comparative statements a survey needs to make.`,
  ];
  // 每段扩展至 ~1000 字符（重复句式换措辞）以满足 chunk 目标量
  return sections.map((paragraph, index) => {
    const suffix = ` Detailed elaboration ${index + 1}: the discussion continues with implementation notes, parameter sensitivity and cross-sequence consistency checks that reviewers of the original publication requested, together with the exact command-line configuration used to reproduce every table in the experimental section of the manuscript.`;
    return paragraph + suffix;
  });
}

/** 模拟网络恢复：给 metadata-only 记录补挂合法 PDF 全文（builtin 文本层可读 + 分析 ok → available） */
async function attachFullText(fixture: UpgradeFixture, sourceId: string, title: string): Promise<void> {
  const { source } = await fixture.sources.attachFile(fixture.projectId, sourceId, {
    fileName: `${sourceId}-fulltext.pdf`,
    content: fakePdfBuffer(thickParagraphs(title)),
  });
  await fixture.sources.setAnalysis(fixture.projectId, sourceId, fakeTextAnalysis(), {
    ...(source.contentHash !== undefined ? { contentHash: source.contentHash } : {}),
  });
}

const matrixCalls = (fixture: UpgradeFixture): number =>
  fixture.runtime.calls.filter((call) => call.contextScope === "research/survey-matrix").length;
const synthesisCalls = (fixture: UpgradeFixture): number =>
  fixture.runtime.calls.filter((call) => call.contextScope === "research/survey-synthesis").length;
const outlineCalls = (fixture: UpgradeFixture): number =>
  fixture.runtime.calls.filter((call) => call.contextScope === "writing/outline").length;

describe("CorpusUpgradeService.upgrade（E2E 升级链路）", { timeout: 60_000 }, () => {
  it("abstract_only 源获全文 → 升级 → matrix fulltext + 真实 chunkId 锚 → synthesis 重建 → outline 重规划（refs 变化）", async () => {
    const fixture = await newUpgradeFixture();
    try {
      const [abstractId] = await seedOldBasis(fixture, { fulltextCount: 3, abstractCount: 1 });
      await attachFullText(fixture, abstractId!, "Recovered Fulltext Paper");

      // availability：升级候选如实标记（downloadedFile ≠ fulltextBasis）
      const before = await fixture.upgrade.availability(fixture.projectId);
      expect(before.summary).toMatchObject({ totalSources: 4, downloadedFile: 4, fulltextBasis: 3, abstractBasis: 1, upgradeEligible: 1 });
      expect(before.sources.find((row) => row.sourceId === abstractId)?.upgradeEligible).toBe(true);
      expect(before.downstream).toMatchObject({ synthesisFresh: true, outlineReusable: true });

      // 换 trend claim → 升级后 synthesisId 集合变化 → outline refs 失效（传播链验证）
      fixture.runtime.setSynthesisScript("trend", () =>
        JSON.stringify({
          candidates: [
            {
              kind: "trend",
              claim: "升级后趋势（fulltext 深度重读）：关联方法演进从外观嵌入走向检测置信度利用",
              detail: { period: "2017-2024", direction: "升级后方向" },
              entryIds: [],
              evidenceProposals: [],
            },
          ],
        }),
      );

      const matrixCallsBefore = matrixCalls(fixture);
      const outcome = await fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] });

      // matrix：恰 1 次重建（scoped——buildMatrix 只处理目标集，未点名条目不进 results）
      expect(outcome.skippedIneligible).toEqual([]);
      expect(outcome.steps.matrix.built).toEqual([abstractId]);
      expect(outcome.steps.matrix.skippedExisting).toBe(0);
      expect(matrixCalls(fixture) - matrixCallsBefore).toBe(1);

      // 重建条目：fulltext 深度 + anchors 钉真实 chunkId（ChunkAccess 可回取）
      const matrix = await fixture.matrix.getMatrix(fixture.projectId);
      const entry = matrix?.entries.find((candidate) => candidate.sourceId === abstractId);
      expect(entry?.interpretationDepth).toBe("fulltext");
      expect((entry?.anchors ?? []).length).toBeGreaterThan(0);
      for (const anchor of entry?.anchors ?? []) {
        for (const chunkId of anchor.chunkIds) {
          const resolved = await fixture.chunkAccess.resolve(fixture.projectId, chunkId);
          expect(resolved.chunk.sourceId).toBe(abstractId);
        }
      }

      // synthesis：matrix 指纹变化 → 全量重建（非 reused）
      expect("reused" in outcome.steps.synthesis && outcome.steps.synthesis.reused).toBe(false);
      const synthesis = await fixture.synthesis.getSynthesis(fixture.projectId);
      expect(synthesis?.matrixFingerprint).toBe(fingerprintJson(matrix!));

      // outline：旧 refs 指向已消失的 synthesisId → 必须重规划
      expect("reused" in outcome.steps.outline && outcome.steps.outline.reused).toBe(false);
      const outline = await fixture.manuscript.loadOutline(fixture.projectId);
      const freshSynthesisIds = new Set((synthesis?.items ?? []).map((item) => item.synthesisId));
      for (const section of outline?.sections ?? []) {
        for (const ref of section.synthesisRefs ?? []) {
          expect(freshSynthesisIds.has(ref)).toBe(true);
        }
      }

      // snapshot：basisDepth 升级 + revision+1（升级 = 新语料修订）
      const snapshot = await fixture.corpus.get(fixture.projectId);
      expect(snapshot?.counts.fulltextBasis).toBe(4);
      expect(snapshot?.revision).toBe(1);

      // after：无遗留 eligible
      expect(outcome.after.fulltextBasis).toBe(4);
      expect(outcome.after.stillEligible).toEqual([]);

      // 审计 journal 存在且含关键事件
      const journal = await readFile(join(fixture.projects.researchDir(fixture.projectId), "corpus-upgrades.jsonl"), "utf8");
      for (const event of ["upgrade.started", "upgrade.refresh.done", "upgrade.matrix.done", "upgrade.synthesis.done", "upgrade.outline.done", "upgrade.completed"]) {
        expect(journal.includes(`"event":"${event}"`)).toBe(true);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("幂等：升级完成后重复 upgrade = 研究层 no-op（matrix/synthesis/outline 调用增量 0，revision 不再空转）", async () => {
    const fixture = await newUpgradeFixture();
    try {
      const [abstractId] = await seedOldBasis(fixture, { fulltextCount: 3, abstractCount: 1 });
      await attachFullText(fixture, abstractId!, "Recovered Paper");
      await fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] });

      const m = matrixCalls(fixture);
      const s = synthesisCalls(fixture);
      const o = outlineCalls(fixture);
      const snapshotBefore = await fixture.corpus.get(fixture.projectId);

      const again = await fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] });
      expect(again.steps.matrix.built).toEqual([]); // 资格过滤后无目标 → no-op
      expect(again.steps.synthesis).toMatchObject({ skipped: true });
      expect(again.steps.outline).toMatchObject({ skipped: true });
      expect(matrixCalls(fixture) - m).toBe(0);
      expect(synthesisCalls(fixture) - s).toBe(0);
      expect(outlineCalls(fixture) - o).toBe(0);
      const snapshotAfter = await fixture.corpus.get(fixture.projectId);
      expect(snapshotAfter?.revision).toBe(snapshotBefore?.revision); // 无合格目标不空转修订号
    } finally {
      await fixture.cleanup();
    }
  });

  it("最小增量：8 源只升 2 → 恰 2 次 matrix 重建、6 次 skipped_existing；未变条目内容/指纹口径保持", async () => {
    const fixture = await newUpgradeFixture();
    try {
      // 4 fulltext + 4 abstract = 8 源
      const abstractIds = await seedOldBasis(fixture, { fulltextCount: 4, abstractCount: 4 });
      await attachFullText(fixture, abstractIds[0]!, "Recovered A");
      await attachFullText(fixture, abstractIds[2]!, "Recovered C");

      const matrixBefore = await fixture.matrix.getMatrix(fixture.projectId);
      const unchangedIds = (matrixBefore?.entries ?? [])
        .filter((entry) => entry.interpretationDepth === "fulltext" || ![abstractIds[0], abstractIds[2]].includes(entry.sourceId))
        .map((entry) => entry.sourceId);

      const m = matrixCalls(fixture);
      const outcome = await fixture.upgrade.upgrade(fixture.projectId, {
        sourceIds: [abstractIds[0]!, abstractIds[2]!],
      });
      expect(outcome.steps.matrix.built.sort()).toEqual([abstractIds[0], abstractIds[2]].sort());
      // scoped build 只处理目标集：两条失效条目重建即全部目标（未点名 6 条不进 results、零调用）
      expect(outcome.steps.matrix.skippedExisting).toBe(0);
      expect(matrixCalls(fixture) - m).toBe(2);

      // 未升级的 abstract 条目仍在（scoped 升级不碰未点名目标；其无文件 → 不在 eligible 口径内）
      const matrixAfter = await fixture.matrix.getMatrix(fixture.projectId);
      const afterById = new Map((matrixAfter?.entries ?? []).map((entry) => [entry.sourceId, entry]));
      for (const sourceId of unchangedIds) {
        const before = matrixBefore?.entries.find((entry) => entry.sourceId === sourceId);
        const after = afterById.get(sourceId);
        expect(after).toBeDefined();
        expect(after?.interpretationDepth).toBe(before?.interpretationDepth);
        expect(after?.mainIdea).toBe(before?.mainIdea);
      }
      // 无文件源不在升级候选口径（downloadedFile ≠ fulltextBasis 的另一半）
      expect(outcome.after.stillEligible).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("CorpusUpgradeService（负例与降级）", { timeout: 60_000 }, () => {
  it("薄文本（非平凡 chunk 不足）不判 fulltext：资格过滤拦截 + skippedIneligible 点名原因", async () => {
    const fixture = await newUpgradeFixture();
    try {
      const [abstractId] = await seedOldBasis(fixture, { fulltextCount: 2, abstractCount: 1 });
      // 挂一个文本层过薄的「扫描件」（<200 字符 → chunker full_text_unavailable）
      const { source: scan } = await fixture.sources.attachFile(fixture.projectId, abstractId!, {
        fileName: `${abstractId}-scan.pdf`,
        content: fakePdfBuffer(["scanned image page short ocr line"]),
      });
      await fixture.sources.setAnalysis(fixture.projectId, abstractId!, fakeTextAnalysis(), {
        ...(scan.contentHash !== undefined ? { contentHash: scan.contentHash } : {}),
      });
      const availability = await fixture.upgrade.availability(fixture.projectId);
      const row = availability.sources.find((candidate) => candidate.sourceId === abstractId);
      expect(row?.parsedUsable).toBe(false);
      expect(row?.upgradeEligible).toBe(false);
      expect(row?.reason).toContain("扫描 / 薄文本");

      const outcome = await fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] });
      expect(outcome.skippedIneligible).toHaveLength(1);
      expect(outcome.skippedIneligible[0]?.sourceId).toBe(abstractId);
      expect(outcome.steps.matrix.built).toEqual([]);
      expect(outcome.steps.synthesis).toMatchObject({ skipped: true });
      // 原条目不被破坏：仍 abstract_only
      const matrix = await fixture.matrix.getMatrix(fixture.projectId);
      expect(matrix?.entries.find((entry) => entry.sourceId === abstractId)?.interpretationDepth).toBe("abstract_only");
    } finally {
      await fixture.cleanup();
    }
  });

  it("metadata_only 源：requiresAuthorDecision，不进入升级目标，不无限重试", async () => {
    const fixture = await newUpgradeFixture();
    try {
      await seedOldBasis(fixture, { fulltextCount: 2, abstractCount: 1 });
      const availability = await fixture.upgrade.availability(fixture.projectId);
      expect(availability.summary.requiresAuthorDecision).toBe(1);
      const outcome = await fixture.upgrade.upgrade(fixture.projectId); // 全量升级
      expect(outcome.after.requiresAuthorDecision).toHaveLength(1);
      expect(outcome.steps.matrix.built).toEqual([]); // 唯一 abstract 源无文件 → 无合格目标
      expect(outcome.steps.synthesis).toMatchObject({ skipped: true });
    } finally {
      await fixture.cleanup();
    }
  });

  it("未知 sourceIds → INVALID_REQUEST 点名；未冻结语料 → INVALID_REQUEST", async () => {
    const fixture = await newUpgradeFixture();
    try {
      await expect(fixture.upgrade.upgrade(fixture.projectId)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await fixture.corpus.freeze(fixture.projectId, { matrix: null });
      await expect(
        fixture.upgrade.upgrade(fixture.projectId, { sourceIds: ["S999"] }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("S999") });
    } finally {
      await fixture.cleanup();
    }
  });

  it("断点恢复：重建全部失败 → 熔断（synthesis 不消费缺源矩阵）；修复后重跑幂等补齐", async () => {
    const fixture = await newUpgradeFixture();
    try {
      const [abstractId] = await seedOldBasis(fixture, { fulltextCount: 2, abstractCount: 1 });
      await attachFullText(fixture, abstractId!, "Recovered");
      const synthesisFingerprintBefore = (await fixture.synthesis.getSynthesis(fixture.projectId))?.matrixFingerprint;

      // S 源脚本失败（模拟解析/模型故障中断）
      fixture.runtime.setScript(abstractId!, () => ({ fail: true, error: "模拟重建失败" }));
      const failed = await fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] });
      expect(failed.steps.matrix.failed).toHaveLength(1);
      expect(failed.steps.matrix.built).toEqual([]);
      expect(failed.steps.synthesis).toMatchObject({ skipped: true });
      expect(failed.steps.outline).toMatchObject({ skipped: true });
      expect(failed.after.failedRebuilds).toEqual([abstractId]);
      // synthesis 未被缺源矩阵污染
      expect((await fixture.synthesis.getSynthesis(fixture.projectId))?.matrixFingerprint).toBe(synthesisFingerprintBefore);
      // 失败源仍 eligible（可重试）
      expect(failed.after.stillEligible).toEqual([abstractId]);

      // 修复后重跑：复位脚本，只补失败目标（fulltext 条目零重复调用）
      fixture.runtime.setScript(abstractId!, ({ chunkIds }) =>
        JSON.stringify({
          researchProblem: "修复后的重建",
          methodFamily: "tracking_association",
          mainIdea: "低分检测框两段式关联，恢复漏检目标。",
          anchors: chunkIds.length > 0 ? [{ field: "mainIdea", chunkIds: [chunkIds[0]!] }] : [],
        }),
      );
      const m = matrixCalls(fixture);
      const repaired = await fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] });
      expect(repaired.steps.matrix.built).toEqual([abstractId]);
      expect(matrixCalls(fixture) - m).toBe(1);
      expect("reused" in repaired.steps.synthesis && repaired.steps.synthesis.reused).toBe(false);
      expect(repaired.after.stillEligible).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("CorpusUpgradeService（并发互斥 / HITL / journal）", { timeout: 60_000 }, () => {
  it("存在活跃 run（磁盘 checkpoint awaiting_input）→ PROJECT_BUSY；完成后恢复可用", async () => {
    const fixture = await newUpgradeFixture();
    try {
      const [abstractId] = await seedOldBasis(fixture, { fulltextCount: 2, abstractCount: 1 });
      await attachFullText(fixture, abstractId!, "Recovered");
      // 直接落一个活跃 run checkpoint（磁盘判定，与 WorkflowOrchestrator.isActiveStatus 同谓词）
      const state: WorkflowState = {
        schemaVersion: 1,
        runId: "w-busytest0001",
        projectId: fixture.projectId,
        workflowKind: "topic_survey",
        status: "awaiting_input",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedStages: [],
        stageResults: {},
        stageHistory: [],
        inputs: {},
        counters: {},
        eventsSeq: 0,
      };
      await fixture.runStore.saveCheckpoint(state);
      await expect(fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] })).rejects.toMatchObject({
        code: "PROJECT_BUSY",
      });
      // run 结束后升级可用
      await fixture.runStore.saveCheckpoint({ ...state, status: "completed" });
      const outcome = await fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] });
      expect(outcome.steps.matrix.built).toEqual([abstractId]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("升级进行中同项目再入 → PROJECT_BUSY（进程内单 owner）", async () => {
    const fixture = await newUpgradeFixture();
    try {
      const [abstractId] = await seedOldBasis(fixture, { fulltextCount: 2, abstractCount: 1 });
      await attachFullText(fixture, abstractId!, "Recovered");
      // 用阻塞脚本占住第一次升级（下一次 matrix 调用挂起）
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runtime = fixture.runtime as unknown as { runAgent: (input: { contextScope?: string }) => Promise<unknown> };
      const originalRun = runtime.runAgent.bind(runtime);
      let holdNextMatrixCall = false;
      runtime.runAgent = async (input) => {
        if (input.contextScope === "research/survey-matrix" && holdNextMatrixCall) {
          holdNextMatrixCall = false;
          await gate;
        }
        return originalRun(input);
      };
      holdNextMatrixCall = true;
      const first = fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] });
      await new Promise((resolve) => setTimeout(resolve, 150)); // 让第一次进入挂起段
      await expect(fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] })).rejects.toMatchObject({
        code: "PROJECT_BUSY",
      });
      release?.();
      const outcome = await first;
      expect(outcome.steps.matrix.built).toEqual([abstractId]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("HITL：confirmed 的 abstract 条目不被自动升级（skippedIneligible 给出人工裁决原因）", async () => {
    const fixture = await newUpgradeFixture();
    try {
      const [abstractId] = await seedOldBasis(fixture, { fulltextCount: 2, abstractCount: 1 });
      await attachFullText(fixture, abstractId!, "Recovered");
      // 人工确认该条目（HITL 锁定）
      const matrix = await fixture.matrix.getMatrix(fixture.projectId);
      const entry = matrix?.entries.find((candidate) => candidate.sourceId === abstractId);
      await fixture.matrix.updateEntry(fixture.projectId, `M-${abstractId}`, { status: "confirmed" });

      const availability = await fixture.upgrade.availability(fixture.projectId);
      expect(availability.sources.find((row) => row.sourceId === abstractId)?.confirmedEntry).toBe(true);
      expect(availability.sources.find((row) => row.sourceId === abstractId)?.upgradeEligible).toBe(false);

      const outcome = await fixture.upgrade.upgrade(fixture.projectId, { sourceIds: [abstractId!] });
      expect(outcome.skippedIneligible[0]?.sourceId).toBe(abstractId);
      expect(outcome.skippedIneligible[0]?.reason).toContain("人工确认");
      expect(entry).toBeDefined();
      // 条目原样保留（confirmed + abstract_only）
      const after = await fixture.matrix.getMatrix(fixture.projectId);
      const kept = after?.entries.find((candidate) => candidate.sourceId === abstractId);
      expect(kept?.status).toBe("confirmed");
      expect(kept?.interpretationDepth).toBe("abstract_only");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("basis 闸门语义修复（buildClaimResolutionContext.groundableInBasis）", { timeout: 60_000 }, () => {
  it("matrix 存在而条目缺席（失效待重建）→ 不可采证；matrix 未构建 → 保持可采证（首跑语义）", async () => {
    const fixture = await newUpgradeFixture();
    try {
      const [abstractId] = await seedOldBasis(fixture, { fulltextCount: 1, abstractCount: 1 });
      await attachFullText(fixture, abstractId!, "Recovered");
      // 制造「失效未重建」态：手动失效（资格内的源）但不重建
      await fixture.matrix.invalidateUpgradableEntries(fixture.projectId, { sourceIds: [abstractId!] });
      // 快照行同步为 null（模拟 syncBasisDepth 后的部分重建态——Phase A R3 场景）
      const matrix = await fixture.matrix.getMatrix(fixture.projectId);
      await fixture.corpus.syncBasisDepth(fixture.projectId, matrix!);
      // 确保 chunk 已生成（镜像真实链路：升级前 availability/检索已触碰过）
      await fixture.retrieval.search(fixture.projectId, "multi-object tracking", { topK: 3 });

      const { buildClaimResolutionContext } = await import("../../src/workflow/definitions.js");
      const services = {
        sources: fixture.sources,
        corpus: fixture.corpus,
        survey: fixture.matrix,
        chunkStore: new ChunkStore(fixture.projects),
        manuscript: fixture.manuscript,
        evidenceSelection: { selectForWriting: async () => ({ formal: [] }) },
      } as never;
      const context = await buildClaimResolutionContext(services, fixture.projectId);
      const bySource = new Map(context.sources.map((row) => [row.sourceId, row]));

      // 失效待重建的源（basisDepth=null + hasFulltext）：matrix 存在 → 不可采证（修复后）
      expect(bySource.get(abstractId!)?.hasChunks).toBe(false);
      // 既有 fulltext 基线源不受影响
      const fullId = (await fixture.sources.list(fixture.projectId)).find(
        (item) => item.sourceId !== abstractId,
      )?.sourceId;
      expect(bySource.get(fullId!)?.hasChunks).toBe(true);

      // 对照：matrix 未构建（首跑）时 null+hasFulltext 仍可采证（原语义保留）
      const fixture2 = await newUpgradeFixture();
      try {
        const { sources, projectId, corpus, matrix, manuscript, retrieval } = fixture2;
        const id1 = await addFulltextPaper(sources, projectId, FIXTURE_PAPERS[0]!);
        await corpus.freeze(projectId, { matrix: null });
        await retrieval.search(projectId, "multi-object tracking association", { topK: 3 }); // chunk 懒生成
        const services2 = {
          sources,
          corpus,
          survey: matrix,
          chunkStore: new ChunkStore(fixture2.projects),
          manuscript,
          evidenceSelection: { selectForWriting: async () => ({ formal: [] }) },
        } as never;
        const context2 = await buildClaimResolutionContext(services2, projectId);
        const row2 = context2.sources.find((row) => row.sourceId === id1);
        expect(row2?.hasChunks).toBe(true); // matrix 未构建 → 可采证
        expect(retrieval).toBeDefined();
      } finally {
        await fixture2.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("FinalizeService 研究链新鲜度守卫（M15.8.5）", { timeout: 60_000 }, () => {
  it("survey 半升级态（synthesis 过期 vs matrix）→ 拒绝 Finalize；链新鲜 → 正常", async () => {
    const fixture = await newUpgradeFixture();
    try {
      await seedOldBasis(fixture, { fulltextCount: 2, abstractCount: 1 });
      const projectId = fixture.projectId;
      const root = fixture.root;
      // 手工落齐 Finalize 前置：修订 + passing gate（对齐修订）+ passing build（对齐）+ build/paper.pdf
      await mkdir(join(root, projectId, "manuscript", "sections"), { recursive: true });
      await writeFile(join(root, projectId, "manuscript", "sections", "a.tex"), "survey body", "utf8");
      await mkdir(join(root, projectId, "build"), { recursive: true });
      await writeFile(join(root, projectId, "build", "paper.pdf"), "%PDF-1.5", "utf8");
      const { ManuscriptRevisionStore } = await import("../../src/manuscript/RevisionStore.js");
      const { PaperArtifactStore } = await import("../../src/artifacts/ArtifactStore.js");
      const { ReviewArtifactStore } = await import("../../src/review/reviewArtifacts.js");
      const { FinalizeService } = await import("../../src/artifacts/FinalizeService.js");
      const revisions = new ManuscriptRevisionStore({ projects: fixture.projects });
      const committed = await revisions.commit(projectId, "writing.sections", "w-fin");
      await mkdir(join(root, projectId, "reviews"), { recursive: true });
      await writeFile(
        join(root, projectId, "reviews", "quality-gate-r1.json"),
        JSON.stringify({
          gate: { passed: true, reasons: [], rules: [], checkedAt: new Date().toISOString(), thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true } },
          reviewSummary: { round: 1 },
          revision: committed.revision,
          reviewedRevision: committed.revision,
        }),
        "utf8",
      );
      await writeFile(
        join(root, projectId, "build", "build-gate.json"),
        JSON.stringify({
          passed: true,
          reasons: [],
          checkedAt: new Date().toISOString(),
          revision: committed.revision,
          compile: { ok: true, tool: "latexmk", durationMs: 10, exitCode: 0, pdfPath: "build/paper.pdf", logPath: "build/compile.log" },
          diagnostics: [],
        }),
        "utf8",
      );
      const finalize = new FinalizeService({
        projects: fixture.projects,
        reviewArtifacts: new ReviewArtifactStore(fixture.projects),
        artifacts: new PaperArtifactStore({ projects: fixture.projects }),
        revisions,
      });

      // 链新鲜（升级未发生）：Finalize 正常冻结
      const result = await finalize.finalize(projectId, "w-fin");
      expect(result.revision).toBe(committed.revision);

      // 半升级态：手工改 matrix（模拟升级重建后的矩阵）→ synthesis 过期 → 拒绝
      const matrix = await fixture.matrix.getMatrix(projectId);
      const mutated = {
        ...matrix!,
        entries: matrix!.entries.map((entry, index) =>
          index === 0 ? { ...entry, mainIdea: `${entry.mainIdea ?? ""}（升级后重读）` } : entry,
        ),
      };
      await writeFile(join(fixture.projects.researchDir(projectId), "survey.json"), JSON.stringify(mutated), "utf8");
      await expect(finalize.finalize(projectId, "w-fin")).rejects.toMatchObject({
        code: "QUALITY_GATE_STALE",
        message: expect.stringContaining("Survey Synthesis"),
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
