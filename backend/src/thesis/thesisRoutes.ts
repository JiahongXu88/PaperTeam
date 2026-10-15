/**
 * M14.1c：/api/projects/:id/thesis/* 路由（从 httpServer 的资源分派器调用）。
 *
 * 端点：
 *   GET    /thesis/document           读取学位论文文档模型（无则 model=null）
 *   PUT    /thesis/document           保存模型（对当前 outline 校验）
 *   GET    /thesis/templates          已实现模板列表
 *   POST   /thesis/assemble           确定性装配 → manuscript-thesis/
 *   POST   /thesis/compile            编译装配产物（同步；学位论文预算最长 600s）
 *
 * M14.1c 范围：模型 / 装配 / 编译的稳定接口（为 M14.2 thesis_from_papers
 * 工作流预留）；不实现完整学位论文生成工作流。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { BusinessError } from "../errors.js";
import type { ManuscriptService } from "../manuscript/ManuscriptService.js";
import type { ThesisDocumentService } from "./ThesisDocumentService.js";
import { THESIS_TEMPLATE_ADAPTERS } from "./genericCtexbookAdapter.js";
import { THESIS_TEMPLATE_IDS, type ThesisDocumentModel } from "./thesisDocumentTypes.js";
import type { InheritedFigureAssetService } from "./inheritedFigureAssets.js";
import type { DecisionActor } from "./researchInputTypes.js";

export interface ThesisRouteDeps {
  service: ThesisDocumentService;
  manuscript: ManuscriptService;
  /** M14.3：图形资产继承（可选装配——缺省路由 404 语义） */
  figures?: InheritedFigureAssetService;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  sendMethodNotAllowed: (res: ServerResponse, allowed: string, method: string) => void;
}

export async function handleThesisRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  rest: string,
  method: string,
  deps: ThesisRouteDeps,
): Promise<boolean> {
  const { service, manuscript, readJsonBody, sendJson, sendMethodNotAllowed } = deps;

  if (rest === "/templates") {
    if (method !== "GET") {
      sendMethodNotAllowed(res, "GET", method);
      return true;
    }
    sendJson(res, 200, {
      templates: [...THESIS_TEMPLATE_ADAPTERS.values()].map((adapter) => ({
        templateId: adapter.templateId,
        defaultBibliography: adapter.defaultBibliography,
      })),
    });
    return true;
  }

  if (rest === "/document") {
    if (method === "GET") {
      sendJson(res, 200, { model: await service.loadModel(projectId) });
      return true;
    }
    if (method === "PUT") {
      const body = await readJsonBody(req);
      const model = body["model"];
      if (model === undefined || typeof model !== "object") {
        throw new BusinessError("INVALID_REQUEST", "请求体需要 model 字段（ThesisDocumentModel）");
      }
      const outline = await manuscript.loadOutline(projectId);
      if (outline === null) {
        throw new BusinessError("INVALID_REQUEST", "项目尚无 outline（先完成普通论文大纲，再映射学位论文章节）");
      }
      const saved = await service.saveModel(projectId, parseModel(model), outline);
      sendJson(res, 200, { model: saved });
      return true;
    }
    sendMethodNotAllowed(res, "GET, PUT", method);
    return true;
  }

  if (rest === "/assemble") {
    if (method !== "POST") {
      sendMethodNotAllowed(res, "POST", method);
      return true;
    }
    const outline = await manuscript.loadOutline(projectId);
    if (outline === null) {
      throw new BusinessError("INVALID_REQUEST", "项目尚无 outline");
    }
    const result = await service.assemble(projectId, outline);
    sendJson(res, 200, {
      bibliography: result.bibliography,
      chapters: result.chapters,
      transformedFiles: result.transformedFiles,
      mainTexChars: result.mainTex.length,
    });
    return true;
  }

  if (rest === "/compile") {
    if (method !== "POST") {
      sendMethodNotAllowed(res, "POST", method);
      return true;
    }
    const result = await service.compile(projectId);
    sendJson(res, 200, {
      ok: result.ok,
      tool: result.tool,
      durationMs: result.durationMs,
      pdfPath: result.pdfPath,
      logPath: result.logPath,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
    return true;
  }

  // ---- M14.3：研究成果图形资产继承（PlotSpec 确定性生成 + 作者授权 + 受控插入）----
  if (rest === "/figure-assets") {
    if (deps.figures === undefined) {
      return false;
    }
    const figures = deps.figures;
    if (method === "GET") {
      sendJson(res, 200, await figures.list(projectId));
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      const spec = body["spec"];
      if (spec === undefined || typeof spec !== "object") {
        throw new BusinessError("INVALID_REQUEST", "请求体需要 spec 字段（PlotSpec / DiagramSpec）");
      }
      const kind = body["kind"] === "diagram" ? "diagram" : "plot";
      const result = await figures.generateAndAuthorize(projectId, {
        sourceId: requireString(body, "sourceId"),
        blockId: requireString(body, "blockId"),
        kind,
        spec: spec as Record<string, unknown>,
        caption: requireString(body, "caption"),
        actor: readActor(body),
      });
      sendJson(res, 201, { asset: result.asset, cached: result.cached, ...(result.captionValidation !== undefined ? { captionValidation: result.captionValidation } : {}) });
      return true;
    }
    sendMethodNotAllowed(res, "GET, POST", method);
    return true;
  }
  const figureInsertMatch = /^\/figure-assets\/(fig-[0-9a-f]{12,64})\/insert$/.exec(rest);
  if (figureInsertMatch !== null && deps.figures !== undefined) {
    if (method !== "POST") {
      sendMethodNotAllowed(res, "POST", method);
      return true;
    }
    const body = await readJsonBody(req);
    const result = await deps.figures.insert(projectId, {
      figId: figureInsertMatch[1]!,
      sectionFile: requireString(body, "sectionFile"),
      ...(typeof body["caption"] === "string" ? { caption: body["caption"] } : {}),
      ...(typeof body["referenceSentence"] === "string" ? { referenceSentence: body["referenceSentence"] } : {}),
      actor: readActor(body),
    });
    sendJson(res, 200, { asset: result.asset, label: result.label, file: result.file });
    return true;
  }

  return false;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BusinessError("INVALID_REQUEST", `请求体需要非空字符串字段 ${field}`);
  }
  return value.trim();
}

function readActor(body: Record<string, unknown>): DecisionActor {
  const actorBody = typeof body["actor"] === "object" && body["actor"] !== null ? (body["actor"] as Record<string, unknown>) : {};
  return {
    kind: actorBody["kind"] === "test_fixture" ? "test_fixture" : "user",
    ...(typeof actorBody["id"] === "string" ? { id: actorBody["id"] } : {}),
    ...(typeof actorBody["note"] === "string" ? { note: actorBody["note"] } : {}),
  };
}

/** 入参基础校验（详细结构校验在 saveModel 的 validateThesisDocumentModel） */
function parseModel(raw: unknown): ThesisDocumentModel {
  const model = raw as ThesisDocumentModel;
  if (typeof model?.templateId !== "string" || !THESIS_TEMPLATE_IDS.includes(model.templateId)) {
    throw new BusinessError("INVALID_REQUEST", `templateId 只能是 ${THESIS_TEMPLATE_IDS.join(" / ")}`);
  }
  if (typeof model.titleZh !== "string") {
    throw new BusinessError("INVALID_REQUEST", "titleZh 必须是非空字符串");
  }
  if (!Array.isArray(model.chapters)) {
    throw new BusinessError("INVALID_REQUEST", "chapters 必须是数组");
  }
  return model;
}
