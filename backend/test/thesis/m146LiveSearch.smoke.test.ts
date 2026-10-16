/**
 * M14.6 — 实时学术检索路径探针（env 门控：PAPERTEAM_M146_LIVE_SEARCH=1；默认跳过，不进 CI；零模型调用）。
 *
 * M14.5 零参考文献的直接原因：testStack 缺省禁用全部学术 provider（生产栈缺省启用 OpenAlex / arXiv / S2）。
 * 本探针以生产同一检索链（ResearchDiscoveryService.academicSearch → saveAcademicCandidates →
 * SourceImportService.promoteCandidate → tryResolveFullText → TargetedGroundingService.prepareSource）在本机
 * 直连 OpenAlex / arXiv 探测案例 B 的文献主题；**不**执行 groundClaims（证据判定需模型调用；预算留给 F5 等
 * 核心 smoke）。因此本探针只能证明「实时检索 / 候选 / 全文获取 / 分块」可达，不证明正式 Evidence 可形成。
 *
 * 运行：PAPERTEAM_M146_LIVE_SEARCH=1 npx vitest run test/thesis/m146LiveSearch.smoke.test.ts
 * 产物：D:\PaperTeamData\M14_6\smoke\live-search-<ts>.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createScriptedRuntime } from "../../src/runtime/scriptedRuntime.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

const live = process.env["PAPERTEAM_M146_LIVE_SEARCH"] === "1";
const outDir = process.env["PAPERTEAM_M146_OUT"] ?? "D:\\PaperTeamData\\M14_6\\smoke";

/** 案例 B 文献主题（大纲 literatureRefs 的英文检索形态；OpenAlex 对中文查询召回极差） */
const THEMES = ["quadrotor downwash effect neural network prediction", "nonlinear model predictive control quadrotor trajectory tracking"];

describe.skipIf(!live)("M14.6 实时学术检索探针（OpenAlex / arXiv 直连；零模型调用）", () => {
  let stack: TestStack | undefined;
  afterAll(async () => {
    await stack?.cleanup();
  });

  it("academicSearch → 候选 → promote → 全文 → 分块（不做 grounding）", { timeout: 600_000 }, async () => {
    const scripted = createScriptedRuntime({ reviewSequence: ["pass"] });
    stack = await startTestStack(scripted.runtime, {
      // 只禁用无法直连 / 需凭据的 provider；OpenAlex + arXiv 真实直连；全文 resolver 走缺省（OpenAlex OA + arXiv PDF）
      search: { disabledProviders: ["semantic-scholar", "aminer", "searxng"], providerTimeoutMs: 20_000 },
      fullText: { enabled: true },
    });
    const created = await stack.request("POST", "/api/projects", { title: "Quadrotor close-proximity flight with neural network downwash prediction and NMPC", language: "zh", documentType: "master_thesis" });
    expect(created.status).toBe(201);
    const projectId = (created.body["project"] as { id: string })["id"];
    const services = stack.stack;
    const report: Record<string, unknown> = { themes: [] as unknown[] };
    const themesOut: unknown[] = [];
    const promoted: string[] = [];
    let modelCalls = 0;
    const originalRunAgent = scripted.runtime.runAgent.bind(scripted.runtime);
    scripted.runtime.runAgent = async (input) => {
      modelCalls += 1;
      return originalRunAgent(input);
    };
    for (const theme of THEMES) {
      const startedAt = Date.now();
      const response = await services.discovery.academicSearch(theme, { limit: 6 }, projectId);
      const results = response.results.map((item) => ({ title: item.record.title, year: item.record.year ?? null, doi: item.identity.doi ?? null, arxivId: item.identity.arxivId ?? null, providers: item.sources.map((entry) => entry.provider) }));
      const saved = await services.discovery.saveAcademicCandidates(projectId, theme, response.results, response.results.map((_, index) => index).slice(0, 4));
      themesOut.push({ theme, ms: Date.now() - startedAt, results: results.length, saved: saved.saved.length, sample: results.slice(0, 4) });
      for (const candidate of saved.saved.slice(0, 2)) {
        try {
          const result = await services.sourceImport.promoteCandidate(projectId, candidate.candidateId, { sourceRole: "evidence", deferFullText: true, selectionReason: "m146-live-search-probe" });
          promoted.push(result.source.sourceId);
        } catch (error) {
          themesOut.push({ theme, promoteError: (error as Error).message.slice(0, 200) });
        }
      }
    }
    const fullText: unknown[] = [];
    for (const sourceId of promoted.slice(0, 3)) {
      const startedAt = Date.now();
      try {
        const resolved = await services.sourceImport.tryResolveFullText(projectId, sourceId);
        let chunks: unknown = null;
        if (resolved.outcome === "resolved" || resolved.outcome === "skipped_has_file") {
          if ((await services.ingestion.getDocument(projectId, sourceId)) === null) {
            try {
              await services.ingestion.ingest(projectId, sourceId);
            } catch (error) {
              chunks = { ingestError: (error as Error).message.slice(0, 200) };
            }
          }
          if (chunks === null) {
            const indexed = await services.workflowServices.targetedGrounding.prepareSource(projectId, sourceId);
            chunks = { status: indexed.status, chunkCount: indexed.chunkCount, reason: indexed.reason ?? null };
          }
        }
        fullText.push({ sourceId, outcome: resolved.outcome, note: resolved.note ?? null, ms: Date.now() - startedAt, chunks });
      } catch (error) {
        fullText.push({ sourceId, error: (error as Error).message.slice(0, 200), ms: Date.now() - startedAt });
      }
    }
    report["themes"] = themesOut;
    report["promoted"] = promoted.length;
    report["fullText"] = fullText;
    report["modelCalls"] = modelCalls;
    report["candidates"] = (await services.candidates.list(projectId)).filter((candidate) => candidate.origin === "academic_search").length;
    report["formalEvidence"] = (await services.workflowServices.evidenceSelection.selectForWriting(projectId)).formal.length;
    report["note"] = "groundClaims（模型判定）未执行——正式 Evidence 预期为 0；本探针只证明检索 / 候选 / 全文 / 分块路径可达";
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const outPath = join(outDir, `live-search-${stamp}.json`);
    await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[m146-live-search] ${JSON.stringify({ themes: themesOut.map((entry) => ({ theme: (entry as { theme: string }).theme, results: (entry as { results?: number }).results, saved: (entry as { saved?: number }).saved })), promoted: promoted.length, fullText: fullText.map((entry) => (entry as { outcome?: string; error?: string }).outcome ?? (entry as { error?: string }).error), modelCalls })}`);
    console.log(`[m146-live-search] 产物：${outPath}`);
    expect(modelCalls).toBe(0);
    expect(themesOut.some((entry) => ((entry as { results?: number }).results ?? 0) > 0)).toBe(true);
    expect(report["candidates"] as number).toBeGreaterThan(0);
  });
});
