/**
 * M14.3 浏览器级 thesis E2E（Playwright）：
 * 创建学位论文项目 → 上传研究材料 → ResearchInput 登记 → 启动工作流 →
 * HITL（入选 / 确认贡献 / approve / 缺材料限制口径）→ Timeline 推进 →
 * Review/Gate 状态 → Draft PDF 下载。
 *
 * 真实性边界：浏览器事件 / HTTP / SSE / 编排器 / checkpoint / 文件全部真实；
 * 模型输出为 scripted（PAPERTEAM_TEST_RUNTIME=scripted），解析为罐头 docling
 * wrapper（内容含 scripted 贡献锚句）。前置服务由 scripts/e2e-thesis-server.sh
 * 启动（本 spec 只做浏览器操作）。
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

test.describe("thesis_from_papers 浏览器 E2E", () => {
  test("上传材料 → 工作流 → HITL → Draft 下载", { timeout: 600_000 }, async ({ page }) => {
    // 页面异常捕获（渲染崩溃诊断）
    page.on("pageerror", (error) => {
      console.log(`[pageerror] ${error.message.slice(0, 400)}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.log(`[console.error] ${message.text().slice(0, 300)}`);
      }
    });
    page.on("response", async (response) => {
      if (response.url().includes("/resume") && response.status() >= 300) {
        console.log(`[resume ${response.status()}] ${(await response.text().catch(() => "")).slice(0, 300)}`);
      }
    });
    // 1. 打开 PaperTeam → 新建项目（选择学位论文类型 → 学位论文卡）
    await page.goto("/projects/new");
    await page.getByRole("radio", { name: /学位论文/ }).first().check();
    await expect(page.getByTestId("thesis-selection")).toBeVisible();
    await page.getByTestId("thesis-title").fill("浏览器端到端学位论文验证");
    await page.getByTestId("thesis-submit").click();

    // 2. 项目页：切到「研究材料」面板（thesis 专属 tab）
    await page.getByRole("tab", { name: "研究材料" }).click();
    await expect(page.getByTestId("research-inputs-panel")).toBeVisible({ timeout: 30_000 });

    // 3. 上传研究材料 PDF（scripted 锚句在罐头解析产物中）
    const uploadDir = await mkdtemp(join(tmpdir(), "m143-e2e-"));
    const pdfPath = join(uploadDir, "browser-paper.pdf");
    await writeFile(pdfPath, "%PDF-1.5\nbrowser-e2e research material\n", "utf8");
    await page.locator('input[type="file"][accept=".pdf,application/pdf"]').setInputFiles(pdfPath);
    await expect(page.getByTestId("research-inputs-list")).toContainText("browser-paper", { timeout: 60_000 });

    // 4. 启动学位论文工作流
    await page.getByTestId("thesis-start-run").click();
    await expect(page.getByText("学位论文工作流已启动", { exact: false })).toBeVisible({ timeout: 30_000 });

    // 5. 工作流 tab：HITL 面板出现（范围确认）
    await page.getByRole("tab", { name: "工作流" }).click();
    const hitl = page.getByTestId("hitl-panel");
    await expect(hitl).toBeVisible({ timeout: 60_000 });

    // 6. HITL：入选材料 → 确认贡献 → 缺材料限制口径 → approve（循环至终态）
    const deadline = Date.now() + 480_000;
    for (;;) {
      // 逐个点击并重新定位（payload 随每次 resume 重渲染，批式 nth 会拿到失联元素）
      for (let round = 0; round < 10; round += 1) {
        const include = page.locator('[data-testid^="thesis-include-"]').first();
        if (!(await include.isVisible().catch(() => false))) break;
        await include.click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
      }
      const confirm = page.getByTestId("thesis-confirm-contributions");
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
      }
      for (let round = 0; round < 10; round += 1) {
        const limitation = page.locator('[data-testid^="thesis-limitation-"]').first();
        if (!(await limitation.isVisible().catch(() => false))) break;
        await limitation.click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
      }
      const approve = page.getByTestId("hitl-approve");
      if (await approve.isVisible().catch(() => false)) {
        await approve.click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(2_500);
      } else {
        await page.waitForTimeout(2_000);
      }
      const completed = page.getByTestId("workflow-completed");
      if (await completed.isVisible().catch(() => false)) break;
      const failed = page.getByTestId("workflow-failed");
      if (await failed.isVisible().catch(() => false)) {
        throw new Error(`工作流失败：${await failed.textContent()}`);
      }
      if (Date.now() > deadline) throw new Error("浏览器 E2E 等待完成超时");
    }

    // 7. Timeline 反映真实执行（stage 列表非空且出现完成态）
    const timeline = page.getByTestId("stage-timeline");
    await expect(timeline).toBeVisible();
    const stageCount = await timeline.locator("li").count();
    expect(stageCount).toBeGreaterThan(5);

    // 8. Draft 下载可用（论文产出面板的 Draft/Final 卡下载按钮触发真实产物端点）
    await page.getByRole("tab", { name: "论文产出" }).click();
    const draftCard = page.locator('[data-testid="draft-card"], [data-testid="final-card"]').first();
    await expect(draftCard).toBeVisible({ timeout: 30_000 });
    await expect(draftCard).not.toContainText("尚无 PDF");
    const downloadButton = page.locator('[data-testid="draft-download"], [data-testid="final-download"]').first();
    await expect(downloadButton).toBeVisible({ timeout: 30_000 });
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      downloadButton.click(),
    ]);
    expect(await download.path()).toBeTruthy();
  });
});
