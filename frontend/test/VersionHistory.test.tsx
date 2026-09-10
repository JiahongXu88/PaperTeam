import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { VersionHistoryCard } from "../src/components/project/VersionHistory.js";
import { ApiError } from "../src/api/client.js";
import { renderWithProviders } from "./helpers.js";
import type { ManuscriptVersionView, VersionCompareView, VersionListView } from "../src/types/api.js";

/**
 * 版本历史（M4.8）：
 * - 历史列表：修订号 / 当前版本 / Final / Draft / 审稿轮次 / 门禁 / 恢复来源
 *   全部来自 Backend ManuscriptVersionDTO（前端不拼装）
 * - 比较：两个修订的确定性差异（章节状态 + 规模 + scorecard 对照）
 * - 恢复：确认文案如实（创建新修订、不删除历史）；成功 / 拒绝（PROJECT_BUSY）
 */

vi.mock("../src/api/versions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/versions.js")>();
  return {
    ...actual,
    listVersions: vi.fn(),
    compareVersions: vi.fn(),
    restoreRevision: vi.fn(),
  };
});

const versionsApi = await import("../src/api/versions.js");
const listVersionsMock = vi.mocked(versionsApi.listVersions);
const compareVersionsMock = vi.mocked(versionsApi.compareVersions);
const restoreRevisionMock = vi.mocked(versionsApi.restoreRevision);

function versionFixture(overrides: Partial<ManuscriptVersionView> = {}): ManuscriptVersionView {
  return {
    revision: 1,
    createdAt: "2026-09-10T08:00:00.000Z",
    source: "writing.sections",
    isCurrent: false,
    isFinal: false,
    hasDraft: false,
    review: null,
    qualityGate: null,
    build: null,
    artifacts: [],
    revisionPlan: null,
    iteration: null,
    ...overrides,
  };
}

function versionsFixture(): VersionListView {
  return {
    current: 3,
    versions: [
      versionFixture({
        revision: 3,
        createdAt: "2026-09-10T09:00:00.000Z",
        source: "revision.restore",
        restoredFrom: 1,
        isCurrent: true,
        hasDraft: true,
        artifacts: [{ artifactId: "art-draft-rev3", kind: "draft" }],
      }),
      versionFixture({
        revision: 2,
        source: "revision.revise",
        review: {
          round: 1,
          reviewedRevision: 2,
          critical: 1,
          major: 3,
          blocking: 1,
          academicScore: 67,
        },
        qualityGate: { round: 1, passed: false, failedRuleIds: ["academic_score_threshold"] },
        isFinal: true,
        artifacts: [{ artifactId: "art-final-rev2", kind: "final" }],
        revisionPlan: { planId: "plan-r1-rev2", round: 1, planned: 2, skipped: 1 },
      }),
      versionFixture({ revision: 1, source: "outline.plan" }),
    ],
  };
}

function compareFixture(): VersionCompareView {
  return {
    from: { revision: 1, createdAt: "2026-09-10T08:00:00.000Z", source: "outline.plan" },
    to: { revision: 3, createdAt: "2026-09-10T09:00:00.000Z", source: "revision.restore" },
    sections: [
      { path: "sections/introduction.tex", title: "引言", status: "modified", fromLines: 12, toLines: 18, added: 7, removed: 1 },
      { path: "sections/method.tex", title: "方法", status: "unchanged", fromLines: 30, toLines: 30, added: 0, removed: 0 },
      { path: "sections/appendix.tex", title: "appendix.tex", status: "added", fromLines: null, toLines: 9, added: 9, removed: 0 },
    ],
    summary: { unchanged: 1, modified: 1, added: 1, removed: 0 },
    reviewDelta: {
      from: null,
      to: {
        round: 2,
        reviewedRevision: 3,
        critical: 0,
        major: 1,
        blocking: 0,
        academicScore: 82,
      },
      fromGate: null,
      toGate: { round: 2, passed: true, failedRuleIds: [] },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listVersionsMock.mockResolvedValue(versionsFixture());
  compareVersionsMock.mockResolvedValue(compareFixture());
});

describe("版本历史", () => {
  it("列表展示 Backend DTO 事实：当前版本 / Final / 恢复来源 / 审稿 / 门禁 / 计划", async () => {
    renderWithProviders(<VersionHistoryCard projectId="p-1" />);

    const items = await screen.findAllByTestId("version-item");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute("data-revision", "3");
    expect(items[0]).toHaveTextContent("当前版本");
    expect(items[0]).toHaveTextContent("版本恢复");
    expect(items[0]).toHaveTextContent("基于修订 1 恢复");
    // rev2：Final + 门禁未通过 + 审稿轮次 + 修订计划
    expect(items[1]).toHaveTextContent("Final");
    expect(items[1]).toHaveTextContent("审稿第 1 轮：严重 1 / 主要 3 · 学术 67");
    expect(items[1]).toHaveTextContent("门禁未通过（1 项）");
    expect(items[1]).toHaveTextContent("修订计划 plan-r1-rev2（派发 2 · 记录 1）");
    expect(items[1]).toHaveTextContent("审稿修订");
    // rev1：无审稿记录
    expect(items[2]).toHaveTextContent("未审稿");
    // Final 产物提供查看入口（受控 artifact URL）
    expect(screen.getByRole("link", { name: "查看 Final" })).toHaveAttribute(
      "href",
      expect.stringContaining("/api/projects/p-1/artifacts/art-final-rev2/download"),
    );
  });

  it("比较：选择两个修订 → 章节状态 + 规模 + scorecard 对照", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VersionHistoryCard projectId="p-1" />);
    await screen.findAllByTestId("version-item");

    // 默认比较 2 → 3（上一版 → 当前版），加载后呈现结果
    await waitFor(() => {
      expect(screen.getByTestId("version-compare-result")).toBeVisible();
    });
    expect(compareVersionsMock).toHaveBeenCalledWith("p-1", 2, 3, expect.anything());
    const table = screen.getByTestId("version-compare-table");
    expect(table).toHaveTextContent("引言");
    expect(table).toHaveTextContent("已修改");
    expect(table).toHaveTextContent("12 → 18 行（+7 / −1）");
    expect(table).toHaveTextContent("未变化");
    expect(table).toHaveTextContent("新增");
    const delta = screen.getByTestId("version-compare-delta");
    expect(delta).toHaveTextContent("无审稿记录");
    expect(delta).toHaveTextContent("第 2 轮审稿：严重 0 / 主要 1 · 学术 82 · 门禁通过");

    // 切换比较目标 → 重新请求
    await user.selectOptions(screen.getByTestId("compare-from"), "3");
    await user.selectOptions(screen.getByTestId("compare-to"), "1");
    await waitFor(() => {
      expect(compareVersionsMock).toHaveBeenLastCalledWith("p-1", 3, 1, expect.anything());
    });
  });

  it("恢复：确认文案如实（创建新修订 / 不删除历史）；成功后展示过期提示", async () => {
    const user = userEvent.setup();
    restoreRevisionMock.mockResolvedValue({ revision: 4, created: true, restoredFrom: 2, current: 4 });
    renderWithProviders(<VersionHistoryCard projectId="p-1" />);
    await screen.findAllByTestId("version-item");

    await user.click(screen.getAllByTestId("version-restore-button")[0]!);
    const confirm = screen.getByTestId("version-restore-confirm");
    expect(confirm).toHaveTextContent("将基于修订 2 创建新的当前修订。现有版本历史不会被删除");
    await user.click(screen.getByTestId("version-restore-confirm-button"));
    expect(restoreRevisionMock).toHaveBeenCalledWith("p-1", 2);
    await waitFor(() => {
      expect(screen.getByTestId("version-restore-success")).toHaveTextContent(
        "已创建修订 4（基于修订 2）",
      );
    });
    expect(screen.getByTestId("version-restore-success")).toHaveTextContent("旧门禁与构建结论已过期");
  });

  it("恢复被拒绝（PROJECT_BUSY）：按业务语义映射，不透传内部信息", async () => {
    const user = userEvent.setup();
    restoreRevisionMock.mockRejectedValue(
      new ApiError(409, "PROJECT_BUSY", "项目有进行中的 workflow run"),
    );
    renderWithProviders(<VersionHistoryCard projectId="p-1" />);
    await screen.findAllByTestId("version-item");

    await user.click(screen.getAllByTestId("version-restore-button")[0]!);
    await user.click(screen.getByTestId("version-restore-confirm-button"));
    await waitFor(() => {
      expect(screen.getByTestId("version-restore-error")).toHaveTextContent(
        "项目有进行中的任务，任务结束后再恢复版本。",
      );
    });
  });

  it("当前版本行不提供恢复入口", async () => {
    renderWithProviders(<VersionHistoryCard projectId="p-1" />);
    await screen.findAllByTestId("version-item");
    const restoreButtons = screen.getAllByTestId("version-restore-button");
    expect(restoreButtons).toHaveLength(2); // rev1 / rev2；rev3 是当前版本
  });
});
