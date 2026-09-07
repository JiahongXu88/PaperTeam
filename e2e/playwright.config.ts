import { defineConfig } from "@playwright/test";

/**
 * PaperTeam 浏览器级 E2E（仅测试工具，不进入产品代码）。
 *
 * 前置：`npm run dev` 已启动（Backend :3000 + Vite :5173）。
 *   PAPERTEAM_E2E_BASE_URL   前端地址（默认 http://localhost:5173）
 *   PAPERTEAM_E2E_PDF        用真实论文 PDF 跑导入 / Review 路径（默认用仓库内 fixture）
 *   PAPERTEAM_E2E_CDP_URL    已有浏览器的 DevTools 地址（如 http://127.0.0.1:9222）：
 *                            设置后经 connectOverCDP 复用该浏览器，不再自行启动
 *   PAPERTEAM_E2E_HEADLESS   "0" 时有头运行
 *
 * 浏览器：默认用本机已安装的 Chrome（channel: "chrome"），不需要下载 Playwright 浏览器。
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "report", open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.PAPERTEAM_E2E_BASE_URL ?? "http://localhost:5173",
    channel: "chrome",
    headless: process.env.PAPERTEAM_E2E_HEADLESS !== "0",
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
