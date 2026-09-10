/**
 * M4.6 Quality Gate 只读 API 测试：GET /api/projects/:id/quality-gate
 * （latest + 按轮 + 新鲜度信号）与 POST 重新评估的轮次落盘。
 *
 * 链路全部真实：scripted runtime 产出 fail / pass 两套审稿 → 真实聚合 →
 * 真实确定性 gate 判定 → 真实落盘 quality-gate-r{n}.json → HTTP 读取。
 * round 配对（gate ↔ 同轮 reviewSummary）与 stale 信号在此回归。
 */

import { afterAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(reviewSequence: ("pass" | "fail")[]): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence });
  return startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
}

/** 导入最小 manuscript（POST /review 的 digest 输入；base64 内联） */
async function importManuscript(stack: TestStack, projectId: string): Promise<void> {
  const imported = await stack.request("POST", `/api/projects/${projectId}/import`, {
    files: [
      { path: "main.tex", contentBase64: Buffer.from(MAIN_TEX, "utf8").toString("base64") },
      {
        path: "sections/introduction.tex",
        contentBase64: Buffer.from("\\section{引言}\n基于证据的论述。", "utf8").toString("base64"),
      },
    ],
  });
  expect(imported.status).toBe(200);
}

const MAIN_TEX = [
  "\\documentclass[UTF8]{ctexart}",
  "\\begin{document}",
  "\\input{sections/introduction}",
  "\\end{document}",
].join("\n");

describe("Quality Gate API（GET latest / by round / stale）", () => {
  it("尚无 gate 产物：GET 返回空态（rounds 空、gate null、stale false），不伪造 0/0 结果", async () => {
    const stack = await newStack(["pass"]);
    const created = await stack.request("POST", "/api/projects", { title: "gate 空态" });
    const projectId = (created.body["project"] as { id: string }).id;

    const got = await stack.request("GET", `/api/projects/${projectId}/quality-gate`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      rounds: [],
      round: null,
      gate: null,
      reviewSummary: null,
      latestReviewRound: null,
      stale: false,
    });

    // POST 缺 review：如实 400
    const posted = await stack.request("POST", `/api/projects/${projectId}/quality-gate`);
    expect(posted.status).toBe(400);
  });

  it("fail 轮 → gate FAIL（blockers / rules / thresholds 完整）→ pass 轮 → gate PASS；round 隔离与 stale 信号", async () => {
    // 序列：第 1 轮审稿 fail（gate 应 FAIL），第 2 轮 pass（gate 应 PASS）
    const stack = await newStack(["fail", "pass"]);
    const created = await stack.request("POST", "/api/projects", {
      title: "gate 轮次",
      workflowKind: "idea_to_paper",
    });
    const projectId = (created.body["project"] as { id: string }).id;
    await importManuscript(stack, projectId);

    // 第 1 轮：fail 审稿 → gate r1 FAIL
    const review1 = await stack.request("POST", `/api/projects/${projectId}/review`);
    expect(review1.status).toBe(200);
    expect((review1.body["summary"] as { round: number }).round).toBe(1);

    const gate1 = await stack.request("POST", `/api/projects/${projectId}/quality-gate`);
    expect(gate1.status).toBe(200);
    expect(gate1.body["round"]).toBe(1);
    const gate1Result = gate1.body["gate"] as {
      passed: boolean;
      reasons: string[];
      rules: Array<{ rule: string; passed: boolean; detail: string }>;
      thresholds: { academicPassScore: number; styleRiskMax: number };
    };
    expect(gate1Result.passed).toBe(false);
    // fail 审稿（critical blocking + academic 66 + style 68）应落在这四类 blocker
    const failedRules = gate1Result.rules.filter((rule) => !rule.passed).map((rule) => rule.rule);
    expect(failedRules).toContain("blocking_issues_zero");
    expect(failedRules).toContain("open_critical_major_zero");
    expect(failedRules).toContain("academic_score_threshold");
    expect(failedRules).toContain("style_risk_threshold");
    expect(gate1Result.reasons).toHaveLength(failedRules.length);
    expect(gate1Result.thresholds.academicPassScore).toBeGreaterThan(0);

    // GET latest：r1 FAIL + 同轮 reviewSummary（round 配对）
    const latest1 = await stack.request("GET", `/api/projects/${projectId}/quality-gate`);
    expect(latest1.status).toBe(200);
    expect(latest1.body["round"]).toBe(1);
    expect((latest1.body["rounds"] as unknown[]).length).toBe(1);
    expect((latest1.body["rounds"] as Array<{ round: number; passed: boolean; blockerCount: number }>)[0]).toMatchObject({
      round: 1,
      passed: false,
      blockerCount: failedRules.length,
    });
    expect((latest1.body["reviewSummary"] as { round: number }).round).toBe(1);
    expect(latest1.body["stale"]).toBe(false);

    // 第 2 轮审稿（pass）后未重评 gate → stale：最新 review r2 > gate r1
    await stack.request("POST", `/api/projects/${projectId}/review`);
    const staleNow = await stack.request("GET", `/api/projects/${projectId}/quality-gate`);
    expect(staleNow.body["latestReviewRound"]).toBe(2);
    expect(staleNow.body["stale"]).toBe(true);

    // 重新评估 → gate r2 PASS；GET latest = r2
    const gate2 = await stack.request("POST", `/api/projects/${projectId}/quality-gate`);
    expect(gate2.body["round"]).toBe(2);
    expect((gate2.body["gate"] as { passed: boolean }).passed).toBe(true);

    const latest2 = await stack.request("GET", `/api/projects/${projectId}/quality-gate`);
    expect(latest2.body["round"]).toBe(2);
    expect(latest2.body["stale"]).toBe(false);
    const rounds2 = latest2.body["rounds"] as Array<{ round: number; passed: boolean }>;
    expect(rounds2.map((entry) => entry.round)).toEqual([2, 1]); // 降序
    expect(rounds2[0]).toMatchObject({ round: 2, passed: true });
    expect(rounds2[1]).toMatchObject({ round: 1, passed: false });

    // 按轮读取：r1 仍是 FAIL（不与新 review 混装）
    const round1 = await stack.request("GET", `/api/projects/${projectId}/quality-gate?round=1`);
    expect(round1.status).toBe(200);
    expect(round1.body["round"]).toBe(1);
    expect((round1.body["gate"] as { passed: boolean }).passed).toBe(false);
    expect((round1.body["reviewSummary"] as { round: number }).round).toBe(1);

    // 参数校验：未知轮 404；非法值 400
    const missing = await stack.request("GET", `/api/projects/${projectId}/quality-gate?round=99`);
    expect(missing.status).toBe(404);
    const invalid = await stack.request("GET", `/api/projects/${projectId}/quality-gate?round=abc`);
    expect(invalid.status).toBe(400);
  });

  it("当前 workflow 链路不注入 citationIntegrity：gate rules 只含 9 条基础规则（语义规则休眠，不因缺 semantic 记录 FAIL）", async () => {
    const stack = await newStack(["pass"]);
    const created = await stack.request("POST", "/api/projects", { title: "gate 规则集" });
    const projectId = (created.body["project"] as { id: string }).id;
    await importManuscript(stack, projectId);
    await stack.request("POST", `/api/projects/${projectId}/review`);
    await stack.request("POST", `/api/projects/${projectId}/quality-gate`);

    const got = await stack.request("GET", `/api/projects/${projectId}/quality-gate`);
    const rules = ((got.body["gate"] as { rules: Array<{ rule: string }> }).rules).map((rule) => rule.rule);
    expect(rules).toEqual([
      "hallucinated_citations_zero",
      "citation_structure_valid",
      "no_contradictory_evidence",
      "unsupported_critical_claims_zero",
      "blocking_issues_zero",
      "open_critical_major_zero",
      "academic_score_threshold",
      "style_risk_threshold",
      "target_feasibility",
    ]);
  });
});
