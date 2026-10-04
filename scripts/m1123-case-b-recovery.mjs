#!/usr/bin/env node
/**
 * M11.2.3 Case B 恢复验证（一次性）：多模态视觉编码 Survey（p-8c225ac897ec）
 * 在 M11.2 终态（FACT_PRESERVATION_FAILED @ build.draft，rev3 已写盘）上验证：
 *
 * PART A（确定性，零模型成本）——死锁解除证明：
 *   1. 复读 gate-r3 的 pairwise 违规（rev2→rev3：删除了 rev2 无依据新增的
 *      范围声明句，被判 number_removed ×3）；
 *   2. 新代码路径：pairwise 投影（projectPairwiseFactRestore）+ buildRevisionPlan
 *      → 计划条目携带行级 removeValues + 删除式指令；
 *   3. evaluateFactPreservation(rev2→rev3, 新计划) → 期望 ok=true（同一 delta
 *      被授权放行）；对照：旧盘上 plan-r2（无 removeValues）→ ok=false（原死锁）；
 *   4. 负对照：把 rev3 换成数值替换版（同文件他行 2025→2019 类改写）→ 仍 FAIL
 *      （授权只放行删除，不放行替换/漂移）。
 *
 * PART B（真实恢复）：起 HTTP + orchestrator 续跑 topic_survey（front stages
 * 幂等；writing 指纹跳过），HITL 策略同 m1121-run3（stalled 先 revise_more 一轮
 * 再 accept_draft）——验证修订环在授权语义修复后不再结构性死锁。
 *
 * 用法：node scripts/m1123-case-b-recovery.mjs <projectId> [--skip-run]
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const projectId = process.argv[2];
if (projectId === undefined) {
  console.error("用法：node scripts/m1123-case-b-recovery.mjs <projectId> [--skip-run]");
  process.exit(1);
}
const skipRun = process.argv.includes("--skip-run");

const projectsRoot = join(repoRoot, "e2e", ".tmp", "case-b-survey", "projects");
process.env["PROJECTS_ROOT"] = projectsRoot;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["CITATION_MAX_METADATA_LOOKUPS"] ??= "60";

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(
  distUrl("settings", "ModelSettingsStore.js")
);
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { evaluateFactPreservation, projectPairwiseFactRestore } = await import(
  distUrl("quality", "factPreservation.js")
);
const { buildRevisionPlan } = await import(distUrl("review", "revisionPlan.js"));
const { readSnapshotTex } = await import(distUrl("quality", "citationPreservation.js"));

const config = loadConfig();
const skillRegistry = new SkillRegistry({
  storeRoot: join(config.runtimeRoot, "skills"),
  disabledSkillIds: config.skills.disabledSkillIds,
  log: () => {},
});
await skillRegistry.ensureInstalled();
const modelSettingsStore = new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
const modelSpec = config.pi.model ?? (await resolveStartupModelSpec(undefined, modelSettingsStore));
if (modelSpec === undefined) {
  console.error("[fatal] 未解析到模型");
  process.exit(1);
}

const { createScholarlyTools } = await import(distUrl("skills", "scholarlyTools.js"));
const { createRetrieveLibraryTool } = await import(distUrl("retrieval", "tools.js"));
const { evidenceToolsForRole } = await import(distUrl("evidence", "tools.js"));

let stackRef;
const adapter = new PiRuntimeAdapter({
  modelSpec,
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: projectsRoot,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  roleCustomTools: (role, pid) => {
    const tools = [];
    if ((role === "researcher" || role === "citation") && stackRef !== undefined) {
      tools.push(
        ...createScholarlyTools(
          stackRef.citationIntegrity.scholarlyResolver,
          stackRef.discovery,
          role === "researcher" ? pid : undefined,
        ),
      );
    }
    if (stackRef !== undefined && pid !== undefined && (role === "researcher" || role === "writer" || role === "reviewer")) {
      tools.push(createRetrieveLibraryTool(stackRef.retrieval, pid));
    }
    if (stackRef !== undefined && pid !== undefined) {
      tools.push(
        ...evidenceToolsForRole(
          role,
          { chunkAccess: stackRef.chunkAccess, grounding: stackRef.evidenceGrounding, evidence: stackRef.evidence },
          pid,
        ),
      );
    }
    return tools;
  },
  log: () => {},
});

// （PART A 不需要工具装配——skill 工具在 PART B run 时按 m1121 模式注入）
const projects = new ProjectStore({ root: projectsRoot });
const stack = buildServiceStack({
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  ...(config.pi.longRunTimeoutMs !== undefined
    ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) }
    : { longRunTimeoutMs: 900_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  log: (message) => console.log(message),
});
stackRef = stack;

// ---- PART A：死锁解除的确定性证明 ----
// 语义对齐产品路径：死锁发生在「gate r2 判 rev1→rev2 无依据新增 → plan-r2（本修复
// 前无 removeValues）派发删除 → rev3 执行删除 → gate r3 判 rev2→rev3 违规」。
// 因此 PART A 从 gate-r2 的 added 违规构建新 plan-r2（sourceRevision=2），再以它
// 授权评估 rev2→rev3 的删除 delta。
console.log("\n===== PART A：pairwise 授权投影（零模型成本）=====");
const gateRound2 = 2;
const gateRound3 = 3;
const gate2 = await stack.reviewArtifacts.loadGate(projectId, gateRound2);
const gate3 = await stack.reviewArtifacts.loadGate(projectId, gateRound3);
if (gate2?.factPreservation == null || gate3?.factPreservation == null) {
  throw new Error("quality-gate-r2/r3.json 缺少 factPreservation——项目数据不符合预期");
}
const addedState = gate2.factPreservation;
const removalState = gate3.factPreservation;
console.log(
  `r2 pairwise（rev${addedState.previousRevision}→rev${addedState.currentRevision}）：added=${addedState.addedUnsupportedFacts.length} ok=${addedState.ok}（无依据新增 = 死锁起点）`,
);
console.log(
  `r3 pairwise（rev${removalState.previousRevision}→rev${removalState.currentRevision}）：removed=${removalState.removedFacts.length} ok=${removalState.ok}（按旧计划删除 → 被判违规 = 死锁）`,
);

const rev1Files = await readSnapshotTex(stack.revisions.snapshotDir(projectId, addedState.previousRevision));
const rev2Files = await readSnapshotTex(stack.revisions.snapshotDir(projectId, addedState.currentRevision));
const rev3Files = await readSnapshotTex(stack.revisions.snapshotDir(projectId, removalState.currentRevision));
if (rev1Files === null || rev2Files === null || rev3Files === null) {
  throw new Error("rev1/rev2/rev3 快照缺失");
}
// summarizePairwiseFactRegressions 的等价投影（workflow definitions 私有 → 现场重构）
const regressionsByFile = new Map();
const buckets = [
  ...addedState.changedFacts,
  ...addedState.removedFacts,
  ...addedState.addedUnsupportedFacts,
];
for (const finding of buckets) {
  const files = finding.kind === "added_unsupported" ? rev2Files : rev1Files;
  const projection = projectPairwiseFactRestore(finding, files ?? []);
  const entry = regressionsByFile.get(finding.file) ?? {
    detail: `${finding.reason}：${finding.before}${finding.after !== "" ? ` → ${finding.after}` : "（被删除）"}`.slice(0, 240),
    restoreValues: new Set(),
    removeValues: new Set(),
  };
  for (const value of projection.restoreValues ?? []) entry.restoreValues.add(value);
  for (const value of projection.removeValues ?? []) entry.removeValues.add(value);
  regressionsByFile.set(finding.file, entry);
}
const factRegressions = [...regressionsByFile.entries()].map(([file, entry]) => ({
  file,
  detail: entry.detail,
  ...(entry.removeValues.size > 0 ? { removeValues: [...entry.removeValues] } : {}),
  ...(entry.restoreValues.size > 0 ? { restoreValues: [...entry.restoreValues] } : {}),
}));
console.log("新投影 factRegressions:", JSON.stringify(factRegressions, null, 1));

const summaryForPlan = gate2.reviewSummary;
const newPlan = buildRevisionPlan({
  projectId,
  sourceRevision: addedState.currentRevision,
  reviewRound: gateRound2,
  summary: summaryForPlan,
  factRegressions,
});
const newPlanFactItem = newPlan.items.find((item) => item.kind === "fact_preserve");
console.log(
  `新 plan-r2 fact_preserve 条目：removeValues=${JSON.stringify(newPlanFactItem?.factRestore?.removeValues ?? [])} restoreValues=${JSON.stringify(newPlanFactItem?.factRestore?.restoreValues ?? [])}`,
);
console.log(`指令（前 90 字）：${newPlanFactItem?.instruction.slice(0, 90)}`);

const snapshot = (revision, files) => ({ revision, files });
const withNewPlan = evaluateFactPreservation({
  previous: snapshot(removalState.previousRevision, rev2Files),
  current: snapshot(removalState.currentRevision, rev3Files),
  plan: newPlan,
});
console.log(
  `
[PART A 结论] 新 plan-r2 授权下的 rev2→rev3 删除：ok=${withNewPlan.ok} allowedRemovals=${withNewPlan.allowedRemovals} removed=${withNewPlan.removedFacts.length}（旧盘 plan-r2：ok=${removalState.ok} removed=${removalState.removedFacts.length} = 原 FACT_PRESERVATION_FAILED）`,
);
if (withNewPlan.ok !== true) {
  console.error("[PART A FAIL] 死锁未解除——检查 projectPairwiseFactRestore 投影");
  process.exit(2);
}

// 负对照 1：同一授权下附加无授权数值 → 仍 FAIL（删除授权不放行新增）
const mutatedSwap = rev3Files.map((file) => {
  if (!file.file.endsWith("introduction.tex")) return file;
  return { ...file, content: `${file.content}
据统计，本领域年增长率约 47%。
` };
});
const swap = evaluateFactPreservation({
  previous: snapshot(removalState.previousRevision, rev2Files),
  current: snapshot(removalState.currentRevision, mutatedSwap),
  plan: newPlan,
});
console.log(
  `[负对照1] rev3 附加无授权数值（47%）：ok=${swap.ok} added=${swap.addedUnsupportedFacts.length}（新增值仍被拦）`,
);
// 负对照 2：既有数值被改写 → 仍 FAIL（删除授权不放行替换）。
// 取首个含十进制数值的 section（整数常出现在 cite key 内 = D 类引用变化，非事实）
const decimalFile = rev3Files.find(
  (file) => /\d+\.\d+/.test(file.content) && file.file.includes("sections/"),
);
if (decimalFile !== undefined) {
  const mutatedValue = rev3Files.map((file) =>
    file.file === decimalFile.file
      ? { ...file, content: file.content.replace(/(\d+\.\d+)/, (num) => String(Number(num) + 1)) }
      : file,
  );
  const valueMutated = evaluateFactPreservation({
    previous: snapshot(removalState.previousRevision, rev2Files),
    current: snapshot(removalState.currentRevision, mutatedValue),
    plan: newPlan,
  });
  console.log(
    `[负对照2] ${decimalFile.file} 数值改写：ok=${valueMutated.ok} changed=${valueMutated.changedFacts.length} removed=${valueMutated.removedFacts.length}（改值仍被拦）`,
  );
} else {
  console.log("[负对照2] 无含十进制数值的 section（跳过）");
}

if (skipRun) {
  console.log("\n[--skip-run] PART B 跳过");
  await adapter.close().catch(() => {});
  process.exit(0);
}

// ---- PART B：真实恢复（m1121-run3 语义）----
const { createBackendHttpServer } = await import(distUrl("httpServer.js"));
const { WorkflowOrchestrator } = await import(distUrl("workflow", "WorkflowOrchestrator.js"));
const { WorkflowRunStore } = await import(distUrl("workflow", "runStore.js"));
const { createTopicSurveyDefinition } = await import(distUrl("workflow", "definitions.js"));

const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore: new WorkflowRunStore(projects, { log: () => {} }),
  definitionFactory: (kind) => {
    if (kind !== "topic_survey") {
      throw new Error(`本脚本只装配 topic_survey（收到 ${kind}）`);
    }
    return createTopicSurveyDefinition(stack.workflowServices);
  },
  log: () => {},
});
const server = createBackendHttpServer({
  runtime: adapter,
  projects,
  generation: stack.generation,
  orchestrator,
  stack,
});
await new Promise((onListen) => server.listen(0, "127.0.0.1", onListen));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`\n===== PART B：续跑（backend http on ${base}）=====`);

async function request(method, path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" } } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = { raw: true };
  }
  return { status: response.status, body: parsed };
}

async function readAcceptedCandidateIds(pid) {
  try {
    const raw = JSON.parse(await readFile(join(projectsRoot, pid, "sources", "candidates.json"), "utf8"));
    return (raw.items ?? []).filter((item) => item.status === "accepted").map((item) => item.candidateId);
  } catch {
    return [];
  }
}

try {
  const runsResponse = await request("GET", `/projects/${projectId}/runs`);
  for (const orphan of runsResponse.body["runs"] ?? []) {
    if (orphan.status === "running" || orphan.status === "pending") {
      console.log(`[cleanup] 取消孤儿 run ${orphan.runId}`);
      await request("POST", `/runs/${orphan.runId}/cancel`).catch(() => {});
    }
  }
  const started = await request("POST", `/projects/${projectId}/workflows`, { kind: "topic_survey" });
  if (started.status !== 202) {
    throw new Error(`run 启动失败：${started.status} ${JSON.stringify(started.body)}`);
  }
  const runId = started.body.runId;
  console.log(`[run] ${runId}`);
  const runStartedAt = Date.now();
  const deadline = Date.now() + 3 * 60 * 60 * 1000;
  let stalledSeen = 0;
  let run;
  for (;;) {
    const { body } = await request("GET", `/runs/${runId}`);
    run = body.run;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      break;
    }
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      let decision = "approve";
      let resumePayload;
      if (stageId === "hitl.revision_stalled") {
        stalledSeen += 1;
        decision = stalledSeen <= 1 ? "revise_more" : "accept_draft";
      } else if (stageId === "hitl.revision_overflow") {
        decision = "accept_draft";
      } else if (stageId === "hitl.literature_selection") {
        const accepted = await readAcceptedCandidateIds(projectId);
        if (accepted.length > 0) {
          resumePayload = { candidateIds: accepted };
        }
      }
      const payload = run.awaiting?.payload ?? {};
      console.log(
        `[hitl] ${stageId} → ${decision}` +
          `（elapsed ${Math.round((Date.now() - runStartedAt) / 60000)}min；failureClass=${payload["failureClass"] ?? "-"}；convergence=${payload["convergence"] ?? "-"}；gateReasons=${(payload["gateReasons"] ?? []).length}）`,
      );
      const resume = await request("POST", `/runs/${runId}/resume`, {
        decision,
        ...(resumePayload !== undefined ? { payload: resumePayload } : {}),
      });
      if (resume.status !== 200) {
        throw new Error(`resume ${stageId} 失败：${resume.status} ${JSON.stringify(resume.body)}`);
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`超时（${run.status} / ${run.currentStage}）`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  console.log(`\n[done] status=${run.status} label=${run.completion?.label ?? "-"} elapsed=${Math.round((Date.now() - runStartedAt) / 60000)}min`);
  console.log(JSON.stringify(run.completion?.summary ?? {}, null, 2));
  if (run.status === "failed") {
    console.log(`[error] ${run.error?.code} @ ${run.error?.stageId}: ${run.error?.message?.slice(0, 300)}`);
  }
  const iterations = JSON.parse(
    await readFile(join(projects.reviewsDir(projectId), "iteration-history.json"), "utf8"),
  );
  console.log("\niteration-history：");
  for (const record of iterations.iterations) {
    console.log(
      `  r${record.gateRound}: rev${record.revision} outcome=${record.outcome ?? "-"} ` +
        `score=${record.scorecard.academicScore} crit=${record.scorecard.critical} blk=${record.scorecard.blocking} ` +
        `unsupOpaque=${record.scorecard.unsupportedOpaque ?? "-"} factV=${record.scorecard.factViolations ?? "-"} failed=[${record.scorecard.failedRuleIds.join(",")}]`,
    );
  }
  try {
    const trace = JSON.parse(
      await readFile(join(projects.workflowDir(projectId), "runs", runId, "run-trace.json"), "utf8"),
    );
    const modelSpans = (trace.spans ?? []).filter((span) => span.name === "model.turn");
    const attr = (span, key) => (typeof span.attributes?.[key] === "number" ? span.attributes[key] : 0);
    const tokens = modelSpans.reduce(
      (acc, span) => ({
        input: acc.input + attr(span, "model.inputTokens"),
        output: acc.output + attr(span, "model.outputTokens"),
        cacheRead: acc.cacheRead + attr(span, "model.cacheReadTokens"),
      }),
      { input: 0, output: 0, cacheRead: 0 },
    );
    const cost = modelSpans.reduce((sum, span) => sum + attr(span, "model.estimatedCost"), 0);
    console.log(`trace: turns=${modelSpans.length} tokens(in/out/cacheRead)=${tokens.input}/${tokens.output}/${tokens.cacheRead} cost=$${cost.toFixed(2)}`);
  } catch {
    console.log("trace: 不可读（跳过）");
  }
} finally {
  server.close();
  await orchestrator.close().catch(() => {});
  await adapter.close().catch(() => {});
}
