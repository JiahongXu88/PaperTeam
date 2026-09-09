import { expect, test, primeTheme, type Page } from "./fixtures.js";

/**
 * HITL 决策 E2E（M4.5）。
 *
 * 运行前提（与 workflow.spec 的无模型栈不同）：dev 栈以脚本化 Runtime 启动——
 *   PAPERTEAM_TEST_RUNTIME=scripted PAPERTEAM_PORT=3100 \
 *   PAPERTEAM_RUNTIME_ROOT=<隔离目录> PROJECTS_ROOT=<隔离目录> node backend/dist/index.js
 *   cd frontend && PAPERTEAM_PORT=3100 npx vite
 * 然后以 PAPERTEAM_E2E_HITL=1 运行本套件（其它环境自动跳过）。
 *
 * 编排器 / checkpoint / SSE / HTTP / React 全部真实；只有「模型输出」是确定性
 * 脚本（src/runtime/scriptedRuntime.ts）。HITL 的 awaiting / resume / cancel
 * 语义绝不 mock。
 *
 * 用例：
 *   A running → awaiting feasibility → approve → 自动恢复到 outline awaiting（SSE，无刷新）
 *   B outline awaiting → revise 反馈 → 重新规划 → 再次 outline awaiting
 *   C awaiting → 页面刷新 → 仍等待 → approve（checkpoint 恢复）
 *   D awaiting → HITL 取消（decision 通道）→ cancelled
 *   E 旧页面 + 另一端 resume（stale）：面板自动让位，不卡死
 *   F/G Light / Dark / 窄屏（1100px）无横向溢出
 */

const HITL_ENABLED = process.env.PAPERTEAM_E2E_HITL === "1";

type PageFixture = Page;
type RequestFixture = Parameters<Parameters<typeof test>[2]>[0]["request"];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startRun(request: RequestFixture, projectId: string): Promise<string> {
  const response = await request.post(`/api/projects/${projectId}/workflows`, {
    data: { kind: "idea_to_paper" },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { runId: string }).runId;
}

/** 走到可行性确认（脚本化 research + feasibility 瞬时完成） */
async function gotoFeasibilityAwaiting(page: PageFixture, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}?tab=workflow`);
  await expect(page.getByTestId("hitl-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("hitl-payload-feasibility")).toBeVisible({ timeout: 30_000 });
}

async function cancelViaHeader(page: PageFixture): Promise<void> {
  await page.getByTestId("cancel-run").click();
  await page.getByTestId("cancel-confirm").getByRole("button", { name: "取消任务" }).click();
  await expect(page.getByTestId("workflow-cancelled")).toBeVisible({ timeout: 60_000 });
}

async function waitRunStatus(
  request: RequestFixture,
  runId: string,
  statuses: string[],
  timeoutMs = 60_000,
): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request.get(`/api/runs/${runId}`);
    const run = ((await response.json()) as { run: { status: string } }).run;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status}）`);
    }
    await delay(300);
  }
}

async function cleanupProject(request: RequestFixture, projectId: string): Promise<void> {
  if (projectId === "") {
    return;
  }
  await request.post(`/api/projects/${projectId}/archive`);
  await request.delete(`/api/projects/${projectId}`);
}

const STAMP = `${Date.now().toString(36)}`;

test.describe.serial("HITL 决策（脚本化 Runtime 栈）", () => {
  test.skip(!HITL_ENABLED, "PAPERTEAM_E2E_HITL 未设置（需要 PAPERTEAM_TEST_RUNTIME=scripted 的 dev 栈）");

  let projectId = "";
  /** 本轮未终结的 run：失败兜底取消，避免污染下一个用例（同项目阻塞创建） */
  let activeRunId = "";

  test.afterEach(async ({ request }) => {
    if (activeRunId !== "") {
      await request.post(`/api/runs/${activeRunId}/cancel`).catch(() => {});
      await waitRunStatus(request, activeRunId, ["cancelled", "completed", "failed"]).catch(() => {});
      activeRunId = "";
    }
  });

  test.afterAll(async ({ request }) => {
    await cleanupProject(request, projectId);
  });

  test("A 可行性确认 → 继续 → 自动恢复到大纲确认（SSE，无整页刷新）", async ({ page, request }) => {
    const created = await request.post("/api/projects", {
      data: { title: `M4.5 HITL A ${STAMP}`, researchIdea: "脚本化 Runtime 下的 HITL 验证项目" },
    });
    projectId = ((await created.json()) as { project: { id: string } }).project.id;
    activeRunId = await startRun(request, projectId);

    await gotoFeasibilityAwaiting(page, projectId);

    // 待办内容来自 checkpoint（prompt + payload + options）
    const panel = page.getByTestId("hitl-panel");
    await expect(panel).toContainText("调研与可行性评估已完成");
    await expect(panel).toContainText("当前评估结论");
    // 严格按 options 渲染：可行性节点是 继续 / 调整目标 / 取消任务
    await expect(page.getByTestId("hitl-approve")).toBeVisible();
    await expect(page.getByTestId("hitl-adjust")).toBeVisible();
    await expect(page.getByTestId("hitl-cancel")).toBeVisible();
    await expect(page.getByTestId("hitl-revise")).toHaveCount(0);

    // Timeline 一等化：HITL 节点显示等待确认，而非 running / failed
    const timeline = page.getByTestId("stage-timeline");
    await expect(timeline.locator('[data-stage="hitl.feasibility_confirm"]')).toHaveAttribute(
      "data-stage-state",
      "awaiting",
    );
    await expect(timeline.locator('[data-stage="hitl.feasibility_confirm"]')).toContainText("等待确认");

    // 继续 → run 恢复（无整页刷新；SSE 驱动缓存更新）
    await page.getByTestId("hitl-approve").click();
    await expect(page.getByTestId("hitl-payload-outline")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("hitl-outline-sections")).toContainText("引言");
    // 大纲节点动作：继续 / 提出修改意见 / 取消（无 调整目标）
    await expect(page.getByTestId("hitl-revise")).toBeVisible();
    await expect(page.getByTestId("hitl-adjust")).toHaveCount(0);

    // 后端权威状态：run 再次 awaiting（outline）
    const run = await request.get(`/api/runs/${activeRunId}`);
    expect(((await run.json()) as { run: { status: string } }).run.status).toBe("awaiting_input");

    await cancelViaHeader(page);
    await waitRunStatus(request, activeRunId, ["cancelled"]);
    activeRunId = "";
  });

  test("B 大纲确认 → 提出修改意见 → 重新规划 → 再次等待确认", async ({ page, request }) => {
    activeRunId = await startRun(request, projectId);
    await gotoFeasibilityAwaiting(page, projectId);
    await page.getByTestId("hitl-approve").click();
    await expect(page.getByTestId("hitl-payload-outline")).toBeVisible({ timeout: 30_000 });

    // 打开修改意见表单：空值不可提交
    await page.getByTestId("hitl-revise").click();
    const form = page.getByTestId("hitl-revise-form");
    await expect(form).toBeVisible();
    await expect(page.getByTestId("hitl-revise-submit")).toBeDisabled();
    await expect(page.getByTestId("hitl-feedback")).toBeFocused();

    await page.getByTestId("hitl-feedback").fill("希望方法章节提前，实验章节增加消融实验。");
    await page.getByTestId("hitl-revise-submit").click();

    // revise → outline.plan 重跑 → 再次 awaiting outline（无需刷新）
    await expect(page.getByTestId("hitl-payload-outline")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("hitl-panel")).toContainText("大纲已生成");

    await cancelViaHeader(page);
    await waitRunStatus(request, activeRunId, ["cancelled"]);
    activeRunId = "";
  });

  test("C awaiting → 刷新页面 → 仍等待确认 → 继续（checkpoint 恢复，不依赖内存事件）", async ({ page, request }) => {
    activeRunId = await startRun(request, projectId);
    await gotoFeasibilityAwaiting(page, projectId);

    await page.reload();
    await expect(page.getByTestId("hitl-panel")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("hitl-payload-feasibility")).toBeVisible();
    await expect(page.getByTestId("hitl-approve")).toBeEnabled();

    await page.getByTestId("hitl-approve").click();
    await expect(page.getByTestId("hitl-payload-outline")).toBeVisible({ timeout: 30_000 });

    await cancelViaHeader(page);
    await waitRunStatus(request, activeRunId, ["cancelled"]);
    activeRunId = "";
  });

  test("D awaiting → HITL 面板取消（decision 通道）→ cancelled", async ({ page, request }) => {
    activeRunId = await startRun(request, projectId);
    await gotoFeasibilityAwaiting(page, projectId);

    await page.getByTestId("hitl-cancel").click();
    const confirm = page.getByTestId("hitl-cancel-confirm");
    await expect(confirm).toContainText("确定取消整个任务吗");
    await confirm.getByRole("button", { name: "取消任务" }).click();

    await expect(page.getByTestId("workflow-cancelled")).toBeVisible({ timeout: 30_000 });
    await waitRunStatus(request, activeRunId, ["cancelled"]);
    activeRunId = "";
  });

  test("E 旧页面 + 另一端 resume：面板自动让位（stale 不卡死）", async ({ page, request }) => {
    activeRunId = await startRun(request, projectId);
    await gotoFeasibilityAwaiting(page, projectId);

    // 另一个「页面」（API 直连）先 resume
    const resumed = await request.post(`/api/runs/${activeRunId}/resume`, { data: { decision: "approve" } });
    expect(resumed.ok()).toBeTruthy();

    // 旧页面经 SSE / 轮询自动推进到 outline awaiting：可行性面板让位
    await expect(page.getByTestId("hitl-payload-outline")).toBeVisible({ timeout: 30_000 });

    // 此时旧的可操作性依然成立（对新待办决策）：approve 后流程推进过 outline
    // （脚本化执行瞬时完成，running / completed 均证明已越过待办节点）
    await page.getByTestId("hitl-approve").click();
    await expect
      .poll(
        async () =>
          (
            await page
              .getByTestId("stage-timeline")
              .locator('[data-stage="writing.sections"]')
              .getAttribute("data-stage-state")
          ) ?? "",
        { timeout: 30_000 },
      )
      .toEqual(expect.stringMatching(/^(running|completed)$/));

    await cancelViaHeader(page);
    await waitRunStatus(request, activeRunId, ["cancelled"]);
    activeRunId = "";
  });

  test("F Light 视觉 + 窄屏（1100px）无横向溢出", async ({ page, request }) => {
    activeRunId = await startRun(request, projectId);
    await gotoFeasibilityAwaiting(page, projectId);

    await page.screenshot({ path: "shots/m45-hitl-feasibility-light.png", fullPage: true });
    // 大纲场景
    await page.getByTestId("hitl-approve").click();
    await expect(page.getByTestId("hitl-payload-outline")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("hitl-revise").click();
    await expect(page.getByTestId("hitl-revise-form")).toBeVisible();
    await page.screenshot({ path: "shots/m45-hitl-outline-revise-light.png", fullPage: true });

    // 窄屏：HITL 面板不横向溢出
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await cancelViaHeader(page);
    await waitRunStatus(request, activeRunId, ["cancelled"]);
    activeRunId = "";
  });

  test("G Dark 视觉", async ({ page, request }) => {
    // 主题在首次导航前写入 localStorage（React 挂载前生效，避免闪白）
    await primeTheme(page, "dark");

    activeRunId = await startRun(request, projectId);
    await gotoFeasibilityAwaiting(page, projectId);
    // 确认 dark 已生效（html data-theme）
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "shots/m45-hitl-feasibility-dark.png", fullPage: true });

    await page.getByTestId("hitl-approve").click();
    await expect(page.getByTestId("hitl-payload-outline")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: "shots/m45-hitl-outline-dark.png", fullPage: true });

    // 取消确认对话框（Dark）
    await page.getByTestId("hitl-cancel").click();
    await expect(page.getByTestId("hitl-cancel-confirm")).toBeVisible();
    await page.screenshot({ path: "shots/m45-hitl-cancel-dark.png" });
    await page.getByTestId("hitl-cancel-confirm").getByRole("button", { name: "取消任务" }).click();
    await expect(page.getByTestId("workflow-cancelled")).toBeVisible({ timeout: 30_000 });
    await waitRunStatus(request, activeRunId, ["cancelled"]);
    activeRunId = "";
  });
});
