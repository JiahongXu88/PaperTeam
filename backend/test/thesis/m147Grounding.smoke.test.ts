/**
 * M14.7 Smoke — 实时学术检索 → 全文 → Grounding（真实模型 judge）→ 正式 Evidence 真实闭环。
 *
 * M14.6 §17.1 遗留：实时链路只验证到「全文 / 分块可达」，groundClaims（模型判定）从未真实
 * 执行，正式 Evidence 形成未验证（引用闭环以 Crossref 核验的 fixture 元数据验收）。
 *
 * 本 smoke 在生产同一链上补齐（任务 §4.2 十项检查）：
 *   1. 真实搜索发现论文（OpenAlex / arXiv 直连，S2/Aminer/SearXNG 禁用——本机不可达 / 需凭据）；
 *   2. 候选保存 + 提升（sourceRole=evidence，selectionReason 明示「claim support unverified」）；
 *   3. 合法可访问全文解析（OpenAlex OA / arXiv PDF resolver；不配 Unpaywall——无邮箱配置）；
 *   4. 内容分块（retrieval index）；
 *   5. 与论断相关的片段（词面 Top-K + 逐字 quote 窗口）；
 *   6. 生产同款 Grounding Judge（EvidenceGroundingService.ground → runtime.runAgent）；
 *   7. 正式验证（quote 逐字校验 + 元数据核验 + 语义判定）；
 *   8. 写入 EvidenceStore（evidence/evidence.jsonl，verified/fulltext/direct）；
 *   9. Writer 可引用（selectForWriting().formal + A 组 key 解析 resolveEvidenceCitationKey）；
 *   10. 合法 Citation Key（canonical bibliography 条目 + key 命中）。
 *
 * 预算纪律（任务 §4.4）：judge ≤ 4 次（阶段账本硬上限 + 服务层 maxJudgeCalls 双保险）；
 * 拒绝结果如实保留（不为引用出现绕过验证）。零调用断言不适用——本 smoke 本来就是模型 smoke。
 *
 * 运行（Windows 本机，backend/）：
 *   PAPERTEAM_M147_GROUNDING=1 npx vitest run test/thesis/m147Grounding.smoke.test.ts
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, afterAll } from "vitest";

import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { registerStoredCustomProviders } from "../../src/settings/ModelSettingsService.js";
import { ModelSettingsStore, resolveStartupModelSpec } from "../../src/settings/ModelSettingsStore.js";
import { GlobalBudgetLedger } from "../helpers/globalBudgetLedger.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import type { AgentRuntime } from "../../src/runtime/types.js";
import { LegacyPdfTextParser } from "../../src/ingestion/LegacyPdfTextParser.js";
import { PyMuPdfParser } from "../../src/paper/PdfParser.js";
import { assignCitationKeys, buildBibliographyFromSources, renderBibliographyFile, resolveEvidenceCitationKey } from "../../src/citation/bibliography.js";

const live = process.env["PAPERTEAM_M147_GROUNDING"] === "1";

/** 论断与主题一一对应（英文检索词对 OpenAlex/arXiv 召回质量最好；论断是真实研究命题） */
const CLAIM_TOPICS = [
  {
    theme: "quadrotor downwash effect aerodynamic disturbance prediction",
    claim:
      "Quadrotor UAVs flying in close proximity experience significant aerodynamic downwash disturbances that degrade trajectory tracking performance, and these disturbances can be modeled or predicted with data-driven approaches.",
  },
  {
    theme: "nonlinear model predictive control quadrotor trajectory tracking real-time",
    claim:
      "Nonlinear model predictive control enables quadrotors to track trajectories accurately under explicit state and input constraints, with real-time solvers making onboard deployment feasible.",
  },
] as const;

/** §4.4：本阶段 judge 调用硬上限（与服务层 RESEARCH_SUPPLY_JUDGE_CALL_LIMIT 同值） */
const JUDGE_CALL_CAP = 4;

describe.skipIf(!live)("M14.7 Smoke — 实时检索 Grounding → 正式 Evidence 闭环", () => {
  let adapter: PiRuntimeAdapter | undefined;
  let stack: TestStack | undefined;
  afterAll(async () => {
    await stack?.cleanup().catch(() => undefined);
    await adapter?.close().catch(() => undefined);
  });

  it("search → fulltext → chunk → judge → verified evidence → citable key", { timeout: 900_000 }, async () => {
    const outDir = process.env["PAPERTEAM_M147_OUT"] ?? "D:\\PaperTeamData\\M14_7\\smoke";
    const runtimeRoot =
      process.env["PAPERTEAM_M147_RUNTIME_ROOT"] ?? join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? tmpdir(), ".paperteam");
    const phaseLedgerPath = process.env["PAPERTEAM_M147_GROUNDING_LEDGER"] ?? join(outDir, "m147-grounding-budget.json");
    const model = process.env["PAPERTEAM_M147_MODEL"] ?? "zai-coding-cn/glm-5.3";

    // ---- 真实模型 runtime（生产同款 judge 通道；凭据不打印、不入库） ----
    const agentDir = join(runtimeRoot, "runtime", "pi", "agent");
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const customProviderStore = new CustomProviderStore({ settingsDir: join(runtimeRoot, "settings") });
    await registerStoredCustomProviders(modelRuntime, customProviderStore, () => {});
    const startupSpec = await resolveStartupModelSpec(model, new ModelSettingsStore({ settingsDir: join(runtimeRoot, "settings") }));
    expect(startupSpec).toBeDefined();
    const projectsRoot = await mkdtemp(join(outDir, "grounding-projects-"));
    adapter = new PiRuntimeAdapter({ modelSpec: startupSpec!, agentDir, workspaceRoot: projectsRoot, runTimeoutMs: 300_000, modelRuntime });

    // ---- 双层预算：阶段账本（judge ≤ 4 硬上限）+ 主全局账本（本轮 40 共享） ----
    const phaseLedger = new GlobalBudgetLedger(phaseLedgerPath, "m147-grounding", { maxCalls: JUDGE_CALL_CAP, maxTokens: 400_000 });
    type UsageShape = Partial<Record<"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "estimatedCost", number>>;
    interface UsageTotals { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCost: number }
    const usageTotals: UsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0 };
    const prompts: Array<{ scope: string; task: string; output: string; usage?: UsageShape; durationMs: number }> = [];
    const target = adapter;
    const counting: AgentRuntime = new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj);
        if (prop === "runAgent" && typeof value === "function") {
          return async (input: { task: string; contextScope?: string }) => {
            phaseLedger.chargeCall();
            usageTotals.calls += 1;
            const startedAt = Date.now();
            const task = (await (value as (...a: unknown[]) => Promise<unknown>).apply(obj, [input])) as { output?: string; usage?: UsageShape };
            const usage = task.usage ?? {};
            usageTotals.inputTokens += usage.inputTokens ?? 0;
            usageTotals.outputTokens += usage.outputTokens ?? 0;
            usageTotals.cacheReadTokens += usage.cacheReadTokens ?? 0;
            usageTotals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
            usageTotals.estimatedCost += usage.estimatedCost ?? 0;
            phaseLedger.chargeUsage(task.usage);
            prompts.push({
              scope: input.contextScope ?? "(unknown)",
              task: input.task.slice(0, 4000),
              output: (task.output ?? "").slice(0, 4000),
              ...(task.usage !== undefined ? { usage: task.usage } : {}),
              durationMs: Date.now() - startedAt,
            });
            return task;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
      },
    }) as unknown as AgentRuntime;

    // ---- 生产栈：真实 provider + 全文 resolver + PyMuPDF 解析（smoke 不走 docling） ----
    stack = await startTestStack(counting, {
      search: { disabledProviders: ["semantic-scholar", "aminer", "searxng"], providerTimeoutMs: 20_000 },
      fullText: { enabled: true },
      root: projectsRoot,
      ingestion: {
        structuredParser: new LegacyPdfTextParser({ pdfParser: new PyMuPdfParser({}) }),
        fallbackParser: new LegacyPdfTextParser({ pdfParser: new PyMuPdfParser({}) }),
      },
    });
    const services = stack.stack;
    const created = await stack.request("POST", "/api/projects", {
      title: "Quadrotor close-proximity flight: downwash prediction and NMPC (M14.7 grounding probe)",
      language: "zh",
      documentType: "master_thesis",
    });
    expect(created.status).toBe(201);
    const projectId = (created.body["project"] as { id: string })["id"];

    const report: Record<string, unknown> = { startedAt: new Date().toISOString(), projectId, themes: [] as unknown[] };

    // ---- 1-4：真实检索 → 候选 → 提升 → 全文 → 分块 ----
    const themesOut: unknown[] = [];
    const promoted: Array<{ sourceId: string; title: string; doi: string | null; arxivId: string | null }> = [];
    for (const topic of CLAIM_TOPICS) {
      const startedAt = Date.now();
      const response = await services.discovery.academicSearch(topic.theme, { limit: 6 }, projectId);
      const results = response.results.map((item) => ({
        title: item.record.title,
        year: item.record.year ?? null,
        doi: item.identity.doi ?? null,
        arxivId: item.identity.arxivId ?? null,
        providers: item.sources.map((entry) => entry.provider),
      }));
      const saved = await services.discovery.saveAcademicCandidates(projectId, topic.theme, response.results, response.results.map((_, index) => index).slice(0, 4));
      themesOut.push({ theme: topic.theme, ms: Date.now() - startedAt, results: results.length, saved: saved.saved.length, sample: results.slice(0, 4) });
      for (const candidate of saved.saved.slice(0, 2)) {
        try {
          const result = await services.sourceImport.promoteCandidate(projectId, candidate.candidateId, {
            sourceRole: "evidence",
            deferFullText: true,
            selectionReason: "m147-grounding-smoke: academic identity + complete metadata; claim support unverified",
          });
          promoted.push({
            sourceId: result.source.sourceId,
            title: (result.source.metadata.title ?? candidate.title) as string,
            doi: result.source.metadata.doi ?? null,
            arxivId: result.source.metadata.arxivId ?? null,
          });
        } catch (error) {
          themesOut.push({ theme: topic.theme, promoteError: (error as Error).message.slice(0, 200) });
        }
      }
    }
    report["themes"] = themesOut;
    report["promoted"] = promoted;

    const fullText: unknown[] = [];
    const usable: string[] = [];
    for (const entry of promoted.slice(0, 4)) {
      const startedAt = Date.now();
      try {
        const resolved = await services.sourceImport.tryResolveFullText(projectId, entry.sourceId);
        let chunks: unknown = null;
        if (resolved.outcome === "resolved" || resolved.outcome === "skipped_has_file") {
          if ((await services.ingestion.getDocument(projectId, entry.sourceId)) === null) {
            try {
              await services.ingestion.ingest(projectId, entry.sourceId);
            } catch (error) {
              chunks = { ingestError: (error as Error).message.slice(0, 200) };
            }
          }
          if (chunks === null) {
            const indexed = await services.workflowServices.targetedGrounding.prepareSource(projectId, entry.sourceId);
            chunks = { status: indexed.status, chunkCount: indexed.chunkCount, reason: indexed.reason ?? null };
            if (indexed.status === "indexed" && indexed.chunkCount > 0) usable.push(entry.sourceId);
          }
        }
        fullText.push({ ...entry, outcome: resolved.outcome, note: resolved.note ?? null, ms: Date.now() - startedAt, chunks });
      } catch (error) {
        fullText.push({ ...entry, error: (error as Error).message.slice(0, 200), ms: Date.now() - startedAt });
      }
    }
    report["fullText"] = fullText;
    report["usableSources"] = usable;

    // ---- 5-8：真实 Grounding Judge（≤4 次；生产同款 TargetedGroundingService） ----
    const grounded = await services.workflowServices.targetedGrounding.groundClaims(
      projectId,
      CLAIM_TOPICS.map((topic) => ({
        claimId: `m147-${topic.theme.split(" ").slice(0, 2).join("-")}`,
        claim: topic.claim,
        section: "related_work",
        sourceIds: [...usable],
      })),
      { maxJudgeCalls: JUDGE_CALL_CAP },
    );
    report["grounding"] = {
      judgeCallsUsed: grounded.judgeCallsUsed,
      judgeCallCap: JUDGE_CALL_CAP,
      verifiedClaims: grounded.verifiedClaims,
      verifiedEvidence: grounded.verifiedEvidence,
      outcomes: grounded.outcomes.map((outcome) => ({
        claimId: outcome.claimId,
        status: outcome.status,
        evidenceIds: outcome.evidenceIds,
        attempts: outcome.attempts,
        reason: outcome.reason ?? null,
      })),
    };

    // ---- 9-10：正式 Evidence → EvidenceStore → Writer 可引用 key ----
    const formal = (await services.workflowServices.evidenceSelection.selectForWriting(projectId)).formal;
    const sources = await services.sources.list(projectId);
    const bibliography = assignCitationKeys(buildBibliographyFromSources(sources));
    const chain = formal.map((record) => {
      const key = resolveEvidenceCitationKey(record, bibliography);
      return {
        evidenceId: record.id,
        claim: record.claim.slice(0, 200),
        sourceId: record.source?.sourceId ?? null,
        title: record.source?.title ?? null,
        doi: record.source?.doi ?? null,
        verificationStatus: record.verificationStatus,
        verificationLevel: record.verificationLevel,
        supportStrength: record.supportStrength,
        verificationMethod: record.verificationMethod,
        chunk: record.location?.chunk ?? null,
        quote: (record.quote ?? "").slice(0, 300),
        citationKey: key,
      };
    });
    report["formalEvidenceChain"] = chain;
    report["bibliographyPreview"] = renderBibliographyFile(bibliography).slice(0, 2000);
    report["usage"] = { ...usageTotals };
    report["phaseBudget"] = phaseLedger.snapshot();
    report["evidenceJsonl"] = (await readFile(join(services.projects.projectDir(projectId), "evidence", "evidence.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    report["finishedAt"] = new Date().toISOString();
    report["modelCalls"] = usageTotals.calls;
    report["prompts"] = prompts;

    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const outPath = join(outDir, `grounding-${stamp}.json`);
    await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[m147-grounding] 产物：${outPath}`);
    console.log(`[m147-grounding] ${JSON.stringify({ usable: usable.length, verifiedClaims: grounded.verifiedClaims, formalEvidence: formal.length, judgeCalls: usageTotals.calls })}`);

    // ---- 断言：链路可达 + 预算纪律 + 至少一条真实 verified 正式 Evidence 及可引用 key ----
    expect(themesOut.some((entry) => ((entry as { results?: number }).results ?? 0) > 0)).toBe(true);
    expect(promoted.length).toBeGreaterThan(0);
    expect(usageTotals.calls).toBeLessThanOrEqual(JUDGE_CALL_CAP);
    expect(grounded.verifiedClaims).toBeGreaterThanOrEqual(1);
    expect(formal.length).toBeGreaterThanOrEqual(1);
    const verifiedChain = chain.filter((entry) => entry.verificationStatus === "verified");
    expect(verifiedChain.length).toBeGreaterThanOrEqual(1);
    for (const entry of verifiedChain) {
      expect(entry.sourceId).toBeTruthy();
      expect(entry.title).toBeTruthy();
      expect(entry.doi ?? entry.title).toBeTruthy();
      expect(entry.verificationLevel).not.toBe("metadata"); // 全文级核验，不是仅元数据
      expect(entry.chunk).toMatch(/^[S]\d{3}:[^:]+:\d+:/); // 真实 chunkId 锚点（sourceId:section:n:hash）
      expect(entry.quote?.length ?? 0).toBeGreaterThan(40); // 逐字 quote（Stage 1 校验过存在性）
      expect(entry.citationKey).toBeTruthy(); // Writer A 组 key 可解析
      expect(report["bibliographyPreview"]).toContain(`{${entry.citationKey},`);
    }
  });
});
