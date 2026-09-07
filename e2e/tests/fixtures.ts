import { chromium, test as base, type Browser, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..");

/** 导入路径用的 PDF：真实论文（PAPERTEAM_E2E_PDF）或仓库内 arXiv fixture */
export function resolvePdfPath(): string {
  const fromEnv = process.env.PAPERTEAM_E2E_PDF;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    if (!existsSync(fromEnv)) {
      throw new Error(`PAPERTEAM_E2E_PDF 指向的文件不存在：${fromEnv}`);
    }
    return fromEnv;
  }
  return resolve(repoRoot, "backend", "test", "fixtures", "pdf", "attention.pdf");
}

export const RESOLUTIONS = [
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1100w", width: 1100, height: 800 },
] as const;

export const THEMES = ["light", "dark"] as const;

/** 在 React 挂载前写入主题偏好（与 src/theme/theme.ts 的 key 一致） */
export async function primeTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript((value) => {
    window.localStorage.setItem("paperteam.theme", value);
  }, theme);
}

/**
 * 可选：复用一个已开 remote-debugging 的浏览器（PAPERTEAM_E2E_CDP_URL）。
 * 端口不硬编码；测试结束只断开连接，不关闭用户的浏览器。
 */
export const test = base.extend<{ cdpBrowser: Browser | null }>({
  cdpBrowser: async ({}, use) => {
    const url = process.env.PAPERTEAM_E2E_CDP_URL;
    if (url === undefined || url.trim() === "") {
      await use(null);
      return;
    }
    const browser = await chromium.connectOverCDP(url);
    try {
      await use(browser);
    } finally {
      await browser.close();
    }
  },
  page: async ({ page, cdpBrowser }, use) => {
    if (cdpBrowser === null) {
      await use(page);
      return;
    }
    const context = await cdpBrowser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
    const cdpPage = await context.newPage();
    try {
      await use(cdpPage);
    } finally {
      await context.close();
    }
  },
});

export { expect } from "@playwright/test";
