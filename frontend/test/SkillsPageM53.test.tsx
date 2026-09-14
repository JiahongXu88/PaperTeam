import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { SkillsPage } from "../src/pages/SkillsPage.js";
import type { SkillCatalogEntry, SkillProvenanceView, SkillUpdatePreview, SkillView } from "../src/types/paper.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M5.3 Skill Settings UI：名称 / 用途 / 来源 / 固定 revision / 安装状态 / hash 摘要 /
 * role + contextScope 绑定 / update 状态；install approved Skill、预览并应用更新、
 * 查看 provenance；没有任意 URL 输入框。
 */

vi.mock("../src/api/skills.js", () => ({
  listSkills: vi.fn(),
  regenerateSkillSummary: vi.fn(),
  getSkillProvenance: vi.fn(),
  getSkillUpdatePreview: vi.fn(),
  applySkillUpdate: vi.fn(),
  installSkill: vi.fn(),
}));

const { listSkills, getSkillProvenance, getSkillUpdatePreview, applySkillUpdate, installSkill } =
  await import("../src/api/skills.js");

const SHA_KDENSE = "0b2afe68a5f9379097ad815e028af664f1e222b7";
const HASH_A = "a1b2c3d4e5f6".padEnd(64, "0");
const HASH_B = "b2c3d4e5f6a1".padEnd(64, "0");

const writing: SkillView = {
  id: "academic-writing-zh",
  name: "academic-writing-zh",
  originalDescription: "Draft, revise, and audit scientific manuscripts…",
  purpose: "Writer 撰写 / 修订中文工科论文章节时的写作方法：证据绑定、不补造实验。",
  sourceType: "external",
  sourceRepo: "K-Dense-AI/scientific-agent-skills",
  sourceRevision: SHA_KDENSE,
  upstreamPath: "skills/scientific-writing/SKILL.md",
  version: "2.1+paperteam.1",
  license: "MIT",
  installedPath: "installed/academic-writing-zh",
  contentHash: HASH_A,
  bundleHash: "c".repeat(64),
  status: "installed",
  installedAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  assignedAgents: ["writer"],
  allowedTools: [],
  summaryStatus: "summary_pending",
  wrapperNote: "PaperTeam 学术适配版",
  integrity: "ok",
  disabledByConfig: false,
  update: { available: true, currentHash: HASH_A, candidateHash: HASH_B, currentRevision: SHA_KDENSE, candidateRevision: SHA_KDENSE },
};

const style: SkillView = {
  ...writing,
  id: "academic-style-zh",
  name: "academic-style-zh",
  purpose: "style Reviewer 与 style-only 润色的中文学术表达原则。",
  sourceRepo: "op7418/Humanizer-zh",
  sourceRevision: "91f3d394db8419c20d67ebe22a96cf8fee0a404b",
  contentHash: "d".repeat(64),
  assignedAgents: ["reviewer", "writer"],
  disabledByConfig: true,
  update: { available: false, currentHash: "d".repeat(64), candidateHash: "d".repeat(64) },
};

const catalog: SkillCatalogEntry[] = [
  { id: "academic-writing-zh", name: "academic-writing-zh", installed: true },
  { id: "academic-style-zh", name: "academic-style-zh", installed: true },
  {
    id: "academic-review",
    name: "academic-review",
    purpose: "academic Reviewer 的可执行审稿方法。",
    sourceRepo: "K-Dense-AI/scientific-agent-skills",
    sourceRevision: SHA_KDENSE,
    license: "MIT",
    installed: false,
  },
];

const bindings = [
  { agentRole: "writer", skillIds: ["academic-writing-zh"] },
  { agentRole: "writer", contextScope: "writing/style-polish", skillIds: ["academic-writing-zh", "academic-style-zh"] },
  { agentRole: "reviewer", contextScope: "review/style", skillIds: ["academic-style-zh"] },
];

function mockList() {
  vi.mocked(listSkills).mockResolvedValue({ skills: [writing, style], catalog, bindings, allowedContextScopes: ["review/style", "writing/style-polish"] });
}

describe("SkillsPage（M5.3 受控 Skill 设置）", () => {
  it("展示用途 / 来源 / 固定 revision / hash 摘要 / 绑定 role+scope / 更新与禁用状态；没有 URL 输入框", async () => {
    mockList();
    renderWithProviders(<SkillsPage />, { route: "/skills" });
    expect((await screen.findAllByText("academic-writing-zh")).length).toBeGreaterThan(0);
    expect(screen.getByText(/证据绑定、不补造实验/)).toBeInTheDocument();
    expect(screen.getAllByText("K-Dense-AI/scientific-agent-skills").length).toBeGreaterThan(0);
    expect(screen.getAllByText(SHA_KDENSE.slice(0, 12)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(HASH_A.slice(0, 12)).length).toBeGreaterThan(0);
    // 绑定 chips：writer 默认 + style-polish；reviewer review/style
    expect(screen.getByText(/写作（writer） · 默认/)).toBeInTheDocument();
    expect(screen.getAllByText(/写作（writer） · writing\/style-polish/).length).toBe(2);
    expect(screen.getByText(/审阅（reviewer） · review\/style/)).toBeInTheDocument();
    // 状态 chips
    expect(screen.getAllByText("有可用更新").length).toBeGreaterThan(0);
    expect(screen.getByText(/配置禁用（不注入）/)).toBeInTheDocument();
    // 绑定表含 contextScope 列
    expect(screen.getByRole("columnheader", { name: "contextScope" })).toBeInTheDocument();
    expect(screen.getAllByText("review/style").length).toBeGreaterThan(0);
    // 无任意 URL 安装入口
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/marketplace/i)).not.toBeInTheDocument();
  });

  it("预览更新：先看到 current/candidate hash、文件 diff 与 SKILL.md 行 diff，应用时携带预览的候选 hash", async () => {
    mockList();
    const preview: SkillUpdatePreview = {
      id: "academic-writing-zh",
      currentHash: HASH_A,
      candidateHash: HASH_B,
      currentRevision: SHA_KDENSE,
      candidateRevision: SHA_KDENSE,
      candidateBundleHash: "e".repeat(64),
      files: [
        { path: "SKILL.md", status: "modified", currentBytes: 100, candidateBytes: 120 },
        { path: "LICENSE", status: "unchanged", currentBytes: 1088, candidateBytes: 1088 },
      ],
      skillMdDiff: { added: 2, removed: 0, hunks: ["+ ## 9. 新增章节", "+ 新规则"], truncated: false },
    };
    vi.mocked(getSkillUpdatePreview).mockResolvedValue(preview);
    vi.mocked(applySkillUpdate).mockResolvedValue({ ...writing, contentHash: HASH_B, update: { available: false, currentHash: HASH_B, candidateHash: HASH_B } });
    renderWithProviders(<SkillsPage />, { route: "/skills" });
    await screen.findAllByText("academic-writing-zh");

    const applyButton = screen.getByRole("button", { name: "应用更新" });
    expect(applyButton).toBeDisabled(); // 未预览不能应用
    expect(getSkillUpdatePreview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "预览更新" }));
    await waitFor(() => expect(getSkillUpdatePreview).toHaveBeenCalledWith("academic-writing-zh", expect.anything()));
    expect(await screen.findByText(HASH_B)).toBeInTheDocument();
    expect(screen.getByText("modified")).toBeInTheDocument();
    expect(screen.getByTestId("skill-diff")).toHaveTextContent("新增章节");

    await waitFor(() => expect(screen.getByRole("button", { name: "应用更新" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "应用更新" }));
    await waitFor(() => expect(applySkillUpdate).toHaveBeenCalledWith("academic-writing-zh", HASH_B));
  });

  it("approved catalog 中未安装的 Skill 显示「安装」并只按 id 安装；查看 provenance 拉取审计材料", async () => {
    mockList();
    vi.mocked(installSkill).mockResolvedValue({ ...writing, id: "academic-review", name: "academic-review" });
    const provenance: SkillProvenanceView = {
      id: "academic-writing-zh",
      contentHash: HASH_A,
      provenance: `# Provenance — academic-writing-zh\n- Pin revision: ${SHA_KDENSE}`,
      license: "MIT License\n\nCopyright (c) 2025 K-Dense Inc.",
      upstreamSnapshot: { file: "UPSTREAM_SKILL.md", sha256: "f".repeat(64), matchesRecorded: true },
    };
    vi.mocked(getSkillProvenance).mockResolvedValue(provenance);
    renderWithProviders(<SkillsPage />, { route: "/skills" });
    await screen.findAllByText("academic-writing-zh");

    expect(screen.getByText("academic-review")).toBeInTheDocument();
    expect(screen.getByText(/未安装（approved）/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    await waitFor(() => expect(installSkill).toHaveBeenCalledWith("academic-review"));

    const provenanceButtons = screen.getAllByRole("button", { name: /查看来源与许可/ });
    fireEvent.click(provenanceButtons[0]!);
    await waitFor(() => expect(getSkillProvenance).toHaveBeenCalledWith("academic-writing-zh", expect.anything()));
    expect(await screen.findByTestId("skill-provenance-academic-writing-zh")).toHaveTextContent(SHA_KDENSE);
    expect(screen.getByText(/与记录 hash 一致/)).toBeInTheDocument();
  });
});
