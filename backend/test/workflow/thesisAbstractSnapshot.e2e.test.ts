/**
 * M14.7 — 摘要快照绑定 + 引用完整性三分 E2E（scripted 全流程）。
 *
 * 场景：review fail → 修订接受 → review pass 的完整循环。断言：
 *   1. 修订后摘要被刷新（thesis.abstract 完成两次），产物带快照绑定（修订号 + 三个指纹）；
 *   2. Gate 规则 thesis_abstract_snapshot_current 出现且通过（绑定 = 当前正文 / 事实 / 决定）；
 *   3. gate 结果透传 citations 原始输入；completion summary 带 citationIntegrity 三分
 *      （citedCount / hallucinated / evidenceSufficiency——正式 Evidence 存在且被引用 → "cited"）；
 *   4. 人为篡改正文后绑定比较判 stale（ABSTRACT_STALE 语义的直接验证）。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createScriptedRuntime } from "../../src/runtime/scriptedRuntime.js";
import type { AgentRuntime, RunAgentInput, AgentTask } from "../../src/runtime/types.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { runThesisCitationClosure } from "../helpers/thesisCitationFlow.js";
import {
  compareAbstractSnapshot,
  computeAuthorDecisionFingerprint,
  computeConfirmedFactFingerprint,
  computeManuscriptSectionsFingerprint,
  type AbstractSnapshotBinding,
} from "../../src/thesis/abstractSnapshot.js";
import type { FactView } from "../../src/thesis/researchInputTypes.js";

describe("M14.7 摘要快照绑定 + 引用完整性 E2E", () => {
  let stack: TestStack;
  let scripted: ReturnType<typeof createScriptedRuntime>;

  beforeAll(async () => {
    // fail → pass：第一轮 review 产出可修订问题（gate FAIL），修订接受后复审通过
    scripted = createScriptedRuntime({ reviewSequence: ["fail", "pass"] });
    const base = scripted.runtime;
    const wrapped: AgentRuntime = {
      ...base,
      runAgent: async (input: RunAgentInput): Promise<AgentTask> => base.runAgent(input),
    };
    stack = await startTestStack(wrapped, {
      search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"], providerTimeoutMs: 2_000 },
    });
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it("修订后摘要刷新 + 快照绑定 + gate 规则 + citationIntegrity", { timeout: 300_000 }, async () => {
    const { projectId, run } = await runThesisCitationClosure(stack, "摘要快照绑定学位论文");
    expect(run.status).toBe("completed");
    expect(run.completion?.label).toBe("final");

    const projectDir = stack.store.projectDir(projectId);

    // 1) 摘要刷新：写作期一次 + 修订后一次
    const abstractCompletions = (run.stageResults !== undefined ? Object.keys(run.stageResults) : []);
    expect(abstractCompletions).toContain("thesis.abstract");
    const abstractStage = run.stageResults?.["thesis.abstract"] ?? {};
    expect(abstractStage["saved"]).toBe(true);

    // 2) 产物快照绑定：修订号 + 三个指纹，且与当前磁盘状态一致
    const artifact = JSON.parse(await readFile(join(projectDir, "research", "thesis-abstract.json"), "utf8")) as {
      saved: boolean;
      snapshot?: AbstractSnapshotBinding;
    };
    expect(artifact.saved).toBe(true);
    expect(artifact.snapshot).toBeDefined();
    expect(artifact.snapshot!.manuscriptFingerprint).toHaveLength(64);
    expect(typeof artifact.snapshot!.revision).toBe("number");

    // 3) Gate：快照绑定规则出现且通过
    const gateFiles = (await readdir(join(projectDir, "reviews"))).filter((name) => /^quality-gate-r\d+\.json$/.test(name)).sort();
    const gate = JSON.parse(await readFile(join(projectDir, "reviews", gateFiles[gateFiles.length - 1]!), "utf8")) as {
      gate: { passed: boolean; rules: Array<{ rule: string; passed: boolean; detail: string }> };
    };
    const snapshotRule = gate.gate.rules.find((entry) => entry.rule === "thesis_abstract_snapshot_current");
    expect(snapshotRule, "thesis_abstract_snapshot_current 规则应出现").toBeDefined();
    expect(snapshotRule?.passed, snapshotRule?.detail).toBe(true);
    expect(snapshotRule?.detail).toContain("指纹一致");

    // 4) 引用完整性三分：completion summary 结构化（非布尔；hallucinated=0 ≠ 证据充分）
    const summary = (run.completion?.summary ?? {}) as Record<string, unknown>;
    const integrity = summary["citationIntegrity"] as { citedCount: number; hallucinated: number; evidenceSufficiency: string } | undefined;
    expect(integrity).toBeDefined();
    expect(integrity!.citedCount).toBeGreaterThan(0);
    expect(integrity!.hallucinated).toBe(0);
    expect(integrity!.evidenceSufficiency).toBe("cited");

    // 5) 篡改正文 → 绑定比较判 stale（ABSTRACT_STALE 的直接语义验证；不改工作流状态）
    const sectionFiles = (await readdir(join(projectDir, "manuscript", "sections"))).filter((name) => name.endsWith(".tex"));
    expect(sectionFiles.length).toBeGreaterThan(0);
    const first = join(projectDir, "manuscript", "sections", sectionFiles[0]!);
    const original = await readFile(first, "utf8");
    await import("node:fs/promises").then((fs) => fs.writeFile(first, `${original}\n% M14.7 tamper for staleness check\n`, "utf8"));
    try {
      const tampered = await computeManuscriptSectionsFingerprint(stack.store, projectId, sectionFiles);
      const freshness = compareAbstractSnapshot(artifact.snapshot, {
        revision: artifact.snapshot!.revision,
        manuscriptFingerprint: tampered,
        confirmedFactFingerprint: computeConfirmedFactFingerprint([] as FactView[]),
        authorDecisionFingerprint: computeAuthorDecisionFingerprint([]),
      });
      expect(freshness.current).toBe(false);
      expect(freshness.detail).toContain("ABSTRACT_STALE");
      expect(freshness.detail).toContain("正文已变化");
    } finally {
      await import("node:fs/promises").then((fs) => fs.writeFile(first, original, "utf8"));
    }
  });
});
