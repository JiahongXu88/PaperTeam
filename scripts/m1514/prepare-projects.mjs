#!/usr/bin/env node
/**
 * M15.14 Phase C 前置 — 为 17 个选定 family 建 PaperTeam 项目（import-pdf），
 * 并确定性预置"无摘要 PaperMap"（由 parsed document.sections 派生，零模型调用）。
 *
 * 预置 map 的目的：A1 臂直调 FullPaperReviewService.reviewFullPaper 需要非空
 * PaperMap；生产路径的 map 摘要由 paper.ensure（batched ~3 调用/族）生成。为把
 * A1 的成本如实界定为"整稿 pass 本体 2 调用"，harness 预置 summary-less map——
 * fullpaper 对缺失摘要有诚实回退（导航行显示"（摘要未生成）"），被引节全文
 * （critique 的主要证据源）不受影响。该选择登记于协议 deviation 说明。
 *
 * 幂等：phase-c/projects.json 已存在的 family 跳过。
 * 用法：node scripts/m1514/prepare-projects.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const REPO = resolve(here, "..", "..");
const PROJECTS_ROOT = join(ROOT, "phase-d", "projects-root");
const FRAME = join(ROOT, "phase-b", "candidate-frame.json");
const MANUSCRIPTS = join(ROOT, "manuscripts");
const LEDGER = join(ROOT, "phase-b", "pdf-collection-ledger.json");
const OUT = join(ROOT, "phase-c", "projects.json");

process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
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
const { createExistingPaperReviewDefinition } = await import(distUrl("workflow", "definitions.js"));
const { initResearchNetwork } = await import(distUrl("network", "researchNetworkBootstrap.js"));

const config = loadConfig();
const researchNet = await initResearchNetwork({
  settingsDir: join(config.runtimeRoot, "settings"),
  ...(config.research.proxyUrl !== undefined ? { envProxyUrl: config.research.proxyUrl } : {}),
  log: () => {},
});
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: PROJECTS_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role_, scope) => skillRegistry.skillAssignmentsFor(role_, scope),
  log: () => {},
});
const projects = new ProjectStore({ root: PROJECTS_ROOT });
const stack = buildServiceStack({
  researchFetch: researchNet.router.fetch,
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  ...(config.pi.longRunTimeoutMs !== undefined ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) } : { longRunTimeoutMs: 900_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  log: () => {},
});
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore: new WorkflowRunStore(projects, { log: () => {} }),
  definitionFactory: (kind) =>
    kind === "existing_paper_review"
      ? createExistingPaperReviewDefinition(stack.workflowServices)
      : (() => {
          throw new Error(`只装配 existing_paper_review（${kind}）`);
        })(),
  log: () => {},
});
const server = createBackendHttpServer({ runtime: adapter, projects, generation: stack.generation, orchestrator, stack });
await new Promise((onListen) => server.listen(0, "127.0.0.1", onListen));
const base = `http://127.0.0.1:${server.address().port}`;
const request = async (method, path, body) => {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = { raw: true }; }
  return { status: response.status, body: parsed };
};

const frame = JSON.parse(await readFile(FRAME, "utf8"));
const pdfLedger = JSON.parse(await readFile(LEDGER, "utf8"));
const okPdfs = new Set(pdfLedger.filter((l) => l.status === "ok").map((l) => l.candidateId));
const existing = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : { generatedAt: null, families: [] };
const known = new Map(existing.families.map((f) => [f.familyId, f]));

const outFamilies = [];
for (const candidate of frame.candidates) {
  const familyId = `fam-${candidate.candidateId}`;
  if (known.has(familyId) && existsSync(join(PROJECTS_ROOT, known.get(familyId).projectId, "paper", "paper-map.json"))) {
    outFamilies.push(known.get(familyId));
    console.log(`[skip] ${familyId} → ${known.get(familyId).projectId}`);
    continue;
  }
  if (!okPdfs.has(candidate.candidateId)) {
    console.log(`[missing-pdf] ${familyId} skipped (collection failed)`);
    continue;
  }
  const contentBase64 = (await readFile(join(MANUSCRIPTS, `${familyId}.pdf`))).toString("base64");
  const created = await request("POST", "/projects/import-pdf", { fileName: `${familyId}.pdf`, contentBase64, goal: "review_only" });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`import-pdf failed ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
  }
  const projectId = created.body.project.id;
  // 确定性无摘要 PaperMap（由 parsed sections 派生；摘要缺省 → fullpaper 导航行
  // 显示"（摘要未生成）"诚实回退；sourceFingerprint 取 parsed document sha256）
  const document = JSON.parse(await readFile(join(PROJECTS_ROOT, projectId, "paper", "parsed", "document.json"), "utf8"));
  const chunksRaw = await readFile(join(PROJECTS_ROOT, projectId, "paper", "parsed", "chunks.jsonl"), "utf8");
  const chunks = chunksRaw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const bySection = new Map();
  for (const chunk of chunks) {
    bySection.set(chunk.sectionId, (bySection.get(chunk.sectionId) ?? 0) + 1);
  }
  const map = {
    schemaVersion: 1,
    documentTitle: document.title,
    abstract: document.abstract,
    pageCount: document.parse?.pageCount ?? 0,
    sections: document.sections.map((s) => ({
      sectionId: s.sectionId,
      title: s.title,
      level: s.level ?? 1,
      pageStart: s.pageStart,
      pageEnd: s.pageEnd,
      chunkCount: bySection.get(s.sectionId) ?? 0,
      charCount: s.charCount,
    })),
    generatedAt: new Date().toISOString(),
    sourceFingerprint: document.sha256,
    note: "m1514-harness deterministic summary-less map (zero model calls)",
  };
  await mkdir(join(PROJECTS_ROOT, projectId, "paper"), { recursive: true });
  await writeFile(join(PROJECTS_ROOT, projectId, "paper", "paper-map.json"), JSON.stringify(map, null, 1), "utf8");
  const record = {
    familyId,
    candidateId: candidate.candidateId,
    role: candidate.role,
    paperId: candidate.paperId,
    projectId,
    pdfSha256: pdfLedger.find((l) => l.candidateId === candidate.candidateId)?.sha256 ?? null,
  };
  outFamilies.push(record);
  console.log(`[imported] ${familyId} (${candidate.role}) → ${projectId} sections=${map.sections.length}`);
}
await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), projectsRoot: PROJECTS_ROOT, families: outFamilies }, null, 1), "utf8");
console.log(`done: ${outFamilies.length} families → ${OUT}`);
server.close();
process.exit(0);
