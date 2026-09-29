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
import { DocumentParserUnavailableError } from "../../src/errors.js";
import type { DocumentParser } from "../../src/ingestion/types.js";
import type { LatexImporter } from "../../src/import/LatexImporter.js";
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

/** 编译成功且生成 main.pdf 的假 runner（M9.5.1 编排：编译命令在 buildDir=cwd 内执行） */
export const fakeSuccessfulRunner: CommandRunner = async (command, args, opts) => {
  if (args.includes("--version")) {
    return { code: 0, stdout: `${command} 1.0`, stderr: "" };
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(opts.cwd, "main.pdf"), "%PDF-1.5");
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
export type ServiceStackOptionsSearch = Parameters<typeof buildServiceStack>[0]["search"];
export type ServiceStackOptionsFullText = Parameters<typeof buildServiceStack>[0]["fullText"];
export type ServiceStackOptionsIngestion = Parameters<typeof buildServiceStack>[0]["ingestion"];
export type ServiceStackOptionsVision = NonNullable<Parameters<typeof buildServiceStack>[0]["vision"]>;

/** 测试默认的离线文档解析 stub：PDF 上传的后台 ingestion 立即失败（不 spawn python/docling） */
const offlineDocumentParser: DocumentParser = {
  id: "test-offline",
  async parseFile() {
    throw new DocumentParserUnavailableError(
      "测试栈禁用文档解析（离线；ingestion 测试请注入 fake parser）",
    );
  },
};

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

/**
 * M10.3：轮询 run 直到 awaiting_input，途中对指定的中间 HITL 自动批准。
 * existing_paper_improvement 前段新增 hitl.research_plan（approve）/
 * hitl.evidence_supply（continue）后，旧测试只关心 hitl.plan_confirm——
 * 用本辅助越过新增决策点，测试焦点保持在原断言。
 */
export async function pollRunUntilAwaiting(
  stack: TestStack,
  runId: string,
  targetStage: string,
  options: { timeoutMs?: number; autoDecisions?: Record<string, string> } = {},
): Promise<import("../../src/workflow/types.js").WorkflowState> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const autoDecisions = options.autoDecisions ?? {
    "hitl.research_plan": "approve",
    "hitl.evidence_supply": "continue",
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as import("../../src/workflow/types.js").WorkflowState;
    if (run.status === "awaiting_input" && run.awaiting?.stageId === targetStage) {
      return run;
    }
    if (run.status === "failed") {
      throw new Error(
        `run 意外失败：${run.error?.code} ${run.error?.message}（stage ${run.error?.stageId ?? "?"}）`,
      );
    }
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      const decision = autoDecisions[stageId];
      if (decision === undefined) {
        throw new Error(`等待 ${targetStage} 时遇到未预期的待办节点 ${stageId}`);
      }
      await stack.request("POST", `/api/runs/${runId}/resume`, { decision });
      continue;
    }
    if (run.status === "completed") {
      throw new Error(`run 已完成（未出现 ${targetStage}）`);
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${targetStage} 超时（当前 ${run.status}，stage ${run.currentStage}）`);
    }
  }
}

export async function startTestStack(
  runtime: AgentRuntime,
  options: {
    latexRunner?: CommandRunner;
    citation?: ServiceStackOptionsCitation;
    review?: ServiceStackOptionsReview;
    /** search provider 装配（缺省全关 = 完全离线；http 测试注入 fake fetch / 显式启用单个 provider） */
    search?: ServiceStackOptionsSearch;
    /** M7.2 全文装配（缺省关闭 = promote 后台尝试 no-op，保持离线；测试注入 fake resolvers） */
    fullText?: ServiceStackOptionsFullText;
    skills?: { registry: import("../../src/skills/SkillRegistry.js").SkillRegistry; summaries?: import("../../src/skills/SkillSummaryService.js").SkillSummaryService };
    /** Readiness probe（GET /ready；M5.5） */
    readiness?: import("../../src/runtime/readiness.js").ReadinessProbe;
    /** Final PDF parser 注入（import-pdf / existing_paper_review 测试用） */
    paperParser?: import("../../src/paper/PdfParser.js").PdfParser;
    /** M10.1 ingestion 装配（缺省离线 stub；ingestion 测试注入 fake parser） */
    ingestion?: ServiceStackOptionsIngestion;
    /** M10.2 Vision 模型接入（缺省不装配 = analyze 全部 skipped；测试注入 fake） */
    vision?: ServiceStackOptionsVision;
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
    // search 同理：默认全部 academic provider 禁用（research 端点按 not configured
    // 结构化失败）；需要驱动真实 provider 逻辑的 http 测试注入 fetchImpl + 白名单
    ...(options.search !== undefined
      ? { search: options.search }
      : {
          search: {
            disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"],
            providerTimeoutMs: 2_000,
          },
        }),
    // M7.2：默认关闭全文 resolver（promote 后台 no-op，测试零外呼）；
    // 全文链路测试显式注入 fake resolvers
    ...(options.fullText !== undefined
      ? { fullText: options.fullText }
      : { fullText: { enabled: false } }),
    ...(options.paperParser !== undefined ? { paperParser: options.paperParser } : {}),
    // M10.1：默认离线（PDF 上传的后台 ingestion 不 spawn python / docling）；
    // CSV/XLSX 解析是进程内确定性 TS，不受此注入影响
    ingestion: {
      structuredParser: offlineDocumentParser,
      fallbackParser: offlineDocumentParser,
      ...(options.ingestion ?? {}),
    },
    ...(options.vision !== undefined ? { vision: options.vision } : {}),
    log: () => {},
  });
  // Existing-LaTeX 导入器：栈内单例（import-paper 的 latex 路径与 /:id/import 共用）
  const importer = stack.latexImport;
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
    ...(options.readiness !== undefined ? { readiness: options.readiness } : {}),
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
