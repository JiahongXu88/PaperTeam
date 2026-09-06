import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { ModelSettingsPage } from "../src/pages/ModelSettingsPage.js";
import type {
  ModelOptionsView,
  ModelSettingsView,
  ModelTestResultView,
} from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M4.3.7.5 Model Settings UI 测试（vi.mock api 层，不发真实请求；
 * 断言 Key 输入永不回填、payload 不携带空 Key、env 覆盖提示、清除确认）。
 */

vi.mock("../src/api/settings.js", () => ({
  getModelSettings: vi.fn(),
  getModelOptions: vi.fn(),
  saveModelSettings: vi.fn(),
  clearModelApiKey: vi.fn(),
  testModelConnection: vi.fn(),
}));

const {
  getModelSettings,
  getModelOptions,
  saveModelSettings,
  clearModelApiKey,
  testModelConnection,
} = await import("../src/api/settings.js");

const storedSettings: ModelSettingsView = {
  provider: "zai-coding-cn",
  model: "zai-coding-cn/glm-5.3",
  savedModel: "zai-coding-cn/glm-5.3",
  apiKeyConfigured: true,
  apiKeySource: "stored",
  configurationSource: "stored",
  envOverride: false,
  runtimePhase: "healthy",
  runtimeVersion: "0.84.4",
  modelPhase: "configured",
  modelDetail: "模型 zai-coding-cn/glm-5.3 已配置",
  detail: "模型配置来自 Settings UI 保存的本地配置。",
};

const providers: ModelOptionsView = {
  providers: [
    { id: "zai-coding-cn", name: "Z.AI Coding CN", authConfigured: true, apiKeyLoginSupported: true, modelCount: 2 },
    { id: "anthropic", name: "Anthropic", authConfigured: false, apiKeyLoginSupported: true, modelCount: 1 },
  ],
};

const zaiModels: ModelOptionsView = {
  provider: providers.providers[0]!,
  models: [
    { modelId: "glm-5.3", displayName: "GLM-5.3", contextWindow: 200000, reasoning: true },
    { modelId: "glm-5.2", displayName: "GLM-5.2", contextWindow: 1000000 },
  ],
};

const anthropicModels: ModelOptionsView = {
  provider: providers.providers[1]!,
  models: [{ modelId: "claude-opus-x", displayName: "Claude Opus X", contextWindow: 200000 }],
};

function mockApi(overrides?: { settings?: Partial<ModelSettingsView> }) {
  vi.mocked(getModelSettings).mockResolvedValue({ ...storedSettings, ...overrides?.settings });
  vi.mocked(getModelOptions).mockImplementation(async (provider?: string) => {
    if (provider === "zai-coding-cn") {
      return zaiModels;
    }
    if (provider === "anthropic") {
      return anthropicModels;
    }
    return providers;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ModelSettingsPage（M4.3.7.5）", () => {
  it("页面加载：渲染当前状态（Runtime/source/model/API Key 已配置）", async () => {
    mockApi();
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    expect(await screen.findByText("Model Settings")).toBeInTheDocument();
    expect(screen.getByText(/Pi 0\.84\.4/)).toBeInTheDocument();
    expect(screen.getByText("本地存储")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-configured")).toHaveTextContent("已配置");
    expect(screen.getByText("zai-coding-cn/glm-5.3")).toBeInTheDocument();
  });

  it("API Key 输入框永不回填：初始为空（type=password）", async () => {
    mockApi();
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });
    const input = await screen.findByTestId("api-key-input");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("type", "password");
    // 已配置提示走文案，不回填值
    expect(screen.getByTestId("api-key-hint")).toHaveTextContent("API Key 已配置");
  });

  it("模型选择 + Save：不输入 Key 时 payload 不携带 apiKey 字段", async () => {
    mockApi();
    vi.mocked(saveModelSettings).mockResolvedValue({ ...storedSettings });
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    // 切换到另一个 provider（真实变更触发模型列表重载）：
    // 先等 provider 选项渲染完成（jsdom 对不存在选项的 select.change 会置空）
    await screen.findByRole("option", { name: /Anthropic/ });
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "anthropic" },
    });
    // 模型列表异步加载：等 Claude 选项出现后再选择
    await screen.findByRole("option", { name: /Claude Opus X/ });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-opus-x" },
    });
    fireEvent.click(screen.getByTestId("save-model"));

    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledWith({ model: "anthropic/claude-opus-x" });
    });
    expect(screen.getByTestId("save-success")).toBeInTheDocument();
  });

  it("输入 Key 后 Save：payload 携带新 Key；成功后清空输入框", async () => {
    mockApi();
    vi.mocked(saveModelSettings).mockResolvedValue({ ...storedSettings });
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    const input = await screen.findByTestId("api-key-input");
    fireEvent.change(input, { target: { value: "sk-test-new-key" } });
    fireEvent.click(screen.getByTestId("save-model"));

    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledWith({
        model: "zai-coding-cn/glm-5.3",
        apiKey: "sk-test-new-key",
      });
    });
    await waitFor(() => {
      expect(input).toHaveValue("");
    });
  });

  it("Save 失败：显示错误状态", async () => {
    mockApi();
    vi.mocked(saveModelSettings).mockRejectedValue(
      new Error("当前有 1 个 Agent Run 正在执行，暂不能变更模型配置"),
    );
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    fireEvent.click(await screen.findByTestId("save-model"));
    expect(await screen.findByTestId("save-error")).toHaveTextContent("暂不能变更模型配置");
  });

  it("Test Connection 成功：显示 OK + 延迟", async () => {
    mockApi();
    const result: ModelTestResultView = {
      ok: true,
      provider: "zai-coding-cn",
      model: "zai-coding-cn/glm-5.3",
      latencyMs: 812,
    };
    vi.mocked(testModelConnection).mockResolvedValue(result);
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    fireEvent.click(await screen.findByTestId("test-connection"));
    expect(await screen.findByTestId("test-result")).toHaveTextContent("Connection OK");
    expect(screen.getByTestId("test-result")).toHaveTextContent("812ms");
    // 未输入 Key → 不携带 apiKey
    expect(testModelConnection).toHaveBeenCalledWith({ model: "zai-coding-cn/glm-5.3" });
  });

  it("Test Connection 失败：显示稳定失败分类", async () => {
    mockApi();
    vi.mocked(testModelConnection).mockResolvedValue({
      ok: false,
      provider: "zai-coding-cn",
      model: "zai-coding-cn/glm-5.3",
      code: "AUTH_FAILED",
      detail: "invalid key",
    });
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    fireEvent.click(await screen.findByTestId("test-connection"));
    expect(await screen.findByTestId("test-result")).toHaveTextContent("认证失败");
  });

  it("Clear Key：需确认；取消不调用，确认后调用并显示结果", async () => {
    mockApi();
    vi.mocked(clearModelApiKey).mockResolvedValue({
      ...storedSettings,
      apiKeyConfigured: false,
      apiKeySource: "none",
    });
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    const clearButton = await screen.findByTestId("clear-key");
    fireEvent.click(clearButton);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(clearModelApiKey).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId("clear-success")).toBeInTheDocument();
  });

  it("Clear Key 取消：不调用 API", async () => {
    mockApi();
    vi.stubGlobal("confirm", vi.fn(() => false));
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    fireEvent.click(await screen.findByTestId("clear-key"));
    expect(clearModelApiKey).not.toHaveBeenCalled();
  });

  it("环境变量覆盖：显示覆盖提示与本地保存值差异", async () => {
    mockApi({
      settings: {
        configurationSource: "environment",
        envOverride: true,
        model: "zai-coding-cn/glm-5.2",
        apiKeySource: "environment",
      },
    });
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    expect(await screen.findByTestId("env-override-note")).toHaveTextContent("环境变量");
    expect(screen.getByText("环境变量")).toBeInTheDocument();
    expect(screen.getByText(/本地保存值/)).toHaveTextContent("glm-5.3");
  });

  it("Key 来源为环境变量时：Clear 按钮禁用（本地无可清除 Key）", async () => {
    mockApi({
      settings: {
        configurationSource: "environment",
        envOverride: true,
        apiKeySource: "environment",
      },
    });
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });
    expect(await screen.findByTestId("clear-key")).toBeDisabled();
  });
});
