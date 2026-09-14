#!/usr/bin/env node
/**
 * M5.6 真实论文验收执行器（仅测试工具，不进入产品代码）。
 *
 *   node scripts/m5-acceptance.mjs --scenario improvement   --arm A|B --pdf <abs.pdf> --title "<t>" [--style suggest_only|apply_once]
 *   node scripts/m5-acceptance.mjs --scenario quick-review  --arm A|B --pdf <abs.pdf> --title "<t>" [--semantic off|contradiction_only|full]
 *   node scripts/m5-acceptance.mjs --scenario idea          --arm A|B --idea "<研究想法>" --title "<t>" [--stop-at feasibility|outline|none]
 *   公共：--port 3011 --root <acceptanceRoot>（默认 ~/.paperteam-acceptance）--model-timeout-min 90
 *
 * arm A：PAPERTEAM_DISABLED_SKILLS=academic-writing-zh,academic-review,academic-style-zh（学术 Skill 关闭）
 * arm B：学术 Skill 开启。其余（模型 / provider / 阈值 / 材料）完全相同——由同一 ~/.paperteam 配置保证。
 *
 * 产出：<root>/<arm>/<scenario>-<ts>/summary.json + backend.log + 关键产物拷贝。
 * 不把论文内容写进 summary（只有计数 / 指纹 / 章节 id）；真实论文只作为本地输入。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, cp, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const invariants = await import(`file://${join(repoRoot, "backend", "dist", "review", "styleInvariants.js").replaceAll("\\", "/")}`);
const signals = await import(`file://${join(repoRoot, "backend", "dist", "review", "styleSignals.js").replaceAll("\\", "/")}`);

// ---- args ----
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, item, index, all) => {
    if (item.startsWith("--")) {
      const next = all[index + 1];
      acc.push([item.slice(2), next === undefined || next.startsWith("--") ? "true" : next]);
    }
    return acc;
  }, []),
);
const scenario = args.scenario ?? "improvement";
const arm = args.arm ?? "B";
const port = Number(args.port ?? 3011);
const root = resolve(args.root ?? join(homedir(), ".paperteam-acceptance"));
const stylePolicy = args.style ?? (arm === "B" ? "apply_once" : "suggest_only");
const semanticMode = args.semantic ?? "off";
const stopAt = args["stop-at"] ?? "none";
const modelTimeoutMin = Number(args["model-timeout-min"] ?? 90);
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const outDir = join(root, arm, `${scenario}-${stamp}`);
const projectsRoot = join(root, arm, "projects");
await mkdir(outDir, { recursive: true });
await mkdir(projectsRoot, { recursive: true });

const base = `http://127.0.0.1:${port}`;
const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  return writeFile(join(outDir, "runner.log"), text + "\n", { flag: "a" });
};

// ---- backend ----
const disabledSkills = arm === "A" ? "academic-writing-zh,academic-review,academic-style-zh" : "";
const backendLog = join(outDir, "backend.log");
const backend = spawn(process.execPath, [join(repoRoot, "backend", "dist", "index.js")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PAPERTEAM_PORT: String(port),
    PROJECTS_ROOT: projectsRoot,
    PAPERTEAM_DISABLED_SKILLS: disabledSkills,
    NODE_ENV: "development",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const backendChunks = [];
for (const stream of [backend.stdout, backend.stderr]) {
  stream.on("data", (chunk) => {
    backendChunks.push(chunk);
    writeFile(backendLog, chunk, { flag: "a" }).catch(() => {});
  });
}
backend.on("exit", (code, signal) => void log(`backend exited code=${code} signal=${signal}`));

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

async function waitReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const ready = await api("GET", "/ready");
      if (ready.status === 200) {
        return ready.body;
      }
    } catch {
      // backend 尚未监听
    }
    if (Date.now() > deadline) {
      throw new Error("backend /ready 超时");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function waitIdle(stableMs = 8000, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let idleSince = null;
  for (;;) {
    const status = (await api("GET", "/api/runtime/status")).body.status;
    const active = status?.sessions?.activeRuns ?? 0;
    if (active === 0) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= stableMs) {
        return status;
      }
    } else {
      idleSince = null;
    }
    if (Date.now() > deadline) {
      return status;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

async function hashTree(dir) {
  const out = {};
  const walk = async (current, prefix) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else {
        out[rel] = sha(await readFile(full));
      }
    }
  };
  await walk(dir, "");
  return out;
}

async function readTexTree(dir) {
  const texts = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "revisions") await walk(full);
      } else if (entry.name.endsWith(".tex")) {
        texts.push(await readFile(full, "utf8"));
      }
    }
  };
  await walk(dir);
  return texts.join("\n\n");
}

function multisetDiff(before, after) {
  const count = (items) => items.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map());
  const a = count(before);
  const b = count(after);
  const added = [];
  const removed = [];
  for (const [key, n] of b) for (let i = 0; i < n - (a.get(key) ?? 0); i += 1) added.push(key);
  for (const [key, n] of a) for (let i = 0; i < n - (b.get(key) ?? 0); i += 1) removed.push(key);
  return { added, removed };
}

function hardMetrics(baselineTex, finalTex, bibKeys) {
  const cites = multisetDiff(invariants.extractCitationKeys(baselineTex), invariants.extractCitationKeys(finalTex));
  const numbers = multisetDiff(invariants.extractNumericTokens(baselineTex), invariants.extractNumericTokens(finalTex));
  const math = multisetDiff(invariants.extractMathSegments(baselineTex), invariants.extractMathSegments(finalTex));
  const bib = new Set(bibKeys);
  const finalKeys = new Set(invariants.extractCitationKeys(finalTex));
  const missingKeys = [...finalKeys].filter((key) => !bib.has(key));
  const baselineSet = new Set(invariants.extractNumericTokens(baselineTex));
  const newNumbers = [...new Set(numbers.added)].filter((token) => !baselineSet.has(token));
  return {
    citationKeys: { baseline: invariants.extractCitationKeys(baselineTex).length, final: invariants.extractCitationKeys(finalTex).length, added: [...new Set(cites.added)], removed: [...new Set(cites.removed)] },
    citationKeysNotInBib: missingKeys, // 任何一项 = 疑似虚构引用（必须为空）
    numericTokens: { baseline: invariants.extractNumericTokens(baselineTex).length, final: invariants.extractNumericTokens(finalTex).length, newTokens: newNumbers.slice(0, 40), newCount: newNumbers.length, removedCount: numbers.removed.length },
    mathSegments: { baseline: invariants.extractMathSegments(baselineTex).length, final: invariants.extractMathSegments(finalTex).length, added: math.added.length, removed: math.removed.length },
    styleSignals: { baseline: signals.scanStyleSignals(baselineTex).byKind, baselineTotal: signals.scanStyleSignals(baselineTex).total, final: signals.scanStyleSignals(finalTex).byKind, finalTotal: signals.scanStyleSignals(finalTex).total },
    sentinelWords: multisetDiff(invariants.extractSentinelWords(baselineTex), invariants.extractSentinelWords(finalTex)),
  };
}

function parseUsageLog() {
  const text = Buffer.concat(backendChunks).toString("utf8");
  const perRole = {};
  const tasks = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /\[pi-runtime\] usage taskId=(\S+) status=(\S+) in=(\d+) out=(\d+) cacheR=(\d+) cacheW=(\d+) turns=(\d+)(?: cost=([\d.eE+-]+))? exec=(\d+|\?)ms role=(\S+) skills=(\S*)(?: accessed=(\S+))?/.exec(line);
    if (match === null) continue;
    const entry = { taskId: match[1], status: match[2], input: Number(match[3]), output: Number(match[4]), cacheRead: Number(match[5]), cacheWrite: Number(match[6]), turns: Number(match[7]), cost: match[8] !== undefined ? Number(match[8]) : null, execMs: match[9] === "?" ? null : Number(match[9]), role: match[10], skills: match[11], accessed: match[12] ?? null };
    tasks.push(entry);
    const role = (perRole[entry.role] ??= { runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, execMs: 0 });
    role.runs += 1;
    role.input += entry.input;
    role.output += entry.output;
    role.cacheRead += entry.cacheRead;
    role.cacheWrite += entry.cacheWrite;
    role.cost += entry.cost ?? 0;
    role.execMs += entry.execMs ?? 0;
  }
  const stalls = (text.match(/GATEWAY_STALL|CONTEXT_BUDGET_EXCEEDED|RUNTIME_QUEUE_FULL|RUNTIME_SESSION_CAPACITY|EXECUTION_TIMEOUT|会话轮换/g) ?? []).reduce((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map());
  return { perRole, tasks, notable: Object.fromEntries(stalls) };
}

async function decide(run) {
  const awaiting = run.awaiting;
  const stageId = awaiting.stageId;
  if (stageId === "hitl.plan_confirm" || stageId === "hitl.outline_confirm") {
    return { decision: "approve" };
  }
  if (stageId === "hitl.feasibility_confirm") {
    return stopAt === "feasibility" ? { decision: "cancel" } : { decision: "approve" };
  }
  if (stageId === "hitl.style_polish") {
    const ids = awaiting.payload?.defaultSelectedIds ?? [];
    return ids.length > 0 ? { decision: "apply", payload: { selectedFindingIds: ids } } : { decision: "skip" };
  }
  if (stageId === "hitl.revision_stalled" || stageId === "hitl.revision_overflow") {
    return { decision: "accept_draft" };
  }
  throw new Error(`未知 HITL：${stageId}`);
}

async function driveRun(runId) {
  const started = Date.now();
  const deadline = started + modelTimeoutMin * 60_000;
  const decisions = [];
  let lastStage = null;
  for (;;) {
    const run = (await api("GET", `/api/runs/${runId}`)).body.run;
    if (run.currentStage !== lastStage) {
      lastStage = run.currentStage;
      await log(`run ${runId} status=${run.status} stage=${run.currentStage ?? "-"}`);
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return { run, decisions, wallMs: Date.now() - started };
    }
    if (run.status === "awaiting_input") {
      if (stopAt === "outline" && run.awaiting.stageId === "hitl.outline_confirm") {
        await log(`stop-at outline：记录后取消`);
        await api("POST", `/api/runs/${runId}/resume`, { decision: "cancel" });
        decisions.push({ stageId: run.awaiting.stageId, decision: "cancel", payload: run.awaiting.payload });
        continue;
      }
      const input = await decide(run);
      decisions.push({ stageId: run.awaiting.stageId, decision: input.decision, payloadKeys: Object.keys(input.payload ?? {}), hitlPayload: run.awaiting.payload });
      const resumed = await api("POST", `/api/runs/${runId}/resume`, input);
      await log(`HITL ${run.awaiting.stageId} → ${input.decision} (${resumed.status})`);
      if (resumed.status >= 400) {
        throw new Error(`resume 失败：${JSON.stringify(resumed.body)}`);
      }
    }
    if (Date.now() > deadline) {
      await log(`超时（${modelTimeoutMin} 分钟），取消 run`);
      await api("POST", `/api/runs/${runId}/cancel`, {});
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function stageTimeline(run) {
  return (run.stageHistory ?? []).map((record) => ({
    stageId: record.stageId,
    attempt: record.attempt,
    status: record.status,
    durationMs: new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime(),
    summary: Object.fromEntries(Object.entries(record.summary ?? {}).filter(([, value]) => typeof value === "number" || typeof value === "boolean" || typeof value === "string").slice(0, 20)),
    ...(record.error ? { error: record.error } : {}),
  }));
}

// ---- main ----
const summary = {
  scenario,
  arm,
  skillsDisabled: disabledSkills || null,
  stylePolicy: scenario === "improvement" || scenario === "idea" ? stylePolicy : null,
  citationSemanticMode: scenario === "quick-review" ? semanticMode : null,
  gitSha: (await readFile(join(repoRoot, ".git", "HEAD"), "utf8")).trim(),
  startedAt: new Date().toISOString(),
};
try {
  const head = summary.gitSha;
  if (head.startsWith("ref:")) {
    summary.gitSha = (await readFile(join(repoRoot, ".git", head.slice(5).trim()), "utf8")).trim();
  }
  summary.ready = await waitReady();
  const idle = await waitIdle();
  summary.runtimeBefore = { model: idle?.model, sessions: idle?.sessions, skillsNote: "usageTotals 基线在 skill 简介生成之后采样" };
  const skills = (await api("GET", "/api/skills")).body;
  summary.skills = (skills.skills ?? []).map((skill) => ({ id: skill.id, contentHash: skill.contentHash.slice(0, 12), sourceRevision: skill.sourceRevision, disabledByConfig: skill.disabledByConfig, integrity: skill.integrity }));

  let projectId;
  if (scenario === "improvement" || scenario === "quick-review") {
    const pdfPath = resolve(args.pdf);
    const content = await readFile(pdfPath);
    summary.corpus = { fileName: basename(pdfPath), bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
    const imported = await api("POST", "/api/projects/import-pdf", {
      fileName: basename(pdfPath),
      contentBase64: content.toString("base64"),
      goal: scenario === "improvement" ? "improvement" : "review_only",
      ...(args.title ? { title: args.title } : {}),
      researchField: args.field ?? "计算机视觉 / 智能交通",
      language: "zh",
      targetProfile: args.target ?? "核心期刊",
    });
    if (imported.status !== 201) {
      throw new Error(`import-pdf 失败：${imported.status} ${JSON.stringify(imported.body).slice(0, 300)}`);
    }
    projectId = imported.body.project.id;
    summary.project = { id: projectId, workflowKind: imported.body.project.workflowKind, pageCount: imported.body.document?.pageCount, sectionCount: imported.body.document?.sectionCount, chunkCount: imported.body.document?.chunkCount, extractionQuality: imported.body.document?.parse?.extractionQuality };
    await log(`导入完成 project=${projectId} pages=${summary.project.pageCount} sections=${summary.project.sectionCount}`);
  } else {
    const created = await api("POST", "/api/projects", {
      title: args.title ?? "M5.6 材料不足提案",
      researchIdea: args.idea ?? "面向车载多目标跟踪的运动残差门控记忆机制（仅有初步想法，尚无实验、数据集与实现）",
      researchField: args.field ?? "计算机视觉 / 智能交通",
      language: "zh",
      targetProfile: args.target ?? "核心期刊",
    });
    projectId = created.body.project.id;
    summary.project = { id: projectId, workflowKind: "idea_to_paper" };
  }

  const manuscriptDir = join(projectsRoot, projectId, "manuscript");
  const treeBefore = await hashTree(manuscriptDir);
  const revisionBefore = (await api("GET", `/api/projects/${projectId}/revisions`)).body.current ?? 0;
  const usageBefore = (await api("GET", "/api/runtime/status")).body.status?.sessions?.usageTotals ?? null;

  const kind = scenario === "improvement" ? "existing_paper_improvement" : scenario === "quick-review" ? "existing_paper_review" : "idea_to_paper";
  const runBody = { kind, ...(kind === "existing_paper_review" ? { citationSemanticMode: semanticMode } : { stylePolicy }) };
  const created = await api("POST", `/api/projects/${projectId}/workflows`, runBody);
  if (created.status !== 202) {
    throw new Error(`创建 run 失败：${created.status} ${JSON.stringify(created.body)}`);
  }
  const runId = created.body.runId;
  await log(`run 创建 ${runId} kind=${kind} ${JSON.stringify(runBody)}`);
  const { run, decisions, wallMs } = await driveRun(runId);
  summary.run = {
    runId,
    status: run.status,
    completion: run.completion ?? null,
    error: run.error ?? null,
    wallMs,
    request: run.request,
    decisions,
    timeline: stageTimeline(run),
    stageResults: Object.fromEntries(Object.entries(run.stageResults ?? {}).map(([id, value]) => [id, Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== "object" || v === null).slice(0, 25))])),
  };

  // 产物 / 门禁 / 修订
  const treeAfter = await hashTree(manuscriptDir);
  const changedFiles = Object.keys({ ...treeBefore, ...treeAfter }).filter((file) => treeBefore[file] !== treeAfter[file]);
  const revisionsBody = (await api("GET", `/api/projects/${projectId}/revisions`)).body;
  summary.manuscript = {
    revisionBefore,
    revisionAfter: revisionsBody.current ?? 0,
    revisions: (revisionsBody.revisions ?? []).map((r) => ({ revision: r.revision, reason: r.reason, createdAt: r.createdAt })),
    mutatedFiles: changedFiles.length,
    mutatedFileSamples: changedFiles.slice(0, 20),
  };
  summary.qualityGate = (await api("GET", `/api/projects/${projectId}/quality-gate`)).body;
  summary.iterations = (await api("GET", `/api/projects/${projectId}/iterations`)).body.iterations ?? [];
  summary.stylePolish = (await api("GET", `/api/projects/${projectId}/style-polish`)).body;
  summary.artifacts = (await api("GET", `/api/projects/${projectId}/artifacts`)).body;
  summary.build = (await api("GET", `/api/projects/${projectId}/build`)).body;
  summary.citationReport = (await api("GET", `/api/projects/${projectId}/citation-report`)).body?.report?.summary ?? null;
  summary.reviews = ((await api("GET", `/api/projects/${projectId}/reviews`)).body.reviews ?? []).map((review) => ({
    round: review.round,
    reviewedRevision: review.reviewedRevision,
    counts: review.counts,
    scores: review.scores,
    unsupportedCriticalClaims: review.unsupportedCriticalClaims,
    issuesWithReason: (review.issues ?? []).filter((issue) => issue.reason).length,
    issuesWithAction: (review.issues ?? []).filter((issue) => issue.suggestedAction).length,
    issuesLocated: (review.issues ?? []).filter((issue) => issue.section && issue.section !== "(unknown)").length,
    issuesTotal: (review.issues ?? []).length,
    styleMinor: (review.issues ?? []).filter((issue) => issue.category === "style" && issue.severity === "minor").length,
  }));
  if (scenario === "quick-review") {
    summary.paperReview = (await api("GET", `/api/projects/${projectId}/paper-review`)).body;
    if (summary.paperReview?.report) {
      const report = summary.paperReview.report;
      summary.paperReview = { round: report.round, findingsTotal: (report.findings ?? []).length, bySeverity: report.review?.bySeverity ?? null, byCategory: report.review?.byCategory ?? null, citationIntegrity: report.citationIntegrity?.summary ?? report.citationIntegrity ?? null };
    }
  }
  if (scenario === "idea") {
    summary.feasibility = (await api("GET", `/api/projects/${projectId}/feasibility`)).body;
  }

  // 硬指标：基线修订（首个）vs 最终修订
  const revisions = summary.manuscript.revisions;
  if (revisions.length >= 1) {
    const first = revisions[0].revision;
    const last = revisions[revisions.length - 1].revision;
    const baselineTex = await readTexTree(join(manuscriptDir, "revisions", `rev-${first}`)).catch(() => "");
    const finalTex = await readTexTree(join(manuscriptDir, "revisions", `rev-${last}`)).catch(() => "");
    const bib = await readFile(join(manuscriptDir, "references.bib"), "utf8").catch(() => "");
    const bibKeys = [...bib.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]);
    if (baselineTex !== "" && finalTex !== "") {
      summary.hardMetrics = { baselineRevision: first, finalRevision: last, bibKeys: bibKeys.length, ...hardMetrics(baselineTex, finalTex, bibKeys) };
    }
  }

  // usage
  const after = (await api("GET", "/api/runtime/status")).body.status;
  summary.runtimeAfter = { sessions: after?.sessions };
  summary.usage = { before: usageBefore, after: after?.sessions?.usageTotals ?? null, perTask: parseUsageLog() };
  if (usageBefore && summary.usage.after) {
    summary.usage.delta = Object.fromEntries(Object.keys(usageBefore).map((key) => [key, (summary.usage.after[key] ?? 0) - (usageBefore[key] ?? 0)]));
  }
  // 产物拷贝（PDF / gate / plan）
  for (const sub of ["reviews", "artifacts", "build"]) {
    await cp(join(projectsRoot, projectId, sub), join(outDir, sub), { recursive: true }).catch(() => {});
  }
  summary.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await log(`完成：status=${summary.run.status} completion=${JSON.stringify(summary.run.completion)} → ${join(outDir, "summary.json")}`);
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await log(`失败：${summary.error}`);
  process.exitCode = 1;
} finally {
  await log("停止 backend（Windows 下 kill 为强制终止，优雅停机不在此验证）");
  backend.kill();
  await new Promise((r) => setTimeout(r, 1500));
}
