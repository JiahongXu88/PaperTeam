/**
 * M14.1b 真实本地材料验证（Phase F）——不是 Mock：
 *   材料：D:\PaperTeamData\M14_0_1_RealThesisPaperStudy（M14.0.1 合法获取的公开论文 / 学位论文）
 *   解析：真实 docling（TableFormer）+ 真实 PyMuPDF 文本层（独立通道）
 *   运行：PAPERTEAM_M141B_REAL_MATERIAL=1 npx vitest run test/thesis/m141bRealMaterial.smoke.test.ts
 *
 * 版权 / 归属纪律：这些是他人的公开学术案例，不是 PaperTeam 用户的研究成果。所有
 * "作者确认"均以 actor=test_fixture 标记为测试行为；原始 PDF / 全文解析结果只落在
 * PAPERTEAM_M141B_DATA_ROOT（缺省 D:\PaperTeamData\M14_1b_ResearchInputFacts），不入库。
 *
 * Oracle：M14.0.1 人工核对的真实冲突（范登平 表4.3 vs CVPR19 Table 5：
 * 0.699/0.630/0.098 vs 0.724/0.603/0.092，其余两行相同）。被测功能仍需真实解析并自行对齐。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DoclingParser } from "../../src/ingestion/DoclingParser.js";
import { LegacyPdfTextParser } from "../../src/ingestion/LegacyPdfTextParser.js";
import { PyMuPdfParser } from "../../src/paper/PdfParser.js";
import type { ResearchInputType } from "../../src/thesis/researchInputTypes.js";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";

const live = process.env["PAPERTEAM_M141B_REAL_MATERIAL"] === "1";
const STUDY = process.env["PAPERTEAM_M1401_STUDY_ROOT"] ?? "D:/PaperTeamData/M14_0_1_RealThesisPaperStudy";
const DATA_ROOT = process.env["PAPERTEAM_M141B_DATA_ROOT"] ?? "D:/PaperTeamData/M14_1b_ResearchInputFacts";
const PROJECTS_ROOT = join(DATA_ROOT, "projects");
const REPORT_DIR = join(DATA_ROOT, "report");

interface Material {
  key: string;
  file: string;
  inputType: ResearchInputType;
  title: string;
  arxivId?: string;
  doi?: string;
  versionLabel?: string;
  publicationStatus?: { value: "published" | "submitted" | "preprint" | "unpublished"; asOf?: string };
}

const FAN: Material[] = [
  { key: "fan_cvpr19", file: "papers/fan_ssav_cvpr19_cvf.pdf", inputType: "published_paper", title: "Shifting More Attention to Video Salient Object Detection", doi: "10.1109/CVPR.2019.00875", versionLabel: "CVF open-access", publicationStatus: { value: "published" } },
  { key: "fan_iccv17", file: "papers/fan_smeasure_iccv17_arxiv1708.00786v1.pdf", inputType: "preprint", title: "Structure-measure: A New Way to Evaluate Foreground Maps", arxivId: "1708.00786v1", versionLabel: "arXiv v1", publicationStatus: { value: "preprint" } },
  { key: "fan_thesis", file: "thesis/zh_fan_dengping_nankai_phd2019.pdf", inputType: "unpublished_manuscript", title: "认知规律启发的显著性物体检测方法与评测（公开学位论文，作为手稿材料验证）", versionLabel: "author-page copy", publicationStatus: { value: "unpublished" } },
];
const LI: Material[] = [
  { key: "li_cdc23", file: "papers/li_nmpc_cdc23_arxiv2304.07794v2.pdf", inputType: "submitted_manuscript", title: "Nonlinear MPC for Quadrotors in Close-Proximity Flight with Neural Network Downwash Prediction", arxivId: "2304.07794v2", versionLabel: "arXiv v2 (Submitted to CDC 2023 at thesis time)", publicationStatus: { value: "submitted", asOf: "2023-05" } },
  { key: "li_thesis", file: "thesis/zh_li_jinjie_buaa_master2023.pdf", inputType: "experiment_report", title: "基于模型预测的无人机密集编队跟踪控制算法研究（公开学位论文，作为实验报告材料验证）", versionLabel: "author-page copy" },
];
const LIQIMAI: Material[] = [
  { key: "glp_v1", file: "papers/liqimai_glp_cvpr19_arxiv1901.09993v1.pdf", inputType: "preprint", title: "Label Efficient Semi-Supervised Learning via Graph Filtering (v1)", arxivId: "1901.09993v1", versionLabel: "arXiv v1" },
  { key: "glp_v3", file: "papers/liqimai_glp_cvpr19_arxiv1901.09993v3.pdf", inputType: "published_paper", title: "Label Efficient Semi-Supervised Learning via Graph Filtering (v3)", arxivId: "1901.09993v3", versionLabel: "arXiv v3" },
];
const ALL = [...FAN, ...LI, ...LIQIMAI];
const available = live && ALL.every((material) => existsSync(join(STUDY, material.file)));

describe.skipIf(!available)("M14.1b 真实材料端到端（docling + PyMuPDF，公开学术案例）", () => {
  it("场景 A–E：多来源导入 / 版本关系 / 真实冲突 / 单元格溯源 / 作者确认边界 / Planner 上下文", async () => {
    await mkdir(PROJECTS_ROOT, { recursive: true });
    await mkdir(REPORT_DIR, { recursive: true });
    const log = (message: string) => console.log(message);
    const pyMuPdf = new PyMuPdfParser({ log });
    const stack = await startTestStack(scriptedIdeaRuntime().runtime, {
      root: PROJECTS_ROOT,
      paperParser: pyMuPdf,
      ingestion: {
        structuredParser: new DoclingParser({ log, timeoutMs: 3_600_000, maxConcurrency: 1 }),
        fallbackParser: new LegacyPdfTextParser({ pdfParser: pyMuPdf, log }),
      },
    });
    const report: Record<string, unknown> = { startedAt: new Date().toISOString(), study: STUDY, actorNote: "所有作者确认均为 test_fixture 模拟；材料为公开学术案例，不是用户本人成果" };
    try {
      // 复用同一项目（解析产物按 contentHash 幂等；重跑不重新 docling）
      let projectId: string | undefined;
      for (const id of await stack.store.list()) {
        if ((await stack.store.get(id))?.title === "M14.1b real material") projectId = id;
      }
      projectId ??= (await stack.store.create("M14.1b real material", { language: "zh" })).id;
      const service = stack.stack.researchInputs;
      const inputs: Record<string, { inputId: string; sourceId: string; created: boolean; parse: unknown; tables: number }> = {};

      // ---- 场景 A：多来源导入（含重复导入）----
      for (const material of ALL) {
        const content = await readFile(join(STUDY, material.file));
        const { source } = await stack.stack.sources.add(projectId, { fileName: material.file.split("/").pop()!, content, metadata: { title: material.title } });
        const t0 = Date.now();
        const result = await service.register(projectId, {
          sourceId: source.sourceId,
          inputType: material.inputType,
          title: material.title,
          ...(material.arxivId !== undefined ? { arxivId: material.arxivId } : {}),
          ...(material.doi !== undefined ? { doi: material.doi } : {}),
          ...(material.versionLabel !== undefined ? { versionLabel: material.versionLabel } : {}),
          ...(material.publicationStatus !== undefined ? { publicationStatus: material.publicationStatus } : {}),
          provenanceUri: `m14.0.1-study:${material.file}`,
        }, { ensureParsed: true });
        log(`[real] ${material.key} parse=${result.input.parse.status} tables=${result.input.parse.tableCount ?? 0} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        inputs[material.key] = { inputId: result.input.inputId, sourceId: source.sourceId, created: result.created, parse: result.input.parse, tables: result.input.parse.tableCount ?? 0 };
      }
      // 重复导入 CVPR19：同文件 → 同 source、同 inputId、created=false
      const dupContent = await readFile(join(STUDY, FAN[0]!.file));
      const dupSource = await stack.stack.sources.add(projectId, { fileName: "fan_ssav_cvpr19_cvf.pdf", content: dupContent });
      expect(dupSource.created).toBe(false);
      const dup = await service.register(projectId, { sourceId: dupSource.source.sourceId, inputType: "published_paper" });
      expect(dup.created).toBe(false);
      expect(dup.input.inputId).toBe(inputs["fan_cvpr19"]!.inputId);
      const registry = await service.list(projectId);
      const glpRelation = registry.relations.find((relation) => relation.basis === "arxiv_identifier");
      expect(glpRelation).toMatchObject({ kind: "same_work", status: "confirmed" });
      expect(registry.inputs.find((input) => input.inputId === inputs["glp_v1"]!.inputId)!.workId).toBe(registry.inputs.find((input) => input.inputId === inputs["glp_v3"]!.inputId)!.workId);
      report["scenarioA"] = {
        inputs,
        duplicateImport: { created: dup.created, sameInputId: dup.input.inputId === inputs["fan_cvpr19"]!.inputId },
        relations: registry.relations,
        workGroups: registry.workGroups,
        contentHashes: Object.fromEntries(registry.inputs.map((input) => [input.inputId, input.version.contentHash])),
      };

      // ---- 事实抽取 + 来源核验 ----
      const extraction: Record<string, unknown> = {};
      for (const material of ALL) {
        const { inputId } = inputs[material.key]!;
        const extracted = await service.extractFacts(projectId, inputId);
        const verified = await service.verifyFacts(projectId, inputId);
        extraction[material.key] = {
          created: extracted.created, unchanged: extracted.unchanged, skippedCells: extracted.skippedCells, parseStatus: extracted.parseStatus,
          tables: extracted.tables.map((table) => ({ blockId: table.blockId, page: table.page, label: table.label, labelBasis: table.labelBasis, rows: table.rows.length, columns: table.headers.length, headerRowDerived: table.headerRowDerived })),
          verification: verified,
        };
        log(`[real] ${material.key} facts=${extracted.created} verified=${verified.verified}/${verified.checked}`);
      }
      report["extraction"] = extraction;

      // ---- 场景 B：真实数值冲突（范登平 表4.3 vs CVPR19 Table 5）----
      const detect = await service.detectConflicts(projectId, { inputIds: [inputs["fan_cvpr19"]!.inputId, inputs["fan_thesis"]!.inputId, inputs["fan_iccv17"]!.inputId] });
      const conflicts = await service.facts.listConflicts(projectId);
      const facts = (await service.facts.load(projectId)).facts;
      const factById = new Map(facts.map((fact) => [fact.factId, fact]));
      const describe = (factId: string) => {
        const fact = factById.get(factId)!;
        return { input: fact.researchInputId, page: fact.provenance.page, table: fact.provenance.table?.label, row: fact.provenance.table?.rowLabel, column: fact.provenance.table?.columnLabel, raw: fact.value.raw, verification: fact.verification.status };
      };
      report["scenarioB"] = {
        alignments: detect.alignments.map((alignment) => ({ id: alignment.alignmentId, status: alignment.status, left: alignment.left, right: alignment.right, evidence: alignment.evidence })),
        conflicts: conflicts.map((conflict) => ({ id: conflict.conflictId, classification: conflict.classification, severity: conflict.severity, key: conflict.key, parties: conflict.parties.map((party) => describe(party.factId)) })),
        skipped: detect.skippedInputs,
      };
      const oracle = [["0.724", "0.699"], ["0.603", "0.630"], ["0.092", "0.098"]];
      const mismatch = conflicts.filter((conflict) => conflict.classification === "value_mismatch");
      const oracleHits = oracle.filter(([paper, thesis]) => mismatch.some((conflict) => {
        const raws = conflict.parties.map((party) => party.raw).sort();
        return raws.join("|") === [paper, thesis].sort().join("|");
      }));
      report["scenarioB_oracle"] = { expectedPairs: oracle, detectedPairs: mismatch.map((conflict) => conflict.parties.map((party) => party.raw)), hits: oracleHits.length };
      log(`[real] conflicts: ${conflicts.length} (value_mismatch ${mismatch.length}); oracle hits ${oracleHits.length}/3`);

      // ---- 场景 C：表格单元格溯源（范登平 表5.1 ↔ ICCV17 Table 1：AP × PASCAL-S MM1 = 0.452）----
      const cellTrace = (inputId: string, raw: string, rowHint: RegExp, colHint: RegExp) =>
        facts.filter((fact) => fact.researchInputId === inputId && fact.value.raw === raw && rowHint.test(fact.provenance.table?.rowLabel ?? "") && colHint.test(fact.provenance.table?.columnLabel ?? ""))
          .map((fact) => ({ factId: fact.factId, page: fact.provenance.page, pageBasis: fact.provenance.pageBasis, blockId: fact.provenance.blockId, table: fact.provenance.table, verification: fact.verification, contentHash: fact.provenance.contentHash.slice(0, 12) }));
      report["scenarioC"] = {
        thesis_t51_AP_PASCALS_MM1: cellTrace(inputs["fan_thesis"]!.inputId, "0.452", /^AP/i, /PASCAL/i),
        iccv17_t1_AP_PASCALS_MM1: cellTrace(inputs["fan_iccv17"]!.inputId, "0.452", /^AP/i, /PASCAL/i),
        thesis_t43_explicit_S: cellTrace(inputs["fan_thesis"]!.inputId, "0.699", /SSAA/i, /S/),
        li_thesis_t9_gamma4: cellTrace(inputs["li_thesis"]!.inputId, "1.0523", /Loss/i, /4/),
      };

      // ---- 场景 D：作者确认边界（test_fixture 显式模拟）----
      const actor = { kind: "test_fixture" as const, note: "M14.1b 真实材料验证：模拟作者操作，非真实作者确认" };
      const scopeDecision = await service.submitDecision(projectId, { decisionId: "real-scope-cvpr19", actor, payload: { type: "scope_decision", inputId: inputs["fan_cvpr19"]!.inputId, scope: "included" } });
      const scopeDup = await service.submitDecision(projectId, { decisionId: "real-scope-cvpr19", actor, payload: { type: "scope_decision", inputId: inputs["fan_cvpr19"]!.inputId, scope: "excluded" } });
      expect(scopeDup.duplicate).toBe(true);
      await service.submitDecision(projectId, { decisionId: "real-scope-thesis", actor, payload: { type: "scope_decision", inputId: inputs["fan_thesis"]!.inputId, scope: "included" } });
      await service.submitDecision(projectId, { decisionId: "real-unpub-thesis", actor, payload: { type: "unpublished_material_policy", inputId: inputs["fan_thesis"]!.inputId, allowed: true, note: "测试：允许纳入" } });
      let resolution: unknown = null;
      const sConflict = mismatch.find((conflict) => conflict.parties.some((party) => party.raw === "0.699"));
      if (sConflict !== undefined) {
        const thesisParty = sConflict.parties.find((party) => party.raw === "0.699")!;
        const resolved = await service.submitDecision(projectId, { decisionId: "real-adopt-thesis-S", actor, payload: { type: "conflict_resolution", conflictId: sConflict.conflictId, decision: "adopt_fact", adoptedFactId: thesisParty.factId, rationale: "测试模拟：采用学位论文版本" } });
        resolution = resolved.decision;
        // 未裁决的事实不能被确认
        const other = mismatch.find((conflict) => conflict.conflictId !== sConflict.conflictId);
        if (other !== undefined) {
          await expect(service.submitDecision(projectId, { actor, payload: { type: "fact_confirmation", factIds: [other.parties[0]!.factId], outcome: "confirmed" } })).rejects.toThrow(/未裁决冲突/);
        }
      }
      // 重开（新进程）后决定与状态仍在
      const reopened = await startTestStack(scriptedIdeaRuntime().runtime, { root: PROJECTS_ROOT });
      try {
        const decisions = await reopened.stack.researchInputs.decisions.list(projectId);
        expect(decisions.map((decision) => decision.decisionId)).toContain("real-scope-cvpr19");
        expect((await reopened.stack.researchInputs.registry.get(projectId, inputs["fan_cvpr19"]!.inputId)).scope.status).toBe("included");
        report["scenarioD"] = { decisions, duplicateRejected: scopeDup.duplicate, firstDecision: scopeDecision.decision.decisionId, resolution, actorKinds: [...new Set(decisions.map((decision) => decision.actor.kind))] };
      } finally {
        await reopened.cleanup();
      }

      // ---- 场景 E：Planner 可消费上下文 ----
      const context = await service.plannerContext(projectId);
      report["scenarioE"] = {
        inputs: context.inputs,
        factCounts: { authorConfirmed: context.facts.authorConfirmed.length, sourceVerifiedUnconfirmed: context.facts.sourceVerifiedUnconfirmed.length, extractedOnly: context.facts.extractedOnly.length, conflicted: context.facts.conflicted.length },
        conflicts: { unresolved: context.conflicts.unresolved.length, resolved: context.conflicts.resolved.length },
        pendingDecisions: context.pendingDecisions,
        writingBlockers: context.writingBlockers,
      };
      expect(context.facts.authorConfirmed).toHaveLength(0);
      report["finishedAt"] = new Date().toISOString();
    } finally {
      await writeFile(join(REPORT_DIR, "m141b-real-material-report.json"), JSON.stringify(report, null, 2), "utf8");
      await stack.cleanup();
    }
  }, 3 * 60 * 60 * 1000);
});
