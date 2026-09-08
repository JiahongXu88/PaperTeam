import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  BusinessError,
  NotFoundError,
  ProjectBusyError,
  ProjectNotArchivedError,
  toBusinessError,
} from "./errors.js";
import {
  SUPPORT_STRENGTHS,
  VERIFICATION_LEVELS,
  VERIFICATION_STATUSES,
  type EvidenceLocation,
  type EvidenceSourceRef,
} from "./evidence/EvidenceStore.js";
import type { GenerationService } from "./generation/GenerationService.js";
import type { LatexImporter } from "./import/LatexImporter.js";
import type { ModelSettingsService } from "./settings/ModelSettingsService.js";
import { MAX_PAPER_PDF_BYTES } from "./paper/PaperIngestService.js";
import type { ProjectStore } from "./project/ProjectStore.js";
import { readExistingPaperGoal } from "./project/ProjectImportService.js";
import type { AgentRuntime, RuntimeHealth } from "./runtime/types.js";
import type { RuntimeStatusService } from "./runtime/statusService.js";
import type { ServiceStack } from "./serviceStack.js";
import { AgentMultimodalAnalyzer } from "./sources/PdfAnalyzer.js";
import { MAX_SOURCE_BYTES } from "./sources/SourceStore.js";
import type { SkillRegistry } from "./skills/SkillRegistry.js";
import type { SkillSummaryService } from "./skills/SkillSummaryService.js";
import { readFeasibilityReport } from "./agents/FeasibilityService.js";
import { aggregateReviews } from "./review/ReviewAggregator.js";
import { ReviewReportExporter, contentDisposition } from "./review/ReviewReportExporter.js";
import {
  evaluateQualityGate,
  runBuildGate,
  saveQualityGateReport,
} from "./quality/gates.js";
import { collectLatexFiles } from "./manuscript/LatexFiles.js";
import { isWorkflowKind, WORKFLOW_KINDS, type WorkflowKind } from "./workflow/kinds.js";
import {
  CITATION_SEMANTIC_MODES,
  DEFAULT_CITATION_SEMANTIC_MODE,
  isCitationSemanticMode,
  type CitationSemanticMode,
} from "./citation/semanticMode.js";
import type { WorkflowDomainEvent } from "./workflow/types.js";
import type { WorkflowOrchestrator } from "./workflow/WorkflowOrchestrator.js";

/**
 * Backend 自身的轻量 HTTP 服务（Node 原生 http，无 Web 框架）。
 *
 * 端点清单与 DTO 以 docs/API_CONTRACT.md 为准；本文件只做三件事：
 * 路由匹配与方法校验、请求体解析与字段校验、把服务层结果与 BusinessError
 * 映射为 JSON 响应。业务逻辑与文件 I/O 一律在服务层（ServiceStack）。
 *
 * 错误约定：BusinessError → 其 httpStatus + {status:"error", error:{code,message,detail?}}；
 * 其它异常统一 500 且不透传内部消息（原始错误只进日志）。
 */

/** 普通 JSON 请求体上限（字节） */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * base64 上传请求体上限：原始文件上限 × 4/3 膨胀 + JSON 包装余量。
 * 与服务层的文件大小上限联动，否则「50MB」只是文档上的数字。
 */
const UPLOAD_BODY_SLACK_BYTES = 1024 * 1024;
const MAX_SOURCE_UPLOAD_BODY_BYTES = Math.ceil((MAX_SOURCE_BYTES * 4) / 3) + UPLOAD_BODY_SLACK_BYTES;
const MAX_PAPER_UPLOAD_BODY_BYTES = Math.ceil((MAX_PAPER_PDF_BYTES * 4) / 3) + UPLOAD_BODY_SLACK_BYTES;

/** SSE 心跳间隔（毫秒） */
const SSE_HEARTBEAT_MS = 15_000;

export interface BackendHttpServerOptions {
  runtime: AgentRuntime;
  projects: ProjectStore;
  generation: GenerationService;
  orchestrator: WorkflowOrchestrator;
  /** 业务服务栈（文献 / Evidence / 引用 / 手稿 / PDF Review） */
  stack?: ServiceStack;
  /** Existing-LaTeX 导入器 */
  importer?: LatexImporter;
  /** Runtime 状态诊断（GET /api/runtime/status） */
  runtimeStatus?: RuntimeStatusService;
  /** Skill Registry（GET /api/skills） */
  skills?: SkillRegistry;
  skillSummaries?: SkillSummaryService;
  /** Model Settings（/api/settings/model） */
  modelSettings?: ModelSettingsService;
}

export function createBackendHttpServer({
  runtime,
  projects,
  generation,
  orchestrator,
  stack,
  importer,
  runtimeStatus,
  skills,
  skillSummaries,
  modelSettings,
}: BackendHttpServerOptions): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res, {
      runtime,
      projects,
      generation,
      orchestrator,
      stack,
      importer,
      runtimeStatus,
      skills,
      skillSummaries,
      modelSettings,
    }).catch((error: unknown) => {
      const businessError = toBusinessError(error);
      if (businessError !== error) {
        // 未归类异常：完整原因只进日志，响应体只给稳定的 INTERNAL_ERROR
        console.error(`[http] 未处理错误（${req.method ?? "?"} ${req.url ?? "?"}）:`, error);
      }
      if (!res.headersSent) {
        sendBusinessError(res, businessError);
      } else {
        res.end();
      }
    });
  });
  // SSE 长连接需要禁用请求级超时（keep-alive 由心跳维持）
  server.requestTimeout = 0;
  return server;
}

interface Services {
  runtime: AgentRuntime;
  projects: ProjectStore;
  generation: GenerationService;
  orchestrator: WorkflowOrchestrator;
  stack?: ServiceStack;
  importer?: LatexImporter;
  runtimeStatus?: RuntimeStatusService;
  skills?: SkillRegistry;
  skillSummaries?: SkillSummaryService;
  modelSettings?: ModelSettingsService;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  services: Services,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  // ---- GET /health ----
  if (pathname === "/health") {
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    const health: RuntimeHealth = await services.runtime.healthCheck();
    sendJson(res, 200, {
      status: "ok",
      runtime: {
        provider: health.provider,
        ok: health.ok,
        status: health.status,
        detail: health.detail,
        latencyMs: health.latencyMs,
        checkedAt: health.checkedAt,
      },
    });
    return;
  }

  // ---- GET /api/runtime/status ----
  if (pathname === "/api/runtime/status") {
    if (method !== "GET") {
      res.setHeader("Allow", "GET");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    if (services.runtimeStatus === undefined) {
      sendJson(res, 503, { status: "unavailable", detail: "Runtime 诊断服务未配置" });
      return;
    }
    const status = await services.runtimeStatus.getStatus();
    sendJson(res, 200, { status });
    return;
  }

  // ---- /api/skills（全局 Skill 资源：只读 + 摘要重生成） ----
  if (pathname === "/api/skills" || pathname.startsWith("/api/skills/")) {
    if (services.skills === undefined) {
      sendJson(res, 503, { status: "unavailable", detail: "Skill Registry 未配置" });
      return;
    }
    const skillMatch = /^\/api\/skills\/([a-z0-9][a-z0-9-]*)(\/summary)?$/.exec(pathname);
    if (skillMatch === null) {
      if (method === "GET") {
        const skills = await services.skills.list();
        sendJson(res, 200, { skills, bindings: services.skills.bindings() });
        return;
      }
      res.setHeader("Allow", "GET");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    const skillId = skillMatch[1] ?? "";
    const isSummary = skillMatch[2] === "/summary";
    if (!isSummary) {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET", method);
        return;
      }
      const skill = await services.skills.get(skillId);
      if (skill === null) {
        throw new NotFoundError("Skill", skillId);
      }
      sendJson(res, 200, { skill });
      return;
    }
    if (method !== "POST") {
      sendMethodNotAllowed(res, "POST", method);
      return;
    }
    if (services.skillSummaries === undefined) {
      sendJson(res, 503, { status: "unavailable", detail: "Skill 摘要服务未配置" });
      return;
    }
    const skill = await services.skills.get(skillId);
    if (skill === null) {
      throw new NotFoundError("Skill", skillId);
    }
    const { generated, failed } = await services.skillSummaries.generateMissing({ only: skillId });
    if (failed.includes(skillId) || generated.length === 0) {
      throw new BusinessError("AGENT_RUN_FAILED", `简介生成失败（模型可能未配置）：${skillId}`);
    }
    sendJson(res, 200, { skill: await services.skills.get(skillId) });
    return;
  }

  // ---- /api/settings/model ----
  if (pathname === "/api/settings/model" || pathname.startsWith("/api/settings/model/")) {
    if (services.modelSettings === undefined) {
      sendJson(res, 503, { status: "unavailable", detail: "Model Settings 服务未配置" });
      return;
    }
    const handled = await handleModelSettingsRoutes(
      req,
      res,
      pathname,
      method,
      url,
      services.modelSettings,
    );
    if (handled) {
      return;
    }
    sendJson(res, 404, { status: "not_found", path: pathname });
    return;
  }

  // ---- /api/projects ----
  if (pathname === "/api/projects") {
    if (method === "GET") {
      // 项目列表（updatedAt 降序）；默认只返回未归档项目
      const scope = url.searchParams.get("scope") ?? "active";
      if (scope !== "active" && scope !== "archived" && scope !== "all") {
        throw new BusinessError("INVALID_REQUEST", "scope 只能是 active / archived / all");
      }
      const projects = await services.projects.listMetadata(scope);
      sendJson(res, 200, { projects, scope });
      return;
    }
    if (method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    const body = await readJsonBody(req);
    const title = readStringField(body, "title");
    if (title === undefined) {
      throw new BusinessError("INVALID_REQUEST", "请求体必须包含非空字符串字段 title");
    }
    const project = await services.projects.create(title, readResearchMeta(body));
    sendJson(res, 201, { project });
    return;
  }

  // ---- POST /api/projects/import-pdf（已有论文 File-First 导入） ----
  if (pathname === "/api/projects/import-pdf") {
    if (method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    if (services.stack === undefined) {
      sendJson(res, 503, { status: "unavailable", detail: "业务服务栈未配置" });
      return;
    }
    const { body, fileName, content } = await readUploadBody(req, MAX_PAPER_UPLOAD_BODY_BYTES);
    const goal = readExistingPaperGoal(body["goal"]);
    const result = await services.stack.projectImport.importPdf({
      fileName,
      content,
      goal,
      meta: readResearchMeta(body),
    });
    sendJson(res, 201, {
      project: result.project,
      document: toPaperDocumentSummary(result.document),
      titleSource: result.titleSource,
    });
    return;
  }

  // ---- /api/projects/:id（GET / PATCH / DELETE） ----
  const projectMatch = /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})$/.exec(pathname);
  if (projectMatch) {
    const projectId = projectMatch[1] ?? "";
    if (method === "GET") {
      const project = await services.projects.getRequired(projectId);
      sendJson(res, 200, { project });
      return;
    }
    if (method === "PATCH") {
      const body = await readJsonBody(req);
      const title = readOptionalTitle(body);
      const project = await services.projects.updateMeta(projectId, {
        ...readResearchMeta(body, true),
        ...(title !== undefined ? { title } : {}),
      });
      sendJson(res, 200, { project });
      return;
    }
    if (method === "DELETE") {
      await permanentlyDeleteProject(services, projectId);
      sendJson(res, 200, { status: "deleted", projectId });
      return;
    }
    res.setHeader("Allow", "GET, PATCH, DELETE");
    sendJson(res, 405, { status: "method_not_allowed", method });
    return;
  }

  // ---- POST /api/projects/:id/archive | /restore ----
  const lifecycleMatch = /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/(archive|restore)$/.exec(pathname);
  if (lifecycleMatch) {
    const projectId = lifecycleMatch[1] ?? "";
    const action = lifecycleMatch[2] ?? "";
    if (method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    if (action === "archive") {
      if (await services.orchestrator.hasActiveRun(projectId)) {
        throw new ProjectBusyError(
          "当前项目仍有进行中的任务，请先完成或取消任务后再归档。",
        );
      }
      const project = await services.projects.archive(projectId);
      sendJson(res, 200, { project });
      return;
    }
    const project = await services.projects.restore(projectId);
    sendJson(res, 200, { project });
    return;
  }

  // ---- POST /api/projects/:id/generate（同步形态，保留兼容） ----
  const generateMatch = /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/generate$/.exec(pathname);
  if (generateMatch) {
    const projectId = generateMatch[1] ?? "";
    if (method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    const body = await readJsonBody(req);
    const prompt = readStringField(body, "prompt");
    if (prompt === undefined) {
      throw new BusinessError("INVALID_REQUEST", "请求体必须包含非空字符串字段 prompt");
    }
    const result = await services.generation.generate({ projectId, prompt });
    sendJson(res, 200, result);
    return;
  }

  // ---- POST /api/projects/:id/workflows（异步 WorkflowRun） ----
  const workflowsMatch = /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/workflows$/.exec(pathname);
  if (workflowsMatch) {
    const projectId = workflowsMatch[1] ?? "";
    if (method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    const body = await readJsonBody(req);
    const kind = readWorkflowKind(body);
    const prompt = readStringField(body, "prompt");
    const project = await services.projects.getRequired(projectId);
    if (project.archivedAt !== undefined) {
      throw new ProjectBusyError(`项目已归档，不能启动新任务（请先恢复项目 ${projectId}）`);
    }
    const run = await services.orchestrator.createRun(projectId, kind, {
      ...(prompt !== undefined ? { prompt } : {}),
      // 语义核验模式：显式写入 request（新 run 缺省 off；读取端对缺字段的旧 run
      // 按 full 解释，两个默认值不共用同一条兜底路径）
      ...(kind === "existing_paper_review" ? { citationSemanticMode: readCitationSemanticMode(body) } : {}),
    });
    sendJson(res, 202, { runId: run.runId, status: run.status, workflowKind: run.workflowKind });
    return;
  }

  // ---- GET /api/runs?projectId=... ----
  if (pathname === "/api/runs") {
    if (method !== "GET") {
      res.setHeader("Allow", "GET");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    const projectId = url.searchParams.get("projectId") ?? "";
    if (projectId === "") {
      throw new BusinessError("INVALID_REQUEST", "缺少查询参数 projectId");
    }
    const runs = await services.orchestrator.listRuns(projectId);
    sendJson(res, 200, { runs });
    return;
  }

  // ---- /api/runs/:runId[/events|/resume|/cancel] ----
  const runMatch = /^\/api\/runs\/([a-z0-9][a-z0-9-]{0,63})(\/[a-z]+)?$/.exec(pathname);
  if (runMatch) {
    const runId = runMatch[1] ?? "";
    const action = runMatch[2] ?? "";
    if (action === "") {
      if (method !== "GET") {
        res.setHeader("Allow", "GET");
        sendJson(res, 405, { status: "method_not_allowed", method });
        return;
      }
      const run = await services.orchestrator.getRun(runId);
      sendJson(res, 200, { run });
      return;
    }
    if (action === "/events") {
      if (method !== "GET") {
        res.setHeader("Allow", "GET");
        sendJson(res, 405, { status: "method_not_allowed", method });
        return;
      }
      await handleRunEventsSse(req, res, services.orchestrator, runId);
      return;
    }
    if (action === "/resume") {
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { status: "method_not_allowed", method });
        return;
      }
      const body = await readJsonBody(req);
      const decision = readStringField(body, "decision");
      if (decision === undefined) {
        throw new BusinessError("INVALID_REQUEST", "请求体必须包含非空字符串字段 decision");
      }
      const payload = readPayloadField(body, "payload");
      const run = await services.orchestrator.resume(runId, { decision, ...(payload !== undefined ? { payload } : {}) });
      sendJson(res, 200, { run });
      return;
    }
    if (action === "/cancel") {
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { status: "method_not_allowed", method });
        return;
      }
      const run = await services.orchestrator.cancel(runId);
      sendJson(res, 200, { run });
      return;
    }
    sendJson(res, 404, { status: "not_found", path: pathname });
    return;
  }

  // ---- 项目下资源路由（需要服务栈） ----
  if (services.stack !== undefined) {
    const handled = await handleProjectResourceRoutes(
      req,
      res,
      pathname,
      method,
      url,
      services.stack,
      services.importer,
      services.orchestrator,
    );
    if (handled) {
      return;
    }
  }

  sendJson(res, 404, { status: "not_found", path: pathname });
}

/**
 * /api/settings/model 路由组：
 *   GET    /api/settings/model                 状态（不含任何 key）
 *   PUT    /api/settings/model                 保存 {model, apiKey?}（apiKey 省略 = 保持原 Key）
 *   DELETE /api/settings/model/key             清除本地保存的 API Key
 *   GET    /api/settings/model/options         provider 列表（?provider= 查该 provider 模型）
 *   POST   /api/settings/model/test            Test Connection {model, apiKey?}
 *   GET    /api/settings/model/custom-providers          自定义提供商列表（不含 key）
 *   PUT    /api/settings/model/custom-providers/:id      新建 / 整体替换 {provider, apiKey?}
 *   DELETE /api/settings/model/custom-providers/:id      删除（连同其本地凭据与指向它的模型偏好）
 *
 * 安全约束：所有响应不携带 key 本体；apiKey 只经 PUT/test 请求体进入，
 * 不落任何日志（请求体从不打印）。
 */
async function handleModelSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  url: URL,
  service: ModelSettingsService,
): Promise<boolean> {
  if (pathname === "/api/settings/model") {
    if (method === "GET") {
      const settings = await service.getStatus();
      sendJson(res, 200, { settings });
      return true;
    }
    if (method === "PUT") {
      const body = await readJsonBody(req);
      const model = readStringField(body, "model");
      if (model === undefined) {
        throw new BusinessError("INVALID_REQUEST", "请求体必须包含非空字符串字段 model");
      }
      // apiKey：字段不存在 → 保持原 Key；空字符串 → 语义非法（400）
      const apiKeyField = body["apiKey"];
      if (apiKeyField !== undefined && typeof apiKeyField !== "string") {
        throw new BusinessError("INVALID_REQUEST", "字段 apiKey 必须是字符串");
      }
      const settings = await service.saveModel({
        model,
        ...(typeof apiKeyField === "string" ? { apiKey: apiKeyField } : {}),
      });
      sendJson(res, 200, { settings });
      return true;
    }
    res.setHeader("Allow", "GET, PUT");
    sendJson(res, 405, { status: "method_not_allowed", method });
    return true;
  }

  if (pathname === "/api/settings/model/key" && method === "DELETE") {
    const settings = await service.clearApiKey();
    sendJson(res, 200, { settings });
    return true;
  }

  if (pathname === "/api/settings/model/options" && method === "GET") {
    const provider = url.searchParams.get("provider") ?? undefined;
    const options = await service.getOptions(provider === "" ? undefined : provider);
    sendJson(res, 200, { options });
    return true;
  }

  if (pathname === "/api/settings/model/test" && method === "POST") {
    const body = await readJsonBody(req);
    const model = readStringField(body, "model");
    if (model === undefined) {
      throw new BusinessError("INVALID_REQUEST", "请求体必须包含非空字符串字段 model");
    }
    const apiKeyField = body["apiKey"];
    if (apiKeyField !== undefined && typeof apiKeyField !== "string") {
      throw new BusinessError("INVALID_REQUEST", "字段 apiKey 必须是字符串");
    }
    const result = await service.testConnection({
      model,
      ...(typeof apiKeyField === "string" && apiKeyField !== "" ? { apiKey: apiKeyField } : {}),
    });
    sendJson(res, 200, { result });
    return true;
  }

  if (pathname === "/api/settings/model/custom-providers") {
    if (method === "GET") {
      sendJson(res, 200, { providers: await service.listCustomProviders() });
      return true;
    }
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { status: "method_not_allowed", method });
    return true;
  }

  const customProviderMatch = /^\/api\/settings\/model\/custom-providers\/([^/]+)$/.exec(pathname);
  if (customProviderMatch !== null) {
    const id = decodeURIComponent(customProviderMatch[1] ?? "");
    if (method === "PUT") {
      const body = await readJsonBody(req);
      const provider = body["provider"];
      if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
        throw new BusinessError("INVALID_REQUEST", "请求体必须包含对象字段 provider");
      }
      if ((provider as Record<string, unknown>)["id"] !== id) {
        throw new BusinessError("INVALID_REQUEST", "路径中的 id 与 provider.id 不一致");
      }
      const apiKeyField = body["apiKey"];
      if (apiKeyField !== undefined && typeof apiKeyField !== "string") {
        throw new BusinessError("INVALID_REQUEST", "字段 apiKey 必须是字符串");
      }
      const result = await service.saveCustomProvider(provider, typeof apiKeyField === "string" ? apiKeyField : undefined);
      sendJson(res, 200, result);
      return true;
    }
    if (method === "DELETE") {
      const settings = await service.deleteCustomProvider(id);
      sendJson(res, 200, { settings });
      return true;
    }
    res.setHeader("Allow", "PUT, DELETE");
    sendJson(res, 405, { status: "method_not_allowed", method });
    return true;
  }

  // 不匹配的子路径（如 GET /api/settings/model/key）：交给上层 404
  if (pathname === "/api/settings/model/key" || pathname === "/api/settings/model/options" || pathname === "/api/settings/model/test") {
    res.setHeader("Allow", pathname === "/api/settings/model/key" ? "DELETE" : pathname === "/api/settings/model/options" ? "GET" : "POST");
    sendJson(res, 405, { status: "method_not_allowed", method });
    return true;
  }
  return false;
}

/** /api/projects/:id/{sources|evidence|feasibility|citation-*|manuscript|context|review*|quality-gate|build|import} */
async function handleProjectResourceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  url: URL,
  stack: ServiceStack,
  importer?: LatexImporter,
  orchestrator?: WorkflowOrchestrator,
): Promise<boolean> {
  const base = /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/([a-z-]+)(\/.*)?$/.exec(pathname);
  if (base === null) {
    return false;
  }
  const projectId = base[1] ?? "";
  const resource = base[2] ?? "";
  const rest = base[3] ?? "";

  // ---- sources ----
  if (resource === "sources") {
    if (rest === "") {
      if (method === "POST") {
        const { body, fileName, content } = await readUploadBody(req, MAX_SOURCE_UPLOAD_BODY_BYTES);
        const sourceRole = readSourceRole(body);
        const item = await stack.sources.add(projectId, {
          fileName,
          content,
          ...(sourceRole !== undefined ? { sourceRole } : {}),
          metadata: readSourceMetadata(body),
          ...(body["preferred"] === true ? { preferred: true } : {}),
        });
        // PDF 自动跑确定性文本层分析；分析失败不影响上传成功（原始文件已落盘）
        let source = item;
        if (item.fileName.toLowerCase().endsWith(".pdf")) {
          try {
            const analysis = await stack.pdfAnalyzer.analyzeFile(
              await stack.sources.filePath(projectId, item.sourceId),
            );
            source = await stack.sources.setAnalysis(projectId, item.sourceId, analysis);
          } catch (error) {
            console.error(`[http] 文献 ${item.sourceId} 自动分析失败（不影响上传）:`, errorText(error));
          }
        }
        sendJson(res, 201, { source });
        return true;
      }
      if (method === "GET") {
        const items = await stack.sources.list(projectId);
        sendJson(res, 200, { sources: items });
        return true;
      }
      res.setHeader("Allow", "GET, POST");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return true;
    }

    const itemMatch = /^\/([A-Z]\d{2,})$/.exec(rest);
    if (itemMatch) {
      const sourceId = itemMatch[1] ?? "";
      if (method === "GET") {
        const item = await stack.sources.getRequired(projectId, sourceId);
        sendJson(res, 200, { source: item });
        return true;
      }
      if (method === "PATCH") {
        const body = await readJsonBody(req);
        const sourceRole = readSourceRole(body);
        const item = await stack.sources.update(projectId, sourceId, {
          ...(sourceRole !== undefined ? { sourceRole } : {}),
          ...(typeof body["preferred"] === "boolean" ? { preferred: body["preferred"] } : {}),
          metadata: readSourceMetadata(body),
        });
        sendJson(res, 200, { source: item });
        return true;
      }
      if (method === "DELETE") {
        await stack.sources.remove(projectId, sourceId);
        sendJson(res, 200, { status: "deleted", sourceId });
        return true;
      }
      res.setHeader("Allow", "GET, PATCH, DELETE");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return true;
    }

    const analyzeMatch = /^\/([A-Z]\d{2,})\/analyze$/.exec(rest);
    if (analyzeMatch) {
      if (method !== "POST") {
        sendMethodNotAllowed(res, "POST", method);
        return true;
      }
      const sourceId = analyzeMatch[1] ?? "";
      const body = await readOptionalJsonBody(req);
      const mode = body["mode"] === "multimodal" ? "multimodal" : "builtin";
      const path = await stack.sources.filePath(projectId, sourceId);
      const analysis =
        mode === "multimodal"
          ? await new AgentMultimodalAnalyzer({
              runtime: stack.runtime,
              agentId: stack.agentIds.researcher,
            }).analyzeReferencePaper({
              projectId,
              absolutePath: path,
            })
          : await stack.pdfAnalyzer.analyzeFile(path);
      const updated = await stack.sources.setAnalysis(projectId, sourceId, analysis);
      sendJson(res, 200, { source: updated });
      return true;
    }
    return false;
  }

  // ---- evidence ----
  if (resource === "evidence") {
    if (rest === "") {
      if (method === "GET") {
        const status = url.searchParams.get("status");
        const sourceId = url.searchParams.get("sourceId");
        const section = url.searchParams.get("section");
        const filter = {
          ...(status !== null ? { status: requireEnumParam(status, VERIFICATION_STATUSES, "status") } : {}),
          ...(sourceId !== null ? { sourceId } : {}),
          ...(section !== null ? { section } : {}),
        };
        const records = Object.keys(filter).length
          ? await stack.evidence.query(projectId, filter)
          : await stack.evidence.list(projectId);
        sendJson(res, 200, { evidence: records });
        return true;
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const claim = readStringField(body, "claim");
        if (claim === undefined) {
          throw new BusinessError("INVALID_REQUEST", "请求体必须包含非空字符串字段 claim");
        }
        // source / location 的字段级校验在 EvidenceStore.append 内完成，这里只保证是对象
        const source = body["source"];
        const location = body["location"];
        const record = await stack.evidence.append(
          projectId,
          {
            claim,
            ...(typeof body["summary"] === "string" ? { summary: body["summary"] } : {}),
            ...(typeof body["quote"] === "string" ? { quote: body["quote"] } : {}),
            ...(isRecord(source) ? { source: source as EvidenceSourceRef } : {}),
            ...(isRecord(location) ? { location: location as EvidenceLocation } : {}),
          },
          "user",
        );
        sendJson(res, 201, { evidence: record });
        return true;
      }
      res.setHeader("Allow", "GET, POST");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return true;
    }

    const evidenceMatch = /^\/([A-Z]\d{2,})(\/verify)?$/.exec(rest);
    if (evidenceMatch) {
      const evidenceId = evidenceMatch[1] ?? "";
      const isVerify = evidenceMatch[2] === "/verify";
      if (!isVerify) {
        if (method !== "GET") {
          sendMethodNotAllowed(res, "GET", method);
          return true;
        }
        const record = await stack.evidence.get(projectId, evidenceId);
        if (record === null) {
          throw new NotFoundError("Evidence", evidenceId);
        }
        sendJson(res, 200, { evidence: record });
        return true;
      }
      if (method !== "POST") {
        sendMethodNotAllowed(res, "POST", method);
        return true;
      }
      const body = await readJsonBody(req);
      const status = readStringField(body, "verificationStatus");
      if (status === undefined) {
        throw new BusinessError("INVALID_REQUEST", "请求体必须包含 verificationStatus");
      }
      const record = await stack.evidence.updateVerification(projectId, evidenceId, {
        verificationStatus: requireEnumField(status, VERIFICATION_STATUSES, "verificationStatus"),
        ...(typeof body["verificationMethod"] === "string"
          ? { verificationMethod: body["verificationMethod"] }
          : {}),
        ...(typeof body["verificationLevel"] === "string"
          ? { verificationLevel: requireEnumField(body["verificationLevel"], VERIFICATION_LEVELS, "verificationLevel") }
          : {}),
        ...(typeof body["supportStrength"] === "string"
          ? { supportStrength: requireEnumField(body["supportStrength"], SUPPORT_STRENGTHS, "supportStrength") }
          : {}),
      });
      sendJson(res, 200, { evidence: record });
      return true;
    }
    return false;
  }

  // ---- citations（PDF 引用完整性） ----
  if (resource === "citations") {
    if (rest === "/extract" && method === "POST") {
      const body = await readOptionalJsonBody(req);
      const { result, reused } = await stack.citationIntegrity.extract(projectId, {
        ...(body["force"] === true ? { force: true } : {}),
      });
      sendJson(res, 200, {
        summary: {
          referenceCount: result.references.length,
          calloutCount: result.callouts.length,
        },
        reused,
        notes: result.notes,
        references: result.references,
        callouts: result.callouts,
      });
      return true;
    }
    if (rest === "/verify-metadata" && method === "POST") {
      const body = await readOptionalJsonBody(req);
      const result = await stack.citationIntegrity.verifyMetadata(projectId, {
        ...(body["force"] === true ? { force: true } : {}),
      });
      sendJson(res, 200, {
        byStatus: result.byStatus,
        checked: result.checked,
        reused: result.reused,
        telemetry: result.telemetry,
        records: result.records,
      });
      return true;
    }
    if (rest === "/verify-claims" && method === "POST") {
      const body = await readOptionalJsonBody(req);
      const limit = readOptionalPositiveInt(body, "limit");
      const result = await stack.citationIntegrity.verifyClaims(projectId, {
        ...(body["force"] === true ? { force: true } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      sendJson(res, 200, {
        summary: result.summary,
        verified: result.verified,
        reused: result.reused,
        telemetry: result.telemetry,
        records: result.records,
      });
      return true;
    }
    if (rest === "/claims" && method === "GET") {
      const records = await stack.citationIntegrity.listClaimRecords(projectId);
      sendJson(res, 200, { records });
      return true;
    }
    if (rest === "/integrity" && method === "GET") {
      const report = await stack.citationIntegrity.integrityReport(projectId);
      sendJson(res, 200, { report });
      return true;
    }
    if (rest === "/metadata" && method === "GET") {
      const records = await stack.citationIntegrity.listMetadataRecords(projectId);
      sendJson(res, 200, { records });
      return true;
    }
    if (rest === "" && method === "GET") {
      const summary = await stack.citationIntegrity.summary(projectId);
      const references = await stack.paperStore.loadReferences<Record<string, unknown>>(projectId);
      sendJson(res, 200, { summary, references });
      return true;
    }
    return sendMethodNotAllowedIfKnown(res, method, rest, {
      "/extract": "POST",
      "/verify-metadata": "POST",
      "/verify-claims": "POST",
      "/claims": "GET",
      "/integrity": "GET",
      "/metadata": "GET",
      "": "GET",
    });
  }

  // ---- paper（Final PDF Review 输入） ----
  if (resource === "paper") {
    if (rest === "/pdf" && method === "POST") {
      const { fileName, content } = await readUploadBody(req, MAX_PAPER_UPLOAD_BODY_BYTES);
      const result = await stack.paperIngest.ingest(projectId, { fileName, content });
      sendJson(res, 201, {
        document: toPaperDocumentSummary(result.document),
        unchanged: result.unchanged,
      });
      return true;
    }
    if (rest === "/map") {
      if (method === "GET") {
        const map = await stack.paperStore.loadMap(projectId);
        sendJson(res, 200, { map });
        return true;
      }
      if (method === "POST") {
        const body = await readOptionalJsonBody(req);
        const refreshSummaries = body["refreshSummaries"] !== false;
        const map = await stack.paperMap.ensureMap(projectId, { refreshSummaries });
        sendJson(res, 200, { map });
        return true;
      }
      res.setHeader("Allow", "GET, POST");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return true;
    }
    if (rest === "/review-context" && method === "GET") {
      const sectionId = url.searchParams.get("sectionId");
      if (sectionId === null) {
        const scopes = await stack.reviewContext.listSectionScopes(projectId);
        sendJson(res, 200, { sections: scopes });
        return true;
      }
      const context = await stack.reviewContext.buildSectionContext(projectId, sectionId, {
        reviewSkill: url.searchParams.get("skill") ?? undefined,
      });
      sendJson(res, 200, {
        context: {
          contextScope: context.contextScope,
          sectionId: context.sectionId,
          sectionTitle: context.sectionTitle,
          budget: context.budget,
          prompt: context.prompt,
        },
      });
      return true;
    }
    if (rest === "/reparse" && method === "POST") {
      const document = await stack.paperIngest.reparse(projectId);
      sendJson(res, 200, { document: toPaperDocumentSummary(document) });
      return true;
    }
    if (rest === "/chunks") {
      if (method !== "GET") {
        res.setHeader("Allow", "GET");
        sendJson(res, 405, { status: "method_not_allowed", method });
        return true;
      }
      const sectionId = url.searchParams.get("sectionId");
      const chunks = await stack.paperStore.loadChunks(projectId);
      sendJson(res, 200, {
        chunks: sectionId === null ? chunks : chunks.filter((c) => c.sectionId === sectionId),
      });
      return true;
    }
    if (rest === "") {
      if (method !== "GET") {
        res.setHeader("Allow", "GET");
        sendJson(res, 405, { status: "method_not_allowed", method });
        return true;
      }
      const document = await stack.paperStore.loadDocument(projectId);
      if (document === null) {
        sendJson(res, 200, {
          document: null,
          stages: await stack.paperIngest.getStageSummary(projectId),
          note: "尚未上传 Final PDF（POST /api/projects/:id/paper/pdf）",
        });
        return true;
      }
      sendJson(res, 200, {
        document: toPaperDocumentSummary(document),
        sections: document.sections,
        stages: await stack.paperIngest.getStageSummary(projectId),
      });
      return true;
    }
    return sendMethodNotAllowedIfKnown(res, method, rest, {
      "/pdf": "POST",
      "/review-context": "GET",
      "/reparse": "POST",
    });
  }

  // ---- paper-review（existing_paper_review 聚合报告） ----
  if (resource === "paper-review") {
    if (rest === "") {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET", method);
        return true;
      }
      const report = await stack.reviewArtifacts.latestExistingReview(projectId);
      sendJson(res, 200, { report });
      return true;
    }
    // GET /paper-review/export.md —— Markdown 报告下载（与 Web UI 同源的结构化数据）
    if (rest === "/export.md") {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET", method);
        return true;
      }
      const report = await stack.reviewArtifacts.latestExistingReview(projectId);
      if (report === null) {
        // 明确 404：不导出空文件（先运行快速 Review）
        throw new NotFoundError("Review 报告（先运行快速 Review）", projectId);
      }
      const [project, document, references, metadataRecords, claims, callouts, gate, runs] = await Promise.all([
        stack.projects.getRequired(projectId),
        stack.paperStore.loadDocument(projectId),
        stack.paperStore.loadReferences<Record<string, unknown>>(projectId),
        stack.citationIntegrity.listMetadataRecords(projectId),
        stack.citationIntegrity.listClaimRecords(projectId),
        stack.paperStore.loadCallouts<Record<string, unknown>>(projectId),
        readLatestQualityGate(stack, projectId),
        orchestrator?.listRuns(projectId) ?? Promise.resolve([]),
      ]);
      const reviewRun = runs
        .filter((run) => run.workflowKind === "existing_paper_review")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const exporter = new ReviewReportExporter();
      const result = exporter.export({
        report: report as never,
        // 报告按轮记录模式：off 轮不展示历史 claim records（按轮隔离）
        citationSemanticMode: isCitationSemanticMode(report["citationSemanticMode"])
          ? report["citationSemanticMode"]
          : undefined,
        project: { title: project.title },
        document:
          document !== null
            ? {
                originalFileName: document.originalFileName,
                pageCount: document.parse.pageCount,
                parse: document.parse,
                sections: document.sections.map((s) => ({ sectionId: s.sectionId, title: s.title })),
              }
            : null,
        references: references as never[],
        metadataRecords,
        claims,
        calloutCount: callouts.length,
        run:
          reviewRun !== undefined
            ? {
                runId: reviewRun.runId,
                status: reviewRun.status,
                ...(reviewRun.startedAt !== undefined ? { startedAt: reviewRun.startedAt } : {}),
                ...(reviewRun.finishedAt !== undefined ? { finishedAt: reviewRun.finishedAt } : {}),
                stageHistory: reviewRun.stageHistory.map((stage) => ({
                  stageId: stage.stageId,
                  status: stage.status,
                  startedAt: stage.startedAt,
                  finishedAt: stage.finishedAt,
                })),
              }
            : null,
        gate,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", contentDisposition(result.fileName));
      res.end(result.markdown);
      return true;
    }
    return false;
  }

  // ---- feasibility / citation / manuscript / context ----
  if (rest !== "") {
    return false;
  }
  if (resource === "feasibility" && method === "GET") {
    const report = await readFeasibilityReport(stack.projects, projectId);
    if (report === null) {
      sendJson(res, 200, { feasibility: null, note: "尚未评估（先运行 idea_to_paper workflow）" });
      return true;
    }
    sendJson(res, 200, { feasibility: report });
    return true;
  }
  if (resource === "citation-check" && method === "POST") {
    const report = await stack.citation.verify(projectId);
    sendJson(res, 200, { report });
    return true;
  }
  if (resource === "citation-report" && method === "GET") {
    const report = await stack.citation.latestReport(projectId);
    sendJson(res, 200, { report });
    return true;
  }
  if (resource === "manuscript" && method === "GET") {
    const outline = await stack.manuscript.loadOutline(projectId);
    const sections = await stack.manuscript.sectionStatuses(projectId);
    sendJson(res, 200, { outline, sections });
    return true;
  }
  if (resource === "context" && method === "GET") {
    const rebuild = url.searchParams.get("rebuild") === "true";
    if (rebuild) {
      const evidenceStats = await stack.evidence.stats(projectId);
      const content = await stack.manuscript.rebuildContext(projectId, { evidenceStats });
      sendJson(res, 200, { context: content, rebuilt: true });
      return true;
    }
    try {
      const content = await readFile(stack.manuscript.contextPath(projectId), "utf8");
      sendJson(res, 200, { context: content, rebuilt: false });
    } catch {
      const evidenceStats = await stack.evidence.stats(projectId);
      const content = await stack.manuscript.rebuildContext(projectId, { evidenceStats });
      sendJson(res, 200, { context: content, rebuilt: true });
    }
    return true;
  }

  // ---- review / quality-gate / build / import ----

  if (resource === "review" || resource === "reviews") {
    if (method === "POST") {
      // 独立全面审稿：三路并行 + 确定性聚合（同 workflow 内的 review.run）
      const digest = await buildReviewDigest(stack, projectId);
      const evidence = await stack.evidence.list(projectId);
      const project = await stack.projects.getRequired(projectId);
      const citation = await stack.citation.latestReport(projectId);
      const results = await stack.reviewer.reviewAll({
        projectId,
        manuscriptDigest: digest,
        evidence: evidence.slice(0, 20),
        targetProfile: project.targetProfile,
        ...(citation
          ? {
              citationDigest: `cited=${citation.summary.citedCount} missing=${citation.summary.missingKeys} hallucinated=${citation.summary.hallucinated}`,
            }
          : {}),
      });
      const round = await stack.reviewArtifacts.nextSummaryRound(projectId);
      const reportPaths: string[] = [];
      for (const result of results) {
        reportPaths.push(await stack.reviewer.saveReport(projectId, round, result));
      }
      const summary = aggregateReviews(results, round, reportPaths);
      await stack.reviewArtifacts.saveSummary(projectId, round, summary);
      sendJson(res, 200, { summary });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, { reviews: await stack.reviewArtifacts.listSummaries(projectId) });
      return true;
    }
    res.setHeader("Allow", "GET, POST");
    sendJson(res, 405, { status: "method_not_allowed", method });
    return true;
  }

  if (resource === "quality-gate" && method === "POST") {
    // 从最新 artifacts 确定性评估（缺 review 时如实报错）
    const summary = await stack.reviewArtifacts.latestSummary(projectId);
    if (summary === null) {
      throw new BusinessError("INVALID_REQUEST", "尚无 review 结果（先执行 review 或 workflow）");
    }
    const citation = await stack.citation.latestReport(projectId);
    const evidence = await stack.evidence.stats(projectId);
    const feasibility = (await readFeasibilityReport(stack.projects, projectId))?.report ?? null;
    const gate = evaluateQualityGate(
      { review: summary, citation, evidence, feasibility },
      {
        academicPassScore: stack.workflowServices.review.academicPassScore,
        styleRiskMax: stack.workflowServices.review.styleRiskMax,
        requireFeasibility: true,
      },
    );
    await saveQualityGateReport(stack.projects, projectId, summary.round, gate, summary);
    sendJson(res, 200, { gate });
    return true;
  }

  if (resource === "build" && method === "POST") {
    // Build Gate + Draft PDF（质量语义不影响构建）
    const { build, compile } = await runBuildGate(stack.projects, stack.latex, projectId);
    sendJson(res, 200, {
      build,
      compile: {
        ok: compile.ok,
        tool: compile.tool,
        durationMs: compile.durationMs,
        ...(compile.pdfPath !== null ? { pdfPath: "build/paper.pdf" } : {}),
        ...(compile.logPath !== null ? { logPath: "build/compile.log" } : {}),
        ...(compile.error !== undefined ? { error: compile.error } : {}),
      },
    });
    return true;
  }

  if (resource === "import") {
    if (importer === undefined) {
      sendJson(res, 503, { status: "unavailable", detail: "LaTeX 导入器未配置" });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req, MAX_SOURCE_UPLOAD_BODY_BYTES);
      const files = body["files"];
      let report;
      if (body["archiveBase64"] !== undefined) {
        const archive = readBase64Field(body, "archiveBase64");
        report = await importer.importFromArchive(projectId, archive);
      } else if (Array.isArray(files)) {
        report = await importer.importFromFiles(projectId, files as never);
      } else {
        throw new BusinessError("INVALID_REQUEST", "请求体必须包含 archiveBase64 或 files");
      }
      sendJson(res, 200, { report });
      return true;
    }
    if (method === "GET") {
      try {
        const report = JSON.parse(
          await readFile(
            join(stack.projects.projectDir(projectId), "workflow", "import-report.json"),
            "utf8",
          ),
        );
        sendJson(res, 200, { report });
      } catch {
        sendJson(res, 200, { report: null, note: "尚未导入（POST archiveBase64 或 files）" });
      }
      return true;
    }
    res.setHeader("Allow", "GET, POST");
    sendJson(res, 405, { status: "method_not_allowed", method });
    return true;
  }

  return false;
}

/** PaperDocument 摘要（HTTP 响应不携带 pages/chunks 全文，明细走 /chunks 端点） */
function toPaperDocumentSummary(document: {
  projectId: string;
  documentId: string;
  title?: string;
  originalFileName: string;
  bytes: number;
  sha256: string;
  parse: { pageCount: number; extractionQuality: string; parsedAt: string; parserId: string; durationMs: number };
  sections: unknown[];
  chunks: unknown[];
  abstractSectionId?: string;
  referencesSectionId?: string;
  ingestedAt: string;
}): Record<string, unknown> {
  return {
    projectId: document.projectId,
    documentId: document.documentId,
    ...(document.title !== undefined ? { title: document.title } : {}),
    originalFileName: document.originalFileName,
    bytes: document.bytes,
    sha256: document.sha256.slice(0, 12),
    parse: document.parse,
    pageCount: document.parse.pageCount,
    sectionCount: document.sections.length,
    chunkCount: document.chunks.length,
    ...(document.abstractSectionId !== undefined
      ? { abstractSectionId: document.abstractSectionId }
      : {}),
    ...(document.referencesSectionId !== undefined
      ? { referencesSectionId: document.referencesSectionId }
      : {}),
    ingestedAt: document.ingestedAt,
  };
}

/** 审稿用稿件摘要（main + sections 截断） */
async function buildReviewDigest(stack: ServiceStack, projectId: string): Promise<string> {
  const files = await collectLatexFiles(stack.projects.manuscriptDir(projectId));
  const parts: string[] = [];
  if (files.mainTex !== null) {
    parts.push(`[main.tex]\n${files.mainTex.content.slice(0, 2000)}`);
  }
  for (const section of files.sections.slice(0, 15)) {
    parts.push(`[${section.relativePath}]\n${section.content.slice(0, 2500)}`);
  }
  if (parts.length === 0) {
    throw new BusinessError("INVALID_REQUEST", "manuscript 目录没有任何 .tex 文件");
  }
  return parts.join("\n\n").slice(0, 40_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 最新 Quality Gate 报告（quality-gate-r*.json；无则 null——快速 Review 默认不含 Gate） */
async function readLatestQualityGate(
  stack: ServiceStack,
  projectId: string,
): Promise<{ passed: boolean; reasons: string[]; rules: Array<{ rule: string; passed: boolean; detail: string }> } | null> {
  let names: string[];
  try {
    names = await readdir(stack.projects.reviewsDir(projectId));
  } catch {
    return null;
  }
  const rounds = names
    .map((name) => /^quality-gate-r(\d+)\.json$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a);
  const latest = rounds[0];
  if (latest === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      await readFile(join(stack.projects.reviewsDir(projectId), `quality-gate-r${latest}.json`), "utf8"),
    ) as { gate?: { passed?: unknown; reasons?: unknown; rules?: unknown } };
    const gate = parsed.gate;
    if (gate === undefined || typeof gate.passed !== "boolean" || !Array.isArray(gate.reasons)) {
      return null;
    }
    return {
      passed: gate.passed,
      reasons: gate.reasons.filter((r): r is string => typeof r === "string"),
      rules: (Array.isArray(gate.rules) ? gate.rules : []).filter(isRecord).map((rule) => ({
        rule: String(rule["rule"] ?? ""),
        passed: rule["passed"] === true,
        detail: String(rule["detail"] ?? ""),
      })),
    };
  } catch {
    return null;
  }
}

/** 读取创建/更新项目时的研究定位字段 */
function readResearchMeta(body: Record<string, unknown>, forPatch = false): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const stringFields = [
    "researchIdea",
    "researchField",
    "documentType",
    "targetProfile",
    "targetVenue",
    "language",
  ];
  for (const field of stringFields) {
    const value = body[field];
    if (typeof value === "string" && value.trim() !== "") {
      meta[field] = value;
    } else if (forPatch && typeof value === "string") {
      meta[field] = value; // PATCH 允许空串清除（ProjectStore 归一化为不设置）
    }
  }
  const workflowKind = body["workflowKind"];
  if (isWorkflowKind(workflowKind)) {
    meta["workflowKind"] = workflowKind;
  } else if (workflowKind !== undefined) {
    throw new BusinessError("INVALID_REQUEST", `workflowKind 只能是 ${WORKFLOW_KINDS.join("、")}`);
  }
  return meta;
}

function readSourceRole(body: Record<string, unknown>): "evidence" | "reference" | "both" | undefined {
  const value = body["sourceRole"];
  if (value === undefined) {
    return undefined;
  }
  if (value === "evidence" || value === "reference" || value === "both") {
    return value;
  }
  throw new BusinessError("INVALID_REQUEST", "sourceRole 只能是 evidence / reference / both");
}

function readSourceMetadata(body: Record<string, unknown>): {
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  url?: string;
  venue?: string;
} {
  const metadata: Record<string, unknown> = {};
  for (const field of ["title", "doi", "url", "venue"] as const) {
    const value = body[field];
    if (typeof value === "string" && value.trim() !== "") {
      metadata[field] = value;
    }
  }
  if (Array.isArray(body["authors"]) && body["authors"].every((a) => typeof a === "string")) {
    metadata["authors"] = body["authors"];
  }
  if (typeof body["year"] === "number" && Number.isInteger(body["year"])) {
    metadata["year"] = body["year"];
  }
  return metadata;
}

// ---- SSE：WorkflowRun 进度（Domain Event replay + 实时推送） ----

async function handleRunEventsSse(
  req: IncomingMessage,
  res: ServerResponse,
  orchestrator: WorkflowOrchestrator,
  runId: string,
): Promise<void> {
  // 先订阅再 replay：replay 期间新到的事件进缓冲，按 seq 去重后补发，
  // 保证「已有事件 replay + 实时事件」无缝且不重不漏。
  const buffered: WorkflowDomainEvent[] = [];
  let replayDone = false;
  let lastSeq = 0;
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  // 客户端可能在 subscribe / readEvents 的 await 期间断开：清理逻辑必须在第一个 await 之前挂好，
  // 否则心跳定时器与编排器监听器会一直挂着
  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat !== null) {
      clearInterval(heartbeat);
    }
    unsubscribe?.();
    unsubscribe = null;
  };
  req.on("close", cleanup);
  res.on("close", cleanup);

  const send = (event: WorkflowDomainEvent) => {
    if (!closed && event.seq > lastSeq) {
      lastSeq = event.seq;
      writeSseEvent(res, event);
    }
  };

  try {
    // run 不存在时 subscribe 抛 WORKFLOW_NOT_FOUND（headers 未发送，安全映射 404）
    unsubscribe = await orchestrator.subscribe(runId, (event) => {
      if (closed) {
        return;
      }
      if (replayDone) {
        send(event);
      } else {
        buffered.push(event);
      }
    });
    if (closed) {
      cleanup();
      unsubscribe?.();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const { events, skippedLines } = await orchestrator.readEvents(runId);
    for (const event of events) {
      send(event);
    }
    if (!closed) {
      res.write(
        skippedLines > 0
          ? `: replay 完成（${events.length} 条事件，${skippedLines} 行损坏已跳过）\n\n`
          : `: replay 完成（${events.length} 条事件）\n\n`,
      );
    }
    replayDone = true;
    buffered.sort((a, b) => a.seq - b.seq);
    for (const event of buffered) {
      send(event);
    }
    if (closed) {
      return;
    }

    // 心跳：保活 + 代理缓冲提示；连接断开由 cleanup 收尾（不影响 workflow 执行）
    heartbeat = setInterval(() => {
      if (!closed) {
        res.write(": ping\n\n");
      }
    }, SSE_HEARTBEAT_MS);
  } catch (error) {
    cleanup();
    throw error;
  }
}

function writeSseEvent(res: ServerResponse, event: WorkflowDomainEvent): void {
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

// ---- 请求体与字段解析 ----

/** 读取并解析 JSON 请求体；非法 JSON / 超限抛 INVALID_REQUEST */
async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > maxBytes) {
      throw new BusinessError("INVALID_REQUEST", `请求体超过 ${maxBytes} 字节上限`);
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    throw new BusinessError("INVALID_REQUEST", "请求体不能为空（需要 JSON 对象）");
  }
  return parseJsonObject(text);
}

/**
 * 可选请求体：空 body 视为 {}；非空则必须是合法 JSON 对象（解析错误 / 超限如实报 400，
 * 不能把 `{"force": tru` 静默当成没有参数）。
 */
async function readOptionalJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new BusinessError("INVALID_REQUEST", `请求体超过 ${MAX_BODY_BYTES} 字节上限`);
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    return {};
  }
  return parseJsonObject(text);
}

function parseJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BusinessError("INVALID_REQUEST", "请求体不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BusinessError("INVALID_REQUEST", "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * base64 字段 → Buffer。Buffer.from(str, "base64") 从不抛错、会静默丢弃非法字符，
 * 所以必须先校验字符集，否则损坏的上传会变成一份"看起来解析失败"的乱码文件。
 */
function readBase64Field(body: Record<string, unknown>, field: string): Buffer {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BusinessError("INVALID_REQUEST", `请求体必须包含非空字符串字段 ${field}`);
  }
  const compact = value.replace(/\s+/g, "");
  if (!BASE64_PATTERN.test(compact)) {
    throw new BusinessError("INVALID_REQUEST", `${field} 不是合法 base64`);
  }
  const content = Buffer.from(compact, "base64");
  if (content.byteLength === 0) {
    throw new BusinessError("INVALID_REQUEST", `${field} 解码后为空`);
  }
  return content;
}

/** 文件上传请求体（{fileName, contentBase64, …}）的公共解析 */
async function readUploadBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ body: Record<string, unknown>; fileName: string; content: Buffer }> {
  const body = await readJsonBody(req, maxBytes);
  const fileName = readStringField(body, "fileName");
  if (fileName === undefined) {
    throw new BusinessError("INVALID_REQUEST", "请求体必须包含 fileName 与 contentBase64");
  }
  return { body, fileName, content: readBase64Field(body, "contentBase64") };
}

function readStringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** 可选正整数字段（缺省 undefined；非正整数 → 400） */
function readOptionalPositiveInt(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new BusinessError("INVALID_REQUEST", `字段 ${field} 必须是正整数`);
  }
  return value;
}

function requireEnumField<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new BusinessError("INVALID_REQUEST", `字段 ${field} 只能是 ${allowed.join(" / ")}`);
}

function requireEnumParam<T extends string>(value: string, allowed: readonly T[], param: string): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new BusinessError("INVALID_REQUEST", `查询参数 ${param} 只能是 ${allowed.join(" / ")}`);
}

function readPayloadField(
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BusinessError("INVALID_REQUEST", `字段 ${field} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function readWorkflowKind(body: Record<string, unknown>): WorkflowKind {
  const kind = body["kind"];
  if (kind === undefined) {
    return "idea_to_paper";
  }
  if (isWorkflowKind(kind)) {
    return kind;
  }
  throw new BusinessError(
    "INVALID_REQUEST",
    `字段 kind 只能是 ${WORKFLOW_KINDS.join("、")}（缺省 idea_to_paper）`,
  );
}

/** 语义核验模式（existing_paper_review 专用）：非法值 400；缺省 off（新 run 默认关闭） */
function readCitationSemanticMode(body: Record<string, unknown>): CitationSemanticMode {
  const value = body["citationSemanticMode"];
  if (value === undefined) {
    return DEFAULT_CITATION_SEMANTIC_MODE;
  }
  if (isCitationSemanticMode(value)) {
    return value;
  }
  throw new BusinessError(
    "INVALID_REQUEST",
    `字段 citationSemanticMode 只能是 ${CITATION_SEMANTIC_MODES.join("、")}（缺省 ${DEFAULT_CITATION_SEMANTIC_MODE}）`,
  );
}

/** PATCH 请求体中的可选 title（重命名；非字符串或空串视为不修改） */
function readOptionalTitle(body: Record<string, unknown>): string | undefined {
  const value = body["title"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * 永久删除项目（仅已归档；无进行中任务）：
 * 前置校验 → 释放 Runtime 内该项目的 idle Agent Session → 删除整个工作区目录。
 */
async function permanentlyDeleteProject(services: Services, projectId: string): Promise<void> {
  const project = await services.projects.getRequired(projectId);
  if (project.archivedAt === undefined) {
    throw new ProjectNotArchivedError(projectId);
  }
  if (await services.orchestrator.hasActiveRun(projectId)) {
    throw new ProjectBusyError("当前项目仍有进行中的任务，请先完成或取消任务后再删除。");
  }
  // Runtime 会话清理：Workspace 删除后进程内不能长期保留该论文上下文
  try {
    await services.runtime.releaseProjectSessions?.(projectId);
  } catch (error) {
    // 会话清理失败不阻塞删除（目录已是事实源的全部）；仅记录
    console.error(`[http] 释放项目 Runtime 会话失败（projectId=${projectId}）:`, error);
  }
  await services.projects.delete(projectId);
}

function sendBusinessError(res: ServerResponse, error: BusinessError): void {
  sendJson(res, error.httpStatus, {
    status: "error",
    error: {
      code: error.code,
      message: error.message,
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    },
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function sendMethodNotAllowed(res: ServerResponse, allowed: string, method: string): void {
  res.setHeader("Allow", allowed);
  sendJson(res, 405, { status: "method_not_allowed", method });
}

/**
 * 子路径已知但方法不对 → 405（带 Allow）；子路径未知 → 交给上层 404。
 * 用于 citations / paper 这类「一个资源前缀下多个动作」的路由组。
 */
function sendMethodNotAllowedIfKnown(
  res: ServerResponse,
  method: string,
  rest: string,
  allowedByPath: Record<string, string>,
): boolean {
  const allowed = allowedByPath[rest];
  if (allowed === undefined) {
    return false;
  }
  sendMethodNotAllowed(res, allowed, method);
  return true;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
