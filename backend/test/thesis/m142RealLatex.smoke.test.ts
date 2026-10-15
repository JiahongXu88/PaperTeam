/**
 * M14.2 真实 LaTeX 工作流 Smoke（env 门控：PAPERTEAM_M142_REAL_LATEX=1；默认跳过，不进 CI）。
 *
 * 运行（服务器）：PAPERTEAM_M142_REAL_LATEX=1 npx vitest run test/thesis/m142RealLatex.smoke.test.ts
 *
 * 证明：thesis_from_papers 的 writing.sections → 确定性装配 → build.draft
 * （真实 xelatex + bibtex/gbt7714）→ Draft 产物注册 全链在真实 TeX 上工作。
 * 模型侧仍是 scripted runtime（本 smoke 只验证编译与产物链；真实模型见
 * m142RealModel.smoke）。零新增模型调用。
 *
 * 与 thesis.e2e 的差异：testStack realLatex=true（无 fake runner）；scripted
 * 节输出剥掉 \eqref{eq:1}（canned fixture 无对应 \label，真实编译会因未解析
 * 引用正确失败——那正是 M14.1c 修复的 fail-closed，不是本 smoke 的对象）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createScriptedRuntime, THESIS_CONTRIBUTION_QUOTE } from "../../src/runtime/scriptedRuntime.js";
import type { AgentRuntime, RunAgentInput } from "../../src/runtime/types.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { tableBlock, textBlock } from "./fixtures.js";
import type { ParsedBlock } from "../../src/ingestion/types.js";

const live = process.env["PAPERTEAM_M142_REAL_LATEX"] === "1";
const cleanups: (() => Promise<void>)[] = [];

/** 剥掉 canned 节输出中的悬空 \eqref（真实编译 fail-closed 会拒绝未解析引用） */
function eqrefStrippedRuntime(base: AgentRuntime): AgentRuntime {
  return {
    ...base,
    runAgent: async (input: RunAgentInput) => {
      const task = await base.runAgent(input);
      if (input.contextScope === "writing/sections" && task.output !== undefined) {
        return { ...task, output: task.output.replace(/检索质量与幻觉率的关系如式[^。]*。/g, "") };
      }
      return task;
    },
  };
}

describe.skipIf(!live)("M14.2 真实 LaTeX 工作流 smoke", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await startTestStack(eqrefStrippedRuntime(createScriptedRuntime({ reviewSequence: ["pass"] }).runtime), {
      realLatex: true,
      ...(process.env["PAPERTEAM_M142_REAL_LATEX_ROOT"] !== undefined
        ? { root: process.env["PAPERTEAM_M142_REAL_LATEX_ROOT"] }
        : {}),
      registerCleanup: (cleanup: () => Promise<void>) => cleanups.push(cleanup),
    });
  });

  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  it(
    "thesis 工作流 → 装配 → 真实 xelatex 编译 → Draft PDF 产物注册",
    async () => {
      const project = await stack.store.create("M14.2 真实 LaTeX 学位论文 smoke", { language: "zh", documentType: "master_thesis" });
      const projectId = project.id;
      const blocks: ParsedBlock[] = [
        textBlock("B0001", 1, `研究背景。${THESIS_CONTRIBUTION_QUOTE}`),
        tableBlock("B0002", 2, ["Method", "S ↑"], [["Ours", "0.724"], ["Base", "0.667"]], "表1 消融"),
      ];
      const { source } = await stack.stack.sources.add(projectId, {
        fileName: "real-latex-paper.pdf",
        content: Buffer.from("%PDF-1.5\nreal-latex-paper-content", "utf8"),
      });
      const { ParsedDocumentStore } = await import("../../src/ingestion/ParsedDocumentStore.js");
      void ParsedDocumentStore;
      const document = {
        schemaVersion: 1 as const,
        sourceId: source.sourceId,
        fileName: "real-latex-paper.pdf",
        storedFileName: "real-latex-paper.pdf",
        kind: "pdf" as const,
        mimeType: "application/pdf",
        parser: { id: "test-fixture", version: "1" },
        parseMode: "structured" as const,
        status: "ok" as const,
        pageCount: 2,
        blocks,
        counts: { text: 1, table: 1 } as never,
        notes: [],
        contentHash: source.contentHash!,
        parsedAt: new Date().toISOString(),
      };
      await stack.stack.parsedDocuments.save(projectId, document);
      const registered = await stack.stack.researchInputs.register(
        projectId,
        { sourceId: source.sourceId, inputType: "published_paper", title: "真实编译论文" },
        { ensureParsed: false },
      );
      await stack.stack.researchInputs.registry.refreshParse(projectId, registered.input.inputId);

      const runResponse = await stack.request("POST", `/api/projects/${projectId}/workflows`, {});
      expect(runResponse.status).toBe(202);
      const runId = runResponse.body["runId"] as string;

      // 驱动 HITL：include → 确认全部贡献（事实不确认 → author_decision → 限制口径）
      const deadline = Date.now() + 420_000;
      for (;;) {
        const run = ((await stack.request("GET", `/api/runs/${runId}`)).body["run"] ?? {}) as {
          status: string;
          awaiting?: { stageId: string; payload?: Record<string, unknown> };
        };
        if (run.status === "awaiting_input" && run.awaiting !== undefined) {
          const payload = run.awaiting.payload;
          let decision: string | undefined;
          let body: Record<string, unknown> | undefined;
          if (run.awaiting.stageId === "hitl.scope_and_version") {
            const proposed = (payload?.["inputs"] as { proposed?: Array<{ inputId: string }> } | undefined)?.proposed ?? [];
            const contributions = (payload?.["contributions"] as Array<{ id: string; status: string }> | undefined) ?? [];
            const unconfirmed = contributions.filter((item) => item.status === "proposed").map((item) => item.id);
            if (proposed.length > 0) {
              decision = "include";
              body = { inputId: proposed[0]!.inputId, actorKind: "test_fixture" };
            } else if (unconfirmed.length > 0) {
              decision = "confirm_contribution";
              body = { contributionIds: unconfirmed, actorKind: "test_fixture" };
            } else {
              decision = "approve";
              body = { actorKind: "test_fixture" };
            }
          } else if (run.awaiting.stageId === "hitl.outline_confirm") {
            decision = "approve";
            body = { actorKind: "test_fixture" };
          } else if (run.awaiting.stageId === "hitl.author_decision") {
            const missing = (payload?.["missingChapters"] as Array<{ chapterId: string }> | undefined) ?? [];
            decision = missing.length > 0 ? "write_as_limitation" : "approve";
            body = { ...(missing.length > 0 ? { subject: missing[0]!.chapterId } : {}), actorKind: "test_fixture" };
          }
          if (decision === undefined) {
            throw new Error(`未预期的 HITL：${run.awaiting.stageId}`);
          }
          const resume = await stack.request("POST", `/api/runs/${runId}/resume`, { decision, payload: body });
          expect(resume.status).toBe(200);
          continue;
        }
        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          expect({ status: run.status }).toEqual({ status: "completed" });
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(`真实编译 smoke 超时（status=${run.status}）`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Draft 产物 + 真实 PDF 魔数
      const finalRun = ((await stack.request("GET", `/api/runs/${runId}`)).body["run"] ?? {}) as {
        stageResults?: Record<string, Record<string, unknown>>;
      };
      const draftArtifactId = finalRun.stageResults?.["build.draft"]?.["draftArtifactId"] as string | undefined;
      expect(draftArtifactId).toMatch(/^art-draft-rev\d+$/);
      const pdf = await readFile(join(stack.store.buildDir(projectId), "paper.pdf"));
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      const mainTex = await readFile(join(stack.store.projectDir(projectId), "manuscript-thesis", "main.tex"), "utf8");
      expect(mainTex).toContain("ctexbook");
      console.log(
        `[m142-real-latex] draft=${draftArtifactId} pdfBytes=${pdf.length} tool=${finalRun.stageResults?.["build.draft"]?.["tool"] ?? "?"}`,
      );
    },
    480_000,
  );
});
