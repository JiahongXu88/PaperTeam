/**
 * topic_survey 写作链 Fixture E2E（M11.2 §二十二-7/8）。
 *
 * 真实服务栈 + 组合脚本 runtime（survey scopes 走 buildSurveyRuntime；写作 /
 * 审稿 / 修订走本文件定制的输出），覆盖写作链关键行为：
 * 1. 修订轮：首轮 review FAIL（critical 指向带 refs 的章节）→ gate FAIL →
 *    revision.plan → revision.revise（该节修订 prompt 注入「综述结构红线」+
 *    synthesis 边界）→ revision.validate → 二轮 review PASS → gate PASS →
 *    build.draft / build.final → completed(label=final)；
 * 2. fail-closed：写作输出引用白名单之外的 ghost key → writeSection 后检拒绝
 *    → stage 重试耗尽 → run failed（错误信息点名越界 key）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { buildSurveyRuntime } from "../survey/fixtures.js";
import {
  SURVEY_PLAN_JSON,
  SURVEY_SECTION_TEX,
  scriptedRevision,
} from "../../src/runtime/scriptedRuntime.js";
import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";
import type { FullTextResolver } from "../../src/search/fullText.js";
import type { WorkflowState } from "../../src/workflow/types.js";

/** 带文本层的最小 PDF（与 topicSurvey.e2e 同构） */
function buildTextPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, " ").slice(0, 6000)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const parts: string[] = ["%PDF-1.4"];
  let offset = parts[0]!.length + 1;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(object);
    offset += object.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
  return Buffer.from(parts.join("\n"), "latin1");
}

const FAKE_PAPERS = Array.from({ length: 6 }, (_, index) => ({
  doi: `10.1234/survey-writing-${index + 1}`,
  title: `Survey Writing Association Paper ${index + 1}`,
  year: 2018 + index,
  body:
    `Survey writing association paper ${index + 1}. `.repeat(6) +
    "We associate every detection box including low-score ones and keep identity stable through occlusion. " +
    "Experiments show identity switches drop; the association approach improves identity preservation. ",
}));

const openalexResponse = {
  results: FAKE_PAPERS.map((paper, index) => ({
    id: `https://openalex.org/W${200 + index}`,
    title: paper.title,
    doi: `https://doi.org/${paper.doi}`,
    publication_year: paper.year,
    authorships: [{ author: { display_name: `Author ${index + 1}` } }],
    cited_by_count: 10 + index,
    open_access: { is_oa: true },
  })),
};

const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url);
  if (target.startsWith("https://api.openalex.org/works")) {
    return new Response(JSON.stringify(openalexResponse), { status: 200 });
  }
  if (target.startsWith("https://oa.example.org/")) {
    const doi = decodeURIComponent(target.replace("https://oa.example.org/", "").replace(/\.pdf$/, ""));
    const paper = FAKE_PAPERS.find((candidate) => candidate.doi === doi) ?? FAKE_PAPERS[0]!;
    return new Response(buildTextPdf(paper.body), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  }
  return new Response(JSON.stringify({ error: `unexpected url ${target}` }), { status: 500 });
};

const fakeOaResolver: FullTextResolver = {
  name: "unpaywall",
  async resolve(identity) {
    if (identity.doi !== undefined && identity.doi.startsWith("10.1234/")) {
      return { kind: "found", url: `https://oa.example.org/${identity.doi}.pdf`, source: "fake-oa" };
    }
    return { kind: "not_found" };
  },
};

/** survey prompt 的白名单行（`全部允许（\cite 只能用这些 key）：a, b`） */
const SURVEY_ALLOWED = /全部允许（\\cite 只能用这些 key）[:：]\s*([^。\n]+)/;

const REVIEW_FAIL_FIRST_ROUND = {
  fact: JSON.stringify({
    summary: "综述核心章节存在无证据支撑的综合结论。",
    claims: [],
    issues: [
      {
        category: "fact",
        severity: "critical",
        section: "sections/trends-comparison.tex",
        description: "跨方法比较结论缺少证据支撑（对应 synthesis 引用组未落实）",
        suggestedAction: "按 synthesis 引用候选组补齐 \\cite 或弱化表述",
        blocking: false,
      },
    ],
  }),
  academic: JSON.stringify({
    summary: "比较维度覆盖不足。",
    scores: { 覆盖完整性: 70, 分类与组织: 72, 文献均衡性: 68, 比较与论证: 60, 引用支撑: 65, 写作质量: 78 },
    overallScore: 68,
    issues: [
      {
        category: "academic",
        severity: "major",
        section: "sections/trends-comparison.tex",
        description: "横向比较未覆盖主要方法路线",
        suggestedAction: "补充 comparison synthesis 两侧的比较论述",
        blocking: false,
      },
    ],
  }),
  style: JSON.stringify({
    summary: "文风可接受。",
    riskScore: 22,
    issues: [],
  }),
};

const REVIEW_PASS_LATER_ROUNDS = {
  fact: JSON.stringify({
    summary: "关键论断均有证据支撑。",
    claims: [],
    issues: [],
  }),
  academic: JSON.stringify({
    summary: "综述结构与支撑良好。",
    scores: { 覆盖完整性: 88, 分类与组织: 86, 文献均衡性: 84, 比较与论证: 87, 引用支撑: 90, 写作质量: 89 },
    overallScore: 87,
    issues: [],
  }),
  style: JSON.stringify({
    summary: "文风自然。",
    riskScore: 18,
    issues: [],
  }),
};

function taskOf(output: string): AgentTask {
  const now = new Date().toISOString();
  return { taskId: `run-${Math.random().toString(36).slice(2, 8)}`, agentId: "writer", status: "completed", createdAt: now, updatedAt: now, output };
}

/** 把 fixture 里的占位 \cite 依序重写为白名单 key（镜像 reciteToAllowedKeys） */
function reciteCites(tex: string, keys: string[]): string {
  if (keys.length === 0) {
    return tex.replace(/\\(?:cite|citep|citet|citealp|citealt|parencite|textcite|autocite)\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, "");
  }
  let index = 0;
  return tex.replace(/\\(?:cite|citep|citet|citealp|citealt|parencite|textcite|autocite)\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, () => {
    const key = keys[Math.min(index, keys.length - 1)]!;
    index += 1;
    return `\\cite{${key}}`;
  });
}

interface WritingRuntimeOptions {
  /** 首轮 review FAIL（修订轮场景） */
  firstReviewFail?: boolean;
  /** 写作输出在 trends-comparison 节引用 ghost key（fail-closed 场景） */
  ghostKey?: boolean;
}

function buildWritingRuntime(options: WritingRuntimeOptions) {
  const survey = buildSurveyRuntime({}, {});
  const recordedTasks: { scope: string; task: string }[] = [];
  let reviewCallIndex = 0;
  const runtime: AgentRuntime = {
    provider: "pi",
    healthCheck: () => survey.healthCheck(),
    runAgent: async (input): Promise<AgentTask> => {
      const scope = input.contextScope ?? "";
      const task = input.task;
      const isSurveyScope =
        scope === "research/survey-matrix" ||
        scope === "research/survey-synthesis" ||
        scope.startsWith("citation/evidence/") ||
        (scope === "writing/outline" && task.includes("[SYN-"));
      if (isSurveyScope) {
        return survey.runAgent(input);
      }
      recordedTasks.push({ scope, task });
      if (scope === "research/survey-plan") {
        return taskOf(SURVEY_PLAN_JSON);
      }
      if (scope === "writing/sections") {
        const match = SURVEY_ALLOWED.exec(task);
        const keys = (match?.[1] ?? "")
          .split(/[,，、\s]+/)
          .map((key) => key.trim())
          .filter((key) => /^[A-Za-z0-9_.:+*-]+$/.test(key));
        if (options.ghostKey === true && task.includes("trends-comparison.tex")) {
          return taskOf("\\section{演进趋势与跨方法比较}\n\n越界引用 \\cite{ghost2099paper}。");
        }
        return taskOf(reciteCites(SURVEY_SECTION_TEX, keys));
      }
      if (scope.startsWith("review/")) {
        const round = Math.floor(reviewCallIndex / 3);
        reviewCallIndex += 1;
        const mode = scope.slice("review/".length) as "fact" | "academic" | "style";
        const pack = options.firstReviewFail === true && round === 0 ? REVIEW_FAIL_FIRST_ROUND : REVIEW_PASS_LATER_ROUNDS;
        return taskOf(pack[mode]);
      }
      if (scope === "writing/revision") {
        return taskOf(scriptedRevision(task, false, false));
      }
      if (scope === "writing/repair") {
        return taskOf(scriptedRevision(task, false, false));
      }
      throw new Error(`未预期的 runtime scope：${scope}`);
    },
    startAgent: async (input) => {
      const task = await runtime.runAgent(input);
      return {
        taskId: task.taskId,
        sessionKey: `agent:${input.agentId}:writing-e2e`,
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  };
  return { runtime, recordedTasks };
}

let stack: TestStack;
let recordedTasks: { scope: string; task: string }[];

beforeAll(async () => {
  const built = buildWritingRuntime({ firstReviewFail: true });
  recordedTasks = built.recordedTasks;
  stack = await startTestStack(built.runtime, {
    search: {
      disabledProviders: ["semantic-scholar", "arxiv", "aminer", "searxng"],
      providerTimeoutMs: 2_000,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    },
    fullText: { enabled: true, resolvers: [fakeOaResolver] },
  });
});

afterAll(async () => {
  await stack.cleanup();
});

async function runSurveyToFinal(title: string): Promise<{ projectId: string; runId: string; run: WorkflowState }> {
  const created = await stack.request("POST", "/api/projects", { title, workflowKind: "topic_survey" });
  expect(created.status).toBe(201);
  const projectId = (created.body["project"] as { id: string }).id;
  const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, { kind: "topic_survey" });
  expect(started.status).toBe(202);
  const runId = started.body["runId"] as string;
  const deadline = Date.now() + 300_000;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (run.status === "completed" || run.status === "failed") {
      return { projectId, runId, run };
    }
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      if (!stageId.startsWith("hitl.")) {
        throw new Error(`未预期的待办节点 ${stageId}`);
      }
      await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`轮询超时（${run.status} / ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("topic_survey 写作链 fixture E2E", () => {
  it("修订轮：review FAIL → 修订（综述结构红线注入）→ review PASS → gate PASS → PDF（label=final）", async () => {
    const { projectId, run } = await runSurveyToFinal("综述写作链修订轮测试");
    expect(run.status).toBe("completed");
    expect(run.completion?.label).toBe("final");

    // 两轮 review + 一轮修订
    const reviewCompletions = run.stageHistory.filter(
      (record) => record.stageId === "review.run" && record.status === "completed",
    ).length;
    const reviseCompletions = run.stageHistory.filter(
      (record) => record.stageId === "revision.revise" && record.status === "completed",
    ).length;
    const validateCompletions = run.stageHistory.filter(
      (record) => record.stageId === "revision.validate" && record.status === "completed",
    ).length;
    expect(reviewCompletions).toBe(2);
    expect(reviseCompletions).toBe(1);
    expect(validateCompletions).toBe(1);
    expect(run.completedStages).toContain("revision.plan");
    expect(run.completedStages).toContain("build.final");

    // survey gate 产物：两轮均含 survey 四规则，第二轮全过
    const gate2 = JSON.parse(
      await readFile(join(stack.store.projectDir(projectId), "reviews", "quality-gate-r2.json"), "utf8"),
    ) as { gate: { passed: boolean; rules: Array<{ rule: string; passed: boolean }> } };
    expect(gate2.gate.passed).toBe(true);
    const surveyRules = gate2.gate.rules.filter((rule) => rule.rule.startsWith("survey_"));
    expect(surveyRules).toHaveLength(4);
    expect(surveyRules.every((rule) => rule.passed)).toBe(true);

    // 修订 prompt：trends-comparison（带 refs 的节）注入综述结构红线 + synthesis 边界
    const revisionTasks = recordedTasks.filter((entry) => entry.scope === "writing/revision");
    expect(revisionTasks.length).toBeGreaterThan(0);
    const targeted = revisionTasks.find((entry) => entry.task.includes("演进趋势与跨方法比较"));
    expect(targeted).toBeDefined();
    expect(targeted!.task).toContain("综述结构红线");
    expect(targeted!.task).toContain("不得更换或新增 taxonomy");
    expect(targeted!.task).toContain("本节绑定的 synthesis");

    // survey-writing 评估产物按轮落盘
    const surveyWriting1 = JSON.parse(
      await readFile(join(stack.store.projectDir(projectId), "reviews", "survey-writing-r1.json"), "utf8"),
    ) as { metrics: { evidenceBackedTotal: number } };
    expect(surveyWriting1.metrics.evidenceBackedTotal).toBeGreaterThan(0);
  }, 300_000);
});

describe("topic_survey 写作 fail-closed", () => {
  it("写作输出引用白名单外 ghost key → run failed（错误点名越界 key）", async () => {
    const built = buildWritingRuntime({ ghostKey: true });
    const failStack = await startTestStack(built.runtime, {
      search: {
        disabledProviders: ["semantic-scholar", "arxiv", "aminer", "searxng"],
        providerTimeoutMs: 2_000,
        fetchImpl: fakeFetch as unknown as typeof fetch,
      },
      fullText: { enabled: true, resolvers: [fakeOaResolver] },
    });
    try {
      const created = await failStack.request("POST", "/api/projects", {
        title: "综述写作越界引用测试",
        workflowKind: "topic_survey",
      });
      const projectId = (created.body["project"] as { id: string }).id;
      const started = await failStack.request("POST", `/api/projects/${projectId}/workflows`, {
        kind: "topic_survey",
      });
      const runId = started.body["runId"] as string;
      const deadline = Date.now() + 300_000;
      let run: WorkflowState | undefined;
      for (;;) {
        const { body } = await failStack.request("GET", `/api/runs/${runId}`);
        run = body["run"] as WorkflowState;
        if (run.status === "completed" || run.status === "failed") {
          break;
        }
        if (run.status === "awaiting_input") {
          await failStack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error("轮询超时");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(run!.status).toBe("failed");
      expect(run!.error?.stageId).toBe("writing.sections");
      expect(run!.error?.message).toContain("ghost2099paper");
      // fail-closed：越界节的正文不落盘（其余节可已写，但该节产物被拒绝）
    } finally {
      await failStack.cleanup();
    }
  }, 300_000);
});
