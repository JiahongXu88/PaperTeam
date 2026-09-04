import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, toBusinessError } from "./errors.js";
import type { GenerationService } from "./generation/GenerationService.js";
import type { LatexImporter } from "./import/LatexImporter.js";
import type { ProjectStore } from "./project/ProjectStore.js";
import type { AgentRuntime, RuntimeHealth } from "./runtime/types.js";
import type { RuntimeStatusService } from "./runtime/statusService.js";
import type { ServiceStack } from "./serviceStack.js";
import { AgentMultimodalAnalyzer } from "./sources/PdfAnalyzer.js";
import { readFeasibilityReport } from "./agents/FeasibilityService.js";
import { aggregateReviews, type ReviewSummary } from "./review/ReviewAggregator.js";
import {
  evaluateQualityGate,
  runBuildGate,
  saveQualityGateReport,
} from "./quality/gates.js";
import { collectLatexFiles } from "./manuscript/LatexFiles.js";
import { writeJsonAtomic } from "./util/atomic.js";
import type { WorkflowDomainEvent, WorkflowKind } from "./workflow/types.js";
import type { WorkflowOrchestrator } from "./workflow/WorkflowOrchestrator.js";

/**
 * Backend 自身的轻量 HTTP 服务（Node 原生 http，无 Web 框架）。
 *
 * M3 端点：
 *   GET    /health                                  存活探针（含 Pi Runtime 实时健康）
 *   POST   /api/projects                            创建论文项目 {title, researchIdea?, …}
 *   GET    /api/projects/:id                        查询项目元数据
 *   PATCH  /api/projects/:id                        更新研究定位字段
 *   POST   /api/projects/:id/generate               Writer 写作 + LaTeX 编译（M2 同步形态，保留兼容）
 *   POST   /api/projects/:id/workflows              创建异步 WorkflowRun {kind, prompt?} → {runId}
 *   GET    /api/runs?projectId=xxx                  项目 run 列表
 *   GET    /api/runs/:runId                         run 状态 / 当前 stage / 待办 / 错误
 *   GET    /api/runs/:runId/events                  SSE：Domain Event replay + 实时推送
 *   POST   /api/runs/:runId/resume                  提交 HITL 输入 {decision, payload?}
 *   POST   /api/runs/:runId/cancel                  取消 run
 *   POST   /api/projects/:id/sources                上传文献（JSON + base64；sourceRole）
 *   GET    /api/projects/:id/sources                文献列表
 *   GET    /api/projects/:id/sources/:sid           文献详情
 *   PATCH  /api/projects/:id/sources/:sid           更新 sourceRole / preferred / metadata
 *   DELETE /api/projects/:id/sources/:sid           删除文献
 *   POST   /api/projects/:id/sources/:sid/analyze   PDF 分析（builtin / multimodal）
 *   GET    /api/projects/:id/evidence               Evidence 列表（支持查询参数过滤）
 *   POST   /api/projects/:id/evidence               手工添加 Evidence
 *   POST   /api/projects/:id/evidence/:eid/verify   更新 Evidence 核验状态
 *   GET    /api/projects/:id/feasibility            最近一次可行性报告
 *   POST   /api/projects/:id/citation-check         执行引用核验（静态 + metadata）
 *   GET    /api/projects/:id/citation-report        最近一次引用核验报告
 *   GET    /api/projects/:id/manuscript             大纲 + 章节状态
 *   GET    /api/projects/:id/context                Derived Context（?rebuild=true 强制重建）
 */

/** 默认请求体大小上限（字节） */
const MAX_BODY_BYTES = 1024 * 1024;

/** 文献上传（base64 内容）请求体上限：原始 20MB × base64 膨胀 ≈ 28MB */
const MAX_UPLOAD_BODY_BYTES = 28 * 1024 * 1024;

/** SSE 心跳间隔（毫秒） */
const SSE_HEARTBEAT_MS = 15_000;

export interface BackendHttpServerOptions {
  runtime: AgentRuntime;
  projects: ProjectStore;
  generation: GenerationService;
  orchestrator: WorkflowOrchestrator;
  /** M3.1 业务服务栈（文献 / Evidence / 引用 / 手稿） */
  stack?: ServiceStack;
  /** M3.2 Existing-LaTeX 导入器 */
  importer?: LatexImporter;
  /** M3.5 Runtime 状态诊断（GET /api/runtime/status） */
  runtimeStatus?: RuntimeStatusService;
}

export function createBackendHttpServer({
  runtime,
  projects,
  generation,
  orchestrator,
  stack,
  importer,
  runtimeStatus,
}: BackendHttpServerOptions): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res, { runtime, projects, generation, orchestrator, stack, importer, runtimeStatus }).catch(
      (error: unknown) => {
        const businessError = toBusinessError(error);
        if (businessError.code === "INTERNAL_ERROR") {
          console.error("[http] 未处理错误:", error);
        }
        if (!res.headersSent) {
          sendBusinessError(res, businessError);
        } else {
          res.end();
        }
      },
    );
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

  // ---- GET /api/runtime/status（M3.5 Runtime 诊断） ----
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

  // ---- /api/projects ----
  if (pathname === "/api/projects") {
    if (method !== "POST") {
      res.setHeader("Allow", "POST");
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

  // ---- /api/projects/:id（GET / PATCH） ----
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
      const project = await services.projects.updateMeta(projectId, readResearchMeta(body, true));
      sendJson(res, 200, { project });
      return;
    }
    res.setHeader("Allow", "GET, PATCH");
    sendJson(res, 405, { status: "method_not_allowed", method });
    return;
  }

  // ---- POST /api/projects/:id/generate（M2 同步形态，保留兼容） ----
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

  // ---- POST /api/projects/:id/workflows（M3.0：异步 WorkflowRun） ----
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
    const run = await services.orchestrator.createRun(projectId, kind, {
      ...(prompt !== undefined ? { prompt } : {}),
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

  // ---- M3.1/M3.2 资源路由（需要服务栈） ----
  if (services.stack !== undefined) {
    const handled = await handleProjectResourceRoutes(
      req,
      res,
      pathname,
      method,
      url,
      services.stack,
      services.importer,
    );
    if (handled) {
      return;
    }
  }

  sendJson(res, 404, { status: "not_found", path: pathname });
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
        const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES);
        const fileName = readStringField(body, "fileName");
        const contentBase64 = readStringField(body, "contentBase64");
        if (fileName === undefined || contentBase64 === undefined) {
          throw new BusinessError("INVALID_REQUEST", "请求体必须包含 fileName 与 contentBase64");
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentBase64, "base64");
        } catch {
          throw new BusinessError("INVALID_REQUEST", "contentBase64 不是合法 base64");
        }
        if (content.byteLength === 0) {
          throw new BusinessError("INVALID_REQUEST", "contentBase64 解码后为空");
        }
        const item = await stack.sources.add(projectId, {
          fileName,
          content,
          ...(readSourceRole(body) !== undefined ? { sourceRole: readSourceRole(body) } : {}),
          metadata: readSourceMetadata(body),
          ...(body["preferred"] === true ? { preferred: true } : {}),
        });
        // PDF 自动跑确定性分析（失败不阻塞上传）
        if (item.fileName.toLowerCase().endsWith(".pdf")) {
          try {
            const analysis = await stack.pdfAnalyzer.analyzeFile(
              await stack.sources.filePath(projectId, item.sourceId),
            );
            const updated = await stack.sources.setAnalysis(projectId, item.sourceId, analysis);
            sendJson(res, 201, { source: updated });
            return true;
          } catch {
            sendJson(res, 201, { source: item });
            return true;
          }
        }
        sendJson(res, 201, { source: item });
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
        const item = await stack.sources.update(projectId, sourceId, {
          ...(readSourceRole(body) !== undefined ? { sourceRole: readSourceRole(body)! } : {}),
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
    if (analyzeMatch && method === "POST") {
      const sourceId = analyzeMatch[1] ?? "";
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
      const mode = body["mode"] === "multimodal" ? "multimodal" : "builtin";
      const item = await stack.sources.getRequired(projectId, sourceId);
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
        const filter = {
          ...(url.searchParams.get("status") !== null
            ? { status: url.searchParams.get("status") as never }
            : {}),
          ...(url.searchParams.get("sourceId") !== null
            ? { sourceId: url.searchParams.get("sourceId") ?? undefined }
            : {}),
          ...(url.searchParams.get("section") !== null
            ? { section: url.searchParams.get("section") ?? undefined }
            : {}),
        };
        const records = Object.keys(filter).length
          ? await stack.evidence.query(projectId, filter)
          : await stack.evidence.list(projectId);
        sendJson(res, 200, { evidence: records });
        return true;
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const record = await stack.evidence.append(
          projectId,
          {
            claim: String(body["claim"] ?? ""),
            ...(typeof body["summary"] === "string" ? { summary: body["summary"] } : {}),
            ...(typeof body["quote"] === "string" ? { quote: body["quote"] } : {}),
            ...(isRecord(body["source"]) ? { source: body["source"] as never } : {}),
            ...(isRecord(body["location"]) ? { location: body["location"] as never } : {}),
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
      if (!isVerify && method === "GET") {
        const record = await stack.evidence.get(projectId, evidenceId);
        if (record === null) {
          throw new BusinessError("INVALID_REQUEST", `Evidence 不存在：${evidenceId}`);
        }
        sendJson(res, 200, { evidence: record });
        return true;
      }
      if (isVerify && method === "POST") {
        const body = await readJsonBody(req);
        const status = readStringField(body, "verificationStatus");
        if (status === undefined) {
          throw new BusinessError("INVALID_REQUEST", "请求体必须包含 verificationStatus");
        }
        const record = await stack.evidence.updateVerification(projectId, evidenceId, {
          verificationStatus: status as never,
          ...(typeof body["verificationMethod"] === "string"
            ? { verificationMethod: body["verificationMethod"] }
            : {}),
          ...(typeof body["verificationLevel"] === "string"
            ? { verificationLevel: body["verificationLevel"] as never }
            : {}),
          ...(typeof body["supportStrength"] === "string"
            ? { supportStrength: body["supportStrength"] as never }
            : {}),
        });
        sendJson(res, 200, { evidence: record });
        return true;
      }
      return false;
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

  // ---- M3.2：review / quality-gate / build / import ----

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
      const { readdir } = await import("node:fs/promises");
      let round = 1;
      try {
        const names = await readdir(stack.projects.reviewsDir(projectId));
        round =
          names
            .map((name) => /^review-summary-r(\d+)\.json$/.exec(name))
            .filter((match): match is RegExpExecArray => match !== null)
            .reduce((max, match) => Math.max(max, Number(match[1])), 0) + 1;
      } catch {
        // 无历史
      }
      const reportPaths: string[] = [];
      for (const result of results) {
        reportPaths.push(await stack.reviewer.saveReport(projectId, round, result));
      }
      const summary = aggregateReviews(results, round, reportPaths);
      await writeJsonAtomic(
        join(stack.projects.reviewsDir(projectId), `review-summary-r${round}.json`),
        summary,
      );
      sendJson(res, 200, { summary });
      return true;
    }
    if (method === "GET") {
      const { readdir } = await import("node:fs/promises");
      const summaries: unknown[] = [];
      try {
        const names = (await readdir(stack.projects.reviewsDir(projectId))).sort();
        for (const name of names) {
          if (/^review-summary-r\d+\.json$/.test(name)) {
            summaries.push(JSON.parse(await readFile(join(stack.projects.reviewsDir(projectId), name), "utf8")));
          }
        }
      } catch {
        // 无 reviews 目录
      }
      sendJson(res, 200, { reviews: summaries });
      return true;
    }
    res.setHeader("Allow", "GET, POST");
    sendJson(res, 405, { status: "method_not_allowed", method });
    return true;
  }

  if (resource === "quality-gate" && method === "POST") {
    // 从最新 artifacts 确定性评估（缺 review 时如实报错）
    const summary = await latestReviewSummaryFrom(stack, projectId);
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

  if (resource === "import" && importer !== undefined) {
    if (method === "POST") {
      const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES);
      const archiveBase64 = readStringField(body, "archiveBase64");
      const files = body["files"];
      let report;
      if (archiveBase64 !== undefined) {
        let archive: Buffer;
        try {
          archive = Buffer.from(archiveBase64, "base64");
        } catch {
          throw new BusinessError("INVALID_REQUEST", "archiveBase64 不是合法 base64");
        }
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

/** 最新 review 汇总（round 最大） */
async function latestReviewSummaryFrom(
  stack: ServiceStack,
  projectId: string,
): Promise<ReviewSummary | null> {
  const { readdir } = await import("node:fs/promises");
  try {
    const names = await readdir(stack.projects.reviewsDir(projectId));
    const rounds = names
      .map((name) => /^review-summary-r(\d+)\.json$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((a, b) => b - a);
    if (rounds.length === 0) {
      return null;
    }
    return JSON.parse(
      await readFile(
        join(stack.projects.reviewsDir(projectId), `review-summary-r${rounds[0]}.json`),
        "utf8",
      ),
    ) as ReviewSummary;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (workflowKind === "idea_to_paper" || workflowKind === "existing_paper_improvement") {
    meta["workflowKind"] = workflowKind;
  } else if (workflowKind !== undefined) {
    throw new BusinessError(
      "INVALID_REQUEST",
      "workflowKind 只能是 idea_to_paper 或 existing_paper_improvement",
    );
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
  // run 不存在时 subscribe 抛 WORKFLOW_NOT_FOUND（headers 未发送，安全映射 404）
  unsubscribe = await orchestrator.subscribe(runId, (event) => {
    if (closed) {
      return;
    }
    if (replayDone) {
      if (event.seq > lastSeq) {
        lastSeq = event.seq;
        writeSseEvent(res, event);
      }
    } else {
      buffered.push(event);
    }
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const { events, skippedLines } = await orchestrator.readEvents(runId);
  for (const event of events) {
    writeSseEvent(res, event);
    lastSeq = Math.max(lastSeq, event.seq);
  }
  if (skippedLines > 0) {
    res.write(`: replay 完成（${events.length} 条事件，${skippedLines} 行损坏已跳过）\n\n`);
  } else {
    res.write(`: replay 完成（${events.length} 条事件）\n\n`);
  }
  replayDone = true;
  // 补发订阅缓冲中比 replay 更新的事件（seq 去重）
  buffered.sort((a, b) => a.seq - b.seq);
  for (const event of buffered) {
    if (event.seq > lastSeq) {
      lastSeq = event.seq;
      writeSseEvent(res, event);
    }
  }

  // 心跳：保活 + 代理缓冲提示；连接断开时清理干净（不影响 workflow 执行）
  const heartbeat = setInterval(() => {
    if (closed) {
      return;
    }
    res.write(": ping\n\n");
  }, SSE_HEARTBEAT_MS);
  req.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
  });
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

function readStringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
  if (kind === "idea_to_paper" || kind === "existing_paper_improvement") {
    return kind;
  }
  throw new BusinessError(
    "INVALID_REQUEST",
    "字段 kind 只能是 idea_to_paper 或 existing_paper_improvement（缺省 idea_to_paper）",
  );
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
