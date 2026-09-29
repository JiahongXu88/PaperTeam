/**
 * M10.3 单元测试（确定性，无 LLM）：
 * - Asset Inventory：MANIFEST 角色映射 + current/historical 域隔离 + ambiguous
 * - Revision Baseline：表格 / 数字 / 引用 / 图 / 硬件 / 占位提取
 * - 外部意见 already_satisfied 终态：登记校验 / 计划派生不派发 / gate 复核不降级
 * - Improvement Plan enriched 条目：expectedFactChanges 授权数值变更；
 *   user_confirmed Evidence quote 授权数值新增；无授权 → 违规
 * - Revision Response markdown：状态投影 + 无意见时如实呈现
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildAssetInventory } from "../../src/import/assetInventory.js";
import { buildRevisionBaseline } from "../../src/review/revisionBaseline.js";
import { buildRevisionResponseMarkdown } from "../../src/review/revisionResponse.js";
import {
  applyDispatchOutcome,
  externalInstructionId,
  ExternalInstructionStore,
  readExternalInstructions,
  reverifyHandledInstructions,
  type ExternalDispatchResult,
  type ExternalInstruction,
} from "../../src/review/externalInstructions.js";
import { buildRevisionPlan } from "../../src/review/revisionPlan.js";
import { evaluateFactPreservation } from "../../src/quality/factPreservation.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function newProjectStore(): Promise<ProjectStore> {
  const root = await mkdtemp(join(tmpdir(), "m103-units-"));
  roots.push(root);
  return new ProjectStore({ root });
}

const MANIFEST = JSON.stringify({
  caseVersion: 1,
  currentManuscript: { packagedPath: "manuscript/source/paper.tex" },
  currentExperiments: { finalResult: { battery: "experiments/data/phase4/battery_phase4.json" } },
  historicalBoardExperiments: { data: "experiments/data/board_c0_20260904/aggregate.json" },
  assets: [
    { packagedPath: "manuscript/source/paper.tex", role: "current_manuscript", confidence: "high" },
    { packagedPath: "experiments/data/phase4/battery_phase4.json", role: "current_experiment" },
    { packagedPath: "experiments/data/board_c0_20260904/aggregate.json", role: "historical_board_experiment" },
    { packagedPath: "feedback/response_to_reviewers.md", role: "submission_feedback" },
    { packagedPath: "a/README.md", role: "readme" },
    { packagedPath: "b/README.md", role: "readme" },
  ],
});

describe("M10.3 Asset Inventory", () => {
  const sources = [
    { sourceId: "S001", fileName: "paper.tex", sourceType: "latex" },
    { sourceId: "S002", fileName: "battery_phase4.json", sourceType: "json" },
    { sourceId: "S003", fileName: "aggregate.json", sourceType: "json" },
    { sourceId: "S004", fileName: "response_to_reviewers.md", sourceType: "markdown" },
    { sourceId: "S005", fileName: "README.md", sourceType: "markdown" },
    { sourceId: "S006", fileName: "unknown.png", sourceType: "image" },
    { sourceId: "S007", fileName: "MANIFEST.json", sourceType: "json" },
  ];

  it("MANIFEST 角色映射 + current/historical 域隔离", () => {
    const inventory = buildAssetInventory(sources, MANIFEST);
    expect(inventory.manifestFound).toBe(true);
    expect(inventory.currentManuscriptPath).toBe("manuscript/source/paper.tex");
    const byId = new Map(inventory.entries.map((entry) => [entry.sourceId, entry]));
    expect(byId.get("S001")?.role).toBe("current_manuscript");
    expect(byId.get("S002")?.role).toBe("current_experiment");
    expect(byId.get("S003")?.role).toBe("historical_board_experiment");
    expect(byId.get("S004")?.role).toBe("submission_feedback");
    // 域隔离：PC current 与板端 historical 不同域，绝不混入同一集合
    expect(inventory.domains.current).toContain("S002");
    expect(inventory.domains.current).not.toContain("S003");
    expect(inventory.domains.historicalBoard).toEqual(["S003"]);
    expect(inventory.domains.feedback).toEqual(["S004"]);
    expect(inventory.domains.unclassified).toContain("S006");
    expect(byId.get("S007")?.role).toBe("case_manifest");
  });

  it("同名 basename（两个 README.md）→ ambiguous，不猜", () => {
    const inventory = buildAssetInventory(sources, MANIFEST);
    const byId = new Map(inventory.entries.map((entry) => [entry.sourceId, entry]));
    expect(byId.get("S005")?.role).toBe("ambiguous");
    expect(inventory.warnings.some((warning) => warning.includes("README.md"))).toBe(true);
  });

  it("MANIFEST 缺失 / 非法 → unclassified 退化（不阻塞）", () => {
    const none = buildAssetInventory(sources, null);
    expect(none.manifestFound).toBe(false);
    expect(none.entries.every((entry) => entry.role === "unclassified" || entry.role === "case_manifest")).toBe(true);
    const broken = buildAssetInventory(sources, "{not json");
    expect(broken.manifestFound).toBe(false);
    expect(broken.warnings.length).toBeGreaterThan(0);
  });
});

describe("M10.3 Revision Baseline", () => {
  it("表格 / 数字 / 引用 / 图 / 硬件 / 占位提取 + contentHash", () => {
    const tex = [
      "\\documentclass{ctexart}",
      "\\begin{document}",
      "\\section{实验}",
      "准确率提升 12.4\\%，FPS 达 3.31fps。硬件平台为 RDK X3。占位：待回填。",
      "\\begin{table}[h]",
      "\\caption{主结果}",
      "\\label{tab:main}",
      "\\begin{tabular}{ll}",
      "方法 & MOTA \\\\",
      "Ours & 82.4 \\\\",
      "\\end{tabular}",
      "\\end{table}",
      "\\includegraphics[width=0.9\\linewidth]{figs/framework.pdf}",
      "引用 \\cite{a} 与 \\cite{b}。",
      "\\end{document}",
    ].join("\n");
    const baseline = buildRevisionBaseline([{ file: "main.tex", content: tex }], "2026-09-30T00:00:00Z");
    expect(baseline.files).toEqual(["main.tex"]);
    expect(baseline.contentHash).toHaveLength(64);
    expect(baseline.tables).toHaveLength(1);
    expect(baseline.tables[0]?.label).toBe("tab:main");
    expect(baseline.tables[0]?.rows.some((row) => row.includes("82.4"))).toBe(true);
    expect(baseline.numbers[0]?.tokens).toContain("12.4%");
    expect(baseline.citationKeys).toEqual(["a", "b"]);
    expect(baseline.figures).toEqual(["figs/framework.pdf"]);
    expect(baseline.hardware.some((entry) => entry.replace(/\s+/g, " ").includes("RDK X3"))).toBe(true);
    expect(baseline.placeholders).toBeGreaterThan(0);
    expect(baseline.claims[0]?.sentences.some((sentence) => sentence.includes("12.4"))).toBe(true);
  });
});

describe("M10.3 外部意见 already_satisfied 终态", () => {
  const base = {
    source: "journal_reviewer" as const,
    reviewerLabel: "Reviewer 1",
    text: "建议补充近年文献对比。",
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
  };
  const satisfied: ExternalInstruction = {
    ...base,
    instructionId: externalInstructionId(base.source, base.reviewerLabel, base.text),
    status: "already_satisfied",
    statusNote: "投稿版已按 response 落实（2026-09-13 提交）",
  };

  it("add：initialStatus=already_satisfied 落盘；无 initialStatus → pending", async () => {
    const projects = await newProjectStore();
    const store = new ExternalInstructionStore(projects);
    const project = await projects.create("instructions");
    const projectId = project.id;
    const added = await store.add(projectId, {
      source: "journal_reviewer",
      reviewerLabel: "外审 1",
      text: "建议补充近年文献。",
      initialStatus: "already_satisfied",
      statusNote: "投稿版已落实",
    });
    expect(added?.status).toBe("already_satisfied");
    expect(added?.statusNote).toBe("投稿版已落实");
    const plain = await store.add(projectId, {
      source: "editor",
      text: "突出创新点。",
    });
    expect(plain?.status).toBe("pending");
    // initialStatus 但缺 statusNote → 退化为 pending（防滥用为跳过通道）
    const noNote = await store.add(projectId, {
      source: "editor",
      text: "突出创新点（另一条）。",
      initialStatus: "already_satisfied",
    });
    expect(noNote?.status).toBe("pending");
  });

  it("计划派生：already_satisfied → skipped（不派发），pending → planned", () => {
    const summary = emptySummary();
    const plan = buildRevisionPlan({
      projectId: "p1",
      sourceRevision: 1,
      reviewRound: 1,
      summary,
      externalInstructions: [satisfied, { ...base, instructionId: "x-pending", status: "pending" }],
    });
    const item = plan.items.find((entry) => entry.id === `external:${satisfied.instructionId}`);
    expect(item?.status).toBe("skipped");
    expect(item?.note).toContain("已在当前稿落实");
    expect(plan.items.find((entry) => entry.id === "external:x-pending")?.status).toBe("planned");
  });

  it("gate 复核不降级 already_satisfied（只降 handled）；派发聚合视为终态", () => {
    const handled: ExternalInstruction = {
      ...base,
      instructionId: "x-handled",
      status: "handled",
    };
    const failed = { ok: false };
    const reverted = reverifyHandledInstructions([satisfied, handled], failed, "t");
    expect(reverted.instructions.find((entry) => entry.instructionId === satisfied.instructionId)?.status).toBe(
      "already_satisfied",
    );
    expect(reverted.instructions.find((entry) => entry.instructionId === "x-handled")?.status).toBe("unresolved");

    const dispatch: ExternalDispatchResult = {
      round: 1,
      revision: 2,
      outcomes: [{ instructionId: satisfied.instructionId, outcome: "applied", targetChanged: true }],
      unmatched: [],
    };
    const applied = applyDispatchOutcome([satisfied], dispatch, "t");
    expect(applied.instructions[0]?.status).toBe("already_satisfied");
    expect(applied.changed).toBe(false);
  });

  it("HTTP 落盘读回：already_satisfied 保留 statusNote", () => {
    const read = readExternalInstructions({ instructions: [satisfied] });
    expect(read[0]?.status).toBe("already_satisfied");
    expect(read[0]?.statusNote).toContain("投稿版");
  });
});

describe("M10.3 Improvement Plan 授权链（Fact Preservation）", () => {
  const previous = {
    revision: 1,
    files: [{ file: "main.tex", content: "\\section{实验}\n本文方法 MOTA 为 78.2\\%。\\cite{a}\n" }],
  };

  it("expectedFactChanges 点名旧值新值 → 授权变更（plan_value_correction）", () => {
    const current = {
      revision: 2,
      files: [{ file: "main.tex", content: "\\section{实验}\n本文方法 MOTA 为 82.4\\%。\\cite{a}\n" }],
    };
    const result = evaluateFactPreservation({
      previous,
      current,
      plan: null,
      improvementPlanItems: [
        {
          section: "main.tex",
          action: "更新主表 MOTA 数值",
          rationale: "MOTA 78.2 → 82.4（依据：E001 复跑结果）",
        },
      ],
      evidenceTexts: [],
    });
    expect(result.changedFacts).toHaveLength(0);
    expect(result.allowedChanges).toBe(1);
  });

  it("user_confirmed Evidence（quote 含新值）授权新增数值（basis=evidence）", () => {
    const current = {
      revision: 2,
      files: [
        { file: "main.tex", content: "\\section{实验}\n本文方法 MOTA 为 78.2\\%。\\cite{a}\n新增：G2 指标 0.7108。\n" },
      ],
    };
    const result = evaluateFactPreservation({
      previous,
      current,
      plan: null,
      improvementPlanItems: [
        { section: "main.tex", action: "补充 G2 身份一致性指标", rationale: "新增 G2 0.7108" },
      ],
      // user_confirmed 证据以 claim+summary+quote 文本进入授权池（IngestionService 同构）
      evidenceTexts: ["rgate_hybrid 在低照度场景 G2 达 0.7108", "0.7108"],
    });
    expect(result.addedUnsupportedFacts).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("无授权的数值变更 → 违规（changedFacts 非空）", () => {
    const current = {
      revision: 2,
      files: [{ file: "main.tex", content: "\\section{实验}\n本文方法 MOTA 为 91.5\\%。\\cite{a}\n" }],
    };
    const result = evaluateFactPreservation({
      previous,
      current,
      plan: null,
      improvementPlanItems: [{ section: "main.tex", action: "润色表述", rationale: "语言优化" }],
      evidenceTexts: [],
    });
    expect(result.changedFacts.length).toBeGreaterThan(0);
    expect(result.ok).toBe(false);
  });

  it("historical 数值不覆盖 current：计划未点名的历史值（如旧板测值）不构成新值授权", () => {
    const current = {
      revision: 2,
      files: [{ file: "main.tex", content: "\\section{实验}\n本文方法 MOTA 为 286.57\\%。\\cite{a}\n" }],
    };
    const result = evaluateFactPreservation({
      previous,
      current,
      plan: null,
      // 历史板测证据在池（quote=286.57），但改进计划没有点名 78.2 → 286.57 的变更
      improvementPlanItems: [{ section: "main.tex", action: "润色表述", rationale: "语言优化" }],
      evidenceTexts: ["板端早期跟踪器 E2E 延迟 286.57 ms"],
    });
    expect(result.changedFacts.length).toBeGreaterThan(0);
  });
});

describe("M10.3 Revision Response markdown", () => {
  it("外部意见逐条投影（含 already_satisfied 依据）+ 复核结果", () => {
    const markdown = buildRevisionResponseMarkdown({
      instructions: [
        {
          instructionId: "x-abc",
          source: "journal_reviewer",
          reviewerLabel: "外审 1",
          text: "建议补充近年 MOT 方法对比。",
          status: "already_satisfied",
          statusNote: "投稿版引言已补充 6 篇（2021-2024）文献",
          createdAt: "t",
          updatedAt: "t",
        },
      ],
      plans: [],
      validation: null,
      improvementPlan: {
        items: [{ section: "main.tex", action: "补充对比论述", relatedEvidenceIds: ["E001"] }],
      },
      revision: 3,
      finalArtifactId: "art-final-rev3.pdf",
      draftArtifactId: null,
      generatedAt: "t",
    });
    expect(markdown).toContain("Revision Trace / Author Revision Report");
    expect(markdown).toContain("x-abc");
    expect(markdown).toContain("已在当前稿落实");
    expect(markdown).toContain("E001");
    expect(markdown).toContain("不是 Response Letter");
  });

  it("无外部意见 → 如实呈现（不虚构 Reviewer 意见）", () => {
    const markdown = buildRevisionResponseMarkdown({
      instructions: [],
      plans: [],
      validation: null,
      improvementPlan: null,
      revision: 1,
      finalArtifactId: null,
      draftArtifactId: null,
      generatedAt: "t",
    });
    expect(markdown).toContain("本轮没有登记任何外部修改意见");
  });
});

function emptySummary(): ReviewSummary {
  return {
    schemaVersion: 1,
    round: 1,
    generatedAt: "t",
    reportPaths: [],
    counts: { critical: 0, major: 0, minor: 0, info: 0, blocking: 0 },
    scores: {},
    issues: [],
  } as unknown as ReviewSummary;
}

describe("M10.3 Fact Preservation 整文件重排噪声归一", () => {
  const wrapPrevious = {
    revision: 1,
    files: [
      {
        file: "main.tex",
        content: [
          "\documentclass{ctexart}",
          "\newcommand{\keywords}[1]{\textbf{关键词：}#1}",
          "\section{实验}",
          "在 BDD100K 数据集上评估，延迟 1.5ms。",
          "\end{document}",
        ].join("\n"),
      },
    ],
  };

  it("行内断行拆数字（BDD1\n00K）与前导宏参数不再判违规（排版噪声 ≠ 事实漂移）", () => {
    const current = {
      revision: 2,
      files: [
        {
          file: "main.tex",
          content: [
            "\documentclass{ctexart}",
            "\newcommand{\keywords}[1]{\textbf{关键词：}#1}",
            "\section{实验}",
            // 整文件重排：BDD100K 被断行拆开；数字本身未动
            "在 BDD1\n00K 数据集上评估，延迟 1.5ms。",
            "\end{document}",
          ].join("\n"),
        },
      ],
    };
    const result = evaluateFactPreservation({
      previous: wrapPrevious,
      current,
      plan: null,
      improvementPlanItems: [],
      evidenceTexts: [],
    });
    expect(result.ok).toBe(true);
    expect(result.changedFacts).toHaveLength(0);
    expect(result.addedUnsupportedFacts).toHaveLength(0);
  });

  it("真实数值漂移（1.5ms → 3.0ms）仍被拦截", () => {
    const current = {
      revision: 2,
      files: [
        {
          file: "main.tex",
          content: wrapPrevious.files[0]!.content.replace("1.5ms", "3.0ms"),
        },
      ],
    };
    const result = evaluateFactPreservation({
      previous: wrapPrevious,
      current,
      plan: null,
      improvementPlanItems: [],
      evidenceTexts: [],
    });
    expect(result.ok).toBe(false);
  });
});

describe("M10.3 Asset Inventory 真实案例角色词表", () => {
  it("experiment_result → current 域；deployment_result → historicalBoard 域（真实 MANIFEST 词表）", () => {
    const manifest = JSON.stringify({
      caseVersion: 1,
      assets: [
        { packagedPath: "experiments/data/phase4/battery_phase4.json", role: "experiment_result" },
        { packagedPath: "experiments/data/board_c0_20260904/aggregate.json", role: "deployment_result" },
        { packagedPath: "context/phase-reports/phase5/FINAL_ALGORITHM_FREEZE.md", role: "evaluation_report" },
        { packagedPath: "feedback/response_to_reviewers.md", role: "reviewer_feedback_response" },
        { packagedPath: "manuscript/historical/paper_before_revision.tex", role: "historical_manuscript" },
      ],
    });
    const inventory = buildAssetInventory(
      [
        { sourceId: "S001", fileName: "battery_phase4.json", sourceType: "json" },
        { sourceId: "S002", fileName: "aggregate.json", sourceType: "json" },
        { sourceId: "S003", fileName: "FINAL_ALGORITHM_FREEZE.md", sourceType: "markdown" },
        { sourceId: "S004", fileName: "response_to_reviewers.md", sourceType: "markdown" },
        { sourceId: "S005", fileName: "paper_before_revision.tex", sourceType: "latex" },
      ],
      manifest,
    );
    expect(inventory.domains.current).toContain("S001");
    expect(inventory.domains.historicalBoard).toContain("S002");
    expect(inventory.domains.current).toContain("S003");
    expect(inventory.domains.feedback).toContain("S004");
    expect(inventory.domains.historical).toContain("S005");
    // 嵌入域隔离红线：PC current 与板端 historical 互斥
    expect(inventory.domains.current).not.toContain("S002");
    expect(inventory.domains.historicalBoard).not.toContain("S001");
  });
});

describe("M10.3 Asset Inventory 上传改名回退匹配", () => {
  it("加前缀的上传名（board_c0_aggregate.json ← aggregate.json）唯一后缀命中 → 角色保留", () => {
    const manifest = JSON.stringify({
      caseVersion: 1,
      assets: [
        { packagedPath: "experiments/data/board_c0_20260904/aggregate.json", role: "deployment_result" },
        { packagedPath: "experiments/data/phase4/battery_phase4.json", role: "experiment_result" },
      ],
    });
    const inventory = buildAssetInventory(
      [
        { sourceId: "S001", fileName: "board_c0_aggregate.json", sourceType: "json" },
        { sourceId: "S002", fileName: "battery_phase4.json", sourceType: "json" },
      ],
      manifest,
    );
    const board = inventory.entries.find((e) => e.sourceId === "S001")!;
    expect(board.role).toBe("deployment_result");
    expect(board.sourceId).not.toBe(undefined);
    expect(inventory.domains.historicalBoard).toContain("S001");
  });

  it("后缀多命中（两个 aggregate 结尾资产）→ ambiguous 不猜", () => {
    const manifest = JSON.stringify({
      caseVersion: 1,
      assets: [
        { packagedPath: "a/aggregate.json", role: "deployment_result" },
        { packagedPath: "b/aggregate.json", role: "experiment_result" },
      ],
    });
    const inventory = buildAssetInventory(
      [{ sourceId: "S001", fileName: "x_aggregate.json", sourceType: "json" }],
      manifest,
    );
    expect(inventory.entries[0]?.role).toBe("ambiguous");
  });
});
