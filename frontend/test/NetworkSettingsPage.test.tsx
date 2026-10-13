import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NetworkSettingsPage } from "../src/pages/NetworkSettingsPage.js";
import type { NetworkSettingsView, NetworkTestResultView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * 网络设置页测试（M13.8；vi.mock api 层，不发真实请求）。
 *
 * 断言：状态区如实展示直连 / 代理 / 来源；表单默认提示 127.0.0.1 / 7890；保存 payload
 * 形状（enabled / protocol / host / port 数字）；env 覆盖提示；测试连接结果逐项渲染
 * （含限流说明）；端口非法时禁用按钮并提示；页面文案声明「不影响模型 API」。
 */

vi.mock("../src/api/network.js", () => ({
  getNetworkSettings: vi.fn(),
  saveNetworkSettings: vi.fn(),
  testNetworkSettings: vi.fn(),
}));

const { getNetworkSettings, saveNetworkSettings, testNetworkSettings } = await import("../src/api/network.js");

const baseScope = {
  appliesTo: ["学术检索（OpenAlex / arXiv / Semantic Scholar / AMiner）", "合法开放获取全文 PDF 下载（FullTextResolver）"],
  notAppliedTo: ["模型 API 请求（Pi Runtime / 公司模型网关 / 自定义模型 Provider）", "本机 PaperTeam HTTP API"],
  bypass: "回环 / 私网 / 单标签主机名（如本机 SearXNG）始终直连",
};

const directSettings: NetworkSettingsView = {
  effective: null,
  source: "none",
  envOverride: false,
  saved: null,
  scope: baseScope,
  routerStats: { proxied: 0, direct: 3, bypassed: 0, retiring: 0 },
};

const proxySettings: NetworkSettingsView = {
  effective: { protocol: "http", host: "127.0.0.1", port: 7890 },
  effectiveUrl: "http://127.0.0.1:7890",
  source: "stored",
  envOverride: false,
  saved: { enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 },
  savedAt: "2026-10-13T08:00:00.000Z",
  scope: baseScope,
  routerStats: { proxied: 12, direct: 0, bypassed: 2, retiring: 0 },
};

const testResult: NetworkTestResultView = {
  ok: true,
  mode: "proxy",
  proxy: "http://127.0.0.1:7890",
  checkedAt: "2026-10-13T08:00:00.000Z",
  durationMs: 4200,
  summary: "代理 http://127.0.0.1:7890：3/5 项学术服务可访问；arXiv PDF 约 1900KB/s；限流：OpenAlex / Semantic Scholar（与代理无关）",
  checks: [
    { id: "proxy", label: "代理可连接性", target: "http://127.0.0.1:7890", status: "ok", latencyMs: 3, detail: "代理端口可连接（3ms）" },
    { id: "arxiv_api", label: "arXiv API（检索）", target: "export.arxiv.org", status: "ok", httpStatus: 200, latencyMs: 2700, detail: "可访问（2700ms）" },
    { id: "arxiv_pdf", label: "arXiv PDF 下载（首段）", target: "arxiv.org", status: "ok", httpStatus: 200, latencyMs: 1600, firstByteMs: 1400, bytes: 262144, throughputKBps: 1900, detail: "PDF 头合法；首字节 1400ms，首 256KB 约 1900KB/s" },
    { id: "openalex", label: "OpenAlex（检索 / 元数据）", target: "api.openalex.org", status: "rate_limited", httpStatus: 429, retryAfterSeconds: 59493, detail: "匿名额度已用尽（按出口 IP 计），约 17 小时后重置；与代理无关，可申请免费 OpenAlex API Key" },
    { id: "semantic_scholar", label: "Semantic Scholar（检索 / 元数据）", target: "api.semanticscholar.org", status: "rate_limited", httpStatus: 429, detail: "匿名限流；可配置 PAPERTEAM_SEMANTIC_SCHOLAR_API_KEY" },
    { id: "crossref", label: "Crossref（引用元数据）", target: "api.crossref.org", status: "ok", httpStatus: 200, latencyMs: 2200, detail: "可访问（2200ms）" },
  ],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("NetworkSettingsPage", () => {
  it("直连初态：状态区显示直连 / 未配置；表单默认提示 127.0.0.1 与 7890；文案声明不影响模型 API", async () => {
    vi.mocked(getNetworkSettings).mockResolvedValue(directSettings);
    renderWithProviders(<NetworkSettingsPage />, { route: "/settings/network" });
    await screen.findByTestId("network-form");
    expect(screen.getByTestId("network-effective")).toHaveTextContent("直连");
    expect(screen.getByTestId("network-source")).toHaveTextContent("未配置");
    expect(screen.getByTestId("network-enabled")).not.toBeChecked();
    expect(screen.getByTestId("network-host")).toHaveAttribute("placeholder", "127.0.0.1");
    expect(screen.getByTestId("network-port")).toHaveAttribute("placeholder", "7890");
    expect(screen.getByText(/不影响模型 API 连接/)).toBeInTheDocument();
    expect(screen.getByText(/模型 API 请求/)).toBeInTheDocument();
  });

  it("保存：enabled + host + port（数字）发往 Backend；成功后显示提示并刷新状态", async () => {
    vi.mocked(getNetworkSettings).mockResolvedValueOnce(directSettings).mockResolvedValue(proxySettings);
    vi.mocked(saveNetworkSettings).mockResolvedValue(proxySettings);
    const user = userEvent.setup();
    renderWithProviders(<NetworkSettingsPage />, { route: "/settings/network" });
    await screen.findByTestId("network-form");
    await user.click(screen.getByTestId("network-enabled"));
    await user.type(screen.getByTestId("network-host"), "127.0.0.1");
    await user.type(screen.getByTestId("network-port"), "7890");
    await user.click(screen.getByTestId("network-save"));
    await waitFor(() => expect(saveNetworkSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveNetworkSettings).mock.calls[0]![0]).toEqual({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 });
    await screen.findByTestId("network-save-success");
    await waitFor(() => expect(screen.getByTestId("network-effective")).toHaveTextContent("http://127.0.0.1:7890"));
    expect(screen.getByTestId("network-saved")).toHaveTextContent("启用 · http://127.0.0.1:7890");
  });

  it("端口非法：禁用保存 / 测试并提示；关闭开关时不要求地址", async () => {
    vi.mocked(getNetworkSettings).mockResolvedValue(directSettings);
    const user = userEvent.setup();
    renderWithProviders(<NetworkSettingsPage />, { route: "/settings/network" });
    await screen.findByTestId("network-form");
    expect(screen.getByTestId("network-save")).toBeEnabled(); // 关闭状态直接可保存（= 直连）
    await user.click(screen.getByTestId("network-enabled"));
    expect(screen.getByTestId("network-save")).toBeDisabled(); // 启用但地址为空
    await user.type(screen.getByTestId("network-host"), "127.0.0.1");
    await user.type(screen.getByTestId("network-port"), "99999");
    expect(screen.getByRole("alert")).toHaveTextContent("1–65535");
    expect(screen.getByTestId("network-save")).toBeDisabled();
    expect(screen.getByTestId("network-test")).toBeDisabled();
  });

  it("测试连接：用表单值发起；逐项渲染状态与限流说明；摘要可见", async () => {
    vi.mocked(getNetworkSettings).mockResolvedValue(proxySettings);
    vi.mocked(testNetworkSettings).mockResolvedValue(testResult);
    const user = userEvent.setup();
    renderWithProviders(<NetworkSettingsPage />, { route: "/settings/network" });
    await screen.findByTestId("network-form");
    expect(screen.getByTestId("network-enabled")).toBeChecked();
    expect(screen.getByTestId("network-host")).toHaveValue("127.0.0.1");
    expect(screen.getByTestId("network-port")).toHaveValue("7890");
    await user.click(screen.getByTestId("network-test"));
    await waitFor(() => expect(testNetworkSettings).toHaveBeenCalledWith({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 }));
    const result = await screen.findByTestId("network-test-result");
    expect(result).toHaveTextContent("3/5 项学术服务可访问");
    expect(screen.getByTestId("network-check-status-arxiv_pdf")).toHaveTextContent("可访问");
    expect(screen.getByTestId("network-check-status-openalex")).toHaveTextContent("限流");
    expect(screen.getByTestId("network-check-openalex")).toHaveTextContent("与代理无关");
    expect(screen.getByTestId("network-check-arxiv_pdf")).toHaveTextContent("1900 KB/s");
    expect(screen.getByTestId("network-check-status-proxy")).toHaveTextContent("可访问");
  });

  it("env 覆盖：显示提示；保存成功提示说明环境变量优先", async () => {
    const envSettings: NetworkSettingsView = {
      ...proxySettings,
      source: "environment",
      envOverride: true,
      effective: { protocol: "socks5", host: "10.0.0.2", port: 1080 },
      effectiveUrl: "socks5://10.0.0.2:1080",
    };
    vi.mocked(getNetworkSettings).mockResolvedValue(envSettings);
    vi.mocked(saveNetworkSettings).mockResolvedValue(envSettings);
    const user = userEvent.setup();
    renderWithProviders(<NetworkSettingsPage />, { route: "/settings/network" });
    await screen.findByTestId("network-form");
    expect(screen.getByTestId("network-env-override")).toBeInTheDocument();
    expect(screen.getByTestId("network-source")).toHaveTextContent("PAPERTEAM_RESEARCH_PROXY_URL");
    await user.click(screen.getByTestId("network-save"));
    await screen.findByTestId("network-save-success");
    expect(screen.getByTestId("network-save-success")).toHaveTextContent("环境变量为准");
  });

  it("代理不可连接的测试结果：显示未探测项与失败说明", async () => {
    vi.mocked(getNetworkSettings).mockResolvedValue(proxySettings);
    vi.mocked(testNetworkSettings).mockResolvedValue({
      ok: false,
      mode: "proxy",
      proxy: "http://127.0.0.1:7899",
      checkedAt: "2026-10-13T08:00:00.000Z",
      durationMs: 20,
      summary: "代理 http://127.0.0.1:7899 不可连接，学术服务探测已跳过",
      checks: [
        { id: "proxy", label: "代理可连接性", target: "http://127.0.0.1:7899", status: "proxy_unreachable", latencyMs: 2, detail: "代理端口拒绝连接：请确认代理软件已启动且端口正确" },
        { id: "arxiv_api", label: "arXiv API（检索）", target: "export.arxiv.org", status: "skipped", detail: "代理不可连接，未探测" },
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<NetworkSettingsPage />, { route: "/settings/network" });
    await screen.findByTestId("network-form");
    await user.click(screen.getByTestId("network-test"));
    const result = await screen.findByTestId("network-test-result");
    expect(result).toHaveTextContent("不可连接");
    expect(screen.getByTestId("network-check-status-proxy")).toHaveTextContent("代理不可连接");
    expect(screen.getByTestId("network-check-status-arxiv_api")).toHaveTextContent("未探测");
    expect(screen.getByTestId("network-check-proxy")).toHaveTextContent("代理软件已启动");
  });
});
