#!/usr/bin/env node
/**
 * M11.3 Phase F/G — 真实 Case 终验驱动（一次性）。
 *
 * 流程（在项目副本上执行，原验收数据不动）：
 *  1. 复制项目到 e2e/.tmp/{work}/projects/（副本 = 独立会话 + 零污染）；
 *  2. 预冻结研究语料（CorpusSnapshotService.freeze：磁盘状态 + 既有 matrix
 *     基线）——之后整个 run 消费冻结基线（普通 resume 不漂移；本脚本是
 *     fullText 默认开启下跑的，正是 §34 的真实验证：网络可下载也不补齐）；
 *  3. 启动 topic_survey：front 阶段幂等跳过（matrix/synthesis/outline/写作
 *     指纹复用），尾部走新语义 review（disconfirmation + 投影修复）→
 *     resolution（Phase B 门槛）→ revision（语法归一）→ gate（终态语义）→
 *     PDF；
 *  4. HITL 策略：stalled 先 revise_more 一轮再 accept_draft；overflow 直接
 *     accept_draft；
 *  5. 产物摘要：iteration 轨迹 / claim grounding+resolution / 语料快照
 *     （revision+fingerprint 前后对比 = 冻结验证）/ gate / build / trace 成本。
 *
 * 用法：node scripts/m113-case-final.mjs <caseA|caseB>
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const CASES = {
  caseA: {
    label: "Case A（MOT Survey）",
    sourceRoot: join(repoRoot, "e2e", ".tmp", "m1112-survey-e2e", "projects"),
    projectId: "p-6de7674cd29e",
    work: join(repoRoot, "e2e", ".tmp", "m113-mot-final"),
  },
  caseB: {
    label: "Case B（多模态视觉编码，降级语料）",
    sourceRoot: join(repoRoot, "e2e", ".tmp", "case-b-survey", "projects"),
    projectId: "p-8c225ac897ec",
    work: join(repoRoot, "e2e", ".tmp", "m113-case-b-final"),
  },
};
const config = CASES[process.argv[2] ?? "caseA"];
if (config === undefined) {
  console.error("用法：node scripts/m113-case-final.mjs <caseA|caseB>");
  process.exit(1);
}

process.env["PROJECTS_ROOT"] = join(config.work, "projects");
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["CITATION_MAX_METADATA_LOOKUPS"] ??= "60";

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
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

const config_ = loadConfig();
const projectsRoot = process.env["PROJECTS_ROOT"];
const skillRegistry = new SkillRegistry({
  storeRoot: join(config_.runtimeRoot, "skills"),
  disabledSkillIds: config_.skills.disabledSkillIds,
  log: () => {},
});
await skillRegistry.ensureInstalled();
const modelSettingsStore = new ModelSettingsStore({ settingsDir: join(config_.runtimeRoot, "settings") });
const modelSpec = config_.pi.model ?? (await resolveStartupModelSpec(undefined, modelSettingsStore));
if (modelSpec === undefined) {
  console.error("[fatal] 未解析到模型");
  process.exit(1);
}

let stackRef;
const adapter = new PiRuntimeAdapter({
  modelSpec,
  ...(config_.pi.apiKey !== undefined ? { apiKey: config_.pi.apiKey } : {}),
  agentDir: config_.pi.agentDir,
  workspaceRoot: projectsRoot,
  runTimeoutMs: config_.pi.runTimeoutMs,
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
// M11.3：fullText 默认开启——语料稳定性由 Corpus Freeze 保证（这正是本验收
// 要证明的产品语义；m1123 时代的 enabled:false workaround 退役）
const stack = buildServiceStack({
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config_.latex.compileTimeoutMs }),
  agentIds: config_.agents,
  stageTimeoutMs: config_.stageTimeoutMs,
  stageMaxAttempts: config_.stageMaxAttempts,
  ...(config_.pi.longRunTimeoutMs !== undefined
    ? { longRunTimeoutMs: Math.max(config_.pi.longRunTimeoutMs, 600_000) }
    : { longRunTimeoutMs: 900_000 }),
  ...(config_.search !== undefined ? { search: config_.search } : {}),
  ...(config_.citation !== undefined ? { citation: config_.citation } : {}),
  log: (message) => console.log(message),
});
stackRef = stack;

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
const base = `http://127.0.0.1:${server.address().port}`;
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
  // ---- 1. 副本 ----
  await rm(join(config.work, "projects"), { recursive: true, force: true });
  await mkdir(join(config.work, "projects"), { recursive: true });
  await cp(join(config.sourceRoot, config.projectId), join(config.work, "projects", config.projectId), {
    recursive: true,
  });
  const projectId = config.projectId;
  console.log(`[prep] ${config.label} 副本就绪：${projectId}`);

  // ---- 2. 预冻结语料（freeze 幂等；basisDepth 来自既有 matrix） ----
  const matrix = await stack.survey.getMatrix(projectId);
  const frozen = await stack.corpus.freeze(projectId, { matrix });
  console.log(
    `[corpus] 冻结基线：revision=${frozen.revision} sources=${frozen.counts.total} hasFulltext(disk)=${frozen.counts.hasFulltext} fulltextBasis(matrix)=${frozen.counts.fulltextBasis} abstractBasis=${frozen.counts.abstractBasis} fingerprint=${frozen.fingerprint}`,
  );
  const evidenceBefore = (await stack.evidence.list(projectId)).length;
  console.log(`[step] evidence.list ok（${evidenceBefore} 条）`);

  // ---- 3. run ----
  const runsResponse = await request("GET", `/runs?projectId=${projectId}`);
  console.log(`[step] GET runs ok`);
  for (const orphan of runsResponse.body["runs"] ?? []) {
    // 含 awaiting_input：被复制过来的 stale run（进程被杀时停在 HITL）会被
    // 服务器恢复为活跃 run，阻断新 run 创建（409）——一律取消
    if (orphan.status === "running" || orphan.status === "pending" || orphan.status === "awaiting_input") {
      console.log(`[cleanup] 取消孤儿 run ${orphan.runId}（${orphan.status}）`);
      await request("POST", `/runs/${orphan.runId}/cancel`).catch(() => {});
    }
  }
  console.log(`[step] POST workflows…`);
  const started = await request("POST", `/projects/${projectId}/workflows`, { kind: "topic_survey" });
  console.log(`[step] POST workflows → ${started.status} ${started.status !== 202 ? JSON.stringify(started.body).slice(0, 400) : started.body.runId}`);
  if (started.status !== 202) {
    throw new Error(`run 启动失败：${started.status} ${JSON.stringify(started.body)}`);
  }
  const runId = started.body.runId;
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
        const accepted = await readAcceptedCandidateIds(projectId);
        if (accepted.length > 0) {
          resumePayload = { candidateIds: accepted };
        }
      }
      const payload = run.awaiting?.payload ?? {};
      console.log(
        `[hitl] ${stageId} → ${decision}（elapsed ${Math.round((Date.now() - runStartedAt) / 60000)}min；failureClass=${payload["failureClass"] ?? "-"}；convergence=${payload["convergence"] ?? "-"}；outcome=${payload["outcome"] ?? "-"}）`,
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
  console.log(
    `\n[done] status=${run.status} label=${run.completion?.label ?? "-"} qualityStatus=${run.completion?.summary?.qualityStatus ?? "-"} elapsed=${Math.round((Date.now() - runStartedAt) / 60000)}min`,
  );
  console.log(JSON.stringify(run.completion?.summary ?? {}, null, 2));
  if (run.status === "failed") {
    console.log(`[error] ${run.error?.code} @ ${run.error?.stageId}: ${run.error?.message?.slice(0, 300)}`);
  }

  // ---- 4. 产物摘要 ----
  const summary = {
    case: process.argv[2],
    runId,
    status: run.status,
    completion: run.completion ?? null,
    corpus: {},
    iterations: [],
    claimGrounding: [],
    evidence: { before: evidenceBefore, after: (await stack.evidence.list(projectId)).length },
  };

  const frozenAfter = await stack.corpus.get(projectId);
  summary.corpus = {
    frozenAtStart: { revision: frozen.revision, fingerprint: frozen.fingerprint, counts: frozen.counts },
    afterRun: frozenAfter && {
      revision: frozenAfter.revision,
      fingerprint: frozenAfter.fingerprint,
      counts: frozenAfter.counts,
    },
    unchanged: frozenAfter?.fingerprint === frozen.fingerprint && frozenAfter?.revision === frozen.revision,
  };
  console.log(
    `\n[corpus] 运行后快照：revision=${frozenAfter?.revision} fingerprint=${frozenAfter?.fingerprint} ${summary.corpus.unchanged ? "（冻结稳定 ✓）" : "（漂移！✗）"}`,
  );

  const iterations = JSON.parse(
    await readFile(join(projects.reviewsDir(projectId), "iteration-history.json"), "utf8"),
  );
  console.log("\niteration-history（全部轮）：");
  for (const record of iterations.iterations) {
    console.log(
      `  r${record.gateRound}: rev${record.revision} outcome=${record.outcome ?? "-"} ` +
        `score=${record.scorecard.academicScore} crit=${record.scorecard.critical} maj=${record.scorecard.major} blk=${record.scorecard.blocking} style=${record.scorecard.styleRisk ?? "-"} ` +
        `unsupO=${record.scorecard.unsupportedOpaque ?? "-"} unsupT=${record.scorecard.unsupportedTransparent ?? "-"} ` +
        `factV=${record.scorecard.factViolations ?? "-"} citeV=${record.scorecard.citationViolations ?? "-"} failed=[${record.scorecard.failedRuleIds.join(",")}]`,
    );
  }
  summary.iterations = iterations.iterations.map((record) => ({
    gateRound: record.gateRound,
    revision: record.revision,
    outcome: record.outcome ?? null,
    scorecard: record.scorecard,
  }));

  const rounds = await stack.reviewArtifacts.gateRounds(projectId);
  for (const round of rounds.slice(-4)) {
    const cg = await stack.reviewArtifacts.loadClaimGrounding(projectId, round);
    if (cg === null) continue;
    const resolution = await stack.reviewArtifacts.loadClaimResolution(projectId, round);
    const rs = await readFile(join(projects.reviewsDir(projectId), `review-summary-r${round}.json`), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    summary.claimGrounding.push({
      round,
      totalClaims: cg.totalClaims,
      unsupported: cg.unsupportedClaims,
      opaque: cg.opaqueUnsupportedClaims,
      transparent: cg.transparentUnsupportedClaims,
      resolution: resolution?.counts ?? null,
      disconfirmedIssues: rs?.disconfirmedIssues?.length ?? 0,
    });
    console.log(
      `\nr${round}: claims=${cg.totalClaims} unsupported=${cg.unsupportedClaims}（opaque=${cg.opaqueUnsupportedClaims}/transparent=${cg.transparentUnsupportedClaims}）disconfirmed=${rs?.disconfirmedIssues?.length ?? 0}` +
        (resolution ? ` resolution=${JSON.stringify(resolution.counts)}` : ""),
    );
    if (rs?.disconfirmedIssues?.length > 0) {
      for (const issue of rs.disconfirmedIssues) {
        console.log(`  [disconfirmed] ${issue.severity}|${issue.section}: ${String(issue.description).slice(0, 120)}`);
      }
    }
  }

  // build gate / PDF
  try {
    const buildGate = JSON.parse(await readFile(join(projects.buildDir(projectId), "build-gate.json"), "utf8"));
    summary.buildGate = { passed: buildGate.passed, revision: buildGate.revision, diagnostics: buildGate.diagnostics?.length ?? 0 };
    console.log(`\n[build] gate.passed=${buildGate.passed} revision=${buildGate.revision}`);
  } catch {
    console.log("\n[build] 无 build-gate.json");
  }
  const artifactsDir = join(projects.root, projectId, "artifacts");
  if (existsSync(artifactsDir)) {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(artifactsDir)).filter((name) => name.endsWith(".pdf"));
    summary.pdfs = files;
    console.log(`[artifacts] PDF：${files.join("、") || "（无）"}`);
  }

  // trace 成本
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
    summary.trace = { turns: modelSpans.length, tokens, cost: Number(cost.toFixed(2)) };
    console.log(
      `[trace] turns=${modelSpans.length} tokens(in/out/cacheRead)=${tokens.input}/${tokens.output}/${tokens.cacheRead} cost=$${cost.toFixed(2)}`,
    );
  } catch {
    console.log("[trace] 不可读（跳过）");
  }

  await mkdir(config.work, { recursive: true });
  await writeFile(join(config.work, "final-report.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n[report] ${join(config.work, "final-report.json")}`);
} finally {
  // Windows：进程退出与未结算的 close 回调竞态会触发 libuv 断言
  // （UV_HANDLE_CLOSING）——串行关闭 + 短暂让步后再退出
  server.close();
  await orchestrator.close().catch(() => {});
  await adapter.close().catch(() => {});
  await new Promise((resolveGrace) => setTimeout(resolveGrace, 500));
  process.exit(0);
}
