import { expect, test } from "./fixtures.js";
import { resolvePdfPath } from "./fixtures.js";

/**
 * 用户完整路径 smoke（真实浏览器 + 运行中的 PaperTeam）：
 *   1. 打开 PaperTeam           2. 创建「从研究想法开始」项目      3. 返回项目列表
 *   4. 导入已有论文（PDF）       5. 快速 Review（模型未配置时给出引导）
 *   6. Review 状态               7. 引用核验                      8. Skills
 *   9. 模型设置                 10. 深色 / 浅色切换 + 刷新保持    11. 归档
 *  12. 设置 → 项目管理          13. 恢复                         14. 再归档
 *  15. 永久删除确认 UI（只对本测试创建的 fixture 项目真正删除）   16. 品牌返回主页
 *
 * 每次运行都创建自己的项目并在结尾清理，可重复执行；不删除用户的其他项目。
 */

const STAMP = `${Date.now().toString(36)}`;
const IDEA_TITLE = `E2E 想法项目 ${STAMP}`;

test.describe.serial("PaperTeam 用户路径 smoke", () => {
  let ideaProjectId = "";
  let importedProjectId = "";

  test("1-3 打开工作台、创建想法项目、返回列表", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole("heading", { name: "论文项目" })).toBeVisible();

    await page.getByRole("link", { name: "新建项目" }).first().click();
    await expect(page.getByRole("heading", { name: "新建项目" })).toBeVisible();
    await page.getByLabel(/论文标题/).fill(IDEA_TITLE);
    await page.getByLabel("研究想法", { exact: true }).fill("E2E：验证从研究想法开始的创建路径。");
    await page.getByRole("button", { name: "创建项目" }).click();

    await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+$/);
    ideaProjectId = page.url().split("/").pop() ?? "";
    await expect(page.getByRole("heading", { name: IDEA_TITLE })).toBeVisible();
    await expect(page.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    // 想法项目没有 Review 标签
    await expect(page.getByRole("tab", { name: "Review" })).toHaveCount(0);

    await page.getByTestId("brand-home").click();
    await expect(page).toHaveURL(/\/projects$/);
    // 列表行 + 侧栏「最近项目」都会出现该标题
    await expect(page.getByTestId("project-card").filter({ hasText: IDEA_TITLE })).toBeVisible();
  });

  test("4-6 导入已有论文 PDF → 快速 Review 页（自动启动后立即取消）", async ({ page, request }) => {
    await page.goto("/projects/new");
    await page.getByRole("radio", { name: /导入已有论文/ }).check();
    await page.getByLabel("选择论文 PDF（.pdf）").setInputFiles(resolvePdfPath());
    await expect(page.getByTestId("goal-review_only")).toHaveClass(/selected/);
    await page.getByRole("button", { name: "导入论文" }).click();

    await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+\?tab=review$/, { timeout: 90_000 });
    importedProjectId = new URL(page.url()).pathname.split("/").pop() ?? "";
    const panel = page.getByTestId("review-panel");
    await expect(panel).toBeVisible();
    // 标题来自 PDF（fixture 为 Attention Is All You Need；真实论文则是其标题），不是文件名占位
    await expect(page.locator("h1.workspace-title")).not.toHaveText(/\.pdf$/);
    // 模型已配置 → 自动开始 Review（阶段清单）；未配置 → 明确引导，不是死胡同
    await expect(panel.getByTestId("review-running").or(panel.getByTestId("review-model-missing")).or(panel.getByTestId("start-review"))).toBeVisible();

    // 自动启动的 Review 会消耗模型额度：smoke 只验证"能启动 + 能取消"，随即取消，
    // 页面应把状态从运行中切到已取消（轮询只在有活跃 run 时进行）
    if (await panel.getByTestId("review-running").isVisible()) {
      const runs = (await (await request.get(`/api/runs?projectId=${importedProjectId}`)).json()) as { runs: Array<{ runId: string; status: string }> };
      const active = runs.runs.find((run) => ["pending", "running", "awaiting_input"].includes(run.status));
      expect(active).toBeDefined();
      const cancelled = await request.post(`/api/runs/${active!.runId}/cancel`);
      expect(cancelled.ok()).toBeTruthy();
      await expect(panel.getByText("已取消", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(panel.getByTestId("start-review")).toBeVisible();
    }

    await page.getByRole("tab", { name: "PDF 与结构" }).click();
    await expect(page.getByRole("heading", { name: "论文结构" })).toBeVisible();
    await expect(page.getByText(/个章节/)).toBeVisible();
  });

  test("7 引用核验：提取是确定性的，无需模型", async ({ page }) => {
    await page.goto(`/projects/${importedProjectId}?tab=citations`);
    const extractButton = page.getByRole("button", { name: /提取引用|重新提取/ });
    await extractButton.click();
    await expect(page.getByRole("heading", { name: "参考文献" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/参考文献 \d+/)).toBeVisible();
    await expect(page.getByRole("button", { name: "核验文献真实性" })).toBeVisible();
  });

  test("8-9 Skills 与模型设置", async ({ page }) => {
    await page.goto("/skills");
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "verify-citations" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Install|Uninstall/ })).toHaveCount(0);

    await page.goto("/settings/model");
    await expect(page.getByRole("heading", { name: "模型设置" })).toBeVisible();
    await expect(page.getByLabel("模型提供商")).toBeVisible();
    await expect(page.getByTestId("api-key-input")).toHaveValue("");
    await expect(page.getByTestId("api-key-input")).toHaveAttribute("type", "password");
  });

  test("10 深色 / 浅色切换，刷新后保持", async ({ page }) => {
    await page.goto("/settings/appearance");
    await page.getByRole("radio", { name: "深色" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("radio", { name: "浅色" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("radio", { name: "跟随系统" }).check();
  });

  test("11-15 归档 → 设置中恢复 → 再归档 → 删除确认（fixture 项目）", async ({ page }) => {
    // 归档想法项目（列表行菜单 + 行内确认）
    await page.goto("/projects");
    const row = page.getByTestId("project-card").filter({ hasText: IDEA_TITLE });
    await row.getByTestId("project-row-menu").click();
    await page.getByRole("menuitem", { name: "归档项目" }).click();
    await row.getByRole("button", { name: "归档" }).click();
    await expect(row).toHaveCount(0);

    // 设置 → 项目管理：恢复
    await page.goto("/settings/projects");
    const table = page.getByTestId("archived-projects-table");
    await expect(table).toContainText(IDEA_TITLE);
    await page.getByTestId(`restore-${ideaProjectId}`).click();
    await expect(table.getByText(IDEA_TITLE)).toHaveCount(0);

    // 再归档（工作区菜单）
    await page.goto(`/projects/${ideaProjectId}`);
    await page.getByTestId("workspace-menu").click();
    await page.getByRole("menuitem", { name: "归档项目" }).click();
    await page.getByRole("button", { name: "归档" }).click();
    await expect(page).toHaveURL(/\/projects$/);

    // 永久删除确认 UI：输入不一致时按钮禁用；一致后才启用；只删本测试创建的项目
    await page.goto("/settings/projects");
    const archivedRow = page.getByTestId("archived-projects-table").locator("tr").filter({ hasText: IDEA_TITLE });
    await archivedRow.getByRole("button", { name: "永久删除" }).click();
    const confirm = page.getByTestId("delete-confirm");
    await expect(confirm).toContainText("永久删除后无法恢复");
    await expect(page.getByTestId("delete-confirm-button")).toBeDisabled();
    await page.getByTestId("delete-confirm-input").fill("不一致的标题");
    await expect(page.getByTestId("delete-confirm-button")).toBeDisabled();
    await page.getByTestId("delete-confirm-input").fill(IDEA_TITLE);
    await expect(page.getByTestId("delete-confirm-button")).toBeEnabled();
    await page.getByTestId("delete-confirm-button").click();
    await expect(page.getByTestId("archived-projects-table").getByText(IDEA_TITLE)).toHaveCount(0);
  });

  test("16 品牌返回主页；清理导入的 fixture 项目", async ({ page, request }) => {
    await page.goto("/skills");
    await page.getByTestId("brand-home").click();
    await expect(page).toHaveURL(/\/projects$/);

    // 清理：导入项目可能仍在 Review（真实论文场景）——先取消活跃 run，再归档 + 删除
    if (importedProjectId !== "") {
      const runs = await request.get(`/api/runs?projectId=${importedProjectId}`);
      for (const run of ((await runs.json()) as { runs: Array<{ runId: string; status: string }> }).runs) {
        if (["pending", "running", "awaiting_input"].includes(run.status)) {
          if (process.env.PAPERTEAM_E2E_KEEP_IMPORTED === "1") {
            return; // 真实论文 Review 跑着：保留项目供人工查看
          }
          await request.post(`/api/runs/${run.runId}/cancel`);
        }
      }
      if (process.env.PAPERTEAM_E2E_KEEP_IMPORTED === "1") {
        return;
      }
      await request.post(`/api/projects/${importedProjectId}/archive`);
      const deleted = await request.delete(`/api/projects/${importedProjectId}`);
      expect(deleted.ok()).toBeTruthy();
    }
  });
});
