import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DiscoveryPanel } from "../src/components/project/DiscoveryPanel.js";
import type {
  AcademicSearchResponseView,
  WebSearchResponseView,
} from "../src/types/discovery.js";
import type {
  CandidatePromoteResult,
  CandidateSourceView,
} from "../src/types/sources.js";
import type { PlanExecutionResultView, ResearchPlanView } from "../src/types/researchPlan.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M7.1c Discovery UI（既有后端能力的前端消费）：
 * - 检索 payload（学术含年份范围 / Web 精简）与显式保存（saveAsCandidates 下标）
 * - 候选列表渲染（发现方式 / provider / 状态徽标 / provenance）
 * - Promote / Reject 调用既有幂等端点；loading / empty / error 状态
 *
 * M8.1：Research Plan 展示与受限编辑（GET/PUT /research/plan）。
 */

vi.mock("../src/api/discovery.js", () => ({
  academicSearch: vi.fn(),
  webSearch: vi.fn(),
  listCandidates: vi.fn(),
  promoteCandidate: vi.fn(),
  rejectCandidate: vi.fn(),
}));

vi.mock("../src/api/researchPlan.js", () => ({
  getResearchPlan: vi.fn(async () => null),
  updateResearchPlan: vi.fn(),
  approveResearchPlan: vi.fn(),
  executeResearchPlan: vi.fn(),
}));

const api = vi.mocked(await import("../src/api/discovery.js"));
const planApi = vi.mocked(await import("../src/api/researchPlan.js"));

const NOW = "2026-09-19T08:00:00.000Z";

function academicResponse(
  overrides: Partial<AcademicSearchResponseView> = {},
): AcademicSearchResponseView {
  return {
    status: "success",
    results: [
      {
        record: {
          provider: "openalex",
          recordId: "W1",
          title: "Transformers in Multi-Object Tracking",
          authors: ["Chen, Li"],
          year: 2023,
          venue: "CVPR",
          doi: "10.1000/mot",
          arxivId: "2301.00001",
        },
        citationCount: 42,
        openAccess: true,
        score: 0.0321,
        sources: [{ provider: "openalex", rank: 1 }],
      },
      {
        record: {
          provider: "semantic-scholar",
          recordId: "S2",
          title: "Track-by-Attention Survey",
          authors: ["Wang, Wei", "Zhao, Ming"],
          year: 2022,
        },
        score: 0.0156,
        sources: [{ provider: "semantic-scholar", rank: 2 }],
      },
    ],
    diagnostics: {
      providers: [
        { provider: "openalex", outcome: "ok", resultCount: 1 },
        { provider: "semantic-scholar", outcome: "ok", resultCount: 1 },
      ],
      rawResultCount: 2,
      fusedResultCount: 2,
    },
    ...overrides,
  };
}

function webResponse(): WebSearchResponseView {
  return {
    status: "success",
    results: [
      {
        url: "https://arxiv.org/abs/2301.00001",
        title: "MOT Benchmark Page",
        snippet: "Official benchmark of multi-object tracking.",
        engines: ["google", "bing"],
        score: 1.5,
        rank: 1,
        provider: "searxng",
      },
    ],
    diagnostics: {
      providers: [{ provider: "searxng", outcome: "ok", resultCount: 1 }],
      rawResultCount: 1,
      fusedResultCount: 1,
    },
  };
}

function candidateView(overrides: Partial<CandidateSourceView> = {}): CandidateSourceView {
  return {
    candidateId: "C001",
    origin: "academic_search",
    provider: "openalex",
    title: "Transformers in Multi-Object Tracking",
    authors: ["Chen, Li"],
    year: 2023,
    venue: "CVPR",
    doi: "10.1000/mot",
    query: "transformer multi-object tracking",
    status: "pending_review",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function promoteResult(candidate: CandidateSourceView): CandidatePromoteResult {
  return {
    source: {
      sourceId: "S001",
      sourceRole: "both",
      origin: "AGENT_RETRIEVED",
      status: "metadata_only",
      preferred: false,
      metadata: { title: candidate.title, doi: candidate.doi },
      bytes: 0,
      createdAt: NOW,
      updatedAt: NOW,
    },
    created: true,
    candidate: { ...candidate, status: "accepted", promotedSourceId: "S001" },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

async function renderPanel(candidates: CandidateSourceView[] = [], topic?: string) {
  api.listCandidates.mockResolvedValue(candidates);
  renderWithProviders(
    <DiscoveryPanel projectId="p-1" {...(topic !== undefined ? { topic } : {})} />,
    { route: "/projects/p-1?tab=discovery" },
  );
  await screen.findByText("候选文献");
  // 等 query 真正 settle（loading 态下 section 标题与「0 条」也会渲染）
  if (candidates.length === 0) {
    await screen.findByText(/还没有候选/);
  } else {
    await screen.findByText(`${candidates.length} 条`);
  }
}

function planView(overrides: Partial<ResearchPlanView> = {}): ResearchPlanView {
  return {
    planId: "rp-plan00000001",
    status: "draft",
    questions: ["Transformer MOT 的发展历史", "当前 SOTA 方法", "效率局限"],
    queries: [
      {
        queryId: "q-1",
        query: "Transformer MOT survey",
        kind: "academic",
        rationale: "Understand evolution",
        expectedCoverage: "近三年综述",
        status: "planned",
      },
      {
        queryId: "q-2",
        query: "real-time transformer tracking",
        kind: "web",
        rationale: "Find efficiency optimization",
        status: "executed",
        resultCount: 5,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function renderPanelWithPlan(
  plan: ResearchPlanView | null,
  candidates: CandidateSourceView[] = [],
) {
  planApi.getResearchPlan.mockResolvedValue(plan);
  await renderPanel(candidates, "Transformer MOT");
  if (plan !== null) {
    await screen.findByTestId("plan-queries");
  } else {
    await screen.findByTestId("research-plan-empty");
  }
}

async function runSearch(user: ReturnType<typeof userEvent.setup>) {
  api.academicSearch.mockResolvedValue(academicResponse());
  await user.type(screen.getByLabelText("研究问题"), "transformer multi-object tracking");
  await user.type(screen.getByLabelText(/年份范围/), "2020");
  await user.type(screen.getByLabelText("结束年份"), "2024");
  await user.click(screen.getByRole("button", { name: "检索" }));
}

describe("DiscoveryPanel（M7.1c Discovery 候选 UI）", () => {
  it("空候选 → 检索表单与引导文案齐全；候选列表为空态", async () => {
    await renderPanel([]);

    expect(screen.getByText("研究检索")).toBeTruthy();
    expect(screen.getByRole("button", { name: "学术检索" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Web 检索" })).toBeTruthy();
    expect(await screen.findByText(/还没有候选/)).toBeTruthy();
    for (const label of ["全部", "待审", "已接受", "已拒绝"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("学术检索：payload 携带 query 与年份范围（默认不持久化）", async () => {
    await renderPanel([]);
    const user = userEvent.setup();
    await runSearch(user);

    await waitFor(() => expect(api.academicSearch).toHaveBeenCalledTimes(1));
    expect(api.academicSearch).toHaveBeenCalledWith("p-1", {
      query: "transformer multi-object tracking",
      yearFrom: 2020,
      yearTo: 2024,
    });
    expect(await screen.findByText("Transformers in Multi-Object Tracking")).toBeTruthy();
    expect(screen.getByText("Track-by-Attention Survey")).toBeTruthy();
  });

  it("勾选检索结果 → 保存选中：同参数二次调用并携带 saveAsCandidates 下标", async () => {
    await renderPanel([]);
    const user = userEvent.setup();
    await runSearch(user);
    expect(await screen.findByText("Transformers in Multi-Object Tracking")).toBeTruthy();

    await user.click(screen.getByLabelText("选择结果 1"));
    const savedResponse = academicResponse({
      saved: { saved: [candidateView()], mergedExisting: [1] },
    });
    api.academicSearch.mockResolvedValue(savedResponse);
    await user.click(screen.getByTestId("save-candidates"));

    await waitFor(() => expect(api.academicSearch).toHaveBeenCalledTimes(2));
    expect(api.academicSearch).toHaveBeenLastCalledWith("p-1", {
      query: "transformer multi-object tracking",
      yearFrom: 2020,
      yearTo: 2024,
      saveAsCandidates: [0],
    });
    expect(await screen.findByText(/已保存 1 条候选/)).toBeTruthy();
  });

  it("本地校验：年份区间颠倒 → 提示且不发起请求", async () => {
    await renderPanel([]);
    const user = userEvent.setup();
    api.academicSearch.mockResolvedValue(academicResponse());
    await user.type(screen.getByLabelText("研究问题"), "tracking");
    await user.type(screen.getByLabelText(/年份范围/), "2024");
    await user.type(screen.getByLabelText("结束年份"), "2020");
    await user.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText(/起始年份不能晚于结束年份/)).toBeTruthy();
    expect(api.academicSearch).not.toHaveBeenCalled();
  });

  it("Web 模式：payload 只含 query", async () => {
    await renderPanel([]);
    const user = userEvent.setup();
    api.webSearch.mockResolvedValue(webResponse());
    await user.click(screen.getByRole("button", { name: "Web 检索" }));
    await user.type(screen.getByLabelText("研究问题"), "mot benchmark");
    await user.click(screen.getByRole("button", { name: "检索" }));

    await waitFor(() => expect(api.webSearch).toHaveBeenCalledTimes(1));
    expect(api.webSearch).toHaveBeenCalledWith("p-1", { query: "mot benchmark" });
    expect(await screen.findByText("MOT Benchmark Page")).toBeTruthy();
  });

  it("候选列表渲染：标题 / 元数据 / 发现方式 / provider / 状态徽标 / 检索词", async () => {
    await renderPanel([
      candidateView(),
      candidateView({
        candidateId: "C002",
        origin: "web_search",
        provider: "searxng",
        title: "MOT Benchmark Page",
        authors: undefined,
        year: undefined,
        venue: undefined,
        doi: undefined,
        url: "https://arxiv.org/abs/2301.00001",
        status: "rejected",
      }),
      candidateView({
        candidateId: "C003",
        title: "Accepted Paper",
        status: "accepted",
        promotedSourceId: "S009",
      }),
    ]);

    expect(await screen.findByText("Transformers in Multi-Object Tracking")).toBeTruthy();
    expect(screen.getByText("MOT Benchmark Page")).toBeTruthy();
    // 「学术检索 / Web 检索 / 状态标签」与检索模式按钮、筛选按钮同名 → 按钮 + 徽标同时在场
    expect(screen.getAllByText("学术检索").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Web 检索").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("待审").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("已拒绝").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("已接受").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("→ S009")).toBeTruthy();
    expect(screen.getAllByText(/检索词：transformer multi-object tracking/).length).toBe(3);
    expect(screen.getAllByText("openalex").length).toBe(2);
    expect(screen.getByText("searxng")).toBeTruthy();
    expect(await screen.findByText("3 条")).toBeTruthy();
  });

  it("状态筛选：点击「待审」→ listCandidates 带 status=pending_review", async () => {
    await renderPanel([]);

    await userEvent.setup().click(screen.getByRole("button", { name: "待审" }));
    await waitFor(() => {
      const call = api.listCandidates.mock.calls.at(-1);
      expect(call?.[0]).toBe("p-1");
      expect(call?.[1]).toBe("pending_review");
    });
  });

  it("Promote：勾选候选 → 逐个调用既有 promote 端点并携带入库角色", async () => {
    const first = candidateView();
    const second = candidateView({ candidateId: "C002", title: "Second Paper" });
    await renderPanel([first, second]);
    api.promoteCandidate.mockImplementation(async (_projectId, candidateId) =>
      promoteResult(candidateId === "C001" ? first : second),
    );
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("选择候选 C001"));
    await user.click(screen.getByLabelText("选择候选 C002"));
    await user.selectOptions(screen.getByLabelText("入库角色"), "evidence");
    await user.click(screen.getByTestId("promote-candidates"));

    await waitFor(() => expect(api.promoteCandidate).toHaveBeenCalledTimes(2));
    expect(api.promoteCandidate).toHaveBeenCalledWith("p-1", "C001", { sourceRole: "evidence" });
    expect(api.promoteCandidate).toHaveBeenCalledWith("p-1", "C002", { sourceRole: "evidence" });
    expect(await screen.findByText(/已接受 2 条候选并导入文献库/)).toBeTruthy();
  });

  it("Reject：勾选候选 → 调用既有 reject 端点", async () => {
    const candidate = candidateView();
    await renderPanel([candidate]);
    api.rejectCandidate.mockResolvedValue({ ...candidate, status: "rejected" });
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("选择候选 C001"));
    await user.click(screen.getByTestId("reject-candidates"));

    await waitFor(() => expect(api.rejectCandidate).toHaveBeenCalledTimes(1));
    expect(api.rejectCandidate).toHaveBeenCalledWith("p-1", "C001");
    expect(await screen.findByText(/已拒绝 1 条候选/)).toBeTruthy();
  });

  it("错误状态：检索失败与候选加载失败如实呈现（含重试）", async () => {
    api.listCandidates.mockRejectedValue(new Error("boom"));
    renderWithProviders(<DiscoveryPanel projectId="p-1" />, { route: "/projects/p-1?tab=discovery" });
    expect(await screen.findByText("候选加载失败")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();

    api.listCandidates.mockResolvedValue([]);
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText(/还没有候选/);

    api.academicSearch.mockRejectedValue(new Error("SEARCH_PROVIDER_NOT_CONFIGURED"));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("研究问题"), "tracking");
    await user.click(screen.getByRole("button", { name: "检索" }));
    expect(await screen.findByText("学术检索失败")).toBeTruthy();
  });

  it("partial 检索：如实提示部分源失败", async () => {
    await renderPanel([]);
    api.academicSearch.mockResolvedValue(academicResponse({ status: "partial" }));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("研究问题"), "tracking");
    await user.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText(/部分检索源失败/)).toBeTruthy();
  });
});

describe("DiscoveryPanel（M8.1 Research Plan 展示与编辑）", () => {
  it("无计划：空态引导（先运行调研），不渲染编辑按钮", async () => {
    await renderPanelWithPlan(null);

    expect(screen.getByText("Research Plan")).toBeTruthy();
    expect(screen.getByTestId("research-plan-empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  });

  it("有计划：Topic / Questions / Queries（理由 / 期望覆盖 / 执行结果数）齐全", async () => {
    await renderPanelWithPlan(planView());

    expect(screen.getByText("Transformer MOT")).toBeTruthy(); // topic prop
    expect(screen.getAllByText(/发展历史/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Transformer MOT survey")).toBeTruthy();
    expect(screen.getByText("real-time transformer tracking")).toBeTruthy();
    expect(screen.getByText("理由：Understand evolution")).toBeTruthy();
    expect(screen.getByText("理由：Find efficiency optimization")).toBeTruthy();
    expect(screen.getByText("期望覆盖：近三年综述")).toBeTruthy();
    expect(screen.getByText("5 条结果")).toBeTruthy();
    expect(screen.getByText("草稿")).toBeTruthy();
  });

  it("编辑保存：改问题 + 改检索词与状态 + 增删条目 → PUT 受限字段 payload", async () => {
    await renderPanelWithPlan(planView());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "编辑" }));
    const questions = screen.getByLabelText("研究问题（每行一个）");
    await user.clear(questions);
    await user.type(questions, "改后的问题一\n改后的问题二");
    await user.clear(screen.getByLabelText("检索词 1"));
    await user.type(screen.getByLabelText("检索词 1"), "end-to-end MOT survey");
    await user.selectOptions(screen.getByLabelText("状态 1"), "skipped");
    await user.click(screen.getAllByRole("button", { name: "删除" })[1]!); // 删除第 2 条
    await user.click(screen.getByRole("button", { name: "添加检索" }));
    // 删除后新行占第 2 个位置（行内 aria-label 按位置编号）
    await user.type(screen.getByLabelText("检索词 2"), "mot occlusion");
    await user.type(screen.getByLabelText("理由 2"), "补遮挡线索");
    await user.selectOptions(screen.getByLabelText("检索方式 2"), "web");

    planApi.updateResearchPlan.mockResolvedValue(planView());
    await user.click(screen.getByRole("button", { name: "保存计划" }));

    await waitFor(() => expect(planApi.updateResearchPlan).toHaveBeenCalledTimes(1));
    expect(planApi.updateResearchPlan).toHaveBeenCalledWith("p-1", {
      questions: ["改后的问题一", "改后的问题二"],
      queries: [
        {
          queryId: "q-1",
          query: "end-to-end MOT survey",
          kind: "academic",
          rationale: "Understand evolution",
          status: "skipped",
        },
        { query: "mot occlusion", kind: "web", rationale: "补遮挡线索", status: "planned" },
      ],
    });
  });

  it("本地校验：检索词为空 → 提示且不发请求", async () => {
    await renderPanelWithPlan(planView());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.clear(screen.getByLabelText("检索词 1"));
    await user.click(screen.getByRole("button", { name: "保存计划" }));

    expect(await screen.findByText(/第 1 条检索词为空/)).toBeTruthy();
    expect(planApi.updateResearchPlan).not.toHaveBeenCalled();
  });
});

describe("DiscoveryPanel（M8.2 Research Plan Execution）", () => {
  function executionResult(
    overrides: Partial<PlanExecutionResultView> = {},
  ): PlanExecutionResultView {
    return {
      executionId: "exec-000000000001",
      totalQueries: 2,
      executedQueries: 2,
      failedQueries: 0,
      plan: planView({ status: "done" }),
      ...overrides,
    };
  }

  it("draft：展示「批准计划」（无执行按钮）；点击 → approve API 调用", async () => {
    await renderPanelWithPlan(planView()); // 默认 draft
    const user = userEvent.setup();

    expect(screen.getByTestId("plan-status").textContent).toBe("草稿");
    expect(screen.getByRole("button", { name: "批准计划" })).toBeTruthy();
    expect(screen.queryByTestId("execute-plan")).toBeNull();

    planApi.approveResearchPlan.mockResolvedValue(planView({ status: "approved" }));
    await user.click(screen.getByRole("button", { name: "批准计划" }));

    await waitFor(() => expect(planApi.approveResearchPlan).toHaveBeenCalledTimes(1));
    expect(planApi.approveResearchPlan).toHaveBeenCalledWith("p-1");
    expect(planApi.executeResearchPlan).not.toHaveBeenCalled();
  });

  it("approved：执行按钮 → 点击调用 execute API，成功后展示执行结果摘要", async () => {
    await renderPanelWithPlan(
      planView({ status: "approved", queries: [
        { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "planned" },
        { queryId: "q-2", query: "real-time transformer tracking", kind: "web", status: "planned" },
      ] }),
    );
    const user = userEvent.setup();

    expect(screen.getByTestId("plan-status").textContent).toBe("已批准");
    expect(screen.queryByRole("button", { name: "批准计划" })).toBeNull();

    planApi.executeResearchPlan.mockResolvedValue(
      executionResult({
        executedQueries: 1,
        failedQueries: 1,
        plan: planView({
          status: "done",
          queries: [
            { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "executed", resultCount: 25 },
            { queryId: "q-2", query: "real-time transformer tracking", kind: "web", status: "planned" },
          ],
        }),
      }),
    );
    await user.click(screen.getByTestId("execute-plan"));

    await waitFor(() => expect(planApi.executeResearchPlan).toHaveBeenCalledTimes(1));
    expect(planApi.executeResearchPlan).toHaveBeenCalledWith("p-1");
    expect(
      await screen.findByText(/计划执行完成：1 条检索成功、1 条失败/),
    ).toBeTruthy();
    expect(screen.getByText(/计划共 2 条/)).toBeTruthy();
  });

  it("执行后回填展示：executed 状态与结果数（Query / Status / Results）", async () => {
    await renderPanelWithPlan(
      planView({ status: "approved", queries: [
        { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "planned" },
      ] }),
    );
    const user = userEvent.setup();

    planApi.executeResearchPlan.mockResolvedValue(
      executionResult({
        totalQueries: 1,
        executedQueries: 1,
        plan: planView({
          status: "done",
          queries: [
            { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "executed", resultCount: 25 },
          ],
        }),
      }),
    );
    // execute 成功后 invalidate 触发重取：getResearchPlan 返回回填后的 plan
    planApi.getResearchPlan.mockResolvedValue(
      planView({
        status: "done",
        queries: [
          { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "executed", resultCount: 25 },
        ],
      }),
    );
    await user.click(screen.getByTestId("execute-plan"));

    expect(await screen.findByText("25 条结果")).toBeTruthy();
    expect(await screen.findByText("已执行")).toBeTruthy();
    expect(screen.getByTestId("plan-status").textContent).toBe("已完成");
  });

  it("done：不渲染批准 / 执行按钮，显示完成提示", async () => {
    await renderPanelWithPlan(planView({ status: "done" }));

    expect(screen.getByTestId("plan-status").textContent).toBe("已完成");
    expect(screen.queryByRole("button", { name: "批准计划" })).toBeNull();
    expect(screen.queryByTestId("execute-plan")).toBeNull();
    expect(screen.getByText(/本轮计划已执行完成/)).toBeTruthy();
  });

  it("执行失败：错误如实呈现（不吞 409）", async () => {
    await renderPanelWithPlan(
      planView({ status: "approved", queries: [
        { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "planned" },
      ] }),
    );
    const user = userEvent.setup();

    planApi.executeResearchPlan.mockRejectedValue(
      new Error("该计划正在执行中，禁止重复执行"),
    );
    await user.click(screen.getByTestId("execute-plan"));

    expect(await screen.findByText("计划执行失败")).toBeTruthy();
    expect(screen.getByText(/禁止重复执行/)).toBeTruthy();
  });
});
