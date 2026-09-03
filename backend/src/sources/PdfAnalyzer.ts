/**
 * Reference PDF 分析（M3.1）。
 *
 * 分层设计：
 * - Layer 1（确定性，本文件 BuiltinPdfAnalyzer）：零依赖文本/结构层分析 ——
 *   页数、图片对象数、zlib 解压后的 Tj/TJ 文本抽取、章节标题识别、引用标记密度、
 *   文本预览。对子集字体 / Identity-H 编码的 PDF 提取质量有限，如实报告
 *   extractionQuality（good / partial / poor），不伪造成功。
 * - Layer 2（MultimodalAnalyzer 扩展点）：视觉图表级分析。OpenClaw 2026.8.1 的
 *   agent RPC 附件仅支持 image/*（PDF 会被网关拒绝），因此 AgentMultimodalAnalyzer
 *   通过消息文本引用服务器本地路径、由 Agent 内置 pdf 工具完成（真实可用性
 *   取决于 Gateway / 模型能力与沙箱路径授权；不可用时返回明确的 capability-gap
 *   结果，不伪造验证成功）。
 *
 * 分析失败不破坏项目：异常被捕获并转为 status=failed 的结果。
 */

import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

import type { AgentRuntime } from "../runtime/types.js";
import { AgentRunFailedError } from "../errors.js";
import { extractJsonObject } from "../agents/outputParsing.js";

/** PDF 分析结果（存储于 sources/parsed/<sourceId>.json） */
export interface PdfAnalysis {
  analyzer: string;
  /** ok：文本层可用；partial：仅部分可用；failed：无法分析 */
  status: "ok" | "partial" | "failed";
  pageCount: number | null;
  imageCount: number | null;
  extractedChars: number;
  /** 文本抽取质量评估（failed 时 poor） */
  extractionQuality: "good" | "partial" | "poor";
  headings: string[];
  /** 引用标记（[n] / (Author, year)）出现次数 */
  citationMarkers: number;
  textPreview: string;
  note?: string;
  analyzedAt: string;
  /** multimodal 扩展产物（视觉级结构画像；capability gap 时为 undefined） */
  styleProfile?: Record<string, unknown>;
}

export interface BuiltinAnalyzerOptions {
  now?: () => Date;
}

/** Layer 1：确定性文本/结构分析 */
export class BuiltinPdfAnalyzer {
  private readonly now: () => Date;

  constructor(options: BuiltinAnalyzerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async analyzeFile(path: string): Promise<PdfAnalysis> {
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch (error) {
      return this.failure(`无法读取文件：${error instanceof Error ? error.message : String(error)}`);
    }
    return this.analyzeBuffer(buffer);
  }

  analyzeBuffer(buffer: Buffer): PdfAnalysis {
    try {
      if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
        return this.failure("不是 PDF 文件（缺少 %PDF- 头）");
      }
      const pageCount = countPageObjects(buffer);
      const imageCount = countImageObjects(buffer);
      const text = extractPdfText(buffer);
      const printableRatio = printableRatioOf(text);
      const headings = detectHeadings(text);
      const citationMarkers = countCitationMarkers(text);

      const extractedChars = text.length;
      const perPage = pageCount !== null && pageCount > 0 ? extractedChars / pageCount : extractedChars;
      let extractionQuality: PdfAnalysis["extractionQuality"];
      let status: PdfAnalysis["status"];
      if (extractedChars >= 200 && perPage >= 150 && printableRatio >= 0.7) {
        extractionQuality = "good";
        status = "ok";
      } else if (extractedChars >= 60 && printableRatio >= 0.5) {
        extractionQuality = "partial";
        status = "partial";
      } else {
        extractionQuality = "poor";
        status = "partial"; // 结构信息仍可能有效（页数 / 图片数），文本不可依赖
      }
      return {
        analyzer: "builtin-text",
        status,
        pageCount,
        imageCount,
        extractedChars,
        extractionQuality,
        headings,
        citationMarkers,
        textPreview: text.slice(0, 2000),
        ...(status === "partial" && extractionQuality === "poor"
          ? { note: "文本层抽取质量低（可能使用子集字体 / 扫描件）；结构信息仅供参考" }
          : {}),
        analyzedAt: this.now().toISOString(),
      };
    } catch (error) {
      return this.failure(
        `分析过程异常：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private failure(note: string): PdfAnalysis {
    return {
      analyzer: "builtin-text",
      status: "failed",
      pageCount: null,
      imageCount: null,
      extractedChars: 0,
      extractionQuality: "poor",
      headings: [],
      citationMarkers: 0,
      textPreview: "",
      note,
      analyzedAt: this.now().toISOString(),
    };
  }
}

/** Layer 2 扩展点：多模态（视觉级）分析器接口 */
export interface MultimodalAnalyzer {
  readonly name: string;
  /**
   * 对参考论文做结构 / 呈现模式分析（Reference Style Profile）。
   * 能力不可用时返回 status="failed" + capabilityGap 说明，不抛异常。
   */
  analyzeReferencePaper(params: {
    projectId: string;
    absolutePath: string;
    documentType?: string;
    targetProfile?: string;
  }): Promise<PdfAnalysis>;
}

/**
 * 基于 Agent 的多模态分析（扩展点实现）。
 * 消息中给出服务器本地 PDF 路径，由 Agent（OpenClaw 内置 pdf 工具）完成
 * 视觉级分析；本实现不把 PDF 作为 RPC 附件传递（agent 入口拒绝非图片附件）。
 */
export class AgentMultimodalAnalyzer implements MultimodalAnalyzer {
  readonly name = "agent-multimodal";
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly now: () => Date;

  constructor(options: { runtime: AgentRuntime; agentId: string; now?: () => Date }) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.now = options.now ?? (() => new Date());
  }

  async analyzeReferencePaper(params: {
    projectId: string;
    absolutePath: string;
    documentType?: string;
    targetProfile?: string;
  }): Promise<PdfAnalysis> {
    const base: PdfAnalysis = {
      analyzer: this.name,
      status: "failed",
      pageCount: null,
      imageCount: null,
      extractedChars: 0,
      extractionQuality: "poor",
      headings: [],
      citationMarkers: 0,
      textPreview: "",
      note: "multimodal 能力不可用（未配置模型凭据或 Gateway 不在线）",
      analyzedAt: this.now().toISOString(),
    };
    let task;
    try {
      task = await this.runtime.runAgent({
        agentId: this.agentId,
        task: [
          "你是一名论文结构与呈现模式分析专家。请使用你可用的 pdf 读取工具，",
          `分析下面路径的参考论文 PDF（只做结构与风格分析，不复述其内容）：\n${params.absolutePath}`,
          "",
          `目标论文类型：${params.documentType ?? "（未指定）"}；目标档次：${params.targetProfile ?? "（未指定）"}`,
          "",
          "只输出一个 JSON 对象（不要 Markdown 围栏），字段：",
          '{"sectionStructure": ["章节名按顺序"], "sectionProportions": {"introduction": 0.1},',
          ' "figureUsage": "图表使用方式描述", "tableUsage": "表格使用方式描述",',
          ' "methodOrganization": "方法章节组织模式", "relatedWorkStyle": "相关工作组织方式",',
          ' "citationDensity": "引用密度描述", "pageLayout": "页面布局与视觉呈现描述"}',
        ].join("\n"),
        projectId: params.projectId,
        contextScope: "sources/pdf-analysis",
        metadata: { role: "researcher", skill: "pdf-analysis", milestone: "M3.1" },
      });
    } catch (error) {
      base.note = `multimodal 分析调用失败：${
        error instanceof Error ? error.message : String(error)
      }（视觉图表级分析尚受模型 / Runtime 能力约束）`;
      return base;
    }
    if (task.status !== "completed") {
      base.note = `multimodal 分析任务失败：${task.error ?? task.status}`;
      return base;
    }
    try {
      const parsed = extractJsonObject(task.output ?? "", "PDF 结构分析结果");
      return {
        ...base,
        status: "ok",
        extractionQuality: "partial",
        note: "由 Agent 视觉级分析产出（Reference Style Profile，Derived Context）",
        styleProfile: parsed,
      };
    } catch (error) {
      if (error instanceof AgentRunFailedError) {
        base.note = `multimodal 分析输出无法解析：${error.message}`;
        return base;
      }
      throw error;
    }
  }
}

// ---- 确定性 PDF 解析辅助（零依赖） ----

/** 统计 /Type /Page（排除 /Pages）出现次数 */
function countPageObjects(buffer: Buffer): number | null {
  const text = buffer.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page(?!s)[\s/>]/g);
  if (matches !== null && matches.length > 0) {
    return matches.length;
  }
  // 回退：Pages 树的 /Count
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((match) =>
    Number.parseInt(match[1] ?? "0", 10),
  );
  const max = counts.length > 0 ? Math.max(...counts) : 0;
  return max > 0 ? max : null;
}

function countImageObjects(buffer: Buffer): number | null {
  const matches = buffer.toString("latin1").match(/\/Subtype\s*\/Image[\s/>]/g);
  return matches === null ? null : matches.length;
}

/**
 * 提取文本：遍历 stream...endstream 块，FlateDecode 尝试 zlib 解压（失败用原文），
 * 收集 Tj / TJ 操作符中的字符串。子集字体编码下结果是字形索引而非可读文本 ——
 * 由 printableRatio / extractionQuality 如实反映。
 */
function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  const chunks: string[] = [];
  const streamPattern = /stream\r?\n?/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end === -1) {
      break;
    }
    const segment = Buffer.from(raw.slice(start, end), "latin1");
    let decoded: string | undefined;
    try {
      decoded = inflateSync(segment).toString("latin1");
    } catch {
      try {
        decoded = inflateSync(segment.subarray(2)).toString("latin1");
      } catch {
        decoded = undefined; // 未压缩或其他滤波器
      }
    }
    const content = decoded ?? segment.toString("latin1");
    if (!/(Tj|TJ)\b/.test(content)) {
      continue; // 非内容流
    }
    chunks.push(extractTextOperators(content));
    if (chunks.join("").length > 500_000) {
      break; // 提取上限（防御超大文件）
    }
  }
  return chunks.join("\n").replace(/[ \t]+/g, " ").trim();
}

/** 从单个内容流提取 (…) Tj 与 [ (…) … ] TJ 的字符串 */
function extractTextOperators(content: string): string {
  const parts: string[] = [];
  // (string) Tj
  const tjPattern = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  // [ (s1) num (s2) … ] TJ
  const tjArrayPattern = /\[((?:\\.|[^\]])*)\]\s*TJ/g;
  let match: RegExpExecArray | null;
  while ((match = tjPattern.exec(content)) !== null) {
    parts.push(decodePdfString(match[1] ?? ""));
  }
  while ((match = tjArrayPattern.exec(content)) !== null) {
    const inner = match[1] ?? "";
    const stringPattern = /\(((?:\\.|[^\\()])*)\)/g;
    let innerMatch: RegExpExecArray | null;
    while ((innerMatch = stringPattern.exec(inner)) !== null) {
      parts.push(decodePdfString(innerMatch[1] ?? ""));
    }
  }
  return parts.join("");
}

function decodePdfString(raw: string): string {
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
}

function printableRatioOf(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      ch === "\n" ||
      ch === "\t"
    ) {
      printable += 1;
    }
  }
  return printable / text.length;
}

/** 常见一级章节标题识别 */
function detectHeadings(text: string): string[] {
  const headingPattern =
    /^\s*(?:\d+(?:\.\d+)?\s+)?(abstract|introduction|related work|background|preliminar\w*|method(s|ology)?|approach|experiment(s|al results)?|evaluation|results|discussion|conclusion(s)?|acknowledg\w*|references)\s*$/gim;
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(text)) !== null && found.length < 30) {
    const heading = (match[1] ?? "").trim().toLowerCase();
    if (!found.includes(heading)) {
      found.push(heading);
    }
  }
  return found;
}

function countCitationMarkers(text: string): number {
  const bracket = text.match(/\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g)?.length ?? 0;
  const authorYear = text.match(/\([A-Z][A-Za-z'-]+(?:\s+et\s+al\.?)?,?\s*\d{4}\)/g)?.length ?? 0;
  return bracket + authorYear;
}
