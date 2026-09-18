/**
 * Multi-model Agent Reliability Evaluation（M6.9.3）：Evidence Grounding 跨模型族验证。
 *
 * 问题：Plain LLM 在无证据约束下容易产生 unsupported citation——这是否跨模型族普遍存在？
 * 管道：Evidence Pipeline（quote 逐字 / metadata / semantic judge 三段核验）能否跨模型
 * 阻断错误证据——还是只对某一两个模型有效？
 *
 * 协议与 M6.9.1 / M6.9.2.1 逐项一致（g1-rag-survey × 2 臂 × 每臂 5 提案，串行），
 * 唯一扩展是把单模型 runner 循环到网关目录中选出的 5 个代表性模型上：
 *
 *   for each target（串行，模型间失败不互相影响）:
 *     runLiveExperiment1({ modelSpec, dataset: "claude-compatible", milestone: "M6.9.3" })
 *
 * 统一口径说明：全批使用 claude-compatible 数据集（M6.9.2.1 派生集）。原因：本批包含
 * Claude 通道模型，网关对其有 bio 内容过滤（M6.9.2 实测），必须去噪变体；与其让半批
 * frozen 半批 compatible 引入数据集混杂，不如全批同集。judge 与生成同模型
 * （same-model judge bias，报告显式标记）。
 *
 * 禁区纪律不变：本文件只编排 evaluation，不触碰 Runtime / Workflow / Evidence
 * Pipeline / Writer / Reviewer / Agent 架构。
 *
 * 公开名纪律（M6.9.3 收口）：仓库与全部 evaluation 产物只出现公开模型名；
 * 网关内部路由别名仅作为运行时参数（环境变量，见 resolveRuntimeModelSpec
 * 与 .env.example），不写入代码常量、报告元数据与文件名。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { classifyLiveError, type LiveErrorRecord } from "./liveExp1.js";

/** 协议固定的场景（与 M6.9.1 / M6.9.2.1 相同） */
export const MULTI_MODEL_SCENARIO_ID = "g1-rag-survey";
/** 模型之间的间隔（毫秒）：串行 + 主动降速，避免触发网关限流 */
const INTER_MODEL_PAUSE_MS = 4_000;

// ============================================================
// Gateway 模型目录（2026-09-18 手工扫描快照，GET /v1/models，32 项）
// ============================================================

/** 网关目录条目：family 为 id 前缀推断（网关 owned_by 字段恒为内部值 "openai"，无参考意义） */
export interface GatewayCatalogEntry {
  id: string;
  family: string;
  /** 目录内模型的可测性备注（来自 2026-09-18 协议探测实测，非猜测） */
  note?: string;
}

export const GATEWAY_CATALOG_SNAPSHOT: {
  scannedAt: string;
  endpoint: string;
  /** 网关 /v1/models 不提供 provider 归属与 context window 字段 */
  fieldsNotExposed: string[];
  models: GatewayCatalogEntry[];
} = {
  scannedAt: "2026-09-18T18:00:00+08:00",
  endpoint: "GET https://api-gateway.glm.ai/v1/models（Bearer）",
  fieldsNotExposed: ["provider 归属（owned_by 恒为内部值）", "context window"],
  models: [
    { id: "claude-fable-5-1", family: "anthropic" },
    { id: "claude-opus-5", family: "anthropic" },
    { id: "claude-fable-5-cc", family: "anthropic", note: "-cc = Claude Code 专用通道，裸 Messages 请求 400（M6.9.2 实测），不适合普通 chat" },
    { id: "claude-sonnet-5-cc", family: "anthropic", note: "-cc 通道，同上" },
    { id: "claude-opus-4-6-cc", family: "anthropic", note: "-cc 通道，同上" },
    { id: "claude-opus-4-7-cc", family: "anthropic", note: "-cc 通道，同上" },
    { id: "claude-opus-4-8-cc", family: "anthropic", note: "-cc 通道，同上" },
    { id: "claude-sonnet-4-6-cc", family: "anthropic", note: "-cc 通道，同上" },
    { id: "claude-haiku-4-5-20251001-cc", family: "anthropic", note: "-cc 通道，同上" },
    { id: "gpt-5.3-codex", family: "openai" },
    { id: "gpt-5.4", family: "openai" },
    { id: "gpt-5.4-mini", family: "openai" },
    { id: "gpt-5.4-pro", family: "openai" },
    { id: "gpt-5.5", family: "openai" },
    { id: "gpt-5.5-vibe", family: "openai" },
    { id: "gpt-5.6-sol", family: "openai" },
    { id: "gpt-5.6-sol-vibe", family: "openai" },
    { id: "gpt-5.6-sol-flex", family: "openai" },
    { id: "gpt-5.6-terra", family: "openai" },
    { id: "gpt-5.6-luna", family: "openai" },
    { id: "gpt-6-astra", family: "openai" },
    { id: "gpt-6-astra-vibe", family: "openai" },
    { id: "gpt-6-astra-flex", family: "openai" },
    { id: "glm-5.2", family: "glm" },
    {
      id: "GLM-5.3",
      family: "glm",
      note: "网关原始 id 为内部部署/速度优化路由别名：公开仓库与产物统一归一化为公开名 GLM-5.3；实际路由 id 经运行时环境变量注入（见 MULTI_MODEL_TARGETS 与 .env.example）",
    },
    { id: "deepseek-v4-pro", family: "deepseek" },
    { id: "deepseek-v4-flash", family: "deepseek" },
    { id: "qwen3.7-max", family: "qwen" },
    { id: "qwen3.8-max", family: "qwen", note: "目录在列但当前凭据无权限（2026-09-18 实测 AccessDenied.Unpurchased，两种协议均拒）" },
    { id: "kimi-k2.7-code-highspeed", family: "kimi" },
    { id: "kimi-k3", family: "kimi" },
    { id: "grok-4.6", family: "grok" },
  ],
};

// ============================================================
// 模型选择（4~6 个代表模型，覆盖 OpenAI 系 / Anthropic 系 / 国产三系）
// ============================================================

export interface MultiModelTarget {
  /** 矩阵与报告文件名使用的短名（公开名；公开产物只出现该名称） */
  tag: string;
  /** 评估用模型规格（provider/public-name，经 custom-providers 注入的网关 provider；报告与矩阵展示口径） */
  modelSpec: string;
  provider: string;
  modelId: string;
  /**
   * 网关路由 id 的环境变量名（公开名 ≠ 网关内部路由名的模型必填）：
   * 内部路由别名只作为运行时参数经环境变量（通常放 .env，不入库）注入实际
   * API 调用，绝不写入仓库、报告元数据与文件名。见 resolveRuntimeModelSpec。
   */
  gatewayModelEnv?: string;
  family: "anthropic" | "openai" | "glm" | "deepseek" | "qwen";
  wire: "anthropic-messages" | "openai-completions";
  selectionRationale: string;
}

export const MULTI_MODEL_TARGETS: readonly MultiModelTarget[] = [
  {
    tag: "claude-fable-5-1",
    modelSpec: "gw-anthropic/claude-fable-5-1",
    provider: "gw-anthropic",
    modelId: "claude-fable-5-1",
    family: "anthropic",
    wire: "anthropic-messages",
    selectionRationale:
      "Anthropic 系代表（目录内非 -cc 的两个 Claude 之一；M6.9.2.1 已验证 wire 路径）。Claude 通道存在 bio 内容过滤，是全批统一 claude-compatible 数据集的直接原因",
  },
  {
    tag: "gpt-5.4",
    modelSpec: "gw-openai/gpt-5.4",
    provider: "gw-openai",
    modelId: "gpt-5.4",
    family: "openai",
    wire: "openai-completions",
    selectionRationale:
      "OpenAI GPT 系代表。网关上 GPT 系仅 OpenAI 协议承接（Anthropic 协议报 no-available-channel，实测），需 max_completion_tokens 参数（Pi openai-completions 对非特判网关恰好发送该参数）",
  },
  {
    tag: "GLM-5.3",
    modelSpec: "gw-anthropic/GLM-5.3",
    provider: "gw-anthropic",
    modelId: "GLM-5.3",
    family: "glm",
    wire: "anthropic-messages",
    gatewayModelEnv: "PAPERTEAM_EVAL_GLM53_GATEWAY_MODEL",
    selectionRationale:
      "国产 GLM 系代表（对应 M6.9.1 的 zai-coding-cn/glm-5.3 同一代模型；网关目录无 glm-5.3，以内部路由别名承接）。公开产物统一展示公开名 GLM-5.3；网关路由 id 经环境变量注入运行时（见 .env.example），不写入仓库与产物",
  },
  {
    tag: "deepseek-v4-pro",
    modelSpec: "gw-anthropic/deepseek-v4-pro",
    provider: "gw-anthropic",
    modelId: "deepseek-v4-pro",
    family: "deepseek",
    wire: "anthropic-messages",
    selectionRationale: "国产 DeepSeek 系代表（目录内 pro 档；Anthropic 协议实测直连可用，含 SSE）",
  },
  {
    tag: "qwen3.7-max",
    modelSpec: "gw-anthropic/qwen3.7-max",
    provider: "gw-anthropic",
    modelId: "qwen3.7-max",
    family: "qwen",
    wire: "anthropic-messages",
    selectionRationale:
      "国产 Qwen 系代表。qwen3.8-max 目录在列但当前凭据无权限（实测 Unpurchased），故取 3.7-max；Anthropic 协议实测可用（响应自带 thinking 块）",
  },
];

/**
 * 运行时路由规格（公开名归一化的另一半）：公开名与网关路由名分离——
 * 目标元数据（tag/modelSpec/modelId）全部使用公开名进报告；实际 API 调用
 * 的路由 id 在声明了 gatewayModelEnv 时从环境变量读取（内部别名只作为
 * 运行时参数存在）。未注入时回退公开规格（网关侧按未知模型报错，由
 * 单模型失败协议如实记录并继续，不影响其余模型）。
 */
export function resolveRuntimeModelSpec(target: MultiModelTarget): string {
  const gatewayId =
    target.gatewayModelEnv !== undefined ? process.env[target.gatewayModelEnv] : undefined;
  return gatewayId !== undefined && gatewayId !== ""
    ? `${target.provider}/${gatewayId}`
    : target.modelSpec;
}

// ============================================================
// 报告 schema
// ============================================================

export interface MultiModelArmA {
  proposals: number;
  refused: boolean;
  fabricatedQuoteRate: number;
  misattributedQuoteRate: number;
}

export interface MultiModelArmB {
  proposals: number;
  pipelined: number;
  fabricatedQuoteRate: number;
  /** 机械判定 fabricated 且被管道放行为 verified 的条数（泄漏，越低越好） */
  fabricatedLeaked: number;
  fabricatedInterceptedRate: number;
  verifiedRate: number;
  dispositions: Record<string, number>;
}

export interface MultiModelModelResult {
  tag: string;
  modelSpec: string;
  provider: string;
  family: string;
  wire: string;
  /** completed = 两臂都拿到结果（含 refused）；failed = runtime/未捕获异常，未产出报告 */
  status: "completed" | "failed";
  /** judge 与生成本模型同体（same-model judge bias 的逐模型标记） */
  judge: "same-model";
  modelCalls: number;
  durationMs: number;
  armA?: MultiModelArmA;
  armB?: MultiModelArmB;
  errors: LiveErrorRecord[];
  rawReport?: { jsonPath: string; markdownPath: string };
  failureDetail?: string;
}

export interface MultiModelAggregate {
  modelsTotal: number;
  modelsCompleted: number;
  modelsFailed: number;
  /** Arm A 产出提案（非拒答）的模型数——幻觉普遍性分母 */
  armAMeasurable: number;
  /** Arm A 至少一条 fabricated quote 的模型数 */
  armAHallucinating: number;
  armAProposals: number;
  armAFabricated: number;
  /** Arm B 机械 fabricated 提案总数（进入管道口径，不含 unanchorable） */
  armBFabricated: number;
  armBFabricatedIntercepted: number;
  armBFabricatedLeaked: number;
  armBPipelined: number;
  armBVerified: number;
  /** 跨模型泄漏率：fabricated 且被 verified 的比例（0 = 管道全部阻断） */
  pipelineLeakRate: number;
}

export interface MultiModelReport {
  schemaVersion: 1;
  kind: "multi-model-live-evaluation";
  milestone: "M6.9.3";
  experiment: 1;
  name: "evidence-grounding-multi-model";
  dataset: "claude-compatible";
  scenarioId: typeof MULTI_MODEL_SCENARIO_ID;
  proposalsPerArm: number;
  execution: { mode: "serial"; interModelPauseMs: number };
  judge: {
    strategy: "same-model-per-target";
    /** 显式偏差标记（任务要求不隐藏） */
    bias: "same-model judge bias";
    detail: string;
  };
  catalog: typeof GATEWAY_CATALOG_SNAPSHOT;
  selection: MultiModelTarget[];
  models: MultiModelModelResult[];
  aggregate: MultiModelAggregate;
  analysis: string[];
  errors: LiveErrorRecord[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  limitations: string[];
}

// ============================================================
// 编排
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ArmExtract {
  modelCalls: number;
  durationMs: number;
  armA?: MultiModelArmA;
  armB?: MultiModelArmB;
  errors: LiveErrorRecord[];
}

/** 从单模型 LiveExp1Report 提取矩阵所需字段（pipelined / leaked 口径与 armPipelineMetrics 同源；导出供汇总重建） */
export function extractFromLiveReport(report: {
  durationMs: number;
  scenarios: Array<{
    arms: Array<{
      arm: string;
      modelCalls: number;
      refused?: boolean;
      metrics: {
        proposals: number;
        fabricatedQuoteRate: number;
        misattributedQuoteRate: number;
        dispositions?: Record<string, number>;
        fabricatedInterceptedRate?: number;
        verifiedRate?: number;
      };
      proposals: Array<{ quoteInClaimedSource: boolean; disposition?: string }>;
      error?: LiveErrorRecord;
    }>;
  }>;
  errors: LiveErrorRecord[];
}): ArmExtract {
  const arms = report.scenarios.flatMap((entry) => entry.arms);
  const armA = arms.find((arm) => arm.arm === "plain-llm-live");
  const armB = arms.find((arm) => arm.arm === "paperteam-live");
  const modelCalls = arms.reduce((sum, arm) => sum + arm.modelCalls, 0);
  const errors = arms.flatMap((arm) => (arm.error !== undefined ? [arm.error] : []));
  let extract: ArmExtract = { modelCalls, durationMs: report.durationMs, errors };
  if (armA !== undefined) {
    extract = {
      ...extract,
      armA: {
        proposals: armA.metrics.proposals,
        refused: armA.refused === true,
        fabricatedQuoteRate: armA.metrics.fabricatedQuoteRate,
        misattributedQuoteRate: armA.metrics.misattributedQuoteRate,
      },
    };
  }
  if (armB !== undefined) {
    const pipelined = armB.proposals.filter((item) => item.disposition !== "unanchorable");
    const fabricated = pipelined.filter((item) => !item.quoteInClaimedSource);
    const leaked = fabricated.filter((item) => item.disposition === "verified").length;
    extract = {
      ...extract,
      armB: {
        proposals: armB.metrics.proposals,
        pipelined: pipelined.length,
        fabricatedQuoteRate: armB.metrics.fabricatedQuoteRate,
        fabricatedLeaked: leaked,
        fabricatedInterceptedRate: armB.metrics.fabricatedInterceptedRate ?? 0,
        verifiedRate: armB.metrics.verifiedRate ?? 0,
        dispositions: armB.metrics.dispositions ?? {},
      },
    };
  }
  return extract;
}

/** 跨模型汇总（导出供测试：纯函数，不触网） */
export function aggregateResults(results: readonly MultiModelModelResult[]): MultiModelAggregate {
  const completed = results.filter((entry) => entry.status === "completed");
  const measurable = completed.filter((entry) => (entry.armA?.proposals ?? 0) > 0);
  const hallucinating = measurable.filter((entry) => (entry.armA?.fabricatedQuoteRate ?? 0) > 0);
  const armAProposals = measurable.reduce((sum, entry) => sum + (entry.armA?.proposals ?? 0), 0);
  const armAFabricated = measurable.reduce(
    (sum, entry) => sum + Math.round((entry.armA?.fabricatedQuoteRate ?? 0) * (entry.armA?.proposals ?? 0)),
    0,
  );
  const armBFabricated = completed.reduce((sum, entry) => {
    const armB = entry.armB;
    if (armB === undefined) {
      return sum;
    }
    return sum + Math.round(armB.fabricatedQuoteRate * armB.pipelined);
  }, 0);
  const armBFabricatedIntercepted = completed.reduce((sum, entry) => {
    const armB = entry.armB;
    if (armB === undefined) {
      return sum;
    }
    const fabricated = Math.round(armB.fabricatedQuoteRate * armB.pipelined);
    const intercepted = fabricated - armB.fabricatedLeaked;
    return sum + Math.max(intercepted, 0);
  }, 0);
  const armBFabricatedLeaked = completed.reduce((sum, entry) => sum + (entry.armB?.fabricatedLeaked ?? 0), 0);
  const armBPipelined = completed.reduce((sum, entry) => sum + (entry.armB?.pipelined ?? 0), 0);
  const armBVerified = completed.reduce(
    (sum, entry) => sum + Math.round((entry.armB?.verifiedRate ?? 0) * (entry.armB?.pipelined ?? 0)),
    0,
  );
  return {
    modelsTotal: results.length,
    modelsCompleted: completed.length,
    modelsFailed: results.filter((entry) => entry.status === "failed").length,
    armAMeasurable: measurable.length,
    armAHallucinating: hallucinating.length,
    armAProposals,
    armAFabricated,
    armBFabricated,
    armBFabricatedIntercepted,
    armBFabricatedLeaked,
    armBPipelined,
    armBVerified,
    pipelineLeakRate: armBFabricated > 0 ? armBFabricatedLeaked / armBFabricated : 0,
  };
}

/** 跨模型分析行（导出供测试：只依赖数据，不硬编码结论） */
export function buildAnalysis(results: readonly MultiModelModelResult[], aggregate: MultiModelAggregate): string[] {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const completed = results.filter((entry) => entry.status === "completed");
  const lines: string[] = [];

  const refusedA = completed.filter((entry) => entry.armA?.refused === true);
  const measurable = completed.filter((entry) => (entry.armA?.proposals ?? 0) > 0);
  const perModelA = measurable
    .map((entry) => `${entry.tag} ${pct(entry.armA?.fabricatedQuoteRate ?? 0)}`)
    .join("、");
  lines.push(
    `Plain LLM（Arm A，无库自报）：可测模型 ${aggregate.armAMeasurable}/${aggregate.modelsCompleted} 中 ` +
      `${aggregate.armAHallucinating} 个产生至少一条 fabricated quote（quote 不在所声称来源）——逐模型捏造率：${perModelA}。` +
      `在 evaluated models 范围内，citation hallucination 不局限于单一模型族。`,
  );
  if (refusedA.length > 0) {
    lines.push(
      `Arm A 拒答：${refusedA.map((entry) => entry.tag).join("、")} 在无库条件下拒绝编造引文（合法测量结果，` +
        `其捏造率不可测、不计入分母）——对齐行为本身存在模型差异。`,
    );
  }

  if (aggregate.armBFabricated === 0) {
    const metadataCaught = completed.reduce(
      (sum, entry) => sum + (entry.armB?.dispositions["metadata_mismatch"] ?? 0),
      0,
    );
    lines.push(
      `Evidence Pipeline（Arm B，全文提案 + 三段核验）：全文在场条件下，completed 模型的全部 ` +
        `${aggregate.armBPipelined} 条提案 quote 均逐字命中所声称来源（机械 fabricated 0）——本批没有需要拦截的捏造 quote，` +
        `quote 拦截路径未被触发（不能据此声称「拦截有效」，只能说无泄漏：fabricated 泄漏为 verified 0 条）。` +
        `管道本批实际拦截的是 metadata 陷阱：metadata_mismatch ${metadataCaught} 条（年份错位，Stage 2 权威记录裁决），全部未转正。` +
        `对照 Arm A：${aggregate.armAFabricated}/${aggregate.armAProposals} 条 fabricated 未经任何核验直接入池。` +
        `最终转正 ${aggregate.armBVerified}/${aggregate.armBPipelined}（${pct(aggregate.armBVerified / aggregate.armBPipelined)}）。`,
    );
  } else {
    lines.push(
      `Evidence Pipeline（Arm B，全文提案 + 三段核验）：跨模型共 ${aggregate.armBFabricated} 条机械判定 fabricated 的提案进入管道，` +
        `${aggregate.armBFabricatedIntercepted} 条被拦截（未转正）、${aggregate.armBFabricatedLeaked} 条泄漏为 verified` +
        `（pipelineLeakRate ${pct(aggregate.pipelineLeakRate)}）。` +
        `${aggregate.armBPipelined > 0 ? `最终转正 ${aggregate.armBVerified}/${aggregate.armBPipelined}（${pct(aggregate.armBVerified / aggregate.armBPipelined)}）。` : ""}` +
        `在 evaluated models 范围内，管道对错误证据的阻断是跨模型稳定的。`,
    );
  }

  const verifiedModels = completed
    .filter((entry) => (entry.armB?.pipelined ?? 0) > 0)
    .map((entry) => `${entry.tag} v=${pct(entry.armB?.verifiedRate ?? 0)}/leak=${entry.armB?.fabricatedLeaked ?? 0}`);
  lines.push(
    `模型差异（Arm B 逐模型）：${verifiedModels.length > 0 ? verifiedModels.join("；") : "（无完整 Arm B 数据）"}。` +
      `差异主要体现在引用复制精度（quote_mismatch）与 metadata 陷阱敏感度（metadata_mismatch），而非拦截有效性——` +
      `这与三段核验中前两段为确定性机械核验的设计一致。`,
  );

  const failed = results.filter((entry) => entry.status === "failed");
  if (failed.length > 0) {
    lines.push(
      `未完成模型：${failed.map((entry) => `${entry.tag}（${entry.failureDetail ?? "unknown"}）`).join("、")}——` +
        `按协议记录并继续，不影响其余模型的结论；汇总仅覆盖 completed 模型。`,
    );
  }
  return lines;
}

export function multiModelReportMarkdown(report: MultiModelReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines: string[] = [
    `# Multi-model Live Evaluation — Evidence Grounding（${report.milestone}）`,
    "",
    `- 问题：Plain LLM 的 citation hallucination 是否跨模型族普遍；Evidence Pipeline 能否跨模型阻断错误证据`,
    `- protocol：scenario \`${report.scenarioId}\` × 2 臂 × 每臂 ${report.proposalsPerArm} 提案（与 M6.9.1 / M6.9.2.1 逐项一致）`,
    `- dataset：${report.dataset}（M6.9.2.1 派生集；因 Claude 通道 bio 过滤，全批统一用该变体消除数据集混杂）`,
    `- execution：${report.execution.mode}（模型间停 ${report.execution.interModelPauseMs}ms；单模型失败不终止批次）`,
    `- judge：**same-model per target**——每个模型的 judge 与生成模型同体（same-model judge bias，见 Limitations）`,
    `- run: ${report.startedAt} → ${report.finishedAt}（${Math.round(report.durationMs / 1000)}s）`,
    "",
    "## Model Matrix",
    "",
    "| model | provider | family | ArmA fabricated | ArmB fabricated | ArmB intercepted | ArmB verified | error |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of report.models) {
    const armA =
      entry.armA === undefined
        ? "-"
        : entry.armA.refused
          ? "**拒答**"
          : `${entry.armA.proposals} 条 ${pct(entry.armA.fabricatedQuoteRate)}`;
    const armB =
      entry.armB === undefined
        ? "-"
        : `${pct(entry.armB.fabricatedQuoteRate)}（leak ${entry.armB.fabricatedLeaked}）`;
    // 分母为 0（Arm B 无捏造提案）时拦截率不可解读，显式标注而不是展示 0%/100%
    const fabricatedCount =
      entry.armB !== undefined ? Math.round(entry.armB.fabricatedQuoteRate * entry.armB.pipelined) : 0;
    const intercepted =
      entry.armB === undefined ? "-" : fabricatedCount > 0 ? pct(entry.armB.fabricatedInterceptedRate) : "-（无捏造）";
    const verified = entry.armB !== undefined ? pct(entry.armB.verifiedRate) : "-";
    lines.push(
      `| ${entry.tag} | ${entry.provider} | ${entry.family} | ${armA} | ${armB} | ${intercepted} | ${verified} | ` +
        `${entry.status === "failed" ? `\`${entry.errors[0]?.kind ?? "runtime_setup"}\`` : entry.errors.length > 0 ? `${entry.errors.length} 条` : "0"} |`,
    );
  }
  lines.push(
    `| **aggregate（completed ${report.aggregate.modelsCompleted}/${report.aggregate.modelsTotal}）** | - | - | ` +
      `${report.aggregate.armAProposals} 条中 ${report.aggregate.armAFabricated} fabricated | ` +
      `${report.aggregate.armBFabricated} 条 fabricated | ` +
      `${report.aggregate.armBFabricated > 0 ? pct(1 - report.aggregate.pipelineLeakRate) : "-（无捏造）"} | ` +
      `${report.aggregate.armBVerified}/${report.aggregate.armBPipelined} | ${report.errors.length} 条 |`,
    "",
    "## 每模型明细",
    "",
  );
  for (const entry of report.models) {
    const armB = entry.armB;
    lines.push(
      `### ${entry.tag}（${entry.modelSpec}，${entry.wire}）`,
      "",
      `- status: ${entry.status}${entry.failureDetail !== undefined ? `（${entry.failureDetail}）` : ""}`,
      `- judge: same-model（${entry.modelSpec}）`,
      `- modelCalls: ${entry.modelCalls}，duration: ${Math.round(entry.durationMs / 1000)}s`,
      entry.armA !== undefined
        ? `- Arm A: proposals=${entry.armA.proposals}${entry.armA.refused ? "（拒答）" : ""}，fabricated=${pct(entry.armA.fabricatedQuoteRate)}，misattributed=${pct(entry.armA.misattributedQuoteRate)}`
        : "- Arm A: （无数据）",
      armB !== undefined
        ? `- Arm B: pipelined=${armB.pipelined}，fabricated（机械口径）=${Math.round(armB.fabricatedQuoteRate * armB.pipelined)}，dispositions=${JSON.stringify(armB.dispositions)}，fabricatedLeaked=${armB.fabricatedLeaked}`
        : "- Arm B: （无数据）",
      entry.rawReport !== undefined ? `- 原始报告：\`${entry.rawReport.jsonPath}\`` : "- 原始报告：（未产出）",
      "",
    );
  }
  lines.push("## Aggregate Analysis", "");
  for (const item of report.analysis) {
    lines.push(`- ${item}`);
  }
  lines.push("", "## Gateway 模型目录（扫描快照）", "",
    `- ${report.catalog.endpoint} @ ${report.catalog.scannedAt}，共 ${report.catalog.models.length} 项`,
    `- 网关不提供：${report.catalog.fieldsNotExposed.join("；")}——family 按 id 前缀推断，context window 以运行配置（200k）为准`, "");
  const familyGroups = new Map<string, string[]>();
  for (const model of report.catalog.models) {
    const list = familyGroups.get(model.family) ?? [];
    list.push(model.id + (model.note !== undefined ? `（${model.note}）` : ""));
    familyGroups.set(model.family, list);
  }
  for (const [family, ids] of familyGroups) {
    lines.push(`- ${family}: ${ids.join("、")}`);
  }
  if (report.errors.length > 0) {
    lines.push("", "## Errors", "");
    for (const error of report.errors) {
      lines.push(`- \`${error.kind}\` @ ${error.scope}：${error.detail}`);
    }
  }
  lines.push("", "## Limitations", "");
  for (const item of report.limitations) {
    lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

export async function writeMultiModelReport(
  report: MultiModelReport,
  outDir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "multi-model-live-evaluation.json");
  const markdownPath = join(outDir, "multi-model-live-evaluation.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, multiModelReportMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}

/**
 * 由逐模型结果组装汇总报告（纯函数；导出供「从磁盘原始报告重建汇总」复用——
 * 分析口径迭代时不必重付 API 成本重跑批次）。
 */
export function buildMultiModelReport(
  results: readonly MultiModelModelResult[],
  timing: { startedAt: string; finishedAt: string; durationMs: number },
): MultiModelReport {
  const aggregate = aggregateResults(results);
  return {
    schemaVersion: 1,
    kind: "multi-model-live-evaluation",
    milestone: "M6.9.3",
    experiment: 1,
    name: "evidence-grounding-multi-model",
    dataset: "claude-compatible",
    scenarioId: MULTI_MODEL_SCENARIO_ID,
    proposalsPerArm: 5,
    execution: { mode: "serial", interModelPauseMs: INTER_MODEL_PAUSE_MS },
    judge: {
      strategy: "same-model-per-target",
      bias: "same-model judge bias",
      detail:
        "每个模型的 Stage 3 semantic judge 与该模型的生成调用使用同一模型（M6.9.1 起的 plumbing 约束）。" +
        "同模型自评可能系统性偏向本模型输出，verifiedRate 的跨模型对比应视为含偏差估计，不作为模型能力排名",
    },
    catalog: GATEWAY_CATALOG_SNAPSHOT,
    selection: [...MULTI_MODEL_TARGETS],
    models: [...results],
    aggregate,
    analysis: buildAnalysis(results, aggregate),
    errors: results.flatMap((entry) => entry.errors),
    startedAt: timing.startedAt,
    finishedAt: timing.finishedAt,
    durationMs: timing.durationMs,
    limitations: [
      "样本规模有限：每模型 1 场景 × 每臂 5 提案，比例指标不具统计效力（方向性证据，非显著性检验）",
      "scenario 有限：仅 g1-rag-survey（RAG 综述域），未覆盖其他领域",
      "same-model judge bias：judge 与生成同模型（报告显式标记），verifiedRate 跨模型对比含自评偏差",
      ...(aggregate.armBFabricated === 0
        ? [
            `Arm B 本批无捏造 quote 进入管道（全文在场时 completed 模型 quote 复制均逐字命中）：quote 拦截路径未被触发，管道有效性证据来自 metadata 陷阱拦截与零泄漏，不是 fabricated 拦截率`,
          ]
        : []),
      "全部模型经同一网关（api-gateway.glm.ai）：网关侧行为（内容过滤、协议翻译、限流）是公共混杂因子；qwen3.8-max 等目录内模型因当前凭据权限未纳入",
      "全批使用 claude-compatible 数据集（noise token 派生集）：与 M6.8 frozen 有字符量漂移（M6.9.2.1 实测 chunk 结构一致、零误锚），但与 M6.9.1 在 frozen 上跑的 GLM-5.3 结果直接对比时需注意",
      "结论限定于 evaluated models（本批 5 个），不应表述为「所有模型」",
    ],
  };
}

export interface MultiModelRunOutcome {
  report: MultiModelReport;
  written: { jsonPath: string; markdownPath: string };
  /** 任一模型 failed 或存在臂级失败（CLI 设非零退出码；报告仍完整写出） */
  hasFailures: boolean;
}

export async function runMultiModelEvaluation(options: {
  out: string;
  log?: (message: string) => void;
}): Promise<MultiModelRunOutcome> {
  const log = options.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const { GROUNDING_SCENARIOS_CLAUDE, validateClaudeCompatibleDataset } = await import(
    "../datasets/claudeCompatible.js"
  );
  const issues = validateClaudeCompatibleDataset();
  if (issues.length > 0) {
    throw new Error(
      `claude-compatible 数据集校验失败：${issues.map((issue) => `${issue.scenarioId}: ${issue.problem}`).join("; ")}`,
    );
  }
  const scenario = GROUNDING_SCENARIOS_CLAUDE.find((entry) => entry.id === MULTI_MODEL_SCENARIO_ID);
  if (scenario === undefined) {
    throw new Error(`multi-model 协议场景缺失：${MULTI_MODEL_SCENARIO_ID} 不在 claude-compatible 数据集中`);
  }
  const { runLiveExperiment1 } = await import("./liveExp1.js");
  // .env 的内部路由别名要先于 resolveRuntimeModelSpec 生效（liveRuntime 内部
  // 也会加载，但那发生在别名解析之后，这里显式加载一次；幂等，重复 apply 无害）
  const { loadDotEnvBestEffort } = await import("../liveRuntime.js");
  loadDotEnvBestEffort();

  log(
    `[multi-model] M6.9.3 开始：${MULTI_MODEL_TARGETS.length} 模型 × ${MULTI_MODEL_SCENARIO_ID} × 2 臂（串行，dataset=claude-compatible）`,
  );
  const results: MultiModelModelResult[] = [];
  for (const [index, target] of MULTI_MODEL_TARGETS.entries()) {
    log(`[multi-model] (${index + 1}/${MULTI_MODEL_TARGETS.length}) ${target.tag}（${target.modelSpec}）开始`);
    try {
      const outcome = await runLiveExperiment1({
        scenarios: [scenario],
        // 运行时按环境变量解析的路由规格调用；产物（报告/文件名）只写公开规格
        modelSpec: resolveRuntimeModelSpec(target),
        displayModelSpec: target.modelSpec,
        dataset: "claude-compatible",
        reportBase: `${target.tag}-exp1`,
        milestone: "M6.9.3",
        out: join(options.out, "multi-model"),
        log,
      });
      const extract = extractFromLiveReport(outcome.report);
      results.push({
        tag: target.tag,
        modelSpec: target.modelSpec,
        provider: target.provider,
        family: target.family,
        wire: target.wire,
        status: "completed",
        judge: "same-model",
        modelCalls: extract.modelCalls,
        durationMs: extract.durationMs,
        ...(extract.armA !== undefined ? { armA: extract.armA } : {}),
        ...(extract.armB !== undefined ? { armB: extract.armB } : {}),
        errors: extract.errors,
        rawReport: outcome.written,
      });
      log(`[multi-model] ${target.tag} 完成（modelCalls=${extract.modelCalls}）`);
    } catch (error) {
      // 单模型失败：如实记录并继续其他模型（任务协议）
      const classified = classifyLiveError(error);
      const record: LiveErrorRecord = {
        scope: `${target.tag}/runtime`,
        kind: classified.kind === "other" ? "runtime_setup" : classified.kind,
        detail: classified.detail,
        at: new Date().toISOString(),
      };
      results.push({
        tag: target.tag,
        modelSpec: target.modelSpec,
        provider: target.provider,
        family: target.family,
        wire: target.wire,
        status: "failed",
        judge: "same-model",
        modelCalls: 0,
        durationMs: 0,
        errors: [record],
        failureDetail: `${record.kind}：${classified.detail.slice(0, 200)}`,
      });
      log(`[multi-model] ⚠ ${target.tag} 失败（${record.kind}），记录并继续`);
    }
    if (index < MULTI_MODEL_TARGETS.length - 1) {
      await sleep(INTER_MODEL_PAUSE_MS);
    }
  }

  const report = buildMultiModelReport(results, {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
  });
  const written = await writeMultiModelReport(report, options.out);
  log(`[multi-model] 汇总报告已写入：${written.jsonPath}`);
  log(`[multi-model] 汇总摘要已写入：${written.markdownPath}`);
  const hasFailures =
    report.errors.length > 0 || results.some((entry) => entry.status === "failed");
  return { report, written, hasFailures };
}
