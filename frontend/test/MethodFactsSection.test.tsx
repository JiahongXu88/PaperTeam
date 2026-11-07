import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MethodFactsSection } from "../src/components/project/MethodFactsSection.js";
import { renderWithProviders } from "./helpers.js";
import type { MethodFactStateView } from "../src/api/experimentPackages.js";

vi.mock("../src/api/experimentPackages.js", () => ({ getMethodFacts: vi.fn(), confirmMethodFacts: vi.fn(), revokeMethodFacts: vi.fn() }));
const api = await import("../src/api/experimentPackages.js");

// SYNTHETIC：与任何真实方法无关的示意参数 / 组件
const candidates: MethodFactStateView = {
  status: "none",
  candidates: [
    { candidateId: "mfc-1", factKind: "parameter", subject: "λ", aliases: [], value: 0.35, valueText: "0.35", quote: "λ=0.35" },
    { candidateId: "mfc-2", factKind: "component", subject: "邻域门控", aliases: [], status: "REMOVED", quote: "去掉邻域门控" },
  ],
};
const sheet = { sheetId: "mfs-0001", version: 1, createdAt: "2026-01-01T00:00:00Z", contentHash: "c".repeat(64), facts: [
  { factId: "mf-1", factKind: "parameter" as const, subject: "λ", aliases: [], value: 0.35, valueText: "0.35", unit: "dimensionless", scope: [], sourceLocator: "author", confirmedAt: "2026-01-01T00:00:00Z" },
] };

beforeEach(() => { vi.clearAllMocks(); });

describe("MethodFactsSection（M17.2.1 作者方法事实）", () => {
  it("预填研究想法候选但标明未确认；作者确认后才提交为事实", async () => {
    vi.mocked(api.getMethodFacts).mockResolvedValue(candidates);
    vi.mocked(api.confirmMethodFacts).mockResolvedValue({ status: "valid", sheet, candidates: [] });
    renderWithProviders(<MethodFactsSection projectId="p-test" />);
    expect((await screen.findByTestId("method-facts-none")).textContent).toContain("未经确认");
    expect((screen.getByLabelText("参数取值") as HTMLInputElement).value).toBe("0.35");
    expect((screen.getByLabelText("组件状态") as HTMLSelectElement).value).toBe("REMOVED");
    await userEvent.click(screen.getByTestId("method-facts-confirm"));
    await waitFor(() => expect(api.confirmMethodFacts).toHaveBeenCalledWith("p-test", { facts: [
      { factKind: "parameter", subject: "λ", valueText: "0.35", sourceLocator: "project.researchIdea + author:method-facts-form" },
      { factKind: "component", subject: "邻域门控", status: "REMOVED", sourceLocator: "project.researchIdea + author:method-facts-form" },
    ] }));
  });

  it("失效 / 撤销状态醒目提示，不显示为有效", async () => {
    vi.mocked(api.getMethodFacts).mockResolvedValue({ status: "stale", sheet, reasons: ["研究想法原文已在确认后修改"], candidates: [] });
    renderWithProviders(<MethodFactsSection projectId="p-test" />);
    expect((await screen.findByTestId("method-facts-active")).textContent).toContain("已失效");
    expect(screen.getByRole("alert").textContent).toContain("研究想法原文已在确认后修改");
    expect(screen.queryByTestId("method-facts-revoke")).toBeNull();
  });

  it("有效事实可填写原因后撤销", async () => {
    vi.mocked(api.getMethodFacts).mockResolvedValue({ status: "valid", sheet, candidates: [] });
    vi.mocked(api.revokeMethodFacts).mockResolvedValue({ status: "revoked", sheet, reasons: ["方法改版"], candidates: [] });
    renderWithProviders(<MethodFactsSection projectId="p-test" />);
    const revoke = await screen.findByTestId("method-facts-revoke");
    expect((revoke as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("撤销原因"), "方法改版");
    await userEvent.click(revoke);
    await waitFor(() => expect(api.revokeMethodFacts).toHaveBeenCalledWith("p-test", "方法改版"));
  });
});
