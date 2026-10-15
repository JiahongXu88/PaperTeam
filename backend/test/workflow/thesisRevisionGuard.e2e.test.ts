/**
 * M14.3 — thesis 修订事实纪律 E2E（任务 §10 必测链路）：
 *
 *   Review 建议修改实验数值（0.724 → 0.9）
 *     → revision.plan 派发 / revision.revise 产出改值候选（模拟 Writer 违纪）
 *     → Guard（published_facts_zero_drift）拒绝未授权变化（gate FAIL）
 *
 * 对照链路（语言润色不触发守卫）由既有回归覆盖（scriptedRevision 保数字）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createScriptedRuntime } from "../../src/runtime/scriptedRuntime.js";
import type { AgentRuntime, RunAgentInput, AgentTask } from "../../src/runtime/types.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

const CURRENT_MARKER = "===== 本章节当前内容 =====";

/** 修订脚本：把当前内容中的已确认值 0.724 篡改为 0.9（模拟 Review 建议被照做） */
function mutatingRevision(task: string): string {
  const start = task.indexOf(CURRENT_MARKER);
  if (start === -1) return "\\subsection{修订}\n本方法 S 指标为 0.9。";
  const rest = task.slice(start + CURRENT_MARKER.length);
  const end = rest.indexOf("\n=====");
  const current = end === -1 ? rest : rest.slice(0, end);
  return current.replace(/0\.724/g, "0.9");
}

describe("M14.3 thesis 修订事实守卫 E2E", () => {
  let stack: TestStack;
  let scripted: ReturnType<typeof createScriptedRuntime>;
  let revisionMutations = 0;

  beforeAll(async () => {
    scripted = createScriptedRuntime({
      reviewSequence: ["pass"],
      everyRoundFactIssue: {
        severity: "major",
        category: "fact",
        section: "sections/method-design.tex",
        description: "数值口径建议：将 S 指标 0.724 更新为 0.9（作者复核后的新值）",
        suggestion: "将正文与表格中的 0.724 全部改为 0.9",
      },
    });
    // 包装：thesis 方法章写作输出携带已确认值 0.724；修订输出将其改值
    const base = scripted.runtime;
    const wrapped: AgentRuntime = {
      ...base,
      runAgent: async (input: RunAgentInput): Promise<AgentTask> => {
        if (input.contextScope === "writing/sections" && input.task.includes("【学位论文章节】") && input.task.includes("0.724")) {
          const titleMatch = /本节「([^」]+)」/.exec(input.task);
          const title = titleMatch?.[1] ?? "方法设计";
          // 只在方法总体设计节写入数值（章级聚合比对下，同章他节的正确副本会
          // 掩盖单节篡改——本测试构造「该值仅出现一次」的漂移场景）
          const withValue = title === "方法总体设计";
          return {
            taskId: `scripted-thesis-${Math.random().toString(36).slice(2, 8)}`,
            status: "completed",
            output: `\\subsection{${title}}\n\n${withValue ? "本方法在 DUTS 数据集上的 S 指标为 0.724，相比基线方法有明显提升。" : "本节阐述方法的设计考量与有效性来源。"}下面给出方法设计与分析。\n`,
          } as AgentTask;
        }
        if (input.contextScope === "writing/revision" || input.contextScope === "writing/revision-proposal") {
          revisionMutations += 1;
          return {
            taskId: `scripted-revision-${Math.random().toString(36).slice(2, 8)}`,
            status: "completed",
            output: mutatingRevision(input.task),
          } as AgentTask;
        }
        return base.runAgent(input);
      },
    };
    stack = await startTestStack(wrapped, {
      search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"], providerTimeoutMs: 2_000 },
    });
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it("review 建议改数值 → 修订候选改值 → drift gate 拒绝（未授权事实变更）", { timeout: 240_000 }, async () => {
    const created = await stack.request("POST", "/api/projects", { title: "修订守卫学位论文", language: "zh", documentType: "master_thesis" });
    expect(created.status).toBe(201);
    const projectId = (created.body["project"] as { id: string })["id"];

    // 研究材料（服务级种子：无后台解析竞态）
    const pdfText =
      "我们提出显著性检测方法 LSM。该方法在 DUTS 数据集上的 S 指标达到 0.724，超过基线的 0.667。消融实验见表1。";
    const { source } = await stack.stack.sources.add(projectId, {
      fileName: "guard-paper.pdf",
      content: Buffer.from(`%PDF-1.5\n${pdfText}`, "utf8"),
    });
    const sourceId = source.sourceId;
    const document = {
      schemaVersion: 1 as const,
      sourceId,
      fileName: "guard-paper.pdf",
      storedFileName: "guard-paper.pdf",
      kind: "pdf" as const,
      mimeType: "application/pdf",
      parser: { id: "test-fixture", version: "1" },
      parseMode: "structured" as const,
      status: "ok" as const,
      pageCount: 2,
      blocks: [
        {
          blockId: "B0001",
          type: "text" as never,
          text: pdfText,
          provenance: { page: 1 },
        },
        {
          blockId: "B0002",
          type: "table" as never,
          headers: ["Method", "S ↑"],
          rows: [["Ours", "0.724"], ["Base", "0.667"]],
          rowCount: 2,
          columnCount: 2,
          caption: "表1 消融结果",
          provenance: { page: 2 },
        },
      ],
      counts: { text: 1, table: 1 } as never,
      notes: [],
      contentHash: source.contentHash!,
      parsedAt: new Date().toISOString(),
    };
    await stack.stack.parsedDocuments.save(projectId, document as never);
    // 种子文本层缓存（独立字符通道核验用；覆盖表事实页 + 正文页的全部 surface）
    const textLayerDir = join(stack.store.projectDir(projectId), "research", "text-layers");
    await (await import("node:fs/promises")).mkdir(textLayerDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(textLayerDir, `${sourceId}-${source.contentHash!.slice(0, 12)}.json`),
      JSON.stringify({
        sourceId,
        contentHash: source.contentHash,
        parser: { id: "seed" },
        pages: [
          { page: 1, text: pdfText },
          { page: 2, text: "Method S ↑ Ours 0.724 Base 0.667 表1 消融结果" },
        ],
      }),
      "utf8",
    );
    const registered = await stack.request("POST", `/api/projects/${projectId}/research-inputs`, {
      sourceId,
      inputType: "published_paper",
      title: "LSM 显著性方法",
      provenanceUri: "https://example.org/lsm",
    });
    expect(registered.status).toBeLessThan(300);
    const inputId = (registered.body["input"] as { inputId: string })["inputId"];
    await stack.stack.researchInputs.registry.refreshParse(projectId, inputId);

    // 事实抽取 + 核验 + 确认（0.724 进入 authorConfirmed）
    await stack.stack.researchInputs.extractFacts(projectId, inputId);
    await stack.stack.researchInputs.verifyFacts(projectId, inputId);
    const factsResponse = await stack.request("GET", `/api/projects/${projectId}/research-inputs/facts?inputId=${inputId}`);
    const facts = (factsResponse.body["facts"] as Array<{ factId: string; verification?: { sourceCheck?: string } }>) ?? [];
    const verified = facts.filter((fact) => fact.verification?.["sourceCheck"] === "verified").map((fact) => fact.factId);
    expect(verified.length).toBeGreaterThan(0);
    const confirm = await stack.request("POST", `/api/projects/${projectId}/research-inputs/decisions`, {
      actor: { kind: "test_fixture" },
      payload: { type: "fact_confirmation", factIds: verified, outcome: "confirmed" },
    });
    expect(confirm.status).toBeLessThan(300);

    // 启动工作流
    const start = await stack.request("POST", `/api/projects/${projectId}/workflows`, { kind: "thesis_from_papers" });
    expect(start.status).toBe(202);
    const runId = start.body["runId"] as string;

    // 驱动：include → 确认贡献 → approve → 大纲 approve → 溢出时 accept_draft
    const deadline = Date.now() + 200_000;
    let terminal = "";
    for (;;) {
      const run = ((await stack.request("GET", `/api/runs/${runId}`)).body["run"] ?? {}) as {
        status: string;
        awaiting?: { stageId: string; payload?: Record<string, unknown> };
      };
      if (run.status === "awaiting_input" && run.awaiting !== undefined) {
        const { stageId, payload } = run.awaiting;
        let decision = "approve";
        let body: Record<string, unknown> = { actorKind: "test_fixture" };
        if (stageId === "hitl.scope_and_version") {
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
          }
        } else if (stageId === "hitl.revision_overflow" || stageId === "hitl.revision_stalled") {
          decision = "accept_draft";
        } else if (stageId === "hitl.author_decision") {
          const missing = (payload?.["missingChapters"] as Array<{ chapterId: string }> | undefined) ?? [];
          decision = missing.length > 0 ? "write_as_limitation" : "approve";
          body = { ...(missing.length > 0 ? { subject: missing[0]!.chapterId } : {}), actorKind: "test_fixture" };
        } else if (stageId === "hitl.style_polish") {
          decision = "skip";
        }
        const resume = await stack.request("POST", `/api/runs/${runId}/resume`, { decision, payload: body });
        if (resume.status >= 300) {
          throw new Error(`resume 失败（${stageId}/${decision}）：${JSON.stringify(resume.body).slice(0, 300)}`);
        }
        continue;
      }
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        terminal = run.status;
        break;
      }
      if (Date.now() > deadline) throw new Error(`守卫 E2E 超时（${run.status}）`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // 核心断言 1：修订确实发生（Writer 输出过改值候选）
    expect(revisionMutations).toBeGreaterThan(0);

    // 核心断言 2：gate 产物存在 published_facts_zero_drift FAIL（0.724 被改 → 拒绝）
    const projectDir = stack.store.projectDir(projectId);
    const reviewsDir = join(projectDir, "reviews");
    const { readdir } = await import("node:fs/promises");
    const gateFiles = (await readdir(reviewsDir)).filter((name) => /^quality-gate-r\d+\.json$/.test(name)).sort();
    const latestGate = gateFiles[gateFiles.length - 1]!;
    const gateRaw = await readFile(join(reviewsDir, latestGate), "utf8");
    const gate = JSON.parse(gateRaw) as {
      gate: { passed: boolean; rules: Array<{ rule: string; passed: boolean; detail: string }> };
    };
    const driftRule = gate.gate.rules.find((rule) => rule.rule === "published_facts_zero_drift");
    expect(driftRule).toBeDefined();
    expect(driftRule!.passed).toBe(false);
    expect(driftRule!.detail).toContain("0.9");
    // 核心断言 3：未授权变更不许以 Draft 冒充成功——若 run 终态非 completed，
    // 其失败必须源于守卫链（accept_draft 后 Draft 的事实保持硬阻断同样合法）
    if (terminal !== "completed") {
      const finalRun = ((await stack.request("GET", `/api/runs/${runId}`)).body["run"] ?? {}) as {
        error?: { message?: string };
      };
      expect(finalRun.error?.message ?? "").toMatch(/事实|drift|fact|Draft/i);
    }
  });
});
