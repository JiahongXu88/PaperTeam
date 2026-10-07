/**
 * M12 Batch 2 Smoke A：Target Publication 全链 live smoke（真实 OpenAlex）。
 *
 * 运行：
 *   PAPERTEAM_LIVE_SMOKE=1 npx vitest run test/target/targetPipelineLive.smoke.test.ts
 * 默认跳过（不进默认 CI）。Batch 1 Smoke A（benchmark 冻结链）之上补 A7/A8：
 *   真实 discovery → 冻结 → TargetProfileService.ensureCurrent（确定性提取；
 *   真实语料无全文 → 维度覆盖如实不足，不伪造全文统计）
 *   → 手稿 fixture → TargetGapService.evaluate（六维四档判决 + 结构化 gap）
 *
 * 诚实性断言：profile 维度 availability 只能来自真实可观测数据（无全文 →
 * unavailable/insufficient，reason 明示）；readiness 的 gap 携带「不构成稿件
 * 事实错误」限定语；无新数值分数门。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import { SourceImportService } from "../../src/sources/SourceImportService.js";
import { AcademicSearchService } from "../../src/search/academicSearchService.js";
import { OpenAlexSearchProvider } from "../../src/search/openalexProvider.js";
import { ProviderHttpClient } from "../../src/search/providerHttp.js";
import { VenueResolutionService } from "../../src/search/venueResolution.js";
import { buildTargetServices } from "../../src/target/services.js";
import { setupTargetHarness, EIGHT_PAPERS } from "./profileFixtures.js";
import { loadConfig } from "../../src/config/config.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelSettingsStore, resolveStartupModelSpec } from "../../src/settings/ModelSettingsStore.js";
import { parseModelSpec } from "../../src/runtime/PiRuntimeAdapter.js";
import type { TargetSummaryModel } from "../../src/target/TargetProfileService.js";
import { ParsedDocumentStore } from "../../src/ingestion/ParsedDocumentStore.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import type { TargetReadinessArtifact } from "../../src/target/types.js";

const live = process.env["PAPERTEAM_LIVE_SMOKE"] === "1";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** 极简手稿 fixture（真实 .tex，供 readiness 确定性观测） */
const MANUSCRIPT_TEX = [
  "\\documentclass{article}",
  "\\begin{document}",
  "\\section{Introduction}",
  "Multi-object tracking is important. We cite \\cite{ref1}.",
  "\\section{Method}",
  "Our method uses a gating mechanism. As shown in Figure~\\ref{fig:overview}.",
  "\\begin{figure}[t]",
  "  \\includegraphics{figs/overview.pdf}",
  "  \\caption{System overview.}",
  "  \\label{fig:overview}",
  "\\end{figure}",
  "\\section{Experiments}",
  "We evaluate on the MOT17 dataset. Our method achieves MOTA 75.1 in Table~\\ref{tab:main}.",
  "\\begin{table}[t]",
  "  \\caption{Main results.}",
  "  \\label{tab:main}",
  "  \\begin{tabular}{lc}",
  "    Method & MOTA \\\\",
  "    Ours & 75.1 \\\\",
  "  \\end{tabular}",
  "\\end{table}",
  "\\end{document}",
].join("\n");

describe.skipIf(!live)("M12 Batch 2 Smoke A：target 全链（真实 OpenAlex → profile → readiness）", () => {
  const http = new ProviderHttpClient({ defaultTimeoutMs: 20_000, defaultMaxRetries: 1 });

  it(
    "CVPR/MOT 真实发现 → 冻结 → 确定性 profile（覆盖如实）→ readiness 四档判决",
    { timeout: 300_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "paperteam-smokea2-"));
      roots.push(root);
      const projects = new ProjectStore({ root });
      const created = await projects.create("Smoke A target pipeline live", {
        researchField: "multi-object tracking",
        documentType: "conference_paper",
        targetProfile: "high_level_conference",
        targetVenue: "CVPR",
      });
      const projectId = created.id;
      const sources = new SourceStore(projects);
      const candidates = new CandidateStore(projects);
      const imports = new SourceImportService({ projects, sources, candidates, log: () => {} });
      const parsedDocuments = new ParsedDocumentStore(projects);
      const revisions = new ManuscriptRevisionStore({ projects });
      const venues = new VenueResolutionService({ http });
      const targets = buildTargetServices({
        projects,
        academic: new AcademicSearchService({
          providers: [new OpenAlexSearchProvider({ http })],
        }),
        venues,
        candidates,
        imports,
        sources,
        parsedDocuments,
        revisions,
        // 不装配 summaryModel：本 smoke 验证确定性主轴；method/writing 如实 UNAVAILABLE
        log: () => {},
      });

      // 1) 真实发现 + 冻结（Batch 1 A6 默认流程）
      const frozen = await targets.discovery.discoverAndFreeze(projectId, {
        target: {
          documentType: "conference_paper",
          targetProfile: "high_level_conference",
          targetVenue: "CVPR",
          researchField: "multi-object tracking",
        },
      });
      const effectivePapers = frozen.artifact.papers.filter((paper) => paper.excluded === undefined);
      expect(effectivePapers.length).toBeGreaterThanOrEqual(4);
      expect(effectivePapers.every((paper) => paper.venueRaw !== "")).toBe(true);
      expect(effectivePapers.filter((paper) => paper.citationCount !== undefined).length).toBeGreaterThan(0);

      // 2) 确定性 profile：真实语料无全文（metadata-only）→ 维度覆盖如实不足
      const { profile } = await targets.profile.ensureCurrent(projectId);
      expect(profile.benchmarkRevision).toBe(frozen.artifact.revision);
      expect(profile.corpusFingerprint).toBe(frozen.artifact.fingerprint);
      expect(profile.n).toBe(effectivePapers.length);
      // 无全文语料：结构/文献/实验/视觉维度不得声称 available-with-data
      for (const dim of ["structure", "literature", "experiments", "visuals"] as const) {
        const entry = profile.dimensions[dim];
        expect(["unavailable", "insufficient"]).toContain(entry.availability);
        expect(entry.coverage).toBe(0);
        expect(entry.reason ?? "").not.toBe("");
      }
      // 未装配摘要模型 → method/writing 如实 UNAVAILABLE
      expect(profile.dimensions.method.availability).toBe("unavailable");
      expect(profile.dimensions.writing.availability).toBe("unavailable");
      const profileOnDisk = JSON.parse(
        await readFile(join(projects.researchDir(projectId), "target-profile.json"), "utf8"),
      ) as { provenance: { modelSummarizedFields: string[] } };
      expect(profileOnDisk.provenance.modelSummarizedFields).toEqual([]);
      // 幂等：同语料同指纹 → ensureCurrent 不重建
      const again = await targets.profile.ensureCurrent(projectId);
      expect(again.regenerated).toBe(false);

      // 3) 手稿 fixture → readiness：确定性观测 + 四档判决 + gap 限定语
      const manuscriptDir = projects.manuscriptDir(projectId);
      await mkdir(join(manuscriptDir, "figs"), { recursive: true });
      await writeFile(join(manuscriptDir, "main.tex"), MANUSCRIPT_TEX, "utf8");
      const readiness = (await targets.gap.evaluate(projectId)) as TargetReadinessArtifact;
      expect(readiness.benchmarkRevision).toBe(frozen.artifact.revision);
      expect(readiness.dimensions.length).toBe(6);
      const verdicts = new Set(readiness.dimensions.map((entry) => entry.verdict));
      for (const verdict of verdicts) {
        expect(["MEETS_TARGET", "PARTIALLY_MEETS_TARGET", "BELOW_TARGET", "INSUFFICIENT_EVIDENCE"]).toContain(
          verdict,
        );
      }
      // 无全文参照系的维度 → INSUFFICIENT_EVIDENCE（语料侧证据不足是真实结论）
      const insufficient = readiness.dimensions.filter((entry) => entry.verdict === "INSUFFICIENT_EVIDENCE");
      expect(insufficient.length).toBeGreaterThan(0);
      // 结构化 gap 携带「距离语义」限定语（不是稿件事实错误）
      for (const entry of readiness.dimensions) {
        for (const gap of entry.gaps) {
          expect(gap.includes("不构成稿件事实错误")).toBe(true);
        }
      }
      expect(readiness.provenance.basis).toBe("benchmark_observation");
      // 原始 artifact 无数值分数
      const readinessRaw = await readFile(
        join(projects.researchDir(projectId), "target-readiness.json"),
        "utf8",
      );
      expect(readinessRaw.includes("targetScore")).toBe(false);
    },
  );

  it(
    "A7 摘要模型 live 验收：真实 GLM 调用 → method/writing 模型摘要（provenance 标注）",
    { timeout: 300_000 },
    async () => {
      const config = loadConfig();
      const modelRuntime = await ModelRuntime.create({
        authPath: join(config.pi.agentDir, "auth.json"),
        modelsPath: join(config.pi.agentDir, "models.json"),
      });
      const modelSettingsStore = new ModelSettingsStore({
        settingsDir: join(config.runtimeRoot, "settings"),
      });
      const defaultModel = await resolveStartupModelSpec(undefined, modelSettingsStore);
      expect(defaultModel).toBeDefined();
      const parsedSpec = parseModelSpec(defaultModel!);
      expect(parsedSpec).toBeDefined();
      const catalogEntry = modelRuntime.getModel(parsedSpec!.provider, parsedSpec!.modelId);
      expect(catalogEntry).toBeDefined();
      expect(modelRuntime.hasConfiguredAuth(parsedSpec!.provider)).toBe(true);

      const summaryModel: TargetSummaryModel = {
        caller: modelRuntime,
        catalogEntry,
        spec: defaultModel!,
      };
      const harness = await setupTargetHarness(EIGHT_PAPERS, { summaryModel, roots });
      const { profile } = await harness.profile.ensureCurrent(harness.projectId);
      // 真实模型路径的两维：available（成功）或带 summaryFailure 的诚实失败——两种都合法
      for (const dim of ["method", "writing"] as const) {
        const entry = profile.dimensions[dim];
        expect(["available", "unavailable"]).toContain(entry.availability);
        if (entry.availability === "available") {
          expect(profile.provenance.model).toBe(defaultModel);
          expect(profile.provenance.modelSummarizedFields.length).toBeGreaterThan(0);
        } else {
          expect(profile.provenance.summaryFailure ?? "").not.toBe("");
        }
      }
      console.log(
        "[smoke-a] summary:",
        JSON.stringify({
          model: profile.provenance.model,
          method: profile.dimensions.method.availability,
          writing: profile.dimensions.writing.availability,
          failure: profile.provenance.summaryFailure?.slice(0, 160),
        }),
      );
    },
  );
});
