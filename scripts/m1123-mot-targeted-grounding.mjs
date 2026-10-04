#!/usr/bin/env node
/**
 * M11.2.3 D-3 真实采证微验证（一次性，service-direct）：
 * 对 MOT r8 claim-grounding 的 B 类 unsupported claims（全文在库、证据未采——
 * M11.3 预验收 §2 的 #1/#2/#3/#9：S024 番茄 / S016 Deep OC-SORT / S005 SMILEtrack /
 * S009 ContrasTR）跑 TargetedGroundingService：
 *   claim（r8 原文）+ 在库 chunks → 逐字 quote → 三段核验（quote / metadata / judge）
 *   → verified evidence 数（§20 验收的「补 Grounding 数量」）。
 * 不触碰 manuscript / reviews / matrix——只追加 evidence store（206 → 206+N）。
 *
 * 用法：node scripts/m1123-mot-targeted-grounding.mjs
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const projectId = "p-6de7674cd29e";
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

const config = loadConfig();
const skillRegistry = new SkillRegistry({
  storeRoot: join(config.runtimeRoot, "skills"),
  disabledSkillIds: config.skills.disabledSkillIds,
  log: () => {},
});
await skillRegistry.ensureInstalled();
const modelSettingsStore = new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
const modelSpec = config.pi.model ?? (await resolveStartupModelSpec(undefined, modelSettingsStore));

let stackRef;
const adapter = new PiRuntimeAdapter({
  modelSpec,
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: projectsRoot,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  roleCustomTools: () => [],
  log: () => {},
});
const projects = new ProjectStore({ root: projectsRoot });
const stack = buildServiceStack({
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  fullText: { enabled: false },
  log: () => {},
});
stackRef = stack;

// r8 的 4 条 B 类 claims（M11.3 预验收 §2 #1/#2/#3/#9 的原文）与其目标源
const requests = [
  {
    claimId: "b1-tomato",
    claim: "该跟踪模板被移植到农业番茄跟踪计数场景并验证有效",
    section: "sections/appearance-embedding-reid.tex",
    sourceIds: ["S024"],
  },
  {
    claimId: "b2-deepocsort",
    claim: "Deep OC-SORT 按置信度选择性吸收外观并自适应加权融合 IoU",
    section: "sections/appearance-embedding-reid.tex",
    sourceIds: ["S016"],
  },
  {
    claimId: "b3-smiletrack",
    claim: "SMILEtrack 同步改进检测端 PRB-Net 优于 YOLOX 并将模块即插即用移植到 ByteTrack 验证叠加性",
    section: "sections/appearance-embedding-reid.tex",
    sourceIds: ["S005"],
  },
  {
    claimId: "b9-contrastr",
    claim: "端到端侧 ContrasTR 以历史记忆余弦相似度分配身份",
    section: "sections/cross-method-comparison.tex",
    sourceIds: ["S009"],
  },
];

const before = (await stack.evidence.list(projectId)).length;
console.log(`evidence before=${before}`);
const result = await stack.targetedGrounding.groundClaims(projectId, requests);
const after = (await stack.evidence.list(projectId)).length;
console.log("\n===== Targeted Grounding 结果 =====");
for (const outcome of result.outcomes) {
  console.log(
    `${outcome.claimId}: ${outcome.status} evidence=${JSON.stringify(outcome.evidenceIds)}` +
      (outcome.reason !== undefined ? `（${outcome.reason.slice(0, 90)}）` : ""),
  );
  for (const attempt of outcome.attempts) {
    console.log(`  ${attempt.sourceId} ${attempt.chunkId.slice(0, 28)}… → ${attempt.outcome}${attempt.reason !== undefined ? `：${attempt.reason.slice(0, 70)}` : ""}`);
  }
}
console.log(
  `\nverifiedClaims=${result.verifiedClaims}/${requests.length} verifiedEvidence=${result.verifiedEvidence} unsupportedByJudge=${result.unsupportedByJudge}`,
);
console.log(`evidence ${before} → ${after}（Δ=${after - before}）`);
await adapter.close().catch(() => {});
