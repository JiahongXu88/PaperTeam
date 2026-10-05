import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcceptanceEvaluationReader, HeldOutAccessError, readEvaluationPath, type EvaluationSetManifest } from "../../src/evaluation/heldOutAccess.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-heldout-")); roots.push(root);
  await mkdir(join(root, "evaluation"), { recursive: true });
  await writeFile(join(root, "baseline.tex"), "generation text", "utf8");
  await writeFile(join(root, "evaluation", "author-response.md"), "held-out answer", "utf8");
  await writeFile(join(root, "revision_change_log.md"), "held-out change log", "utf8");
  await writeFile(join(root, "final.pdf"), "held-out PDF", "utf8");
  return root;
}

describe("held-out EvaluationSet read boundary", () => {
  const manifest: EvaluationSetManifest = { generationPaths: ["baseline.tex"], heldOutPaths: ["evaluation/author-response.md"] };
  it("blocks direct reads before Candidate Freeze without returning contents", async () => {
    const root = await fixture();
    await expect(readEvaluationPath(root, "evaluation/author-response.md", manifest)).rejects.toBeInstanceOf(HeldOutAccessError);
    await expect(readEvaluationPath(root, "baseline.tex", manifest)).resolves.toBe("generation text");
  });
  it("allows held-out evaluation reads after Candidate Freeze", async () => {
    const root = await fixture();
    await expect(readEvaluationPath(root, "evaluation/author-response.md", { ...manifest, candidateFrozenAt: "2026-10-05T00:00:00.000Z" })).resolves.toBe("held-out answer");
  });
  it("rejects traversal outside the project root", async () => {
    const root = await fixture();
    await expect(readEvaluationPath(root, "../secret.txt", { ...manifest, candidateFrozenAt: "frozen" })).rejects.toBeInstanceOf(HeldOutAccessError);
  });
  it("acceptance reader blocks held-out inputs before freeze and exposes only parsed reviewer blocks", async () => {
    const root = await fixture();
    await writeFile(join(root, "feedback.md"), [
      "## Reviewer 1", "Please clarify the reported metric direction.",
      "## Author response", "We changed it because we saw the final paper.",
      "## Reviewer 2", "Please add the missing citation.",
    ].join("\n"), "utf8");
    const reader = new AcceptanceEvaluationReader(root, {
      generationPaths: ["baseline.tex"],
      heldOutPaths: ["evaluation/author-response.md", "revision_change_log.md", "final.pdf"],
      reviewerCommentPaths: ["feedback.md"],
    });
    await expect(reader.read("evaluation/author-response.md")).rejects.toBeInstanceOf(HeldOutAccessError);
    await expect(reader.read("revision_change_log.md")).rejects.toBeInstanceOf(HeldOutAccessError);
    await expect(reader.read("final.pdf")).rejects.toBeInstanceOf(HeldOutAccessError);
    const comments = await reader.readReviewerComments("feedback.md");
    expect(comments).toEqual([
      { heading: "Reviewer 1", content: "Please clarify the reported metric direction." },
      { heading: "Reviewer 2", content: "Please add the missing citation." },
    ]);
    expect(JSON.stringify(comments)).not.toContain("We changed it");
    expect(() => reader.freezeCandidate({ candidateId: "candidate-1", publishable: false })).toThrow(HeldOutAccessError);
    expect(reader.isFrozen()).toBe(false);
    reader.freezeCandidate({ candidateId: "candidate-1", publishable: true, frozenAt: "frozen" });
    expect(reader.isFrozen()).toBe(true);
    await expect(reader.read("evaluation/author-response.md")).resolves.toBe("held-out answer");
  });
});
