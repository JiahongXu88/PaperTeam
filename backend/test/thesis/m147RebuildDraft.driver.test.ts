/**
 * M14.7 Rebuild Driver — 案例 B 真实 run 构建失败的定向复验（确定性，零模型调用）。
 *
 * 背景：M14.7 案例 B 真实 E2E run（p-6d475f160929，33 次调用用满 → overflow → accept_draft）
 * 的 build.draft 因模板缺 `bm` 宏包（Writer 写出 `\bm{f}_d`）编译失败，无 Draft 产物。
 * 修复（genericCtexbook preamble + Draft 路径有界修复）落盘后，本驱动用**产品同款构建路径**
 * （ThesisDocumentService.assemble → runBuildGateForRevision → PaperArtifactStore.ensureDraft）
 * 对该 run 的最终修订 rev-3 重建 Draft——这是任务允许的「修复后定向真实复验（≤1 次）」，
 * 不冒充新的端到端运行：run 级账本已耗尽，重建全程零模型调用（runtime 任何调用即失败）。
 *
 * 产物诚实标记：artifact.sourceRunId = "m147-rebuild"（非原 run id）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentRuntime } from "../../src/runtime/types.js";
import { runBuildGateForRevision } from "../../src/quality/gates.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import {
  compareAbstractSnapshot,
  computeAuthorDecisionFingerprint,
  computeConfirmedFactFingerprint,
  computeManuscriptSectionsFingerprint,
  type AbstractSnapshotBinding,
} from "../../src/thesis/abstractSnapshot.js";

const live = process.env["PAPERTEAM_M147_REBUILD"] === "1";

describe.skipIf(!live)("M14.7 Rebuild — 案例 B rev-3 确定性重建 Draft（零模型）", () => {
  it("assemble → build gate → ensureDraft", { timeout: 600_000 }, async () => {
    const projectDir = process.env["PAPERTEAM_M147_PROJECT"] ?? "D:\\PaperTeamData\\M14_7\\projects-caseB\\p-6d475f160929";
    const projectsRoot = join(projectDir, "..");

    // 零模型断言：任何 runAgent 调用直接失败
    const noModel = {
      runAgent: async (): Promise<never> => {
        throw new Error("M14.7 rebuild: unexpected model call");
      },
      startAgent: async (): Promise<never> => {
        throw new Error("M14.7 rebuild: unexpected model call");
      },
    } as unknown as AgentRuntime;

    const stack: TestStack = await startTestStack(noModel, {
      realLatex: true,
      root: projectsRoot,
      stageBudget: { timeoutMs: 600_000, maxAttempts: 1 },
    });
    try {
      const services = stack.stack.workflowServices;
      const projectId = projectDir.split(/[\\/]/).pop()!;
      // 原 run 的 build.draft 已执行 maybeRestoreBestRevision 且未恢复（无 restoredBestFrom）；
      // 重建直接对当前修订（rev-3）执行，与原 run 的终局决策一致。
      const outline = await services.manuscript.loadOutline(projectId);
      expect(outline).not.toBeNull();
      const assembly = await services.thesis.documents.assemble(projectId, outline!);
      expect(assembly.mainTex).toContain("ctexbook");

      const revision = await services.revisions.currentRevision(projectId);
      const { build, compile, record } = await runBuildGateForRevision(
        services.projects,
        services.thesis.latex,
        projectId,
        revision,
        { manuscriptDir: services.thesis.documents.thesisManuscriptDir(projectId) },
      );
      console.log(
        `[m147-rebuild] revision=${revision} build.passed=${build.passed} reasons=${JSON.stringify(build.reasons)} tool=${compile.tool} ${compile.durationMs}ms`,
      );
      console.log(
        `[m147-rebuild] assembly chapterReferences: rewrites=${assembly.chapterReferences.rewrites.length} issues=${assembly.chapterReferences.issues.length}`,
      );
      expect(build.passed, JSON.stringify(build.reasons)).toBe(true);

      const draft = await services.artifacts.ensureDraft(projectId, revision, record, "m147-rebuild");
      expect(draft.artifactId).toBe(`art-draft-rev${revision}`);
      const pdf = await readFile(join(projectDir, "artifacts", draft.file.name));
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

      // 摘要快照绑定 vs rev-3 正文（本 run 修订后预算耗尽未刷新摘要 → 预期 stale，如实记录）
      const artifact = JSON.parse(await readFile(join(projectDir, "research", "thesis-abstract.json"), "utf8")) as {
        snapshot?: AbstractSnapshotBinding;
      };
      const mapping = JSON.parse(await readFile(join(projectDir, "research", "chapter-mapping.json"), "utf8")) as {
        chapters: Array<{ sectionFiles: string[] }>;
      };
      const context = await services.thesis.researchInputs.plannerContext(projectId);
      const decisions = await services.thesis.researchInputs.decisions.list(projectId);
      const freshness = compareAbstractSnapshot(artifact.snapshot, {
        revision,
        manuscriptFingerprint: await computeManuscriptSectionsFingerprint(
          services.projects,
          projectId,
          mapping.chapters.flatMap((chapter) => chapter.sectionFiles),
        ),
        confirmedFactFingerprint: computeConfirmedFactFingerprint(context.facts.authorConfirmed),
        authorDecisionFingerprint: computeAuthorDecisionFingerprint(decisions),
      });
      console.log(`[m147-rebuild] abstract snapshot current=${freshness.current} detail=${freshness.detail}`);

      console.log(
        `[m147-rebuild] DONE artifact=${draft.artifactId} bytes=${pdf.length} abstractCurrent=${freshness.current}`,
      );
    } finally {
      await stack.cleanup().catch(() => undefined);
    }
  });
});
