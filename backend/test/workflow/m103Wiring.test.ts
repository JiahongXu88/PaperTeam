/**
 * M10.3 接线 e2e（scripted Runtime + 离线检索栈；确定性）：
 *
 * 单文件 LaTeX 导入项目（真实案例形态：paper.tex 单文件 + refs.bib）走
 * existing_paper_improvement 全流程，验证 M10.3 新接线：
 * - import.inventory：MANIFEST 案例清单 → 角色 / 域隔离产物
 * - import.baseline：修订前事实基线
 * - research.plan → hitl.research_plan（M8 纪律：批准后才执行）→ research.execute
 *   → hitl.evidence_supply（requirement 缺口触发）→ research.propose → evidence.ground
 * - plan.improvement → hitl.plan_confirm → revision.apply（整文件修订目标）
 * - revision.report：build/revision-response.md
 * - 单文件 main.tex 修订目标 + wholeFile Writer 契约（事实 / 引用逐字保留）
 * - already_satisfied 外部意见：登记后不派发
 * - user_confirmed 结构化记录证据：≠ formal；bib 追加式合并 evidence-backed key
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import {
  scriptedIdeaRuntime,
  startTestStack,
  pollRunUntilAwaiting,
  type TestStack,
} from "../helpers/testStack.js";
import { appendEvidenceBackedBibEntries } from "../../src/workflow/definitions.js";

vi.setConfig({ testTimeout: 60_000 });

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, compressed);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

const PAPER_TEX = [
  "\\documentclass[UTF8]{ctexart}",
  "\\usepackage{cite}",
  "\\begin{document}",
  "\\section{引言}",
  "本文方法在两个数据集上验证，MOTA 提升 12.4\\%。\\cite{a}",
  "\\section{实验}",
  "\\begin{table}[h]",
  "\\caption{主结果}",
  "\\label{tab:main}",
  "\\begin{tabular}{ll}",
  "方法 & MOTA \\\\",
  "Ours & 82.4 \\\\",
  "\\end{tabular}",
  "\\end{table}",
  "板端部署于 RDK X3 平台。",
  "\\bibliographystyle{unsrt}",
  "\\bibliography{refs}",
  "\\end{document}",
].join("\n");

const SINGLE_FILE_ARCHIVE = buildZip([
  { name: "paper.tex", data: Buffer.from(PAPER_TEX, "utf8") },
  { name: "refs.bib", data: Buffer.from("@article{a, title={A Good Paper}, year={2020}}", "utf8") },
]);

const CASE_MANIFEST = JSON.stringify({
  caseVersion: 1,
  currentManuscript: { packagedPath: "manuscript/source/paper.tex" },
  assets: [
    { packagedPath: "manuscript/source/paper.tex", role: "current_manuscript", confidence: "high" },
    { packagedPath: "experiments/data/battery.json", role: "current_experiment" },
    { packagedPath: "experiments/data/board_aggregate.json", role: "historical_board_experiment" },
  ],
});

async function newStack(): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
  return startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
}

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 30_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (run.status === "failed" && !statuses.includes("failed")) {
      throw new Error(
        `run 意外失败：${run.error?.code} ${run.error?.message}（stage ${run.error?.stageId ?? "?"}）`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${statuses.join("|")} 超时（当前 ${run.status}，stage ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function upload(stack: TestStack, projectId: string, fileName: string, content: Buffer) {
  return stack.request("POST", `/api/projects/${projectId}/sources`, {
    fileName,
    contentBase64: content.toString("base64"),
  });
}

describe("M10.3 existing_paper_improvement 接线（单文件项目全流程）", () => {
  it("导入（单文件）+ MANIFEST + 实验数据 → 研究链 HITL → 修订 → Final + Revision Trace", async () => {
    const stack = await newStack();
    const project = await stack.store.create("M10.3 真实形态案例", { targetProfile: "core_journal" });
    const projectId = project.id;

    const imported = await stack.request("POST", `/api/projects/${projectId}/import`, {
      archiveBase64: SINGLE_FILE_ARCHIVE.toString("base64"),
    });
    expect(imported.status).toBe(200);
    expect((imported.body["report"] as { structure: { entryFile: string } }).structure.entryFile).toBe("paper.tex");

    // 资产上传（MANIFEST + current 实验 + historical 板端）→ 内联 ingestion
    const manifest = await upload(stack, projectId, "MANIFEST.json", Buffer.from(CASE_MANIFEST, "utf8"));
    expect(manifest.status).toBe(201);
    const battery = await upload(
      stack,
      projectId,
      "battery.json",
      Buffer.from(JSON.stringify({ readouts: { rgate_hybrid: { ll_dG2: 0.0218 } } }), "utf8"),
    );
    expect(battery.status).toBe(201);
    const board = await upload(
      stack,
      projectId,
      "board_aggregate.json",
      Buffer.from(JSON.stringify({ board: { e2e_ms: 1495.63 } }), "utf8"),
    );
    expect(board.status).toBe(201);

    // 第一轮 reviewer 意见：投稿版已落实 → already_satisfied 登记
    const instruction = await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
      source: "journal_reviewer",
      reviewerLabel: "外审 1",
      text: "建议补充车载视角目标检测/跟踪的相关研究。",
      initialStatus: "already_satisfied",
      statusNote: "投稿版（2026-09-13）引言已补充 6 篇近年文献，response 在案",
    });
    expect(instruction.status).toBe(200);
    expect((instruction.body["instruction"] as { status: string }).status).toBe("already_satisfied");

    // 结构化记录 → user_confirmed Evidence（current 实验域）
    // 直接以 jsonPath 定位确认（IngestionService.confirmRecordEvidence）
    const confirm = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/${(battery.body["source"] as { sourceId: string }).sourceId}/records/evidence`,
      { path: "$.readouts.rgate_hybrid.ll_dG2", claim: "rgate_hybrid 在低照度场景的 G2 增益为 0.0218" },
    );
    expect(confirm.status).toBe(201);
    const evidence = confirm.body["evidence"] as {
      id: string;
      verificationLevel?: string;
      verificationStatus?: string;
    };
    expect(evidence.verificationLevel).toBe("user_confirmed");
    expect(evidence.verificationStatus).toBe("unverified");
    // user_confirmed ≠ grounded_verified：不进 formal 池
    const listed = await stack.request("GET", `/api/projects/${projectId}/evidence`);
    const all = listed.body["evidence"] as unknown as {
      id: string;
      verificationLevel?: string;
      verificationStatus?: string;
    }[];
    const confirmed = all.find((record) => record.id === evidence.id);
    expect(confirmed).toBeDefined();
    expect(confirmed?.verificationLevel).toBe("user_confirmed");
    expect(confirmed?.verificationStatus).toBe("unverified");

    // 启动工作流
    const created = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_improvement",
      prompt: "基于 Phase5 贡献草案扩展返修稿：接入身份可靠性研究链（rgate 零参数门控）",
    });
    expect(created.status).toBe(202);
    const runId = created.body["runId"] as string;

    // 1) hitl.research_plan：M8 纪律——检索执行前批准
    const researchPlan = await pollRunUntilAwaiting(stack, runId, "hitl.research_plan", {
      autoDecisions: {},
    });
    const planPayload = researchPlan.awaiting?.payload as {
      planId?: string;
      requirements?: { topic: string; priority: string }[];
      queries?: { query: string; kind: string }[];
    };
    expect(planPayload?.requirements?.length).toBeGreaterThan(0);
    expect(planPayload?.queries?.length).toBeGreaterThan(0);
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    // 2) hitl.evidence_supply：requirement 缺口触发（离线栈检索失败 → missing）
    const supply = await pollRunUntilAwaiting(stack, runId, "hitl.evidence_supply", {
      autoDecisions: {},
    });
    const supplyPayload = supply.awaiting?.payload as {
      requirements?: { requirementId: string; coverageStatus: string }[];
    };
    expect(supplyPayload?.requirements?.length).toBeGreaterThan(0);
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "continue" });

    // 3) hitl.plan_confirm：改进计划（单文件项目条目指向 main.tex）
    const planConfirm = await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm", {
      autoDecisions: {},
    });
    const items = (planConfirm.awaiting?.payload as { items?: { section: string }[] })?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.section).toBe("main.tex");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    const finished = await pollRun(stack, runId, ["completed", "failed"]);
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    expect(finished.completedStages).toEqual(
      expect.arrayContaining([
        "import.parse",
        "import.baseline_build",
        "import.inventory",
        "import.baseline",
        "import.understand",
        "citation.verify",
        "review.run",
        "assessment.target",
        "research.plan",
        "hitl.research_plan",
        "research.execute",
        "hitl.evidence_supply",
        "research.propose",
        "evidence.ground",
        "plan.improvement",
        "hitl.plan_confirm",
        "revision.apply",
        "quality.gate",
        "build.draft",
        "build.final",
        "revision.report",
      ]),
    );

    // 产物：资产清单（角色 + 域隔离）
    const inventory = JSON.parse(
      await readFile(join(stack.root, projectId, "research", "asset-inventory.json"), "utf8"),
    ) as {
      manifestFound: boolean;
      currentManuscriptPath?: string;
      domains: { current: string[]; historicalBoard: string[] };
    };
    expect(inventory.manifestFound).toBe(true);
    expect(inventory.currentManuscriptPath).toBe("manuscript/source/paper.tex");
    expect(inventory.domains.historicalBoard).toHaveLength(1);
    expect(inventory.domains.current).not.toContain(inventory.domains.historicalBoard[0]);

    // 产物：事实基线
    const baseline = JSON.parse(
      await readFile(join(stack.root, projectId, "research", "revision-baseline.json"), "utf8"),
    ) as { contentHash: string; citationKeys: string[]; tables: unknown[] };
    expect(baseline.contentHash).toHaveLength(64);
    expect(baseline.citationKeys).toEqual(["a"]);
    expect(baseline.tables.length).toBeGreaterThan(0);

    // 产物：研究计划链（approved → done；requirements 保留）
    const research = JSON.parse(
      await readFile(join(stack.root, projectId, "research", "research.json"), "utf8"),
    ) as {
      kind?: string;
      plans?: { status: string; requirements?: unknown[] }[];
      activePlanId?: string;
    };
    expect(research.kind).toBe("existing_paper_analysis");
    const active = research.plans?.find((plan) => plan.status !== undefined);
    expect(active?.status === "done" || research.plans?.every((plan) => plan.status === "done")).toBe(true);

    // 单文件项目仍按 logicalSection 定向修订；已验证的事实与引用必须保留。
    const revised = await readFile(join(stack.root, projectId, "manuscript", "main.tex"), "utf8");
    expect(revised).toContain("\\documentclass");
    expect(revised).toContain("12.4");
    expect(revised).toContain("82.4");
    expect(revised).toContain("RDK X3");
    expect(revised).toContain("\\cite{a}");
    expect(revised).not.toContain("scripted whole-file revision");

    // already_satisfied 意见未被派发改稿，并保留导入时的审计 trace。
    const instructions = await stack.request("GET", `/api/projects/${projectId}/external-instructions`);
    const round1 = (instructions.body["instructions"] as {
      status: string;
      instructionId: string;
      resolutionTrace?: { verification: { fact?: boolean; citation?: boolean }; status: string; actionType: string };
    }[]).find(
      (entry) => entry.instructionId.startsWith("x-"),
    );
    expect(round1?.status).toBe("already_satisfied");
    expect(round1?.resolutionTrace).toMatchObject({
      status: "already_satisfied",
      actionType: "noop",
    });

    // 产物：Revision Trace 报告（含 already_satisfied 意见投影；不虚构意见）
    const response = await readFile(join(stack.root, projectId, "build", "revision-response.md"), "utf8");
    expect(response).toContain("Revision Trace / Author Revision Report");
    expect(response).toContain("已在当前稿落实");
    expect(response).toContain("投稿版（2026-09-13）");
  });

  it("bib 追加式合并：evidence-backed 新 key 追加；既有条目逐字节保持；无证据 key 不追加", async () => {
    const stack = await newStack();
    const project = await stack.store.create("bib append", { workflowKind: "existing_paper_improvement" });
    const projectId = project.id;
    const imported = await stack.request("POST", `/api/projects/${projectId}/import`, {
      archiveBase64: SINGLE_FILE_ARCHIVE.toString("base64"),
    });
    expect(imported.status).toBe(200);

    // 文献库 source（authors/title/year → canonical key du2023strongsort）
    const source = await stack.request("POST", `/api/projects/${projectId}/sources`, {
      fileName: "strongsort_paper.pdf",
      contentBase64: Buffer.from("%PDF-1.4\n", "latin1").toString("base64"),
      title: "StrongSORT: Make DeepSORT Great Again",
      authors: ["Du, Yunhao"],
      year: 2023,
    });
    const sourceId = (source.body["source"] as { sourceId: string }).sourceId;

    // 正文引用新 key（模拟 Writer 已新增引用）
    const mainPath = join(stack.root, projectId, "manuscript", "main.tex");
    const original = await readFile(mainPath, "utf8");
    await writeFile(mainPath, original.replace("\\cite{a}", "\\cite{a}\\cite{du2023strongsort}"), "utf8");

    // 无证据时：不追加
    const before = await readFile(join(stack.root, projectId, "manuscript", "refs.bib"), "utf8");
    const appended0 = await appendEvidenceBackedBibEntries(stack.stack.workflowServices, projectId);
    expect(appended0).toBe(0);
    expect(await readFile(join(stack.root, projectId, "manuscript", "refs.bib"), "utf8")).toBe(before);

    // verified 证据（sourceId + chunk 锚定 → formal；bibliography key 由
    // title+year 解析命中 canonical 条目）
    const evidenceAdded = await stack.request("POST", `/api/projects/${projectId}/evidence`, {
      claim: "StrongSORT 通过自适应外观建模改进在线关联",
      quote: "StrongSORT with adaptive appearance model",
      source: { sourceId, title: "StrongSORT: Make DeepSORT Great Again", year: 2023 },
      location: { chunk: `${sourceId}:SEC1:1:abcdefghij` },
      verificationStatus: "verified",
    });
    expect(evidenceAdded.status).toBe(201);
    const record = evidenceAdded.body["evidence"] as { id: string };
    const evidenceList = await stack.request("GET", `/api/projects/${projectId}/evidence`);
    const formal = (evidenceList.body["evidence"] as unknown as { id: string }[]).find(
      (entry) => entry.id === record.id,
    );
    expect(formal).toBeDefined();

    const appended = await appendEvidenceBackedBibEntries(stack.stack.workflowServices, projectId);
    expect(appended).toBe(1);
    const after = await readFile(join(stack.root, projectId, "manuscript", "refs.bib"), "utf8");
    expect(after.startsWith(before)).toBe(true); // 既有条目逐字节保持（append-only）
    expect(after).toContain("du2023strongsort");

    // 幂等：再次执行不重复追加
    const appendedAgain = await appendEvidenceBackedBibEntries(stack.stack.workflowServices, projectId);
    expect(appendedAgain).toBe(0);
  });
});
