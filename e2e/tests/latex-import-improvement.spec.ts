import { resolve } from "node:path";

import { expect, repoRoot, test } from "./fixtures.js";

/**
 * M14.8-MOT 回归：LaTeX 工程导入（单文件、无 PDF）的系统性改进入口。
 *
 * 真实验收暴露：LaTeX ZIP 导入后 Review 页只显示「尚未导入论文 PDF / 前往上传 PDF」，
 * 整个产品没有「开始系统性改进」按钮（后端 import.parse 直接校验 main.tex，并不需要 PDF）。
 * 本用例走真实 UI：选择「修改已有论文 → LaTeX 工程」上传单文件 ZIP（摘要在首个 \section
 * 之前、内联 thebibliography）→ Review 页出现 LaTeX 改进入口与外部意见面板 → 点击后
 * POST /workflows 202 且 run 的 workflowKind = existing_paper_improvement。
 *
 * 运行前提：scripted 栈（与 evidence-gate.spec.ts 同一配方，无模型调用），然后
 * PAPERTEAM_E2E_LATEX_IMPORT=1 运行；其它环境自动跳过。
 */

const ENABLED = process.env.PAPERTEAM_E2E_LATEX_IMPORT === "1";
const FIXTURE = resolve(repoRoot, "e2e", "fixtures", "tiny-latex-project.zip");

test.describe("M14.8-MOT LaTeX 工程导入 → 系统性改进入口", () => {
  test.skip(!ENABLED, "PAPERTEAM_E2E_LATEX_IMPORT 未设置（需要 scripted 栈）");

  let projectId = "";
  let runId = "";

  test.afterEach(async ({ request }) => {
    if (runId !== "") await request.post(`/api/runs/${runId}/cancel`).catch(() => undefined);
    if (projectId !== "") {
      // run 取消落定后再归档删除
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const archived = await request.post(`/api/projects/${projectId}/archive`);
        if (archived.ok()) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      }
      await request.delete(`/api/projects/${projectId}`);
    }
  });

  test("无 PDF 的 LaTeX 项目可从 Review 页开始系统性改进", async ({ page }) => {
    await page.goto("/projects/new?mode=existing");
    await page.getByTestId("import-format-latex").click();
    await page.getByLabel("选择 LaTeX 工程 ZIP 归档（.zip）").setInputFiles(FIXTURE);
    await page.getByRole("button", { name: "导入论文" }).click();
    await page.waitForURL(/\/projects\/p-[a-z0-9]+/);
    projectId = /\/projects\/(p-[a-z0-9]+)/.exec(page.url())?.[1] ?? "";
    expect(projectId).not.toBe("");

    await page.goto(`/projects/${projectId}?tab=review`);
    await expect(page.getByTestId("latex-improvement-start")).toBeVisible();
    await expect(page.getByText("尚未导入论文 PDF")).toHaveCount(0);
    await expect(page.getByText(/批量导入 Reviewer/)).toBeVisible();

    const created = page.waitForResponse((response) =>
      response.url().endsWith(`/api/projects/${projectId}/workflows`) && response.request().method() === "POST");
    await page.getByTestId("start-improvement").click();
    const response = await created;
    expect(response.status()).toBe(202);
    const body = (await response.json()) as { runId: string; workflowKind: string };
    runId = body.runId;
    expect(body.workflowKind).toBe("existing_paper_improvement");
  });
});
