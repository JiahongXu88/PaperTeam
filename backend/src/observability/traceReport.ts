/**
 * M10.4.0 performance-report.md 生成器（纯函数，无 IO）。
 *
 * 输入 run-trace 快照（RunTraceDocument），输出人类可读 Markdown：
 * - 总时长（wall）与有效执行时长（stage union）、空隙（HITL 等待为主）
 * - stage 时间线（critical path：顺序 + 段间空隙）
 * - 最慢 stage / phase 汇总（import / research / evidence / revision / …）
 * - 模型调用（次数 / latency 分布 / token / 成本 / retry，按模型与按 stage）
 * - 工具调用（次数 / 失败 / 最慢）
 * - Agent 任务汇总
 *
 * 只读 trace 数据做聚合，不做任何推断性补值：没有 usage 的 span 不计成本。
 */

import type { RunTraceDocument, TraceSpan } from "./trace.js";

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "—";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(".000Z", "Z");
}

function pct(part: number, total: number): string {
  if (total <= 0) {
    return "—";
  }
  return `${((part / total) * 100).toFixed(1)}%`;
}

function num(attributes: Record<string, unknown>, key: string): number | undefined {
  const value = attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(attributes: Record<string, unknown>, key: string): string {
  const value = attributes[key];
  return typeof value === "string" ? value : "—";
}

function phaseOf(stageId: string): string {
  const dot = stageId.indexOf(".");
  return dot > 0 ? stageId.slice(0, dot) : stageId;
}

interface SpanGroup {
  key: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  costSpans: number;
}

function newGroup(key: string): SpanGroup {
  return {
    key,
    count: 0,
    totalMs: 0,
    minMs: Number.POSITIVE_INFINITY,
    maxMs: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    costSpans: 0,
  };
}

function accumulate(group: SpanGroup, span: TraceSpan): void {
  group.count += 1;
  group.totalMs += span.durationMs;
  group.minMs = Math.min(group.minMs, span.durationMs);
  group.maxMs = Math.max(group.maxMs, span.durationMs);
  if (span.status === "error") {
    group.errors += 1;
  }
  group.inputTokens += num(span.attributes, "model.inputTokens") ?? num(span.attributes, "task.inputTokens") ?? 0;
  group.outputTokens += num(span.attributes, "model.outputTokens") ?? num(span.attributes, "task.outputTokens") ?? 0;
  group.cacheReadTokens += num(span.attributes, "model.cacheReadTokens") ?? num(span.attributes, "task.cacheReadTokens") ?? 0;
  group.cacheWriteTokens += num(span.attributes, "model.cacheWriteTokens") ?? num(span.attributes, "task.cacheWriteTokens") ?? 0;
  const cost = num(span.attributes, "model.estimatedCost") ?? num(span.attributes, "task.estimatedCost");
  if (cost !== undefined) {
    group.cost += cost;
    group.costSpans += 1;
  }
}

/** span 区间并集总时长（stage 并行 / 重叠时不重复计数） */
function unionDurationMs(spans: TraceSpan[]): number {
  const intervals = spans
    .map((span) => ({ start: span.startMs, end: Math.max(span.endMs, span.startMs + 1) }))
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let currentStart = Number.NaN;
  let currentEnd = Number.NaN;
  for (const interval of intervals) {
    if (Number.isNaN(currentStart) || interval.start > currentEnd) {
      if (!Number.isNaN(currentStart)) {
        total += currentEnd - currentStart;
      }
      currentStart = interval.start;
      currentEnd = interval.end;
    } else {
      currentEnd = Math.max(currentEnd, interval.end);
    }
  }
  if (!Number.isNaN(currentStart)) {
    total += currentEnd - currentStart;
  }
  return total;
}

function groupTable(groups: SpanGroup[], columns: ReadonlyArray<{ header: string; cell: (group: SpanGroup) => string }>): string {
  const header = `| ${columns.map((column) => column.header).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const rows = groups.map((group) => `| ${columns.map((column) => column.cell(group)).join(" | ")} |`);
  return [header, separator, ...rows].join("\n");
}

/** 由 run-trace 快照生成 performance-report.md（纯函数） */
export function buildPerformanceReport(doc: RunTraceDocument): string {
  const spans = doc.spans;
  const stageSpans = spans.filter((span) => span.name.startsWith("stage:"));
  const hitlPayloadSpans = spans.filter((span) => span.name.startsWith("hitl-payload:"));
  const taskSpans = spans.filter((span) => span.name === "agent.task");
  const modelSpans = spans.filter((span) => span.name === "model.turn");
  const toolSpans = spans.filter((span) => span.name === "tool.call");

  const wallStart = Math.min(doc.createdAtMs, ...spans.map((span) => span.startMs));
  const wallEnd = doc.finishedAtMs ?? doc.updatedAtMs;
  const wallMs = Math.max(0, wallEnd - wallStart);
  const busyMs = unionDurationMs(stageSpans);
  const gapMs = Math.max(0, wallMs - busyMs);

  // 重试与压缩（task span events 为准；属性计数同源，仅在无 events 时兜底）
  const countEvents = (name: string): number =>
    spans.reduce((sum, span) => sum + (span.events ?? []).filter((event) => event.name === name).length, 0);
  const autoRetries =
    countEvents("auto_retry") ||
    taskSpans.reduce((sum, span) => sum + (num(span.attributes, "task.retriesAuto") ?? 0), 0);
  const agentRetries =
    countEvents("agent_retry") ||
    taskSpans.reduce((sum, span) => sum + (num(span.attributes, "task.retriesAgent") ?? 0), 0);
  const compactions =
    countEvents("compaction_start") ||
    taskSpans.reduce((sum, span) => sum + (num(span.attributes, "task.compactions") ?? 0), 0);

  const lines: string[] = [];
  lines.push(`# Performance Report — ${doc.traceId}`);
  lines.push("");
  lines.push(`- workflow: \`${doc.workflowKind}\``);
  lines.push(`- project: \`${doc.projectId}\``);
  lines.push(`- run 状态: ${doc.runStatus ?? "(进行中 / 未知)"}`);
  lines.push(
    `- 窗口: ${fmtTime(wallStart)} → ${fmtTime(wallEnd)}（快照生成 ${fmtTime(doc.updatedAtMs)}）`,
  );
  lines.push(`- spans: ${spans.length}（stage ${stageSpans.length} / task ${taskSpans.length} / model ${modelSpans.length} / tool ${toolSpans.length}）${doc.droppedSpans > 0 ? `；⚠ 丢弃 ${doc.droppedSpans} 条（超单 run 上限）` : ""}`);
  lines.push("");
  lines.push("## 1. 总览");
  lines.push("");
  lines.push(`| 指标 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 总时长（wall） | **${fmtMs(wallMs)}** |`);
  lines.push(`| 有效执行时长（stage 并集） | ${fmtMs(busyMs)}（${pct(busyMs, wallMs)}） |`);
  lines.push(`| 空隙（HITL 等待 / 引擎开销） | ${fmtMs(gapMs)}（${pct(gapMs, wallMs)}） |`);
  lines.push(`| stage 尝试次数 | ${stageSpans.length} 次（hitl-payload ${hitlPayloadSpans.length} 次） |`);
  lines.push(`| 模型调用（assistant turn） | ${modelSpans.length} 次 |`);
  lines.push(`| 模型重试 | auto-retry ${autoRetries} 次 + agent retry ${agentRetries} 次 |`);
  lines.push(`| 上下文压缩（compaction） | ${compactions} 次 |`);
  lines.push(`| Agent 任务 | ${taskSpans.length} 次 |`);
  lines.push(`| 工具调用 | ${toolSpans.length} 次（失败 ${toolSpans.filter((span) => span.status === "error").length}） |`);
  lines.push("");

  // ---- 2. Stage 时间线（critical path） ----
  lines.push("## 2. Stage 时间线（critical path，按开始时间）");
  lines.push("");
  lines.push("| # | stage | 尝试 | 状态 | 开始 | 耗时 | 与上一段空隙 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  const timeline = [...stageSpans].sort((a, b) => a.startMs - b.startMs);
  let previousEnd: number | undefined;
  timeline.forEach((span, index) => {
    const gap = previousEnd === undefined ? 0 : Math.max(0, span.startMs - previousEnd);
    lines.push(
      `| ${index + 1} | \`${str(span.attributes, "stage.id")}\` | ${num(span.attributes, "stage.attempt") ?? 1} | ${span.status === "ok" ? "✅" : "❌"} | ${fmtTime(span.startMs)} | ${fmtMs(span.durationMs)} | ${previousEnd === undefined ? "—" : fmtMs(gap)} |`,
    );
    previousEnd = Math.max(previousEnd ?? span.endMs, span.endMs);
  });
  if (timeline.length === 0) {
    lines.push("| — | （无 stage span） | | | | | |");
  }
  lines.push("");
  lines.push("> 空隙大段通常是 HITL 等待（awaiting_input）或 stage 间引擎开销；工具/模型耗时见 §4/§5。");
  lines.push("");

  // ---- 3. 最慢 stage + phase 汇总 ----
  const byStage = new Map<string, SpanGroup>();
  for (const span of stageSpans) {
    const key = str(span.attributes, "stage.id");
    const group = byStage.get(key) ?? newGroup(key);
    accumulate(group, span);
    byStage.set(key, group);
  }
  const slowest = [...byStage.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 12);
  lines.push("## 3. 最慢 Stage（按累计耗时，Top 12）");
  lines.push("");
  lines.push(
    groupTable(slowest, [
      { header: "stage", cell: (group) => `\`${group.key}\`` },
      { header: "尝试", cell: (group) => String(group.count) },
      { header: "累计", cell: (group) => fmtMs(group.totalMs) },
      { header: "占比(busy)", cell: (group) => pct(group.totalMs, busyMs) },
      { header: "最长一次", cell: (group) => fmtMs(group.maxMs) },
      { header: "失败", cell: (group) => String(group.errors) },
    ]),
  );
  lines.push("");
  const byPhase = new Map<string, SpanGroup>();
  for (const span of stageSpans) {
    const key = phaseOf(str(span.attributes, "stage.id"));
    const group = byPhase.get(key) ?? newGroup(key);
    accumulate(group, span);
    byPhase.set(key, group);
  }
  const phases = [...byPhase.values()].sort((a, b) => b.totalMs - a.totalMs);
  lines.push("## 3b. Phase 汇总（stage 前缀）");
  lines.push("");
  lines.push(
    groupTable(phases, [
      { header: "phase", cell: (group) => `\`${group.key}\`` },
      { header: "尝试", cell: (group) => String(group.count) },
      { header: "累计", cell: (group) => fmtMs(group.totalMs) },
      { header: "占比(busy)", cell: (group) => pct(group.totalMs, busyMs) },
    ]),
  );
  lines.push("");

  // ---- 4. 模型调用 ----
  const modelTotal = modelSpans.reduce((sum, span) => sum + span.durationMs, 0);
  const modelInput = modelSpans.reduce((sum, span) => sum + (num(span.attributes, "model.inputTokens") ?? 0), 0);
  const modelOutput = modelSpans.reduce((sum, span) => sum + (num(span.attributes, "model.outputTokens") ?? 0), 0);
  const modelCacheRead = modelSpans.reduce((sum, span) => sum + (num(span.attributes, "model.cacheReadTokens") ?? 0), 0);
  const modelCacheWrite = modelSpans.reduce((sum, span) => sum + (num(span.attributes, "model.cacheWriteTokens") ?? 0), 0);
  const modelCost = modelSpans.reduce((sum, span) => sum + (num(span.attributes, "model.estimatedCost") ?? 0), 0);
  const modelLatencies = modelSpans.map((span) => span.durationMs).sort((a, b) => a - b);
  const median = modelLatencies[Math.floor(modelLatencies.length / 2)] ?? 0;
  const p95 = modelLatencies[Math.min(modelLatencies.length - 1, Math.floor(modelLatencies.length * 0.95))] ?? 0;
  lines.push("## 4. 模型调用");
  lines.push("");
  lines.push(`| 指标 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 调用次数（assistant turn） | ${modelSpans.length} |`);
  lines.push(`| 总 latency | ${fmtMs(modelTotal)}（占 busy ${pct(modelTotal, busyMs)}） |`);
  lines.push(
    `| latency 分布 | median ${fmtMs(median)} / p95 ${fmtMs(p95)} / max ${fmtMs(modelLatencies.at(-1) ?? 0)} |`,
  );
  lines.push(`| input tokens | ${modelInput.toLocaleString("en-US")} |`);
  lines.push(`| output tokens | ${modelOutput.toLocaleString("en-US")} |`);
  lines.push(`| cache read / write | ${modelCacheRead.toLocaleString("en-US")} / ${modelCacheWrite.toLocaleString("en-US")} |`);
  lines.push(`| 成本估算（provider list-price） | ${modelCost > 0 ? `$${modelCost.toFixed(4)}` : "—（未返回）"} |`);
  lines.push("");
  const byModel = new Map<string, SpanGroup>();
  for (const span of modelSpans) {
    const key = str(span.attributes, "model.label");
    const group = byModel.get(key) ?? newGroup(key);
    accumulate(group, span);
    byModel.set(key, group);
  }
  if (byModel.size > 0) {
    lines.push("### 4b. 按模型");
    lines.push("");
    lines.push(
      groupTable([...byModel.values()].sort((a, b) => b.totalMs - a.totalMs), [
        { header: "model", cell: (group) => `\`${group.key}\`` },
        { header: "次数", cell: (group) => String(group.count) },
        { header: "总 latency", cell: (group) => fmtMs(group.totalMs) },
        { header: "median≈", cell: (group) => fmtMs(group.count > 0 ? group.totalMs / group.count : 0) },
        { header: "max", cell: (group) => fmtMs(group.maxMs) },
        { header: "in / out tokens", cell: (group) => `${group.inputTokens.toLocaleString("en-US")} / ${group.outputTokens.toLocaleString("en-US")}` },
        { header: "成本", cell: (group) => (group.costSpans > 0 ? `$${group.cost.toFixed(4)}` : "—") },
      ]),
    );
    lines.push("");
  }
  const modelByStage = new Map<string, SpanGroup>();
  for (const span of modelSpans) {
    const key = str(span.attributes, "stage.id");
    const group = modelByStage.get(key) ?? newGroup(key);
    accumulate(group, span);
    modelByStage.set(key, group);
  }
  if (modelByStage.size > 0) {
    lines.push("### 4c. 按阶段（模型调用分布）");
    lines.push("");
    lines.push(
      groupTable([...modelByStage.values()].sort((a, b) => b.totalMs - a.totalMs), [
        { header: "stage", cell: (group) => `\`${group.key}\`` },
        { header: "模型调用", cell: (group) => String(group.count) },
        { header: "模型总 latency", cell: (group) => fmtMs(group.totalMs) },
        { header: "in / out tokens", cell: (group) => `${group.inputTokens.toLocaleString("en-US")} / ${group.outputTokens.toLocaleString("en-US")}` },
      ]),
    );
    lines.push("");
  }

  // ---- 5. 工具调用 ----
  const toolTotal = toolSpans.reduce((sum, span) => sum + span.durationMs, 0);
  lines.push("## 5. 工具调用");
  lines.push("");
  lines.push(`| 指标 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 调用次数 | ${toolSpans.length} |`);
  lines.push(`| 总耗时 | ${fmtMs(toolTotal)}（占 busy ${pct(toolTotal, busyMs)}） |`);
  lines.push(`| 失败 | ${toolSpans.filter((span) => span.status === "error").length} |`);
  lines.push("");
  const byTool = new Map<string, SpanGroup>();
  for (const span of toolSpans) {
    const key = str(span.attributes, "tool.name");
    const group = byTool.get(key) ?? newGroup(key);
    accumulate(group, span);
    byTool.set(key, group);
  }
  if (byTool.size > 0) {
    lines.push("### 5b. 按工具（按累计耗时）");
    lines.push("");
    lines.push(
      groupTable([...byTool.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 20), [
        { header: "tool", cell: (group) => `\`${group.key}\`` },
        { header: "次数", cell: (group) => String(group.count) },
        { header: "累计", cell: (group) => fmtMs(group.totalMs) },
        { header: "avg", cell: (group) => fmtMs(group.count > 0 ? group.totalMs / group.count : 0) },
        { header: "max", cell: (group) => fmtMs(group.maxMs) },
        { header: "失败", cell: (group) => String(group.errors) },
      ]),
    );
    lines.push("");
  }

  // ---- 6. Agent 任务 ----
  if (taskSpans.length > 0) {
    lines.push("## 6. Agent 任务");
    lines.push("");
    const byAgent = new Map<string, SpanGroup>();
    for (const span of taskSpans) {
      const key = str(span.attributes, "agent.id");
      const group = byAgent.get(key) ?? newGroup(key);
      accumulate(group, span);
      byAgent.set(key, group);
    }
    lines.push(
      groupTable([...byAgent.values()].sort((a, b) => b.totalMs - a.totalMs), [
        { header: "agent", cell: (group) => `\`${group.key}\`` },
        { header: "任务数", cell: (group) => String(group.count) },
        { header: "执行段总耗时", cell: (group) => fmtMs(group.totalMs) },
        { header: "avg", cell: (group) => fmtMs(group.count > 0 ? group.totalMs / group.count : 0) },
        { header: "in / out tokens", cell: (group) => `${group.inputTokens.toLocaleString("en-US")} / ${group.outputTokens.toLocaleString("en-US")}` },
        { header: "失败", cell: (group) => String(group.errors) },
      ]),
    );
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `_生成于 ${new Date().toISOString()}；数据源 run-trace.json（schema ${doc.schemaVersion}，OTel 兼容 span 形状）。成本为 provider list-price 估算，非实际账单。_`,
  );
  return lines.join("\n") + "\n";
}
