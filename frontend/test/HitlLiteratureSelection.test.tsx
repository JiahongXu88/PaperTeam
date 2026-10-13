import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";

import { HitlPanel } from "../src/components/project/HitlPanel.js";
import type { WorkflowRunView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M13.8 文献遴选 HITL payload：按主题相关性排序的候选带「高 / 中 / 低 / 待确认」标签与理由；
 * 相关性汇总（计数 / 近似重复 / 方法家族覆盖）与回退口径如实展示。
 */

vi.mock("../src/api/runs.js", () => ({
  listProjectRuns: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  createWorkflowRun: vi.fn(),
  resumeWorkflowRun: vi.fn(),
}));
vi.mock("../src/api/paper.js", () => ({ exportReviewReport: vi.fn() }));
vi.mock("../src/api/evidence.js", () => ({
  listEvidence: vi.fn(async () => []),
  getEvidence: vi.fn(),
  confirmEvidenceVerified: vi.fn(),
  getQualityGate: vi.fn(async () => ({ rounds: [], round: null, gate: null, reviewSummary: null, latestReviewRound: null, stale: false })),
  reevaluateQualityGate: vi.fn(),
}));

function literatureRun(payload: Record<string, unknown>): WorkflowRunView {
  return {
    runId: "w-lit0001",
    projectId: "p-lit0001",
    workflowKind: "topic_survey",
    status: "awaiting_input",
    currentStage: "hitl.literature_selection",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:10:00.000Z",
    startedAt: "2026-10-13T00:00:05.000Z",
    awaiting: {
      stageId: "hitl.literature_selection",
      prompt: "文献检索已完成，候选清单如下。",
      options: ["approve", "cancel"],
      payload,
    },
    error: null,
    completion: null,
    progress: null,
    completedStages: ["research.plan", "hitl.research_plan", "survey.search"],
  } as WorkflowRunView;
}

describe("HitlPanel：文献遴选相关性标注（M13.8）", () => {
  it("相关性标签 / 理由 / 汇总与近似重复提示按 payload 渲染，推荐集在前", async () => {
    renderWithProviders(
      <HitlPanel
        run={literatureRun({
          pendingCount: 4,
          recommendedCandidateIds: ["C002", "C001"],
          recommendationBasis: "topic_relevance_v1",
          relevanceCounts: { high: 2, medium: 0, low: 1, uncertain: 1 },
          familyCoverage: { track_query_based: 1, transformer_3d_mot: 1 },
          nearDuplicatesSuppressed: 1,
          yearRange: { from: 2021, to: 2026 },
          candidates: [
            { candidateId: "C002", title: "Query-Based End-to-End Multi-Object Tracking", year: 2021, arxivId: "2401.00002", origin: "academic_search", relevance: { label: "high", score: 0.81, queryHits: 3, familyMatches: ["track_query_based"], reasons: ["命中核心短语：multi object tracking", "3 条检索词均命中"] } },
            { candidateId: "C001", title: "Multi-Camera 3D Multi-Object Tracking", year: 2024, arxivId: "2401.00001", origin: "academic_search", relevance: { label: "high", score: 0.7, queryHits: 1, familyMatches: ["transformer_3d_mot"], reasons: ["方法家族：transformer_3d_mot"] } },
            { candidateId: "C003", title: "Single Object Tracking in the Wild", year: 2026, arxivId: "2401.00003", origin: "academic_search", relevance: { label: "low", score: 0.2, queryHits: 1, familyMatches: [], reasons: ["主题词面命中弱（可能是外围工作）"] } },
            { candidateId: "C004", title: "A Note on Smart City Sensing", year: 2025, arxivId: "2401.00004", origin: "academic_search", relevance: { label: "uncertain", score: 0.1, queryHits: 0, familyMatches: [], reasons: ["无摘要且标题未命中主题词，无法确认相关性"] } },
          ],
        })}
      />,
    );
    const panel = await screen.findByTestId("hitl-payload-literature-selection");
    expect(panel).toHaveTextContent("候选文献 4 篇 · 推荐入选 2 篇");
    const summary = screen.getByTestId("literature-selection-relevance-summary");
    expect(summary).toHaveTextContent("高 2 · 中 0 · 低 1 · 待确认 1");
    expect(summary).toHaveTextContent("近似重复已排除 1");
    expect(summary).toHaveTextContent("track_query_based 1");
    expect(screen.getByTestId("literature-relevance-C002")).toHaveTextContent("高相关");
    expect(screen.getByTestId("literature-relevance-C003")).toHaveTextContent("低相关");
    expect(screen.getByTestId("literature-relevance-C004")).toHaveTextContent("相关性待确认");
    expect(within(screen.getByTestId("literature-candidate-C002")).getByText("推荐")).toBeInTheDocument();
    expect(within(screen.getByTestId("literature-candidate-C003")).getByText("备选")).toBeInTheDocument();
    expect(screen.getByTestId("literature-candidate-C002")).toHaveTextContent("3 条检索词均命中");
    const rows = screen.getByTestId("literature-selection-candidates").querySelectorAll("li");
    expect(rows[0]).toHaveAttribute("data-testid", "literature-candidate-C002");
    expect(panel).toHaveTextContent("无法确认相关性的候选如实标注");
  });

  it("回退口径（recency_fallback）如实提示人工核对；旧 payload（无 relevance）仍可渲染", async () => {
    renderWithProviders(
      <HitlPanel
        run={literatureRun({
          pendingCount: 1,
          recommendedCandidateIds: ["C001"],
          recommendationBasis: "recency_fallback",
          relevanceCounts: { high: 0, medium: 0, low: 1, uncertain: 0 },
          candidates: [{ candidateId: "C001", title: "Legacy Candidate", year: 2024, origin: "academic_search" }],
        })}
      />,
    );
    const summary = await screen.findByTestId("literature-selection-relevance-summary");
    expect(summary).toHaveTextContent("回退为学术形态优先、年份降序");
    expect(screen.getByTestId("literature-candidate-C001")).toHaveTextContent("Legacy Candidate");
    expect(screen.queryByTestId("literature-relevance-C001")).toBeNull();
  });
});
