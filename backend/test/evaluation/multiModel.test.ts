/**
 * M6.9.3 Multi-model Evaluation 测试：CLI 参数校验 + 聚合/分析/报告渲染（纯函数，不触网）。
 * 真实网关批次的端到端行为由 evaluation/reports/ 下的实际报告审计，不在单测内复现。
 */

import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../../src/evaluation/cli.js";
import {
  GATEWAY_CATALOG_SNAPSHOT,
  MULTI_MODEL_TARGETS,
  aggregateResults,
  buildAnalysis,
  buildMultiModelReport,
  multiModelReportMarkdown,
  type MultiModelModelResult,
  type MultiModelReport,
} from "../../src/evaluation/runners/multiModel.js";

function completedModel(overrides: Partial<MultiModelModelResult> = {}): MultiModelModelResult {
  return {
    tag: "fixture-model",
    modelSpec: "gw-anthropic/fixture-model",
    provider: "gw-anthropic",
    family: "glm",
    wire: "anthropic-messages",
    status: "completed",
    judge: "same-model",
    modelCalls: 7,
    durationMs: 120_000,
    armA: { proposals: 5, refused: false, fabricatedQuoteRate: 1, misattributedQuoteRate: 0 },
    armB: {
      proposals: 5,
      pipelined: 5,
      fabricatedQuoteRate: 0.4,
      fabricatedLeaked: 0,
      fabricatedInterceptedRate: 1,
      verifiedRate: 0.6,
      dispositions: { verified: 3, metadata_mismatch: 2 },
    },
    errors: [],
    ...overrides,
  };
}

describe("M6.9.3 CLI --multi-model 参数校验", () => {
  it("--runtime real --multi-model：dataset 缺省 frozen 自动切换 claude-compatible", () => {
    const options = parseCliArgs(["--runtime", "real", "--multi-model"]);
    expect(options.multiModel).toBe(true);
    expect(options.dataset).toBe("claude-compatible");
  });

  it("显式 --dataset claude-compatible 与 --multi-model 兼容", () => {
    const options = parseCliArgs(["--runtime", "real", "--multi-model", "--dataset", "claude-compatible"]);
    expect(options.dataset).toBe("claude-compatible");
  });

  it("scripted 模式下 --multi-model 拒绝", () => {
    expect(() => parseCliArgs(["--multi-model"])).toThrow(/--runtime real/);
  });

  it("--multi-model 与 --model / --scenario / --report-name 互斥", () => {
    expect(() => parseCliArgs(["--runtime", "real", "--multi-model", "--model", "p/m"])).toThrow(/互斥/);
    expect(() => parseCliArgs(["--runtime", "real", "--multi-model", "--scenario", "g1-rag-survey"])).toThrow(/互斥/);
    expect(() => parseCliArgs(["--runtime", "real", "--multi-model", "--report-name", "x"])).toThrow(/互斥/);
  });

  it("--multi-model --experiment 2 拒绝（协议固定 Exp1）", () => {
    expect(() => parseCliArgs(["--runtime", "real", "--multi-model", "--experiment", "2"])).toThrow(
      /--experiment 1/,
    );
  });

  it("不带 --multi-model 的 legacy 行为不变（frozen 缺省、无 multiModel 字段）", () => {
    const options = parseCliArgs(["--experiment", "1"]);
    expect(options.multiModel).toBeUndefined();
    expect(options.dataset).toBe("frozen");
  });
});

describe("M6.9.3 聚合与分析", () => {
  it("混合结果（完成/拒答/失败）的 aggregate 计数与泄漏率口径正确", () => {
    const results: MultiModelModelResult[] = [
      completedModel({ tag: "m1" }),
      // 拒答模型：Arm A 不可测，不入幻觉分母；Arm B 正常
      completedModel({
        tag: "m2",
        armA: { proposals: 0, refused: true, fabricatedQuoteRate: 0, misattributedQuoteRate: 0 },
      }),
      // 泄漏 1 条 fabricated 为 verified（Arm A 无捏造的对照）
      completedModel({
        tag: "m3",
        armA: { proposals: 5, refused: false, fabricatedQuoteRate: 0, misattributedQuoteRate: 0 },
        armB: {
          proposals: 5,
          pipelined: 5,
          fabricatedQuoteRate: 0.2,
          fabricatedLeaked: 1,
          fabricatedInterceptedRate: 0,
          verifiedRate: 0.8,
          dispositions: { verified: 4, quote_mismatch: 0 },
        },
      }),
      // 整模型失败（runtime）
      {
        tag: "m4",
        modelSpec: "gw-openai/m4",
        provider: "gw-openai",
        family: "openai",
        wire: "openai-completions",
        status: "failed",
        judge: "same-model",
        modelCalls: 0,
        durationMs: 0,
        errors: [{ scope: "m4/runtime", kind: "runtime_setup", detail: "x", at: "2026-09-18T00:00:00Z" }],
        failureDetail: "runtime_setup：x",
      },
    ];
    const aggregate = aggregateResults(results);
    expect(aggregate.modelsTotal).toBe(4);
    expect(aggregate.modelsCompleted).toBe(3);
    expect(aggregate.modelsFailed).toBe(1);
    expect(aggregate.armAMeasurable).toBe(2);
    expect(aggregate.armAHallucinating).toBe(1); // m2 拒答不入分母
    expect(aggregate.armAProposals).toBe(10);
    expect(aggregate.armAFabricated).toBe(5);
    // m1/m2: fabricated 0.4×5=2 各（泄漏 0）；m3: 0.2×5=1（泄漏 1）
    expect(aggregate.armBFabricated).toBe(5);
    expect(aggregate.armBFabricatedLeaked).toBe(1);
    expect(aggregate.armBFabricatedIntercepted).toBe(4);
    expect(aggregate.pipelineLeakRate).toBeCloseTo(1 / 5);
    expect(aggregate.armBPipelined).toBe(15);
  });

  it("Arm B 零捏造批次：分析明确 quote 拦截路径未被触发，不宣称拦截率", () => {
    const results: MultiModelModelResult[] = [
      completedModel({
        tag: "m0",
        armA: { proposals: 5, refused: false, fabricatedQuoteRate: 1, misattributedQuoteRate: 0 },
        armB: {
          proposals: 5,
          pipelined: 5,
          fabricatedQuoteRate: 0,
          fabricatedLeaked: 0,
          fabricatedInterceptedRate: 0,
          verifiedRate: 0.8,
          dispositions: { verified: 4, metadata_mismatch: 1 },
        },
      }),
    ];
    const aggregate = aggregateResults(results);
    expect(aggregate.armBFabricated).toBe(0);
    const analysis = buildAnalysis(results, aggregate).join("\n");
    expect(analysis).toContain("未被触发");
    expect(analysis).toContain("metadata_mismatch 1 条");
    expect(analysis).not.toContain("阻断是跨模型稳定的");
    // builder：limitations 按数据条件生成；renderer：分母为 0 的拦截列显式标注
    const report = buildMultiModelReport(results, { startedAt: "t0", finishedAt: "t1", durationMs: 1 });
    expect(report.limitations.some((item) => item.includes("未被触发"))).toBe(true);
    const markdown = multiModelReportMarkdown(report);
    expect(markdown).toContain("-（无捏造）");
  });

  it("分析行：evaluated models 措辞 + same-model 拒答与失败如实入文", () => {
    const results: MultiModelModelResult[] = [
      completedModel({ tag: "m1" }),
      completedModel({
        tag: "m2",
        armA: { proposals: 0, refused: true, fabricatedQuoteRate: 0, misattributedQuoteRate: 0 },
      }),
      {
        tag: "m3",
        modelSpec: "gw-openai/m3",
        provider: "gw-openai",
        family: "openai",
        wire: "openai-completions",
        status: "failed",
        judge: "same-model",
        modelCalls: 0,
        durationMs: 0,
        errors: [{ scope: "m3/runtime", kind: "timeout", detail: "x", at: "2026-09-18T00:00:00Z" }],
        failureDetail: "timeout：x",
      },
    ];
    const aggregate = aggregateResults(results);
    const analysis = buildAnalysis(results, aggregate);
    const joined = analysis.join("\n");
    expect(joined).toContain("evaluated models");
    expect(joined).toContain("m2"); // 拒答模型被点名
    expect(joined).toContain("m3"); // 失败模型被点名
    expect(joined).toContain("不局限");
  });
});

describe("M6.9.3 报告渲染", () => {
  it("Model Matrix / judge 偏差标记 / 目录快照 / limitations 齐全且可 JSON 序列化", () => {
    const report: MultiModelReport = {
      schemaVersion: 1,
      kind: "multi-model-live-evaluation",
      milestone: "M6.9.3",
      experiment: 1,
      name: "evidence-grounding-multi-model",
      dataset: "claude-compatible",
      scenarioId: "g1-rag-survey",
      proposalsPerArm: 5,
      execution: { mode: "serial", interModelPauseMs: 4000 },
      judge: {
        strategy: "same-model-per-target",
        bias: "same-model judge bias",
        detail: "fixture",
      },
      catalog: {
        scannedAt: "2026-09-18T18:00:00+08:00",
        endpoint: "GET https://api-gateway.glm.ai/v1/models",
        fieldsNotExposed: ["provider 归属", "context window"],
        models: [{ id: "fixture-model", family: "glm" }],
      },
      selection: [...MULTI_MODEL_TARGETS],
      models: [
        completedModel(),
        {
          tag: "failed-model",
          modelSpec: "gw-openai/failed-model",
          provider: "gw-openai",
          family: "openai",
          wire: "openai-completions",
          status: "failed",
          judge: "same-model",
          modelCalls: 0,
          durationMs: 0,
          errors: [{ scope: "failed-model/runtime", kind: "rate_limit", detail: "429", at: "2026-09-18T00:00:00Z" }],
          failureDetail: "rate_limit：429",
        },
      ],
      aggregate: {
        modelsTotal: 2,
        modelsCompleted: 1,
        modelsFailed: 1,
        armAMeasurable: 1,
        armAHallucinating: 1,
        armAProposals: 5,
        armAFabricated: 5,
        armBFabricated: 2,
        armBFabricatedIntercepted: 2,
        armBFabricatedLeaked: 0,
        armBPipelined: 5,
        armBVerified: 3,
        pipelineLeakRate: 0,
      },
      analysis: ["fixture 分析行"],
      errors: [{ scope: "failed-model/runtime", kind: "rate_limit", detail: "429", at: "2026-09-18T00:00:00Z" }],
      startedAt: "2026-09-18T00:00:00Z",
      finishedAt: "2026-09-18T00:10:00Z",
      durationMs: 600_000,
      limitations: ["fixture limitation"],
    };
    const markdown = multiModelReportMarkdown(report);
    expect(markdown).toContain("## Model Matrix");
    expect(markdown).toContain("| fixture-model |");
    expect(markdown).toContain("| failed-model |");
    expect(markdown).toContain("**aggregate（completed 1/2）**");
    expect(markdown).toContain("same-model judge bias");
    expect(markdown).toContain("## Gateway 模型目录（扫描快照）");
    expect(markdown).toContain("## Limitations");
    expect(markdown).toContain("- fixture limitation");
    expect(() => JSON.stringify(report)).not.toThrow();
    // 选择清单与目录快照的自一致性：每个 target 的 modelId 都在真快照里
    for (const target of MULTI_MODEL_TARGETS) {
      expect(GATEWAY_CATALOG_SNAPSHOT.models.some((entry) => entry.id === target.modelId)).toBe(true);
    }
  });

  it("模型清单满足覆盖要求（Anthropic / OpenAI / GLM / DeepSeek / Qwen，4~6 个）", () => {
    expect(MULTI_MODEL_TARGETS.length).toBeGreaterThanOrEqual(4);
    expect(MULTI_MODEL_TARGETS.length).toBeLessThanOrEqual(6);
    const families = new Set<string>(MULTI_MODEL_TARGETS.map((target) => target.family));
    for (const required of ["anthropic", "openai", "glm", "deepseek", "qwen"]) {
      expect(families.has(required)).toBe(true);
    }
    // 规格唯一（provider/model-id 不重复）
    const specs = MULTI_MODEL_TARGETS.map((target) => target.modelSpec);
    expect(new Set(specs).size).toBe(specs.length);
  });
});
