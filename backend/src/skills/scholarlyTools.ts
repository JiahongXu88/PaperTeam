/**
 * 受控学术检索工具：Pi Session 的 customTools。
 *
 * paper-search skill 的方法层告诉 Agent「什么时候搜索、怎么验证」；
 * 真正的检索由 PaperTeam 后端的 ScholarlyResolver 受控执行
 * （缓存 / 超时 / 重试 / telemetry 都在 resolver 层），Agent 不持有
 * shell，也不直接访问外部 HTTP。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ScholarlyResolver } from "../citation/scholarly.js";

export function createScholarlyTools(resolver: ScholarlyResolver): ToolDefinition[] {
  const searchPapers = defineTool({
    name: "search_papers",
    label: "检索学术论文",
    description:
      "按关键词检索学术论文（Crossref / OpenAlex）。返回 JSON 数组：provider、recordId、title、authors、year、venue、doi、arxivId。用于文献调研与引用核验前的事实检索；结果必须原样引用，不得凭记忆补充。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词或论文标题" }),
      limit: Type.Optional(Type.Number({ description: "返回条数上限（默认 5）" })),
    }),
    execute: async (_toolCallId, params) => {
      const records = await resolver.search(params.query, params.limit ?? 5);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(records) }],
        details: { count: records.length },
      };
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

  return [searchPapers, lookupPaper];
}
