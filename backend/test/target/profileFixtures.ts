/**
 * Target 域测试共享 fixture（A7/A8 测试用；非测试文件本身）。
 *
 * PaperSpec → ParsedDocument / TargetBenchmarkPaper 的确定性工厂：词数精确
 * 可控（totalWords = 正文 + 摘要 + 参考文献条目词 + 附加句），分位带 golden
 * 断言才能手算。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import type { ParsedBlock, ParsedDocument } from "../../src/ingestion/types.js";
import {
  TargetBenchmarkService,
  type BenchmarkSourceLike,
} from "../../src/target/TargetBenchmarkService.js";
import { TargetProfileService, type TargetSummaryModel } from "../../src/target/TargetProfileService.js";
import { TargetGapService } from "../../src/target/TargetGapService.js";
import type { TargetBenchmarkPaper } from "../../src/target/types.js";

export const NOW = () => new Date("2026-10-07T12:00:00.000Z");

export interface PaperSpec {
  sourceId: string;
  /** 全文总词数（含摘要 / 参考文献条目 / 附加句） */
  totalWords: number;
  abstractWords: number;
  refEntries: number;
  refYear: number;
  paperYear?: number;
  tables?: number;
  figures?: number;
  ablation?: boolean;
  robustness?: boolean;
  limitations?: boolean;
  methodDiagramFigure?: boolean;
  extraExperimentsText?: string;
  noDoc?: boolean;
}

export function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `w${index}`).join(" ");
}

function textBlock(blockId: string, text: string, section: string): ParsedBlock {
  return {
    blockId,
    type: "text",
    text,
    provenance: { fileName: "paper.pdf", section },
    textKind: "paragraph",
  };
}

export function makeDocument(spec: PaperSpec): ParsedDocument {
  // 参考文献条目 "[1] Author 0. Title about things. 2019." = 7 词元
  const extras =
    spec.abstractWords +
    7 * spec.refEntries +
    (spec.ablation ? 5 : 0) +
    (spec.limitations ? 2 : 0);
  const body = Math.max(spec.totalWords - extras, 20);
  const w1 = Math.floor(body * 0.3);
  const w2 = Math.floor(body * 0.4);
  const w3 = Math.floor(body * 0.2);
  const w4 = body - w1 - w2 - w3;
  const experimentsText =
    words(w3) +
    (spec.ablation ? " An ablation study is included." : "") +
    (spec.extraExperimentsText ?? "");
  const blocks: ParsedBlock[] = [
    textBlock("B0001", words(spec.abstractWords), "Abstract"),
    textBlock("B0002", words(w1), "1 Introduction"),
    textBlock("B0003", words(w2), "2 Method"),
    textBlock("B0004", experimentsText, "3 Experiments"),
    textBlock("B0005", words(w4) + (spec.limitations ? " Limitations exist." : ""), "4 Conclusion"),
    textBlock(
      "B0006",
      Array.from(
        { length: spec.refEntries },
        (_, index) => `[${index + 1}] Author ${index}. Title about things. ${spec.refYear}.`,
      ).join(" "),
      "References",
    ),
  ];
  for (let index = 0; index < (spec.tables ?? 0); index += 1) {
    blocks.push({
      blockId: `T${String(index + 1).padStart(4, "0")}`,
      type: "table",
      caption: `Table ${index + 1}`,
      headers: ["a", "b"],
      rows: [["1", "2"]],
      rowCount: 1,
      columnCount: 2,
      provenance: { fileName: "paper.pdf", section: "3 Experiments" },
    });
  }
  for (let index = 0; index < (spec.figures ?? 0); index += 1) {
    blocks.push({
      blockId: `F${String(index + 1).padStart(4, "0")}`,
      type: "figure",
      caption:
        spec.methodDiagramFigure === true && index === 0
          ? "Figure 1: Overview of the proposed framework."
          : `Figure ${index + 1}: Some results.`,
      provenance: {
        fileName: "paper.pdf",
        section: spec.methodDiagramFigure === true && index === 0 ? "2 Method" : "3 Experiments",
      },
    });
  }
  const counts: Record<string, number> = {
    text: 0, table: 0, figure: 0, formula: 0, structured_record: 0, code: 0, output: 0,
  };
  for (const block of blocks) {
    counts[block.type] = (counts[block.type] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    sourceId: spec.sourceId,
    fileName: `${spec.sourceId}.pdf`,
    storedFileName: `${spec.sourceId}.pdf`,
    kind: "pdf",
    mimeType: "application/pdf",
    parser: { id: "docling-test" },
    parseMode: "structured",
    status: "ok",
    blocks,
    counts: counts as ParsedDocument["counts"],
    notes: [],
    contentHash: `hash-${spec.sourceId}`,
    parsedAt: NOW().toISOString(),
  };
}

export const VALID_SUMMARY_JSON = JSON.stringify({
  methodDepthNote: "目标带论文通常设独立方法章并按「问题形式化 → 组件设计 → 复杂度」组织论述，先给总体框架再分小节展开。",
  methodNoveltyNote: "新颖性框定普遍采用「与最近基线逐一对比 + 明确贡献列表」模式，贡献条数与实验章的消融逐一对应。",
  writingClaimStrengthNote: "论断强度普遍与实验数字对齐：强结论仅出现在带统计口径的对比句中，无对照的表述用弱化措辞。",
  writingDiscussionNote: "讨论章普遍包含结果解释、失败案例分析与适用范围声明，结论章回收贡献列表并给出限制与展望。",
});

export const TARGET = {
  documentType: "conference_paper",
  targetProfile: "top_conference",
  targetVenue: "CVPR",
  researchField: "multi-object tracking",
};

export const SIX_PAPERS: PaperSpec[] = [
  { sourceId: "P001", totalWords: 1000, abstractWords: 100, refEntries: 10, refYear: 2019, paperYear: 2023, tables: 2, figures: 4 },
  { sourceId: "P002", totalWords: 1500, abstractWords: 120, refEntries: 14, refYear: 2019, paperYear: 2023, tables: 3, figures: 5, methodDiagramFigure: true },
  { sourceId: "P003", totalWords: 2000, abstractWords: 140, refEntries: 18, refYear: 2020, paperYear: 2023, tables: 4, figures: 6, methodDiagramFigure: true, ablation: true },
  { sourceId: "P004", totalWords: 2500, abstractWords: 160, refEntries: 22, refYear: 2020, paperYear: 2023, tables: 5, figures: 7, methodDiagramFigure: true, ablation: true },
  { sourceId: "P005", totalWords: 3000, abstractWords: 180, refEntries: 26, refYear: 2021, paperYear: 2023, tables: 6, figures: 8, methodDiagramFigure: true, ablation: true, robustness: true, limitations: true },
  { sourceId: "P006", totalWords: 3500, abstractWords: 200, refEntries: 30, refYear: 2021, paperYear: 2023, tables: 7, figures: 9, methodDiagramFigure: true, ablation: true, robustness: true, limitations: true },
];

/** 八篇语料（readiness 用：覆盖充足 n=8 → confidence high 可达） */
export const EIGHT_PAPERS: PaperSpec[] = [
  { sourceId: "Q001", totalWords: 4000, abstractWords: 150, refEntries: 20, refYear: 2019, paperYear: 2023, tables: 4, figures: 6, methodDiagramFigure: true, ablation: true, limitations: true },
  { sourceId: "Q002", totalWords: 4500, abstractWords: 160, refEntries: 22, refYear: 2019, paperYear: 2023, tables: 4, figures: 6, methodDiagramFigure: true, ablation: true, limitations: true },
  { sourceId: "Q003", totalWords: 5000, abstractWords: 170, refEntries: 24, refYear: 2020, paperYear: 2023, tables: 5, figures: 7, methodDiagramFigure: true, ablation: true, limitations: true },
  { sourceId: "Q004", totalWords: 5500, abstractWords: 180, refEntries: 26, refYear: 2020, paperYear: 2023, tables: 5, figures: 7, methodDiagramFigure: true, ablation: true, limitations: true },
  { sourceId: "Q005", totalWords: 6000, abstractWords: 190, refEntries: 28, refYear: 2021, paperYear: 2023, tables: 6, figures: 8, methodDiagramFigure: true, ablation: true, limitations: true },
  { sourceId: "Q006", totalWords: 6500, abstractWords: 200, refEntries: 30, refYear: 2021, paperYear: 2023, tables: 6, figures: 8, methodDiagramFigure: true, ablation: true, limitations: true },
  { sourceId: "Q007", totalWords: 7000, abstractWords: 210, refEntries: 32, refYear: 2022, paperYear: 2023, tables: 7, figures: 9, methodDiagramFigure: true, ablation: true, limitations: true },
  { sourceId: "Q008", totalWords: 7500, abstractWords: 220, refEntries: 34, refYear: 2022, paperYear: 2023, tables: 7, figures: 9, methodDiagramFigure: true, ablation: true, limitations: true },
];

export function papersOf(specs: readonly PaperSpec[]): TargetBenchmarkPaper[] {
  return specs.map((spec) => ({
    sourceId: spec.sourceId,
    identityKey: `doi:10.1000/${spec.sourceId.toLowerCase()}`,
    provenance: { provider: "openalex", retrievedAt: NOW().toISOString(), queryUsed: "mot" },
    inclusionReason: "top-cited in venue corpus, rank #1, cited 100 times",
    citationCount: 100,
    venueRaw: "CVPR",
    hasFullText: !spec.noDoc,
  }));
}

export interface TargetHarness {
  projects: ProjectStore;
  projectId: string;
  benchmark: TargetBenchmarkService;
  profile: TargetProfileService;
  gap: TargetGapService;
  root: string;
}

export async function setupTargetHarness(
  specs: readonly PaperSpec[],
  options: { summaryModel?: TargetSummaryModel; roots: string[] } = { roots: [] },
): Promise<TargetHarness> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-target-"));
  options.roots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("Target 测试");
  const docs = new Map<string, ParsedDocument>();
  const years = new Map<string, number>();
  for (const spec of specs) {
    if (!spec.noDoc) {
      docs.set(spec.sourceId, makeDocument(spec));
    }
    if (spec.paperYear !== undefined) {
      years.set(spec.sourceId, spec.paperYear);
    }
  }
  const benchmark = new TargetBenchmarkService({
    projects,
    listSources: async () => [] as BenchmarkSourceLike[],
    now: NOW,
    log: () => {},
  });
  const profile = new TargetProfileService({
    projects,
    benchmarks: benchmark,
    parsedDocuments: { load: async (_projectId, sourceId) => docs.get(sourceId) ?? null },
    getPaperYear: async (_projectId, sourceId) => years.get(sourceId),
    ...(options.summaryModel !== undefined ? { summaryModel: options.summaryModel } : {}),
    now: NOW,
    log: () => {},
  });
  const gap = new TargetGapService({
    projects,
    benchmarks: benchmark,
    profiles: profile,
    now: NOW,
    log: () => {},
  });
  await benchmark.freeze(project.id, { target: TARGET, papers: papersOf(specs) });
  return { projects, projectId: project.id, benchmark, profile, gap, root };
}
