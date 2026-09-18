import { expect, test } from "./fixtures.js";

/**
 * M7.0 侧栏响应式布局回归：
 * 修复前矮视口（≲700px 高）下 .sidebar-recent 被 flex 收缩为 0 高
 * （min-height:0 取消了自动最小尺寸保护），内容溢出绘制且被底部
 * promo card 遮住，滚动也找不回。修复 = flex-shrink:0 + 滚动兜底。
 *
 * 断言与窗口高度无关：最近项目完整占位、与 promo card 无重叠、
 * 溢出时滚动后全部可见。需要 dev 环境已有 ≥1 个项目（SidebarRecent
 * 无数据时不渲染）。
 */

const HEIGHTS = [900, 700, 560, 480];

test("矮视口下最近项目不被底部 promo card 遮挡（任何窗口高度）", async ({ request, page }) => {
  const response = await request.get("/api/projects?scope=active");
  const body = (await response.json()) as { projects: Array<{ id: string }> };
  test.skip(body.projects.length === 0, "无项目时侧栏不渲染最近项目，跳过");

  for (const height of HEIGHTS) {
    await page.setViewportSize({ width: 1280, height });
    await page.goto("/projects", { waitUntil: "networkidle" });

    const metrics = await page.evaluate(() => {
      const recent = document.querySelector<HTMLElement>(".sidebar-recent");
      const card = document.querySelector<HTMLElement>(".sidebar-brand-card");
      const sidebar = document.querySelector<HTMLElement>(".app-sidebar");
      if (!recent || !card || !sidebar) {
        return null;
      }
      const r = recent.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      // 滚动到最近项目顶部，验证滚动可达
      sidebar.scrollTop = Math.max(0, recent.offsetTop - 20);
      const rAfterScroll = recent.getBoundingClientRect();
      return {
        recentHeight: r.height,
        verticalOverlap: r.bottom - c.top,
        visibleAfterScroll:
          Math.min(rAfterScroll.bottom, window.innerHeight) - Math.max(rAfterScroll.top, 0),
        links: recent.querySelectorAll(".sidebar-recent-link").length,
      };
    });

    expect(metrics, `视口 1280x${height}：侧栏结构完整`).not.toBeNull();
    // 完整占位（不被 flex 收缩；5 个链接 + “更多项目” ≈ 200px+）
    expect(metrics!.recentHeight, `视口 1280x${height}：最近项目高度完整`).toBeGreaterThanOrEqual(150);
    // 与 promo card 无垂直重叠
    expect(metrics!.verticalOverlap, `视口 1280x${height}：与 promo card 零重叠`).toBeLessThanOrEqual(0);
    // 滚动后全部可见
    expect(metrics!.visibleAfterScroll, `视口 1280x${height}：滚动后最近项目完整可见`).toBeGreaterThanOrEqual(
      metrics!.recentHeight - 1,
    );
  }
});
