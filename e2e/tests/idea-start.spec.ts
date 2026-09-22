import { expect, test } from "./fixtures.js";

/**
 * M9.1 E2E Activation Foundation：idea_to_paper 的 UI 启动入口。
 *
 * 此前 idea_to_paper run 只能经 API 创建（createWorkflowRun 的全部前端调用点
 * 都是 existing 系列）——浏览器用户建完 idea 项目后无按钮可点。本用例验证：
 *   1. idea 项目侧栏出现「生成论文」区块与「开始生成论文」入口；
 *   2. 模型未配置 → 入口禁用并给出设置引导（无模型栈的可达终点）；
 *      模型已配置 → 点击真实创建 idea_to_paper run，入口切换为「查看任务进度」；
 *   3. 工作流实时视图可见后立即取消（不消耗完整 run 的模型预算）。
 *      取消是协作式（等待在途模型调用 settle，真实模型下可能超过 90s）：
 *      UI 断言「正在取消…」确认取消信号，终态以后端 API 权威轮询收口
 *      （run 终态后才清理项目，避免 PROJECT_BUSY 残留）。
 */

const STAMP = `${Date.now().toString(36)}`;
const TITLE = `E2E M9.1 入口 ${STAMP}`;

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

test.describe.serial("M9.1 idea 项目论文生成入口", () => {
  let projectId = "";

  test.afterAll(async ({ request }) => {
    if (projectId !== "") {
      await request.post(`/api/projects/${projectId}/archive`);
      await request.delete(`/api/projects/${projectId}`);
    }
  });

  test("idea 项目：入口可见 →（模型就绪时）点击启动 → 工作流视图 → 取消", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/projects/new");
    await page.getByLabel(/论文标题/).fill(TITLE);
    await page.getByLabel("研究想法", { exact: true }).fill(
      "E2E：验证 idea_to_paper 的 UI 启动入口（M9.1）。",
    );
    await page.getByRole("button", { name: "创建项目" }).click();
    await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+$/);
    projectId = new URL(page.url()).pathname.split("/").pop() ?? "";

    // 侧栏生成论文区块 + 启动入口可见（不受「论文信息 / PDF」区块 gating）
    const start = page.getByTestId("aside-start-paper");
    await expect(start).toBeVisible();

    if (await start.isDisabled()) {
      // 无模型栈：入口存在但禁用，引导去模型设置——这是本栈下的可达终点
      await expect(page.getByText(/模型未配置，论文生成暂不可用/)).toBeVisible();
      return;
    }

    // 点击 → 真实创建 idea_to_paper run → 入口切换为「查看任务进度」
    await start.click();
    await expect(page.getByRole("button", { name: /查看任务进度/ })).toBeVisible({ timeout: 15_000 });

    // 进入工作流实时视图（时间线 + 取消入口）
    await page.getByRole("button", { name: /查看任务进度/ }).click();
    await expect(page.getByRole("tab", { name: "工作流" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("workflow-panel")).toBeVisible();

    // 立即取消：验证启动链路即可，不消耗完整 run 的模型预算
    await page.getByTestId("cancel-run").click();
    const confirm = page.getByTestId("cancel-confirm");
    await confirm.getByRole("button", { name: "取消任务" }).click();
    // 取消信号发出（协作式取消等待在途调用 settle——终态以 API 轮询为准）
    await expect(page.getByText(/正在取消/)).toBeVisible({ timeout: 15_000 });

    // 后端权威终态：research.idea 的真实模型调用中断窗口可能 >90s，放宽轮询
    const deadline = Date.now() + 240_000;
    for (;;) {
      const response = await page.request.get(`/api/runs?projectId=${projectId}`);
      expect(response.ok()).toBeTruthy();
      const runs = ((await response.json()) as { runs: Array<{ status: string }> }).runs;
      const latest = runs.at(-1);
      if (latest !== undefined && latest.status !== "running" && latest.status !== "pending") {
        expect(latest.status).toBe("cancelled");
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`等待 run 取消终态超时（当前 ${latest?.status ?? "无 run"}）`);
      }
      await delay(2_000);
    }
  });
});
