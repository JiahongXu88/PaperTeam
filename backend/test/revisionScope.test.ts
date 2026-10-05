import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { inferExperimentProtocolScope, isEvidenceEligibleForProtocol } from "../src/evidence/protocolScope.js";
import type { EvidenceRecord } from "../src/evidence/EvidenceStore.js";
import { dispatchableRevisionItems, type RevisionPlanItem } from "../src/review/revisionPlan.js";
import {
  applyRevisionSpan,
  checkRevisionScope,
  checkGlobalRevisionScope,
  hasRevisionWorkspaceMutation,
  hasNewContentAfterDocumentEnd,
  locateLatexSections,
  revisionSpansOverlap,
  verifyNoopCoverage,
} from "../src/review/revisionScope.js";

const paper = String.raw`\documentclass{article}
\begin{document}
\section{Overview}
Keep this abstract-like content.
\subsection{Datasets}\label{subsec:datasets}
UA-DETRAC has a fixed camera viewpoint.
\subsection{Results}
Table values remain 0.76.
\end{document}
`;

function evidence(protocolId: string, status: "current" | "historical" | "superseded"): EvidenceRecord {
  return {
    id: protocolId,
    claim: "low light IDF1",
    verificationStatus: "verified",
    protocolScope: { protocolId, status },
    createdBy: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("existing-paper revision scope", () => {
  it("routes four NO-OP items around Writer and keeps the single modify item", () => {
    const item = (id: string, actionType: "noop" | "modify"): RevisionPlanItem => ({
      id, kind: "external_instruction", priority: "mandatory", section: "subsec:datasets",
      problem: "coverage", instruction: "coverage", expectedOutcome: "addressed", status: "planned", actionType,
    });
    const dispatch = dispatchableRevisionItems([
      item("noop-1", "noop"), item("noop-2", "noop"), item("noop-3", "noop"), item("noop-4", "noop"), item("modify-1", "modify"),
      { id: "untyped", kind: "external_instruction", priority: "mandatory", section: "subsec:datasets",
        problem: "coverage", instruction: "author decision required", expectedOutcome: "addressed", status: "planned" },
    ]);
    expect(dispatch.map((entry) => entry.id)).toEqual(["modify-1"]);
  });

  it("limits a dataset edit to its logical subsection and retains other content", () => {
    const baseline = paper.replaceAll("\\n", "\n");
    const target = locateLatexSections("main.tex", baseline).find((span) => span.label === "subsec:datasets");
    expect(target).toBeDefined();
    const candidate = applyRevisionSpan(baseline, target!, target!.content.replace("fixed camera viewpoint", "fixed surveillance viewpoint"));
    expect(checkRevisionScope(baseline, candidate, target!).allowed).toBe(true);
    expect(candidate.slice(0, target!.start)).toBe(baseline.slice(0, target!.start));
    expect(candidate).toContain("Table values remain 0.76.");
  });

  it("rejects a writer edit to the abstract when datasets is the allowed target", () => {
    const baseline = paper.replaceAll("\\n", "\n");
    const target = locateLatexSections("main.tex", baseline).find((span) => span.label === "subsec:datasets")!;
    const candidate = baseline.replace("Keep this abstract-like content", "Changed abstract");
    expect(checkRevisionScope(baseline, candidate, target)).toMatchObject({ allowed: false, reason: "REVISION_SCOPE_VIOLATION" });
  });

  it("global diff is anchored to immutable input even when a later baseline is contaminated", () => {
    const immutable = paper.replaceAll("\\n", "\n");
    const target = locateLatexSections("main.tex", immutable).find((span) => span.label === "subsec:datasets")!;
    const candidate = applyRevisionSpan(immutable, target, target.content.replace("fixed camera", "fixed surveillance"))
      .replace("Table values remain 0.76", "Table values remain 0.99");
    expect(checkGlobalRevisionScope(immutable, candidate, [target])).toMatchObject({ allowed: false, reason: "REVISION_SCOPE_VIOLATION" });
  });

  it("accepts a clean scoped candidate and rejects a stale baseline", () => {
    const immutable = paper.replaceAll("\\n", "\n");
    const target = locateLatexSections("main.tex", immutable).find((span) => span.label === "subsec:datasets")!;
    const candidate = applyRevisionSpan(immutable, target, target.content.replace("fixed camera", "fixed surveillance"));
    expect(checkGlobalRevisionScope(immutable, candidate, [target]).allowed).toBe(true);
    expect(checkGlobalRevisionScope(immutable.replace("Overview", "Changed"), candidate, [target])).toMatchObject({ allowed: false });
  });

  it("detects direct workspace mutation by full-file snapshot hash", () => {
    const immutable = paper.replaceAll("\\n", "\n");
    const hash = createHash("sha256").update(immutable).digest("hex");
    expect(hasRevisionWorkspaceMutation(hash, immutable.replace("fixed camera", "changed camera"))).toBe(true);
    expect(hasRevisionWorkspaceMutation(hash, immutable)).toBe(false);
  });

  it("allows two deterministic non-overlapping scoped patches in one whole-file candidate", () => {
    const immutable = paper.replaceAll("\\n", "\n");
    const spans = locateLatexSections("main.tex", immutable);
    const datasets = spans.find((span) => span.label === "subsec:datasets")!;
    const results = spans.find((span) => span.heading === "Results")!;
    let candidate = applyRevisionSpan(immutable, results, results.content.replace("0.76", "0.77"));
    candidate = applyRevisionSpan(candidate, { ...datasets, originalHash: createHash("sha256").update(candidate.slice(datasets.start, datasets.end)).digest("hex"), content: candidate.slice(datasets.start, datasets.end) }, candidate.slice(datasets.start, datasets.end).replace("fixed camera", "fixed surveillance"));
    expect(checkGlobalRevisionScope(immutable, candidate, [datasets, results]).allowed).toBe(true);
  });

  it("allows scope validation to pass a scoped numeric change for Fact Guard to judge separately", () => {
    const baseline = paper.replaceAll("\\n", "\n");
    const target = locateLatexSections("main.tex", baseline).find((span) => span.heading === "Results")!;
    const candidate = applyRevisionSpan(baseline, target, target.content.replace("0.76", "0.99"));
    expect(checkRevisionScope(baseline, candidate, target).allowed).toBe(true);
    expect(candidate).toContain("0.99");
  });

  it("rejects content appended after end document when no authorized span includes it", () => {
    const baseline = paper.replaceAll("\\n", "\n");
    const target = locateLatexSections("main.tex", baseline).find((span) => span.label === "subsec:datasets")!;
    const candidate = `${baseline}\\n% internal writer note`;
    expect(checkRevisionScope(baseline, candidate, target).allowed).toBe(false);
    expect(hasNewContentAfterDocumentEnd(baseline, candidate)).toBe(true);
  });

  it("detects overlapping patch spans", () => {
    const spans = locateLatexSections("main.tex", paper.replaceAll("\\n", "\n"));
    expect(revisionSpansOverlap(spans[1]!, { ...spans[1]!, start: spans[1]!.start + 1 })).toBe(true);
  });

  it("accepts current protocol evidence and rejects old COCO protocol for current support", () => {
    expect(inferExperimentProtocolScope("S002-old_coco_pretrained_detector-report.md")).toEqual({
      protocolId: "old_coco_pretrained_detector", status: "superseded",
    });
    expect(inferExperimentProtocolScope("S011-fair_ablation_new_detector.md")).toEqual({
      protocolId: "fair_ablation_new_detector", status: "current",
    });
    expect(isEvidenceEligibleForProtocol(evidence("fair_ablation_new_detector", "current"), { protocolId: "fair_ablation_new_detector" })).toBe(true);
    expect(isEvidenceEligibleForProtocol(evidence("old_coco_pretrained_detector", "superseded"), { protocolId: "fair_ablation_new_detector" })).toBe(false);
  });

  it("verifies baseline RDK X3 coverage only with an exact quote and verified evidence", () => {
    const source = String.raw`\section{Edge Deployment}
The RDK X3 full pipeline takes 1495.6306 ms at 0.669 FPS.
`;
    const normalized = source.replaceAll("\\n", "\n");
    const span = locateLatexSections("main.tex", normalized)[0]!;
    const record = evidence("rdk_x3_deployment", "current");
    const result = verifyNoopCoverage({
      logicalSection: span.logicalSection,
      coverageQuote: "1495.6306 ms at 0.669 FPS",
      evidenceIds: [record.id],
    }, [span], new Map([[record.id, record]]));
    expect(result.verified).toBe(true);
    expect(verifyNoopCoverage({ logicalSection: span.logicalSection, coverageQuote: "already covered", evidenceIds: [record.id] }, [span], new Map([[record.id, record]])).verified).toBe(false);
  });
});
