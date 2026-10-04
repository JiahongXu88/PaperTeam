#!/usr/bin/env node
/**
 * M11.2.3 Case A（MOT Survey，p-6de7674cd29e）修订收敛验证（一次性）。
 *
 * 起点：M11.2 终态 r8（QUALITY_NOT_REACHED，13 UNSUPPORTED，score 77，8 轮振荡
 * 81→77）。本脚本在保留项目上续跑 topic_survey（front 幂等 + writing 指纹跳过，
 * 成本集中在尾段），验证 M11.2.3 行为：
 *   - review 轮：claim grounding 披露口径拆分（opaque/transparent）+ 根因标注；
 *   - revision.plan：Claim Resolution Contract（use_existing_evidence /
 *     ground_existing_source / author_decision / weaken / remove 阶梯）+
 *     mustPreserve 投影 + remove 类窄授权；
 *   - evidence.ground_claims：对 S016/S024/S005/S009 等在库全文定向采证
 *     （零新文献检索，quote 逐字 + judge）；
 *   - 收敛：iteration scorecard 带 unsupportedOpaque / factViolations，
 *     judgeConvergence STALLED → NO_PROGRESS 语义（不再盲目续跑）。
 *
 * HITL 策略：同 m1121-run3（stalled 先 revise_more 一轮再 accept_draft）。
 *
 * 用法：node scripts/m1123-mot-resolution.mjs [projectId]
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const projectId = process.argv[2] ?? "p-6de7674cd29e";

const projectsRoot = join(repoRoot, "e2e", ".tmp", "m1112-survey-e2e", "projects");
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
const { createBackendHttpServer } = await import(distUrl("httpServer.js"));
const { WorkflowOrchestrator } = await import(distUrl("workflow", "WorkflowOrchestrator.js"));
const { WorkflowRunStore } = await import(distUrl("workflow", "runStore.js"));
const { createTopicSurveyDefinition } = await import(distUrl("workflow", "definitions.js"));
const { createScholarlyTools } = await import(distUrl("skills", "scholarlyTools.js"));
const { createRetrieveLibraryTool } = await import(distUrl("retrieval", "tools.js"));
const { evidenceToolsForRole } = await import(distUrl("evidence", "tools.js"));

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
  // M11.2.3 验收前提（§19）：不重新跑 Research/Matrix/Synthesis/Outline/Writing。
  // 禁用 fulltext 再解析——resume 的 survey.fulltext 会在网络好转时把昨日
  // not_found 的源自动补齐（Case B 实录 5/25→13/25），导致 matrix 指纹漂移
  // → 语料被重写。既有 24/29 全文原样保留；metadata_only 源保持降级状态。
  fullText: { enabled: false },
  log: (message) => console.log(message),
});
stackRef = stack;

const evidenceBefore = (await stack.evidence.list(projectId)).length;
const cg8 = await stack.reviewArtifacts.loadClaimGrounding(projectId, 8);
console.log(`[baseline] r8 claim grounding：total=${cg8?.totalClaims ?? "-"} unsupported=${cg8?.unsupportedClaims ?? "-"} evidence=${evidenceBefore}`);

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
console.log(`[boot] backend http on ${base}`);

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
  const deadline = Date.now() + 4 * 60 * 60 * 1000;
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
          `（elapsed ${Math.round((Date.now() - runStartedAt) / 60000)}min；failureClass=${payload["failureClass"] ?? "-"}；convergence=${payload["convergence"] ?? "-"}；outcome=${payload["outcome"] ?? "-"}；gateReasons=${(payload["gateReasons"] ?? []).length}）`,
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

  // ---- M11.2.3 产物摘要 ----
  const iterations = JSON.parse(
    await readFile(join(projects.reviewsDir(projectId), "iteration-history.json"), "utf8"),
  );
  console.log("\niteration-history：");
  for (const record of iterations.iterations) {
    console.log(
      `  r${record.gateRound}: rev${record.revision} outcome=${record.outcome ?? "-"} ` +
        `score=${record.scorecard.academicScore} crit=${record.scorecard.critical} maj=${record.scorecard.major} blk=${record.scorecard.blocking} ` +
        `unsupOpaque=${record.scorecard.unsupportedOpaque ?? "-"} unsupTransp=${record.scorecard.unsupportedTransparent ?? "-"} ` +
        `factV=${record.scorecard.factViolations ?? "-"} citeV=${record.scorecard.citationViolations ?? "-"} failed=[${record.scorecard.failedRuleIds.join(",")}]`,
    );
  }
  const rounds = await stack.reviewArtifacts.gateRounds(projectId);
  for (const round of rounds.slice(0, 3)) {
    const cg = await stack.reviewArtifacts.loadClaimGrounding(projectId, round);
    const resolution = await stack.reviewArtifacts.loadClaimResolution(projectId, round);
    if (cg === null) continue;
    console.log(
      `\nclaim-grounding r${round}: unsupported=${cg.unsupportedClaims}（opaque=${cg.opaqueUnsupportedClaims} / transparent=${cg.transparentUnsupportedClaims}）`,
    );
    if (resolution !== null) {
      console.log(`claim-resolution r${round}: ${JSON.stringify(resolution.counts)}`);
    }
  }
  const evidenceAfter = (await stack.evidence.list(projectId)).length;
  const perSource = new Map();
  for (const record of await stack.evidence.list(projectId)) {
    const sourceId = record.source?.sourceId ?? "?";
    perSource.set(sourceId, (perSource.get(sourceId) ?? 0) + 1);
  }
  const zeroTargets = ["S016", "S024", "S005", "S009", "S004", "S006", "S013", "S002"];
  console.log(
    `\nevidence：before=${evidenceBefore} after=${evidenceAfter}（Δ=${evidenceAfter - evidenceBefore}）；目标源计数：` +
      zeroTargets.map((sid) => `${sid}=${perSource.get(sid) ?? 0}`).join(" "),
  );
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
