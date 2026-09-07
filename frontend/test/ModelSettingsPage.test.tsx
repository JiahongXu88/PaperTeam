import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ModelSettingsPage } from "../src/pages/ModelSettingsPage.js";
import type {
  ModelOptionsView,
  ModelSettingsView,
  ModelTestResultView,
} from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * 模型设置页测试（M4.3.7.5 / UX Polish 2026-09；vi.mock api 层，不发真实请求）。
 *
 * 断言 Key 输入永不回填、payload 不携带空 Key、env 覆盖提示、清除确认、
 * 模型搜索选择器（筛选 / 键盘 / 截断提示），以及 modelId 含「/」的回归：
 * openrouter/anthropic/claude-sonnet-4 重新加载后仍选中完整 modelId。
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
  modelDetail: "模型 zai-coding-cn/glm-5.3 已配置",
  detail: "模型配置来自设置页保存的本地配置。",
};

const providers: ModelOptionsView = {
  providers: [
    { id: "zai-coding-cn", name: "Z.AI Coding CN", authConfigured: true, apiKeyLoginSupported: true, modelCount: 2 },
    { id: "anthropic", name: "Anthropic", authConfigured: false, apiKeyLoginSupported: true, modelCount: 1 },
    { id: "openrouter", name: "OpenRouter", authConfigured: false, apiKeyLoginSupported: true, modelCount: 2 },
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

/** openrouter 的 modelId 本身含「/」（Pi 注册表真实形态） */
const openrouterModels: ModelOptionsView = {
  provider: providers.providers[2]!,
  models: [
    { modelId: "anthropic/claude-sonnet-4", displayName: "Claude Sonnet 4", contextWindow: 200000 },
    { modelId: "openai/gpt-5.2", displayName: "GPT-5.2", contextWindow: 400000 },
  ],
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
    if (provider === "openrouter") {
      return openrouterModels;
    }
    return providers;
  });
}

/** 打开模型搜索选择器并点选一个选项（按 displayName 匹配）；等模型目录就绪 */
async function selectModel(user: ReturnType<typeof userEvent.setup>, optionPattern: RegExp) {
  const input = await screen.findByTestId("model-combobox-input");
  await waitFor(() => expect(input).toBeEnabled());
  await user.click(input);
  const option = await screen.findByRole("option", { name: optionPattern });
  await user.click(option);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ModelSettingsPage", () => {
  it("页面加载：渲染当前状态（Runtime/来源/模型/API Key 已配置）", async () => {
    mockApi();
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    expect(await screen.findByText("模型设置")).toBeInTheDocument();
    expect(await screen.findByText(/Pi 0\.84\.4/)).toBeInTheDocument();
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

  it("modelId 含「/」回归：openrouter 重新加载后正确选中完整 modelId", async () => {
    mockApi({
      settings: {
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4",
        model: "openrouter/anthropic/claude-sonnet-4",
        savedModel: "openrouter/anthropic/claude-sonnet-4",
      },
    });
    vi.mocked(saveModelSettings).mockResolvedValue({ ...storedSettings });
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    // 种子值来自后端 DTO 的 provider/modelId 字段（前端不 split 猜测）
    await waitFor(() =>
      expect(screen.getByTestId("model-combobox-input")).toHaveValue("Claude Sonnet 4"),
    );
    expect((screen.getByLabelText("模型提供商") as HTMLSelectElement).value).toBe("openrouter");

    // 不重新选模型直接保存：payload 是完整 spec（provider + 含斜杠 modelId）
    fireEvent.click(screen.getByTestId("save-model"));
    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledWith({
        model: "openrouter/anthropic/claude-sonnet-4",
      });
    });
  });

  it("切换 Provider 并经搜索选择器选模型：Save 不携带空 apiKey 字段", async () => {
    mockApi();
    vi.mocked(saveModelSettings).mockResolvedValue({ ...storedSettings });
    const user = userEvent.setup();
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    await screen.findByText("模型设置");
    // 先等 provider 选项渲染（jsdom 对不存在选项的 select.change 会置空）
    await screen.findByRole("option", { name: /Anthropic/ });
    await user.selectOptions(screen.getByLabelText("模型提供商"), "anthropic");
    await selectModel(user, /Claude Opus X/);
    fireEvent.click(screen.getByTestId("save-model"));

    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledWith({ model: "anthropic/claude-opus-x" });
    });
    expect(screen.getByTestId("save-success")).toBeInTheDocument();
  });

  it("搜索选择器：输入过滤 modelId/displayName，无匹配显示空态", async () => {
    mockApi({ settings: { provider: "zai-coding-cn", modelId: "glm-5.3", model: "zai-coding-cn/glm-5.3" } });
    const user = userEvent.setup();
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    const input = await screen.findByTestId("model-combobox-input");
    await user.click(input);
    // 默认展开全部选项
    expect(await screen.findByRole("option", { name: /GLM-5\.3/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /GLM-5\.2/ })).toBeInTheDocument();

    // 按 displayName 片段过滤
    await user.type(input, "5.2");
    expect(await screen.findByRole("option", { name: /GLM-5\.2/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GLM-5\.3（/ })).not.toBeInTheDocument();

    // 无匹配 → 空态提示
    await user.clear(input);
    await user.type(input, "不存在的模型");
    expect(await screen.findByText(/没有匹配/)).toBeInTheDocument();
  });

  it("搜索选择器：键盘 ↑↓ + Enter 选择", async () => {
    mockApi({ settings: { provider: "zai-coding-cn", modelId: "glm-5.3", model: "zai-coding-cn/glm-5.3" } });
    vi.mocked(saveModelSettings).mockResolvedValue({ ...storedSettings });
    const user = userEvent.setup();
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    const input = await screen.findByTestId("model-combobox-input");
    await user.click(input);
    // 展开时高亮从当前选中项（GLM-5.3，第 0 项）出发；↓ 移到 GLM-5.2，Enter 选中
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("model-combobox-input")).toHaveValue("GLM-5.2"),
    );
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

  it("Save 失败（MODEL_CONFIG_BUSY）：显示中文转换后的错误", async () => {
    mockApi();
    const { ApiError } = await import("../src/api/client.js");
    vi.mocked(saveModelSettings).mockRejectedValue(
      new ApiError(409, "MODEL_CONFIG_BUSY", "当前有 1 个 Agent Run 正在执行，暂不能变更模型配置"),
    );
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    fireEvent.click(await screen.findByTestId("save-model"));
    expect(await screen.findByTestId("save-error")).toHaveTextContent("等待任务结束");
  });

  it("测试连接成功：显示连接正常 + 延迟", async () => {
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
    expect(await screen.findByTestId("test-result")).toHaveTextContent("连接正常");
    expect(screen.getByTestId("test-result")).toHaveTextContent("812ms");
    // 未输入 Key → 不携带 apiKey
    expect(testModelConnection).toHaveBeenCalledWith({ model: "zai-coding-cn/glm-5.3" });
  });

  it("测试连接失败：显示稳定失败分类的中文文案", async () => {
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
    expect(await screen.findByTestId("test-result")).toHaveTextContent("API Key 无效或认证失败");
  });

  it("清除 Key：需确认；取消不调用，确认后调用并显示结果", async () => {
    mockApi();
    vi.mocked(clearModelApiKey).mockResolvedValue({
      ...storedSettings,
      apiKeyConfigured: false,
      apiKeySource: "none",
    });
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    const clearButton = await screen.findByTestId("clear-key");
    expect(clearButton).toHaveTextContent("清除已保存的 API Key");
    fireEvent.click(clearButton);
    // 行内确认（不用系统 confirm 弹窗）
    fireEvent.click(await screen.findByTestId("clear-key-confirm"));
    await waitFor(() => {
      expect(clearModelApiKey).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId("clear-success")).toBeInTheDocument();
  });

  it("清除 Key 取消：不调用 API", async () => {
    mockApi();
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    fireEvent.click(await screen.findByTestId("clear-key"));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(clearModelApiKey).not.toHaveBeenCalled();
    expect(await screen.findByTestId("clear-key")).toBeInTheDocument();
  });

  it("环境变量覆盖：显示覆盖提示与本地保存值差异", async () => {
    mockApi({
      settings: {
        configurationSource: "environment",
        envOverride: true,
        model: "zai-coding-cn/glm-5.2",
        modelId: "glm-5.2",
        apiKeySource: "environment",
      },
    });
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });

    expect(await screen.findByTestId("env-override-note")).toHaveTextContent("环境变量");
    expect(screen.getByText("环境变量")).toBeInTheDocument();
    expect(screen.getByText(/本地保存值/)).toHaveTextContent("glm-5.3");
  });

  it("Key 来源为环境变量时：清除按钮禁用（本地无可清除 Key）", async () => {
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

  it("危险操作区：中文标题与说明", async () => {
    mockApi();
    renderWithProviders(<ModelSettingsPage />, { route: "/settings/model" });
    expect(await screen.findByText("危险操作")).toBeInTheDocument();
    expect(screen.getByText("清除本地保存的 API Key")).toBeInTheDocument();
  });
});
