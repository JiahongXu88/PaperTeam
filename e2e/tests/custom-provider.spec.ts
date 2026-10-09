import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

/**
 * 自定义提供商 + 自动模型发现（M13.4）端到端：
 * 添加 Provider → 输入 Base URL → 输入测试 Key → 获取模型 → 选择模型 →
 * 保存 → 设置默认模型 → 测试连接（真实 Pi completeSimple → mock SSE）。
 *
 * 网关是本地 node:http mock（Anthropic Messages 协议 + OpenAI 风格 /v1/models
 * 目录，即公司网关的真实组合），Key 用合成值，绝不放真实凭据。
 * 结束后恢复原默认模型并删除测试提供商（不留脏状态）。
 */

const MOCK_KEY = "e2e-mock-key-000";

let gateway: Server | null = null;
let gatewayBaseUrl = "";

function sse(res: import("node:http").ServerResponse, text: string): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg_e2e", type: "message", role: "assistant", model: "glm-5.3", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

test.beforeAll(async () => {
  gateway = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const url = (req.url ?? "").split("?")[0] ?? "";
      const authed = req.headers["authorization"] === `Bearer ${MOCK_KEY}`;
      if (url === "/v1/models") {
        if (!authed) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "invalid key" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "glm-5.3", owned_by: "system" }, { id: "glm-5.3-air", owned_by: "system" }] }));
        return;
      }
      if (url === "/v1/messages") {
        if (!authed) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
          return;
        }
        expect(body).toContain("glm-5.3");
        sse(res, "OK");
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => gateway!.listen(0, "127.0.0.1", resolve));
  const address = gateway.address() as { port: number };
  gatewayBaseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => gateway?.close(() => resolve()));
});

const PROVIDER_ID = "e2e-mock-gateway";

test("添加 → 获取模型 → 选择 → 测试连接 → 保存 → 设为默认模型 → 真实调用验证", async ({ page, request }) => {
  test.setTimeout(120_000);

  // 记录原状态，结束时恢复（e2e 打真实本地 Backend，不留脏状态）
  const before = await request.get("/api/settings/model");
  expect(before.ok()).toBe(true);
  const beforeBody = (await before.json()) as { settings: { model?: string; agents?: Record<string, string | null>; visionModel?: string | null } };

  try {
    await page.goto("/settings/model");
    await expect(page.getByTestId("custom-providers")).toBeVisible();

    // 1-3. 服务名称 / API 地址 / API Key
    await page.getByTestId("add-custom-provider").click();
    const form = page.getByTestId("custom-provider-form");
    await expect(form).toBeVisible();
    await expect(page.getByTestId("custom-provider-id")).toHaveValue("保存时自动生成");
    await page.getByTestId("custom-provider-name").fill("E2E Mock Gateway");
    await page.getByTestId("custom-provider-base-url").fill(gatewayBaseUrl);
    await page.getByTestId("custom-provider-api-key").fill(MOCK_KEY);

    // 4-5. 获取可用模型 → 目录出现（mock 只认正确 Bearer）
    await page.getByTestId("discover-models").click();
    const catalog = page.getByTestId("model-catalog");
    await expect(catalog).toBeVisible();
    await expect(page.getByTestId("discovery-status")).toContainText("2 个模型");
    await expect(page.getByTestId("discovery-status")).toContainText("/v1/models");

    // 搜索过滤 + 选择
    await page.getByTestId("model-search").fill("air");
    await expect(page.getByTestId("catalog-model-glm-5.3-air")).toBeVisible();
    await page.getByTestId("model-search").fill("");
    await page.getByTestId("catalog-model-glm-5.3").check();
    await page.getByTestId("catalog-model-glm-5.3-air").check();
    await expect(page.getByTestId("selected-models")).toContainText("已选模型 2 个");

    // 目录未提供上下文窗口 → 保守默认并标记未验证
    await expect(page.getByTestId("selected-models").locator(".badge-unverified").first()).toBeVisible();

    // 7. 保存前测试连接（真实 Pi completeSimple → mock SSE）
    await page.getByTestId("test-custom-provider").click();
    await expect(page.getByTestId("custom-test-result")).toContainText("连接正常", { timeout: 45_000 });

    // 8. 保存
    await page.getByTestId("save-custom-provider").click();
    await expect(form).not.toBeVisible({ timeout: 30_000 });

    // 服务端自动生成的 id 出现在列表；「模型提供商」切到新提供商
    await expect(page.getByTestId(`custom-provider-${PROVIDER_ID}`)).toBeVisible();
    await expect(page.getByTestId("provider-combobox-input")).toHaveValue(new RegExp(PROVIDER_ID));

    // 9. 设置默认模型：选 glm-5.3 并保存
    await page.getByTestId("model-combobox-input").click();
    await page.getByRole("option", { name: /glm-5\.3/ }).first().click();
    await page.getByTestId("save-model").click();
    await expect(page.getByTestId("save-success")).toBeVisible({ timeout: 30_000 });

    // 主面板（真实 Runtime 注册表路径）再测一次连接：验证保存后的注册与凭据
    await page.getByTestId("test-connection").click();
    await expect(page.getByTestId("test-result")).toContainText("连接正常", { timeout: 45_000 });

    // Runtime 侧核验：注册表里有该 provider 的模型目录
    const options = await request.get(`/api/settings/model/options?provider=${PROVIDER_ID}`);
    expect(options.ok()).toBe(true);
    const optionsBody = (await options.json()) as { options: { models: Array<{ modelId: string }> } };
    expect(optionsBody.options.models.map((model) => model.modelId)).toEqual(
      expect.arrayContaining(["glm-5.3", "glm-5.3-air"]),
    );
  } finally {
    // 恢复默认模型偏好 + 删除测试提供商（幂等）。
    // 注意：GET /settings/model 的 agents/vision 是视图对象（非 PUT 载荷形态），
    // 本测试只改默认模型，因此只回放 model 字段（其余字段省略 = 保持现有）。
    if (typeof beforeBody.settings.model === "string" && beforeBody.settings.model !== "") {
      const restored = await request.put("/api/settings/model", {
        data: { model: beforeBody.settings.model },
      });
      expect(restored.ok()).toBe(true);
    }
    await request.delete(`/api/settings/model/custom-providers/${PROVIDER_ID}`);
  }
});
