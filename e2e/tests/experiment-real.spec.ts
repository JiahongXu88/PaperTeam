import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { expect, test } from "./fixtures.js";

/**
 * M13.3 真实实验数据包浏览器 E2E（env 门控）：
 *   PAPERTEAM_E2E_REAL_ZIP 指向真实 ZIP（本机私有文件，不进仓库）。
 *   未设置时整条链 skip——CI 无真实材料也能安全运行本文件。
 *
 * 覆盖：上传 → 真实解析 → 文件清单/实验分组（arm-*）→ 源材料判定
 * （NO-GO 原样呈现）→ 标度混用告警 → 作者角色修改与分组确认 →
 * workflow-context 有界输出 → 真实数据集 → pgfplots 散点图（真实
 * XeLaTeX 编译）→ PDF 可读性（%PDF magic）。
 * 全程只操作本测试创建的隔离项目，不触碰其他项目。
 */

const REAL_ZIP = process.env.PAPERTEAM_E2E_REAL_ZIP?.trim() ?? "";
const SHOT_DIR = process.env.PAPERTEAM_E2E_SHOT_DIR?.trim() ?? "";
const hasRealZip = REAL_ZIP !== "" && existsSync(REAL_ZIP);

test.describe.serial("M13.3 真实实验包浏览器验收", () => {
  test.skip(!hasRealZip, "PAPERTEAM_E2E_REAL_ZIP 未设置或文件不存在（真实材料为本机私有，不进 CI）");
  let projectId = "";
  const shots = async (page: import("@playwright/test").Page, name: string) => {
    if (SHOT_DIR !== "") {
      await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
    }
  };

  test("1-3 上传真实 ZIP → 解析完成 → 文件清单与实验分组", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/projects/new");
    await page.getByRole("radio", { name: /从研究想法开始/ }).check();
    await page.getByLabel(/论文标题/).fill(`M13-3 E2E Real ZIP ${Date.now().toString(36)}`);
    await page.getByLabel("研究想法", { exact: true }).fill("E2E isolation project for real experiment package acceptance. Safe to delete.");
    await page.getByRole("button", { name: "创建项目" }).click();
    await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+$/, { timeout: 60_000 });
    projectId = page.url().split("/").pop() ?? "";

    await page.getByRole("tab", { name: "实验数据包" }).click();
    const zip = await readFile(REAL_ZIP);
    await page.getByLabel("选择实验 ZIP").setInputFiles({ name: "real-experiment.zip", mimeType: "application/zip", buffer: zip });
    await page.getByRole("button", { name: "上传实验包" }).click();

    // 17 个文件全部登记、无 unsupported（.jsonl 与空白表在新解析器下可读）
    await expect(page.getByRole("heading", { name: /real-experiment\.zip/ })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/已解析 1[56]\/17 文件/)).toBeVisible({ timeout: 120_000 });
    const rows = page.locator("table tbody tr");
    await expect(rows).toHaveCount(17, { timeout: 60_000 });
    await expect(page.locator("td", { hasText: "unsupported" })).toHaveCount(0);

    // 兄弟目录 → 候选平行实验臂
    await expect(page.getByText("arm-a0", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("arm-a3", { exact: true }).first()).toBeVisible();
    await shots(page, "01-experiments-files");
  });

  test("4-5 源材料判定（NO-GO 原样）与标度混用告警", async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=experiments`);
    await expect(page.getByRole("heading", { name: "源材料判定（Source-Reported Verdict）" })).toBeVisible();
    await expect(page.getByText(/NO-GO/).first()).toBeVisible();
    await expect(page.getByText(/PaperTeam 不重算、不解读/)).toBeVisible();
    await expect(page.getByText(/疑似标度混用/).first()).toBeVisible();
    await shots(page, "02-verdict-and-warning");
  });

  test("6-8 作者角色修改 → 分组确认 → workflow-context 有界", async ({ page, request }) => {
    await page.goto(`/projects/${projectId}?tab=experiments`);

    // 机会行流（JSONL）由作者登记为结果数据（图表数据集入口；指标观测被行流守卫挡住）
    const streamRow = page.locator("tr", { hasText: "cps_opportunities.jsonl" });
    await streamRow.locator("select").first().selectOption("main_result");
    await expect(streamRow.locator("select").first()).toHaveValue("main_result");
    const groupInput = streamRow.locator("input");
    await groupInput.fill("opp-universe");
    await groupInput.blur();
    await expect(streamRow.locator("input")).toHaveValue("opp-universe");

    // A0 原生 TrackEval 表 → baseline（表格观测经行列锚进入）
    const a0Row = page.locator("tr", { hasText: "results/A0/pedestrian_summary.txt" });
    await a0Row.locator("select").first().selectOption("baseline_result");
    const a0Group = a0Row.locator("input");
    await a0Group.fill("baseline-a0");
    await a0Group.blur();

    for (const groupId of ["main", "opp-universe", "baseline-a0"]) {
      const groupItem = page.locator("section li").filter({ has: page.locator("strong", { hasText: groupId }) });
      await groupItem.getByRole("button", { name: "确认此组" }).click();
      await expect(page.getByText(/作者确认已保存/)).toBeVisible({ timeout: 30_000 });
    }
    await shots(page, "03-confirmed");

    // workflow-context：作者确认的观测、有界、不混入行流特征
    const context = await request.get(`/api/projects/${projectId}/experiment-packages/workflow-context`);
    expect(context.ok()).toBeTruthy();
    const body = await context.json() as { status: string; truncated: boolean; observations: Array<{ metric: string; value: number; path: string }> };
    expect(body.status).toBe("author_confirmed_not_externally_verified");
    expect(body.observations.length).toBeGreaterThan(0);
    expect(body.observations.length).toBeLessThanOrEqual(100);
    expect(body.observations.some((observation) => observation.path === "phase9/results/phase9_0/metrics.json")).toBe(true);
    expect(body.observations.every((observation) => observation.path !== "phase9/results/phase9_0/cps_opportunities.jsonl")).toBe(true);
  });

  test("9-11 真实数据集 → pgfplots 散点图（真实 XeLaTeX）→ PDF 可读", async ({ page, request }) => {
    await page.goto(`/projects/${projectId}?tab=figures`);
    const datasetSelect = page.getByTestId("plot-dataset-select");
    await expect(datasetSelect).toBeVisible({ timeout: 30_000 });
    // 机会行流数据集（2074 行）
    const options = datasetSelect.locator("option");
    const oppOption = options.filter({ hasText: /cps_opportunities/ }).first();
    await expect(oppOption).toBeVisible({ timeout: 30_000 });
    await datasetSelect.selectOption({ label: (await oppOption.textContent()) ?? "" });

    await page.getByTestId("plot-type-select").selectOption("scatter");
    await page.getByTestId("plot-x-select").selectOption("score");
    await page.getByTestId("plot-series-list").locator(".chip-select", { hasText: "cos_query_cand" }).locator("input").check();
    await page.getByTestId("plot-xlabel").fill("detection score");
    await page.getByTestId("plot-ylabel").fill("cos(query, candidate)");
    await page.getByTestId("plot-caption").fill("Opportunity verification cosine versus detection score (author-confirmed experiment package data).");
    await shots(page, "04-plot-builder");
    await page.getByTestId("plot-generate").click();

    const figureRow = page.getByTestId("figure-row").first();
    await expect(figureRow).toBeVisible({ timeout: 180_000 });
    const figId = ((await figureRow.locator("code").first().textContent()) ?? "").trim();
    expect(figId).toMatch(/^fig-/);
    await shots(page, "05-figure-library");

    // PDF 可读性：真实字节 + %PDF magic
    const pdf = await request.get(`/api/projects/${projectId}/figures/generated/${encodeURIComponent(`${figId}.pdf`)}`);
    expect(pdf.ok()).toBeTruthy();
    const bytes = await pdf.body();
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    await figureRow.getByTestId(`figure-preview-toggle-${figId}`).click();
    await expect(page.getByTestId("figure-preview")).toBeVisible();
    await shots(page, "06-figure-preview");
  });

  test("12 清理：归档隔离项目", async ({ page, request }) => {
    test.skip(projectId === "", "no project");
    const archived = await request.post(`/api/projects/${projectId}/archive`);
    expect([200, 204]).toContain(archived.status());
  });
});
