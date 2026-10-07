/**
 * TargetProfileService（M12 Batch 2 · A7）：benchmark 语料 → research/target-profile.json。
 *
 * 职责：
 * 1. 确定性提取（主体）：effectivePapers → 逐篇 extractPaperStats（ParsedDocument
 *    + SourceMetadata.year）→ aggregate*（分位带；quantiles.ts 纯函数）。
 *    四维（structure/literature/experiments/visuals）零模型参与；
 * 2. bounded LLM 摘要（仅 method/writing 两维的结构模式归纳）：模型输入只有
 *    确定性聚合统计（章节模式名 / 计数 / 比例），**不含任何 benchmark 论文
 *    原文**（反抄袭红线，M12.0 §4.2-8 同款纪律）。结构化输出校验 + 至多
 *    1 次 repair（VisionAnalyzer/Feasibility 同款模式）；失败 → 两维
 *    availability=unavailable（带 summaryFailure），绝不伪造摘要；
 * 3. freshness（M12.0 §6）：stored profile 的 (benchmarkRevision,
 *    corpusFingerprint, extractorSchemaVersion) 任一 ≠ 当前 benchmark
 *    artifact / 提取器版本 → stale；get() 返回信封（fresh=false +
 *    staleReason），ensureCurrent() 显式重建——陈旧 profile 不会被静默
 *    当作当前参照系使用；
 * 4. 读容错 fail-closed：非法 JSON / 非法 schema → 抛错（「损坏」与「未
 *    生成」是两种事实；错误码沿用 INTERNAL_ERROR——专用 code 待 errors.ts
 *    统一收口，见 handoff）。
 *
 * 落盘 writeJsonAtomic；同语料 + 同提取器版本 + 同摘要结果 → 同 profile
 * （generatedAt 除外——确定性字段 golden 测试锁定）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, NotFoundError } from "../errors.js";
import { extractJsonObject } from "../agents/outputParsing.js";
import type { ParsedDocument } from "../ingestion/types.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { TargetBenchmarkService } from "./TargetBenchmarkService.js";
import {
  aggregateExperiments,
  aggregateLiterature,
  aggregateStructure,
  aggregateVisuals,
} from "./aggregate.js";
import { extractPaperStats, type PaperStats } from "./paperStats.js";
import { MIN_PROFILE_SAMPLES, round2 } from "./quantiles.js";
import { effectivePapers } from "./selection.js";
import type {
  MethodProfileDimension,
  TargetProfileEnvelope,
  TargetPublicationProfile,
  WritingProfileDimension,
} from "./types.js";

/** 提取器演进版本（freshness 键之一；提取口径变化时 +1 使全部存量 profile 失效） */
export const TARGET_EXTRACTOR_SCHEMA_VERSION = 1;

/** ---- bounded LLM 摘要 seam（pi ModelRuntime.completeSimple 形状；测试注入 scripted caller）---- */
export interface TargetModelMessage {
  content?: ReadonlyArray<{ type?: string; text?: string }>;
  usage?: { totalTokens?: number };
  stopReason?: string;
  errorMessage?: string;
}

export interface TargetModelCaller {
  completeSimple(
    model: unknown,
    context: { systemPrompt?: string; messages: unknown[] },
    options?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<TargetModelMessage>;
}

/** 摘要模型装配（serviceStack 注入：catalogEntry + 人读 spec） */
export interface TargetSummaryModel {
  caller: TargetModelCaller;
  catalogEntry: unknown;
  spec: string;
}

/** 摘要输出的确定性校验边界 */
const SUMMARY_NOTE_MIN_CHARS = 20;
const SUMMARY_NOTE_MAX_CHARS = 1_200;
const SUMMARY_MAX_TOKENS = 2_048;

const PROFILE_SYSTEM_PROMPT = [
  "你是学术写作的结构统计分析师。基于给定的「目标带论文结构统计」（纯聚合数字与章节名，不含任何论文原文），",
  "归纳目标带论文在方法呈现与写作呈现上的常见模式。要求：",
  "- 只描述可由统计支撑的模式（如「目标带论文通常设独立方法章（10/10 篇）」），不做因果断言；",
  "- 不评价任何具体论文；不虚构统计里没有的数字；",
  "只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字）。",
].join("");

export interface TargetProfileServiceOptions {
  projects: ProjectStore;
  benchmarks: TargetBenchmarkService;
  /** corpus 源解析产物读取（生产传 ParsedDocumentStore 实例） */
  parsedDocuments: { load(projectId: string, sourceId: string): Promise<ParsedDocument | null> };
  /** corpus 源元数据年份读取（生产传 SourceStore 实例的最小投影） */
  getPaperYear(projectId: string, sourceId: string): Promise<number | undefined>;
  /** bounded LLM 摘要（缺省 → method/writing 两维 unavailable，注明未配置） */
  summaryModel?: TargetSummaryModel;
  now?: () => Date;
  log?: (message: string) => void;
}

export class TargetProfileService {
  private readonly projects: ProjectStore;
  private readonly benchmarks: TargetBenchmarkService;
  private readonly parsedDocuments: TargetProfileServiceOptions["parsedDocuments"];
  private readonly getPaperYear: TargetProfileServiceOptions["getPaperYear"];
  private readonly summaryModel: TargetSummaryModel | undefined;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: TargetProfileServiceOptions) {
    this.projects = options.projects;
    this.benchmarks = options.benchmarks;
    this.parsedDocuments = options.parsedDocuments;
    this.getPaperYear = options.getPaperYear;
    this.summaryModel = options.summaryModel;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  private artifactPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "target-profile.json");
  }

  /**
   * 读 profile（信封形态）。未生成 → null；损坏 → 抛错（fail-closed）；
   * fresh=false 时消费方必须重建（ensureCurrent）而不是静默使用。
   */
  async get(projectId: string): Promise<TargetProfileEnvelope | null> {
    let raw: string;
    try {
      raw = await readFile(this.artifactPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const profile = parseTargetProfile(projectId, raw);
    const benchmark = await this.benchmarks.get(projectId);
    if (benchmark === null) {
      // benchmark artifact 被删除（如人工清理）：profile 失去参照系本体 → stale
      return { profile, fresh: false, staleReason: "corpus_fingerprint_changed" };
    }
    if (profile.benchmarkRevision !== benchmark.revision) {
      return { profile, fresh: false, staleReason: "benchmark_revision_changed" };
    }
    if (profile.corpusFingerprint !== benchmark.fingerprint) {
      return { profile, fresh: false, staleReason: "corpus_fingerprint_changed" };
    }
    if (profile.extractorSchemaVersion !== TARGET_EXTRACTOR_SCHEMA_VERSION) {
      return { profile, fresh: false, staleReason: "extractor_schema_version_changed" };
    }
    return { profile, fresh: true };
  }

  /** 确保存在且新鲜的 profile：缺失 / 陈旧 → 重建（显式动作，非静默复用） */
  async ensureCurrent(projectId: string): Promise<{ profile: TargetPublicationProfile; regenerated: boolean }> {
    const envelope = await this.get(projectId);
    if (envelope !== null && envelope.fresh) {
      return { profile: envelope.profile, regenerated: false };
    }
    if (envelope !== null) {
      this.log(
        `[target] projectId=${projectId} profile 陈旧（${envelope.staleReason}）——重建（旧：benchmarkRevision=${envelope.profile.benchmarkRevision} n=${envelope.profile.n}）`,
      );
    }
    return { profile: await this.generate(projectId), regenerated: true };
  }

  /**
   * 生成 profile（要求 benchmark artifact 已冻结）。确定性四维 + bounded
   * method/writing 摘要；生成即落盘（覆盖旧 profile——readiness 每次
   * evaluate 用的是 ensureCurrent 保证的新鲜版本）。
   */
  async generate(projectId: string): Promise<TargetPublicationProfile> {
    await this.projects.getRequired(projectId);
    const benchmark = await this.benchmarks.get(projectId);
    if (benchmark === null) {
      throw new NotFoundError(
        "target profile 的基准语料",
        `${projectId}（无 target-benchmark.json——先执行 benchmark discovery 冻结）`,
      );
    }
    const papers = effectivePapers(benchmark.papers);
    const stats: PaperStats[] = [];
    for (const paper of papers) {
      const [document, year] = await Promise.all([
        this.parsedDocuments.load(projectId, paper.sourceId),
        this.getPaperYear(projectId, paper.sourceId),
      ]);
      stats.push(extractPaperStats(paper.sourceId, document, year));
    }

    const structure = aggregateStructure(stats);
    const literature = aggregateLiterature(stats);
    const experiments = aggregateExperiments(stats);
    const visuals = aggregateVisuals(stats);
    // writing.limitationsPresent 是确定性字段（字符串判定），独立于模型摘要
    const structuralContributors = stats.filter((entry) => entry.hasParsedDoc);
    const limitationsPresent =
      structuralContributors.length > 0
        ? round2(
            structuralContributors.filter((entry) => entry.limitationsPresent).length /
              structuralContributors.length,
          )
        : undefined;
    const { method, writingBase, model, summaryFailure, summaryFields } = await this.summarizeMethodWriting(
      projectId,
      { structure, experiments, visuals },
      papers.length,
    );
    const writing: WritingProfileDimension = {
      ...writingBase,
      ...(limitationsPresent !== undefined ? { limitationsPresent } : {}),
    };

    const notes: string[] = [];
    const noDoc = stats.filter((entry) => !entry.hasParsedDoc).length;
    if (noDoc > 0) {
      notes.push(`${noDoc}/${papers.length} 篇语料论文无可用解析产物（全文未获取或解析失败）——全部维度 coverage 已如实排除`);
    }
    const yearFallback = stats.filter((entry) => entry.referenceCountByYearFallback).length;
    if (yearFallback > 0) {
      notes.push(`${yearFallback} 篇的参考文献条目数按年份计数兜底（无 [n] 标记）——可能低估`);
    }
    notes.push("dataset 广度 = 「<名称> dataset/benchmark/corpus」短语的 distinct 名称数（确定性启发式，非人工核对）");
    if (papers.length < MIN_PROFILE_SAMPLES) {
      notes.push(`语料仅 ${papers.length} 篇（< ${MIN_PROFILE_SAMPLES}）——全部维度按 insufficient 处理，readiness 将是 INSUFFICIENT_EVIDENCE`);
    }

    const profile: TargetPublicationProfile = {
      schemaVersion: 1,
      benchmarkRevision: benchmark.revision,
      corpusFingerprint: benchmark.fingerprint,
      extractorSchemaVersion: TARGET_EXTRACTOR_SCHEMA_VERSION,
      n: papers.length,
      dimensions: { structure, literature, experiments, visuals, method, writing },
      provenance: {
        deterministicFields: [
          "dimensions.structure.sectionPattern",
          "dimensions.structure.totalLengthWords",
          "dimensions.structure.abstractLengthWords",
          "dimensions.literature.citationCount",
          "dimensions.literature.citationDensity",
          "dimensions.literature.medianReferenceAgeYears",
          "dimensions.experiments.tableCount",
          "dimensions.experiments.datasetBreadth",
          "dimensions.experiments.ablationPresent",
          "dimensions.experiments.robustnessPresent",
          "dimensions.visuals.figureCount",
          "dimensions.visuals.methodDiagramPresent",
          "dimensions.writing.limitationsPresent",
        ],
        modelSummarizedFields: summaryFields,
        ...(model !== undefined ? { model } : {}),
        ...(summaryFailure !== undefined ? { summaryFailure } : {}),
      },
      generatedAt: this.now().toISOString(),
      notes,
    };
    await writeJsonAtomic(this.artifactPath(projectId), profile);
    this.log(
      `[target] projectId=${projectId} profile 生成：benchmarkRevision=${benchmark.revision} n=${profile.n}（method/writing=${method.availability}/${writing.availability}）`,
    );
    return profile;
  }

  // ---- bounded LLM 摘要（method / writing）----

  private async summarizeMethodWriting(
    projectId: string,
    deterministic: {
      structure: ReturnType<typeof aggregateStructure>;
      experiments: ReturnType<typeof aggregateExperiments>;
      visuals: ReturnType<typeof aggregateVisuals>;
    },
    corpusSize: number,
  ): Promise<{
    method: MethodProfileDimension;
    writingBase: Omit<WritingProfileDimension, "limitationsPresent">;
    model?: string;
    summaryFailure?: string;
    summaryFields: string[];
  }> {
    const unavailable = (reason: string, coverage = 0) => ({
      availability: "unavailable" as const,
      coverage,
      reason,
    });

    if (this.summaryModel === undefined || deterministic.structure.availability === "unavailable") {
      const reason =
        deterministic.structure.availability === "unavailable"
          ? "确定性结构统计不可用——无摘要输入（无解析产物语料）"
          : "摘要模型未配置（summaryModel 缺省）——method/writing 两维 UNAVAILABLE，不伪造";
      return {
        method: unavailable(reason),
        writingBase: unavailable(reason),
        summaryFields: [],
        summaryFailure: reason,
      };
    }

    // 模型输入：只有聚合统计（章节名 + 计数/比例）——零论文原文
    const summaryInput = renderSummaryInput(deterministic, corpusSize);
    let parsed: Record<string, unknown>;
    try {
      parsed = await this.callSummaryModel(summaryInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[target] projectId=${projectId} method/writing 摘要失败（两维转 UNAVAILABLE）：${message.slice(0, 200)}`);
      return {
        method: unavailable(`模型摘要失败：${message.slice(0, 300)}`),
        writingBase: unavailable(`模型摘要失败：${message.slice(0, 300)}`),
        summaryFields: [],
        summaryFailure: message.slice(0, 500),
      };
    }

    const coverage = deterministic.structure.coverage;
    const availability =
      coverage >= MIN_PROFILE_SAMPLES ? ("available" as const) : ("insufficient" as const);
    const insufficientReason =
      coverage < MIN_PROFILE_SAMPLES
        ? { reason: `结构统计仅 ${coverage} 篇有效样本（< ${MIN_PROFILE_SAMPLES}）——摘要参考意义不足` }
        : {};
    return {
      method: {
        availability,
        coverage,
        ...insufficientReason,
        depthNote: parsed["methodDepthNote"] as string,
        noveltyFramingNote: parsed["methodNoveltyNote"] as string,
      },
      writingBase: {
        availability,
        coverage,
        ...insufficientReason,
        claimStrengthNote: parsed["writingClaimStrengthNote"] as string,
        discussionDepthNote: parsed["writingDiscussionNote"] as string,
      },
      model: this.summaryModel.spec,
      summaryFields: [
        "dimensions.method.depthNote",
        "dimensions.method.noveltyFramingNote",
        "dimensions.writing.claimStrengthNote",
        "dimensions.writing.discussionDepthNote",
      ],
    };
  }

  /** 调用 + 结构化校验 + 至多 1 次 repair（违约反馈回模型）；仍失败 → 抛错（上层转 UNAVAILABLE） */
  private async callSummaryModel(summaryInput: string): Promise<Record<string, unknown>> {
    const model = this.summaryModel!;
    const messages = (): unknown[] => [
      { role: "user", content: [{ type: "text", text: summaryInput }], timestamp: Date.now() },
    ];
    const call = async (): Promise<string> => {
      const message = await model.caller.completeSimple(
        model.catalogEntry,
        { systemPrompt: PROFILE_SYSTEM_PROMPT, messages: messages() },
        { maxTokens: SUMMARY_MAX_TOKENS },
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
    let output: Record<string, unknown>;
    try {
      output = validateSummaryOutput(extractJsonObject(await call(), "目标结构模式摘要"));
    } catch (firstError) {
      const violation = firstError instanceof Error ? firstError.message : String(firstError);
      this.log(`[target] 摘要结构化校验失败（repair 一次）：${violation.slice(0, 160)}`);
      const repairedText = await call();
      try {
        output = validateSummaryOutput(extractJsonObject(repairedText, "目标结构模式摘要（repair）"));
      } catch (secondError) {
        throw new Error(
          `结构化输出解析失败（含 1 次 repair）：${
            secondError instanceof Error ? secondError.message : String(secondError)
          }（首次违约：${violation.slice(0, 200)}）`,
        );
      }
    }
    return output;
  }
}

/** 摘要输入（纯聚合统计；零论文原文——反抄袭红线） */
function renderSummaryInput(
  deterministic: {
    structure: ReturnType<typeof aggregateStructure>;
    experiments: ReturnType<typeof aggregateExperiments>;
    visuals: ReturnType<typeof aggregateVisuals>;
  },
  corpusSize: number,
): string {
  const pattern = Object.entries(deterministic.structure.sectionPattern)
    .map(([name, entry]) => `${name}(present ${entry.present}/${corpusSize}, median ${entry.medianLengthWords} 词)`)
    .join("；");
  return [
    `目标带论文结构统计（benchmark 语料 ${corpusSize} 篇的聚合；不含任何论文原文）：`,
    `章节模式：${pattern || "（无节标题统计）"}`,
    `正文总词数：${describeDist(deterministic.structure.totalLengthWords)}`,
    `摘要词数：${describeDist(deterministic.structure.abstractLengthWords)}`,
    `表格数：${describeDist(deterministic.experiments.tableCount)}；含 ablation 表述的论文比例：${deterministic.experiments.ablationPresent ?? "不可用"}`,
    `图数：${describeDist(deterministic.visuals.figureCount)}；含方法总览图比例：${deterministic.visuals.methodDiagramPresent ?? "不可用"}`,
    "",
    "请输出 JSON：{",
    '  "methodDepthNote": "方法章的常见组织模式（80–300 字，基于上述统计归纳）",',
    '  "methodNoveltyNote": "贡献定位/新颖性框定的常见模式（80–300 字）",',
    '  "writingClaimStrengthNote": "论断强度与证据措辞的常见模式（80–300 字）",',
    '  "writingDiscussionNote": "讨论/结论深度的常见模式（80–300 字）"',
    "}",
  ].join("\n");
}

function describeDist(dist: { min: number; p25: number; median: number; p75: number; max: number; n: number } | undefined): string {
  if (dist === undefined) {
    return "不可用";
  }
  return `p25–p75 ${dist.p25}–${dist.p75}（min–max ${dist.min}–${dist.max}，n=${dist.n}）`;
}

/** 摘要四字段校验（缺字段/空串/超长 → 抛结构化错误触发 repair） */
function validateSummaryOutput(parsed: Record<string, unknown>): Record<string, unknown> {
  const fields = ["methodDepthNote", "methodNoveltyNote", "writingClaimStrengthNote", "writingDiscussionNote"];
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value !== "string" || value.trim().length < SUMMARY_NOTE_MIN_CHARS) {
      throw new Error(`字段 ${field} 缺失或过短（≥ ${SUMMARY_NOTE_MIN_CHARS} 字）`);
    }
    if (value.length > SUMMARY_NOTE_MAX_CHARS) {
      throw new Error(`字段 ${field} 超长（≤ ${SUMMARY_NOTE_MAX_CHARS} 字）`);
    }
  }
  return parsed;
}

/** 解析 + 结构校验（fail-closed；宽容读：provenance/notes 可缺省） */
function parseTargetProfile(projectId: string, raw: string): TargetPublicationProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw profileCorrupted(projectId, "不是合法 JSON");
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (record === null) {
    throw profileCorrupted(projectId, "顶层不是对象");
  }
  const dimensions = record["dimensions"];
  if (typeof dimensions !== "object" || dimensions === null) {
    throw profileCorrupted(projectId, "缺少 dimensions");
  }
  if (record["schemaVersion"] !== 1) {
    throw profileCorrupted(projectId, `不支持的 schemaVersion=${String(record["schemaVersion"])}`);
  }
  if (typeof record["benchmarkRevision"] !== "number" || typeof record["corpusFingerprint"] !== "string") {
    throw profileCorrupted(projectId, "缺少 freshness 键（benchmarkRevision/corpusFingerprint）");
  }
  if (typeof record["extractorSchemaVersion"] !== "number" || typeof record["n"] !== "number") {
    throw profileCorrupted(projectId, "缺少 extractorSchemaVersion/n");
  }
  return parsed as TargetPublicationProfile;
}

function profileCorrupted(projectId: string, detail: string): BusinessError {
  return new BusinessError(
    "TARGET_PROFILE_CORRUPTED",
    `项目 ${projectId} 的 target-profile.json 损坏（${detail}）——拒绝降级解读，请删除后重新生成（target.profile stage / ensureCurrent 均可）`,
  );
}
