/**
 * 测试辅助：完整服务栈 + 按 contextScope 脚本化的 Agent Runtime（M3.1 / M3.2）。
 *
 * scriptedIdeaRuntime 让两条 workflow 在无 Gateway 的测试里真实跑通：
 * 按 AgentRuntime 的 contextScope 返回对应的结构化输出；
 * review 轮次可脚本化（pass / fail 序列）以驱动 bounded revision loop。
 * 实现与输出 payload 的唯一事实源在 src/runtime/scriptedRuntime.ts
 * （PAPERTEAM_TEST_RUNTIME=scripted 时启动入口直接复用同一实现，见 index.ts）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createBackendHttpServer } from "../../src/httpServer.js";
import { LatexCompiler, type CommandRunner } from "../../src/latex/LatexCompiler.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import type { AgentRuntime } from "../../src/runtime/types.js";
import { createScriptedRuntime } from "../../src/runtime/scriptedRuntime.js";
import { buildServiceStack, type ServiceStack } from "../../src/serviceStack.js";
import { LatexImporter } from "../../src/import/LatexImporter.js";
import { WorkflowOrchestrator } from "../../src/workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "../../src/workflow/runStore.js";
import {
  createExistingPaperDefinition,
  createExistingPaperReviewDefinition,
  createIdeaToPaperDefinition,
} from "../../src/workflow/definitions.js";

export const AGENT_IDS = {
  writer: "writer",
  researcher: "researcher",
  reviewer: "reviewer",
  citation: "citation",
} as const;

// 脚本化输出 payload 与 runtime 实现：src 侧唯一事实源的再导出
export {
  createScriptedRuntime,
  type ScriptedRuntime,
  type ScriptedRuntimeOptions,
  EXISTING_ANALYSIS_JSON,
  FEASIBILITY_HIGH_JSON,
  FEASIBILITY_INSUFFICIENT_JSON,
  IMPROVEMENT_PLAN_JSON,
  LATEX_DOC,
  OUTLINE_JSON,
  RESEARCH_JSON,
  REVISED_SECTION_TEX,
  SECTION_TEX,
} from "../../src/runtime/scriptedRuntime.js";

/** 按 contextScope 脚本化的 fake Runtime（历史测试名，等价 createScriptedRuntime） */
export function scriptedIdeaRuntime(
  options: import("../../src/runtime/scriptedRuntime.js").ScriptedRuntimeOptions = {},
): import("../../src/runtime/scriptedRuntime.js").ScriptedRuntime {
  return createScriptedRuntime(options);
}

/** 编译成功且生成 main.pdf 的假 runner */
export const fakeSuccessfulRunner: CommandRunner = async (command, args) => {
  if (args.includes("--version")) {
    return { code: 0, stdout: `${command} 1.0`, stderr: "" };
  }
  const outputDir = args.find((arg) => arg.startsWith("-output-directory="));
  if (outputDir) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(outputDir.slice("-output-directory=".length), "main.pdf"), "%PDF-1.5");
  }
  return { code: 0, stdout: "compiled", stderr: "" };
};

/** 编译失败的假 runner */
export const fakeFailingRunner: CommandRunner = async (command, args) => {
  if (args.includes("--version")) {
    return { code: 0, stdout: `${command} 1.0`, stderr: "" };
  }
  return { code: 1, stdout: "! Undefined control sequence.", stderr: "" };
};

export type ServiceStackOptionsCitation = Parameters<typeof buildServiceStack>[0]["citation"];
export type ServiceStackOptionsReview = Parameters<typeof buildServiceStack>[0]["review"];

export interface TestStack {
  stack: ServiceStack;
  store: ProjectStore;
  root: string;
  orchestrator: WorkflowOrchestrator;
  importer: LatexImporter;
  server: Server;
  cleanup: () => Promise<void>;
  /** HTTP 请求辅助 */
  request: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  port: () => number;
}

export async function startTestStack(
  runtime: AgentRuntime,
  options: {
    latexRunner?: CommandRunner;
    citation?: ServiceStackOptionsCitation;
    review?: ServiceStackOptionsReview;
    skills?: { registry: import("../../src/skills/SkillRegistry.js").SkillRegistry; summaries?: import("../../src/skills/SkillSummaryService.js").SkillSummaryService };
    /** Final PDF parser 注入（import-pdf / existing_paper_review 测试用） */
    paperParser?: import("../../src/paper/PdfParser.js").PdfParser;
    /** 复用已有 projects 根（重启恢复测试：第二栈不 mkdtemp、cleanup 不删根） */
    root?: string;
    registerCleanup?: (cleanup: () => Promise<void>) => void;
  } = {},
): Promise<TestStack> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "paperteam-stack-")));
  const store = new ProjectStore({ root });
  const latex = new LatexCompiler({
    timeoutMs: 10_000,
    runner: options.latexRunner ?? fakeSuccessfulRunner,
  });
  const stack = buildServiceStack({
    runtime,
    projects: store,
    latex,
    agentIds: { ...AGENT_IDS },
    stageTimeoutMs: 10_000,
    stageMaxAttempts: 2,
    // 测试里节内重试不等退避
    review: { sectionRetryBackoffMs: [0, 0], ...(options.review ?? {}) },
    // 测试默认完全离线：关闭旧 metadata 查询，scholarly resolver 不挂任何 provider
    // （否则 citation.metadata stage 会真的去查 crossref / openalex，网络慢时整条链路超时）
    ...(options.citation
      ? { citation: options.citation }
      : { citation: { metadataEnabled: false, scholarly: { providers: [] } } }),
    ...(options.paperParser !== undefined ? { paperParser: options.paperParser } : {}),
    log: () => {},
  });
  const importer = new LatexImporter({ projects: store, latex, log: () => {} });
  const orchestrator = new WorkflowOrchestrator({
    projects: store,
    runStore: new WorkflowRunStore(store),
    definitionFactory: (kind) => {
      switch (kind) {
        case "idea_to_paper":
          return createIdeaToPaperDefinition(stack.workflowServices);
        case "existing_paper_improvement":
          return createExistingPaperDefinition(stack.workflowServices);
        case "existing_paper_review":
          return createExistingPaperReviewDefinition(stack.workflowServices);
      }
    },
    retryDelayMs: 0,
    log: () => {},
  });
  const server = createBackendHttpServer({
    runtime,
    projects: store,
    generation: stack.generation,
    orchestrator,
    stack,
    importer,
    ...(options.skills !== undefined
      ? { skills: options.skills.registry, ...(options.skills.summaries !== undefined ? { skillSummaries: options.skills.summaries } : {}) }
      : {}),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const cleanup = async () => {
    await orchestrator.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (options.root === undefined) {
      await rm(root, { recursive: true, force: true });
    }
  };
  options.registerCleanup?.(cleanup);
  return {
    stack,
    store,
    root,
    orchestrator,
    importer,
    server,
    cleanup,
    port: () => port,
    request: async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(body !== undefined
          ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
          : {}),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}
