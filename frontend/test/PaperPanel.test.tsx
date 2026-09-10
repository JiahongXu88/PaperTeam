import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PaperPanel } from "../src/components/project/PaperPanel.js";
import { ApiError } from "../src/api/client.js";
import { renderWithProviders } from "./helpers.js";
import type {
  ArtifactsResponseView,
  BuildRunResultView,
  BuildStatusView,
  FinalizeResultView,
  PaperArtifactView,
  RevisionIterationView,
} from "../src/types/api.js";

/**
 * 论文产出面板（M4.7）：
 * - Draft / Final 卡片：产物元数据 + 查看（新标签页 inline URL）/ 下载（attachment URL）
 * - Draft 语义：无 Final 时说「当前版本可以作为 Draft，但尚未满足 Final 要求」，
 *   绝不出现「质量门禁未通过，因此 PDF 无法生成」这类错误语义
 * - Finalize：按钮永远可点（资格由后端确定性判定），拒绝原因按业务码映射
 * - 构建状态：通过 / 失败 + 结构化诊断 + stale 信号 + 重新构建 + 日志展开按需拉取
 * - 修订迭代：收敛结论（首轮 / IMPROVED / CONVERGED）+ 记分卡
 */

vi.mock("../src/api/artifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/artifacts.js")>();
  return {
    ...actual,
    listArtifacts: vi.fn(),
    getBuildStatus: vi.fn(),
    getBuildLog: vi.fn(),
    listIterations: vi.fn(),
    runBuild: vi.fn(),
    finalizeProject: vi.fn(),
  };
});

const artifactsApi = await import("../src/api/artifacts.js");

function artifactFixture(overrides: Partial<PaperArtifactView> = {}): PaperArtifactView {
  return {
    artifactId: "art-draft-rev2",
    kind: "draft",
    revision: 2,
    createdAt: "2026-09-09T08:00:00.000Z",
    buildGate: { passed: true, checkedAt: "2026-09-09T08:00:00.000Z", revision: 2 },
    file: { name: "art-draft-rev2.pdf", mimeType: "application/pdf", bytes: 2048 },
    ...overrides,
  };
}

function artifactsFixture(overrides: Partial<ArtifactsResponseView> = {}): ArtifactsResponseView {
  const draft = artifactFixture();
  const final = artifactFixture({
    artifactId: "art-final-rev2",
    kind: "final",
    qualityGate: { passed: true, round: 1, checkedAt: "2026-09-09T08:05:00.000Z", reviewedRevision: 2 },
    file: { name: "art-final-rev2.pdf", mimeType: "application/pdf", bytes: 4096 },
  });
  return {
    artifacts: [draft, final],
    latestDraft: draft,
    latestFinal: final,
    currentRevision: 2,
    finalUpToDate: true,
    ...overrides,
  };
}

function buildStatusFixture(overrides: Partial<BuildStatusView> = {}): BuildStatusView {
  return {
    build: {
      passed: true,
      reasons: [],
      checkedAt: "2026-09-09T08:00:00.000Z",
      revision: 2,
      compile: { ok: true, tool: "latexmk", durationMs: 4200, exitCode: 0, pdfPath: "build/paper.pdf", logPath: "build/compile.log" },
      diagnostics: [],
    },
    currentRevision: 2,
    stale: false,
    ...overrides,
  };
}

function iterationFixture(overrides: Partial<RevisionIterationView> = {}): RevisionIterationView {
  return {
    revision: 2,
    reviewRound: 2,
    gateRound: 2,
    outcome: "IMPROVED",
    planId: "plan-r2-rev2",
    completedAt: "2026-09-09T07:30:00.000Z",
    scorecard: {
      gatePassed: false,
      failedRuleIds: ["academic_score_threshold"],
      critical: 0,
      major: 2,
      blocking: 1,
      academicScore: 72,
      styleRisk: 30,
    },
    ...overrides,
  };
}

async function mockAll(options: {
  artifacts?: ArtifactsResponseView;
  build?: BuildStatusView;
  iterations?: RevisionIterationView[];
} = {}) {
  vi.mocked(artifactsApi.listArtifacts).mockResolvedValue(options.artifacts ?? artifactsFixture());
  vi.mocked(artifactsApi.getBuildStatus).mockResolvedValue(options.build ?? buildStatusFixture());
  vi.mocked(artifactsApi.listIterations).mockResolvedValue(options.iterations ?? [iterationFixture()]);
  vi.mocked(artifactsApi.finalizeProject).mockReset();
  vi.mocked(artifactsApi.runBuild).mockReset();
  vi.mocked(artifactsApi.getBuildLog).mockReset();
}

describe("PaperPanel：产物卡片", () => {
  beforeEach(() => {
    void mockAll();
  });

  it("Final + Draft 卡片：元数据 / 查看（新标签页 inline）/ 下载（attachment）", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);

    const finalCard = await screen.findByTestId("final-card");
    expect(finalCard).toHaveTextContent("已冻结");
    expect(finalCard).toHaveTextContent("rev 2");
    expect(finalCard).toHaveTextContent("第 1 轮通过");

    await userEvent.click(screen.getByTestId("final-view"));
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/projects/p-paper0001/artifacts/art-final-rev2/download"),
      "_blank",
      "noopener,noreferrer",
    );
    expect(openSpy.mock.calls[0]?.[0]).not.toContain("disposition=attachment");
    openSpy.mockRestore();

    // 下载：anchor 导航到 attachment URL（通过 href 断言）
    const clicks: string[] = [];
    const clickCapture = (event: MouseEvent) => {
      const anchor = event.target as HTMLAnchorElement;
      if (anchor instanceof HTMLAnchorElement) {
        clicks.push(anchor.href);
      }
    };
    document.addEventListener("click", clickCapture, true);
    await userEvent.click(screen.getByTestId("final-download"));
    document.removeEventListener("click", clickCapture, true);
    expect(clicks[0]).toContain("disposition=attachment");

    // Draft 卡片存在且有查看入口；产物历史列出全部条目
    expect(screen.getByTestId("draft-card")).toHaveTextContent("可用");
    expect(screen.getByTestId("artifact-history")).toHaveTextContent("2 个");
  });

  it("Final 过期（finalUpToDate=false）：提示新修订需复审，旧 Final 仍可查看", async () => {
    const final = artifactFixture({
      artifactId: "art-final-rev2",
      kind: "final",
      revision: 2,
      qualityGate: { passed: true, round: 1, checkedAt: "2026-09-09T08:05:00.000Z", reviewedRevision: 2 },
    });
    void mockAll({
      artifacts: {
        artifacts: [final],
        latestDraft: null,
        latestFinal: final,
        currentRevision: 3,
        finalUpToDate: false,
      },
    });
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    expect(await screen.findByTestId("final-stale")).toHaveTextContent("冻结后又有了新修订");
    expect(screen.getByTestId("draft-card")).toHaveTextContent("尚无 PDF");
  });

  it("Draft-only（Quality FAIL 项目）：正确语义——可作为 Draft，尚未满足 Final 要求", async () => {
    const draft = artifactFixture();
    void mockAll({
      artifacts: {
        artifacts: [draft],
        latestDraft: draft,
        latestFinal: null,
        currentRevision: 3,
        finalUpToDate: false,
      },
    });
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    const finalCard = await screen.findByTestId("final-card");
    expect(finalCard).toHaveTextContent("当前版本可以作为 Draft，但尚未满足 Final 要求");
    // 红线文案绝不出现
    expect(screen.queryByText(/因此 PDF 无法生成/)).toBeNull();
    expect(screen.getByTestId("draft-card")).toHaveTextContent("当前版本可以作为 Draft");
  });

  it("空项目：空态 + 引导构建", async () => {
    void mockAll({
      artifacts: { artifacts: [], latestDraft: null, latestFinal: null, currentRevision: 0, finalUpToDate: false },
      build: { build: null, currentRevision: 0, stale: false },
      iterations: [],
    });
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    expect(await screen.findByTestId("artifact-empty")).toHaveTextContent("还没有可用的论文 PDF");
    expect(await screen.findByTestId("build-empty")).toHaveTextContent("尚未构建过");
  });
});

describe("PaperPanel：标记 Final（资格由后端判定）", () => {
  beforeEach(() => {
    void mockAll();
  });

  it("点击 → POST finalize；成功后展示冻结的修订", async () => {
    vi.mocked(artifactsApi.finalizeProject).mockResolvedValue({
      final: artifactFixture({ artifactId: "art-final-rev2", kind: "final" }),
      draft: artifactFixture(),
      revision: 2,
      gateRound: 1,
    } as FinalizeResultView);
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    await screen.findByTestId("final-card");
    await userEvent.click(screen.getByTestId("finalize-button"));
    expect(artifactsApi.finalizeProject).toHaveBeenCalledWith("p-paper0001");
    expect(await screen.findByTestId("finalize-success")).toHaveTextContent("rev 2");
  });

  it("QUALITY_GATE_FAILED 拒绝 → 映射为 Draft 语义（不是『PDF 无法生成』）", async () => {
    vi.mocked(artifactsApi.finalizeProject).mockRejectedValue(
      new ApiError(422, "QUALITY_GATE_FAILED", "Quality Gate 未通过"),
    );
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    await screen.findByTestId("final-card");
    await userEvent.click(screen.getByTestId("finalize-button"));
    const error = await screen.findByTestId("finalize-error");
    expect(error).toHaveTextContent("尚未满足 Final 要求");
    expect(error).toHaveTextContent("当前版本可以作为 Draft");
    expect(error.textContent ?? "").not.toContain("因此 PDF 无法生成");
  });

  it("QUALITY_GATE_STALE / BUILD_GATE_STALE 拒绝 → 指示恢复动作", async () => {
    vi.mocked(artifactsApi.finalizeProject).mockRejectedValueOnce(
      new ApiError(409, "QUALITY_GATE_STALE", "stale"),
    );
    const { unmount } = renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    await screen.findByTestId("final-card");
    await userEvent.click(screen.getByTestId("finalize-button"));
    expect(await screen.findByTestId("finalize-error")).toHaveTextContent("重新审稿");
    unmount();

    vi.mocked(artifactsApi.finalizeProject).mockRejectedValueOnce(
      new ApiError(409, "BUILD_GATE_STALE", "stale"),
    );
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    await screen.findByTestId("final-card");
    await userEvent.click(screen.getByTestId("finalize-button"));
    expect(await screen.findByTestId("finalize-error")).toHaveTextContent("重新构建");
  });
});

describe("PaperPanel：构建状态", () => {
  beforeEach(() => {
    void mockAll();
  });

  it("通过 + 对齐：工具 / 耗时 / 修订对齐标记", async () => {
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    expect(await screen.findByTestId("build-outcome")).toHaveTextContent("构建通过");
    const status = screen.getByTestId("build-status");
    expect(status).toHaveTextContent("latexmk");
    expect(status).toHaveTextContent("对齐当前修订");
    expect(screen.queryByTestId("build-stale")).toBeNull();
  });

  it("stale：展示过期标记与警示", async () => {
    void mockAll({ build: buildStatusFixture({ currentRevision: 5, stale: true }) });
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    expect(await screen.findByTestId("build-stale")).toHaveTextContent("已过期");
  });

  it("失败：结构化诊断（文件:行号 + 错误 + 附近行）", async () => {
    void mockAll({
      build: buildStatusFixture({
        build: {
          passed: false,
          reasons: ["LaTeX 编译失败"],
          checkedAt: "2026-09-09T08:00:00.000Z",
          revision: 2,
          compile: { ok: false, tool: "latexmk", durationMs: 1500, exitCode: 1, pdfPath: null, logPath: "build/compile.log", error: "exit 1" },
          diagnostics: [
            { file: "sections/introduction.tex", line: 5, message: "Undefined control sequence.", contextLines: ["l.5 \\badcommand"] },
          ],
        },
      }),
    });
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    expect(await screen.findByTestId("build-outcome")).toHaveTextContent("构建失败");
    expect(screen.getByTestId("build-diagnostics")).toHaveTextContent("sections/introduction.tex:5");
    const status = screen.getByTestId("build-status");
    expect(status).toHaveTextContent("Undefined control sequence.");
  });

  it("重新构建 → POST /build；失败结果如实呈现", async () => {
    vi.mocked(artifactsApi.runBuild).mockResolvedValue({
      revision: 3,
      build: {
        passed: false,
        reasons: ["LaTeX 编译失败"],
        checkedAt: "2026-09-09T09:00:00.000Z",
        revision: 3,
        compile: { ok: false, tool: "latexmk", durationMs: 900, exitCode: 1, pdfPath: null, logPath: "build/compile.log" },
        diagnostics: [],
      },
      draftArtifactId: null,
      diagnosticsCount: 0,
      compile: { ok: false, tool: "latexmk", durationMs: 900, exitCode: 1, pdfPath: null, logPath: "build/compile.log" },
    } as BuildRunResultView);
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    await screen.findByTestId("build-outcome");
    await userEvent.click(screen.getByTestId("build-run"));
    await waitFor(() => expect(artifactsApi.runBuild).toHaveBeenCalledWith("p-paper0001"));
    expect(await screen.findByTestId("build-failed-note")).toHaveTextContent("本次构建未通过");
  });

  it("编译日志按需拉取：展开才请求", async () => {
    vi.mocked(artifactsApi.getBuildLog).mockResolvedValue({ log: "! Undefined control sequence.\nl.5 \\bad" });
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    await screen.findByTestId("build-outcome");
    expect(artifactsApi.getBuildLog).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("build-log-toggle"));
    await waitFor(() => expect(artifactsApi.getBuildLog).toHaveBeenCalledWith("p-paper0001", expect.anything()));
    expect(await screen.findByTestId("build-log")).toHaveTextContent("Undefined control sequence");
  });
});

describe("PaperPanel：修订迭代历史", () => {
  beforeEach(() => {
    void mockAll();
  });

  it("按轮倒序展示收敛结论与记分卡", async () => {
    void mockAll({
      iterations: [
        iterationFixture({ gateRound: 1, reviewRound: 1, revision: 1, outcome: null, planId: undefined }),
        iterationFixture(),
        iterationFixture({
          gateRound: 3,
          revision: 4,
          outcome: "CONVERGED",
          scorecard: {
            gatePassed: false,
            failedRuleIds: ["academic_score_threshold"],
            critical: 0,
            major: 2,
            blocking: 1,
            academicScore: 72,
            styleRisk: 30,
          },
        }),
      ],
    });
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    const items = await screen.findAllByTestId("iteration-item");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("第 3 轮");
    expect(items[0]).toHaveTextContent("不再收敛");
    expect(items[1]).toHaveTextContent("有实质改善");
    expect(items[2]).toHaveTextContent("首轮");
    expect(items[1]).toHaveTextContent("学术评分 72");
  });

  it("无迭代记录：不渲染该面板", async () => {
    void mockAll({ iterations: [] });
    renderWithProviders(<PaperPanel projectId="p-paper0001" />);
    await screen.findByTestId("build-status");
    expect(screen.queryByTestId("iterations-card")).toBeNull();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
