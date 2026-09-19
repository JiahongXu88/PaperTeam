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
import { renderWithProviders } from "./helpers.js";

/**
 * M7.1c Discovery UI（既有后端能力的前端消费）：
 * - 检索 payload（学术含年份范围 / Web 精简）与显式保存（saveAsCandidates 下标）
 * - 候选列表渲染（发现方式 / provider / 状态徽标 / provenance）
 * - Promote / Reject 调用既有幂等端点；loading / empty / error 状态
 */

vi.mock("../src/api/discovery.js", () => ({
  academicSearch: vi.fn(),
  webSearch: vi.fn(),
  listCandidates: vi.fn(),
  promoteCandidate: vi.fn(),
  rejectCandidate: vi.fn(),
}));

const api = vi.mocked(await import("../src/api/discovery.js"));

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

async function renderPanel(candidates: CandidateSourceView[] = []) {
  api.listCandidates.mockResolvedValue(candidates);
  renderWithProviders(<DiscoveryPanel projectId="p-1" />, { route: "/projects/p-1?tab=discovery" });
  await screen.findByText("候选文献");
  // 等 query 真正 settle（loading 态下 section 标题与「0 条」也会渲染）
  if (candidates.length === 0) {
    await screen.findByText(/还没有候选/);
  } else {
    await screen.findByText(`${candidates.length} 条`);
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
