/**
 * retrieve_library：项目文献库检索工具（M6.4；Pi customTools）。
 *
 * 语义边界（防越界，D-0033 + 指令冻结）：
 * - 返回 retrieved source passages（来源 / 章节 / 页码 / 原文 + 引用标记），
 *   **不是 verified evidence**——本工具不写 EvidenceStore、不产生任何
 *   verificationStatus；把检索结果当已核验事实引用是调用方违规；
 * - 项目隔离：工具按会话绑定的 projectId 闭包构造（运行时 seam 传入），
 *   Agent 无法跨项目检索、也无法指定其他项目；
 * - 失败如实返回结构化 payload（不抛错打断 Agent），与 search_web 同风格。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { RetrievalService } from "./RetrievalService.js";
import { packRetrievalContext, DEFAULT_PACK_BUDGET_TOKENS } from "./contextPacker.js";
import type { ChunkFilter } from "./types.js";
import type { SourceRole } from "../sources/SourceStore.js";

export const RETRIEVE_LIBRARY_TOOL_NAME = "retrieve_library";

/** 打包预算上限（token 估算；与 chunk 切分同口径） */
const MAX_TOOL_BUDGET_TOKENS = 24_000;

/** 工具结果统一形状（details 松散键集，避免多分支联合类型不兼容） */
interface RetrieveToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export function createRetrieveLibraryTool(
  retrieval: RetrievalService,
  projectId: string,
): ToolDefinition {
  return defineTool({
    name: RETRIEVE_LIBRARY_TOOL_NAME,
    label: "检索项目文献库",
    description:
      "在当前项目的文献库（Literature Library）全文范围内检索与 query 相关的段落。返回 retrieved source passages：每段带来源（SRC）、chunk 标识（CHUNK）、章节（SECTION）与页码（PAGE，如有）引用标记和原文。这些是检索到的原文段落，不是已核验证据（not verified evidence）——引用其中的事实前必须回到原文核验，本工具不会写入 EvidenceStore。支持按来源（sourceIds）、来源角色（sourceRole: evidence/reference）、章节（section 前缀）过滤；budgetTokens 控制打包上下文的 token 预算。",
    parameters: Type.Object({
      query: Type.String({ description: "检索词（研究主题 / 术语 / 方法名；中英文均可）" }),
      topK: Type.Optional(Type.Number({ description: "返回条数上限（默认 8，最大 50）" })),
      sourceIds: Type.Optional(
        Type.Array(Type.String(), { description: "限定检索的文献 sourceId 列表（如 [\"S001\"]）" }),
      ),
      sourceRole: Type.Optional(
        Type.String({ description: "限定来源角色：evidence | reference（both 条目两侧都算）" }),
      ),
      section: Type.Optional(Type.String({ description: "限定章节标题前缀（如 method / experiments / 摘要）" })),
      budgetTokens: Type.Optional(
        Type.Number({ description: "打包上下文的 token 预算（默认 6000，最大 24000）" }),
      ),
    }),
    execute: async (_toolCallId, params): Promise<RetrieveToolResult> => {
      try {
        const role = params.sourceRole;
        const filter: ChunkFilter = {};
        if (params.sourceIds !== undefined && params.sourceIds.length > 0) {
          filter.sourceIds = params.sourceIds;
        }
        if (role === "evidence" || role === "reference" || role === "both") {
          filter.sourceRole = role as SourceRole;
        }
        if (params.section !== undefined && params.section.trim() !== "") {
          filter.section = params.section.trim();
        }
        const result = await retrieval.search(projectId, params.query, {
          ...(Number.isInteger(params.topK) ? { topK: params.topK } : {}),
          ...(Object.keys(filter).length > 0 ? { filter } : {}),
        });
        const budgetTokens = clampBudget(params.budgetTokens);
        const packed = packRetrievalContext(result.results, {
          budgetTokens,
          sourceScoped: filter.sourceIds !== undefined,
        });
        const payload = {
          kind: "retrieval" as const,
          note: "retrieved source passages（非 verified evidence；不写 EvidenceStore）",
          projectId,
          mode: result.mode,
          query: result.query,
          diagnostics: result.diagnostics,
          packedContext: {
            text: packed.text,
            usedTokens: packed.usedTokens,
            budgetTokens: packed.budgetTokens,
            excluded: packed.excluded,
          },
          results: packed.included.map((entry, index) => ({
            index,
            marker: `[SRC:${entry.chunk.sourceId} CHUNK:${entry.chunk.chunkId}]`,
            sourceTitle: entry.source.title,
            year: entry.source.year,
            section: entry.chunk.sectionTitle,
            ...(entry.chunk.pageStart !== undefined ? { page: entry.chunk.pageStart } : {}),
            score: entry.score,
            channels: entry.channels,
          })),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: { count: packed.included.length, mode: result.mode },
        };
      } catch (error) {
        const code = (error as { code?: string }).code ?? "retrieval_failed";
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text", text: JSON.stringify({ kind: "retrieval", ok: false, reason: code, message }) },
          ],
          details: { ok: false, reason: code },
        };
      }
    },
  });
}

function clampBudget(budget: number | undefined): number {
  if (budget === undefined || !Number.isFinite(budget)) {
    return DEFAULT_PACK_BUDGET_TOKENS;
  }
  return Math.min(Math.max(Math.floor(budget), 1000), MAX_TOOL_BUDGET_TOKENS);
}
