/**
 * M14.5 案例 B 科研事实基线（Phase B；env 门控：PAPERTEAM_M145_FACTS=1；默认跳过，不进 CI）。
 *
 * 目的：在启动真实模型工作流之前，用真实 PDF 解析（本机 docling + PyMuPDF 文本层）建立
 * 李谨杰关联小论文（CDC 2023，arXiv 2304.07794v2）的确定性事实基线：
 *   ResearchInput 注册 / 版本与来源 / 表格事实抽取 / 独立文本层核验 / 冲突检测（单输入）/
 *   Planner 上下文（pendingDecisions / writingBlockers）/ 继承表格候选 / 任务 §三 关注的
 *   "表格—正文—图形数值能否可靠对应"（M14.0.1 口径的关键数值在文本层与事实层的出现情况）。
 *
 * 纪律：零模型调用（runtime 一旦被调用即抛错）；只读 generation-inputs/（held-out 学位论文
 * 从不进入本测试）；所有决定均为 test_fixture（本测试不提交任何决定，只观察）。
 *
 * 运行：
 *   PAPERTEAM_M145_FACTS=1 PAPERTEAM_M145_INPUTS_DIR=D:/PaperTeamData/M14_5/generation-inputs \
 *   PAPERTEAM_M145_DATA_ROOT=D:/PaperTeamData/M14_5 npx vitest run test/thesis/m145CaseBFactBaseline.e2e.test.ts
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DoclingParser } from "../../src/ingestion/DoclingParser.js";
import { LegacyPdfTextParser } from "../../src/ingestion/LegacyPdfTextParser.js";
import { PyMuPdfParser } from "../../src/paper/PdfParser.js";
import type { AgentRuntime } from "../../src/runtime/types.js";
import { makeHealth } from "../helpers/fakeRuntime.js";
import { startTestStack } from "../helpers/testStack.js";

const live = process.env["PAPERTEAM_M145_FACTS"] === "1";
const INPUTS_DIR = process.env["PAPERTEAM_M145_INPUTS_DIR"] ?? "D:/PaperTeamData/M14_5/generation-inputs";
const DATA_ROOT = process.env["PAPERTEAM_M145_DATA_ROOT"] ?? "D:/PaperTeamData/M14_5";
const PDF = "Li2023_NDP_NMPC_CDC_arXiv2304.07794v2.pdf";
const available = live && existsSync(join(INPUTS_DIR, PDF));

/** 任何模型调用都是违规（本阶段必须零模型调用） */
function noModelRuntime(): AgentRuntime {
  const fail = (): never => {
    throw new Error("M14.5 fact baseline 阶段不允许任何模型调用");
  };
  return {
    provider: "pi",
    healthCheck: async () => makeHealth(true),
    startAgent: async () => fail(),
    runAgent: async () => fail(),
    getTask: () => fail(),
    close: async () => {},
  };
}

/**
 * M14.0.1 对照口径（来自对小论文自身的核对，不含 held-out 学位论文内容）：
 * - 四旋翼模型参数 0.0094 / 0.0134 / 0.0145 / 1.5344 / 3.7611（论文 §III-C 参数表）；
 * - 摘要 75.37%（实时轨迹跟踪高度误差下降）；
 * - 谱归一化测试损失 1.589 / 1.022 / 0.518（论文 Fig. 6 图内文字——不应成为表格事实）。
 */
const KEY_NUMBERS = ["0.0094", "0.0134", "0.0145", "1.5344", "3.7611", "75.37", "1.589", "1.022", "0.518"];

describe.skipIf(!available)("M14.5 案例 B 科研事实基线（真实 docling + PyMuPDF；零模型调用）", () => {
  it("注册 → 解析 → 表格事实 → 文本层核验 → 冲突检测 → Planner 上下文 → 继承表格候选", async () => {
    const projectsRoot = join(DATA_ROOT, "projects-caseB-facts");
    const evaluationDir = join(DATA_ROOT, "evaluation");
    await mkdir(projectsRoot, { recursive: true });
    await mkdir(evaluationDir, { recursive: true });
    const log = (message: string) => console.log(message);
    const pyMuPdf = new PyMuPdfParser({ log });
    const stack = await startTestStack(noModelRuntime(), {
      root: projectsRoot,
      paperParser: pyMuPdf,
      ingestion: {
        structuredParser: new DoclingParser({ log, timeoutMs: 1_800_000, maxConcurrency: 1 }),
        fallbackParser: new LegacyPdfTextParser({ pdfParser: pyMuPdf, log }),
      },
    });
    const report: Record<string, unknown> = {
      startedAt: new Date().toISOString(),
      inputsDir: INPUTS_DIR,
      note: "第三方公开小论文；本阶段不提交任何作者决定（纯观察）；零模型调用",
    };
    try {
      const projectId = (await stack.store.create("M14.5 案例B 事实基线", { language: "zh", documentType: "master_thesis" })).id;
      report["projectId"] = projectId;
      const service = stack.stack.researchInputs;
      const bytes = await readFile(join(INPUTS_DIR, PDF));
      const { source } = await stack.stack.sources.add(projectId, { fileName: PDF, content: bytes, metadata: { title: PDF } });
      const t0 = Date.now();
      const registered = await service.register(projectId, {
        sourceId: source.sourceId,
        inputType: "published_paper",
        title: "Nonlinear MPC for Quadrotors in Close-Proximity Flight with Neural Network Downwash Prediction",
        authors: ["Jinjie Li", "Liang Han", "Haoyang Yu", "Yuheng Lin", "Qingdong Li", "Zhang Ren"],
        arxivId: "2304.07794",
        doi: "10.1109/CDC49753.2023.10383632",
        versionLabel: "arXiv 2304.07794v2（IEEE CDC 2023 发表；学位论文答辩时为 Submitted）",
        publicationStatus: { value: "published", asOf: "2023-12" },
        provenanceUri: "https://arxiv.org/abs/2304.07794",
      }, { ensureParsed: true });
      const parseSeconds = (Date.now() - t0) / 1000;
      log(`[m145] parse=${registered.input.parse.status} tables=${registered.input.parse.tableCount ?? 0} in ${parseSeconds.toFixed(0)}s`);
      expect(["full_text", "parsed"]).toContain(registered.input.parse.status);
      const inputId = registered.input.inputId;
      report["input"] = { inputId, sourceId: source.sourceId, parse: registered.input.parse, version: registered.input.version, publicationStatus: registered.input.publicationStatus, scope: registered.input.scope, parseSeconds };

      // ---- 表格事实抽取 + 独立文本层核验 ----
      const extracted = await service.extractFacts(projectId, inputId);
      const verified = await service.verifyFacts(projectId, inputId);
      const facts = (await service.facts.load(projectId)).facts.filter((fact) => fact.researchInputId === inputId);
      const byStatus: Record<string, number> = {};
      const byKind: Record<string, number> = {};
      for (const fact of facts) {
        byStatus[fact.verification.status] = (byStatus[fact.verification.status] ?? 0) + 1;
        byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;
      }
      report["extraction"] = {
        created: extracted.created, unchanged: extracted.unchanged, skippedCells: extracted.skippedCells, parseStatus: extracted.parseStatus,
        tables: extracted.tables.map((table) => ({ blockId: table.blockId, page: table.page, label: table.label, labelBasis: table.labelBasis, rows: table.rows.length, columns: table.headers.length, headers: table.headers, headerRowDerived: table.headerRowDerived })),
        verification: verified,
        factCount: facts.length,
        byVerificationStatus: byStatus,
        byKind,
        facts: facts.map((fact) => ({
          factId: fact.factId, kind: fact.kind, raw: fact.value.raw, page: fact.provenance.page,
          table: fact.provenance.table?.label, row: fact.provenance.table?.rowLabel, column: fact.provenance.table?.columnLabel,
          verification: fact.verification.status, sourceCheck: (fact.verification as { sourceCheck?: string }).sourceCheck,
          conflictStatus: (fact as { conflictStatus?: string }).conflictStatus,
        })),
      };
      log(`[m145] facts=${facts.length} verified=${verified.verified}/${verified.checked}`);

      // ---- 关键数值：文本层出现 vs 事实层捕获（表格/正文/图形的可对应性）----
      const parsedDoc = await stack.stack.parsedDocuments.load(projectId, source.sourceId);
      const blocks = (parsedDoc?.blocks ?? []) as unknown as Array<{ type?: string; text?: string; page?: number }>;
      const textLayer = blocks.map((block) => block.text ?? "").join("\n");
      report["keyNumbers"] = KEY_NUMBERS.map((num) => ({
        number: num,
        inParsedText: textLayer.includes(num),
        blocks: blocks.filter((block) => (block.text ?? "").includes(num)).slice(0, 4).map((block) => ({ type: block.type, page: block.page, excerpt: (block.text ?? "").slice(0, 160) })),
        asFact: facts.filter((fact) => fact.value.raw === num || fact.value.raw === `${num}%`).map((fact) => ({ factId: fact.factId, table: fact.provenance.table?.label, row: fact.provenance.table?.rowLabel, column: fact.provenance.table?.columnLabel, verification: fact.verification.status })),
      }));

      // ---- 冲突检测（单输入：预期无冲突、无版本关系）----
      const detect = await service.detectConflicts(projectId, { inputIds: [inputId] });
      const conflicts = await service.facts.listConflicts(projectId);
      const registry = await service.list(projectId);
      report["conflicts"] = { alignments: detect.alignments.length, skipped: detect.skippedInputs, conflicts: conflicts.length, relations: registry.relations, workGroups: registry.workGroups };
      expect(conflicts).toHaveLength(0);

      // ---- Planner 上下文（未提交任何决定：入选待定、事实全部未确认）----
      const context = await service.plannerContext(projectId);
      report["plannerContext"] = {
        inputs: context.inputs,
        factCounts: { authorConfirmed: context.facts.authorConfirmed.length, sourceVerifiedUnconfirmed: context.facts.sourceVerifiedUnconfirmed.length, extractedOnly: context.facts.extractedOnly.length, conflicted: context.facts.conflicted.length },
        pendingDecisions: context.pendingDecisions,
        writingBlockers: context.writingBlockers,
      };
      expect(context.facts.authorConfirmed).toHaveLength(0);

      // ---- 继承表格候选（M14.3）----
      const assets = await service.refreshTableCandidates(projectId);
      report["tableAssets"] = {
        candidatesBuilt: assets.candidatesBuilt,
        skippedInputs: assets.skippedInputs,
        assets: assets.file.assets.map((asset) => ({ assetId: asset.assetId, status: asset.status, captionZh: asset.captionZh, page: (asset as { source?: { page?: number } }).source?.page, verification: asset.verification })),
      };
      report["finishedAt"] = new Date().toISOString();
    } finally {
      await writeFile(join(evaluationDir, "caseB-fact-baseline.json"), JSON.stringify(report, null, 2), "utf8");
      await stack.cleanup();
    }
  }, 60 * 60 * 1000);
});
