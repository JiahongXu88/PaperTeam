import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, primeTheme, RESOLUTIONS, test, THEMES } from "./fixtures.js";

/**
 * 视觉走查：主要页面 × 4 种视口 × 浅色 / 深色 截图到 e2e/shots/（gitignore）。
 * 同时做两条硬断言：无水平溢出、深色主题真实生效（不是 filter/invert）。
 *
 * 需要一个已存在的项目；用 PAPERTEAM_E2E_PROJECT_ID 指定，否则取列表第一个（没有则只截无项目页面）。
 */

const SHOTS_DIR = resolve(import.meta.dirname, "..", "shots");

async function firstProjectId(request: Parameters<Parameters<typeof test>[2]>[0]["request"]): Promise<string | null> {
  const fromEnv = process.env.PAPERTEAM_E2E_PROJECT_ID;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const response = await request.get("/api/projects?scope=active");
  const body = (await response.json()) as { projects: Array<{ id: string }> };
  return body.projects[0]?.id ?? null;
}

for (const theme of THEMES) {
  for (const resolution of RESOLUTIONS) {
    test(`视觉走查 ${theme} @ ${resolution.name}`, async ({ page, request }) => {
      mkdirSync(SHOTS_DIR, { recursive: true });
      await primeTheme(page, theme);
      await page.setViewportSize({ width: resolution.width, height: resolution.height });
      const projectId = await firstProjectId(request);

      const routes: Array<{ name: string; path: string }> = [
        { name: "projects", path: "/projects" },
        { name: "new", path: "/projects/new" },
        { name: "skills", path: "/skills" },
        { name: "settings-model", path: "/settings/model" },
        { name: "settings-appearance", path: "/settings/appearance" },
        { name: "settings-projects", path: "/settings/projects" },
        ...(projectId !== null
          ? [
              { name: "project-overview", path: `/projects/${projectId}` },
              { name: "project-pdf", path: `/projects/${projectId}?tab=pdf` },
              { name: "project-citations", path: `/projects/${projectId}?tab=citations` },
              { name: "project-review", path: `/projects/${projectId}?tab=review` },
            ]
          : []),
      ];

      for (const route of routes) {
        await page.goto(route.path, { waitUntil: "networkidle" });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        // 深色主题必须改变真实背景色（不是 CSS filter 反色）
        const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(background).not.toBe("rgba(0, 0, 0, 0)");
        if (theme === "dark") {
          expect(background).not.toBe("rgb(244, 244, 241)");
        }
        // 无水平溢出
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${route.path} 出现水平溢出`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: resolve(SHOTS_DIR, `${theme}-${resolution.name}-${route.name}.png`), fullPage: false });
      }
    });
  }
}
