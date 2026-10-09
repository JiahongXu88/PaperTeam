import { createServer, type Server } from "node:http";

import { expect, test } from "./fixtures.js";

/**
 * M13.5 模型目录展开/收起 + thinking 参数兼容设置（mock 网关，隔离 e2e 栈）：
 * 用户反馈「获取可用模型后目录无法收起」。验证：
 * - 显式收起/展开按钮；再次点击可关闭；Esc 关闭；点击外部关闭；
 * - 收起不丢失搜索词与已选模型；重新获取目录不重置已有选择；
 * - 每模型 thinking 参数（auto / omit）可设置，omit 出现徽标；
 * - 保存后提供商落盘（隔离根，无需善后恢复）。
 */

const MOCK_KEY = "e2e-m135-mock-key";

let gateway: Server | null = null;
let gatewayBaseUrl = "";

function sse(res: import("node:http").ServerResponse, text: string): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg_m135", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
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
        res.end(JSON.stringify({ data: [{ id: "model-alpha", owned_by: "system" }, { id: "model-beta", owned_by: "system" }, { id: "model-gamma", owned_by: "system" }] }));
        return;
      }
      if (url === "/v1/messages") {
        if (!authed) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid key" } }));
          return;
        }
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

test.describe.serial("M13.5 模型目录收起与 thinking 参数", () => {
  test("目录可收起/展开；Esc 与点击外部关闭；选择与搜索不丢失；刷新目录不重置选择", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/settings/model");
    await page.getByTestId("add-custom-provider").click();
    const form = page.getByTestId("custom-provider-form");
    await expect(form).toBeVisible();
    await page.getByTestId("custom-provider-name").fill("M135 Mock Gateway");
    await page.getByTestId("custom-provider-base-url").fill(gatewayBaseUrl);
    await page.getByTestId("custom-provider-api-key").fill(MOCK_KEY);

    // 获取目录 → 自动展开
    await page.getByTestId("discover-models").click();
    const catalog = page.getByTestId("model-catalog");
    await expect(catalog).toBeVisible();
    await expect(page.getByTestId("discovery-status")).toContainText("3 个模型");

    // 选择一个模型；输入搜索词
    await page.getByTestId("catalog-model-model-beta").check();
    await page.getByTestId("model-search").fill("gamma");
    await expect(page.getByTestId("catalog-model-model-beta")).toBeHidden(); // 搜索过滤后不可见

    // 收起 → 目录与搜索框隐藏；已选计数仍在
    await page.getByTestId("toggle-model-catalog").click();
    await expect(catalog).toBeHidden();
    await expect(page.getByTestId("model-search")).toBeHidden();
    await expect(page.getByTestId("model-catalog-block")).toContainText("已选 1 个");
    await expect(page.getByTestId("model-catalog-block")).toContainText("搜索生效中");

    // 重新展开 → 搜索词与选择保留
    await page.getByTestId("toggle-model-catalog").click();
    await expect(catalog).toBeVisible();
    await expect(page.getByTestId("model-search")).toHaveValue("gamma");
    await expect(page.getByTestId("selected-models").locator("details", { hasText: "model-beta" })).toHaveCount(1);

    // 清空搜索；再次获取目录（刷新）→ 已选选择不重置
    await page.getByTestId("model-search").fill("");
    await page.getByTestId("discover-models").click();
    await expect(page.getByTestId("discovery-status")).toContainText("3 个模型");
    await expect(page.getByTestId("selected-models").locator("details", { hasText: "model-beta" })).toHaveCount(1);

    // Esc 关闭（焦点在目录内的搜索框，事件冒泡到目录容器）
    await page.getByTestId("model-search").focus();
    await page.keyboard.press("Escape");
    await expect(catalog).toBeHidden();

    // 重新展开 → 点击目录区域外关闭
    await page.getByTestId("toggle-model-catalog").click();
    await expect(catalog).toBeVisible();
    await page.getByTestId("custom-provider-name").click();
    await expect(catalog).toBeHidden();

    // 保存（带一个选择即可）
    await page.getByTestId("toggle-model-catalog").click();
    await page.getByTestId("catalog-model-model-alpha").check();
    await page.getByTestId("save-custom-provider").click();
    await expect(page.getByTestId("custom-providers-table").locator("td", { hasText: "M135 Mock Gateway" })).toBeVisible({ timeout: 30_000 });
  });

  test("已保存提供商可编辑：thinking 参数改为「不发送」出现徽标，保存成功", async ({ page, request }) => {
    test.setTimeout(120_000);
    await page.goto("/settings/model");
    const row = page.getByTestId("custom-providers-table").locator("tr", { hasText: "M135 Mock Gateway" }).first();
    await row.getByRole("button", { name: "编辑" }).click();
    const form = page.getByTestId("custom-provider-form");
    await expect(form).toBeVisible();

    // 展开已选模型的详情，把 thinking 参数设为 omit
    const modelItem = page.getByTestId("selected-models").locator("details", { hasText: "model-alpha" });
    await modelItem.locator("summary").click();
    await modelItem.getByLabel(/thinking 参数/).selectOption("omit");
    await expect(modelItem.locator("summary")).toContainText("无 thinking");

    await page.getByTestId("save-custom-provider").click();
    await expect(page.getByTestId("custom-providers-table").locator("td", { hasText: "M135 Mock Gateway" })).toBeVisible({ timeout: 30_000 });

    // 落盘验证（隔离根）：保存后的 provider 配置含 thinkingRequest=omit
    const saved = await request.get("/api/settings/model/custom-providers");
    expect(saved.ok()).toBeTruthy();
    const body = (await saved.json()) as { providers: Array<{ models: Array<{ id: string; thinkingRequest?: string }> }> };
    const provider = body.providers.find((entry) => entry.models.some((model) => model.id === "model-alpha"));
    expect(provider?.models.find((model) => model.id === "model-alpha")?.thinkingRequest).toBe("omit");

    // 善后：删除测试提供商（隔离根，仅保持整洁）
    const after = await request.get("/api/settings/model/custom-providers");
    const list = (await after.json()) as { providers: Array<{ id: string }> };
    for (const entry of list.providers) {
      if (entry.id.startsWith("m135-mock")) {
        const removed = await request.delete(`/api/settings/model/custom-providers/${entry.id}`);
        expect(removed.ok()).toBeTruthy();
      }
    }
  });
});
