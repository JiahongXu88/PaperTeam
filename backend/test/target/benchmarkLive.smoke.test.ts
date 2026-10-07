/**
 * M12 Batch 1 Smoke A：Target benchmark 全链 live smoke（真实 OpenAlex）。
 *
 * 运行：
 *   PAPERTEAM_LIVE_SMOKE=1 npx vitest run test/target/benchmarkLive.smoke.test.ts
 * 默认跳过（不进默认 CI）；live API 不稳定不作为单测失败依据（同 searchLive 惯例）。
 *
 * 验证链（任务书 §19 Smoke A）：
 *   venue → venueResolution（种子 + 真实 /sources lookup 两路径）
 *   → discovery（真实 OpenAlex venue 服务端过滤 + citationCount）
 *   → selectRecommended（引用数排序）
 *   → role=reference 入库（SourceStore）
 *   → 冻结 research/target-benchmark.json（revision/fingerprint/sufficiency）
 *   → Benchmark/Evidence 隔离（入库后源不在 corpus 资格内、propose 被拒的
 *     服务层前提成立——role 恒 reference）
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import { SourceImportService } from "../../src/sources/SourceImportService.js";
import { AcademicSearchService } from "../../src/search/academicSearchService.js";
import { OpenAlexSearchProvider } from "../../src/search/openalexProvider.js";
import { ProviderHttpClient } from "../../src/search/providerHttp.js";
import { BenchmarkDiscoveryService } from "../../src/search/benchmarkDiscoveryService.js";
import { VenueResolutionService } from "../../src/search/venueResolution.js";
import { TargetBenchmarkService } from "../../src/target/TargetBenchmarkService.js";
import { isCorpusEligible } from "../../src/survey/CorpusSnapshotService.js";

const live = process.env["PAPERTEAM_LIVE_SMOKE"] === "1";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!live)("M12 Batch 1 Smoke A：benchmark 全链（真实 OpenAlex）", () => {
  const http = new ProviderHttpClient({ defaultTimeoutMs: 20_000, defaultMaxRetries: 1 });

  it(
    "CVPR 种子解析 → venue 服务端过滤发现 → 引用数排序 → role=reference 入库 → 冻结",
    { timeout: 180_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "paperteam-smokea-"));
      roots.push(root);
      const projects = new ProjectStore({ root });
      const project = await projects.create("Smoke A benchmark live");
      const projectId = project.id;
      const sources = new SourceStore(projects);
      const candidates = new CandidateStore(projects);
      const imports = new SourceImportService({ projects, sources, candidates, log: () => {} });
      const academic = new AcademicSearchService({
        providers: [new OpenAlexSearchProvider({ http })],
      });
      const venues = new VenueResolutionService({ http });
      const targets = new TargetBenchmarkService({
        projects,
        listSources: async () =>
          (await sources.list(projectId)).map((item) => ({
            sourceId: item.sourceId,
            sourceRole: item.sourceRole,
            status: item.status,
            ...(item.fileName !== undefined ? { fileName: item.fileName } : {}),
          })),
        log: () => {},
      });
      const service = new BenchmarkDiscoveryService({
        projects,
        academic,
        venues,
        candidates,
        imports,
        sources,
        targets,
        log: () => {},
      });

      // ---- 1) venue 解析：种子表命中 CVPR（真实种子文件加载） ----
      const resolved = await venues.resolve("CVPR");
      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        expect(resolved.openalexSourceId).toBe("S4210176548");
      }

      // ---- 2) 未种子 venue 走真实 /sources lookup（曲线检验在线路径） ----
      const lookup = await venues.resolve("IEEE Signal Processing Magazine");
      expect(["resolved", "ambiguous", "not_found"]).toContain(lookup.status);

      // ---- 3) discoverAndFreeze 全链（真实 OpenAlex venue 过滤检索） ----
      const result = await service.discoverAndFreeze(projectId, {
        target: {
          documentType: "conference_paper",
          targetProfile: "top_conference",
          targetVenue: "CVPR",
          researchField: "multi-object tracking",
          timeWindow: { from: 2019, to: 2025 },
        },
        targetCount: 8,
      });

      expect(result.discovery.venueResolution).toMatchObject({ status: "resolved" });
      expect(result.discovery.venueDegraded).toBe(false);
      // 真实 venue 过滤应带回带引用数的候选
      expect(result.discovery.candidates.length).toBeGreaterThan(4);
      expect(
        result.discovery.candidates.some((candidate) => candidate.citationCount !== undefined),
      ).toBe(true);

      // ---- 4) 入库恒 role=reference ----
      expect(result.savedSourceIds.length).toBeGreaterThan(0);
      const saved = await sources.list(projectId);
      const savedById = new Map(saved.map((item) => [item.sourceId, item]));
      for (const sourceId of result.savedSourceIds) {
        const item = savedById.get(sourceId);
        expect(item).toBeDefined();
        expect(item!.sourceRole).toBe("reference");
      }

      // ---- 5) 冻结 artifact：revision=0、指纹、sufficiency 标记 ----
      expect(result.alreadyFrozen).toBe(false);
      expect(result.artifact.revision).toBe(0);
      expect(result.artifact.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(["sufficient", "insufficient"]).toContain(result.selection.selection.sufficiency);
      expect(result.artifact.papers.length).toBeGreaterThan(0);
      expect(result.artifact.papers.some((paper) => paper.citationCount !== undefined)).toBe(true);
      // 落盘验证
      const raw = JSON.parse(
        await readFile(join(projects.researchDir(projectId), "target-benchmark.json"), "utf8"),
      );
      expect(raw.schemaVersion).toBe(1);

      // ---- 6) Evidence 隔离前提：入库源不满足 corpus 资格（isCorpusEligible 谓词） ----
      for (const sourceId of result.savedSourceIds) {
        const item = savedById.get(sourceId)!;
        expect(isCorpusEligible(item)).toBe(false);
      }

      // ---- 7) 幂等：重复 discoverAndFreeze 不改写冻结集合 ----
      const again = await service.discoverAndFreeze(projectId, {
        target: {
          documentType: "conference_paper",
          targetProfile: "top_conference",
          targetVenue: "CVPR",
          researchField: "multi-object tracking",
        },
        targetCount: 8,
      });
      expect(again.alreadyFrozen).toBe(true);
      expect(again.artifact.fingerprint).toBe(result.artifact.fingerprint);
    },
  );
});
