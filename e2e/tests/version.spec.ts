import type { APIRequestContext, Page } from "@playwright/test";

import { expect, primeTheme, test } from "./fixtures.js";

/**
 * M4.8 版本体验 E2E（版本历史 / 确定性比较 / 不可变恢复）。
 *
 * 运行前提（scripted 栈 + 本机真实 LaTeX）：
 *   PAPERTEAM_TEST_RUNTIME=scripted CITATION_METADATA_ENABLED=0 \
 *   PAPERTEAM_PORT=3100 PAPERTEAM_RUNTIME_ROOT=<隔离目录> PROJECTS_ROOT=<隔离目录> \
 *   node backend/dist/index.js
 *   cd frontend && PAPERTEAM_PORT=3100 npx vite
 * 然后以 PAPERTEAM_E2E_VERSION=1 运行本套件（其它环境自动跳过）。
 *
 * 场景由 researchIdea 内嵌标记驱动（[review:...] 审稿轮次序列；见 scriptedRuntime）。
 *
 * 用例（编排 / 版本域 / HTTP / React 全部真实，只有模型输出是脚本）：
 *   A 多修订项目的版本历史正确展示（当前版本 / Final / 来源 / 门禁）
 *   B 比较 上一版 → 当前版：修改章节 + 规模 + scorecard 对照（确定性）
 *   C 恢复历史修订 → 生成新修订；旧修订与产物不变（API 权威核验）
 *   D 恢复后旧 Gate stale：Finalize 被如实拒绝（不偷用旧结论）
 *   E Final 后继续（恢复产生）新修订：旧 Final 仍在；当前版本不是 Final
 *   F 重新通过 Gate → 产生新 Final；两份 Final 并存为历史事实
 *   V Light / Dark 视觉 + 1100px 无横向溢出（版本历史 / 比较 / 恢复确认）
 */

const ENABLED = process.env.PAPERTEAM_E2E_VERSION === "1";
const SHOTS_DIR = process.env.PAPERTEAM_E2E_SHOTS_DIR ?? "shots";

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

async function startRun(request: RequestFixture, projectId: string): Promise<string> {
  const response = await request.post(`/api/projects/${projectId}/workflows`, {
    data: { kind: "idea_to_paper" },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { runId: string }).runId;
}

interface RunState {
  status: string;
  currentStage?: string;
  completion?: { label: string } | null;
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

/** 通过 API 确认可行性 + 大纲两个 HITL（面板交互由 hitl.spec 覆盖） */
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

async function cleanupProject(request: RequestFixture, projectId: string): Promise<void> {
  if (projectId === "") {
    return;
  }
  await request.post(`/api/projects/${projectId}/archive`);
  await request.delete(`/api/projects/${projectId}`);
}

interface VersionRow {
  revision: number;
  source: string;
  restoredFrom?: number;
  isCurrent: boolean;
  isFinal: boolean;
}

async function versionsOf(request: RequestFixture, projectId: string): Promise<{ current: number; versions: VersionRow[] }> {
  const response = await request.get(`/api/projects/${projectId}/versions`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { current: number; versions: VersionRow[] };
}

test.describe.serial("M4.8 版本体验（scripted + 真实 LaTeX）", () => {
  test.skip(!ENABLED, "PAPERTEAM_E2E_VERSION 未设置（需要 scripted dev 栈）");

  const stamp = Date.now().toString(36);
  const projects: string[] = [];

  test.afterAll(async ({ request }) => {
    for (const projectId of [...projects].reverse()) {
      await cleanupProject(request, projectId);
    }
  });

  let loopProject = "";
  let finalProject = "";

  test("A 多修订项目：版本历史正确展示（当前版本 / Final / 来源 / 门禁）", async ({ page, request }) => {
    loopProject = await createIdeaProject(
      request,
      `M4.8 A 版本历史 ${stamp}`,
      `小语料 RAG 评估研究（版本体验 E2E）[review:fail,fail2,pass]`,
    );
    projects.push(loopProject);
    const runId = await startRun(request, loopProject);
    await approveOutlineGates(request, runId);
    const finished = await waitRunStatus(request, runId, ["completed", "failed", "awaiting_input"]);
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");

    const versions = await versionsOf(request, loopProject);
    // 修订链：outline(1) → sections(2) → 首轮修订(3)；后续轮内容不变时幂等不虚增
    expect(versions.current).toBeGreaterThanOrEqual(3);
    expect(versions.versions.length).toBe(versions.current);

    await page.goto(`/projects/${loopProject}?tab=paper`);
    const history = page.getByTestId("version-history");
    await expect(history).toBeVisible();
    const items = history.getByTestId("version-item");
    await expect(items).toHaveCount(versions.current);
    // 最新在前 + 当前版本标记 + Final 标记
    await expect(items.first()).toHaveAttribute("data-revision", String(versions.current));
    await expect(items.first()).toContainText("当前版本");
    await expect(items.first()).toContainText("Final");
    // 来源标签：最新为审稿修订；首稿链路为 初稿写作 / 大纲定稿（人类可读，非工程标识）
    await expect(items.first()).toContainText("审稿修订");
    await expect(items.nth(1)).toContainText("初稿写作");
    await expect(items.last()).toContainText("大纲定稿");
    // 每行有审稿/门禁事实或如实「未审稿」
    await expect(items.first()).toContainText(/门禁(通过|未通过|未评估)/);
  });

  test("B 比较 上一版 → 当前版：修改章节 + 规模 + scorecard 对照（确定性）", async ({ page, request }) => {
    const versions = await versionsOf(request, loopProject);
    const current = versions.current;
    await page.goto(`/projects/${loopProject}?tab=paper`);
    const compareBlock = page.getByTestId("version-compare-block");
    await expect(compareBlock).toBeVisible();
    // 默认 from = 上一版，to = 当前版
    await expect(page.getByTestId("compare-from")).toHaveValue(String(current - 1));
    await expect(page.getByTestId("compare-to")).toHaveValue(String(current));
    const result = page.getByTestId("version-compare-result");
    await expect(result).toBeVisible({ timeout: 20_000 });
    const table = page.getByTestId("version-compare-table");
    await expect(table).toContainText("sections/introduction.tex");
    await expect(table).toContainText("已修改");
    await expect(table).toContainText("未变化");
    // scorecard 对照（后端已有事实，前端不重算）
    const delta = page.getByTestId("version-compare-delta");
    await expect(delta).toContainText(/第 \d+ 轮审稿：严重 \d+ \/ 主要 \d+/);
    await expect(delta).toContainText("门禁未通过");

    // API 权威核验：确定性 diff 与 UI 一致
    const api = await request.get(
      `/api/projects/${loopProject}/versions/compare?from=${current - 1}&to=${current}`,
    );
    expect(api.ok()).toBeTruthy();
    const body = (await api.json()) as { summary: { modified: number; unchanged: number } };
    expect(body.summary.modified).toBeGreaterThan(0);
    expect(body.summary.unchanged).toBeGreaterThan(0);
  });

  test("C 恢复历史修订 → 新修订；旧修订与 Final 产物不变", async ({ page, request }) => {
    const before = await versionsOf(request, loopProject);
    const artifactsBefore = await (
      await request.get(`/api/projects/${loopProject}/artifacts`)
    ).json();

    await page.goto(`/projects/${loopProject}?tab=paper`);
    const restoreSource = 2;
    const row = page.locator(`[data-testid="version-item"][data-revision="${restoreSource}"]`);
    // 打开行内确认（文案如实）
    await row.getByTestId("version-restore-button").click();
    const confirm = page.getByTestId("version-restore-confirm");
    await expect(confirm).toContainText("将基于修订 2 创建新的当前修订。现有版本历史不会被删除");
    await page.getByTestId("version-restore-confirm-button").click();
    await expect(page.getByTestId("version-restore-success")).toContainText("已创建修订", { timeout: 20_000 });

    // API 权威核验：新修订追加，历史记录不动
    const after = await versionsOf(request, loopProject);
    expect(after.current).toBe(before.current + 1);
    const restored = after.versions.find((version) => version.revision === after.current);
    expect(restored).toMatchObject({ source: "revision.restore", restoredFrom: restoreSource, isCurrent: true });
    // 旧记录的不可变事实逐条不变（isCurrent 是派生指针：随恢复前进，不算历史被改）
    const immutableOf = (version: VersionRow & { createdAt?: string; hasDraft?: boolean }) => ({
      revision: version.revision,
      source: version.source,
      ...(version.restoredFrom !== undefined ? { restoredFrom: version.restoredFrom } : {}),
      isFinal: version.isFinal,
    });
    const beforeById = new Map(before.versions.map((version) => [version.revision, version]));
    for (const version of after.versions.filter((version) => version.revision <= before.current)) {
      expect(immutableOf(version)).toEqual(immutableOf(beforeById.get(version.revision)!));
    }
    // Final 产物（不可变清单）不变；旧 Final 仍是 Final 历史事实
    const artifactsAfter = await (
      await request.get(`/api/projects/${loopProject}/artifacts`)
    ).json();
    expect(artifactsAfter.artifacts).toEqual(artifactsBefore.artifacts);
    expect(after.versions.find((version) => version.revision === before.current)?.isFinal).toBe(true);
    // UI：新当前修订行展示「基于修订 2 恢复」
    await expect(page.getByTestId("version-item").first()).toContainText("基于修订 2 恢复");
  });

  test("D 恢复后旧 Gate stale：Finalize 被如实拒绝", async ({ page, request }) => {
    const versions = await versionsOf(request, loopProject);
    await page.goto(`/projects/${loopProject}?tab=paper`);
    await page.getByTestId("finalize-button").click();
    const error = page.getByTestId("finalize-error");
    await expect(error).toBeVisible({ timeout: 15_000 });
    // 旧 gate 评的不是当前修订 → 修订后必须重新审稿（不是「PDF 无法生成」）
    await expect(error).toContainText("审稿结论尚未更新");
    // API 同口径：finalize 409 拒绝
    const response = await request.post(`/api/projects/${loopProject}/finalize`, { data: {} });
    expect(response.status()).toBe(409);
    expect(versions.current).toBeGreaterThan(0);
  });

  test("E Final 后产生新修订：旧 Final 仍在；当前版本不是 Final", async ({ page, request }) => {
    finalProject = await createIdeaProject(
      request,
      `M4.8 E Final 后继续 ${stamp}`,
      `少样本示例选择研究（版本体验 Final 语义）[review:pass]`,
    );
    projects.push(finalProject);
    const runId = await startRun(request, finalProject);
    await approveOutlineGates(request, runId);
    const finished = await waitRunStatus(request, runId, ["completed", "failed"]);
    expect(finished.completion?.label).toBe("final");

    const finalRevision = (await versionsOf(request, finalProject)).current;
    expect(finalRevision).toBeGreaterThanOrEqual(2);

    // Final 后继续：恢复早期修订 → 新的当前修订（尚未 Final）
    const restoreResponse = await request.post(
      `/api/projects/${finalProject}/revisions/1/restore`,
      { data: {} },
    );
    expect(restoreResponse.ok()).toBeTruthy();
    const restoreBody = (await restoreResponse.json()) as { revision: number; restoredFrom: number };
    expect(restoreBody.restoredFrom).toBe(1);
    expect(restoreBody.revision).toBe(finalRevision + 1);

    await page.goto(`/projects/${finalProject}?tab=paper`);
    // Final 卡：旧 Final 保留 + 明确的「最终版本 / 当前工作版本」双事实
    await expect(page.getByTestId("final-card")).toContainText("已冻结");
    await expect(page.getByTestId("final-stale")).toContainText(
      `最终版本仍是 修订 ${finalRevision} 的 Final`,
    );
    await expect(page.getByTestId("final-stale")).toContainText(`当前工作版本是 修订 ${finalRevision + 1}，尚未 Final`);
    // 版本历史：旧修订 isFinal；当前修订不是 Final
    const versions = await versionsOf(request, finalProject);
    expect(versions.versions.find((version) => version.revision === finalRevision)?.isFinal).toBe(true);
    expect(versions.versions[0]?.isFinal).toBe(false);
    await expect(page.getByTestId("version-item").first()).not.toContainText("Final");
  });

  test("F 重新通过 Gate → 新 Final；两份 Final 并存", async ({ page, request }) => {
    // 在 E 项目上再跑一轮（scripted 全 pass）：恢复后的修订被复审 → 新 Final
    const runId = await startRun(request, finalProject);
    await approveOutlineGates(request, runId);
    const finished = await waitRunStatus(request, runId, ["completed", "failed"]);
    expect(finished.completion?.label).toBe("final");

    const versions = await versionsOf(request, finalProject);
    const finals = versions.versions.filter((version) => version.isFinal);
    expect(finals.length).toBeGreaterThanOrEqual(2); // 两份 Final 并存为历史事实
    expect(versions.versions[0]?.isFinal).toBe(true);

    await page.goto(`/projects/${finalProject}?tab=paper`);
    await expect(page.getByTestId("final-card")).toContainText("已冻结");
    // 产物历史里两份 Final PDF 均可查看
    await page.getByTestId("artifact-history").locator("summary").click();
    const finalChips = page.getByTestId("artifact-history").getByText("Final", { exact: true });
    await expect(finalChips.first()).toBeVisible();
  });

  test("V Light / Dark 视觉 + 1100px 无横向溢出", async ({ page, request }) => {
    for (const theme of ["light", "dark"] as const) {
      await primeTheme(page, theme);
      await page.goto(`/projects/${loopProject}?tab=paper`);
      await expect(page.getByTestId("version-history")).toBeVisible();
      await page.screenshot({
        path: `${SHOTS_DIR}/m48-version-${theme}.png`,
        fullPage: true,
      });
    }
    // 恢复确认对话框视觉（Light）
    await primeTheme(page, "light");
    await page.goto(`/projects/${loopProject}?tab=paper`);
    const row = page.getByTestId("version-item").nth(1);
    await row.getByTestId("version-restore-button").click();
    await expect(page.getByTestId("version-restore-confirm")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/m48-restore-dialog-light.png`, fullPage: true });

    // 1100px 无横向溢出
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`/projects/${loopProject}?tab=paper`);
    await expect(page.getByTestId("version-history")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
