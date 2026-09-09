import { resolve } from "node:path";

import { expect, test } from "./fixtures.js";
import { resolvePdfPath } from "./fixtures.js";

/**
 * 工作流实时视图 E2E（M4.4）。
 *
 * 无模型栈（PAPERTEAM_RUNTIME_ROOT 指向独立目录的 dev 栈）下，本套件不访问
 * 任何 LLM Provider：确定性 stage（PDF 解析 / 引用提取）真实推进，模型 stage
 * 快速失败或被取消——时间线 / SSE / 取消 / 恢复全部真实可验证。
 *
 * 用例：
 *   A 启动 review run → 工作流页时间线随 SSE 推进（paper.ensure 完成）
 *   B 运行中取消：确认 → 已取消（queued 不再启动，后端终态 cancelled）
 *   C reload 恢复（GET + SSE replay）+ 概览 / Review 联动入口
 *   D 无模型 idea_to_paper → 快速失败 → 失败状态可读
 *   E（模型已配置时）小论文完整 Review → completed + Review 报告就绪
 */

interface RunState {
  runId: string;
  status: string;
  currentStage?: string;
}

type PageFixture = Parameters<Parameters<typeof test>[2]>[0]["page"];
type RequestFixture = Parameters<Parameters<typeof test>[2]>[0]["request"];

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** File-First 导入（标题由 PDF 内容推导，不需要手填） */
async function createProject(page: PageFixture, pdfPath: string): Promise<string> {
  await page.goto("/projects/new");
  await page.getByRole("radio", { name: /导入已有论文/ }).check();
  await page.getByLabel("选择论文 PDF（.pdf）").setInputFiles(pdfPath);
  await page.getByRole("button", { name: "导入论文" }).click();
  await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+/, { timeout: 90_000 });
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

async function startRun(request: RequestFixture, projectId: string, kind: string): Promise<string> {
  const response = await request.post(`/api/projects/${projectId}/workflows`, { data: { kind } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { runId: string }).runId;
}

async function latestRun(request: RequestFixture, projectId: string): Promise<RunState> {
  const response = await request.get(`/api/runs?projectId=${projectId}`);
  const runs = ((await response.json()) as { runs: RunState[] }).runs;
  return runs[0]!;
}

async function waitRunStatus(request: RequestFixture, runId: string, statuses: string[], timeoutMs = 60_000): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request.get(`/api/runs/${runId}`);
    const run = ((await response.json()) as { run: RunState }).run;
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

test.describe.serial("工作流实时视图（无模型栈）", () => {
  let projectId = "";

  test.afterAll(async ({ request }) => {
    await cleanupProject(request, projectId);
  });

  test("A 导入论文 + 启动 Review → 工作流页时间线随 SSE 推进", async ({ page, request }) => {
    projectId = await createProject(page, resolvePdfPath());
    await startRun(request, projectId, "existing_paper_review");

    await page.goto(`/projects/${projectId}?tab=workflow`);
    await expect(page.getByTestId("workflow-panel")).toBeVisible();
    // 时间线渲染：确定性 stage 真实完成（SSE stage.completed 驱动缓存更新）
    const timeline = page.getByTestId("stage-timeline");
    await expect(timeline.locator('[data-stage="paper.ensure"]')).toHaveAttribute("data-stage-state", "completed", { timeout: 60_000 });
    await expect(timeline.locator('[data-stage="citation.extract"]')).toHaveAttribute("data-stage-state", "completed", { timeout: 60_000 });
    // 运行中头部：取消入口 + 实时连接状态
    await expect(page.getByTestId("cancel-run")).toBeVisible();
    await expect(page.getByTestId("workflow-connection")).toHaveText(/实时同步中|连接中/);
  });

  test("B 运行中取消：确认 → 已取消（queued 不再启动）", async ({ page, request }) => {
    await page.goto(`/projects/${projectId}?tab=workflow`);
    await page.getByTestId("cancel-run").click();
    const confirm = page.getByTestId("cancel-confirm");
    await expect(confirm).toContainText("已完成的阶段与结果会保留");
    await confirm.getByRole("button", { name: "取消任务" }).click();

    // settle 窗口（在途检索 / 模型调用中断）内先出现「正在取消…」，终态后「已取消」
    await expect(page.getByTestId("workflow-cancelled")).toBeVisible({ timeout: 90_000 });
    // 后端权威终态
    const run = await waitRunStatus(request, (await latestRun(request, projectId)).runId, ["cancelled"]);
    expect(run.status).toBe("cancelled");
  });

  test("C reload 恢复 + 概览 / Review 联动入口", async ({ page, request }) => {
    const runId = await startRun(request, projectId, "existing_paper_review");
    await page.goto(`/projects/${projectId}?tab=workflow`);
    await expect(page.getByTestId("stage-timeline")).toBeVisible();

    // 刷新：GET 当前状态 + SSE replay 重建（不需要从打开页面前盯守）
    await page.reload();
    const timeline = page.getByTestId("stage-timeline");
    await expect(timeline.locator('[data-stage="paper.ensure"]')).toHaveAttribute("data-stage-state", "completed", { timeout: 60_000 });

    // 概览摘要卡 → 工作流
    await page.getByRole("tab", { name: "概览" }).click();
    const card = page.getByTestId("current-workflow");
    await expect(card).toContainText(/正在执行|排队中/);
    await card.getByTestId("goto-workflow").click();
    await expect(page.getByRole("tab", { name: "工作流" })).toHaveAttribute("aria-selected", "true");

    // Review 页运行中提示 + 查看工作流入口
    await page.getByRole("tab", { name: "Review" }).click();
    await expect(page.getByTestId("review-running")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("goto-workflow-from-review").click();
    await expect(page.getByRole("tab", { name: "工作流" })).toHaveAttribute("aria-selected", "true");

    // 清场：取消本轮，不影响后续用例
    await page.getByTestId("cancel-run").click();
    await page.getByTestId("cancel-confirm").getByRole("button", { name: "取消任务" }).click();
    await expect(page.getByTestId("workflow-cancelled")).toBeVisible({ timeout: 60_000 });
    await waitRunStatus(request, runId, ["cancelled"]);
  });

  test("D 无模型 idea_to_paper → 失败状态可读", async ({ page, request }) => {
    const created = await request.post("/api/projects", {
      data: { title: `E2E 失败路径 ${STAMP}`, researchIdea: "无模型快速失败的验证项目" },
    });
    const id = ((await created.json()) as { project: { id: string } }).project.id;
    const runId = await startRun(request, id, "idea_to_paper");
    await waitRunStatus(request, runId, ["failed"], 90_000);

    await page.goto(`/projects/${id}?tab=workflow`);
    const failed = page.getByTestId("workflow-failed");
    await expect(failed).toBeVisible();
    await expect(failed).toContainText("任务失败");
    await expect(failed).toContainText("重新开始");
    await expect(page.getByTestId("stage-timeline").locator('[data-stage="research.idea"]')).toHaveAttribute("data-stage-state", "failed");
    await cleanupProject(request, id);
  });
});

/** 模型已配置时的小论文完整链路（单节短调用量级；未配置自动跳过） */
test.describe("完整 Review（模型门控）", () => {
  test("小论文 → completed → Review 报告就绪", async ({ page, request }) => {
    test.skip(!(await modelConfigured(request)), "模型未配置，跳过完整链路（无模型路径由其它用例覆盖）");
    // 真实模型调用：单节论文一次审阅 + 逐条 claim 短判定，给足墙钟预算
    test.setTimeout(420_000);

    const pdf = resolve(import.meta.dirname, "..", "fixtures", "tiny-paper.pdf");
    const projectId = await createProject(page, pdf);
    // 模型已配置时导入会自动启动 Review（NewProjectPage 既有行为）：优先复用该 run，否则手动启动
    const existing = await latestRun(request, projectId);
    if (!["pending", "running", "awaiting_input"].includes(existing.status)) {
      await startRun(request, projectId, "existing_paper_review");
    }

    await page.goto(`/projects/${projectId}?tab=workflow`);
    const timeline = page.getByTestId("stage-timeline");
    await expect(page.getByTestId("workflow-completed")).toBeVisible({ timeout: 300_000 });
    await expect(page.getByTestId("workflow-completed")).toContainText("总耗时");
    await expect(timeline.locator('[data-stage="review.aggregate"]')).toHaveAttribute("data-stage-state", "completed");

    // 结果入口 → Review 报告就绪
    await page.getByTestId("goto-review").click();
    await expect(page.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("review-report").or(page.getByText("本轮审阅未记录问题"))).toBeVisible({ timeout: 30_000 });
    await cleanupProject(request, projectId);
  });
});

async function modelConfigured(request: RequestFixture): Promise<boolean> {
  const response = await request.get("/api/runtime/status");
  const body = (await response.json()) as { status?: { model?: { phase?: string } } };
  return body.status?.model?.phase === "configured";
}
