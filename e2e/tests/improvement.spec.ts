import type { APIRequestContext, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

import { expect, primeTheme, resolvePdfPath, test } from "./fixtures.js";

/**
 * M4.8 Existing Paper Improvement 全链路浏览器 E2E。
 *
 * 运行前提（scripted 栈 + 本机真实 LaTeX）：
 *   PAPERTEAM_TEST_RUNTIME=scripted CITATION_METADATA_ENABLED=0 \
 *   PAPERTEAM_PORT=3100 PAPERTEAM_RUNTIME_ROOT=<隔离目录> PROJECTS_ROOT=<隔离目录> \
 *   node backend/dist/index.js
 *   cd frontend && PAPERTEAM_PORT=3100 npx vite
 * 机器需有真实 latexmk（重建稿的真实编译）。然后 PAPERTEAM_E2E_IMPROVEMENT=1 运行。
 *
 * 全浏览器链路（PDF 导入 UI → 系统性改进 → PDF 重建 → 理解 / 审稿 → 改进计划
 * → HITL 面板确认 → Writer 逐节修订 → 真实 LaTeX 构建 → Draft → 复审 →
 * Quality Gate → Final → 查看 / 下载）。模型输出为脚本；Workflow / 重建 /
 * Store / HTTP / React / Artifacts / Gate / Compiler 全部真实代码路径。
 */

const ENABLED = process.env.PAPERTEAM_E2E_IMPROVEMENT === "1";
const SHOTS_DIR = process.env.PAPERTEAM_E2E_SHOTS_DIR ?? "shots";

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

interface RunState {
  status: string;
  currentStage?: string;
  completion?: { label: string } | null;
  error?: { message: string } | null;
}

async function runState(request: APIRequestContext, runId: string): Promise<RunState> {
  const response = await request.get(`/api/runs/${runId}`);
  return ((await response.json()) as { run: RunState }).run;
}

async function waitRunStatus(
  request: APIRequestContext,
  runId: string,
  statuses: string[],
  timeoutMs = 240_000,
): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await runState(request, runId);
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status} @ ${run.currentStage ?? "?"}）`);
    }
    await delay(400);
  }
}

async function cleanupProject(request: APIRequestContext, projectId: string): Promise<void> {
  if (projectId === "") {
    return;
  }
  await request.post(`/api/projects/${projectId}/archive`);
  await request.delete(`/api/projects/${projectId}`);
}

test.describe.serial("M4.8 Existing Paper Improvement（scripted + 真实 LaTeX）", () => {
  test.skip(!ENABLED, "PAPERTEAM_E2E_IMPROVEMENT 未设置（需要 scripted dev 栈 + latexmk）");

  const stamp = Date.now().toString(36);
  let projectId = "";

  test.afterAll(async ({ request }) => {
    await cleanupProject(request, projectId);
  });

  test("I 导入 PDF（系统性改进）→ 重建 → 改进闭环 → Draft / Final → 查看 / 下载", async ({
    page,
    request,
  }) => {
    test.setTimeout(420_000);

    // 1. 浏览器导入：已有论文 + 系统性改进
    await page.goto("/projects/new");
    await page.getByRole("radio", { name: /导入已有论文/ }).check();
    await page.getByLabel("选择论文 PDF（.pdf）").setInputFiles(resolvePdfPath());
    await page.getByTestId("goal-improvement").click();
    await page.getByRole("button", { name: "导入论文" }).click();
    await page.waitForURL(/\/projects\/p-[a-z0-9]+/, { timeout: 60_000 });
    projectId = /p-[a-z0-9]+/.exec(page.url())?.[0] ?? "";
    expect(projectId).not.toBe("");

    // 2. Review tab：系统性改进入口存在（此前该路径从浏览器不可达）
    await page.goto(`/projects/${projectId}?tab=review`);
    const improvementButton = page.getByTestId("start-improvement");
    await expect(improvementButton).toBeVisible();
    await improvementButton.click();

    // 3. 工作流页：重建 / 理解 / 审稿真实推进 → 改进计划 HITL 面板（浏览器确认）
    await page.goto(`/projects/${projectId}?tab=workflow`);
    await expect(page.getByTestId("stage-timeline")).toBeVisible();
    await expect(page.getByTestId("hitl-panel")).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId("hitl-approve")).toBeVisible();
    await page.getByTestId("hitl-approve").click();

    // 4. 修订 → 真实 LaTeX 构建 → Draft → 复审 → Gate → Final（API 权威等待终态）
    const runsResponse = await request.get(`/api/runs?projectId=${projectId}`);
    const runs = ((await runsResponse.json()) as { runs: { runId: string; workflowKind: string }[] }).runs;
    const improvementRun = runs.find((run) => run.workflowKind === "existing_paper_improvement");
    expect(improvementRun).toBeDefined();
    const finished = await waitRunStatus(request, improvementRun!.runId, ["completed", "failed", "awaiting_input"]);
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");

    // 5. 阶段事实：PDF 重建发生在 import.parse
    const parseStage = await request.get(`/api/runs/${improvementRun!.runId}`);
    expect(parseStage.ok()).toBeTruthy();
    const run = ((await parseStage.json()) as { run: { stageHistory?: { stageId: string; status: string; summary?: Record<string, unknown> }[] } }).run;
    const parseRecord = run.stageHistory?.find(
      (record) => record.stageId === "import.parse" && record.status === "completed",
    );
    expect(parseRecord?.summary?.["reconstructedFromPdf"]).toBe(true);

    // 6. 论文产出：Final 冻结 + 版本历史（重建基线 → 应用改进计划）
    await page.goto(`/projects/${projectId}?tab=paper`);
    await expect(page.getByTestId("final-card")).toBeVisible();
    await expect(page.getByTestId("final-card")).toContainText("已冻结");
    const history = page.getByTestId("version-history");
    await expect(history).toBeVisible();
    const items = history.getByTestId("version-item");
    await expect(items.first()).toContainText("当前版本");
    await expect(items.first()).toContainText("Final");
    await expect(items.last()).toContainText("审稿快照"); // 重建稿进入首轮审稿时的快照修订
    // Draft / Final 的查看 / 下载（浏览器原生 viewer + attachment）
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByTestId("final-view").click(),
    ]);
    await expect(popup.url()).toContain(`/api/projects/${projectId}/artifacts/`);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("final-download").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^art-final-rev\d+\.pdf$/);

    // 7. 版本 API 权威核验：恢复语义可用（恢复早期修订 → 新修订；历史 Final 保留）
    const versionsBefore = (await (
      await request.get(`/api/projects/${projectId}/versions`)
    ).json()) as { current: number; versions: { revision: number; isFinal: boolean }[] };
    expect(versionsBefore.current).toBeGreaterThanOrEqual(2);
    const finalRevision = versionsBefore.versions.find((version) => version.isFinal)?.revision;
    expect(finalRevision).toBe(versionsBefore.current);
    if (versionsBefore.current >= 2) {
      const restoreResponse = await request.post(
        `/api/projects/${projectId}/revisions/1/restore`,
        { data: {} },
      );
      expect(restoreResponse.ok()).toBeTruthy();
      const restoreBody = (await restoreResponse.json()) as { revision: number; restoredFrom: number };
      expect(restoreBody.revision).toBe(versionsBefore.current + 1);
      // 旧 Final 历史事实仍在
      const versionsAfter = (await (
        await request.get(`/api/projects/${projectId}/versions`)
      ).json()) as { versions: { revision: number; isFinal: boolean }[] };
      expect(versionsAfter.versions.find((version) => version.revision === finalRevision)?.isFinal).toBe(true);
    }
  });

  test("V Light / Dark 视觉 + 无横向溢出（改进项目论文产出 / 版本历史）", async ({ page }) => {
    if (projectId === "") {
      test.skip(true, "前一用例未产出项目");
    }
    mkdirSync(SHOTS_DIR, { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await primeTheme(page, theme);
      await page.goto(`/projects/${projectId}?tab=paper`);
      await expect(page.getByTestId("version-history")).toBeVisible();
      await page.screenshot({ path: `${SHOTS_DIR}/m48-improvement-${theme}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`/projects/${projectId}?tab=paper`);
    await expect(page.getByTestId("paper-panel")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
