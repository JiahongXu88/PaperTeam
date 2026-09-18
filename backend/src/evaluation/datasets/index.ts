/**
 * Scenario 注册表与加载校验（M6.8 Evaluation Framework 的唯一数据入口）。
 *
 * 校验是结构性的（确定性、零 IO）：id 唯一、needle 逐字存在、fabricated
 * quote 不在任何语料中、metadataCorrupted 来源存在、marker 场景的注入类别
 * 与检查串一致。运行期校验失败 = 数据集损坏，直接抛错（评估不跑脏数据）。
 */

import type { GroundingScenario, RevisionScenario, WorkflowScenario } from "../types.js";
import { GROUNDING_SCENARIOS } from "./groundingScenarios.js";
import { REVISION_SCENARIOS } from "./revisionScenarios.js";
import { WORKFLOW_SCENARIOS } from "./workflowScenarios.js";

export { GROUNDING_SCENARIOS, REVISION_SCENARIOS, WORKFLOW_SCENARIOS };

export interface ScenarioValidationIssue {
  scenarioId: string;
  problem: string;
}

/** 归一化文本（与 quoteVerification 同口径：去空白后小写比较） */
function looseIncludes(haystack: string, needle: string): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, "").toLowerCase();
  return normalize(haystack).includes(normalize(needle));
}

export function validateGroundingScenario(scenario: GroundingScenario): ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = [];
  const push = (problem: string) => issues.push({ scenarioId: scenario.id, problem });
  const byFile = new Map(scenario.corpus.map((source) => [source.fileName, source]));
  const allContent = scenario.corpus.map((source) => source.content).join("\n");

  if (scenario.supportable.length === 0) {
    push("缺少正例（supportable 为空）");
  }
  for (const claim of scenario.supportable) {
    const source = byFile.get(claim.locator.fileName);
    if (source === undefined) {
      push(`正例 locator 指向不存在的语料文件：${claim.locator.fileName}`);
      continue;
    }
    if (!source.content.includes(claim.locator.needle)) {
      push(`正例 needle 不是逐字子串：${claim.locator.needle.slice(0, 50)}…`);
    }
    if (source.metadataCorrupted === true) {
      // 锚定损坏元数据来源的提案会被 Stage 2 正确拒绝——那是故障语义，不是正例
      push(`正例不得锚定 metadataCorrupted 来源（Stage 2 会正确拒绝）：${claim.locator.fileName}`);
    }
  }
  if (scenario.faults.length === 0) {
    push("缺少注入故障（faults 为空）");
  }
  const faultIds = new Set<string>();
  for (const fault of scenario.faults) {
    if (faultIds.has(fault.id)) {
      push(`故障 id 重复：${fault.id}`);
    }
    faultIds.add(fault.id);
    if (looseIncludes(allContent, fault.quote)) {
      // fabricated_quote 的引文必须不在语料中；其余类的 quote 即真实引文
      if (fault.faultClass === "fabricated_quote") {
        push(`fabricated quote 意外存在于语料中：${fault.quote.slice(0, 50)}…`);
      }
    } else if (fault.faultClass !== "fabricated_quote" && fault.locator !== undefined) {
      push(`故障 quote 不在语料中（应为逐字真实引文）：${fault.quote.slice(0, 50)}…`);
    }
    if (fault.locator !== undefined) {
      const source = byFile.get(fault.locator.fileName);
      if (source === undefined) {
        push(`故障 locator 指向不存在的语料文件：${fault.locator.fileName}`);
      } else if (!source.content.includes(fault.locator.needle)) {
        push(`故障 locator needle 不是逐字子串：${fault.locator.needle.slice(0, 50)}…`);
      }
    }
    if (fault.faultClass === "metadata_mismatch") {
      const source = fault.locator !== undefined ? byFile.get(fault.locator.fileName) : undefined;
      if (source?.metadataCorrupted !== true) {
        push(`metadata_mismatch 故障的锚定来源未标记 metadataCorrupted：${fault.locator?.fileName ?? "(无 locator)"}`);
      } else if (source.authoritativeYear === undefined || source.authoritativeYear === source.year) {
        push(`metadataCorrupted 来源必须声明与存储 year 不同的 authoritativeYear：${source.fileName}`);
      }
    }
  }
  const corrupted = scenario.corpus.filter((source) => source.metadataCorrupted);
  if (corrupted.length > 0 && !scenario.faults.some((fault) => fault.faultClass === "metadata_mismatch")) {
    push("存在 metadataCorrupted 来源但没有 metadata_mismatch 故障消费它");
  }
  return issues;
}

export function validateRevisionScenario(scenario: RevisionScenario): ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = [];
  const push = (problem: string) => issues.push({ scenarioId: scenario.id, problem });
  const has = (kind: string) => scenario.injectedViolations.includes(kind as never);
  if (scenario.marker === null) {
    if (!scenario.expectedClean || scenario.injectedViolations.length > 0) {
      push("无 marker 场景必须是干净对照（expectedClean=true 且零注入）");
    }
    if (scenario.mutatedFactNeedles.length > 0 || scenario.escalationNeedles.length > 0) {
      push("干净对照不应携带 mutatedFact/escalation 检查串");
    }
  } else {
    if (scenario.expectedClean) {
      push("marker 场景不得标记 expectedClean");
    }
    const markerToKind = { "fact:mutate": "fact", "cite:drop": "citation", "strength:escalate": "strength" } as const;
    const expectedKind = markerToKind[scenario.marker];
    if (!has(expectedKind)) {
      push(`marker ${scenario.marker} 与注入类别 ${scenario.injectedViolations.join("+")} 不一致`);
    }
    if (expectedKind === "fact" && scenario.mutatedFactNeedles.length === 0) {
      push("fact 注入缺少 mutatedFactNeedles");
    }
    if (expectedKind === "citation" && scenario.mustKeepCitationKeys.length === 0) {
      push("citation 注入缺少 mustKeepCitationKeys");
    }
    if (expectedKind === "strength" && scenario.escalationNeedles.length === 0) {
      push("strength 注入缺少 escalationNeedles");
    }
  }
  if (!scenario.reviewSequence.includes("fail")) {
    push("修订场景 review 序列必须至少一个 fail（否则不进入修订环）");
  }
  return issues;
}

export function validateWorkflowScenario(scenario: WorkflowScenario): ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = [];
  const push = (problem: string) => issues.push({ scenarioId: scenario.id, problem });
  if (scenario.expected.stages.length === 0 || scenario.expected.sectionFiles.length === 0) {
    push("期望 stages / 章节文件不能为空");
  }
  if (!scenario.expected.citationKeys.includes("gao2023survey")) {
    push("scripted 输出契约固定引用 gao2023survey，期望引用必须包含它");
  }
  if (scenario.corpus !== undefined) {
    if (scenario.preseedClaims === undefined || scenario.preseedClaims.length === 0) {
      push("带语料的场景必须提供 preseedClaims（否则 evidence.ground 无真实候选）");
    }
    const byFile = new Map(scenario.corpus.map((source) => [source.fileName, source]));
    for (const claim of scenario.preseedClaims ?? []) {
      const source = byFile.get(claim.locator.fileName);
      if (source === undefined) {
        push(`preseed locator 指向不存在的语料文件：${claim.locator.fileName}`);
      } else if (!source.content.includes(claim.locator.needle)) {
        push(`preseed needle 不是逐字子串：${claim.locator.needle.slice(0, 50)}…`);
      }
    }
  }
  for (const key of scenario.plainBaseline.fabricatedCitationKeys) {
    if (!scenario.plainBaseline.output.includes(key)) {
      push(`plain 基线声明的捏造引用 key 未出现在输出中：${key}`);
    }
  }
  for (const needle of scenario.plainBaseline.unsupportedClaimNeedles) {
    if (!scenario.plainBaseline.output.includes(needle)) {
      push(`plain 基线声明的无证据论断 needle 未出现在输出中：${needle}`);
    }
  }
  return issues;
}

/** 全量校验（CLI 启动与测试共用）；返回空数组 = 数据集健康 */
export function validateAllScenarios(): ScenarioValidationIssue[] {
  return [
    ...GROUNDING_SCENARIOS.flatMap(validateGroundingScenario),
    ...REVISION_SCENARIOS.flatMap(validateRevisionScenario),
    ...WORKFLOW_SCENARIOS.flatMap(validateWorkflowScenario),
  ];
}

/** 按 id 过滤（CLI --scenario）；未知 id 抛错（宁可失败不静默跑错场景） */
export function selectScenarios<T extends { id: string }>(all: readonly T[], ids: string[]): T[] {
  if (ids.length === 0) {
    return [...all];
  }
  const known = new Set(all.map((scenario) => scenario.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`未知 scenario id：${unknown.join(", ")}（可用：${all.map((s) => s.id).join(", ")}）`);
  }
  return all.filter((scenario) => ids.includes(scenario.id));
}
