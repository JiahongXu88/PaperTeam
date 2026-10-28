/**
 * TargetRubricService（M15.9 · Phase E G2）：目标期刊级 evidence-grounded 质量 rubric（advisory）。
 *
 * 定位与红线（任务书 §5.2/§6）：
 * - 与 benchmark 分位带**分开存储、分开评估**：rubric 是「期刊范围/文章类型/
 *   学术质量维度」的模型判 advisory，输入携带 venue 官方范围陈述 + 文章类型
 *   语义（综述不按"缺新实验"判 FAIL）+ 可选 benchmark 带摘要（A2 消融臂可
 *   关闭——bandDigest=undefined 即 A3 形态）；
 * - evidence-grounded：每个维度判定必须给出稿件内可定位引文（evidenceQuotes）
 *   或明确 INSUFFICIENT_EVIDENCE；范围判定必须引用官方范围陈述；
 * - NEEDS_EXPERT_REVIEW 通道：创新性/贡献等定性维度默认携带专家复核标记——
 *   模型判断是候选评价，不是专家金标准（任务书 §5）；
 * - 零 Gate 接线：本服务产物不进任何 Quality Gate 规则（gates.ts 零改动）；
 * - bounded：单次调用 + 至多 1 次 repair（TargetProfileService 同款模式）；
 *   失败 → 整体 INSUFFICIENT_EVIDENCE + summaryFailure，不伪造。
 *
 * 产物：research/target-rubric.json（inputFingerprint 变化 → 陈旧，须重评）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NotFoundError } from "../errors.js";
import { extractJsonObject } from "../agents/outputParsing.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { collectLatexFiles } from "../manuscript/LatexFiles.js";
import type { TargetSummaryModel } from "./TargetProfileService.js";
import type { TargetPublicationProfile } from "./types.js";
import type { VenueGuidelineArtifact } from "./guidelineTypes.js";
import { describeBand } from "./quantiles.js";

export const RUBRIC_PROMPT_VERSION = "m159-rubric-v1";

/** 稿件摘录上限（字符）——scope/质量维度判定的输入面；超出截断并披露 */
const MANUSCRIPT_DIGEST_MAX_CHARS = 16_000;
const RUBRIC_MAX_TOKENS = 3_000;

const RUBRIC_SYSTEM_PROMPT = [
  "你是学术投稿准备度评审顾问（advisory，不是录用判断）。基于给定的目标期刊官方范围陈述与稿件摘录，",
  "按维度输出结构化评估。纪律：",
  "- 每个维度的判定必须给出稿件内可定位的引文片段（evidenceQuotes，逐字摘自输入），否则判 INSUFFICIENT_EVIDENCE；",
  "- 不虚构稿件中不存在的内容；不编造期刊未写明的要求；",
  "- 范围（relevance）判定必须依据期刊官方范围陈述，并引用其栏目/范围原文；",
  "- 创新性（novelty）与贡献（contribution）是定性判断：如给出非 INSUFFICIENT 判定，必须同时置 needsExpertReview=true；",
  "- 文章类型语义：综述类稿件的实验充分性维度按「文献覆盖与比较深度」评估，不按「缺少新实验」降档；",
  "研究论文如缺真实关键实验，experimentalAdequacy 不得高于 WEAK；",
  "- 只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字）。",
].join("");

export type RubricVerdict = "STRONG" | "ADEQUATE" | "WEAK" | "INSUFFICIENT_EVIDENCE";

export interface RubricDimensionResult {
  dimension: string;
  verdict: RubricVerdict;
  evidenceQuotes: string[];
  gaps: string[];
  needsExpertReview: boolean;
}

export interface TargetRubricArtifact {
  schemaVersion: 1;
  venueId: string;
  promptVersion: string;
  model?: string;
  evaluatedAt: string;
  manuscriptRevision: number | null;
  documentType: string;
  /** 是否携带 benchmark 带摘要（A2=true / A3=false 消融） */
  withBenchmarkBands: boolean;
  dimensions: RubricDimensionResult[];
  scopeRelevance: {
    inScope: boolean | null;
    evidence: string;
    columnMatch?: string;
  };
  overall: { verdict: RubricVerdict | "NEEDS_EXPERT_REVIEW"; rationale: string };
  summaryFailure?: string;
  inputFingerprint: {
    guidelineFrozenAt: string;
    manuscriptDigestSha256: string;
    scopeStatementSha256: string;
    benchmarkBandsIncluded: boolean;
    promptVersion: string;
    model?: string;
  };
  provenance: {
    basis: "model_judgment_advisory";
    disclaimer: string;
  };
}

export interface TargetRubricServiceOptions {
  projects: ProjectStore;
  /** bounded LLM（缺省 → INSUFFICIENT_EVIDENCE + summaryFailure，不伪造） */
  rubricModel?: TargetSummaryModel;
  currentRevision?: (projectId: string) => Promise<number>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface EvaluateRubricOptions {
  /** A3 消融：不携带 benchmark 带（缺省携带 = A2 形态） */
  omitBenchmarkBands?: boolean;
  manuscriptRevision?: number | null;
}

export class TargetRubricService {
  private readonly projects: ProjectStore;
  private readonly rubricModel: TargetSummaryModel | undefined;
  private readonly currentRevision: ((projectId: string) => Promise<number>) | undefined;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: TargetRubricServiceOptions) {
    this.projects = options.projects;
    this.rubricModel = options.rubricModel;
    this.currentRevision = options.currentRevision;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  private artifactPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "target-rubric.json");
  }

  async get(projectId: string): Promise<TargetRubricArtifact | null> {
    let raw: string;
    try {
      raw = await readFile(this.artifactPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return JSON.parse(raw) as TargetRubricArtifact;
  }

  /** 模型 rubric 评估（guideline 工件必须先冻结——scope 判据来源） */
  async evaluate(
    projectId: string,
    guideline: VenueGuidelineArtifact,
    options: EvaluateRubricOptions = {},
  ): Promise<TargetRubricArtifact> {
    await this.projects.getRequired(projectId);
    const withBands = options.omitBenchmarkBands !== true;
    const files = await collectLatexFiles(this.projects.manuscriptDir(projectId));
    const manuscriptRevision =
      options.manuscriptRevision !== undefined
        ? options.manuscriptRevision
        : this.currentRevision !== undefined
          ? await this.currentRevision(projectId)
          : null;
    if (files.allTex.length === 0) {
      throw new NotFoundError(
        "待评手稿",
        `${projectId}（manuscript 目录无 .tex——rubric 无输入）`,
      );
    }
    const digest = renderManuscriptDigest(files.allTex.map((file) => ({ path: file.relativePath, content: file.content })));
    const documentType = await readDocumentType(this.projects, projectId);
    const bands = withBands ? await renderBandDigest(this.projects, projectId) : null;

    const artifact = await this.callRubric({
      projectId,
      digest,
      guideline,
      documentType,
      bands,
      withBands,
      manuscriptRevision,
    });
    await writeJsonAtomic(this.artifactPath(projectId), artifact);
    this.log(
      `[target] projectId=${projectId} rubric 评估：venue=${guideline.venueId} overall=${artifact.overall.verdict} bands=${withBands}`,
    );
    return artifact;
  }

  private async callRubric(input: {
    projectId: string;
    digest: string;
    guideline: VenueGuidelineArtifact;
    documentType: string;
    bands: string | null;
    withBands: boolean;
    manuscriptRevision: number | null;
  }): Promise<TargetRubricArtifact> {
    const { createHash } = await import("node:crypto");
    const fingerprint: TargetRubricArtifact["inputFingerprint"] = {
      guidelineFrozenAt: input.guideline.frozenAt,
      manuscriptDigestSha256: createHash("sha256").update(input.digest).digest("hex").slice(0, 16),
      scopeStatementSha256: createHash("sha256")
        .update(`${input.guideline.venueId}|${input.guideline.scope.scopeStatement ?? ""}|${(input.guideline.scope.columnsZh ?? []).join(",")}`)
        .digest("hex")
        .slice(0, 16),
      benchmarkBandsIncluded: input.withBands,
      promptVersion: RUBRIC_PROMPT_VERSION,
      ...(this.rubricModel !== undefined ? { model: this.rubricModel.spec } : {}),
    };
    const base = {
      schemaVersion: 1 as const,
      venueId: input.guideline.venueId,
      promptVersion: RUBRIC_PROMPT_VERSION,
      ...(this.rubricModel !== undefined ? { model: this.rubricModel.spec } : {}),
      evaluatedAt: this.now().toISOString(),
      manuscriptRevision: input.manuscriptRevision,
      documentType: input.documentType,
      withBenchmarkBands: input.withBands,
      inputFingerprint: fingerprint,
      provenance: {
        basis: "model_judgment_advisory" as const,
        disclaimer:
          "本评估是模型在官方范围陈述 + 稿件摘录（截断披露）上的候选判断（advisory）：不构成录用判断或专家意见；创新性/贡献等定性维度默认需专家复核；未进入任何质量门禁。",
      },
    };
    if (this.rubricModel === undefined) {
      const reason = "rubric 模型未配置（rubricModel 缺省）——整体 INSUFFICIENT_EVIDENCE，不伪造";
      this.log(`[target] projectId=${input.projectId} rubric 未评估：${reason}`);
      return {
        ...base,
        dimensions: [],
        scopeRelevance: { inScope: null, evidence: "（模型未配置——未评估）" },
        overall: { verdict: "INSUFFICIENT_EVIDENCE", rationale: reason },
        summaryFailure: reason,
      };
    }
    const prompt = renderRubricPrompt(input.digest, input.guideline, input.documentType, input.bands);
    let parsed: Record<string, unknown>;
    try {
      parsed = await this.callModel(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[target] projectId=${input.projectId} rubric 调用失败（整体 INSUFFICIENT_EVIDENCE）：${message.slice(0, 200)}`);
      return {
        ...base,
        dimensions: [],
        scopeRelevance: { inScope: null, evidence: "（模型调用失败——未评估）" },
        overall: { verdict: "INSUFFICIENT_EVIDENCE", rationale: `模型调用失败：${message.slice(0, 300)}` },
        summaryFailure: message.slice(0, 500),
      };
    }
    const dimensions = parseDimensions(parsed);
    const scopeRelevance = parseScope(parsed);
    const overall = parseOverall(parsed);
    return { ...base, dimensions, scopeRelevance, overall };
  }

  /** 单次调用 + 至多 1 次 repair；结构化校验失败两次 → 抛错（上层转整体 INSUFFICIENT） */
  private async callModel(prompt: string): Promise<Record<string, unknown>> {
    const model = this.rubricModel!;
    const call = async (): Promise<string> => {
      const message = await model.caller.completeSimple(
        model.catalogEntry,
        {
          systemPrompt: RUBRIC_SYSTEM_PROMPT,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
        },
        { maxTokens: RUBRIC_MAX_TOKENS },
      );
      const text = (message.content ?? [])
        .filter((part) => part.type === "text" || part.type === undefined)
        .map((part) => part.text ?? "")
        .join("")
        .trim();
      if (text === "") {
        throw new Error("模型返回空内容");
      }
      return text;
    };
    try {
      return validateRubricOutput(extractJsonObject(await call(), "目标期刊 rubric 评估"));
    } catch (firstError) {
      const violation = firstError instanceof Error ? firstError.message : String(firstError);
      this.log(`[target] rubric 结构化校验失败（repair 一次）：${violation.slice(0, 160)}`);
      try {
        return validateRubricOutput(extractJsonObject(await call(), "目标期刊 rubric 评估（repair）"));
      } catch (secondError) {
        throw new Error(
          `rubric 结构化输出解析失败（含 1 次 repair）：${secondError instanceof Error ? secondError.message : String(secondError)}`,
        );
      }
    }
  }
}

// ---- 输入渲染 ----

/** 稿件摘录：main.tex 先行 + 各节标题与正文（截断到上限并披露） */
export function renderManuscriptDigest(files: ReadonlyArray<{ path: string; content: string }>): string {
  const main = files.find((file) => file.path === "main.tex") ?? files[0]!;
  const sections = files.filter((file) => file !== main);
  const parts = [
    `【main.tex】\n${main.content}`,
    ...sections.map((file) => `【${file.path}】\n${file.content}`),
  ];
  let text = parts.join("\n\n").replace(/\r\n/g, "\n");
  const truncated = text.length > MANUSCRIPT_DIGEST_MAX_CHARS;
  if (truncated) {
    text = text.slice(0, MANUSCRIPT_DIGEST_MAX_CHARS);
  }
  return `${text}${truncated ? `\n\n【截断披露：稿件摘录超 ${MANUSCRIPT_DIGEST_MAX_CHARS} 字符，已截断；后文内容未参与评估】` : ""}`;
}

function renderRubricPrompt(
  digest: string,
  guideline: VenueGuidelineArtifact,
  documentType: string,
  bands: string | null,
): string {
  const scopeLines = [
    guideline.scope.scopeStatement !== undefined ? `期刊范围陈述：${guideline.scope.scopeStatement}` : "",
    (guideline.scope.columnsZh ?? []).length > 0 ? `常设栏目：${guideline.scope.columnsZh!.join("、")}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return [
    `目标期刊：${guideline.displayName}（venueId=${guideline.venueId}）`,
    scopeLines || "（官方范围陈述缺失——relevance 维度判 INSUFFICIENT_EVIDENCE）",
    `文章类型：${documentType}`,
    bands !== null ? `\n${bands}` : "",
    "",
    "===== 稿件摘录（LaTeX 源，可能截断）=====",
    digest,
    "",
    "请输出 JSON：{",
    '  "dimensions": [六个对象，dimension 依次为 novelty / contribution / technicalSoundness / experimentalAdequacy / relevance / clarity，',
    '    每个对象含 verdict(STRONG|ADEQUATE|WEAK|INSUFFICIENT_EVIDENCE)、evidenceQuotes(稿件逐字引文数组，可为空)、',
    '    gaps(具体差距数组，可为空)、needsExpertReview(布尔)]},',
    '  "scopeRelevance": { "inScope": 布尔或null, "evidence": "依据（引用范围陈述或稿件原文）", "columnMatch": "最接近的栏目（可缺省)" },',
    '  "overall": { "verdict": "STRONG|ADEQUATE|WEAK|INSUFFICIENT_EVIDENCE|NEEDS_EXPERT_REVIEW", "rationale": "总评（≤200字）" }',
    "}",
  ]
    .filter((line) => line !== "" || true)
    .join("\n");
}

/** benchmark 带摘要（A2 输入；profile 缺失 → 如实说明） */
async function renderBandDigest(projects: ProjectStore, projectId: string): Promise<string | null> {
  try {
    const raw = await readFile(join(projects.researchDir(projectId), "target-profile.json"), "utf8");
    const profile = JSON.parse(raw) as TargetPublicationProfile;
    const lines = [
      "===== 目标带参照（benchmark 观测，非官方投稿要求；n=" + profile.n + "）=====",
    ];
    const structure = profile.dimensions.structure;
    if (structure.totalLengthWords !== undefined) {
      lines.push(`- 正文词数带：${describeBand("", structure.totalLengthWords)}`);
    }
    if (structure.abstractLengthWords !== undefined) {
      lines.push(`- 摘要词数带：${describeBand("", structure.abstractLengthWords)}`);
    }
    if (profile.dimensions.experiments.tableCount !== undefined) {
      lines.push(`- 表格数带：${describeBand("", profile.dimensions.experiments.tableCount)}；含 ablation 论文比例 ${Math.round((profile.dimensions.experiments.ablationPresent ?? 0) * 100)}%`);
    }
    if (profile.dimensions.visuals.figureCount !== undefined) {
      lines.push(`- 图数带：${describeBand("", profile.dimensions.visuals.figureCount)}`);
    }
    if (profile.dimensions.literature.citationCount !== undefined) {
      lines.push(`- 参考文献条目数带：${describeBand("", profile.dimensions.literature.citationCount)}`);
    }
    return lines.join("\n");
  } catch {
    return "（benchmark profile 不存在——该期刊语料观测带不可用；分位带参照维度按证据不足处理）";
  }
}

async function readDocumentType(projects: ProjectStore, projectId: string): Promise<string> {
  const metadata = await projects.get(projectId);
  return metadata?.documentType ?? "unknown";
}

// ---- 输出解析与校验 ----

const RUBRIC_DIMENSIONS = ["novelty", "contribution", "technicalSoundness", "experimentalAdequacy", "relevance", "clarity"] as const;
const RUBRIC_VERDICTS: ReadonlySet<string> = new Set(["STRONG", "ADEQUATE", "WEAK", "INSUFFICIENT_EVIDENCE"]);

function parseDimensions(parsed: Record<string, unknown>): RubricDimensionResult[] {
  const raw = Array.isArray(parsed["dimensions"]) ? (parsed["dimensions"] as Array<Record<string, unknown>>) : [];
  const byName = new Map<string, RubricDimensionResult>();
  for (const entry of raw) {
    const dimension = typeof entry["dimension"] === "string" ? entry["dimension"] : undefined;
    const verdict = typeof entry["verdict"] === "string" && RUBRIC_VERDICTS.has(entry["verdict"]) ? (entry["verdict"] as RubricVerdict) : "INSUFFICIENT_EVIDENCE";
    if (dimension === undefined) {
      continue;
    }
    byName.set(dimension, {
      dimension,
      verdict,
      evidenceQuotes: Array.isArray(entry["evidenceQuotes"])
        ? (entry["evidenceQuotes"] as unknown[]).filter((q): q is string => typeof q === "string").slice(0, 6)
        : [],
      gaps: Array.isArray(entry["gaps"])
        ? (entry["gaps"] as unknown[]).filter((g): g is string => typeof g === "string").slice(0, 8)
        : [],
      needsExpertReview: entry["needsExpertReview"] === true || dimension === "novelty" || dimension === "contribution",
    });
  }
  // 缺维如实补 INSUFFICIENT_EVIDENCE（不发明）
  return RUBRIC_DIMENSIONS.map(
    (dimension) =>
      byName.get(dimension) ?? {
        dimension,
        verdict: "INSUFFICIENT_EVIDENCE" as const,
        evidenceQuotes: [],
        gaps: [],
        needsExpertReview: dimension === "novelty" || dimension === "contribution",
      },
  );
}

function parseScope(parsed: Record<string, unknown>): TargetRubricArtifact["scopeRelevance"] {
  const raw = typeof parsed["scopeRelevance"] === "object" && parsed["scopeRelevance"] !== null ? (parsed["scopeRelevance"] as Record<string, unknown>) : {};
  const inScope = typeof raw["inScope"] === "boolean" ? raw["inScope"] : null;
  return {
    inScope,
    evidence: typeof raw["evidence"] === "string" ? raw["evidence"].slice(0, 800) : "（模型未给出范围依据）",
    ...(typeof raw["columnMatch"] === "string" && raw["columnMatch"] !== "" ? { columnMatch: raw["columnMatch"].slice(0, 60) } : {}),
  };
}

function parseOverall(parsed: Record<string, unknown>): TargetRubricArtifact["overall"] {
  const raw = typeof parsed["overall"] === "object" && parsed["overall"] !== null ? (parsed["overall"] as Record<string, unknown>) : {};
  const verdict =
    typeof raw["verdict"] === "string" && (RUBRIC_VERDICTS.has(raw["verdict"]) || raw["verdict"] === "NEEDS_EXPERT_REVIEW")
      ? (raw["verdict"] as TargetRubricArtifact["overall"]["verdict"])
      : "INSUFFICIENT_EVIDENCE";
  return {
    verdict,
    rationale: typeof raw["rationale"] === "string" ? raw["rationale"].slice(0, 600) : "（模型未给出总评理由）",
  };
}

function validateRubricOutput(parsed: Record<string, unknown>): Record<string, unknown> {
  // 维数放宽到 ≥1：缺维由 parseDimensions 如实补 INSUFFICIENT_EVIDENCE（不发明）；
  // 结构性缺失（无 dimensions/scopeRelevance/overall）才触发 repair。
  if (!Array.isArray(parsed["dimensions"]) || (parsed["dimensions"] as unknown[]).length < 1) {
    throw new Error("dimensions 需为非空数组");
  }
  if (typeof parsed["scopeRelevance"] !== "object" || parsed["scopeRelevance"] === null) {
    throw new Error("缺 scopeRelevance");
  }
  if (typeof parsed["overall"] !== "object" || parsed["overall"] === null) {
    throw new Error("缺 overall");
  }
  return parsed;
}
