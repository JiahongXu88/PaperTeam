import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { VerifiedFindingsPanel } from "../src/components/project/VerifiedFindingsPanel.js";
import type { VerifiedFindingRecordView, VerifiedFindingsGateSummaryView } from "../src/types/api.js";

/**
 * M16 后续：审稿意见证书核验呈现。
 * - 已核验缺陷（L1）展示原文位置、单元格、容差、输入指纹，与「转写稿需对照原件」可区分
 * - 旧产物 / 未执行 → 明示未评估，不补「已核验」
 * - 没有证实矛盾时不说「通过」；定位问题单独提示；不出现达刊宣称
 */
const contradictedRecord: VerifiedFindingRecordView = {
  findingId: "f-1", issueIndex: 0, category: "fact", severityObserved: "major",
  anchor: { status: "LOCATED", file: "main.tex", line: 21, danglingReferences: [] },
  status: "VERIFIED_CONTRADICTED",
  statement: "正文 40.6%（main.tex:21）与唯一绑定的表格单元格 SAM-CP · COCO→Cityscapes › PQ = 41.0（main.tex:12）不一致",
  checks: [{
    kind: "TEXT_TABLE_VALUE", outcome: "CONTRADICTED",
    claim: { raw: "40.6", value: 40.6, decimals: 1, unit: "%", file: "main.tex", start: 10, end: 14, line: 21, sentence: "SAM-CP achieves a 40.6% PQ" },
    counterpart: { file: "main.tex", tableLabel: "tab:ov", tableCaption: "Accuracy", rowKey: ["SAM-CP", "CN-L"], headerPath: ["COCO→Cityscapes", "PQ"], raw: "41.0", line: 12 },
    tolerance: "区间不相交", reasons: [], inputsSha256: "abcdef0123456789",
  }],
};

function summary(partial: Partial<VerifiedFindingsGateSummaryView>, counts: Partial<VerifiedFindingsGateSummaryView["summary"]> = {}): VerifiedFindingsGateSummaryView {
  return {
    schema: "paperteam.verified-findings/v1", status: "EVALUATED", unavailableReason: null, path: "reviews/verified-findings-r1.json", documentFingerprint: "d",
    summary: { findings: 3, located: 2, checked: 1, verifiedContradicted: 0, certifiedOnTranscript: 0, notCertified: 0, danglingReferences: 0, sourceVerification: "AUTHOR_SOURCE", ...counts },
    statements: [], records: [], ...partial,
  };
}

describe("VerifiedFindingsPanel", () => {
  it("renders an L1 verified defect with location, cell, tolerance and fingerprint", () => {
    render(<VerifiedFindingsPanel summary={summary({ records: [contradictedRecord] }, { verifiedContradicted: 1 })} />);
    const item = screen.getByTestId("verified-finding");
    expect(item).toHaveAttribute("data-status", "VERIFIED_CONTRADICTED");
    expect(within(item).getByText("已核验缺陷（L1）")).toBeInTheDocument();
    const check = within(item).getByTestId("verified-finding-check");
    expect(check).toHaveTextContent("main.tex:21");
    expect(check).toHaveTextContent("41.0");
    expect(check).toHaveTextContent("abcdef012345");
  });

  it("distinguishes transcript certificates from L1", () => {
    render(<VerifiedFindingsPanel summary={summary({ records: [{ ...contradictedRecord, status: "CERTIFIED_ON_TRANSCRIPT" }] }, { certifiedOnTranscript: 1, sourceVerification: "SOURCE_UNKNOWN" })} />);
    const item = screen.getByTestId("verified-finding");
    expect(within(item).getByText("转写稿上可复算 · 需对照原件")).toBeInTheDocument();
    expect(within(item).queryByText("已核验缺陷（L1）")).toBeNull();
    expect(screen.getByTestId("verified-findings")).toHaveTextContent("来源未知");
  });

  it("old artifacts and unavailable checks are shown as not evaluated, never verified", () => {
    const { unmount } = render(<VerifiedFindingsPanel summary={undefined} />);
    expect(screen.getByTestId("verified-findings")).toHaveAttribute("data-state", "absent");
    expect(screen.getByTestId("verified-findings")).toHaveTextContent("未评估");
    unmount();
    render(<VerifiedFindingsPanel summary={summary({ status: "UNAVAILABLE", unavailableReason: "SNAPSHOT_UNAVAILABLE" })} />);
    expect(screen.getByTestId("verified-findings")).toHaveAttribute("data-state", "unavailable");
    expect(screen.queryByTestId("verified-finding")).toBeNull();
  });

  it("no certified contradiction is not a pass; dangling references are surfaced; no journal-level claim", () => {
    const dangling: VerifiedFindingRecordView = { ...contradictedRecord, findingId: "f-2", issueIndex: 4, status: "NOT_APPLICABLE", statement: null, checks: [], anchor: { status: "LOCATED", file: "main.tex", line: 3, danglingReferences: ["Table 7"] } };
    render(<VerifiedFindingsPanel summary={summary({ records: [dangling] }, { danglingReferences: 1 })} />);
    expect(screen.getByTestId("verified-findings-none")).toHaveTextContent("未证实 ≠ 没有问题");
    expect(screen.getByTestId("verified-findings-dangling")).toHaveTextContent("Table 7");
    expect(screen.getByTestId("verified-findings").textContent).not.toMatch(/达到.*水平|可投稿|录用/);
  });
});
