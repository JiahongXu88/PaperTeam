/**
 * M14.6：MissingMaterialService —— 有界模型提案（B 类 proposed_scope_gap，可选）。
 *
 * 模型只能"建议"研究范围差距：提案必须落在给定的 storyline / 贡献 / 输入上；
 * 不套固定学位论文章节模板；不把"作者缺某个实验"当事实断言；relatedChapterId
 * 只能是给定章 id 或 null。解析层确定性校验（未知章 id 丢弃并记录原因、≤6 条、
 * 标题 ≤80 字），并入账本时状态恒为 proposed——模型输出无法改变任何状态。
 */

import { extractJsonObject } from "../agents/outputParsing.js";
import { AgentRunFailedError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { AgentRuntime } from "../runtime/types.js";
import { MissingMaterialLedger, missingMaterialFingerprint, missingMaterialGapId } from "./MissingMaterialLedger.js";
import {
  REQUIRED_MATERIAL_KINDS,
  type MissingMaterialGapProposal,
  type RequiredMaterial,
  type RequiredMaterialKind,
  type UpsertProposalsResult,
} from "./missingMaterialTypes.js";
import type { ResearchInputSummary } from "./researchInputTypes.js";
import type { ThesisChapterPlan, ThesisContribution, ThesisStoryline } from "./thesisWorkflowTypes.js";

export const MAX_SCOPE_GAP_PROPOSALS = 6;
export const MAX_SCOPE_GAP_TITLE_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 1_000;
const MAX_REQUIRED_MATERIALS = 6;
export const MISSING_MATERIAL_CONTEXT_SCOPE = "thesis/missing-material";

export interface MissingMaterialServiceOptions {
  runtime: AgentRuntime;
  agentId: string;
  ledger: MissingMaterialLedger;
  projects: ProjectStore;
  log?: (message: string) => void;
}

export interface ScopeGapProposalPromptInput {
  documentType: string;
  storyline: ThesisStoryline | null;
  chapters: readonly ThesisChapterPlan[];
  contributions: readonly ThesisContribution[];
  inputs: readonly ResearchInputSummary[];
  language: "zh";
}

export interface ParseScopeGapContext {
  chapterIds: ReadonlySet<string>;
  /** 章 id → 中文标题（可选；用于填 chapterTitleZh） */
  chapterTitles?: ReadonlyMap<string, string>;
  projectId: string;
  fingerprintBase: {
    outlineFingerprint: string;
    sourceInputs: ReadonlyArray<{ inputId: string; contentHash: string }>;
  };
}

export interface ParseScopeGapResult {
  proposals: MissingMaterialGapProposal[];
  /** 被丢弃的提案及原因（审计用） */
  rejected: string[];
}

export interface ProposeScopeGapsResult extends ParseScopeGapResult {
  accepted: UpsertProposalsResult;
  taskId: string;
}

export class MissingMaterialService {
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly ledger: MissingMaterialLedger;
  private readonly projects: ProjectStore;
  private readonly log: (message: string) => void;

  constructor(options: MissingMaterialServiceOptions) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.ledger = options.ledger;
    this.projects = options.projects;
    this.log = options.log ?? (() => {});
  }

  /** 一次模型调用 → 解析校验 → 以 proposed 并入账本。永不推进状态。 */
  async proposeScopeGaps(
    projectId: string,
    input: ScopeGapProposalPromptInput & { outlineFingerprint: string; signal?: AbortSignal },
  ): Promise<ProposeScopeGapsResult> {
    await this.projects.getRequired(projectId);
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: buildScopeGapProposalPrompt(input),
      projectId,
      contextScope: MISSING_MATERIAL_CONTEXT_SCOPE,
      language: input.language,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      metadata: { role: "researcher", skill: "thesis-missing-material" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `研究范围差距提案任务以 ${task.status} 状态结束`);
    }
    const parsed = parseScopeGapProposals(task.output ?? "", {
      chapterIds: new Set(input.chapters.map((chapter) => chapter.chapterId)),
      chapterTitles: new Map(input.chapters.map((chapter) => [chapter.chapterId, chapter.titleZh])),
      projectId,
      fingerprintBase: {
        outlineFingerprint: input.outlineFingerprint,
        sourceInputs: input.inputs.map((item) => ({ inputId: item.inputId, contentHash: item.contentHash })),
      },
    });
    const accepted = await this.ledger.upsertProposals(projectId, parsed.proposals);
    this.log(
      `[missing-material] ${projectId} 范围差距提案：接受 ${parsed.proposals.length}（新建 ${accepted.created}）、丢弃 ${parsed.rejected.length}；task=${task.taskId}`,
    );
    return { ...parsed, accepted, taskId: task.taskId };
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildScopeGapProposalPrompt(input: ScopeGapProposalPromptInput): string {
  const inputLines = input.inputs.map(
    (item) => `- ${item.inputId}「${item.title}」（${item.inputType}${item.versionLabel !== undefined ? `，${item.versionLabel}` : ""}）`,
  );
  const contributionLines = input.contributions.map((item) => `- ${item.id} [${item.kind}] ${item.statement}（来源 ${item.researchInputId}）`);
  const chapterLines = input.chapters.map(
    (chapter) =>
      `- ${chapter.chapterId}「${chapter.titleZh}」（${chapter.responsibility}）拥有贡献：${chapter.ownsContributionIds.join("、") || "无"}；来源输入：${chapter.sourceInputIds.join("、") || "无"}`,
  );
  const storylineLines =
    input.storyline === null
      ? ["（尚未规划主线）"]
      : [
          `结构：${input.storyline.structure}`,
          `叙事：${input.storyline.narrative}`,
          ...(input.storyline.scopeConcerns !== undefined && input.storyline.scopeConcerns.length > 0
            ? ["Planner 自述的范围问题：", ...input.storyline.scopeConcerns.map((item, index) => `  ${index + 1}. ${item}`)]
            : []),
        ];
  return [
    `你是学位论文规划顾问。文档类型：${input.documentType}。请基于下面给定的研究主线、已确认贡献、章节规划与研究输入，判断"研究范围是否足以支撑这篇学位论文"，并给出至多 ${MAX_SCOPE_GAP_PROPOSALS} 条范围差距建议。`,
    "",
    "研究输入：",
    ...(inputLines.length > 0 ? inputLines : ["（无）"]),
    "",
    "已确认研究贡献：",
    ...(contributionLines.length > 0 ? contributionLines : ["（无）"]),
    "",
    "研究主线：",
    ...storylineLines,
    "",
    "章节规划：",
    ...(chapterLines.length > 0 ? chapterLines : ["（无）"]),
    "",
    "纪律（违反即无效）：",
    "1. 只提出能在上述主线 / 贡献 / 输入中找到依据的范围差距；不得凭空补全。",
    "2. 不要假设固定的学位论文章节模板（如「必须有对比实验章 / 消融章」）；章节结构以给定规划为准。",
    "3. 不得把「作者缺少某个具体实验」当作事实断言——只能写成「建议作者确认是否……」。",
    "4. 每条建议都需要作者确认才会生效；你没有权限确认任何缺失，也不要输出状态字段。",
    "5. relatedChapterId 只能是上面给出的章 id 之一，或 null。",
    `6. title ≤ ${MAX_SCOPE_GAP_TITLE_CHARS} 字；description 说明依据；whyInsufficient 说明现有材料为何可能不足。`,
    `7. requiredMaterials.kind 只能取：${REQUIRED_MATERIAL_KINDS.join(" / ")}。`,
    "",
    "只输出一个 JSON 对象，不要其他文字：",
    '{"proposals":[{"title":"…","description":"…","whyInsufficient":"…","relatedChapterId":"章id或null","requiredMaterials":[{"kind":"author_confirmation","description":"…"}],"requiresExperiment":false,"canWriteWithoutMaterial":true}]}',
    "若研究范围足以支撑，输出 {\"proposals\":[]}。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 解析（确定性校验）
// ---------------------------------------------------------------------------

export function parseScopeGapProposals(raw: string, context: ParseScopeGapContext): ParseScopeGapResult {
  const object = extractJsonObject(raw, "研究范围差距提案");
  const items = Array.isArray(object["proposals"]) ? (object["proposals"] as unknown[]) : [];
  const proposals: MissingMaterialGapProposal[] = [];
  const rejected: string[] = [];
  const seenIds = new Set<string>();

  items.forEach((item, index) => {
    const label = `proposals[${index}]`;
    if (item === null || typeof item !== "object") {
      rejected.push(`${label}：不是对象`);
      return;
    }
    const record = item as Record<string, unknown>;
    const title = typeof record["title"] === "string" ? collapseWs(record["title"]) : "";
    if (title === "") {
      rejected.push(`${label}：缺少 title`);
      return;
    }
    const description = typeof record["description"] === "string" ? record["description"].trim().slice(0, MAX_DESCRIPTION_CHARS) : "";
    if (description === "") {
      rejected.push(`${label}：缺少 description`);
      return;
    }
    const relatedRaw = record["relatedChapterId"];
    let chapterId: string | undefined;
    if (relatedRaw !== undefined && relatedRaw !== null) {
      if (typeof relatedRaw !== "string" || !context.chapterIds.has(relatedRaw)) {
        rejected.push(`${label}：relatedChapterId ${JSON.stringify(relatedRaw)} 不在章节规划中（模型不得发明章节）`);
        return;
      }
      chapterId = relatedRaw;
    }
    if (proposals.length >= MAX_SCOPE_GAP_PROPOSALS) {
      rejected.push(`${label}：超过上限 ${MAX_SCOPE_GAP_PROPOSALS} 条`);
      return;
    }
    const clippedTitle = title.length > MAX_SCOPE_GAP_TITLE_CHARS ? `${title.slice(0, MAX_SCOPE_GAP_TITLE_CHARS - 1)}…` : title;
    const gapId = missingMaterialGapId("proposed_scope_gap", chapterId, clippedTitle);
    if (seenIds.has(gapId)) {
      rejected.push(`${label}：与前一条提案重复（${gapId}）`);
      return;
    }
    seenIds.add(gapId);

    const whyInsufficient =
      typeof record["whyInsufficient"] === "string" && record["whyInsufficient"].trim() !== ""
        ? record["whyInsufficient"].trim().slice(0, MAX_DESCRIPTION_CHARS)
        : "模型建议研究范围可能不足；这是建议，不是已确认缺失。";
    const requiredMaterials = parseRequiredMaterials(record["requiredMaterials"]);
    if (!requiredMaterials.some((material) => material.kind === "author_confirmation")) {
      requiredMaterials.push({ kind: "author_confirmation", description: "作者确认该范围建议是否成立；确认后再生成具体材料需求" });
    }
    const chapterTitleZh = chapterId !== undefined ? context.chapterTitles?.get(chapterId) : undefined;

    proposals.push({
      gapId,
      gapType: "proposed_scope_gap",
      origin: "model_proposal",
      ...(chapterId !== undefined ? { chapterId } : {}),
      ...(chapterTitleZh !== undefined ? { chapterTitleZh } : {}),
      contributionIds: [],
      sourceInputIds: context.fingerprintBase.sourceInputs.map((input) => input.inputId),
      title: clippedTitle,
      description,
      whyInsufficient,
      supportingEvidence: [`model_proposal:${label}`],
      requiredMaterials,
      canWriteWithoutMaterial: typeof record["canWriteWithoutMaterial"] === "boolean" ? record["canWriteWithoutMaterial"] : true,
      requiresExperiment: typeof record["requiresExperiment"] === "boolean" ? record["requiresExperiment"] : false,
      sourceFingerprint: missingMaterialFingerprint({
        gapType: "proposed_scope_gap",
        ...(chapterId !== undefined ? { chapterId } : {}),
        contributionIds: [],
        sourceInputs: context.fingerprintBase.sourceInputs,
        outlineFingerprint: context.fingerprintBase.outlineFingerprint,
        content: clippedTitle,
      }),
    });
  });

  return { proposals, rejected };
}

function parseRequiredMaterials(value: unknown): RequiredMaterial[] {
  if (!Array.isArray(value)) return [];
  const result: RequiredMaterial[] = [];
  for (const item of value) {
    if (result.length >= MAX_REQUIRED_MATERIALS) break;
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const kind = record["kind"];
    const description = typeof record["description"] === "string" ? record["description"].trim().slice(0, 300) : "";
    if (typeof kind !== "string" || !REQUIRED_MATERIAL_KINDS.includes(kind as RequiredMaterialKind) || description === "") continue;
    result.push({ kind: kind as RequiredMaterialKind, description });
  }
  return result;
}

function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
