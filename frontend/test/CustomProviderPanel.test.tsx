import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CustomProviderPanel } from "../src/components/settings/CustomProviderPanel.js";
import type { CustomProviderView, ModelDiscoveryResultView, ModelTestResultView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * 自定义提供商面板（M13.4 新流程）：
 * 服务名称 → API 地址 → API Key → 获取模型 → 选择模型 → 测试连接 → 保存。
 * vi.mock api 层，不发真实请求。
 */

vi.mock("../src/api/settings.js", () => ({
  getCustomProviders: vi.fn(),
  createCustomProvider: vi.fn(),
  saveCustomProvider: vi.fn(),
  deleteCustomProvider: vi.fn(),
  discoverCustomProviderModels: vi.fn(),
  testCustomProviderModel: vi.fn(),
}));

const {
  createCustomProvider,
  saveCustomProvider,
  deleteCustomProvider,
  discoverCustomProviderModels,
  testCustomProviderModel,
} = await import("../src/api/settings.js");

const provider: CustomProviderView = {
  id: "my-gateway",
  name: "My Gateway",
  baseUrl: "https://gw.example.test",
  api: "anthropic-messages",
  authHeader: true,
  headers: { "X-Tenant": "research" },
  models: [
    { id: "claude-x", name: "Claude X", reasoning: false, contextWindow: 200000, maxTokens: 8192, input: ["text"] },
    { id: "haiku-y", name: "Haiku Y", reasoning: true, contextWindow: 100000, maxTokens: 4096, input: ["text", "image"] },
  ],
  updatedAt: "2026-10-09T00:00:00.000Z",
  authConfigured: true,
};

const discovered: ModelDiscoveryResultView = {
  ok: true,
  models: [
    { id: "claude-x", name: "Claude X" },
    { id: "glm-5.3", ownedBy: "zhipu", contextWindow: 128000 },
    { id: "glm-5.3-air", ownedBy: "zhipu", contextWindow: 128000 },
  ],
  sourcePath: "/v1/models",
  total: 3,
  truncated: false,
  authSource: "request",
};

afterEach(() => {
  vi.clearAllMocks();
});

function renderPanel(options?: { providers?: CustomProviderView[] }) {
  renderWithProviders(
    <CustomProviderPanel
      providers={options?.providers ?? []}
      loading={false}
      onSaved={() => {}}
    />,
  );
}

describe("CustomProviderPanel：新建流程", () => {
  it("高级设置默认折叠；新建不出现 Provider ID 输入框（只读显示「保存时自动生成」）", async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    const form = await screen.findByTestId("custom-provider-form");

    // 默认折叠：协议选择器不可见
    expect(screen.queryByLabelText("接口协议")).not.toBeVisible();
    expect(screen.getByTestId("custom-provider-id")).toHaveValue("保存时自动生成");
    expect(form).toHaveTextContent("基本信息");

    // 展开后可见协议与认证选项
    await user.click(screen.getByTestId("advanced-settings").querySelector("summary") as HTMLElement);
    expect(await screen.findByLabelText("接口协议")).toBeVisible();
    expect(screen.getByLabelText("用 Authorization: Bearer 发送 API Key")).toBeChecked();
  });

  it("获取模型：成功 → 分组目录 + 搜索过滤 + 多选 + 取消选择；刷新不清掉已选", async () => {
    vi.mocked(discoverCustomProviderModels).mockResolvedValue(discovered);
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    await user.type(screen.getByLabelText(/API 地址/), "https://api-gateway.example.test");
    await user.type(screen.getByTestId("custom-provider-api-key"), "sk-test");

    await user.click(screen.getByTestId("discover-models"));
    expect(vi.mocked(discoverCustomProviderModels)).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://api-gateway.example.test", api: "anthropic-messages", authHeader: true, apiKey: "sk-test" }),
    );
    const catalog = await screen.findByTestId("model-catalog");
    expect(catalog).toHaveTextContent("zhipu");
    expect(screen.getByTestId("discovery-status")).toHaveTextContent("3 个模型");

    // 搜索过滤
    await user.type(screen.getByTestId("model-search"), "air");
    expect(screen.getByTestId("catalog-model-glm-5.3-air")).toBeInTheDocument();
    expect(screen.queryByTestId("catalog-model-claude-x")).not.toBeInTheDocument();
    await user.clear(screen.getByTestId("model-search"));

    // 多选
    await user.click(screen.getByTestId("catalog-model-claude-x"));
    await user.click(screen.getByTestId("catalog-model-glm-5.3"));
    expect(screen.getByTestId("selected-models")).toHaveTextContent("2");
    // 取消选择
    await user.click(screen.getByTestId("catalog-model-glm-5.3"));
    expect(screen.getByTestId("selected-models")).not.toHaveTextContent("glm-5.3");

    // 再次获取（刷新）：已选模型保留
    await user.click(screen.getByTestId("catalog-model-glm-5.3"));
    await user.click(screen.getByTestId("discover-models"));
    await waitFor(() => expect(vi.mocked(discoverCustomProviderModels).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId("selected-models")).toHaveTextContent("claude-x");
    expect(screen.getByTestId("catalog-model-claude-x")).toBeChecked();
  });

  it("获取模型失败（NOT_SUPPORTED）→ 明确区分「目录不支持」并引导手动添加；手动添加支持去重", async () => {
    vi.mocked(discoverCustomProviderModels).mockResolvedValue({
      ok: false,
      code: "NOT_SUPPORTED",
      detail: "api-gateway.example.test 未提供模型目录接口（尝试了 /v1/models、/models，均返回 404/405）。",
      attemptedPaths: ["/v1/models", "/models"],
      authSource: "request",
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    await user.type(screen.getByLabelText(/API 地址/), "https://api-gateway.example.test");

    await user.click(screen.getByTestId("discover-models"));
    const status = await screen.findByTestId("discovery-status");
    expect(status).toHaveTextContent("未提供模型目录接口");
    expect(status).toHaveTextContent("手动添加");
    // 无目录时不渲染搜索框
    expect(screen.queryByTestId("model-search")).not.toBeInTheDocument();

    // 手动添加 + 重复拒绝
    await user.type(screen.getByTestId("manual-model-id"), "manual-model");
    await user.click(screen.getByTestId("add-manual-model"));
    expect(screen.getByTestId("selected-models")).toHaveTextContent("manual-model");
    expect(screen.getAllByText("未验证").length).toBeGreaterThan(0);

    await user.type(screen.getByTestId("manual-model-id"), "manual-model");
    await user.click(screen.getByTestId("add-manual-model"));
    expect(await screen.findByTestId("custom-provider-error")).toHaveTextContent("已在列表中");
    expect(screen.getByTestId("selected-models").querySelectorAll(".selected-model").length).toBe(1);
  });

  it("编辑场景不传新 Key 时：发现请求不带 apiKey，但带 providerId（Backend 复用已保存凭据）", async () => {
    vi.mocked(discoverCustomProviderModels).mockResolvedValue({ ...discovered, authSource: "stored" });
    renderPanel({ providers: [provider] });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("edit-my-gateway"));

    await user.click(screen.getByTestId("discover-models"));
    await waitFor(() => expect(vi.mocked(discoverCustomProviderModels).mock.calls.length).toBeGreaterThan(0));
    const discoveryCall = vi.mocked(discoverCustomProviderModels).mock.calls[0]![0];
    expect(discoveryCall).toEqual(expect.objectContaining({ providerId: "my-gateway", baseUrl: "https://gw.example.test" }));
    expect(discoveryCall).not.toHaveProperty("apiKey");
    expect(await screen.findByTestId("discovery-status")).toHaveTextContent("使用已保存的 Key");
  });

  it("保存：新建走 createCustomProvider（id 空串）；测试连接成功后可保存", async () => {
    vi.mocked(discoverCustomProviderModels).mockResolvedValue(discovered);
    vi.mocked(testCustomProviderModel).mockResolvedValue({
      ok: true,
      provider: "my-gateway",
      model: "my-gateway/claude-x",
      latencyMs: 123,
    } satisfies ModelTestResultView);
    vi.mocked(createCustomProvider).mockResolvedValue({
      provider,
      settings: {} as never,
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    await user.type(screen.getByLabelText(/服务名称/), "公司 GLM 网关");
    await user.type(screen.getByLabelText(/API 地址/), "https://gw.example.test");
    await user.type(screen.getByTestId("custom-provider-api-key"), "sk-new");
    await user.click(screen.getByTestId("discover-models"));
    await user.click(await screen.findByTestId("catalog-model-claude-x"));

    // 保存前测试连接
    await user.click(screen.getByTestId("test-custom-provider"));
    expect(await screen.findByTestId("custom-test-result")).toHaveTextContent("连接正常");
    expect(vi.mocked(testCustomProviderModel)).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "claude-x", apiKey: "sk-new" }),
    );

    await user.click(screen.getByTestId("save-custom-provider"));
    await waitFor(() => {
      expect(vi.mocked(createCustomProvider)).toHaveBeenCalledWith({
        provider: expect.objectContaining({ id: "", name: "公司 GLM 网关", baseUrl: "https://gw.example.test" }),
        apiKey: "sk-new",
      });
    });
    await waitFor(() => expect(screen.queryByTestId("custom-provider-form")).not.toBeInTheDocument());
  });

  it("保存失败（id 冲突等后端错误）→ 显示错误且表单保留输入", async () => {
    vi.mocked(createCustomProvider).mockRejectedValue(new Error("id 与已有提供商冲突"));
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    await user.type(screen.getByLabelText(/服务名称/), "X");
    await user.type(screen.getByLabelText(/API 地址/), "https://x.example.test");
    await user.type(screen.getByTestId("manual-model-id"), "m1");
    await user.click(screen.getByTestId("add-manual-model"));
    await user.click(screen.getByTestId("save-custom-provider"));
    expect(await screen.findByTestId("custom-provider-error")).toHaveTextContent("id 与已有提供商冲突");
    expect(screen.getByTestId("custom-provider-form")).toBeInTheDocument();
  });
});

describe("CustomProviderPanel：编辑流程", () => {
  it("编辑回填：Key 不回显、模型与技术字段保留、PUT 保持 id；留空保存不携带 apiKey", async () => {
    vi.mocked(saveCustomProvider).mockResolvedValue({ provider, settings: {} as never });
    renderPanel({ providers: [provider] });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("edit-my-gateway"));

    expect(screen.getByTestId("custom-provider-api-key")).toHaveValue("");
    expect(screen.getByTestId("custom-provider-id")).toHaveValue("my-gateway");
    expect(screen.getByTestId("custom-provider-id")).toHaveAttribute("readonly");
    expect(screen.getByTestId("selected-models")).toHaveTextContent("claude-x");
    expect(screen.getByTestId("selected-models")).toHaveTextContent("haiku-y");
    // 编辑时高级设置默认展开，额外请求头已回填
    expect(screen.getByLabelText("额外请求头（可选）")).toHaveValue("X-Tenant: research");

    await user.click(screen.getByTestId("save-custom-provider"));
    await waitFor(() => {
      expect(vi.mocked(saveCustomProvider)).toHaveBeenCalledWith({
        provider: expect.objectContaining({
          id: "my-gateway",
          headers: { "X-Tenant": "research" },
          models: expect.arrayContaining([expect.objectContaining({ id: "haiku-y", reasoning: true, input: ["text", "image"] })]),
        }),
      });
    });
  });

  it("删除：行内确认；确认后调用删除并携带 id", async () => {
    vi.mocked(deleteCustomProvider).mockResolvedValue({} as never);
    renderPanel({ providers: [provider] });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("delete-my-gateway"));
    expect(vi.mocked(deleteCustomProvider)).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("confirm-delete-my-gateway"));
    await waitFor(() => expect(vi.mocked(deleteCustomProvider)).toHaveBeenCalledWith("my-gateway"));
  });
});

describe("CustomProviderPanel：模型详情与元数据", () => {
  it("展开模型详情：编辑上下文窗口后「未验证」标记消失且 payload 带 metadataVerified", async () => {
    vi.mocked(discoverCustomProviderModels).mockResolvedValue(discovered);
    vi.mocked(createCustomProvider).mockResolvedValue({ provider, settings: {} as never });
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    await user.type(screen.getByLabelText(/服务名称/), "G");
    await user.type(screen.getByLabelText(/API 地址/), "https://g.example.test");
    await user.click(screen.getByTestId("discover-models"));
    await user.click(await screen.findByTestId("catalog-model-claude-x"));

    const detail = screen.getByTestId("selected-models").querySelector(".selected-model") as HTMLDetailsElement;
    await user.click(detail.querySelector("summary") as HTMLElement);
    const contextInput = await screen.findByLabelText("上下文窗口");
    expect(contextInput).toHaveValue("200000");

    await user.clear(contextInput);
    await user.type(contextInput, "128000");
    expect(screen.queryByText("未验证")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("save-custom-provider"));
    await waitFor(() => {
      expect(vi.mocked(createCustomProvider)).toHaveBeenCalledWith({
        provider: expect.objectContaining({
          models: [expect.objectContaining({ id: "claude-x", contextWindow: 128000, metadataVerified: true })],
        }),
      });
    });
  });

  it("目录返回带上下文的模型：数值来自上游，不标记未验证", async () => {
    vi.mocked(discoverCustomProviderModels).mockResolvedValue(discovered);
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    await user.type(screen.getByLabelText(/API 地址/), "https://g.example.test");
    await user.click(screen.getByTestId("discover-models"));
    await screen.findByTestId("model-catalog");

    await user.click(screen.getByTestId("catalog-model-glm-5.3"));
    const summary = screen.getByTestId("selected-models").querySelector(".selected-model summary") as HTMLElement;
    expect(summary.textContent).toContain("glm-5.3");
    // glm-5.3 带上游 contextWindow → 无「未验证」徽标；claude-x 未选
    expect(summary.textContent).not.toContain("未验证");
  });

  it("键盘可用：手动添加输入框回车等价于点击添加", async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    await user.type(screen.getByTestId("manual-model-id"), "kbd-model{Enter}");
    expect(screen.getByTestId("selected-models")).toHaveTextContent("kbd-model");
  });

  it("空目录状态：显示明确空态与手动引导", async () => {
    vi.mocked(discoverCustomProviderModels).mockResolvedValue({
      ok: true,
      models: [],
      sourcePath: "/v1/models",
      total: 0,
      truncated: false,
      authSource: "none",
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    await user.type(screen.getByLabelText(/API 地址/), "https://empty.example.test");
    await user.click(screen.getByTestId("discover-models"));
    expect(await screen.findByTestId("model-catalog")).toHaveTextContent("目录为空");
    expect(screen.getByTestId("no-models-hint")).toBeInTheDocument();
  });

  it("获取前未填地址：本地提示且不发请求", async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    await user.click(screen.getByTestId("discover-models"));
    expect(await screen.findByTestId("custom-provider-error")).toHaveTextContent("请先填写 API 地址");
    expect(vi.mocked(discoverCustomProviderModels)).not.toHaveBeenCalled();
  });

  it("测试连接失败：分类文案 + 详细信息折叠", async () => {
    vi.mocked(testCustomProviderModel).mockResolvedValue({
      ok: false,
      provider: "my-gateway",
      model: "my-gateway/m1",
      code: "AUTH_FAILED",
      detail: "401 invalid api key",
    } satisfies ModelTestResultView);
    vi.mocked(discoverCustomProviderModels).mockResolvedValue(discovered);
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("add-custom-provider"));
    await user.type(screen.getByLabelText(/API 地址/), "https://g.example.test");
    await user.click(screen.getByTestId("discover-models"));
    await user.click(await screen.findByTestId("catalog-model-claude-x"));
    await user.click(screen.getByTestId("test-custom-provider"));
    const result = await screen.findByTestId("custom-test-result");
    expect(result).toHaveTextContent("API Key 无效或认证失败");
    fireEvent.click(result.querySelector("summary") as HTMLElement);
    expect(result).toHaveTextContent("401 invalid api key");
  });
});
