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

export interface ThesisRouteDeps {
  service: ThesisDocumentService;
  manuscript: ManuscriptService;
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

  return false;
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
