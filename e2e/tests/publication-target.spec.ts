import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./fixtures.js";

/**
 * 发表目标 + 审稿政策：浏览器 E2E（scripted 栈，零真实模型）。
 *
 * 运行前提（与 m15-target-journal.spec 同一 scripted 栈）：
 *   PAPERTEAM_TEST_RUNTIME=scripted PAPERTEAM_PORT=3100 PAPERTEAM_RUNTIME_ROOT=<隔离> PROJECTS_ROOT=<隔离> node backend/dist/index.js
 *   cd frontend && PAPERTEAM_PORT=3100 npx vite
 * 然后 PAPERTEAM_E2E_PUBTARGET=1 运行（可选 PAPERTEAM_E2E_SHOTS=<目录> 保存验收截图）。
 *
 *   P1 创建新论文：选择 中科院 · 三区 + 已核验期刊 → 项目概览显示目标与「未核实」提示
 *   P2 修改目标：改为 JCR Q1 → 编辑态提示「只影响下一次运行」→ 保存后概览更新；非法组合由前端拦截
 *   P3 页面不出现「100% 达刊 / 保证录用」类表述
 */

const ENABLED = process.env.PAPERTEAM_E2E_PUBTARGET === "1";
const SHOTS = process.env.PAPERTEAM_E2E_SHOTS ?? "";

test.describe.serial("发表目标 + 审稿政策", () => {
  test.skip(!ENABLED, "PAPERTEAM_E2E_PUBTARGET 未设置（需要 scripted dev 栈）");
  let projectUrl = "";

  test("P1 创建新论文时设置发表目标 → 概览如实标注未核实", async ({ page }) => {
    await page.goto("/projects/new");
    const form = page.getByTestId("research-article-form");
    await expect(form).toBeVisible();
    await form.getByLabel("论文标题").fill(`发表目标 E2E ${Date.now().toString(36)}`);
    const scheme = form.getByLabel("目标发表体系（可选）");
    await expect(scheme).toBeEnabled();
    await scheme.selectOption("cas");
    await form.getByLabel("层级").selectOption("3");
    await form.getByLabel("名单 / 分区年份").fill("2025");
    await form.getByLabel("目标期刊（可选）").selectOption("verified");
    await form.getByLabel("已核验期刊").selectOption("cjig");
    await expect(form.getByTestId("publication-target-help")).toContainText("不预测录用");
    if (SHOTS !== "") {
      mkdirSync(SHOTS, { recursive: true });
      await form.getByTestId("publication-target-fields").screenshot({ path: join(SHOTS, "01-create-publication-target.png") });
    }
    await form.getByRole("button", { name: "创建项目" }).click();
    await page.waitForURL(/\/projects\/p-[a-z0-9]+/);
    projectUrl = page.url();

    const card = page.getByTestId("publication-target-card");
    await expect(card.getByTestId("publication-target-current")).toHaveText(/中科院三区（2025 年名单） · 中国图象图形学报/);
    await expect(card.getByTestId("publication-target-unverified")).toContainText("系统未核实");
    if (SHOTS !== "") await card.screenshot({ path: join(SHOTS, "02-project-publication-target.png") });
  });

  test("P2 修改发表目标 → 只影响下一次运行；前端拦截缺层级", async ({ page }) => {
    await page.goto(projectUrl);
    const card = page.getByTestId("publication-target-card");
    await card.getByTestId("publication-target-edit").click();
    await expect(card).toContainText("新设置只影响下一次审稿 / 修订运行");
    await card.getByLabel("目标发表体系（可选）").selectOption("jcr");
    await card.getByTestId("publication-target-save").click();
    await expect(card.getByRole("alert")).toContainText("请选择层级");
    await card.getByLabel("层级").selectOption("Q1");
    await card.getByTestId("publication-target-save").click();
    await expect(card.getByTestId("publication-target-current")).toHaveText(/JCR Q1（2025 年名单）/);
  });

  test("P3 无录用承诺 / 达刊措辞", async ({ page }) => {
    await page.goto(projectUrl);
    await expect(page.getByTestId("publication-target-card")).toBeVisible();
    const text = (await page.locator("body").innerText()).replace(/\s+/g, "");
    expect(text).not.toMatch(/100%达|保证录用|录用概率[:：]?\d/);
  });
});
