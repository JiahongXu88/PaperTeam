import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./fixtures.js";

/**
 * M15 长程 D：分层 QualityReport + 数值修改逐项批准的浏览器 E2E（scripted 栈，零真实模型）。
 *
 * 运行前提（与 evidence-gate.spec 同一 scripted 栈）：
 *   PAPERTEAM_TEST_RUNTIME=scripted PAPERTEAM_TEST_RUNTIME_REVIEW=fail,pass CITATION_METADATA_ENABLED=0 \
 *   PAPERTEAM_PORT=3100 PAPERTEAM_RUNTIME_ROOT=<隔离目录> PROJECTS_ROOT=<隔离目录> node backend/dist/index.js
 *   cd frontend && PAPERTEAM_PORT=3100 npx vite
 *   PATH 前置 e2e/fixtures/fakebin（假 xelatex / bibtex）
 * 然后 PAPERTEAM_E2E_M15=1 PAPERTEAM_E2E_PROJECTS_ROOT=<同一 PROJECTS_ROOT> 运行。
 *
 *   R  分层报告：r2 PASS 显示「完整性与已证实缺陷检查通过」+ L4 未经独立校准；r1 失败轮显示非 PASS 分层原因
 *   V  数值修改：未核对不可批准；伪造 boundHash → 409；浏览器逐项批准 → 服务端 approved + 批准事件（actor=author）；
 *      重评后 L3 待批准项消失
 */

const ENABLED = process.env.PAPERTEAM_E2E_M15 === "1";
const PROJECTS_ROOT = process.env.PAPERTEAM_E2E_PROJECTS_ROOT ?? "";

type RequestFixture = Parameters<Parameters<typeof test>[2]>[0]["request"];

async function waitRun(request: RequestFixture, runId: string, statuses: string[], timeoutMs = 150_000): Promise<{ status: string; awaiting?: { stageId?: string } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = ((await (await request.get(`/api/runs/${runId}`)).json()) as { run: { status: string; awaiting?: { stageId?: string } } }).run;
    if (statuses.includes(run.status)) return run;
    if (run.status === "awaiting_input") {
      const decision = run.awaiting?.stageId === "hitl.revision_overflow" ? "accept_draft" : "approve";
      await request.post(`/api/runs/${runId}/resume`, { data: { decision } });
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} 超时（${run.status}）`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test.describe.serial("M15 长程：分层质量报告与数值修改逐项批准", () => {
  test.skip(!ENABLED, "PAPERTEAM_E2E_M15 未设置（需要 scripted dev 栈）");
  let projectId = "";

  test("R 分层报告：PASS 轮与失败轮的分层呈现；L4 恒未经独立校准", async ({ page, request }) => {
    test.setTimeout(240_000);
    const created = await request.post("/api/projects", { data: { title: `M15 分层报告 ${Date.now().toString(36)}` } });
    projectId = ((await created.json()) as { project: { id: string } }).project.id;
    const runResponse = await request.post(`/api/projects/${projectId}/workflows`, { data: {} });
    const runId = ((await runResponse.json()) as { runId: string }).runId;
    await waitRun(request, runId, ["completed", "failed"]);

    const api = (await (await request.get(`/api/projects/${projectId}/quality-gate`)).json()) as { qualityReport: { overall: { status: string; finalizable: boolean } }; gate: { passed: boolean } };
    expect(api.qualityReport).toBeTruthy();
    expect(api.gate.passed).toBe(api.qualityReport.overall.finalizable);

    await page.goto(`/projects/${projectId}?tab=workflow`);
    const panel = page.getByTestId("quality-gate-panel");
    const report = panel.getByTestId("quality-report");
    await expect(report).toBeVisible({ timeout: 30_000 });
    await expect(report).toHaveAttribute("data-overall", api.qualityReport.overall.status);
    await expect(panel.getByTestId("quality-layer-L4")).toHaveAttribute("data-status", "UNVALIDATED");
    await expect(panel.getByTestId("quality-layer-L4")).toContainText("未经独立校准");
    await expect(panel.getByTestId("quality-report-external-validity")).toContainText("独立人类标签 0");
    if (api.qualityReport.overall.status === "PASS") {
      await expect(panel.getByTestId("quality-report-overall")).toHaveText("完整性与已证实缺陷检查通过");
      await expect(panel.getByTestId("quality-report-statement")).toContainText("不代表达到任何期刊水平或可投稿");
    }

    const select = panel.getByTestId("gate-round-select");
    if (await select.count() > 0) {
      const options = await select.locator("option").allTextContents();
      const lastValue = await select.locator("option").last().getAttribute("value");
      expect(options.length).toBeGreaterThan(1);
      await select.selectOption(lastValue!);
      await expect(panel.getByTestId("quality-report")).not.toHaveAttribute("data-overall", "PASS");
      await expect(panel.getByTestId("quality-report-statement")).toBeVisible();
      mkdirSync("shots", { recursive: true });
      await page.screenshot({ path: "shots/m15-quality-report-fail-round.png", fullPage: true });
    }
  });

  test("V 数值修改逐项批准：未核对不可批准；伪造哈希 409；浏览器批准后服务端生效", async ({ page, request }) => {
    test.setTimeout(120_000);
    test.skip(PROJECTS_ROOT === "", "需要 PAPERTEAM_E2E_PROJECTS_ROOT 以登记测试请求");
    // 测试夹具：登记一条由修订被拒候选派生的数值修改请求（与 valueChangeRequests.ts 同一 boundHash 口径）
    const storePath = join(PROJECTS_ROOT, projectId, "research", "edit-contracts.json");
    let store: Record<string, unknown>;
    try {
      store = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
    } catch {
      store = { schemaVersion: "edit-contract-store/v1", contracts: [], approvals: [], events: [] };
    }
    const request0 = {
      requestId: "vcr-e2e0000000000001", target: "sections/results.tex", before: "61.2", after: "61.7",
      context: "Our tracker reaches 61.2 MOTA and 58.4 IDF1.", baselineHash: sha256("baseline"),
    };
    const boundHash = sha256(JSON.stringify([request0.requestId, request0.target, request0.before, request0.after, request0.context, request0.baselineHash]));
    store["valueChangeRequests"] = [{
      schemaVersion: "value-change-request/v1", ...request0, proposedContext: "Our tracker reaches 61.7 MOTA and 58.4 IDF1.",
      baseRevision: 2, source: { runId: "w-e2e", stageId: "revision.revise", instructionIds: [], planItemIds: [], violation: "受保护数值 61.2 被替换——无对应的结构化用户批准" },
      createdAt: new Date().toISOString(), status: "pending", boundHash,
    }];
    mkdirSync(join(PROJECTS_ROOT, projectId, "research"), { recursive: true });
    writeFileSync(storePath, JSON.stringify(store), "utf8");

    // 重评：L3 出现待批准项（报告与 Gate 同源）
    expect((await request.post(`/api/projects/${projectId}/quality-gate`)).ok()).toBeTruthy();
    await page.goto(`/projects/${projectId}?tab=workflow`);
    const panel = page.getByTestId("quality-gate-panel");
    await expect(panel.locator('[data-item="value_change_requests_pending"]')).toBeVisible({ timeout: 30_000 });

    const item = panel.getByTestId("value-change-request");
    await expect(item).toContainText("61.2");
    await expect(item).toContainText("61.7");
    const approve = panel.getByTestId("value-change-approve");
    await expect(approve).toBeDisabled();

    // 无合法批准的 HTTP 决策（伪造内容哈希）→ 409，请求保持 pending
    const forged = await request.post(`/api/projects/${projectId}/value-change-requests/decide`, {
      data: { decisions: [{ requestId: request0.requestId, decision: "approve", boundHash: "0".repeat(64) }] },
    });
    expect(forged.status()).toBe(409);

    await panel.getByTestId("value-change-ack").check();
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(panel.getByTestId("value-change-decided")).toContainText("批准 1", { timeout: 15_000 });

    const listed = (await (await request.get(`/api/projects/${projectId}/value-change-requests`)).json()) as { requests: Array<{ status: string; approvalId?: string }> };
    expect(listed.requests[0]).toMatchObject({ status: "approved" });
    const saved = JSON.parse(readFileSync(storePath, "utf8")) as { approvals: Array<{ kind: string; actor: string }> };
    expect(saved.approvals.at(-1)).toMatchObject({ kind: "value_change_request_approve", actor: "author" });

    expect((await request.post(`/api/projects/${projectId}/quality-gate`)).ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId("quality-report")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-item="value_change_requests_pending"]')).toHaveCount(0);
    await page.screenshot({ path: "shots/m15-value-change-approved.png", fullPage: true });
  });
});
