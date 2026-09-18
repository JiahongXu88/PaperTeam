/**
 * Evidence Tool Layer（M6.5）：Agent 的 Evidence 能力入口（Pi customTools）。
 *
 * 工具纪律（与 scholarlyTools / retrieve_library 同风格）：
 * - 薄壳、无状态：工具不持有业务逻辑，只做参数传递与结构化返回；
 * - 失败如实返回结构化 payload（不抛错打断 Agent 会话）；
 * - 项目隔离：按会话绑定的 projectId 闭包构造，Agent 无法跨项目；
 * - **零 EvidenceStore 写路径**：evidence_query 只拿到只读投影
 *   （EvidenceReadAccess——类型层面就没有 append / updateVerification）；
 *   propose_evidence 只产生待核验候选（EvidenceCandidate，status=pending），
 *   不产生任何 verificationStatus，不写 evidence.jsonl。
 *
 * 角色权限矩阵（§M6.5-13；唯一事实源 evidenceToolsForRole）：
 *   researcher：get_chunk + propose_evidence + evidence_query
 *   writer：    evidence_query
 *   reviewer：  get_chunk + evidence_query
 *   citation：  get_chunk + evidence_query
 *   default：   （无）
 * 任何角色都没有 EvidenceStore 直写工具（write_evidence 不存在——状态机
 * 由 EvidenceGroundingService 独占）。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { BusinessError } from "../errors.js";
import type { ChunkAccess } from "./chunkAccess.js";
import type { EvidenceGroundingService } from "./EvidenceGroundingService.js";
import type { EvidenceQuery, EvidenceRecord, EvidenceStore } from "./EvidenceStore.js";

/** 工具层可见的 EvidenceStore 只读投影（类型层面不存在写方法） */
export type EvidenceReadAccess = Pick<EvidenceStore, "list" | "get" | "query" | "stats">;

export const GET_CHUNK_TOOL_NAME = "get_chunk";
export const PROPOSE_EVIDENCE_TOOL_NAME = "propose_evidence";
export const EVIDENCE_QUERY_TOOL_NAME = "evidence_query";

/** propose_evidence 单会话防洪泛软上限（超出仍入队但 note 提示——不静默丢弃） */
const PROPOSE_NOTE = "候选已入队，等待核验管道（quote 逐字校验 → metadata 核验 → 语义 judge）；这不是已核验证据（not verified evidence）";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function errorPayload(kind: string, error: unknown): ToolResult {
  const code = error instanceof BusinessError ? error.code : "evidence_tool_failed";
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ kind, ok: false, reason: code, message }) }],
    details: { ok: false, reason: code },
  };
}

/** get_chunk：按 chunkId 精确回取文献原文（quote 逐字核验的锚点） */
export function createGetChunkTool(chunkAccess: ChunkAccess, projectId: string): ToolDefinition {
  return defineTool({
    name: GET_CHUNK_TOOL_NAME,
    label: "回取文献原文 chunk",
    description:
      "按 chunkId 精确获取文献库原文段落（逐字原文 + 章节 + 页码 + 来源信息）。chunkId 来自 retrieve_library 返回的 CHUNK 标记。用于引用前核对原文、为 propose_evidence 准备逐字 quote。内容变化会生成新 chunkId，旧 id 将如实返回 not_found。",
    parameters: Type.Object({
      chunkId: Type.String({ description: "chunk 标识（retrieve_library 结果中的 CHUNK: 后完整串，如 S001:SEC01:0003:a1b2c3d4e5）" }),
    }),
    execute: async (_toolCallId, params): Promise<ToolResult> => {
      try {
        const { chunk, source } = await chunkAccess.resolve(projectId, params.chunkId);
        const payload = {
          kind: "chunk",
          note: "逐字原文（derived from 已入库文献全文；retrieved ≠ verified）",
          projectId,
          chunk: {
            chunkId: chunk.chunkId,
            sourceId: chunk.sourceId,
            sectionId: chunk.sectionId,
            section: chunk.sectionTitle,
            ...(chunk.subsection !== undefined ? { subsection: chunk.subsection } : {}),
            ...(chunk.pageStart !== undefined
              ? {
                  page: chunk.pageStart,
                  ...(chunk.pageEnd !== undefined && chunk.pageEnd !== chunk.pageStart
                    ? { pageEnd: chunk.pageEnd }
                    : {}),
                }
              : {}),
            ordinal: chunk.ordinal,
            text: chunk.text,
            charCount: chunk.charCount,
            tokenCount: chunk.tokenCount,
            contentHash: chunk.contentHash,
          },
          source: {
            sourceId: source.sourceId,
            title: source.metadata.title ?? null,
            authors: source.metadata.authors ?? null,
            year: source.metadata.year ?? null,
            doi: source.metadata.doi ?? null,
            arxivId: source.metadata.arxivId ?? null,
            sourceRole: source.sourceRole,
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: { chunkId: chunk.chunkId },
        };
      } catch (error) {
        return errorPayload("chunk", error);
      }
    },
  });
}

/** propose_evidence：提交证据候选（只入候选队列，不写 EvidenceStore） */
export function createProposeEvidenceTool(
  grounding: EvidenceGroundingService,
  projectId: string,
  proposedBy = "researcher",
): ToolDefinition {
  return defineTool({
    name: PROPOSE_EVIDENCE_TOOL_NAME,
    label: "提交证据候选",
    description:
      "提交一条潜在证据（claim + 从 chunk 原文逐字摘出的 quote + chunk 锚点）进入核验队列。只创建待核验候选（EvidenceCandidate）：quote 会做逐字校验、来源会做 metadata 核验、claim 与原文的关系由语义 judge 裁决——只有全部通过才会成为已核验证据。本工具不直接写入证据库。",
    parameters: Type.Object({
      sourceId: Type.String({ description: "来源文献 sourceId（如 S001；须与 chunkId 前缀一致）" }),
      chunkId: Type.String({ description: "chunk 标识（retrieve_library 的 CHUNK 标记）" }),
      claim: Type.String({ description: "该证据支撑的研究论断（单一命题，中文或英文）" }),
      quote: Type.String({ description: "从该 chunk 原文逐字摘出的引文（必须逐字复制，不要改写）" }),
      summary: Type.Optional(Type.String({ description: "可选：证据摘要（≤2000 字符）" })),
    }),
    execute: async (_toolCallId, params): Promise<ToolResult> => {
      try {
        const { candidate, deduplicated } = await grounding.propose(projectId, {
          sourceId: params.sourceId,
          chunkId: params.chunkId,
          claim: params.claim,
          quote: params.quote,
          ...(params.summary !== undefined ? { summary: params.summary } : {}),
          proposedBy,
        });
        const payload = {
          kind: "evidence-proposal",
          ok: true,
          projectId,
          candidateId: candidate.candidateId,
          status: candidate.status,
          deduplicated,
          note: deduplicated ? "同文候选已在队列中，复用未重复入队" : PROPOSE_NOTE,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: { candidateId: candidate.candidateId, deduplicated },
        };
      } catch (error) {
        return errorPayload("evidence-proposal", error);
      }
    },
  });
}

/** evidence_query：查询已入库 Evidence（只读；返回 EvidenceRecord） */
export function createEvidenceQueryTool(
  evidence: EvidenceReadAccess,
  projectId: string,
): ToolDefinition {
  return defineTool({
    name: EVIDENCE_QUERY_TOOL_NAME,
    label: "查询证据库",
    description:
      "查询当前项目的证据库（EvidenceRecord）。支持按核验状态（verified / unverified / plausible / mismatch / unverifiable / not_found）、来源（sourceId）、claim 关键词、章节（section）过滤。返回的是证据库记录——其中只有 verificationStatus=verified 且经过 grounding 管道的记录是已核验证据；unverified 记录仅为待核验线索。",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: "核验状态过滤（verified / unverified / plausible / mismatch / unverifiable / not_found）" }),
      ),
      sourceId: Type.Optional(Type.String({ description: "限定来源 sourceId（如 S001）" })),
      claimContains: Type.Optional(Type.String({ description: "claim 关键词（不区分大小写子串）" })),
      section: Type.Optional(Type.String({ description: "章节名过滤（location.section 包含匹配）" })),
    }),
    execute: async (_toolCallId, params): Promise<ToolResult> => {
      try {
        const filter: EvidenceQuery = {};
        if (params.status !== undefined && params.status.trim() !== "") {
          filter.status = params.status.trim() as EvidenceQuery["status"];
        }
        if (params.sourceId !== undefined && params.sourceId.trim() !== "") {
          filter.sourceId = params.sourceId.trim();
        }
        if (params.claimContains !== undefined && params.claimContains.trim() !== "") {
          filter.claimContains = params.claimContains.trim();
        }
        let records: EvidenceRecord[] = await evidence.query(projectId, filter);
        if (params.section !== undefined && params.section.trim() !== "") {
          const needle = params.section.trim().toLowerCase();
          records = records.filter((record) =>
            (record.location?.section ?? "").toLowerCase().includes(needle),
          );
        }
        const payload = {
          kind: "evidence-query",
          projectId,
          total: records.length,
          evidence: records.slice(0, 50).map((record) => ({
            id: record.id,
            claim: record.claim,
            quote: record.quote ?? null,
            verificationStatus: record.verificationStatus,
            supportStrength: record.supportStrength ?? null,
            verificationLevel: record.verificationLevel ?? null,
            verificationMethod: record.verificationMethod ?? null,
            sourceId: record.source?.sourceId ?? null,
            sourceTitle: record.source?.title ?? null,
            year: record.source?.year ?? null,
            section: record.location?.section ?? null,
            page: record.location?.page ?? null,
            chunkId: record.location?.chunk ?? null,
            createdBy: record.createdBy,
            createdAt: record.createdAt,
          })),
          ...(records.length > 50 ? { truncated: records.length - 50 } : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: { total: records.length },
        };
      } catch (error) {
        return errorPayload("evidence-query", error);
      }
    },
  });
}

export interface EvidenceToolDeps {
  chunkAccess: ChunkAccess;
  grounding: EvidenceGroundingService;
  /** 只读投影（生产传 EvidenceStore 实例——结构满足只读接口即可） */
  evidence: EvidenceReadAccess;
}

/** 角色键（与 runtime/pi/roleConfig 的 PiRoleKey 对齐） */
export type EvidenceToolRole = "researcher" | "writer" | "reviewer" | "citation" | "default";

/**
 * 角色 → Evidence 工具集（§M6.5-13 权限矩阵唯一事实源）。
 * default 角色不授予任何 Evidence 工具。
 */
export function evidenceToolsForRole(
  role: EvidenceToolRole,
  deps: EvidenceToolDeps,
  projectId: string,
): ToolDefinition[] {
  const query = createEvidenceQueryTool(deps.evidence, projectId);
  switch (role) {
    case "researcher":
      return [
        createGetChunkTool(deps.chunkAccess, projectId),
        createProposeEvidenceTool(deps.grounding, projectId, "researcher"),
        query,
      ];
    case "reviewer":
    case "citation":
      return [createGetChunkTool(deps.chunkAccess, projectId), query];
    case "writer":
      return [query];
    default:
      return [];
  }
}
