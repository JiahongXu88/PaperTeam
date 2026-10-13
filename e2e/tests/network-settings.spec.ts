import { expect, test } from "./fixtures.js";

/**
 * M13.8 网络设置页（设置 → 网络设置）浏览器 E2E：
 * - 二级导航可达；表单默认提示 127.0.0.1 / 7890；页面文案声明不影响模型 API；
 * - 保存启用配置 → 状态区显示代理生效；刷新后表单与状态持久（network.json）；
 * - 测试连接 → 逐项结果渲染（真实探测：结果取决于当前网络，断言只看结构与代理项）；
 * - 关闭开关保存 → 回到直连；善后恢复初始状态（隔离 e2e 栈可省略）。
 *
 * 前置：隔离 e2e 栈（docs/BROWSER_ACCEPTANCE.md §5：PAPERTEAM_TEST_RUNTIME=scripted +
 * 独立 PAPERTEAM_RUNTIME_ROOT / PROJECTS_ROOT）。可用 PAPERTEAM_E2E_PROXY_HOST /
 * PAPERTEAM_E2E_PROXY_PORT 指定本机真实代理（缺省 127.0.0.1:7890）；代理不存在时
 * 测试连接应如实显示「代理不可连接」而不是假成功。
 */

const PROXY_HOST = process.env.PAPERTEAM_E2E_PROXY_HOST ?? "127.0.0.1";
const PROXY_PORT = process.env.PAPERTEAM_E2E_PROXY_PORT ?? "7890";

test.describe.serial("M13.8 网络设置", () => {
  test("导航 / 默认提示 / 保存 / 持久化 / 测试连接 / 关闭", async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/settings/model");
    await page.getByTestId("settings-subnav").getByRole("link", { name: "网络设置" }).click();
    await expect(page).toHaveURL(/\/settings\/network$/);
    const form = page.getByTestId("network-form");
    await expect(form).toBeVisible();
    await expect(page.getByText(/不影响模型 API 连接/)).toBeVisible();
    await expect(page.getByTestId("network-host")).toHaveAttribute("placeholder", "127.0.0.1");
    await expect(page.getByTestId("network-port")).toHaveAttribute("placeholder", "7890");

    // 保存启用配置
    const enabled = page.getByTestId("network-enabled");
    if (!(await enabled.isChecked())) {
      await enabled.check();
    }
    await page.getByTestId("network-protocol-http").check();
    await page.getByTestId("network-host").fill(PROXY_HOST);
    await page.getByTestId("network-port").fill(PROXY_PORT);
    await page.getByTestId("network-save").click();
    await expect(page.getByTestId("network-save-success")).toBeVisible();
    await expect(page.getByTestId("network-effective")).toContainText(`http://${PROXY_HOST}:${PROXY_PORT}`);
    await expect(page.getByTestId("network-source")).toContainText("本地保存");

    // 刷新：表单与状态来自 network.json
    await page.reload();
    await expect(page.getByTestId("network-form")).toBeVisible();
    await expect(page.getByTestId("network-enabled")).toBeChecked();
    await expect(page.getByTestId("network-host")).toHaveValue(PROXY_HOST);
    await expect(page.getByTestId("network-port")).toHaveValue(PROXY_PORT);
    await expect(page.getByTestId("network-effective")).toContainText(`http://${PROXY_HOST}:${PROXY_PORT}`);

    // 测试连接：真实探测。结构断言 + 代理项状态只能是「可访问」或「代理不可连接 / 超时」，绝不缺席
    await page.getByTestId("network-test").click();
    const result = page.getByTestId("network-test-result");
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("network-check-proxy")).toBeVisible();
    const proxyStatus = await page.getByTestId("network-check-status-proxy").textContent();
    expect(["可访问", "代理不可连接", "超时"]).toContain((proxyStatus ?? "").trim());
    const checkCount = await page.getByTestId("network-test-checks").locator("li").count();
    expect(checkCount).toBe(6);
    if ((proxyStatus ?? "").trim() === "可访问") {
      // 代理可达时学术项必须被探测（不是 skipped）
      await expect(page.getByTestId("network-check-status-arxiv_pdf")).not.toHaveText("未探测");
    } else {
      await expect(page.getByTestId("network-check-status-arxiv_pdf")).toHaveText("未探测");
    }

    // 关闭开关并保存 → 直连
    await page.getByTestId("network-enabled").uncheck();
    await page.getByTestId("network-save").click();
    await expect(page.getByTestId("network-save-success")).toBeVisible();
    await expect(page.getByTestId("network-effective")).toContainText("直连");
    await expect(page.getByTestId("network-saved")).toContainText("关闭");
  });
});
