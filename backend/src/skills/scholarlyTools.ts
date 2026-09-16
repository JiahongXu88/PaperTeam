/**
 * 受控检索工具：Pi Session 的 customTools。
 *
 * M6.3 起 search_papers 升级为真发现检索（ResearchDiscoveryService 多源聚合：
 * OpenAlex primary / S2 fallback / arXiv preprint / AMiner China-secondary，
 * SourceIdentity 去重 + 带权重 RRF 融合）；search_web 经 SearXNG（optional，
 * 未配置时如实返回 not_configured）。lookup_paper 语义不变（核验 ≠ 检索）。
 *
 * 边界纪律（D-0033）：
 * - 检索/网络重试/熔断全部在服务层（ProviderHttpClient），Agent 不持有 shell、
 *   不直接访问外部 HTTP；
 * - 工具输出明确标记「这些是 Candidate Sources」——检索结果 ≠ verified evidence，
 *   本工具不写 EvidenceStore、不写论文正文、不自动持久化候选（持久化经
 *   project-scoped HTTP API 显式执行）。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ScholarlyResolver } from "../citation/scholarly.js";
import type { ResearchDiscoveryService } from "../search/researchDiscoveryService.js";

/** 工具结果统一形状（details 松散键集，避免多分支联合类型不兼容） */
interface SearchToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export function createScholarlyTools(
  resolver: ScholarlyResolver,
  discovery?: ResearchDiscoveryService,
): ToolDefinition[] {
  const searchPapers = defineTool({
    name: "search_papers",
    label: "检索学术论文",
    description:
      "按关键词发现学术论文（多源聚合：OpenAlex / Semantic Scholar / arXiv / AMiner，跨源去重与融合排序）。返回 candidate sources（provider、title、authors、year、venue、doi、arxivId、abstract、citationCount、openAccess、score、sources）——是候选文献线索，不是已核验证据；引用前需经 lookup_paper 核验与用户确认。检索失败与无结果会如实区分。结果必须原样引用，不得凭记忆补充。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词（研究主题，不是待核验的论文标题）" }),
      limit: Type.Optional(Type.Number({ description: "返回条数上限（默认 10，最大 50）" })),
      yearFrom: Type.Optional(Type.Number({ description: "发表年份下限（含）" })),
      yearTo: Type.Optional(Type.Number({ description: "发表年份上限（含）" })),
    }),
    execute: async (_toolCallId, params): Promise<SearchToolResult> => {
      const limit = clampToolLimit(params.limit);
      if (discovery !== undefined) {
        const response = await discovery.academicSearch(params.query, {
          limit,
          ...(Number.isInteger(params.yearFrom) ? { yearFrom: params.yearFrom } : {}),
          ...(Number.isInteger(params.yearTo) ? { yearTo: params.yearTo } : {}),
        });
        const payload = {
          kind: "academic_search" as const,
          note: "candidate sources（非 verified evidence；不自动入库）",
          status: response.status,
          results: response.results.map((result, index) => ({
            index,
            score: result.score,
            title: result.record.title,
            authors: result.record.authors,
            year: result.record.year,
            venue: result.record.venue,
            doi: result.record.doi,
            arxivId: result.record.arxivId ?? result.identity.arxivId,
            abstract: result.record.abstract?.slice(0, 500),
            citationCount: result.citationCount,
            openAccess: result.openAccess,
            url: result.record.url,
            sources: result.sources,
          })),
          diagnostics: response.diagnostics.providers.map((attempt) => ({
            provider: attempt.provider,
            outcome: attempt.outcome,
            resultCount: attempt.resultCount,
          })),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: { count: response.results.length, status: response.status },
        };
      }
      // 未装配 discovery 服务（最小栈）：回退既有 resolver 受控检索（查证形语义）
      const records = await resolver.search(params.query, Math.min(limit, 10));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "academic_search",
              note: "candidate sources（非 verified evidence；不自动入库）",
              fallback: "resolver-title-search",
              results: records,
            }),
          },
        ],
        details: { count: records.length, status: "fallback" },
      };
    },
  });

  const searchWeb = defineTool({
    name: "search_web",
    label: "Web 检索",
    description:
      "通过 SearXNG 聚合引擎检索 Web 页面（cn.bing / baidu 等）。返回 candidate sources（title / url / snippet / engines）——页面线索不是证据正文；引用任何事实前需打开原文核验，snippet 不构成 verified evidence。未配置 SearXNG（PAPERTEAM_SEARXNG_URL）时如实返回 not_configured。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词" }),
      limit: Type.Optional(Type.Number({ description: "返回条数上限（默认 10，最大 50）" })),
    }),
    execute: async (_toolCallId, params): Promise<SearchToolResult> => {
      if (discovery === undefined) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ kind: "web_search", ok: false, reason: "not_configured" }) },
          ],
          details: { ok: false },
        };
      }
      try {
        const response = await discovery.webSearch(params.query, { limit: clampToolLimit(params.limit) });
        const payload = {
          kind: "web_search" as const,
          note: "candidate sources（snippet 非 verified evidence；不自动入库）",
          status: response.status,
          results: response.results.map((result, index) => ({
            index,
            title: result.title,
            url: result.url,
            snippet: result.snippet.slice(0, 500),
            engines: result.engines,
          })),
          diagnostics: response.diagnostics.providers,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: { count: response.results.length, status: response.status },
        };
      } catch (error) {
        // Web Search optional：未配置 / 上游不可用如实返回，不抛错打断 Agent
        const code = (error as { code?: string }).code ?? "search_failed";
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ kind: "web_search", ok: false, reason: code, message }) }],
          details: { ok: false, reason: code },
        };
      }
    },
  });

  const lookupPaper = defineTool({
    name: "lookup_paper",
    label: "查证单篇论文",
    description:
      "查证一篇论文是否真实存在并返回 canonical 记录。优先传 DOI（精确匹配优先级最高）；无 DOI 时传完整标题 + 年份 + 第一作者。返回 outcome（match/mismatch/ambiguous/not_found/unresolved）：not_found=多源一致查无此文；unresolved=检索暂时失败（绝不等于不存在）。禁止凭记忆判定文献存在性。",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "论文完整标题" })),
      doi: Type.Optional(Type.String({ description: "DOI（如 10.5555/3294771.3295065）" })),
      arxivId: Type.Optional(Type.String({ description: "arXiv id（如 1706.03762）" })),
      year: Type.Optional(Type.Number({ description: "发表年份" })),
      firstAuthor: Type.Optional(Type.String({ description: "第一作者姓氏" })),
    }),
    execute: async (_toolCallId, params) => {
      const verdict = await resolver.resolve({
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.doi !== undefined ? { doi: params.doi } : {}),
        ...(params.arxivId !== undefined ? { arxivId: params.arxivId } : {}),
        ...(params.year !== undefined ? { year: params.year } : {}),
        ...(params.firstAuthor !== undefined ? { authors: [params.firstAuthor] } : {}),
      });
      const payload = {
        outcome: verdict.outcome,
        ...(verdict.canonical !== undefined ? { canonical: verdict.canonical } : {}),
        ...(verdict.mismatches !== undefined ? { mismatches: verdict.mismatches } : {}),
        ...(verdict.candidates !== undefined ? { candidates: verdict.candidates } : {}),
        attempts: verdict.attempts,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        details: { outcome: verdict.outcome },
      };
    },
  });

  return [searchPapers, searchWeb, lookupPaper];
}

function clampToolLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    return 10;
  }
  return Math.min(limit, 50);
}
