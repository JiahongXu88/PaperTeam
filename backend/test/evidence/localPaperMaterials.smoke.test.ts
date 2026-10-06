import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scriptedIdeaRuntime, startTestStack } from "../helpers/testStack.js";
import { verifyQuoteInChunk } from "../../src/evidence/quoteVerification.js";
import { plannerEligibleEvidence } from "../../src/review/plannerAliases.js";

const ROOT = "D:/PaperTeamData/M10.3-real-paper-case/experiments/reports/submission_basis";
const REPORTS = [
  ["rdk_x3_full_pipeline_report.md", "RDK X3 full pipeline experiment report", "RDK X3 full pipeline deployment latency and FPS"],
  ["fair_ablation_new_detector.md", "Fair ablation new detector report", "current fair ablation with new detector protocol results"],
  ["extreme_scene_experiment_report.md", "Extreme scene historical COCO report", "historical extreme scene COCO pretrained detector protocol"],
] as const;
const available = REPORTS.every(([name]) => existsSync(`${ROOT}/${name}`));
const cleanups: Array<() => Promise<void>> = [];

describe("real local Existing Paper source grounding smoke", () => {
  it.skipIf(!available)("RDK X3/current fair-ablation/historical COCO reports → proposal → verification → protocol-filtered eligibility", async () => {
    const stack = await startTestStack(scriptedIdeaRuntime().runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    try {
      const project = await stack.store.create("M11.4.6 local grounding smoke", { researchIdea: "Existing Paper evidence supply" });
      const sources: { source: Awaited<ReturnType<typeof stack.stack.sources.add>>; content: Buffer }[] = [];
      for (const [name, title] of REPORTS) {
        const content = await readFile(`${ROOT}/${name}`);
        const source = await stack.stack.sources.add(project.id, { fileName: name, content, metadata: { title } });
        sources.push({ source, content });
      }
      await stack.stack.retrieval.rebuild(project.id);
      const result = await stack.stack.targetedGrounding.groundClaims(project.id, REPORTS.map(([, , claim], index) => ({
        claimId: `C${index + 1}`, claim, section: "experiments", sourceIds: [sources[index]!.source.source.sourceId],
      })));
      const chunksRetrieved = result.outcomes.reduce((sum, outcome) => sum + outcome.attempts.length, 0);
      const proposals = result.outcomes.reduce((sum, outcome) => sum + outcome.attempts.filter((attempt) => attempt.outcome !== "skipped").length, 0);
      expect(result.verifiedEvidence).toBe(3);
      expect(chunksRetrieved).toBe(3);
      expect(proposals).toBe(3);
      const records = await stack.stack.evidence.list(project.id);
      const verified = records.filter((record) => record.verificationStatus === "verified");
      expect(verified).toHaveLength(3);
      expect(result.outcomes.every((outcome) => outcome.status === "verified")).toBe(true);
      const bySource = new Map(verified.map((record) => [record.source?.sourceId, record]));
      for (const entry of sources) {
        const record = bySource.get(entry.source.source.sourceId);
        expect(record?.location?.chunk).toMatch(new RegExp(`^${entry.source.source.sourceId}:`));
        const chunk = await stack.stack.chunkAccess.resolve(project.id, record!.location!.chunk!);
        expect(verifyQuoteInChunk(record?.quote ?? "", chunk.chunk.text).ok).toBe(true);
      }
      expect(bySource.get(sources[1]!.source.source.sourceId)?.protocolScope).toEqual({ protocolId: "fair_ablation_new_detector", status: "current" });
      expect(bySource.get(sources[2]!.source.source.sourceId)?.protocolScope).toEqual({ protocolId: "old_coco_pretrained_detector", status: "superseded" });
      const eligible = plannerEligibleEvidence(records);
      expect(eligible.map((record) => record.source?.sourceId)).toContain(sources[1]!.source.source.sourceId);
      expect(eligible.map((record) => record.source?.sourceId)).not.toContain(sources[2]!.source.source.sourceId);
      expect(eligible).toHaveLength(2);
      expect(verified.filter((record) => record.protocolScope?.status === "superseded")).toHaveLength(1);
    } finally {
      await stack.cleanup();
    }
  });
});
