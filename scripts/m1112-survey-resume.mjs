#!/usr/bin/env node
/**
 * M11.2 E2E 恢复脚本（一次性）：m1112-survey-e2e 在修订预算耗尽后的
 * overflow / stalled HITL 处，smoke 脚本的通用 approve 不是合法 decision
 * （accept_draft / revise_more / cancel）。本脚本在同一 PROJECTS_ROOT 上以
 * 新 Orchestrator 实例恢复该 run：
 *   - hitl.revision_overflow / hitl.revision_stalled → accept_draft（用户知情
 *     接受 Draft：质量语义如实记录 qualityGatePassed=false）
 *   - hitl.revision_validation → approve
 *   - 其余 HITL → approve
 * 完成后输出 completion summary 与 stage 统计（PDF 产出 = Draft / Final）。
 *
 * 用法：node scripts/m1112-survey-resume.mjs <projectId> <runId>
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const [projectId, runId] = process.argv.slice(2);
if (projectId === undefined || runId === undefined) {
  console.error("用法：node scripts/m1112-survey-resume.mjs <projectId> <runId>");
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
      throw new Error(`resume 只装配 topic_survey（收到 ${kind}）`);
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

try {
  const deadline = Date.now() + 60 * 60 * 1000;
  for (;;) {
    const { body } = await request("GET", `/runs/${runId}`);
    const run = body.run;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      console.log(`\n[done] status=${run.status} label=${run.completion?.label ?? "-"}`);
      console.log(JSON.stringify(run.completion?.summary ?? {}, null, 2));
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
      break;
    }
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      const decision =
        stageId === "hitl.revision_overflow" || stageId === "hitl.revision_stalled"
          ? "accept_draft"
          : stageId === "hitl.revision_validation"
            ? "approve"
            : "approve";
      console.log(`[hitl] ${stageId} → ${decision}`);
      const resume = await request("POST", `/runs/${runId}/resume`, { decision });
      if (resume.status !== 200) {
        throw new Error(`resume ${stageId} 失败：${resume.status} ${JSON.stringify(resume.body)}`);
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`超时（${run.status} / ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
} finally {
  server.close();
  await orchestrator.close().catch(() => {});
  await adapter.close().catch(() => {});
}
