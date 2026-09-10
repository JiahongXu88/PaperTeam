import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, primeTheme, test, type Page } from "./fixtures.js";
import { resolvePdfPath } from "./fixtures.js";

/**
 * 证据工作台 + 质量门禁 E2E（M4.6）。
 *
 * 运行前提（与 hitl.spec 同一 scripted 栈模式）：
 *   PAPERTEAM_TEST_RUNTIME=scripted \
 *   PAPERTEAM_TEST_RUNTIME_REVIEW=fail,pass \        # r1 审稿 fail → gate FAIL → 修订 → r2 pass → gate PASS
 *   CITATION_METADATA_ENABLED=0 \                    # 离线（不查 Crossref/OpenAlex；M4.6 起对 quick review 同样生效）
 *   PAPERTEAM_PORT=3100 PAPERTEAM_RUNTIME_ROOT=<隔离目录> PROJECTS_ROOT=<隔离目录> \
 *   node backend/dist/index.js
 *   cd frontend && PAPERTEAM_PORT=3100 npx vite
 * 可选：PATH 前置 e2e/fixtures/fakebin（无 TeX 机器用假 latexmk，让 run 以
 * completed 终态产出 Draft PDF；不前置时 build.draft 如实失败，run failed
 * 同样被 A1 接受——两轮 gate 在 build 之前已落盘）。
 * 然后以 PAPERTEAM_E2E_EVIDENCE_GATE=1 运行本套件（其它环境自动跳过）。
 *
 * 用例（真实链路：编排器 / checkpoint / 确定性 gate / HTTP / React 全部真实，
 * 只有模型输出是脚本）：
 *   A 证据工作台：scripted 调研证据 + API 登记证据 → 概况 / 列表 / 筛选 / 搜索 /
 *     详情 provenance / 人工确认核验 / 刷新保持 URL
 *   B 质量门禁 FAIL（真实 gate r1）：结论徽标 / 阻止项可解释 / 规则清单 /
 *     Overview 质量状态 / 阶段时间线入口
 *   C 轮次切换：r2 PASS 后切回 r1（round 隔离，不混用新 review）
 *   D blocker 深链（真实评估的矛盾证据 → gate FAIL）：前往处理 → 证据页需注意筛选
 *   E semanticMode=off：快速 Review 不运行门禁（空态，不出现假 0/0 或误 FAIL）
 *   F Light / Dark / 1100px 无横向溢出
 */

const ENABLED = process.env.PAPERTEAM_E2E_EVIDENCE_GATE === "1";
const SHOTS_DIR = process.env.PAPERTEAM_E2E_SHOTS_DIR ?? resolve(import.meta.dirname, "..", "shots");

type PageFixture = Page;
type RequestFixture = Parameters<Parameters<typeof test>[2]>[0]["request"];

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function startRun(request: RequestFixture, projectId: string, kind: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await request.post(`/api/projects/${projectId}/workflows`, { data: { kind, ...extra } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { runId: string }).runId;
}

interface RunState {
  status: string;
  currentStage?: string;
  error?: { message: string } | null;
}

async function waitRunStatus(
  request: RequestFixture,
  runId: string,
  statuses: string[],
  timeoutMs = 120_000,
): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request.get(`/api/runs/${runId}`);
    const run = ((await response.json()) as { run: RunState }).run;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status} @ ${run.currentStage ?? "?"}）`);
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

/** 登记 API 证据（人工登记可携带核验结论——M4.6 起 POST /evidence 支持核验字段） */
async function addEvidence(request: RequestFixture, projectId: string, body: Record<string, unknown>): Promise<void> {
  const response = await request.post(`/api/projects/${projectId}/evidence`, { data: body });
  expect(response.ok(), `登记证据失败：${await response.text()}`).toBeTruthy();
}

const STAMP = `${Date.now().toString(36)}`;

test.describe.serial("证据工作台 + 质量门禁（scripted Runtime 栈）", () => {
  test.skip(!ENABLED, "PAPERTEAM_E2E_EVIDENCE_GATE 未设置（需要 scripted dev 栈）");

  /** 主项目：完整 idea_to_paper（fail → pass），A/B/C 用 */
  let projectId = "";
  /** 深链项目：矛盾证据 + 手动 review/gate，D 用 */
  let blockerProjectId = "";
  /** 快速 Review 项目（semanticMode=off），E 用 */
  let reviewProjectId = "";

  test.afterAll(async ({ request }) => {
    await cleanupProject(request, projectId);
    await cleanupProject(request, blockerProjectId);
    await cleanupProject(request, reviewProjectId);
  });

  test("A1 完整工作流（fail→pass）跑到终态，产出两轮 gate", async ({ request }) => {
    const created = await request.post("/api/projects", {
      data: { title: `M4.6 证据与门禁 ${STAMP}`, researchIdea: "scripted 证据与门禁验证", workflowKind: "idea_to_paper" },
    });
    projectId = ((await created.json()) as { project: { id: string } }).project.id;

    // 人工登记证据（含一条未核验 + 一条需注意），加上 scripted 调研产出的 E001
    await addEvidence(request, projectId, {
      claim: "人工核对过的结论：小语料场景检索质量影响显著",
      summary: "人工阅读来源后登记的证据。",
      quote: "Retrieval quality dominates hallucination rates in small corpora.",
      source: { title: "Small Corpora Retrieval Study", authors: ["Chen, L."], year: 2025, doi: "10.1000/small-corpora" },
      location: { page: 4, section: "4" },
      verificationStatus: "verified",
      verificationLevel: "fulltext",
    });
    await addEvidence(request, projectId, {
      claim: "待核验：重排在小语料下最稳健",
      source: { title: "Rerankers for Small Corpora" },
    });
    await addEvidence(request, projectId, {
      claim: "需注意：来源与表述不符的结论",
      verificationStatus: "mismatch",
      source: { title: "Mismatched Source" },
    });

    const runId = await startRun(request, projectId, "idea_to_paper");
    // 两个 HITL（可行性 / 大纲）确认后自动推进到终态
    for (let i = 0; i < 2; i += 1) {
      const run = await waitRunStatus(request, runId, ["awaiting_input", "completed", "failed", "cancelled"]);
      if (run.status !== "awaiting_input") {
        break;
      }
      const resumed = await request.post(`/api/runs/${runId}/resume`, { data: { decision: "approve" } });
      expect(resumed.ok()).toBeTruthy();
    }
    const final = await waitRunStatus(request, runId, ["completed", "failed", "cancelled"]);
    // 本机无 LaTeX 工具链时 build.draft 如实失败——不影响两轮 gate 已落盘
    expect(["completed", "failed"]).toContain(final.status);

    // 两轮 gate 产物（r1 FAIL / r2 PASS）经真实 API 可读
    const gate = await (await request.get(`/api/projects/${projectId}/quality-gate`)).json();
    const rounds = (gate as { rounds: Array<{ round: number; passed: boolean; blockerCount: number }> }).rounds;
    expect(rounds.map((entry) => [entry.round, entry.passed])).toEqual([[2, true], [1, false]]);
  });

  test("A2 证据工作台：概况 / 列表 / 筛选 / 搜索 / 详情 provenance / 人工确认 / URL 保持", async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=evidence`);
    const panel = page.getByTestId("evidence-panel");
    await expect(panel).toBeVisible();

    // scripted 调研 E001（unverified）+ 人工 3 条 = 4 条；概况统计来自同一份数据
    await expect(panel.getByText("证据总数 4")).toBeVisible();
    await expect(panel.getByText("已核验 1").first()).toBeVisible();
    await expect(panel.getByText("待核验 2").first()).toBeVisible(); // E001 + 人工待核验
    await expect(panel.getByText("需注意 1").first()).toBeVisible();

    // 列表行：claim + 来源 + 中文状态
    await expect(panel.getByText("人工核对过的结论：小语料场景检索质量影响显著")).toBeVisible();
    await expect(panel.locator(".evidence-list").getByText("Small Corpora Retrieval Study")).toBeVisible();
    await expect(panel.getByText("与来源不符", { exact: true }).first()).toBeVisible();

    // 筛选：需注意 → 只剩 mismatch 一条
    await page.getByTestId("evidence-filter-attention").check();
    await expect(panel.locator(".evidence-row")).toHaveCount(1);
    await page.getByTestId("evidence-filter-all").check();

    // 搜索：DOI 命中人工核验那条
    await page.getByTestId("evidence-search").fill("10.1000/small-corpora");
    await expect(panel.locator(".evidence-row")).toHaveCount(1);
    await page.getByTestId("evidence-search").fill("");
    await expect(panel.locator(".evidence-row")).toHaveCount(4);

    // 详情 provenance：文献 / DOI / 页码 / 核验方式 / 使用记录
    const row = panel.locator(".evidence-row").filter({ hasText: "人工核对过的结论" });
    await row.getByTestId("evidence-toggle-detail").click();
    const detail = row.getByTestId("evidence-detail");
    await expect(detail).toContainText("Small Corpora Retrieval Study");
    await expect(detail).toContainText("10.1000/small-corpora");
    await expect(detail).toContainText("第 4 页");
    await expect(detail).toContainText("全文级");
    await expect(detail).toContainText("run:"); // scripted run 的 markUsage 使用记录

    // 人工确认核验：待核验那条 → 已核验（局部 loading → 状态翻转）
    const unverifiedRow = panel.locator(".evidence-row").filter({ hasText: "待核验：重排在小语料下最稳健" });
    await unverifiedRow.getByRole("button", { name: "确认已核验" }).click();
    await expect(unverifiedRow.locator(".status").first()).toHaveText(/已核验/, { timeout: 15_000 });
    await expect(panel.getByText("待核验 1").first()).toBeVisible(); // 只剩 E001

    // 刷新仍停留在证据页（URL state）
    await page.reload();
    await expect(page.getByTestId("evidence-panel")).toBeVisible();
    await expect(page.getByRole("tab", { name: "证据" })).toHaveAttribute("aria-selected", "true");
  });

  test("B 质量门禁 FAIL（gate r1）：结论 / 阻止项可解释 / 规则清单 / Overview 质量状态 / 时间线入口", async ({ page }) => {
    // 切到 r1（历史轮）看 FAIL 展示
    await page.goto(`/projects/${projectId}?tab=workflow`);
    const gatePanel = page.getByTestId("quality-gate-panel");
    await expect(gatePanel).toBeVisible();
    await expect(gatePanel.getByTestId("gate-outcome")).toHaveText(/通过/); // 默认最新 = r2 PASS

    await page.getByTestId("gate-round-select").selectOption("1");
    await expect(gatePanel.getByTestId("gate-outcome")).toHaveText(/未通过/);
    await expect(gatePanel.getByText(/项阻止论文进入 Final/)).toBeVisible();
    // 可解释：实际值 + 阈值来自后端 detail（fail 审稿：academic 66 / style 68）
    await expect(gatePanel.getByText(/academicScore=66/).first()).toBeVisible();
    await expect(gatePanel.getByText(/styleRisk=68/).first()).toBeVisible();
    await expect(gatePanel.getByText(/学术评分 ≥ 80 · 文风风险 ≤ 35/)).toBeVisible();
    // 规则清单：9 条真实规则，文字状态（不只靠颜色）
    await expect(gatePanel.locator('[data-testid="gate-rule"]')).toHaveCount(9);
    await expect(gatePanel.locator('[data-rule="academic_score_threshold"] [data-status="未通过"]')).toHaveCount(1);
    // 同轮审稿上下文（round 隔离：r1 gate ↔ r1 review）
    await expect(gatePanel.getByTestId("gate-review-context")).toContainText("第 1 轮");
    await expect(gatePanel.getByTestId("gate-review-context")).toContainText("学术评分 66");
    await expect(gatePanel.getByText("历史轮次")).toBeVisible();
    // Draft / Final 边界文案
    await expect(gatePanel.getByText(/质量门禁未通过不影响生成 PDF/)).toBeVisible();

    // 阶段时间线：已完成的 quality.gate 有门禁详情入口
    await expect(page.getByTestId("stage-goto-gate").first()).toBeVisible();

    // Overview 质量状态（最新 = r2 PASS）
    await page.goto(`/projects/${projectId}`);
    const status = page.getByTestId("quality-status");
    await expect(status).toBeVisible();
    await expect(status).toContainText("通过");
    await expect(status).toContainText("第 2 轮");
  });

  test("C 轮次切换回最新：r2 PASS（修订后同轮 review 一起切换）", async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=workflow`);
    const gatePanel = page.getByTestId("quality-gate-panel");
    await expect(gatePanel.getByTestId("gate-outcome")).toHaveText(/通过/);
    await expect(gatePanel.getByTestId("gate-review-context")).toContainText("第 2 轮");
    await expect(gatePanel.getByTestId("gate-review-context")).toContainText("学术评分 86"); // pass 审稿
    // PASS 不渲染阻止项区块
    await expect(gatePanel.getByTestId("gate-blockers")).toHaveCount(0);
    await expect(gatePanel.getByText(/当前质量门禁已通过/)).toBeVisible();
  });

  test("D blocker 深链（真实评估）：矛盾证据 → gate FAIL → 前往处理 → 证据页需注意筛选", async ({ page, request }) => {
    // 独立项目：直接写最小 manuscript（POST /review 的 digest 输入）+ 矛盾证据，
    // 走真实 POST /review（scripted pass 审稿）+ POST /quality-gate（真实确定性评估）
    const created = await request.post("/api/projects", {
      data: { title: `M4.6 门禁深链 ${STAMP}`, workflowKind: "idea_to_paper" },
    });
    blockerProjectId = ((await created.json()) as { project: { id: string } }).project.id;
    const imported = await request.post(`/api/projects/${blockerProjectId}/import`, {
      data: {
        files: [
          {
            path: "main.tex",
            contentBase64: Buffer.from(
              ["\\documentclass[UTF8]{ctexart}", "\\begin{document}", "正文。", "\\end{document}"].join("\n"),
              "utf8",
            ).toString("base64"),
          },
        ],
      },
    });
    expect(imported.ok(), await imported.text()).toBeTruthy();
    await addEvidence(request, blockerProjectId, {
      claim: "与论文论断矛盾的证据",
      verificationStatus: "mismatch",
      supportStrength: "contradictory",
      source: { title: "Contradicting Source", doi: "10.1000/contradict" },
    });
    await request.post(`/api/projects/${blockerProjectId}/review`);
    const gate = await request.post(`/api/projects/${blockerProjectId}/quality-gate`);
    expect(gate.ok()).toBeTruthy();
    const gateBody = (await gate.json()) as { gate: { passed: boolean } };
    expect(gateBody.gate.passed).toBe(false); // 真实评估：矛盾证据 → no_contradictory_evidence FAIL

    // UI：blocker 前往处理 → 证据页 + 需注意筛选（attention 深链）
    await page.goto(`/projects/${blockerProjectId}?tab=workflow`);
    const gatePanel = page.getByTestId("quality-gate-panel");
    await expect(gatePanel.getByTestId("gate-outcome")).toHaveText(/未通过/);
    await expect(gatePanel.getByTestId("gate-blocker-goto-evidence")).toBeVisible();
    await gatePanel.getByTestId("gate-blocker-goto-evidence").click();

    await expect(page).toHaveURL(new RegExp(`/projects/${blockerProjectId}\\?tab=evidence&attention=1$`));
    const evidencePanel = page.getByTestId("evidence-panel");
    await expect(evidencePanel).toBeVisible();
    await expect(page.getByTestId("evidence-filter-attention")).toBeChecked();
    await expect(evidencePanel.locator(".evidence-row")).toHaveCount(1);
    await expect(evidencePanel).toContainText("与论文论断矛盾的证据");
  });

  test("E semanticMode=off：快速 Review 不运行门禁（空态，不出现假 0/0 或误 FAIL）", async ({ page, request }) => {
    // 真实 PDF 解析 + 完整快速 Review（scripted）：放宽到 5 分钟
    test.setTimeout(300_000);
    await page.goto("/projects/new");
    await page.getByRole("radio", { name: /导入已有论文/ }).check();
    await page.getByLabel("选择论文 PDF（.pdf）").setInputFiles(resolvePdfPath());
    await page.getByRole("button", { name: "导入论文" }).click();
    await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+\?tab=review$/, { timeout: 90_000 });
    reviewProjectId = new URL(page.url()).pathname.split("/").pop() ?? "";

    const runId = await startRun(request, reviewProjectId, "existing_paper_review", { citationSemanticMode: "off" });
    await waitRunStatus(request, runId, ["completed", "failed", "cancelled"]);

    await page.goto(`/projects/${reviewProjectId}?tab=workflow`);
    const gatePanel = page.getByTestId("quality-gate-panel");
    await expect(gatePanel.getByTestId("gate-empty")).toBeVisible();
    await expect(gatePanel.getByTestId("gate-empty")).toContainText("快速 Review 是只读分析，不运行质量门禁");
    // 不出现假门禁结果（0/0 通过 / 误 FAIL）
    await expect(gatePanel.getByTestId("gate-outcome")).toHaveCount(0);
    await expect(gatePanel.getByTestId("gate-rules")).toHaveCount(0);
    // 快速 Review 项目 Overview 不显示质量状态卡（避免永久「尚未评估」噪音）
    await page.goto(`/projects/${reviewProjectId}`);
    await expect(page.getByTestId("quality-status")).toHaveCount(0);
  });

  test("F Light / Dark / 1100px：证据与门禁页无横向溢出，截图留档", async ({ page }) => {
    mkdirSync(SHOTS_DIR, { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await primeTheme(page, theme);
      for (const [name, path] of [
        ["evidence", `/projects/${projectId}?tab=evidence`],
        ["gate-fail", `/projects/${blockerProjectId}?tab=workflow`],
        ["gate-pass", `/projects/${projectId}?tab=workflow`],
      ] as const) {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 800 }]) {
          await page.setViewportSize(viewport);
          await page.goto(path);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, `${name} @ ${viewport.width} 出现水平溢出`).toBeLessThanOrEqual(0);
          if (viewport.width === 1440) {
            await page.screenshot({
              path: resolve(SHOTS_DIR, `m46-${theme}-${name}.png`),
              fullPage: true,
            });
          }
        }
      }
    }
  });
});
