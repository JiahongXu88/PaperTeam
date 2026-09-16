import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentModelPanel } from "../src/components/settings/AgentModelPanel.js";
import type {
  AgentModelSettingView,
  ModelProviderOptionView,
  ModelSettingsView,
  ModelTestResultView,
} from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M5.7 Agent 独立模型配置面板：
 * - 默认全部「继承默认」并显示实际生效模型；保存按钮禁用（无变更）
 * - 切「自定义」展开 Provider / Model；选择后保存发送完整 agents 映射（null = 继承）
 * - Test Connection 使用该 Agent 当前选择的 provider/model
 * - 保存失败（如运行中 409）显示错误；成功显示提示
 */

vi.mock("../src/api/settings.js", () => ({
  getModelSettings: vi.fn(),
  saveModelSettings: vi.fn(),
  clearModelApiKey: vi.fn(),
  getModelOptions: vi.fn(),
  testModelConnection: vi.fn(),
  getCustomProviders: vi.fn(async () => []),
  saveCustomProvider: vi.fn(),
  deleteCustomProvider: vi.fn(),
}));

const settingsApi = await import("../src/api/settings.js");
const { getModelOptions, saveModelSettings, testModelConnection } = vi.mocked(settingsApi);

function agentView(overrides: Partial<AgentModelSettingView>): AgentModelSettingView {
  return {
    key: "writer",
    effective: "zai-coding-cn/glm-5.3",
    source: "default",
    ...overrides,
  };
}

function baseSettings(agents: AgentModelSettingView[]): ModelSettingsView {
  return {
    provider: "zai-coding-cn",
    modelId: "glm-5.3",
    model: "zai-coding-cn/glm-5.3",
    savedModel: "zai-coding-cn/glm-5.3",
    apiKeyConfigured: true,
    apiKeySource: "stored",
    configurationSource: "stored",
    envOverride: false,
    runtimePhase: "healthy",
    runtimeVersion: "0.84.4",
    modelPhase: "configured",
    modelDetail: "ok",
    detail: "ok",
    agents,
  };
}

const providerList: { providers: ModelProviderOptionView[] } = {
  providers: [
    { id: "zai-coding-cn", name: "Z.AI Coding CN", authConfigured: true, apiKeyLoginSupported: true, modelCount: 2, source: "builtin" },
    { id: "anthropic", name: "Anthropic", authConfigured: false, apiKeyLoginSupported: true, modelCount: 1, source: "builtin" },
  ],
};

const zaiModels = {
  provider: providerList.providers[0]!,
  models: [
    { modelId: "glm-5.3", displayName: "GLM-5.3" },
    { modelId: "glm-5.2", displayName: "GLM-5.2" },
  ],
};

const anthropicModels = {
  provider: providerList.providers[1]!,
  models: [{ modelId: "claude-opus-x", displayName: "Claude Opus X" }],
};

function mockCatalog() {
  getModelOptions.mockImplementation(async (provider?: string) => {
    if (provider === "zai-coding-cn") {
      return zaiModels;
    }
    if (provider === "anthropic") {
      return anthropicModels;
    }
    return providerList;
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

const ALL_KEYS = ["writer", "researcher", "academicReviewer", "factReviewer", "styleReviewer", "citationReviewer"] as const;

describe("AgentModelPanel（M5.7）", () => {
  it("默认全部继承默认并显示实际生效模型；保存按钮禁用（无变更）", async () => {
    mockCatalog();
    renderWithProviders(
      <AgentModelPanel settings={baseSettings(ALL_KEYS.map((key) => agentView({ key })))} />,
      { route: "/settings/model" },
    );
    const panel = await screen.findByTestId("agent-model-panel");
    expect(screen.getByText("Agent 独立模型配置")).toBeInTheDocument();
    for (const key of ALL_KEYS) {
      const mode = within(panel).getByTestId(`agent-model-mode-${key}`) as HTMLSelectElement;
      expect(mode.value).toBe("inherit");
      expect(within(panel).getByTestId(`agent-model-effective-${key}`)).toHaveTextContent(
        "继承默认：zai-coding-cn/glm-5.3",
      );
    }
    expect(screen.getByTestId("save-agent-models")).toBeDisabled();
  });

  it("Writer 切「自定义」→ 选 Provider / Model → 保存发送 agents 映射（writer=spec，其余 null）", async () => {
    mockCatalog();
    saveModelSettings.mockResolvedValue(baseSettings(ALL_KEYS.map((key) => agentView({ key }))));
    const user = userEvent.setup();
    renderWithProviders(
      <AgentModelPanel settings={baseSettings(ALL_KEYS.map((key) => agentView({ key })))} />,
      { route: "/settings/model" },
    );
    const panel = await screen.findByTestId("agent-model-panel");

    await user.selectOptions(within(panel).getByTestId("agent-model-mode-writer"), "custom");
    // 展开后预填默认 provider（zai）；选模型 GLM-5.2
    const modelInput = within(panel).getByTestId("model-combobox-input");
    await waitFor(() => expect(modelInput).toBeEnabled());
    await user.click(modelInput);
    await user.click(await within(panel).findByRole("option", { name: /GLM-5\.2/ }));

    fireEvent.click(screen.getByTestId("save-agent-models"));
    await waitFor(() => expect(saveModelSettings).toHaveBeenCalledTimes(1));
    const payload = saveModelSettings.mock.calls[0]![0];
    expect(payload.model).toBe("zai-coding-cn/glm-5.3");
    expect(payload.agents).toMatchObject({ writer: "zai-coding-cn/glm-5.2" });
    for (const key of ALL_KEYS.filter((entry) => entry !== "writer")) {
      expect(payload.agents).toMatchObject({ [key]: null });
    }
    await screen.findByTestId("agent-model-save-success");
  });

  it("已保存的 override 显示自定义态与独立模型；Test Connection 用该 Agent 的选择", async () => {
    mockCatalog();
    testModelConnection.mockResolvedValue({
      ok: true,
      provider: "anthropic",
      model: "anthropic/claude-opus-x",
      latencyMs: 321,
    } as ModelTestResultView);
    const agents = ALL_KEYS.map((key) =>
      key === "writer"
        ? agentView({
            key,
            override: "anthropic/claude-opus-x",
            overrideProvider: "anthropic",
            overrideModelId: "claude-opus-x",
            effective: "anthropic/claude-opus-x",
            source: "agent_override",
            authConfigured: false,
          })
        : agentView({ key }),
    );
    renderWithProviders(<AgentModelPanel settings={baseSettings(agents)} />, {
      route: "/settings/model",
    });
    const panel = await screen.findByTestId("agent-model-panel");
    const mode = within(panel).getByTestId("agent-model-mode-writer") as HTMLSelectElement;
    expect(mode.value).toBe("custom");
    expect(within(panel).queryByTestId("agent-model-effective-writer")).toBeNull();

    fireEvent.click(within(panel).getByTestId("agent-model-test-writer"));
    await waitFor(() =>
      expect(testModelConnection).toHaveBeenCalledWith({ model: "anthropic/claude-opus-x" }),
    );
    await waitFor(() => expect(panel.textContent).toContain("连接正常："));
    expect(panel.textContent).toContain("anthropic/claude-opus-x");
    // 无凭据提示
    expect(panel.textContent).toContain("尚无可用凭据");
  });

  it("保存失败（运行中 409）显示错误与详情", async () => {
    mockCatalog();
    saveModelSettings.mockRejectedValue(
      Object.assign(new Error("MODEL_CONFIG_BUSY"), {
        status: 409,
        body: { status: "error", error: { code: "MODEL_CONFIG_BUSY", message: "存在在途 Agent Run" } },
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <AgentModelPanel settings={baseSettings(ALL_KEYS.map((key) => agentView({ key })))} />,
      { route: "/settings/model" },
    );
    const panel = await screen.findByTestId("agent-model-panel");
    await user.selectOptions(within(panel).getByTestId("agent-model-mode-researcher"), "custom");
    const modelInput = within(panel).getByTestId("model-combobox-input");
    await waitFor(() => expect(modelInput).toBeEnabled());
    await user.click(modelInput);
    await user.click(await within(panel).findByRole("option", { name: /GLM-5\.3/ }));
    fireEvent.click(screen.getByTestId("save-agent-models"));
    const error = await screen.findByTestId("agent-model-save-error");
    expect(error).toHaveTextContent(/保存失败/);
  });

  it("改回「继承默认」→ 保存发送 null（清除 override）", async () => {
    mockCatalog();
    saveModelSettings.mockResolvedValue(baseSettings(ALL_KEYS.map((key) => agentView({ key }))));
    const user = userEvent.setup();
    const agents = ALL_KEYS.map((key) =>
      key === "citationReviewer"
        ? agentView({
            key,
            override: "zai-coding-cn/glm-5.2",
            overrideProvider: "zai-coding-cn",
            overrideModelId: "glm-5.2",
            effective: "zai-coding-cn/glm-5.2",
            source: "agent_override",
            authConfigured: true,
          })
        : agentView({ key }),
    );
    renderWithProviders(<AgentModelPanel settings={baseSettings(agents)} />, {
      route: "/settings/model",
    });
    const panel = await screen.findByTestId("agent-model-panel");
    await user.selectOptions(within(panel).getByTestId("agent-model-mode-citationReviewer"), "inherit");
    // 继承态显示默认模型（不是过期的 override 值）
    expect(within(panel).getByTestId("agent-model-effective-citationReviewer")).toHaveTextContent(
      "继承默认：zai-coding-cn/glm-5.3",
    );
    fireEvent.click(screen.getByTestId("save-agent-models"));
    await waitFor(() => expect(saveModelSettings).toHaveBeenCalledTimes(1));
    expect(saveModelSettings.mock.calls[0]![0].agents).toMatchObject({
      citationReviewer: null,
    });
  });
});
