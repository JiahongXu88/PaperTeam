/**
 * Deterministic Bibliography & Citation Trace 工作流集成测试（M9.5 §14-7~12）：
 *
 * 真实编排 + 真实业务栈（SourceStore / EvidenceStore / ManuscriptService /
 * citation.verify / quality.gate），Runtime 脚本化。验证闭环：
 *   Verified Evidence → SourceIdentity → 确定性 citation key
 *   → Writer \cite{key}（prompt allowed keys 由系统生成）
 *   → references.bib（只含实际引用；byte identical 重复生成）
 *
 * 覆盖：
 * 7.  Verified Evidence 绑定 citation key（sourceId 追溯写入 bib 且被 gate 消费）
 * 8.  Legacy unverified evidence 不产生 cite 标注（selectForWriting formalOnly）
 * 9.  Writer prompt 的 allowed keys = canonical bibliography（确定性 key，非 LLM key）
 * 10. references.bib 不包含未使用 source（citation.verify 同步裁剪）
 * 11. 重复生成 references.bib byte identical（与独立计算的渲染逐字节相等）
 * 12. 旧项目兼容：Existing-Paper（LaTeX 导入）的 references.bib 不被改写
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";
import { WriterService } from "../../src/writer/WriterService.js";
import { renderBibliographyFile, filterByCitedKeys, buildBibliographyFromSources, mergeArtifactBibliography } from "../../src/citation/bibliography.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../../src/runtime/types.js";

vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 20_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (run.status === "failed" && !statuses.includes("failed")) {
      throw new Error(`run 意外失败：${run.error?.code} ${run.error?.message}（stage ${run.error?.stageId ?? "?"}）`);
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${statuses.join("|")} 超时（当前 ${run.status}，stage ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 图书馆条目 S001 = scripted research bibliography 的同一篇 Gao 综述（同标题+年份 → artifact 条目被丢弃） */
const GAO_TITLE = "Retrieval-Augmented Generation for Large Language Models: A Survey";

async function seedProject(stack: TestStack): Promise<string> {
  const project = await stack.store.create("确定性引用测试", {
    researchIdea: "小语料 RAG 评估",
    researchField: "自然语言处理",
  });
  await stack.stack.sources.addRecord(project.id, {
    sourceType: "doi",
    origin: "DOI_IMPORT",
    metadata: {
      title: GAO_TITLE,
      authors: ["Gao, Yunfan", "Xiong, Yun"],
      year: 2023,
      doi: "10.1145/3578937",
      venue: "ACM Computing Surveys",
    },
    versionType: "journal",
  });
  // S002：不会被脚本 Writer 引用的图书馆条目（用于验证 references.bib 裁剪）
  await stack.stack.sources.addRecord(project.id, {
    sourceType: "arxiv",
    origin: "ARXIV_IMPORT",
    metadata: {
      title: "Attention Is All You Need",
      authors: ["Vaswani, Ashish"],
      year: 2017,
      arxivId: "1706.03762",
    },
    versionType: "preprint",
  });
  // 已核验锚定证据（verified + sourceId + chunk）+ legacy unverified 线索
  await stack.stack.evidence.append(
    project.id,
    {
      claim: "引入检索后事实错误率平均下降",
      quote: "The average factual error rate drops",
      source: { sourceId: "S001", title: GAO_TITLE, year: 2023, doi: "10.1145/3578937" },
      location: { chunk: "S001:SEC01:0001:abcd1234ef", section: "5" },
      verificationStatus: "verified",
      verificationLevel: "fulltext",
      verificationMethod: "evidence-grounding/v1 quote=exact",
      supportStrength: "direct",
    },
    "researcher",
  );
  await stack.stack.evidence.append(
    project.id,
    {
      claim: "一条未核验的 legacy 线索（不得产生 cite 标注）",
      source: { title: "Some Unverified Web Note", year: 2021 },
    },
    "researcher",
  );
  return project.id;
}

async function runToCompletion(stack: TestStack, projectId: string): Promise<string> {
  const created = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
    kind: "idea_to_paper",
  });
  expect(created.status).toBe(202);
  const runId = created.body["runId"] as string;
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  const finished = await pollRun(stack, runId, ["completed"]);
  expect(finished.completion?.label).toBe("final");
  return runId;
}

describe("Deterministic Bibliography（idea_to_paper 全流程）", () => {
  it("Verified Evidence → 确定性 key → \\cite → references.bib 闭环；未引用 source 被裁剪；重复渲染 byte identical", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const projectId = await seedProject(stack);
    const runId = await runToCompletion(stack, projectId);

    const root = join(stack.root, projectId);

    // 1. 章节正文引用确定性 key（Writer prompt allowed keys 由系统生成）
    const intro = await readFile(join(root, "manuscript", "sections", "introduction.tex"), "utf8");
    expect(intro).toContain("\\cite{gao2023retrieval}");
    expect(intro).not.toContain("gao2023survey"); // LLM 自造 key 不进正文

    // 2. references.bib：只含实际引用条目（S002 Vaswani 未被引用 → 不出现）
    const bib = await readFile(join(root, "manuscript", "references.bib"), "utf8");
    expect(bib).toContain("gao2023retrieval");
    expect(bib).toContain("sourceId = {S001}"); // Evidence → SourceIdentity 追溯字段
    expect(bib).toContain("doi = {10.1145/3578937}");
    expect(bib).not.toContain("vaswani2017attention");
    expect(bib).not.toContain("Attention Is All You Need");

    // 3. byte identical：与独立重算的确定性渲染逐字节相等（同输入必同输出）
    const [items, artifactRaw] = await Promise.all([
      stack.stack.sources.list(projectId),
      readFile(join(root, "research", "research.json"), "utf8"),
    ]);
    const artifact = JSON.parse(artifactRaw) as { bibliography?: Array<Record<string, unknown>> };
    const canonical = mergeArtifactBibliography(
      buildBibliographyFromSources(items),
      (artifact.bibliography ?? []) as never,
    );
    const expected = renderBibliographyFile(filterByCitedKeys(canonical, ["gao2023retrieval"]));
    expect(bib).toBe(expected);

    // 4. 引用核验：无 missing key（summary.missingKeys 为计数）；sourceId 追溯字段可解析
    const citationReport = JSON.parse(
      await readFile(join(root, "reviews", "citation-report.json"), "utf8"),
    ) as { summary?: { missingKeys?: number | string[] }; static?: { bibEntries?: Array<{ sourceId?: string }> } };
    const missing = citationReport.summary?.missingKeys ?? 0;
    if (Array.isArray(missing)) {
      expect(missing).toEqual([]);
    } else {
      expect(missing).toBe(0);
    }
    expect(
      citationReport.static?.bibEntries?.some((entry) => entry.sourceId === "S001"),
    ).toBe(true);

    // 5. Quality Gate：citations_evidence_backed 以 verified evidence 覆盖（legacy 不算覆盖来源）
    const gateReport = JSON.parse(
      await readFile(join(root, "reviews", "quality-gate-r1.json"), "utf8"),
    ) as { evidenceCitationCoverage?: { covered?: string[]; uncovered?: string[] } };
    expect(gateReport.evidenceCitationCoverage?.covered).toContain("gao2023retrieval");
    expect(gateReport.evidenceCitationCoverage?.uncovered).toEqual([]);

    // 6. 编译产物存在（references.bib 与 \cite 配对可编译）
    const run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as WorkflowState;
    expect(run.completion?.summary?.["buildOk"]).toBe(true);
  });
});

// ---- 8 / 9. Writer formalOnly：verified 才有 cite 标注 ----

function promptCapturingRuntime(): { runtime: AgentRuntime; tasks: string[] } {
  const tasks: string[] = [];
  const now = () => new Date().toISOString();
  const runtime: AgentRuntime = {
    provider: "pi",
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "prompt capture",
      latencyMs: 1,
      checkedAt: now(),
    }),
    startAgent: async (input: RunAgentInput) => {
      const task = await runtime.runAgent(input);
      return {
        taskId: task.taskId,
        sessionKey: "capture",
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    runAgent: async (input: RunAgentInput) => {
      tasks.push(input.task);
      const task: AgentTask = {
        taskId: `t-${tasks.length}`,
        agentId: input.agentId,
        status: "completed",
        createdAt: now(),
        updatedAt: now(),
        output: "\\section{引言}\n如 \\cite{gao2023retrieval} 所示。",
      };
      return task;
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  } as unknown as AgentRuntime;
  return { runtime, tasks };
}

describe("Writer formalOnly cite 标注（选择层 → prompt）", () => {
  it("verified 锚定证据带（cite: 确定性key）标注；legacy unverified 不产生 cite 标注", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const projectId = await seedProject(stack);

    const selection = await stack.stack.evidenceSelection.selectForWriting(projectId);
    expect(selection.formal.map((record) => record.id)).toEqual(["E001"]);
    expect(selection.excluded.legacyUnverified).toBe(1);

    const { runtime, tasks } = promptCapturingRuntime();
    const writer = new WriterService({ runtime, agentId: "writer", log: () => {} });
    const bibliography = mergeArtifactBibliography(
      buildBibliographyFromSources(await stack.stack.sources.list(projectId)),
      [],
    );
    await writer.writeSection({
      projectId,
      section: { id: "introduction", file: "introduction.tex", title: "引言" },
      outline: { title: "T", sections: [{ id: "introduction", file: "introduction.tex", title: "引言" }] },
      evidence: selection.formal,
      bibliography,
    });
    const prompt = tasks[0] ?? "";
    expect(prompt).toContain("[E001]（cite: gao2023retrieval）");
    expect(prompt).toContain("只允许引用以下参考文献 key：gao2023retrieval, vaswani2017attention");
    expect(prompt).not.toContain("Some Unverified Web Note"); // legacy 不进正式上下文
    expect(prompt).not.toContain("gao2023survey"); // LLM key 不出现在 prompt
  });
});

// ---- 12. 旧项目（Existing-Paper LaTeX 导入）兼容 ----

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
  return Buffer.concat([...parts, ...central, end]);
}

const USER_BIB = "@article{userkey2020,\n  title = {User Authored Paper},\n  year = {2020}\n}\n";

describe("旧项目兼容（Existing-Paper references.bib 不被改写）", () => {
  it("LaTeX 导入项目全流程后用户 references.bib 逐字节保持", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const project = await stack.store.create("已有论文", { targetProfile: "core_journal" });
    const archive = buildZip([
      {
        name: "main.tex",
        data: Buffer.from(
          [
            "\\documentclass[UTF8]{ctexart}",
            "\\begin{document}",
            "\\input{sections/introduction}",
            "\\bibliographystyle{unsrt}",
            "\\bibliography{references}",
            "\\end{document}",
          ].join("\n"),
          "utf8",
        ),
      },
      {
        name: "sections/introduction.tex",
        data: Buffer.from("\\section{引言}\n既有工作 \\cite{userkey2020}。", "utf8"),
      },
      { name: "references.bib", data: Buffer.from(USER_BIB, "utf8") },
    ]);
    const imported = await stack.request("POST", `/api/projects/${project.id}/import`, {
      archiveBase64: archive.toString("base64"),
    });
    expect(imported.status).toBe(200);

    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {
      kind: "existing_paper_improvement",
    });
    expect(created.status).toBe(202);
    const runId = created.body["runId"] as string;
    // plan_confirm HITL → approve → 完成
    const run = await pollRun(stack, runId, ["awaiting_input"]);
    expect(run.awaiting?.stageId).toBe("hitl.plan_confirm");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    await pollRun(stack, runId, ["completed"]);

    const bibAfter = await readFile(
      join(stack.root, project.id, "manuscript", "references.bib"),
      "utf8",
    );
    expect(bibAfter).toBe(USER_BIB); // 用户 bib 原样（sync 守卫：existing-paper 不触碰）
  });
});
