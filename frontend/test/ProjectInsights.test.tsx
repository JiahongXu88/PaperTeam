import { act, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProjectInsights } from "../src/components/project/ProjectInsights.js";
import { queryKeys } from "../src/hooks/queries.js";
import { createTestQueryClient, renderWithProviders } from "./helpers.js";

vi.mock("../src/api/paper.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/api/paper.js")>(),
  getPaper: vi.fn(async () => ({ document: null })),
  listCitations: vi.fn(async () => ({ summary: { extracted: false }, references: [] })),
  getPaperReviewReport: vi.fn(async () => ({ review: {
    sectionsReviewed: 9, sectionsTotal: 10, findingsTotal: 17,
    bySeverity: { critical: 0, major: 2, minor: 10, info: 5 },
  } })),
}));

it("首页驻留期间 Review 完成后刷新摘要，而不是继续显示旧报告", async () => {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  const id = "p-home-review";
  client.setQueryData(queryKeys.paper(id), { document: null });
  client.setQueryData(queryKeys.citations(id), { summary: { extracted: false }, references: [] });
  client.setQueryData(queryKeys.paperReview(id), null);
  client.setQueryData(queryKeys.projectRuns(id), [{ workflowKind: "existing_paper_review", status: "running" }]);
  renderWithProviders(<ProjectInsights projectId={id} />, { client });
  expect(screen.getByText("审阅进行中")).toBeInTheDocument();
  act(() => client.setQueryData(queryKeys.projectRuns(id), [{ workflowKind: "existing_paper_review", status: "completed" }]));
  expect(await screen.findByText("已审阅 9 / 10 节")).toBeInTheDocument();
  expect(screen.getByText("17")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /查看报告/ })).toHaveAttribute("href", `/projects/${id}?tab=review`);
});
