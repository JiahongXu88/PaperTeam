/**
 * M14.1b：下游（thesis Planner / Writer）可消费的结构化输入。
 *
 * 严格分区，不用一个模糊的 verified=true：
 *   authorConfirmed            作者确认 + 无未决阻断冲突 + 输入 included（+ 版本已选定）
 *   sourceVerifiedUnconfirmed  来源核验通过但未经作者确认
 *   extractedOnly              仅抽取
 *   conflicted                 处于未决 / 延后的阻断冲突
 * 不在 included 输入内的事实不进入任何分区；proposed 输入 / 未选版本 / 未决冲突 /
 * 未发表材料未授权 → pendingDecisions + writingBlockers。
 */

import { describeFactLocation } from "./tableAlignment.js";
import {
  isPublishedInputType,
  type FactConflict,
  type FactView,
  type PendingDecision,
  type ResearchFactContext,
  type ResearchInput,
  type ResearchInputSummary,
  type ScientificFact,
  type WorkGroupState,
} from "./researchInputTypes.js";

export interface PlannerContextSource {
  projectId: string;
  inputs: ResearchInput[];
  workGroups: WorkGroupState[];
  facts: ScientificFact[];
  conflicts: FactConflict[];
  now: string;
}

export function buildResearchFactContext(source: PlannerContextSource): ResearchFactContext {
  const summaries = source.inputs.map(summarize);
  const byScope = (scope: ResearchInput["scope"]["status"]) => summaries.filter((entry) => entry.scope === scope);
  const pending: PendingDecision[] = [];
  const blockers: string[] = [];
  const preferredVersionByWork: Record<string, string> = {};
  const usableInputIds = new Set<string>();

  for (const input of source.inputs) {
    if (input.scope.status === "proposed") {
      pending.push({ type: "scope_decision", subject: input.inputId, reason: `研究输入「${input.title}」尚未决定入选 / 排除` });
    }
  }
  for (const group of source.workGroups) {
    const included = group.inputIds.filter((id) => source.inputs.find((input) => input.inputId === id)?.scope.status === "included");
    if (included.length === 0) continue;
    if (included.length > 1 && group.preferredInputId === undefined) {
      pending.push({ type: "version_selection", subject: group.workId, reason: `成果分组 ${group.workId} 有 ${included.length} 个入选版本，未选定跟随版本` });
      blockers.push(`VERSION_UNSELECTED:${group.workId}`);
      continue;
    }
    const preferred = group.preferredInputId ?? included[0]!;
    if (!included.includes(preferred)) {
      pending.push({ type: "version_selection", subject: group.workId, reason: `选定版本 ${preferred} 已不在入选集合中` });
      blockers.push(`VERSION_UNSELECTED:${group.workId}`);
      continue;
    }
    preferredVersionByWork[group.workId] = preferred;
    usableInputIds.add(preferred);
  }
  for (const input of source.inputs) {
    if (!usableInputIds.has(input.inputId)) continue;
    if (!isPublishedInputType(input.inputType) && input.unpublishedMaterialPolicy === undefined) {
      pending.push({ type: "unpublished_material_policy", subject: input.inputId, reason: `「${input.title}」是未发表材料（${input.inputType}），尚未决定是否允许纳入` });
      blockers.push(`UNPUBLISHED_POLICY_UNDECIDED:${input.inputId}`);
      usableInputIds.delete(input.inputId);
    } else if (!isPublishedInputType(input.inputType) && input.unpublishedMaterialPolicy?.allowed === false) {
      usableInputIds.delete(input.inputId);
    }
  }

  const facts = { authorConfirmed: [] as FactView[], sourceVerifiedUnconfirmed: [] as FactView[], extractedOnly: [] as FactView[], conflicted: [] as FactView[] };
  for (const fact of source.facts) {
    if (!usableInputIds.has(fact.researchInputId) || fact.supersededBy !== undefined) continue;
    const view = toView(fact);
    if (fact.conflict.status === "unresolved") {
      facts.conflicted.push(view);
      continue;
    }
    if (fact.verification.status === "author_confirmed") facts.authorConfirmed.push(view);
    else if (fact.verification.status === "source_verified") facts.sourceVerifiedUnconfirmed.push(view);
    else facts.extractedOnly.push(view);
  }

  const relevantConflicts = source.conflicts.filter((conflict) => conflict.parties.some((party) => usableInputIds.has(party.researchInputId)));
  const unresolved = relevantConflicts.filter((conflict) => conflict.status === "unresolved");
  const deferred = relevantConflicts.filter((conflict) => conflict.status === "deferred");
  for (const conflict of [...unresolved, ...deferred]) {
    if (conflict.severity === "blocking") {
      pending.push({ type: "conflict_resolution", subject: conflict.conflictId, reason: `${conflict.classification}：${conflict.parties.map((party) => `${party.raw}@${party.location}`).join(" vs ")}` });
      blockers.push(`CONFLICT_UNRESOLVED:${conflict.conflictId}`);
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: source.now,
    projectId: source.projectId,
    inputs: {
      included: byScope("included"),
      excluded: byScope("excluded"),
      proposed: byScope("proposed"),
      superseded: byScope("superseded"),
      preferredVersionByWork,
    },
    facts,
    conflicts: { unresolved, resolved: relevantConflicts.filter((conflict) => conflict.status === "resolved"), deferred },
    pendingDecisions: pending,
    writingBlockers: [...new Set(blockers)],
  };
}

function summarize(input: ResearchInput): ResearchInputSummary {
  return {
    inputId: input.inputId,
    inputType: input.inputType,
    title: input.title,
    workId: input.workId,
    contentHash: input.version.contentHash,
    ...(input.versionLabel !== undefined ? { versionLabel: input.versionLabel } : {}),
    scope: input.scope.status,
    parseStatus: input.parse.status,
    ...(input.publicationStatus !== undefined ? { publicationStatus: input.publicationStatus.value } : {}),
    ...(input.unpublishedMaterialPolicy !== undefined ? { unpublishedMaterialAllowed: input.unpublishedMaterialPolicy.allowed } : {}),
  };
}

function toView(fact: ScientificFact): FactView {
  return {
    factId: fact.factId,
    researchInputId: fact.researchInputId,
    kind: fact.kind,
    key: fact.key,
    surface: fact.surface,
    value: fact.value,
    verification: fact.verification.status,
    sourceCheck: fact.verification.sourceCheck,
    conflictStatus: fact.conflict.status,
    location: describeFactLocation(fact),
  };
}
