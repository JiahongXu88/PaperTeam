import { describe, expect, it } from "vitest";

import { buildFeasibilityPrompt } from "../../src/agents/FeasibilityService.js";
import type { ResearchReport } from "../../src/agents/ResearcherService.js";
import type { EvidenceStats } from "../../src/evidence/EvidenceStore.js";
import type { ProjectMetadata } from "../../src/project/ProjectStore.js";

const project = {
  title: "Synthetic assessment target",
  documentType: "paper",
  targetProfile: "journal",
  targetVenue: "Synthetic Venue",
  researchIdea: "Assess the existing paper against its stated target.",
} as ProjectMetadata;

const research = {
  domainOverview: "A bounded digest of the existing paper.",
  researchGaps: ["Missing quantitative comparison"],
  potentialContributions: ["A scoped method contribution"],
} as ResearchReport;

const evidenceStats = {
  total: 2300,
  byStatus: { verified: 40, unverified: 2_260 },
  contradictory: 0,
  skippedLines: 0,
} as EvidenceStats;

describe("assessment.target prompt context boundary", () => {
  it("uses target metadata, bounded research summary, and evidence counts only", () => {
    const prompt = buildFeasibilityPrompt(project, research, evidenceStats, "existing_paper");

    expect(prompt).toContain("Synthetic Venue");
    expect(prompt).toContain("Missing quantitative comparison");
    expect(prompt).toContain("Evidence 总数：2300");
    expect(prompt).not.toContain("paper.tex");
    expect(prompt).not.toContain("reviewer comments");
    expect(prompt).not.toContain("S001");
    expect(prompt.length).toBeLessThan(8_000);
  });
});
