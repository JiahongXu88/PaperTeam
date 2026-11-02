import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./fixtures.js";

/**
 * M15 TJA：目标期刊评估浏览器 E2E（scripted 栈，零真实模型）。
 *
 * 运行前提（与 m15-quality-report.spec 同一 scripted 栈）：
 *   PAPERTEAM_TEST_RUNTIME=scripted PAPERTEAM_PORT=3100 PAPERTEAM_RUNTIME_ROOT=<隔离> PROJECTS_ROOT=<隔离> node backend/dist/index.js
 *   cd frontend && PAPERTEAM_PORT=3100 npx vite
 * 然后 PAPERTEAM_E2E_TJA=1 PAPERTEAM_E2E_PROJECTS_ROOT=<同一 PROJECTS_ROOT> 运行。
 *
 *   J1 选择 CJIG（官方快照 profile 可信）→ 评估违规稿 → 打开报告：已证实阻断、官方原句与来源、未评估项 / 作者确认项可见
 *      → 勾选可改写条目 → 转入修改意见队列（服务端 source=target_journal）；不可改写条目没有勾选框
 *   J2 正确阻断：同稿选 PLOS ONE + 叙述性综述 → 稿型 VERIFIED_MISMATCH + 语言不符 → BLOCKED
 *   J3 陈旧拒绝：评估后改稿 → 再转入 → 页面显示 409 错误，不进入队列
 */

const ENABLED = process.env.PAPERTEAM_E2E_TJA === "1";
const PROJECTS_ROOT = process.env.PAPERTEAM_E2E_PROJECTS_ROOT ?? "";

const TEX = [
  String.raw`\documentclass{article}`,
  String.raw`\title{基于深度学习的一种复杂交通场景多目标跟踪方法研究}`,
  String.raw`\begin{document}`,
  String.raw`\begin{abstract}目的：针对遮挡问题展开研究。方法：采用运动补偿，见\cite{r1}与图1。结果：HOTA 提升 3.1。结论：方法有效。\end{abstract}`,
  String.raw`\section{引言}多目标跟踪是计算机视觉中的重要问题。`,
  String.raw`\section{实验}\begin{table}\caption{结果}\end{table}`,
  String.raw`\bibliography{references}`,
  String.raw`\end{document}`,
].join("\n");
const BIB = Array.from({ length: 8 }, (_, i) => `@article{r${i},\n  title={T${i}},\n  year={2023},\n  doi={10.1000/x${i}}\n}\n`).join("\n");

test.describe.serial("M15 TJA：目标期刊评估", () => {
  test.skip(!ENABLED, "PAPERTEAM_E2E_TJA 未设置（需要 scripted dev 栈）");
  test.skip(PROJECTS_ROOT === "", "需要 PAPERTEAM_E2E_PROJECTS_ROOT 以写入测试稿件");
  let projectId = "";

  test("J1 选择期刊 → 可信 profile → 评估 → 报告 → 逐条转入受控修订", async ({ page, request }) => {
    const created = await request.post("/api/projects", { data: { title: `TJA 期刊评估 ${Date.now().toString(36)}` } });
    projectId = ((await created.json()) as { project: { id: string } }).project.id;
    const dir = join(PROJECTS_ROOT, projectId, "manuscript");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.tex"), TEX, "utf8");
    writeFileSync(join(dir, "references.bib"), BIB, "utf8");

    await page.goto(`/projects/${projectId}?tab=target`);
    const panel = page.getByTestId("journal-assessment-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId("journal-assessment-empty")).toBeVisible();
    await panel.getByTestId("journal-select").selectOption("cjig");
    await expect(panel.getByTestId("journal-profile-trust")).toHaveAttribute("data-status", /VERIFIED_SNAPSHOT|VERIFIED_LIVE/);
    await panel.getByTestId("journal-article-type").selectOption("research");
    await panel.getByTestId("journal-evaluate").click();

    const report = panel.getByTestId("journal-assessment-report");
    await expect(report).toHaveAttribute("data-verdict", "BLOCKED_BY_VERIFIED_ISSUE", { timeout: 30_000 });
    await expect(panel.getByTestId("journal-external-validity")).toContainText("独立人类标签 0");
    const noRefs = panel.getByTestId("journal-criterion-rule:cjig-abstract-no-refs");
    await expect(noRefs).toHaveAttribute("data-status", "VIOLATED");
    await expect(noRefs).toHaveAttribute("data-evidence", "verified");
    await noRefs.locator("summary").click();
    await expect(noRefs).toContainText("参考文献号");
    await expect(noRefs.getByRole("link", { name: "官方来源" })).toHaveAttribute("href", "http://www.cjig.cn/zh/info/13448/");
    // 未评估 / 作者确认项可见（图片 dpi、三线表无法从源码判定）
    await expect(panel.getByTestId("journal-criterion-rule:cjig-figures-dpi-3line")).toHaveAttribute("data-status", "NOT_EVALUATED");
    await expect(panel.getByTestId("journal-unknowns")).toContainText("需作者确认");
    // 质量门禁未运行 → B 块如实未评估
    await expect(panel.getByTestId("journal-risk-qr:missing")).toHaveAttribute("data-evidence", "unassessed");
    // 文献不足需作者补真实文献：没有勾选框
    await expect(panel.getByTestId("journal-select-rule:cjig-refs-15")).toHaveCount(0);

    await panel.getByTestId("journal-select-rule:cjig-abstract-no-refs").check();
    await panel.getByTestId("journal-convert").click();
    await expect(panel.getByTestId("journal-message")).toContainText("已转入修改意见队列 1 条");
    const queue = (await (await request.get(`/api/projects/${projectId}/external-instructions`)).json()) as { instructions: Array<{ source: string; text: string; status: string }> };
    const added = queue.instructions.filter((item) => item.source === "target_journal");
    expect(added).toHaveLength(1);
    expect(added[0]!.status).toBe("pending");
    expect(added[0]!.text).toContain("不构成任何数值修改授权");
    mkdirSync("shots", { recursive: true });
    await page.screenshot({ path: "shots/tja-j1-report.png", fullPage: true });
  });

  test("J2 正确阻断：中文叙述性综述投 PLOS ONE → 稿型与语言均为已证实不匹配", async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=target`);
    const panel = page.getByTestId("journal-assessment-panel");
    await panel.getByTestId("journal-select").selectOption("plos-one");
    await panel.getByTestId("journal-article-type").selectOption("survey");
    await panel.getByTestId("journal-evaluate").click();
    const report = panel.getByTestId("journal-assessment-report");
    await expect(report).toContainText("PLOS ONE", { timeout: 30_000 });
    await expect(report).toHaveAttribute("data-verdict", "BLOCKED_BY_VERIFIED_ISSUE");
    await expect(panel.getByTestId("journal-fit-article_type")).toHaveAttribute("data-status", "VERIFIED_MISMATCH");
    await expect(panel.getByTestId("journal-fit-language")).toHaveAttribute("data-status", "VERIFIED_MISMATCH");
    await expect(panel.getByTestId("journal-fit-recent_publications")).toContainText("仅作正向参照");
    await page.screenshot({ path: "shots/tja-j2-plos-survey.png", fullPage: true });
  });

  test("J3 陈旧拒绝：评估后稿件变化 → 转入被 409 拒绝，不进入队列", async ({ page, request }) => {
    await page.goto(`/projects/${projectId}?tab=target`);
    const panel = page.getByTestId("journal-assessment-panel");
    await panel.getByTestId("journal-select").selectOption("plos-one");
    await panel.getByTestId("journal-article-type").selectOption("research");
    await panel.getByTestId("journal-evaluate").click();
    await expect(panel.getByTestId("journal-assessment-report")).toContainText("研究论文", { timeout: 30_000 });
    writeFileSync(join(PROJECTS_ROOT, projectId, "manuscript", "main.tex"), TEX.replace("方法有效", "方法有效且稳定"), "utf8");
    await panel.getByTestId("journal-select-rule:plos-abstract-no-cite").check();
    await panel.getByTestId("journal-convert").click();
    await expect(panel.getByRole("alert")).toContainText("稿件在评估之后已变化");
    const queue = (await (await request.get(`/api/projects/${projectId}/external-instructions`)).json()) as { instructions: Array<{ source: string }> };
    expect(queue.instructions.filter((item) => item.source === "target_journal")).toHaveLength(1);
  });
});
