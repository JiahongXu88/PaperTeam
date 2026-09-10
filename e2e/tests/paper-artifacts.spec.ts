import type { APIRequestContext, Page } from "@playwright/test";

import { expect, primeTheme, resolvePdfPath, test } from "./fixtures.js";

/**
 * M4.7 论文产出闭环 E2E（Draft / Final + Writer–Reviewer 修订闭环）。
 *
 * 运行前提（scripted 栈 + 本机真实 LaTeX）：
 *   PAPERTEAM_TEST_RUNTIME=scripted CITATION_METADATA_ENABLED=0 \
 *   PAPERTEAM_PORT=3100 PAPERTEAM_RUNTIME_ROOT=<隔离目录> PROJECTS_ROOT=<隔离目录> \
 *   node backend/dist/index.js
 *   cd frontend && PAPERTEAM_PORT=3100 npx vite
 * 机器需有真实 latexmk（MiKTeX/TeX Live）；编译是真实调用（不用 fakebin）。
 * 场景由 researchIdea 内嵌标记驱动（scriptedRuntime 按项目转向）：
 *   [review:pass,fail2,...]  审稿轮次序列；[latex:broken] / [latex:unfixable]
 *   引入真实编译错误（修复成功 / 修复耗尽）。然后 PAPERTEAM_E2E_PAPER=1 运行。
 *
 * 用例（编排 / checkpoint / 确定性 gate / LaTeX 编译 / HTTP / React 全部真实，
 * 只有模型输出是脚本）：
 *   A gate 通过 → 真实编译 → Final 冻结（查看 inline / 下载 attachment / 历史）
 *   C fail → 计划 → 修订 → 复审通过 → Final（迭代收敛轨迹）
 *   D REGRESSION → stalled HITL（两轮记分卡对比）→ 接受为草稿
 *   E CONVERGED → stalled HITL → 接受为草稿
 *   F 自动修订预算耗尽 → overflow HITL → accept_draft
 *   B（复用 F 项目）Draft 语义：质量门禁不阻塞 Draft；finalize 422 拒绝如实呈现
 *   G 真实编译失败 → bounded 修复成功 → 复审 → 重编译通过 → Final
 *   H 修复耗尽 → Build FAIL → overflow（buildOk=false）→ 无 PDF；finalize BUILD 拒绝
 *   I 快速 Review 只读：无论文产出 tab；完成后仍零产物（产品红线）
 *   J Light / Dark 视觉 + 1100px 无横向溢出（复用 A 项目）
 */

const ENABLED = process.env.PAPERTEAM_E2E_PAPER === "1";

type PageFixture = Page;
type RequestFixture = APIRequestContext;

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function createIdeaProject(
  request: RequestFixture,
  title: string,
  researchIdea: string,
): Promise<string> {
  const created = await request.post("/api/projects", { data: { title, researchIdea } });
  expect(created.ok()).toBeTruthy();
  return ((await created.json()) as { project: { id: string } }).project.id;
}

async function startRun(
  request: RequestFixture,
  projectId: string,
  kind: "idea_to_paper" | "existing_paper_review" = "idea_to_paper",
): Promise<string> {
  const response = await request.post(`/api/projects/${projectId}/workflows`, {
    data: { kind },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { runId: string }).runId;
}

interface RunState {
  status: string;
  currentStage?: string;
  completion?: { label: string } | null;
  error?: { message: string } | null;
}

async function runState(request: RequestFixture, runId: string): Promise<RunState> {
  const response = await request.get(`/api/runs/${runId}`);
  return ((await response.json()) as { run: RunState }).run;
}

async function waitRunStatus(
  request: RequestFixture,
  runId: string,
  statuses: string[],
  timeoutMs = 180_000,
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

/** 通过 API 确认可行性 + 大纲两个 HITL（面板交互已由 M4.5 hitl.spec 覆盖） */
async function approveOutlineGates(request: RequestFixture, runId: string): Promise<void> {
  for (let index = 0; index < 2; index += 1) {
    const run = await waitRunStatus(request, runId, ["awaiting_input", "completed", "failed", "cancelled"], 60_000);
    if (run.status !== "awaiting_input") {
      break;
    }
    const resumed = await request.post(`/api/runs/${runId}/resume`, { data: { decision: "approve" } });
    expect(resumed.ok()).toBeTruthy();
  }
}

/** 走到修订决策 HITL（stalled / overflow），返回 awaiting 的 stageId */
async function waitRevisionHitl(
  request: RequestFixture,
  runId: string,
): Promise<string> {
  for (;;) {
    const run = await runState(request, runId);
    if (run.status === "failed") {
      throw new Error(`run 意外失败：${run.error?.message ?? "?"} @ ${run.currentStage ?? "?"}`);
    }
    if (run.status === "awaiting_input" && (run.currentStage ?? "").startsWith("hitl.revision")) {
      return run.currentStage ?? "";
    }
    if (run.status === "completed") {
      throw new Error(`run 提前完成（未经过修订 HITL）：${run.completion?.label ?? "?"}`);
    }
    await delay(300);
  }
}

async function cleanupProject(request: RequestFixture, projectId: string): Promise<void> {
  if (projectId === "") {
    return;
  }
  await request.post(`/api/projects/${projectId}/archive`).catch(() => {});
  await request.delete(`/api/projects/${projectId}`).catch(() => {});
}

async function gotoPaperTab(page: PageFixture, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}?tab=paper`);
  await expect(page.getByTestId("paper-panel")).toBeVisible({ timeout: 30_000 });
}

const STAMP = `${Date.now().toString(36)}`;

test.describe.serial("M4.7 论文产出闭环（scripted + 真实 LaTeX）", () => {
  test.skip(!ENABLED, "PAPERTEAM_E2E_PAPER 未设置（需要 scripted dev 栈 + 本机 latexmk）");

  let projectA = ""; // J 复用
  let projectBF = ""; // B 复用 F 的终态
  const projects: string[] = [];

  test.afterAll(async ({ request }) => {
    for (const id of [...projects].reverse()) {
      await cleanupProject(request, id);
    }
  });

  test("A gate 通过 → 真实编译 → Final 冻结 + 查看 / 下载 / 产物历史", async ({ page, request }) => {
    test.setTimeout(240_000);
    projectA = await createIdeaProject(
      request,
      `M4.7 A Final ${STAMP}`,
      "小语料 RAG 评估协议研究 [review:pass]",
    );
    projects.push(projectA);
    const runId = await startRun(request, projectA);
    await approveOutlineGates(request, runId);
    const run = await waitRunStatus(request, runId, ["completed"]);
    expect(run.completion?.label).toBe("final");

    await gotoPaperTab(page, projectA);
    // Final 卡：冻结于通过双 Gate 的修订（outline=rev1、写作=rev2；本轮无修订轮）
    const finalCard = page.getByTestId("final-card");
    await expect(finalCard).toContainText("已冻结");
    await expect(finalCard).toContainText("rev 2");
    await expect(finalCard).toContainText("第 1 轮通过");
    // Draft 卡同修订可用（质量门禁通过不影响 Draft 语义）
    await expect(page.getByTestId("draft-card")).toContainText("可用");
    // 构建状态：真实 latexmk 通过、对齐当前修订
    await expect(page.getByTestId("build-outcome")).toHaveText(/构建通过/);
    await expect(page.getByTestId("build-status")).toContainText(/latexmk|xelatex/);
    await expect(page.getByTestId("build-status")).toContainText("对齐当前修订");
    // 迭代历史：单轮已通过
    const iterations = page.getByTestId("iterations-card");
    await expect(iterations.locator('[data-testid="iteration-item"]')).toHaveCount(1);
    await expect(iterations.locator('[data-testid="iteration-outcome"]')).toHaveText("已通过");

    // 查看 PDF：新标签页（inline URL，浏览器原生 viewer；不先落盘）
    const popupPromise = page.waitForEvent("popup");
    await page.getByTestId("final-view").click();
    const popup = await popupPromise;
    expect(popup.url()).toContain(`/api/projects/${projectA}/artifacts/`);
    expect(popup.url()).toContain("/download");
    expect(popup.url()).not.toContain("disposition=attachment");
    await popup.close();

    // 下载：attachment 头（经 vite 代理返回真实 PDF）
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("final-download").click();
    const download = await downloadPromise;
    expect(download.url()).toContain("disposition=attachment");
    expect(download.suggestedFilename()).toMatch(/^art-final-rev2\.pdf$/);

    // 产物历史：Draft + Final 两条，不可变清单
    const history = page.getByTestId("artifact-history");
    await expect(history).toContainText("2 个");
    await expect(history).toContainText("Final");
    await expect(history).toContainText("Draft");
  });

  test("C 修订闭环：fail → 计划修订 → 复审通过 → Final；迭代呈现收敛轨迹", async ({ page, request }) => {
    test.setTimeout(300_000);
    const projectId = await createIdeaProject(
      request,
      `M4.7 C 修订闭环 ${STAMP}`,
      "修订两轮后通过的研究 [review:fail,fail2,pass]",
    );
    projects.push(projectId);
    const runId = await startRun(request, projectId);
    await approveOutlineGates(request, runId);
    const run = await waitRunStatus(request, runId, ["completed"], 240_000);
    expect(run.completion?.label).toBe("final");

    await gotoPaperTab(page, projectId);
    // 两轮修订 → Final 冻结于 rev 3（修订按内容哈希幂等：第二轮 Writer 输出与
    // 已写入内容相同 → 不再新增修订号，但复审照常重跑——修订后必须复审）
    const finalCard = page.getByTestId("final-card");
    await expect(finalCard).toContainText("已冻结");
    await expect(finalCard).toContainText("rev 3");
    await expect(finalCard).toContainText("第 3 轮通过");
    // 迭代历史（新→旧）：已通过 / 有实质改善 / 首轮
    const outcomes = page.getByTestId("iterations-card").locator('[data-testid="iteration-outcome"]');
    await expect(outcomes).toHaveCount(3);
    await expect(outcomes.nth(0)).toHaveText("已通过");
    await expect(outcomes.nth(1)).toHaveText("有实质改善");
    await expect(outcomes.nth(2)).toHaveText("首轮");
  });

  test("D 退化：REGRESSION → stalled HITL（两轮对比）→ 接受为草稿", async ({ page, request }) => {
    test.setTimeout(240_000);
    const projectId = await createIdeaProject(
      request,
      `M4.7 D 退化 ${STAMP}`,
      "修订后出现退化的研究 [review:fail2,fail]",
    );
    projects.push(projectId);
    const runId = await startRun(request, projectId);
    await approveOutlineGates(request, runId);

    const stageId = await waitRevisionHitl(request, runId);
    expect(stageId).toBe("hitl.revision_stalled");
    await page.goto(`/projects/${projectId}?tab=workflow`);
    const stalled = page.getByTestId("hitl-payload-stalled");
    await expect(stalled).toBeVisible({ timeout: 30_000 });
    await expect(stalled).toContainText("出现退化");
    await expect(stalled).toContainText("本轮修订后出现了新的严重问题或评分大幅下滑");
    // 两轮记分卡对比表（上一轮 + 本轮）
    const scorecard = page.getByTestId("hitl-scorecard");
    await expect(scorecard).toContainText("第 1 轮");
    await expect(scorecard).toContainText("第 2 轮");

    await page.getByTestId("hitl-accept-draft").click();
    const run = await waitRunStatus(request, runId, ["completed"]);
    expect(run.completion?.label).toBe("draft");

    await gotoPaperTab(page, projectId);
    await expect(page.getByTestId("draft-card")).toContainText("可用");
    await expect(page.getByTestId("final-card")).toContainText("尚未冻结");
  });

  test("E 不收敛：CONVERGED → stalled HITL → 接受为草稿 → Draft", async ({ page, request }) => {
    test.setTimeout(240_000);
    const projectId = await createIdeaProject(
      request,
      `M4.7 E 不收敛 ${STAMP}`,
      "连续两轮无实质改善的研究 [review:fail,fail]",
    );
    projects.push(projectId);
    const runId = await startRun(request, projectId);
    await approveOutlineGates(request, runId);

    const stageId = await waitRevisionHitl(request, runId);
    expect(stageId).toBe("hitl.revision_stalled");
    await page.goto(`/projects/${projectId}?tab=workflow`);
    const stalled = page.getByTestId("hitl-payload-stalled");
    await expect(stalled).toBeVisible({ timeout: 30_000 });
    await expect(stalled).toContainText("不再收敛");
    await expect(stalled).toContainText("连续两轮修订没有实质改善");

    await page.getByTestId("hitl-accept-draft").click();
    const run = await waitRunStatus(request, runId, ["completed"]);
    expect(run.completion?.label).toBe("draft");

    await gotoPaperTab(page, projectId);
    await expect(page.getByTestId("draft-card")).toContainText("可用");
    await expect(page.getByTestId("draft-card")).toContainText("当前版本可以作为 Draft，但尚未满足 Final 要求");
  });

  test("F 自动修订预算耗尽 → overflow HITL → accept_draft", async ({ page, request }) => {
    test.setTimeout(300_000);
    projectBF = await createIdeaProject(
      request,
      `M4.7 F 预算耗尽 ${STAMP}`,
      "持续改善但不过线的研究 [review:fail,fail2,fail3]",
    );
    projects.push(projectBF);
    const runId = await startRun(request, projectBF);
    await approveOutlineGates(request, runId);

    const stageId = await waitRevisionHitl(request, runId, 240_000);
    expect(stageId).toBe("hitl.revision_overflow");
    await page.goto(`/projects/${projectBF}?tab=workflow`);
    const overflow = page.getByTestId("hitl-payload-overflow");
    await expect(overflow).toBeVisible({ timeout: 30_000 });
    await expect(overflow).toContainText("未通过");
    // 决策动作：接受为草稿 / 再修一轮 / 取消（无 approve）
    await expect(page.getByTestId("hitl-accept-draft")).toBeVisible();
    await expect(page.getByTestId("hitl-revise-more")).toBeVisible();
    await expect(page.getByTestId("hitl-approve")).toHaveCount(0);

    await page.getByTestId("hitl-accept-draft").click();
    const run = await waitRunStatus(request, runId, ["completed"]);
    expect(run.completion?.label).toBe("draft");
  });

  test("B Draft 语义：质量门禁不阻塞 Draft；finalize 拒绝如实呈现（不出现错误语义）", async ({ page, request }) => {
    test.setTimeout(120_000);
    // 复用 F 的终态：Build PASS + Quality FAIL 的 Draft
    await gotoPaperTab(page, projectBF);
    const draftCard = page.getByTestId("draft-card");
    await expect(draftCard).toContainText("可用");
    await expect(draftCard).toContainText("当前版本可以作为 Draft，但尚未满足 Final 要求");
    await expect(page.getByTestId("final-card")).toContainText("尚未冻结");
    await expect(page.getByTestId("build-outcome")).toHaveText(/构建通过/);
    // 迭代轨迹：首轮 → 有实质改善 ×2（fail3 较 fail2 仍有改善）
    const outcomes = page.getByTestId("iterations-card").locator('[data-testid="iteration-outcome"]');
    await expect(outcomes).toHaveCount(3);
    await expect(outcomes.nth(0)).toHaveText("有实质改善");
    await expect(outcomes.nth(2)).toHaveText("首轮");

    // 标记 Final：按钮永远可点，资格由后端判定 → 422 拒绝 + 可行动文案
    await page.getByTestId("finalize-button").click();
    const error = page.getByTestId("finalize-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText("尚未满足 Final 要求");
    await expect(error).toContainText("当前版本可以作为 Draft");
    // 红线：绝不出现「质量门禁未通过，因此 PDF 无法生成」这类错误语义
    expect((await error.textContent()) ?? "").not.toContain("因此 PDF 无法生成");
    // 编译日志按需拉取（真实 compile.log）
    await page.getByTestId("build-log-toggle").click();
    await expect(page.getByTestId("build-log")).toBeVisible({ timeout: 15_000 });
  });

  test("G 真实编译失败 → bounded 修复成功 → 复审 → 重编译通过 → Final", async ({ page, request }) => {
    test.setTimeout(360_000);
    const projectId = await createIdeaProject(
      request,
      `M4.7 G 修复成功 ${STAMP}`,
      "首轮编译出错可修复的研究 [review:pass] [latex:broken]",
    );
    projects.push(projectId);
    const runId = await startRun(request, projectId);
    await approveOutlineGates(request, runId);
    const run = await waitRunStatus(request, runId, ["completed"], 300_000);
    expect(run.completion?.label).toBe("final");

    // 时间线：修复 stage 真实完成（真实 xelatex 失败 → 诊断 → 修复 → 复审 → 通过）
    await page.goto(`/projects/${projectId}?tab=workflow`);
    const timeline = page.getByTestId("stage-timeline");
    await expect(timeline.locator('[data-stage="revision.repair_latex"]')).toHaveAttribute(
      "data-stage-state",
      "completed",
      { timeout: 30_000 },
    );
    await gotoPaperTab(page, projectId);
    await expect(page.getByTestId("final-card")).toContainText("已冻结");
    await expect(page.getByTestId("build-outcome")).toHaveText(/构建通过/);
  });

  test("H 修复耗尽 → Build FAIL → overflow（buildOk=false）→ 无 PDF；finalize BUILD 拒绝", async ({ page, request }) => {
    test.setTimeout(420_000);
    const projectId = await createIdeaProject(
      request,
      `M4.7 H 修复耗尽 ${STAMP}`,
      "编译持续失败的研究 [review:pass] [latex:unfixable]",
    );
    projects.push(projectId);
    const runId = await startRun(request, projectId);
    await approveOutlineGates(request, runId);

    const stageId = await waitRevisionHitl(request, runId, 360_000);
    expect(stageId).toBe("hitl.revision_overflow");
    await page.goto(`/projects/${projectId}?tab=workflow`);
    const overflow = page.getByTestId("hitl-payload-overflow");
    await expect(overflow).toBeVisible({ timeout: 30_000 });
    // 如实告知构建失败（不产 PDF）
    await expect(overflow).toContainText("编译失败");

    await page.getByTestId("hitl-accept-draft").click();
    const run = await waitRunStatus(request, runId, ["completed"]);
    expect(run.completion?.label).toBe("draft");

    await gotoPaperTab(page, projectId);
    // 无 PDF：空态引导；构建失败如实呈现（末次构建因 latexmk 目标缓存只剩错误
    // 摘要、无结构化诊断 → reasons 面板；compile.log 证明真实 latexmk 在跑）
    await expect(page.getByTestId("artifact-empty")).toBeVisible();
    await expect(page.getByTestId("build-outcome")).toHaveText(/构建失败/);
    await expect(page.getByTestId("build-reasons")).toContainText("LaTeX 编译失败");
    await page.getByTestId("build-log-toggle").click();
    await expect(page.getByTestId("build-log")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("build-log")).toContainText("Latexmk");
    // finalize → BUILD_GATE 拒绝
    await page.getByTestId("finalize-button").click();
    const error = page.getByTestId("finalize-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText("构建未通过");
  });

  test("I 快速 Review 只读：无论文产出 tab；完成后仍零产物", async ({ page, request }) => {
    test.setTimeout(420_000);
    await page.goto("/projects/new");
    await page.getByRole("radio", { name: /导入已有论文/ }).check();
    await page.getByLabel("选择论文 PDF（.pdf）").setInputFiles(resolvePdfPath());
    await page.getByRole("button", { name: "导入论文" }).click();
    // review_only 导入成功后导航到 /projects/:id?tab=review
    await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+\?tab=review/, { timeout: 90_000 });
    const projectId = new URL(page.url()).pathname.split("/").pop() ?? "";
    projects.push(projectId);

    // 只读红线：快速 Review 不暴露论文产出 tab（不产出 Draft / Final）
    await expect(page.getByRole("tab", { name: "论文产出" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Review" })).toBeVisible();
    const artifacts = await request.get(`/api/projects/${projectId}/artifacts`);
    expect(((await artifacts.json()) as { artifacts: unknown[] }).artifacts).toHaveLength(0);

    // 完整跑完快速 Review：完成后依旧零产物（始终只读）
    const runId = await startRun(request, projectId, "existing_paper_review");
    await waitRunStatus(request, runId, ["completed"], 360_000);
    await page.reload();
    await expect(page.getByRole("tab", { name: "论文产出" })).toHaveCount(0);
    const after = await request.get(`/api/projects/${projectId}/artifacts`);
    expect(((await after.json()) as { artifacts: unknown[] }).artifacts).toHaveLength(0);
  });

  test("J Light / Dark 视觉 + 1100px 无横向溢出", async ({ page }) => {
    test.setTimeout(120_000);
    // 复用 A 项目（Final 已冻结的完整形态）
    await gotoPaperTab(page, projectA);
    await page.screenshot({ path: "shots/m47-paper-final-light.png", fullPage: true });

    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // Dark：构建状态 + 迭代历史一并入镜
    await page.setViewportSize({ width: 1440, height: 900 });
    await primeTheme(page, "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByTestId("paper-panel")).toBeVisible();
    await page.screenshot({ path: "shots/m47-paper-final-dark.png", fullPage: true });
  });
});
