import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { pollRunUntilAwaiting, scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";
import type { AgentRuntime, RunAgentInput } from "../../src/runtime/types.js";
import type { WorkflowState } from "../../src/workflow/types.js";

vi.setConfig({ testTimeout: 60_000 });

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

function zip(entries: Array<{ name: string; data: string }>): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const data = Buffer.from(entry.data); const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(20, 4); item.writeUInt16LE(20, 6); item.writeUInt16LE(8, 10); item.writeUInt32LE(compressed.length, 20); item.writeUInt32LE(data.length, 24); item.writeUInt16LE(name.length, 28); item.writeUInt32LE(offset, 42); central.push(item, name); offset += header.length + name.length + compressed.length;
  }
  const dir = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, dir, end]);
}

const main = String.raw`\documentclass{article}
\begin{document}
\begin{abstract}Abstract baseline.\end{abstract}
\section{Introduction}
Intro baseline.
\section{Method}
Method baseline.
\section{Conclusion}
Conclusion baseline.
\end{document}`;

async function until(stack: TestStack, runId: string, statuses: string[]): Promise<WorkflowState> {
  for (let i = 0; i < 3000; i++) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`); const run = body.run as WorkflowState;
    if (statuses.includes(run.status)) return run;
    if (run.status === "awaiting_input") {
      const stage = run.awaiting?.stageId ?? "";
      const decision = stage === "hitl.revision_stalled" || stage === "hitl.revision_overflow" ? "accept_draft"
        : stage === "hitl.evidence_supply" ? "continue" : "approve";
      await stack.request("POST", `/api/runs/${runId}/resume`, { decision }); continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run poll timeout");
}

describe("Existing Paper scoped revision structure guard", () => {
  it("rejects a proposal that drops its own section heading; manuscript stays structurally intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-structure-guard-"));
    const scripted = scriptedIdeaRuntime();
    let damagedProposals = 0;
    const runtime: AgentRuntime = {
      ...scripted.runtime,
      async runAgent(input: RunAgentInput) {
        const result = await scripted.runtime.runAgent(input);
        if (input.contextScope === "writing/revision-proposal" && input.task.includes("Method") && result.output) {
          damagedProposals += 1;
          // Simulate the M11.4 Attempt 7 failure shape: the scoped proposal
          // rewrites the span but drops its own \section command, so the
          // candidate would silently lose a resolvable heading.
          result.output = "Revised method narrative without its section heading.";
        }
        return result;
      },
    };
    const stack = await startTestStack(runtime, { root, registerCleanup: (fn) => cleanups.push(fn) });
    const project = await stack.store.create("synthetic structure guard");
    const archive = zip([{ name: "main.tex", data: main }, { name: "references.bib", data: "" }]);
    expect((await stack.request("POST", `/api/projects/${project.id}/import`, { archiveBase64: archive.toString("base64") })).status).toBe(200);
    expect((await stack.request("POST", `/api/projects/${project.id}/external-instructions`, { source: "advisor", text: "Clarify the method narrative.", section: "Method" })).status).toBe(200);
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { kind: "existing_paper_improvement" });
    const runId = created.body.runId as string;
    const waiting = await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm", { timeoutMs: 60_000 });
    expect(waiting.awaiting?.stageId).toBe("hitl.plan_confirm");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    const terminal = await until(stack, runId, ["failed", "completed"]);
    // The run must not die with "Revision target no longer resolves" or any fatal
    // contract error: the damaged candidate is rejected fail-closed instead.
    expect(terminal.error?.message ?? "").not.toContain("no longer resolves");
    expect(damagedProposals).toBeGreaterThan(0);

    const after = await readFile(join(root, project.id, "manuscript", "main.tex"), "utf8");
    // 标题文本可以被后续轮次合法改写；结构不变式 = 章节数量保持（3 个 section）
    const headingCount = (after.match(/^\\section\{/gm) ?? []).length;
    expect(headingCount).toBe(3);

    // 结构拒绝记录落盘在当轮 stage 执行写入的 patch-validation 文件里（后续轮
    // 次会以自己的 records 覆盖同名文件）——扫描全部 patch-validation 文件。
    const reviewsDir = join(root, project.id, "reviews");
    const files = (await readdir(reviewsDir)).filter((name) => name.startsWith("patch-validation-"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    let damageRecord: { overall: string; apply: { status: string } } | undefined;
    for (const name of files) {
      const artifact = JSON.parse(await readFile(join(reviewsDir, name), "utf8")) as {
        records: Array<{ scope: { violations: string[] }; overall: string; apply: { status: string } }>;
        attemptHistory?: Array<{ scope: { violations: string[] }; overall: string; apply: { status: string } }>;
      };
      damageRecord ??= [...artifact.records, ...(artifact.attemptHistory ?? [])]
        .find((record) => record.scope.violations.join("\n").includes("REVISION_STRUCTURE_DAMAGE"));
    }
    expect(damageRecord, `files=${files.join(",")}`).toBeDefined();
    expect(damageRecord?.overall).toBe("fail");
    expect(damageRecord?.apply.status).toBe("rejected");
  });
});
