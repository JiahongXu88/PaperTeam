/**
 * Researcher 业务角色（M3.1）。
 *
 * 职责（PRD §7.2）：Idea Research —— 领域现状、Related Work 方向、Research Gap、
 * 潜在贡献、研究问题、文献检索计划；并从项目文献库提取候选 Evidence 与
 * 候选参考文献（bibliography）。Researcher 不写论文正文。
 *
 * 链路：读 Project → 组装 Prompt（含文献摘要）→ AgentRuntime.runAgent
 * → 结构化校验 → 落盘 research/research.json + Evidence 追加 → 返回摘要。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentRunFailedError } from "../errors.js";
import type { ProjectMetadata, ProjectStore } from "../project/ProjectStore.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { EvidenceAppendInput, EvidenceStore } from "../evidence/EvidenceStore.js";
import type { SourceStore, SourceItem } from "../sources/SourceStore.js";
import {
  extractJsonObject,
  readOptionalStringArray,
  readRequiredString,
  readRequiredStringArray,
  stripCodeFence,
} from "./outputParsing.js";

export interface ResearchReport {
  domainOverview: string;
  relatedWorkDirections: string[];
  researchGaps: string[];
  potentialContributions: string[];
  researchQuestions: string[];
  literaturePlan: string[];
}

export interface ResearcherResult {
  report: ResearchReport;
  /** 落盘路径（相对项目根） */
  reportPath: string;
  /** 本次追加的 Evidence 条数 */
  evidenceAppended: number;
  /** 候选参考文献条数 */
  bibliographyCount: number;
  /** 本次 Researcher 任务的 Runtime 任务 id（诊断） */
  taskId: string;
}

export interface ResearcherServiceOptions {
  runtime: AgentRuntime;
  agentId: string;
  projects: ProjectStore;
  evidence: EvidenceStore;
  sources: SourceStore;
  log?: (message: string) => void;
}

export class ResearcherService {
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly projects: ProjectStore;
  private readonly evidence: EvidenceStore;
  private readonly sources: SourceStore;
  private readonly log: (message: string) => void;

  constructor(options: ResearcherServiceOptions) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.projects = options.projects;
    this.evidence = options.evidence;
    this.sources = options.sources;
    this.log = options.log ?? (() => {});
  }

  /**
   * 执行一次 Idea Research。
   * 结构化产出必须通过校验才落盘（Agent 返回文本 ≠ 成功）；
   * Researcher 提出的 Evidence 以 unverified 状态进入 EvidenceStore（待核验）。
   */
  async research(params: {
    projectId: string;
    /** 用户补充说明（如 HITL 反馈） */
    extraInstructions?: string;
  }): Promise<ResearcherResult> {
    const project = await this.projects.getRequired(params.projectId);
    const sourceDigest = await this.buildSourceDigest(params.projectId);

    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: buildResearchPrompt(project, sourceDigest, params.extraInstructions),
      projectId: params.projectId,
      contextScope: "research",
      metadata: { role: "researcher", milestone: "M3.1" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `Researcher 任务以 ${task.status} 状态结束`);
    }
    const output = task.output ?? "";
    const parsed = extractJsonObject(output, "Researcher 调研结果");

    const report: ResearchReport = {
      domainOverview: readRequiredString(parsed, "domainOverview", "Researcher 调研结果"),
      relatedWorkDirections: readRequiredStringArray(
        parsed,
        "relatedWorkDirections",
        "Researcher 调研结果",
      ),
      researchGaps: readRequiredStringArray(parsed, "researchGaps", "Researcher 调研结果"),
      potentialContributions: readRequiredStringArray(
        parsed,
        "potentialContributions",
        "Researcher 调研结果",
        { minItems: 1 },
      ),
      researchQuestions: readRequiredStringArray(
        parsed,
        "researchQuestions",
        "Researcher 调研结果",
      ),
      literaturePlan: readRequiredStringArray(parsed, "literaturePlan", "Researcher 调研结果"),
    };

    // 落盘 research/research.json（Authoritative State）
    const researchDir = this.projects.researchDir(params.projectId);
    await mkdir(researchDir, { recursive: true });
    const artifact = {
      generatedAt: new Date().toISOString(),
      taskId: task.taskId,
      report,
      evidence: readEvidenceCandidates(parsed),
      bibliography: readBibliography(parsed),
    };
    const reportPath = join("research", "research.json");
    await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");

    // Researcher 提出的 Evidence 进入 EvidenceStore（unverified，待核验）
    let evidenceAppended = 0;
    for (const candidate of artifact.evidence) {
      await this.evidence.append(params.projectId, candidate, "researcher");
      evidenceAppended += 1;
    }

    this.log(
      `[researcher] projectId=${params.projectId} 调研完成：gaps=${report.researchGaps.length} evidence=${evidenceAppended} bibliography=${artifact.bibliography.length}`,
    );
    return {
      report,
      reportPath,
      evidenceAppended,
      bibliographyCount: artifact.bibliography.length,
      taskId: task.taskId,
    };
  }

  /** 汇总项目文献库（供 Prompt 注入；只提供已解析摘要，不塞原始全文） */
  private async buildSourceDigest(projectId: string): Promise<string> {
    const items = await this.sources.list(projectId);
    const usable = items.filter(
      (item) => item.sourceRole !== "reference" && item.status !== "failed" && item.status !== "pending",
    );
    if (usable.length === 0) {
      return "（项目文献库当前为空：请基于领域常识给出调研方向，并在 literaturePlan 中列出应补充的文献）";
    }
    const lines = usable.slice(0, 20).map((item) => describeSource(item));
    return [`项目文献库（${usable.length} 项）：`, ...lines].join("\n");
  }

  /**
   * Existing-Paper：论文理解（M3.2）。
   * 读取导入的 LaTeX 项目，产出结构化理解（贡献 / 论证 / 实验组织 / 弱点），
   * 映射为 ResearchReport 形状供后续 Feasibility 与改进计划复用。
   */
  async analyzeExistingPaper(params: {
    projectId: string;
    manuscriptDigest: string;
  }): Promise<ResearcherResult & { weaknesses: string[]; contributions: string[] }> {
    const project = await this.projects.getRequired(params.projectId);
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: [
        "你是一名学术研究员（Researcher）。请阅读并理解下面这篇已有论文（LaTeX 结构化摘要），做论文理解分析。",
        "",
        "只输出一个 JSON 对象（不要 Markdown 围栏），字段：",
        "{",
        '  "domainOverview": "论文内容与论证结构概述（200-400 字）",',
        '  "relatedWorkDirections": ["论文涉及的相关工作方向"],',
        '  "researchGaps": ["论文当前的弱点与不足（对照目标档次）"],',
        '  "potentialContributions": ["论文现有贡献"],',
        '  "researchQuestions": ["论文试图回答的问题"],',
        '  "literaturePlan": ["建议补充的文献方向"],',
        '  "evidence": [],',
        '  "bibliography": [],',
        '  "weaknesses": ["具体弱点清单（供改进计划使用）"]',
        "}",
        "",
        "要求：如实评估，不夸大贡献；实验组织方式（Benchmark/Baseline/Ablation）缺失要点名。",
        "",
        `标题：${project.title}`,
        `目标档次：${project.targetProfile ?? "未指定"}`,
        "",
        "===== 论文（LaTeX 结构化摘要）=====",
        params.manuscriptDigest,
      ].join("\n"),
      projectId: params.projectId,
      contextScope: "research/existing-analysis",
      metadata: { role: "researcher", skill: "paper-understanding", milestone: "M3.2" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `论文理解任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "论文理解结果");
    const report: ResearchReport = {
      domainOverview: readRequiredString(parsed, "domainOverview", "论文理解结果"),
      relatedWorkDirections: readRequiredStringArray(
        parsed,
        "relatedWorkDirections",
        "论文理解结果",
        { minItems: 0 },
      ),
      researchGaps: readRequiredStringArray(parsed, "researchGaps", "论文理解结果", { minItems: 0 }),
      potentialContributions: readRequiredStringArray(
        parsed,
        "potentialContributions",
        "论文理解结果",
      ),
      researchQuestions: readRequiredStringArray(parsed, "researchQuestions", "论文理解结果", {
        minItems: 0,
      }),
      literaturePlan: readRequiredStringArray(parsed, "literaturePlan", "论文理解结果", {
        minItems: 0,
      }),
    };
    const weaknesses = readRequiredStringArray(parsed, "weaknesses", "论文理解结果", {
      minItems: 0,
    });

    // 落盘（覆盖 research.json：existing-paper 流程的“调研”即论文理解）
    const researchDir = this.projects.researchDir(params.projectId);
    await mkdir(researchDir, { recursive: true });
    const artifact: ResearchArtifact = {
      generatedAt: new Date().toISOString(),
      taskId: task.taskId,
      report,
      evidence: [],
      bibliography: [],
    };
    await writeFile(
      join(researchDir, "research.json"),
      JSON.stringify({ ...artifact, weaknesses, kind: "existing_paper_analysis" }, null, 2) + "\n",
      "utf8",
    );
    this.log(`[researcher] projectId=${params.projectId} 论文理解完成：weaknesses=${weaknesses.length}`);
    return {
      report,
      reportPath: "research/research.json",
      evidenceAppended: 0,
      bibliographyCount: 0,
      taskId: task.taskId,
      weaknesses,
      contributions: report.potentialContributions,
    };
  }
}

export type ResearchArtifact = {
  generatedAt: string;
  taskId: string;
  report: ResearchReport;
  evidence: EvidenceAppendInput[];
  bibliography: BibliographyEntryInput[];
};

export interface BibliographyEntryInput {
  key: string;
  title: string;
  authors?: string[];
  year?: number;
  doi?: string;
  url?: string;
  venue?: string;
}

/** 读取 research/research.json */
export async function readResearchArtifact(
  projects: ProjectStore,
  projectId: string,
): Promise<ResearchArtifact | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(join(projects.researchDir(projectId), "research.json"), "utf8");
    return JSON.parse(raw) as ResearchArtifact;
  } catch {
    return null;
  }
}

// ---- Prompt ----

export function buildResearchPrompt(
  project: ProjectMetadata,
  sourceDigest: string,
  extraInstructions?: string,
): string {
  return [
    "你是一名学术研究员（Researcher）。请对下面的研究 Idea 做领域调研与可行性预研。",
    "只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字），字段如下：",
    "{",
    '  "domainOverview": "领域现状综述（200-500 字）",',
    '  "relatedWorkDirections": ["相关工作方向 1", "..."],',
    '  "researchGaps": ["研究空白 1", "..."],',
    '  "potentialContributions": ["潜在贡献 1", "..."],',
    '  "researchQuestions": ["研究问题 1", "..."],',
    '  "literaturePlan": ["应补充检索的文献方向 1", "..."],',
    '  "evidence": [{"claim": "该证据支撑的观点", "summary": "证据摘要", "quote": "可选直接引文",',
    '    "source": {"title": "来源文献标题", "authors": ["作者"], "year": 2024, "doi": "可选", "url": "可选"},',
    '    "location": {"page": 1, "section": "4.2"}}],',
    '  "bibliography": [{"key": "zhang2024survey", "title": "标题", "authors": ["作者"], "year": 2024, "doi": "可选", "venue": "可选"}]',
    "}",
    "",
    "要求：",
    "1. 调研基于项目文献库（下方提供）与你的领域知识；不要编造不存在的论文。",
    "2. evidence 只包含你能给出明确来源（文献库条目或确凿的公开文献）的事实；来源不充分的不要写入 evidence。",
    "3. bibliography 的 key 使用「第一作者年份主题」格式（如 zhang2024survey），全小写字母数字。",
    "4. 你不负责写论文正文。",
    "",
    "===== 项目信息 =====",
    `标题：${project.title}`,
    `研究 Idea：${project.researchIdea ?? "（未填写，请依据标题理解）"}`,
    `研究领域：${project.researchField ?? "（未填写）"}`,
    `目标类型：${project.documentType ?? "（未填写）"}`,
    `目标档次：${project.targetProfile ?? "（未填写）"}`,
    `目标 Venue：${project.targetVenue ?? "（未填写）"}`,
    "",
    "===== 项目文献库摘要 =====",
    sourceDigest,
    ...(extraInstructions
      ? ["", "===== 用户补充说明 =====", extraInstructions]
      : []),
  ].join("\n");
}

function describeSource(item: SourceItem): string {
  const meta = item.metadata;
  const parts = [
    `- [${item.sourceId}] ${meta.title ?? item.fileName}`,
    meta.authors?.length ? `作者：${meta.authors.slice(0, 4).join(", ")}` : undefined,
    meta.year !== undefined ? `年份：${meta.year}` : undefined,
    meta.doi ? `DOI：${meta.doi}` : undefined,
    item.analysis?.status === "ok" || item.analysis?.status === "partial"
      ? `摘要：${(item.analysis.textPreview ?? "").slice(0, 400)}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join("；");
}

function readEvidenceCandidates(parsed: Record<string, unknown>): EvidenceAppendInput[] {
  const value = parsed["evidence"];
  if (!Array.isArray(value)) {
    return [];
  }
  const candidates: EvidenceAppendInput[] = [];
  for (const raw of value.slice(0, 50)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const claim = typeof record["claim"] === "string" ? record["claim"].trim() : "";
    if (claim === "") {
      continue; // 无 claim 的候选直接丢弃（校验层也会拒绝）
    }
    const source = record["source"];
    const sourceRef =
      typeof source === "object" && source !== null ? (source as Record<string, unknown>) : undefined;
    const location = record["location"];
    const locationRef =
      typeof location === "object" && location !== null ? (location as Record<string, unknown>) : undefined;
    candidates.push({
      claim,
      ...(typeof record["summary"] === "string" ? { summary: record["summary"] } : {}),
      ...(typeof record["quote"] === "string" ? { quote: record["quote"] } : {}),
      ...(sourceRef !== undefined
        ? {
            source: {
              ...(typeof sourceRef["title"] === "string" ? { title: sourceRef["title"] } : {}),
              ...(readOptionalStringArray(sourceRef, "authors") !== undefined
                ? { authors: readOptionalStringArray(sourceRef, "authors") }
                : {}),
              ...(typeof sourceRef["year"] === "number" ? { year: sourceRef["year"] } : {}),
              ...(typeof sourceRef["doi"] === "string" ? { doi: sourceRef["doi"] } : {}),
              ...(typeof sourceRef["url"] === "string" ? { url: sourceRef["url"] } : {}),
            },
          }
        : {}),
      ...(locationRef !== undefined
        ? {
            location: {
              ...(typeof locationRef["page"] === "number" ? { page: locationRef["page"] } : {}),
              ...(typeof locationRef["section"] === "string" ? { section: locationRef["section"] } : {}),
            },
          }
        : {}),
    });
  }
  return candidates;
}

function readBibliography(parsed: Record<string, unknown>): BibliographyEntryInput[] {
  const value = parsed["bibliography"];
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: BibliographyEntryInput[] = [];
  for (const raw of value.slice(0, 50)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const key = typeof record["key"] === "string" ? record["key"].trim() : "";
    const title = typeof record["title"] === "string" ? record["title"].trim() : "";
    if (key === "" || title === "" || !/^[a-zA-Z0-9_-]{2,64}$/.test(key)) {
      continue; // 非法 key 直接丢弃
    }
    entries.push({
      key,
      title,
      ...(readOptionalStringArray(record, "authors") !== undefined
        ? { authors: readOptionalStringArray(record, "authors") }
        : {}),
      ...(typeof record["year"] === "number" ? { year: record["year"] } : {}),
      ...(typeof record["doi"] === "string" ? { doi: record["doi"] } : {}),
      ...(typeof record["url"] === "string" ? { url: record["url"] } : {}),
      ...(typeof record["venue"] === "string" ? { venue: record["venue"] } : {}),
    });
  }
  // key 去重
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.key)) {
      return false;
    }
    seen.add(entry.key);
    return true;
  });
}
