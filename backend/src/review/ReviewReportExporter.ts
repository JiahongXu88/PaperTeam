/**
 * ReviewReportExporter：把结构化 Review 数据导出为面向二次分析的 Markdown 报告。
 *
 * 原则：
 * - Web UI 与 Export 消费同一套结构化产物（existing-review-r*.json + citation
 *   records + findings）——不会出现「UI 一套结论、Export 另一套结论」；
 * - 面向其它 AI（ChatGPT/Claude/Codex）二次分析：状态用清晰中文文字语义，
 *   emoji 只作辅助，绝不承载唯一信息；
 * - 报告是完整 Review（不受前端当前筛选影响）；
 * - 不包含 API Key、完整 prompt、内部绝对路径、PDF 原文；
 * - 异常项（NOT_FOUND / 不支持 / 证据不足…）详细展开，正常项压缩为紧凑表格。
 */

import type {
  CitationMetadataStatus,
  CitationVerificationRecord,
  ClaimCitationRecord,
  EvidenceLevel,
  ReferenceEntry,
} from "../citation/integrity.js";
import type { CitationSemanticMode } from "../citation/semanticMode.js";
import type { ReviewFinding } from "./finding.js";

export const REVIEW_EXPORT_VERSION = 1;

/** 与前端 status.ts 保持一致的中文标签（导出面向人和 AI，必须文字语义自足） */
const STATUS_LABELS: Record<string, string> = {
  VERIFIED: "已验证",
  METADATA_MISMATCH: "元数据不一致",
  AMBIGUOUS: "待确认",
  NOT_FOUND: "未找到",
  PROVIDER_ERROR: "核验暂未完成",
  UNRESOLVED: "核验暂未完成",
};

const VERDICT_LABELS: Record<string, string> = {
  SUPPORTED: "支持",
  PARTIALLY_SUPPORTED: "部分支持",
  UNSUPPORTED: "不支持",
  CONTRADICTED: "存在矛盾",
  INSUFFICIENT_EVIDENCE: "无法自动判断（证据不足）",
  SKIPPED: "跳过",
  NO_CONTRADICTION_DETECTED: "未发现明显矛盾",
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: "严重（Critical）",
  major: "主要（Major）",
  minor: "次要（Minor）",
  info: "提示（Info）",
};

const CATEGORY_LABELS: Record<string, string> = {
  fact: "事实",
  academic: "学术",
  style: "表达",
  citation: "引用",
  consistency: "一致性",
};

const KIND_LABELS: Record<string, string> = {
  scholarly_paper: "学术论文",
  software: "软件",
  dataset: "数据集",
  documentation: "文档",
  web_resource: "网络资源",
  unknown: "未知类型",
};

const REASON_CODE_LABELS: Record<string, string> = {
  NO_EVIDENCE: "只获取到书目 metadata，没有摘要/正文等可判证据",
  ABSTRACT_ONLY: "仅有摘要（或仓库描述）级证据，论断超出其支持范围",
  FULLTEXT_UNAVAILABLE: "全文无法获取",
  PROVIDER_ERROR: "模型/检索 provider 查询失败",
  REFERENCE_UNVERIFIED: "文献真实性未确立，语义核验跳过",
  LOW_RELEVANCE: "现有证据与论断相关性不足",
  UNQUOTED_CONTRADICTION: "judge 判矛盾但引不出逐字反向引文，矛盾结论不可采信",
};

const EVIDENCE_LEVEL_LABELS: Record<string, string> = {
  abstract: "摘要",
  metadata: "书目元数据",
  snippet: "检索片段",
  web: "网页",
  fulltext: "全文",
  repository: "官方仓库",
  official_docs: "官方文档",
};

const STATUS_EMOJI: Record<string, string> = {
  VERIFIED: "✅",
  METADATA_MISMATCH: "⚠️",
  AMBIGUOUS: "❔",
  NOT_FOUND: "❌",
  PROVIDER_ERROR: "⚡",
  UNRESOLVED: "⚡",
};

const VERDICT_EMOJI: Record<string, string> = {
  SUPPORTED: "✅",
  PARTIALLY_SUPPORTED: "🟡",
  UNSUPPORTED: "❌",
  CONTRADICTED: "❌",
  INSUFFICIENT_EVIDENCE: "❔",
  SKIPPED: "⏭️",
  NO_CONTRADICTION_DETECTED: "✅",
};

/** 正文 claim 截断（报告紧凑性；全文在 UI 明细可查） */
const CLAIM_MAX_CHARS = 300;
const EVIDENCE_MAX_CHARS = 240;

export interface ReviewExportInput {
  /** existing-review-r{n}.json（与 Web UI 同源） */
  report: {
    round: number;
    generatedAt: string;
    /** 本轮语义核验模式（off 时报告不携带语义统计；缺省按 full 解释——旧轮兼容） */
    citationSemanticMode?: CitationSemanticMode;
    paper: { title: string; pageCount?: number; sections?: number };
    review: {
      sectionsReviewed: number;
      sectionsTotal: number;
      skippedSections?: number;
      emptySections?: number;
      failedSections?: number;
      findingsTotal: number;
      parseFailures?: number;
      dropped?: number;
      bySeverity?: Record<string, number>;
      byCategory?: Record<string, number>;
    };
    citationIntegrity?: {
      metadataByStatus?: Record<string, number>;
      probableFabrications?: string[];
    };
    findings: ReviewFinding[];
  };
  project: { title: string };
  document: {
    originalFileName: string;
    pageCount: number;
    parse: { parserId: string; durationMs: number; extractionQuality: string; parsedAt: string };
    sections: Array<{ sectionId: string; title: string }>;
  } | null;
  references: ReferenceEntry[];
  metadataRecords: CitationVerificationRecord[];
  claims: ClaimCitationRecord[];
  calloutCount: number;
  /**
   * 本轮语义核验模式（调用方从 run/report 解析；优先于 report.citationSemanticMode）。
   * off：报告写明「本轮未开启」，不输出 支持 0 / 证据不足 0 之类的空统计，
   * 也不把项目里历史遗留的 claim records 混入本轮报告。
   */
  citationSemanticMode?: CitationSemanticMode;
  /** 最近一次 existing_paper_review run（阶段耗时 / 总时长） */
  run?: {
    runId: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    stageHistory: Array<{ stageId: string; status: string; startedAt: string; finishedAt: string }>;
  } | null;
  /** Quality Gate 报告（快速 Review 默认不含；有才输出） */
  gate?: { passed: boolean; reasons: string[]; rules: Array<{ rule: string; passed: boolean; detail: string }> } | null;
}

export interface ReviewExportResult {
  markdown: string;
  fileName: string;
}

function esc(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict] ?? verdict;
}

/** 导出文件名（sanitize：非法字符 → 空格；中文标题保留，走 UTF-8 filename*） */
export function sanitizeFileName(title: string, round: number): string {
  const base = title
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  const suffix = `PaperTeam-Review-r${round}.md`;
  return base === "" ? suffix : `${base}-r${round}.md`;
}

/** RFC 5987：Content-Disposition 的 UTF-8 filename*（中文标题合法下载） */
export function contentDisposition(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const ascii =
    asciiFallback !== ""
      ? asciiFallback
      : fileName.replace(/[^\x20-\x7E]/g, "") === ""
        ? `PaperTeam-Review-${Date.now()}.md`
        : "PaperTeam-Review.md";
  return `attachment; filename="${ascii.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export class ReviewReportExporter {
  export(input: ReviewExportInput): ReviewExportResult {
    const { report, references, metadataRecords, claims } = input;
    const referenceById = new Map(references.map((r) => [r.referenceId, r]));
    const sectionTitle = new Map((input.document?.sections ?? []).map((s) => [s.sectionId, s.title]));
    const metadataById = new Map(metadataRecords.map((r) => [r.referenceId, r]));
    const fileName = sanitizeFileName(report.paper.title || input.project.title, report.round);

    const lines: string[] = [];
    const push = (...parts: string[]) => lines.push(parts.join("\n"));

    // ---- 标题与基本信息 ----
    push("# PaperTeam Review Report", "");
    push("> 本报告由 PaperTeam 生成，面向人工复核与 AI 二次分析；与 Web UI 消费同一套结构化 Review 数据。", "");
    push("## 基本信息", "");
    push(
      "| 项目 | 内容 |",
      "| --- | --- |",
      `| 论文标题 | ${esc(report.paper.title || input.project.title)} |`,
      `| 文件名 | ${esc(input.document?.originalFileName ?? "（未知）")} |`,
      `| Review 时间 | ${report.generatedAt} |`,
      `| Review 轮次 | 第 ${report.round} 轮 |`,
      `| Review 模式 | 快速 Review（existing_paper_review，只读分析，不修改论文） |`,
      `| 页数 / 章节 | ${input.document?.pageCount ?? report.paper.pageCount ?? "—"} 页 / ${report.paper.sections ?? input.document?.sections.length ?? "—"} 节 |`,
      "",
    );

    // ---- 总体摘要 ----
    const bySeverity = report.review.bySeverity ?? {};
    push("## 总体摘要", "");
    push(
      `- Review 状态：${input.run?.status === "completed" ? "已完成" : (input.run?.status ?? "已完成")}`,
      `- 已审阅章节：${report.review.sectionsReviewed} / ${report.review.sectionsTotal} 节${
        (report.review.skippedSections ?? 0) + (report.review.failedSections ?? 0) > 0
          ? `（跳过 ${report.review.skippedSections ?? 0} 节，失败 ${report.review.failedSections ?? 0} 节）`
          : ""
      }`,
      `- 参考文献数：${references.length}`,
      `- 正文引用标记（callout）数：${input.calloutCount}`,
      `- 审阅发现（findings）：${report.review.findingsTotal} 条（严重 ${bySeverity["critical"] ?? 0} / 主要 ${bySeverity["major"] ?? 0} / 次要 ${bySeverity["minor"] ?? 0} / 提示 ${bySeverity["info"] ?? 0}）`,
      "",
    );

    // ---- 引用真实性核验 ----
    push("## 引用真实性核验（Layer 1：外部权威源比对）", "");
    const statusOrder: CitationMetadataStatus[] = [
      "VERIFIED",
      "METADATA_MISMATCH",
      "AMBIGUOUS",
      "NOT_FOUND",
      "PROVIDER_ERROR",
      "UNRESOLVED",
    ];
    push("| 状态 | 数量 |", "| --- | --- |");
    for (const status of statusOrder) {
      const count = metadataRecords.filter((r) => r.status === status).length;
      if (count > 0) {
        push(`| ${STATUS_EMOJI[status] ?? ""} ${statusLabel(status)} | ${count} |`);
      }
    }
    const unchecked = references.length - metadataRecords.length;
    if (unchecked > 0) {
      push(`| 未核验 | ${unchecked} |`);
    }
    push("");

    const attentionStatuses = new Set(["NOT_FOUND", "METADATA_MISMATCH", "AMBIGUOUS", "PROVIDER_ERROR", "UNRESOLVED"]);
    const attention = metadataRecords.filter((r) => attentionStatuses.has(r.status) || r.probableFabrication);
    if (attention.length > 0) {
      push("### 需要注意的引用", "");
      for (const record of attention) {
        const reference = referenceById.get(record.referenceId);
        push(this.describeReference(record, reference, sectionTitle));
      }
    }
    const normal = metadataRecords.filter((r) => !attentionStatuses.has(r.status) && !r.probableFabrication);
    if (normal.length > 0) {
      push(
        `### 正常引用（${normal.length} 条，紧凑列表）`,
        "",
        "| 编号 | 标题 | 类型 | 状态 | 来源 | DOI / URL |",
        "| --- | --- | --- | --- | --- | --- |",
      );
      for (const record of normal) {
        const reference = referenceById.get(record.referenceId);
        const canonical = record.canonical;
        const link =
          canonical?.doi !== undefined
            ? `https://doi.org/${canonical.doi}`
            : canonical?.software !== undefined
              ? `${canonical.software.repositoryUrl}${canonical.software.homepage !== undefined ? `（官方文档：${canonical.software.homepage}）` : ""}`
              : canonical?.url ?? reference?.url ?? "—";
        push(
          `| [${reference?.number ?? record.referenceId}] | ${esc(reference?.title ?? truncate(reference?.rawText ?? "（无标题）", 80))} | ${
            KIND_LABELS[record.kind ?? "scholarly_paper"] ?? "学术论文"
          } | ✅ ${statusLabel(record.status)} | ${esc(canonical?.provider ?? "—")} | ${esc(link)} |`,
        );
      }
      push("");
    }

    // ---- 语义核验 ----
    // 模式决定本节形态：off → 一句话说明（不输出空统计、不混入历史 records）；
    // contradiction_only → 标注模式，仅展开明确矛盾；full → 完整统计 + 明细
    const semanticMode = input.citationSemanticMode ?? report.citationSemanticMode ?? "full";
    let pending = 0;
    let insufficient: ClaimCitationRecord[] = [];
    if (semanticMode === "off") {
      push("## 引用语义核验", "");
      push("本轮未开启引用语义核验（仅执行引用真实性与元数据核验）。", "");
    } else {
      push(
        semanticMode === "contradiction_only"
          ? "## 语义核验（Layer 2：仅检查明显冲突）"
          : "## 语义核验（Layer 2：论断与引用一致性）",
        "",
      );
      if (semanticMode === "contradiction_only") {
        push("模式：仅检查明显冲突——只报告与正文论断明确矛盾的引用，不判断引用是否充分支持论断。", "");
      }
      const verdictOrder = [
        "SUPPORTED",
        "PARTIALLY_SUPPORTED",
        "UNSUPPORTED",
        "CONTRADICTED",
        "INSUFFICIENT_EVIDENCE",
        "SKIPPED",
        "NO_CONTRADICTION_DETECTED",
      ] as const;
      const byVerdict = new Map<string, ClaimCitationRecord[]>();
      for (const claim of claims) {
        byVerdict.set(claim.verdict, [...(byVerdict.get(claim.verdict) ?? []), claim]);
      }
      push("| 结论 | 数量 |", "| --- | --- |");
      for (const verdict of verdictOrder) {
        const list = byVerdict.get(verdict) ?? [];
        if (list.length > 0) {
          push(`| ${VERDICT_EMOJI[verdict] ?? ""} ${verdictLabel(verdict)} | ${list.length} |`);
        }
      }
      pending = claims.filter((c) => c.status === "pending").length;
      if (pending > 0) {
        push(`| 待核验（本轮未处理） | ${pending} |`);
      }
      push("");

      if (semanticMode === "contradiction_only") {
        // 只展开明确矛盾；未发现矛盾不逐条铺开（避免噪音）
        const contradicted = byVerdict.get("CONTRADICTED") ?? [];
        if (contradicted.length === 0) {
          push("未发现正文论断与引用来源存在明显矛盾。", "");
        } else {
          push(`### 存在矛盾（${contradicted.length} 条）`, "");
          for (const claim of contradicted) {
            push(this.describeClaim(claim, referenceById, sectionTitle, metadataById, true));
          }
        }
      } else {
        const detailVerdicts: Array<(typeof verdictOrder)[number]> = ["UNSUPPORTED", "CONTRADICTED"];
        for (const verdict of detailVerdicts) {
          const list = byVerdict.get(verdict) ?? [];
          if (list.length === 0) {
            continue;
          }
          push(`### ${verdictLabel(verdict)}（${list.length} 条）`, "");
          for (const claim of list) {
            push(this.describeClaim(claim, referenceById, sectionTitle, metadataById, true));
          }
        }
        insufficient = byVerdict.get("INSUFFICIENT_EVIDENCE") ?? [];
        if (insufficient.length > 0) {
          push(
            `### 无法自动判断（证据不足，${insufficient.length} 条——只表示未获取到足够摘要/正文证据，不代表引用存在问题）`,
            "",
          );
          for (const claim of insufficient) {
            push(this.describeClaim(claim, referenceById, sectionTitle, metadataById, false));
          }
        }
      }
    }

    // ---- Review Findings ----
    push("## Review Findings（分章节审阅发现）", "");
    const findings = report.findings;
    if (findings.length === 0) {
      push("本轮审阅未记录问题。", "");
    } else {
      for (const severity of ["critical", "major", "minor", "info"] as const) {
        const list = findings.filter((f) => f.severity === severity);
        if (list.length === 0) {
          continue;
        }
        push(`### ${SEVERITY_LABELS[severity] ?? severity}（${list.length} 条）`, "");
        for (const finding of list) {
          const location =
            finding.page !== undefined
              ? `第 ${finding.page} 页`
              : finding.sectionId !== undefined
                ? (sectionTitle.get(finding.sectionId) ?? finding.sectionId)
                : "（未定位）";
          push(
            `- **${location}${finding.sectionId !== undefined ? `（${sectionTitle.get(finding.sectionId) ?? finding.sectionId}）` : ""}｜${CATEGORY_LABELS[finding.category] ?? finding.category}**`,
            `  - 问题：${esc(finding.message)}`,
            ...(finding.claimText !== undefined ? [`  - 相关论断：「${esc(truncate(finding.claimText, CLAIM_MAX_CHARS))}」`] : []),
            ...(finding.suggestion !== undefined ? [`  - 建议：${esc(finding.suggestion)}`] : []),
          );
        }
        push("");
      }
    }

    // ---- 章节 Review ----
    push("## 章节 Review", "");
    const findingsBySection = new Map<string, ReviewFinding[]>();
    for (const finding of findings) {
      const key = finding.sectionId ?? "";
      findingsBySection.set(key, [...(findingsBySection.get(key) ?? []), finding]);
    }
    const sections = input.document?.sections ?? [];
    if (sections.length === 0) {
      push("（无章节结构信息）", "");
    } else {
      push("| 章节 | 审阅发现数 |", "| --- | --- |");
      for (const section of sections) {
        const count = (findingsBySection.get(section.sectionId) ?? []).length;
        if (count > 0) {
          push(`| ${esc(section.title)} | ${count} |`);
        }
      }
      const unlocated = (findingsBySection.get("") ?? []).length;
      if (unlocated > 0) {
        push(`| （未定位到章节） | ${unlocated} |`);
      }
      push("");
    }

    // ---- Quality Gate ----
    push("## Quality Gate", "");
    if (input.gate === null || input.gate === undefined) {
      push("本轮快速 Review 不包含 Quality Gate（如需，请在写作/改进工作流中运行）。", "");
    } else {
      push(`- 判定：${input.gate.passed ? "✅ PASS（通过）" : "❌ FAIL（未通过）"}`);
      if (input.gate.reasons.length > 0) {
        push("- 阻止原因：");
        for (const reason of input.gate.reasons) {
          push(`  - ${esc(reason)}`);
        }
      }
      push("");
      push("| 规则 | 结果 | 说明 |", "| --- | --- | --- |");
      for (const rule of input.gate.rules) {
        push(`| ${esc(rule.rule)} | ${rule.passed ? "✅ 通过" : "❌ 未通过"} | ${esc(truncate(rule.detail, 160))} |`);
      }
      push("");
    }

    // ---- 未解决问题 ----
    push("## 未解决问题（需人工 / 二次分析跟进）", "");
    const unresolved: string[] = [];
    for (const status of ["NOT_FOUND", "PROVIDER_ERROR", "UNRESOLVED"] as const) {
      const count = metadataRecords.filter((r) => r.status === status).length;
      if (count > 0) {
        unresolved.push(`- ${statusLabel(status)}的引用：${count} 条`);
      }
    }
    const fabrications = metadataRecords.filter((r) => r.probableFabrication);
    if (fabrications.length > 0) {
      unresolved.push(`- 疑似虚构引用：${fabrications.length} 条（${fabrications.map((r) => `[${referenceById.get(r.referenceId)?.number ?? r.referenceId}]`).join("、")}）`);
    }
    if (insufficient.length > 0) {
      unresolved.push(
        `- 无法自动判断（证据不足）的论断-引用对：${insufficient.length} 条（只表示未获取到足够摘要/正文证据，不是论文缺陷；见上文语义核验明细）`,
      );
    }
    if (pending > 0) {
      unresolved.push(`- 待核验的论断-引用对：${pending} 条（超出本轮处理上限，再次运行 Review 可补齐）`);
    }
    if ((report.review.failedSections ?? 0) > 0) {
      unresolved.push(`- 审阅失败的章节：${report.review.failedSections} 节（模型调用失败，重新 Review 可补齐）`);
    }
    if ((report.review.parseFailures ?? 0) > 0) {
      unresolved.push(`- 模型输出无法解析的章节：${report.review.parseFailures} 节`);
    }
    push(...(unresolved.length > 0 ? unresolved : ["（无）"]), "");

    // ---- 运行信息 ----
    push("## 运行信息", "");
    if (semanticMode === "off") {
      push(`- 引用语义核验：未开启（语义模型调用 0 次）`);
    } else {
      const modelLabels = [...new Set(claims.map((c) => c.model).filter((m): m is string => m !== undefined))];
      push(`- 语义核验 judge 模型：${modelLabels.length > 0 ? modelLabels.join("、") : "（未记录）"}`);
      const modelCalls = claims.filter((c) => c.model !== undefined).length;
      push(`- 模型调用（语义 judge）：${modelCalls} 次；分章节审阅：${report.review.sectionsReviewed} 次（每节一次，含重试另计）`);
    }
    const resolverCalls = metadataRecords.reduce((sum, r) => sum + r.attempts.length, 0);
    push(`- 外部权威源查询：${resolverCalls} 次（学术库 + 软件仓库；含重试）`);
    push(`- PDF 解析：${input.document?.parse.parserId ?? "—"}（${input.document?.parse.durationMs ?? "—"} ms，质量 ${input.document?.parse.extractionQuality ?? "—"}）`);
    if (input.run !== null && input.run !== undefined) {
      const totalMs = durationBetween(input.run.startedAt, input.run.finishedAt);
      if (totalMs !== undefined) {
        push(`- Review 总耗时：${(totalMs / 1000).toFixed(1)} 秒`);
      }
      push("", "| 阶段 | 状态 | 耗时 |", "| --- | --- | --- |");
      for (const stage of input.run.stageHistory) {
        const ms = durationBetween(stage.startedAt, stage.finishedAt);
        push(`| ${esc(stage.stageId)} | ${stage.status === "completed" ? "完成" : stage.status} | ${ms !== undefined ? `${(ms / 1000).toFixed(1)}s` : "—"} |`);
      }
    }
    push("", "---", "", `*报告版本：v${REVIEW_EXPORT_VERSION}；生成于 ${new Date().toISOString()}。本报告不含 API Key、模型提示词与内部路径。*`);

    return { markdown: lines.join("\n"), fileName };
  }

  /** 单条引用的详细块（需注意项） */
  private describeReference(
    record: CitationVerificationRecord,
    reference: ReferenceEntry | undefined,
    sectionTitle: Map<string, string>,
  ): string {
    const lines: string[] = [];
    const canonical = record.canonical;
    const number = reference?.number ?? record.referenceId;
    lines.push(`#### [${number}] ${reference?.title ?? truncate(reference?.rawText ?? "（无标题）", 120)}`);
    lines.push("");
    lines.push(
      `- 作者/年份：${reference?.authors?.slice(0, 3).join("，") ?? "—"}${(reference?.authors?.length ?? 0) > 3 ? " 等" : ""}，${reference?.year ?? "—"}`,
      `- 类型：${KIND_LABELS[record.kind ?? "scholarly_paper"] ?? record.kind ?? "学术论文"}`,
      `- 状态：${STATUS_EMOJI[record.status] ?? ""} ${statusLabel(record.status)}${record.probableFabrication ? "（疑似虚构，需人工确认）" : ""}`,
    );
    if (canonical !== undefined) {
      lines.push(`- Canonical 来源：${canonical.provider}（${canonical.recordId || "—"}）`);
      if (canonical.software !== undefined) {
        lines.push(
          `- Repository：${canonical.software.repositoryUrl}`,
          ...(canonical.software.homepage !== undefined ? [`- 官方文档：${canonical.software.homepage}`] : []),
        );
      }
      if (canonical.doi !== undefined) {
        lines.push(`- DOI：${canonical.doi}`);
      } else if (canonical.url !== undefined) {
        lines.push(`- URL：${canonical.url}`);
      } else {
        lines.push("- DOI：暂无");
      }
    } else {
      lines.push("- DOI：暂无（未获得 canonical 记录）");
    }
    if (record.mismatches !== undefined && record.mismatches.length > 0) {
      lines.push(
        `- 字段差异：${record.mismatches.map((m) => `${m.field}：文中 ${m.expected ?? "?"}，权威源 ${m.actual ?? "?"}`).join("；")}`,
      );
    }
    if (record.attempts.length > 0) {
      lines.push(
        `- 核验详情：${record.attempts
          .map((a) => `${providerDisplayName(a.provider)}：${attemptOutcomeLabel(a.outcome)}`)
          .join("；")}`,
      );
    }
    if (record.error !== undefined) {
      lines.push(`- 错误：${esc(truncate(record.error, 200))}`);
    }
    lines.push(`- 所在位置：第 ${reference?.page ?? "—"} 页${reference?.sectionId !== undefined ? `（${sectionTitle.get(reference.sectionId) ?? reference.sectionId}）` : ""}`);
    lines.push("");
    return lines.join("\n");
  }

  /** 单条 claim-citation 记录（详细 / 紧凑两种形态；v4 记录 = 原子论断 × 引用组） */
  private describeClaim(
    claim: ClaimCitationRecord,
    referenceById: Map<string, ReferenceEntry>,
    sectionTitle: Map<string, string>,
    metadataById: Map<string, CitationVerificationRecord>,
    detailed: boolean,
  ): string {
    const references = (claim.referenceIds ?? [claim.referenceId]).map(
      (referenceId) => referenceById.get(referenceId),
    );
    const reference = references[0];
    const metadata = metadataById.get(claim.referenceId);
    const section = sectionTitle.get(claim.sectionId) ?? claim.sectionId;
    const numbers = references
      .map((ref) => ref?.number ?? (ref !== undefined ? ref.referenceId : "?"))
      .join(", ");
    const number = reference?.number ?? claim.referenceId;
    const groupLabel =
      (claim.referenceIds?.length ?? 1) > 1
        ? `引用组 ${claim.groupRawText ?? `[${numbers}]`}（${claim.referenceIds!.length} 篇共同支撑）`
        : `引用 [${number}]`;
    const lines: string[] = [];
    const headline = `p${claim.page}｜${section}｜${groupLabel} → 状态：${VERDICT_EMOJI[claim.verdict] ?? ""} ${verdictLabel(claim.verdict)}`;
    if (!detailed) {
      // 紧凑形态（无法自动判断全量保留时控制篇幅）；reasonCode 后缀与理由重复时不再追加
      const reasonCodeLabel =
        claim.reasonCode !== undefined ? (REASON_CODE_LABELS[claim.reasonCode] ?? claim.reasonCode) : undefined;
      const reasonSuffix =
        reasonCodeLabel !== undefined && !(claim.reason ?? "").includes(reasonCodeLabel)
          ? `（${reasonCodeLabel}）`
          : "";
      const refTitle = reference?.title ?? truncate(reference?.rawText ?? claim.referenceId, 60);
      lines.push(
        `- **${headline}**`,
        `  - 论断：「${esc(truncate(claim.claimText, CLAIM_MAX_CHARS))}」`,
        `  - 被引文献：${esc(truncate(refTitle, 100))}${(claim.referenceIds?.length ?? 1) > 1 ? ` 等 ${claim.referenceIds!.length} 篇` : ""}`,
        `  - 理由：${esc(truncate(claim.reason ?? "—", 200))}${reasonSuffix}`,
      );
      if (claim.evidence.length > 0) {
        const evidence = claim.evidence[0]!;
        lines.push(
          `  - 证据（${EVIDENCE_LEVEL_LABELS[evidence.evidenceLevel] ?? evidence.evidenceLevel}，${evidence.source}）：${esc(truncate(evidence.text.split("\n")[0] ?? "", EVIDENCE_MAX_CHARS))}`,
        );
      } else {
        lines.push("  - 证据：当前未获得足够可核验的原文证据（自动核验无法判断，不代表引用存在错误）。");
      }
    } else {
      lines.push(
        `- **${headline}**`,
        `  - 原子论断：「${esc(truncate(claim.claimText, CLAIM_MAX_CHARS))}」`,
        ...(claim.sourceSentence !== undefined
          ? [`  - 来源句：「${esc(truncate(claim.sourceSentence, CLAIM_MAX_CHARS))}」`]
          : []),
        (claim.referenceIds?.length ?? 1) > 1
          ? `  - 被引文献组：${claim.groupRawText ?? `[${numbers}]`}（${claim.referenceIds!.length} 篇共同支撑，成员 [${numbers}]）`
          : `  - 被引文献：[${numbers}]`,
        `  - 文献真实性：${statusLabel(metadata?.status ?? "SKIPPED_NO_METADATA")}`,
        `  - 理由：${esc(claim.reason ?? "—")}`,
      );
      if (claim.excludedReferenceIds !== undefined && claim.excludedReferenceIds.length > 0) {
        lines.push(
          `  - 未参与核验的组员：[${claim.excludedReferenceIds
            .map((referenceId) => referenceById.get(referenceId)?.number ?? referenceId)
            .join(", ")}]（真实性未确立或无摘要）`,
        );
      }
      if (claim.evidence.length > 0) {
        for (const evidence of claim.evidence) {
          lines.push(
            `  - 证据（${EVIDENCE_LEVEL_LABELS[evidence.evidenceLevel as EvidenceLevel] ?? evidence.evidenceLevel}｜${evidence.source}${evidence.page !== undefined ? `｜p${evidence.page}` : ""}）：${esc(truncate(evidence.text.split("\n")[0] ?? "", EVIDENCE_MAX_CHARS))}`,
            ...([
              ...(evidence.doi !== undefined ? [`    - DOI：${evidence.doi}`] : []),
              ...(evidence.url !== undefined ? [`    - URL：${evidence.url}`] : []),
            ] as string[]),
          );
        }
      } else {
        lines.push("  - 证据：当前未获得足够可核验的原文证据（自动核验无法判断，不代表引用存在错误）。");
      }
    }
    return lines.join("\n");
  }
}

function providerDisplayName(provider: string): string {
  const names: Record<string, string> = {
    crossref: "Crossref",
    openalex: "OpenAlex",
    "semantic-scholar": "Semantic Scholar",
    arxiv: "arXiv",
    github: "GitHub（官方仓库）",
  };
  return names[provider] ?? provider;
}

function attemptOutcomeLabel(outcome: string): string {
  const labels: Record<string, string> = {
    match: "命中",
    mismatch: "命中（字段有差异）",
    not_found: "未收录",
    ambiguous: "多个候选",
    error: "查询失败",
  };
  return labels[outcome] ?? outcome;
}

function durationBetween(startedAt: string | undefined, finishedAt: string | undefined): number | undefined {
  if (startedAt === undefined || finishedAt === undefined) {
    return undefined;
  }
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
