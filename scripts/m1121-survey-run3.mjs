#!/usr/bin/env node
/**
 * M11.2.1 E2E 第三跑（一次性）：在 M11.2 保留的真实项目上验证 Typed
 * Authorized Weakening 修复后的修订收敛。
 *
 * 前提：M11.2 两跑的真实项目数据保留在磁盘（p-*），front stages 全部幂等，
 * writing.sections 现带大纲指纹幂等跳过（M11.2.1）——成本集中在
 * review → revision → gate → PDF 尾段。
 *
 * 尾段 HITL 决策策略：
 *   - 四个前置确认（research_plan / literature_selection / matrix / outline）→ approve
 *   - hitl.revision_validation → approve（用户知情接受复核结果，记录在案）
 *   - hitl.revision_stalled：第一次 → revise_more；之后 → accept_draft
 *   - hitl.revision_overflow → accept_draft
 *
 * 用法：node scripts/m1121-survey-run3.mjs <projectId>
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const projectId = process.argv[2];
if (projectId === undefined) {
  console.error("用法：node scripts/m1121-survey-run3.mjs <projectId>");
  process.exit(1);
}

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
const {
  createTopicSurveyDefinition,
} = await import(distUrl("workflow", "definitions.js"));
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
    if ((role === "researcher" || role === "writer" || role === "reviewer") && stackRef !== undefined && pid !== undefined) {
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
  log: (message) => console.log(message),
});
stackRef = stack;
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore: new WorkflowRunStore(projects, { log: () => {} }),
  definitionFactory: (kind) => {
    if (kind !== "topic_survey") {
      throw new Error(`run3 只装配 topic_survey（收到 ${kind}）`);
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

/** 既有 corpus 的 accepted 候选（candidates.json；空 = 无既有库，走默认推荐集） */
async function readAcceptedCandidateIds(pid) {
  try {
    const raw = JSON.parse(await readFile(join(projectsRoot, pid, "sources", "candidates.json"), "utf8"));
    return (raw.items ?? [])
      .filter((item) => item.status === "accepted")
      .map((item) => item.candidateId);
  } catch {
    return [];
  }
}

try {
  // 清理可能的孤儿 run
  const runsResponse = await request("GET", `/projects/${projectId}/runs`);
  for (const orphan of runsResponse.body["runs"] ?? []) {
    if (orphan.status === "running" || orphan.status === "pending") {
      console.log(`[cleanup] 取消孤儿 run ${orphan.runId}（${orphan.status}）`);
      await request("POST", `/runs/${orphan.runId}/cancel`).catch(() => {});
    }
  }

  const started = await request("POST", `/projects/${projectId}/workflows`, { kind: "topic_survey" });
  const startedBody = started.body;
  if (started.status !== 202) {
    throw new Error(`run 启动失败：${started.status} ${JSON.stringify(startedBody)}`);
  }
  const runId = startedBody.runId;
  console.log(`[run] ${runId}`);

  const runStartedAt = Date.now();
  const deadline = Date.now() + 5 * 60 * 60 * 1000;
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
        // M11.2 坑位防复发：重跑遴选默认集会把 pending 的新候选推入库，语料漂移
        // （run2 实录 25→29）→ matrix/synthesis/outline 重建 → 写作幂等跳过失效。
        // 续跑语义：原样提交既有 accepted 集合（promote 幂等去重，库不变）。
        const accepted = await readAcceptedCandidateIds(projectId);
        if (accepted.length > 0) {
          resumePayload = { candidateIds: accepted };
        }
      }
      const payload = run.awaiting?.payload ?? {};
      console.log(
        `[hitl] ${stageId} → ${decision}${resumePayload !== undefined ? `（candidateIds=${resumePayload.candidateIds.length}）` : ""}（elapsed ${Math.round((Date.now() - runStartedAt) / 60000)}min；` +
          `failureClass=${payload["failureClass"] ?? "-"}；gateReasons=${(payload["gateReasons"] ?? []).length}）`,
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
  const timings = {};
  for (const entry of run.stageHistory ?? []) {
    if (entry.status !== "completed") continue;
    timings[entry.stageId] ??= 0;
    timings[entry.stageId] += new Date(entry.finishedAt).getTime() - new Date(entry.startedAt).getTime();
  }
  console.log("stage ms:", JSON.stringify(timings));
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
} finally {
  server.close();
  await orchestrator.close().catch(() => {});
  await adapter.close().catch(() => {});
}
