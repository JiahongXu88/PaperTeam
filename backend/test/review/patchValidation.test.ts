import { describe, expect, it } from "vitest";
import { locateLatexSections } from "../../src/review/revisionScope.js";
import { attributeCitationChangesToPatches } from "../../src/review/patchValidation.js";
import { summarizePatchValidation, validationForComment, type PatchValidationRecord } from "../../src/review/patchValidation.js";

const before = String.raw`\begin{document}
\section{Introduction}
Intro text.
\section{Datasets}
Datasets text.
\end{document}`;

describe("patch citation attribution", () => {
  it("attributes same-file missing added citation only to its Introduction patch", () => {
    const spans = locateLatexSections("main.tex", before);
    const intro = spans.find((span) => span.heading === "Introduction")!;
    const datasets = spans.find((span) => span.heading === "Datasets")!;
    const after = before.replace("Intro text.", String.raw`Intro \cite{fake2026}.`);
    const result = attributeCitationChangesToPatches({
      before,
      after,
      patches: [
        { patchId: "A", planItemIds: ["a"], commentIds: ["ca"], span: intro },
        { patchId: "B", planItemIds: ["b"], commentIds: ["cb"], span: datasets },
      ],
      knownKeys: new Set(),
    });
    expect(result.findings).toEqual([expect.objectContaining({ key: "fake2026", patchId: "A", commentIds: ["ca"] })]);
    expect(result.unattributed).toEqual([]);
  });

  it("fails closed when a citation change is outside all authorized patch spans", () => {
    const spans = locateLatexSections("main.tex", before);
    const intro = spans.find((span) => span.heading === "Introduction")!;
    const after = before.replace("Datasets text.", String.raw`Datasets \cite{orphan2026}.`);
    const result = attributeCitationChangesToPatches({
      before,
      after,
      patches: [{ patchId: "A", planItemIds: ["a"], commentIds: ["ca"], span: intro }],
      knownKeys: new Set(),
    });
    expect(result.unattributed).toEqual([expect.objectContaining({ key: "orphan2026", code: "UNATTRIBUTED_CITATION_VIOLATION" })]);
  });

  it("marks overlapping section ownership as ambiguous and attributes removals", () => {
    const spans = locateLatexSections("main.tex", before);
    const intro = spans.find((span) => span.heading === "Introduction")!;
    const withCitation = before.replace("Intro text.", String.raw`Intro \cite{existing2024}.`);
    const removed = attributeCitationChangesToPatches({
      before: withCitation,
      after: before,
      patches: [{ patchId: "B", planItemIds: ["b1"], commentIds: ["cb"], span: intro }],
      knownKeys: new Set(["existing2024"]),
    });
    expect(removed.findings).toEqual([expect.objectContaining({ code: "REMOVED_CITATION_KEY", key: "existing2024", patchId: "B", commentIds: ["cb"] })]);
    const ambiguous = attributeCitationChangesToPatches({
      before,
      after: withCitation,
      patches: [
        { patchId: "A", planItemIds: ["a1"], commentIds: ["ca"], span: intro },
        { patchId: "B", planItemIds: ["b1"], commentIds: ["cb"], span: intro },
      ],
      knownKeys: new Set(),
    });
    expect(ambiguous.findings[0]).toMatchObject({ code: "AMBIGUOUS_PATCH_ATTRIBUTION", key: "existing2024" });
    expect(ambiguous.unattributed).toHaveLength(1);
  });

  it("maps valid added and removed citation occurrences to distinct patches by location", () => {
    const spans = locateLatexSections("main.tex", before);
    const intro = spans.find((span) => span.heading === "Introduction")!;
    const datasets = spans.find((span) => span.heading === "Datasets")!;
    const source = before.replace("Datasets text.", String.raw`Datasets cites \cite{old2023}.`);
    const after = source.replace("Intro text.", String.raw`Intro cites \cite{valid2024}.`).replace(String.raw`\cite{old2023}`, "");
    const result = attributeCitationChangesToPatches({
      before: source,
      after,
      patches: [
        { patchId: "A", planItemIds: ["a1"], commentIds: ["ca"], span: intro, addedKeys: ["valid2024"] },
        { patchId: "B", planItemIds: ["b1"], commentIds: ["cb"], span: datasets, removedKeys: ["old2023"] },
      ],
      knownKeys: new Set(["valid2024", "old2023"]),
    });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ADDED_CITATION_KEY", key: "valid2024", patchId: "A", planItemIds: ["a1"], commentIds: ["ca"] }),
      expect.objectContaining({ code: "REMOVED_CITATION_KEY", key: "old2023", patchId: "B", planItemIds: ["b1"], commentIds: ["cb"] }),
    ]));
    expect(result.unattributed).toEqual([]);
  });

  it("summarizes PASS and FAIL records without retaining manuscript text", () => {
    const record: PatchValidationRecord = {
      patchId: "p1", revisionId: "rev-2", file: "main.tex", logicalTarget: "subsection:Datasets",
      planItemIds: ["plan-1"], commentIds: ["comment-1"], evidenceIds: [], beforeFileHash: "a", beforeTargetHash: "b",
      proposedReplacementHash: "c", afterFileHash: "d", scope: { ok: true, violations: [] },
      workspaceIntegrity: { ok: true, directMutationDetected: false, recoveryAttempted: false, recoverySucceeded: true },
      fact: { ok: true, findingIds: [], violations: [] }, citation: { ok: true, findingIds: [], addedKeys: [], removedKeys: [], violations: [] },
      evidence: { ok: true, violations: [] }, apply: { ok: true, status: "applied" }, overall: "pass",
    };
    expect(summarizePatchValidation([record])).toMatchObject({ totalPatches: 1, passedPatches: 1, failedPatches: 0, publishable: true });
    const failed = { ...record, fact: { ok: false, findingIds: ["f1"], violations: ["numeric drift"] }, overall: "fail" as const };
    expect(summarizePatchValidation([failed], ["UNATTRIBUTED_FACT_VIOLATION"])).toMatchObject({ totalPatches: 1, failedPatches: 1, factOk: false, publishable: false });
    const citationFail: PatchValidationRecord = {
      ...record, patchId: "pA", commentIds: ["comment-A"], citation: { ok: false, findingIds: ["c1"], addedKeys: ["missing_fake_key"], removedKeys: [], violations: ["MISSING_CITATION_KEY"] }, overall: "fail",
    };
    const siblingPass: PatchValidationRecord = { ...record, patchId: "pB", commentIds: ["comment-B"] };
    expect(validationForComment([citationFail, siblingPass], "comment-A")).toMatchObject({ citation: false, overall: false });
    expect(validationForComment([citationFail, siblingPass], "comment-B")).toMatchObject({ fact: true, citation: true, overall: true });
    expect(validationForComment([citationFail, siblingPass], "noop-comment")).toBeNull();
  });
});
