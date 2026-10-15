import { defineConfig } from "@playwright/test";

/**
 * M14.3 浏览器级 E2E（Playwright）。
 *
 * 启动方式（服务器 / 本地）：
 *   1. Backend：PAPERTEAM_TEST_RUNTIME=scripted PAPERTEAM_TEST_ALLOW_FIXTURE_ACTOR=1
 *      PAPERTEAM_PORT=3210 PAPERTEAM_HOST=127.0.0.1 PROJECTS_ROOT=<tmp>
 *      PAPERTEAM_DOCLING_PYTHON=<fake-docling> node dist/index.js
 *   2. Frontend：vite（PAPERTEAM_PORT=3210 → /api 代理）
 *
 * 真实性边界：浏览器事件 / HTTP / SSE / 工作流编排 / checkpoint / 文件落盘
 * 全部真实；只有「模型输出」是 scripted（与既有后端 E2E 同族）。解析用
 * 罐头 docling wrapper（内容含 scripted 贡献锚句，保证 verbatim 锚定可复现）。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PAPERTEAM_E2E_BASE_URL ?? "http://127.0.0.1:5173",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "./e2e/.artifacts",
});
