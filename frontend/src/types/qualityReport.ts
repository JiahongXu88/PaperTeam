/**
 * M15 长程 B / D：分层 QualityReport 与数值修改请求的前端视图类型（与 backend/src/quality/qualityReport.ts、
 * valueChangeRequests.ts 同构；前端不做任何重算，只呈现）。
 */
export type QualityLayerIdView = "L0" | "L1" | "L2" | "L3" | "L4";
export type QualityLayerStatusView = "PASS" | "FAIL" | "NOT_EVALUATED" | "NOT_APPLICABLE" | "NEEDS_VERIFICATION" | "NEEDS_AUTHOR_DECISION" | "UNVALIDATED";
export type QualityOverallStatusView = "PASS" | "FAIL" | "NOT_EVALUATED" | "NEEDS_VERIFICATION" | "NEEDS_AUTHOR_DECISION";

export interface QualityReportItemView {
  id: string;
  layer: QualityLayerIdView;
  sourceStatus: string;
  status: QualityLayerStatusView;
  required: boolean;
  evidenceGrade: string;
  detail: string;
  reasonCode?: string;
}

export interface QualityReportLayerView {
  layer: QualityLayerIdView;
  title: string;
  status: QualityLayerStatusView;
  items: QualityReportItemView[];
  blocking: string[];
  unknowns: string[];
}

export interface QualityReportView {
  schemaVersion: "quality-report/v1";
  generatedAt: string;
  binding: {
    reviewedRevision: number | null;
    reviewRound: number | null;
    inputFingerprint: string | null;
    runId: string | null;
    entry: "workflow" | "manual" | "legacy_projection";
    workflowKind: string | null;
    reviewPurpose: string | null;
  };
  layers: Record<QualityLayerIdView, QualityReportLayerView>;
  overall: { status: QualityOverallStatusView; finalizable: boolean; reasons: string[]; unknowns: string[]; statement: string };
  compat: { legacyPassedDerived: boolean; rulePassedBeforeReport: boolean | null; difference: string | null; meaning: string };
  externalValidity: { independentHumanLabels: number; scoreCalibrated: false; targetJournalValidated: false; statement: string };
}

export interface ValueChangeRequestView {
  requestId: string;
  target: string;
  before: string;
  after: string;
  context: string;
  proposedContext: string;
  baselineHash: string;
  baseRevision: number | null;
  source: { runId: string; stageId: string; instructionIds: string[]; planItemIds: string[]; violation: string };
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  decidedAt?: string;
  approvalId?: string;
  boundHash: string;
}
