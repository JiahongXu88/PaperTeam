/**
 * M14.1b：/api/projects/:id/research-inputs 路由（从 httpServer 的资源分派器调用）。
 *
 * 作者决定端点的 actor 固定为 user（真实 HTTP 操作）；请求体中的 actor 字段只允许
 * 覆盖 id / note，不允许声明 test_fixture 以外的其它 kind——模型不能生成确认事件。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { BusinessError } from "../errors.js";
import type { ResearchInputService } from "./ResearchInputService.js";
import {
  AUTHOR_DECISION_TYPES,
  RESEARCH_INPUT_TYPES,
  VERSION_RELATION_KINDS,
  type AuthorDecisionPayload,
  type DecisionActor,
  type ResearchInputType,
} from "./researchInputTypes.js";

export interface ResearchInputRouteDeps {
  service: ResearchInputService;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  sendMethodNotAllowed: (res: ServerResponse, allowed: string, method: string) => void;
}

const INPUT_ID_RE = /^ri-[a-f0-9]{12}$/;

export async function handleResearchInputRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  rest: string,
  method: string,
  url: URL,
  deps: ResearchInputRouteDeps,
): Promise<boolean> {
  const { service, readJsonBody, sendJson, sendMethodNotAllowed } = deps;
  if (rest === "") {
    if (method === "GET") {
      const file = await service.list(projectId);
      sendJson(res, 200, { inputs: file.inputs, relations: file.relations, workGroups: file.workGroups, alignments: file.alignments });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      const sourceId = readString(body, "sourceId", true)!;
      const inputType = readString(body, "inputType", true)!;
      if (!RESEARCH_INPUT_TYPES.includes(inputType as ResearchInputType)) {
        throw new BusinessError("INVALID_REQUEST", `inputType 只能是 ${RESEARCH_INPUT_TYPES.join(" / ")}`);
      }
      const publicationStatus = body["publicationStatus"];
      const result = await service.register(
        projectId,
        {
          sourceId,
          inputType: inputType as ResearchInputType,
          ...(readString(body, "title") !== undefined ? { title: readString(body, "title")! } : {}),
          ...(readStringArray(body, "authors") !== undefined ? { authors: readStringArray(body, "authors")! } : {}),
          ...(readString(body, "providedBy") !== undefined ? { providedBy: readString(body, "providedBy")! } : {}),
          ...(readString(body, "provenanceUri") !== undefined ? { provenanceUri: readString(body, "provenanceUri")! } : {}),
          ...(readString(body, "doi") !== undefined ? { doi: readString(body, "doi")! } : {}),
          ...(readString(body, "arxivId") !== undefined ? { arxivId: readString(body, "arxivId")! } : {}),
          ...(readString(body, "versionLabel") !== undefined ? { versionLabel: readString(body, "versionLabel")! } : {}),
          ...(readString(body, "workId") !== undefined ? { workId: readString(body, "workId")! } : {}),
          ...(isRecord(publicationStatus) && typeof publicationStatus["value"] === "string"
            ? { publicationStatus: { value: publicationStatus["value"] as never, ...(typeof publicationStatus["asOf"] === "string" ? { asOf: publicationStatus["asOf"] } : {}) } }
            : {}),
        },
        { ensureParsed: body["ensureParsed"] === true },
      );
      sendJson(res, result.created ? 201 : 200, result);
      return true;
    }
    sendMethodNotAllowed(res, "GET, POST", method);
    return true;
  }
  if (rest === "/relations") {
    if (method !== "POST") {
      sendMethodNotAllowed(res, "POST", method);
      return true;
    }
    const body = await readJsonBody(req);
    const kind = readString(body, "kind", true)!;
    if (!VERSION_RELATION_KINDS.includes(kind as never)) {
      throw new BusinessError("INVALID_REQUEST", `kind 只能是 ${VERSION_RELATION_KINDS.join(" / ")}`);
    }
    const basis = readString(body, "basis") ?? "model_candidate";
    if (!["content_match", "title_similarity", "model_candidate"].includes(basis)) {
      throw new BusinessError("INVALID_REQUEST", "basis 只能是 content_match / title_similarity / model_candidate（元数据关系由系统在登记时自动建立，作者确认走 decisions）");
    }
    const relation = await service.registry.proposeRelation(projectId, {
      fromInputId: readString(body, "fromInputId", true)!,
      toInputId: readString(body, "toInputId", true)!,
      kind: kind as never,
      basis: basis as never,
      ...(readString(body, "evidence") !== undefined ? { evidence: readString(body, "evidence")! } : {}),
      proposedBy: basis === "model_candidate" ? "model" : "system",
    });
    sendJson(res, 201, { relation });
    return true;
  }
  if (rest === "/facts") {
    if (method !== "GET") {
      sendMethodNotAllowed(res, "GET", method);
      return true;
    }
    const inputId = url.searchParams.get("inputId");
    const verification = url.searchParams.get("verification");
    const conflictStatus = url.searchParams.get("conflictStatus");
    const facts = await service.facts.list(projectId, {
      ...(inputId !== null ? { researchInputId: inputId } : {}),
      ...(verification !== null ? { verification: verification as never } : {}),
      ...(conflictStatus !== null ? { conflictStatus: conflictStatus as never } : {}),
    });
    sendJson(res, 200, { facts });
    return true;
  }
  if (rest === "/conflicts") {
    if (method !== "GET") {
      sendMethodNotAllowed(res, "GET", method);
      return true;
    }
    const status = url.searchParams.get("status");
    sendJson(res, 200, { conflicts: await service.facts.listConflicts(projectId, status !== null ? (status as never) : undefined) });
    return true;
  }
  if (rest === "/conflicts/detect") {
    if (method !== "POST") {
      sendMethodNotAllowed(res, "POST", method);
      return true;
    }
    const body = await readJsonBody(req);
    const inputIds = readStringArray(body, "inputIds");
    sendJson(res, 200, await service.detectConflicts(projectId, inputIds !== undefined ? { inputIds } : {}));
    return true;
  }
  if (rest === "/decisions") {
    if (method === "GET") {
      sendJson(res, 200, { decisions: await service.decisions.list(projectId) });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      const payload = body["payload"];
      if (!isRecord(payload) || typeof payload["type"] !== "string" || !AUTHOR_DECISION_TYPES.includes(payload["type"] as never)) {
        throw new BusinessError("INVALID_REQUEST", `payload.type 只能是 ${AUTHOR_DECISION_TYPES.join(" / ")}`);
      }
      const actorBody = isRecord(body["actor"]) ? body["actor"] : {};
      const actor: DecisionActor = {
        kind: actorBody["kind"] === "test_fixture" ? "test_fixture" : "user",
        ...(typeof actorBody["id"] === "string" ? { id: actorBody["id"] } : {}),
        ...(typeof actorBody["note"] === "string" ? { note: actorBody["note"] } : {}),
      };
      const result = await service.submitDecision(projectId, {
        ...(readString(body, "decisionId") !== undefined ? { decisionId: readString(body, "decisionId")! } : {}),
        actor,
        payload: payload as unknown as AuthorDecisionPayload,
      });
      sendJson(res, result.duplicate ? 200 : 201, result);
      return true;
    }
    sendMethodNotAllowed(res, "GET, POST", method);
    return true;
  }
  if (rest === "/planner-context") {
    if (method !== "GET") {
      sendMethodNotAllowed(res, "GET", method);
      return true;
    }
    sendJson(res, 200, await service.plannerContext(projectId));
    return true;
  }
  // M14.3：继承表格资产台账（GET 只读；POST refresh 重建候选——幂等，已授权/
  // 已插入/已拒绝状态不受影响）。授权经 /decisions（payload.type=table_inheritance）。
  if (rest === "/table-assets") {
    if (method === "GET") {
      const refresh = url.searchParams.get("refresh") === "1";
      const file = refresh
        ? (await service.refreshTableCandidates(projectId)).file
        : await service.listTableAssets(projectId);
      sendJson(res, 200, { assets: file.assets, updatedAt: file.updatedAt });
      return true;
    }
    if (method === "POST") {
      const result = await service.refreshTableCandidates(projectId);
      sendJson(res, 200, { assets: result.file.assets, candidatesBuilt: result.candidatesBuilt, skippedInputs: result.skippedInputs });
      return true;
    }
    sendMethodNotAllowed(res, "GET, POST", method);
    return true;
  }
  const item = /^\/(ri-[a-f0-9]{12})(\/extract|\/verify|\/statement-facts)?$/.exec(rest);
  if (item !== null) {
    const inputId = item[1]!;
    if (!INPUT_ID_RE.test(inputId)) {
      throw new BusinessError("INVALID_REQUEST", "非法 inputId");
    }
    const action = item[2];
    if (action === undefined) {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET", method);
        return true;
      }
      sendJson(res, 200, await service.view(projectId, inputId));
      return true;
    }
    if (method !== "POST") {
      sendMethodNotAllowed(res, "POST", method);
      return true;
    }
    if (action === "/extract") {
      const result = await service.extractFacts(projectId, inputId);
      sendJson(res, 200, {
        created: result.created,
        unchanged: result.unchanged,
        skippedCells: result.skippedCells,
        parseStatus: result.parseStatus,
        tables: result.tables.map((table) => ({ blockId: table.blockId, label: table.label, labelBasis: table.labelBasis, page: table.page, rows: table.rows.length, columns: table.headers.length, headerRowDerived: table.headerRowDerived })),
      });
      return true;
    }
    if (action === "/verify") {
      sendJson(res, 200, await service.verifyFacts(projectId, inputId));
      return true;
    }
    const body = await readJsonBody(req);
    const candidates = body["candidates"];
    if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 200) {
      throw new BusinessError("INVALID_REQUEST", "candidates 必须是 1–200 条的数组");
    }
    const method_ = readString(body, "method") ?? "manual";
    if (method_ !== "manual" && method_ !== "model_candidate") {
      throw new BusinessError("INVALID_REQUEST", "method 只能是 manual / model_candidate");
    }
    const result = await service.addStatementFacts(
      projectId,
      inputId,
      candidates.map((candidate) => {
        if (!isRecord(candidate)) throw new BusinessError("INVALID_REQUEST", "candidate 必须是对象");
        return {
          kind: readString(candidate, "kind", true)! as never,
          statement: readString(candidate, "statement", true)!,
          quote: readString(candidate, "quote", true)!,
          ...(isRecord(candidate["key"]) ? { key: candidate["key"] as never } : {}),
          ...(readString(candidate, "value") !== undefined ? { value: readString(candidate, "value")! } : {}),
        };
      }),
      { method: method_, extractor: readString(body, "extractor") ?? (method_ === "manual" ? "http/manual" : "model"), ...(readString(body, "taskId") !== undefined ? { taskId: readString(body, "taskId")! } : {}) },
    );
    sendJson(res, 201, result);
    return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(body: Record<string, unknown>, field: string, required = false): string | undefined {
  const value = body[field];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (required) throw new BusinessError("INVALID_REQUEST", `请求体必须包含非空字符串字段 ${field}`);
  return undefined;
}

function readStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new BusinessError("INVALID_REQUEST", `${field} 必须是字符串数组`);
  }
  return value.map((entry) => entry.trim()).filter((entry) => entry !== "");
}
