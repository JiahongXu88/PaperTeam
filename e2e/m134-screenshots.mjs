import { chromium } from "@playwright/test";

/**
 * M13.4 验收截图：新自定义提供商 UI（亮色 / 暗色 × 列表 / 编辑表单）。
 * 只读操作 + 打开一次编辑表单（不保存、不改任何状态）。
 */
const base = process.env.PAPERTEAM_E2E_BASE_URL ?? "http://localhost:5173";

async function shoot(theme) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await page.addInitScript((value) => {
    window.localStorage.setItem("paperteam.theme", value);
  }, theme);
  await page.goto(`${base}/settings/model`);
  await page.getByTestId("custom-providers").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `docs/research/assets/m13-4-list-${theme}.png`, fullPage: false });

  // 编辑表单（真实保存的公司 GLM 网关）——高级设置默认展开（编辑态）
  await page.getByTestId("edit-glm").click();
  await page.getByTestId("custom-provider-form").waitFor({ state: "visible", timeout: 15_000 });
  // 获取一次模型目录以展示目录区（用已保存凭据，只读不落盘）
  await page.getByTestId("discover-models").click();
  await page.getByTestId("model-catalog").waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `docs/research/assets/m13-4-form-${theme}.png`, fullPage: false });
  await page.keyboard.press("Escape");
  await page.getByTestId("cancel-edit").click().catch(() => {});
  await browser.close();
  console.log(`captured ${theme}`);
}

await shoot("light");
await shoot("dark");
