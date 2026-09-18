/**
 * Experiment 1 Runner：Evidence Grounding Evaluation。
 *
 * 三臂对比（同一组 ground-truth 标注的提案，只差系统配置）：
 * - plain-llm：无文献库、无检索、无核验——提案按 LLM 自报直接进证据池
 *   （unverified；镜像 Researcher legacy 路径的存储形态）；
 * - rag：文献库 + 真实 RetrievalService——检索命中时 quote 被替换为检索
 *   chunk 的逐字切片（RAG 生成条件化消除捏造引文），但无任何核验（元数据
 *   冲突 / 论断越界照单全收）；检索不命中时捏造照旧（运行期实测，不假设）；
 * - paperteam：完整三段核验（quote 逐字 / metadata / ground-truth judge）
 *   ——只有 verified 才进正式证据池。
 *
 * 一致性自检（groundTruthAgreement）：paperteam 臂的处置必须与 ground truth
 * 一致（mismatch ← fabricated_quote/metadata_mismatch；judge 拒绝 ←
 * unsupported_claim；verified ← 正例）。不一致记入 issues（不静默、不粉饰）。
 */

import type {
  GroundingArmResult,
  GroundingProposalOutcome,
  GroundingScenario,
} from "../types.js";
import { aggregateFromOutcomes, computeGroundingMetrics, groundTruthOf } from "../metrics/grounding.js";
import {
  createGroundingHarness,
  type GroundingHarness,
} from "./harness.js";

interface Proposal {
  key: string;
  claim: string;
  quote: string;
  faultClass: GroundingProposalOutcome["faultClass"];
  locator?: { fileName: string; needle: string };
}

function proposalsOf(scenario: GroundingScenario): Proposal[] {
  const positives: Proposal[] = scenario.supportable.map((claim, index) => ({
    key: `ok-${index + 1}`,
    claim: claim.claim,
    quote: claim.locator.needle,
    faultClass: null,
    locator: claim.locator,
  }));
  const faults: Proposal[] = scenario.faults.map((fault) => ({
    key: fault.id,
    claim: fault.claim,
    quote: fault.quote,
    faultClass: fault.faultClass,
    locator: fault.locator,
  }));
  return [...positives, ...faults];
}

function outcomeOf(proposal: Proposal, disposition: GroundingProposalOutcome["disposition"]): GroundingProposalOutcome {
  const truth = groundTruthOf(proposal.faultClass);
  return {
    key: proposal.key,
    claim: proposal.claim,
    ...truth,
    faultClass: proposal.faultClass,
    disposition,
  };
}

/** RAG quote 切片：检索 chunk 原文的逐字前缀（足够长以过最小引文长度校验） */
function verbatimSliceOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

async function runPlainLlmArm(scenario: GroundingScenario): Promise<GroundingArmResult> {
  const harness: GroundingHarness = await createGroundingHarness(scenario);
  try {
    const outcomes: GroundingProposalOutcome[] = [];
    for (const proposal of proposalsOf(scenario)) {
      // 无库无核验：LLM 自报内容原样入池（unverified——legacy 存储形态）
      await harness.evidence.append(
        harness.projectId,
        {
          claim: proposal.claim,
          quote: proposal.quote,
          verificationStatus: "unverified",
          verificationMethod: "plain-llm/自报（无核验）",
        },
        "evaluation:plain-llm",
      );
      outcomes.push(outcomeOf(proposal, "accepted"));
    }
    return {
      arm: "plain-llm",
      scenarioId: scenario.id,
      outcomes,
      metrics: computeGroundingMetrics(outcomes, scenario.supportable.length),
    };
  } finally {
    await harness.cleanup();
  }
}

async function runRagArm(scenario: GroundingScenario): Promise<GroundingArmResult> {
  const harness = await createGroundingHarness(scenario);
  try {
    await harness.addCorpus(scenario.corpus);
    await harness.retrieval.search(harness.projectId, scenario.corpus[0]!.fileName, { topK: 1 });
    const outcomes: GroundingProposalOutcome[] = [];
    for (const proposal of proposalsOf(scenario)) {
      // 真实检索（按 claim 查询）：命中 → quote 替换为检索 chunk 逐字切片
      const result = await harness.retrieval.search(harness.projectId, proposal.claim, { topK: 5 });
      const quote = result.results.length > 0 ? verbatimSliceOf(result.results[0]!.chunk.text) : proposal.quote;
      await harness.evidence.append(
        harness.projectId,
        {
          claim: proposal.claim,
          quote,
          verificationStatus: "unverified",
          verificationMethod: "rag/检索条件化（无核验）",
        },
        "evaluation:rag",
      );
      outcomes.push({
        ...outcomeOf(proposal, "accepted"),
        // 检索命中 → 引文被条件化为真实逐字切片（捏造被消除）；未命中 → 原样
        quoteVerbatim: result.results.length > 0 ? true : groundTruthOf(proposal.faultClass).quoteVerbatim,
      });
    }
    return {
      arm: "rag",
      scenarioId: scenario.id,
      outcomes,
      metrics: computeGroundingMetrics(outcomes, scenario.supportable.length),
    };
  } finally {
    await harness.cleanup();
  }
}

async function runPaperteamArm(scenario: GroundingScenario): Promise<{ result: GroundingArmResult; issues: string[] }> {
  const harness = await createGroundingHarness(scenario);
  const issues: string[] = [];
  try {
    await harness.addCorpus(scenario.corpus);
    // 索引构建 + 提案锚点解析
    const keyToCandidate = new Map<string, string>();
    for (const proposal of proposalsOf(scenario)) {
      const locator = proposal.locator ?? scenario.supportable[0]?.locator;
      if (locator === undefined) {
        issues.push(`${scenario.id}/${proposal.key}: 无 locator，无法提案`);
        continue;
      }
      const { sourceId, chunkId } = await harness.resolveChunkByNeedle(locator.fileName, locator.needle);
      const { candidate } = await harness.grounding.propose(harness.projectId, {
        sourceId,
        chunkId,
        claim: proposal.claim,
        quote: proposal.quote,
        proposedBy: "evaluation:paperteam",
      });
      keyToCandidate.set(proposal.key, candidate.candidateId);
    }
    const summary = await harness.grounding.groundPending(harness.projectId);
    const byCandidate = new Map(summary.results.map((result) => [result.candidateId, result]));
    const outcomes: GroundingProposalOutcome[] = [];
    for (const proposal of proposalsOf(scenario)) {
      const candidateId = keyToCandidate.get(proposal.key);
      const result = candidateId !== undefined ? byCandidate.get(candidateId) : undefined;
      if (result === undefined) {
        issues.push(`${scenario.id}/${proposal.key}: 候选未进入核验批次`);
        outcomes.push(outcomeOf(proposal, "rejected_other"));
        continue;
      }
      let disposition: GroundingProposalOutcome["disposition"];
      if (result.status === "verified") {
        disposition = "accepted";
      } else if (result.status === "mismatch") {
        disposition = (result.reason ?? "").includes("metadata_mismatch") ? "rejected_metadata_mismatch" : "rejected_quote_mismatch";
      } else if (result.status === "rejected") {
        disposition = "rejected_judge";
      } else {
        disposition = "rejected_other";
      }
      outcomes.push(outcomeOf(proposal, disposition));
      // 一致性自检：处置 vs ground truth
      const truth = groundTruthOf(proposal.faultClass);
      const agrees =
        (disposition === "accepted" && truth.claimSupported && truth.quoteVerbatim && truth.metadataCorrect) ||
        (disposition === "rejected_quote_mismatch" && !truth.quoteVerbatim) ||
        (disposition === "rejected_metadata_mismatch" && !truth.metadataCorrect) ||
        (disposition === "rejected_judge" && !truth.claimSupported);
      if (!agrees) {
        issues.push(
          `${scenario.id}/${proposal.key}: 处置 ${disposition} 与 ground truth 不符（faultClass=${proposal.faultClass ?? "正例"}）`,
        );
      }
    }
    return {
      result: {
        arm: "paperteam",
        scenarioId: scenario.id,
        outcomes,
        metrics: computeGroundingMetrics(outcomes, scenario.supportable.length),
      },
      issues,
    };
  } finally {
    await harness.cleanup();
  }
}

export interface Experiment1Result {
  experiment: 1;
  name: "evidence-grounding";
  arms: GroundingArmResult[];
  aggregate: Record<string, ReturnType<typeof computeGroundingMetrics>>;
  comparison: Record<string, unknown>;
  limitations: string[];
  issues: string[];
}

export async function runExperiment1(options: {
  scenarios: readonly GroundingScenario[];
  log?: (message: string) => void;
}): Promise<Experiment1Result> {
  const log = options.log ?? (() => {});
  const arms: GroundingArmResult[] = [];
  const issues: string[] = [];
  for (const scenario of options.scenarios) {
    log(`[exp1] ${scenario.id}：plain-llm 臂`);
    arms.push(await runPlainLlmArm(scenario));
    log(`[exp1] ${scenario.id}：rag 臂`);
    arms.push(await runRagArm(scenario));
    log(`[exp1] ${scenario.id}：paperteam 臂`);
    const paperteam = await runPaperteamArm(scenario);
    arms.push(paperteam.result);
    issues.push(...paperteam.issues);
  }
  const collect = (arm: string) =>
    arms
      .filter((entry) => entry.arm === arm)
      .map((entry) => ({
        outcomes: entry.outcomes,
        supportableTotal:
          options.scenarios.find((scenario) => scenario.id === entry.scenarioId)?.supportable.length ?? 0,
      }));
  const aggregate = {
    "plain-llm": aggregateFromOutcomes(collect("plain-llm")),
    rag: aggregateFromOutcomes(collect("rag")),
    paperteam: aggregateFromOutcomes(collect("paperteam")),
  };
  const comparison = {
    unsupportedClaimRate: {
      plainLlm: aggregate["plain-llm"]!.unsupportedClaimRate,
      rag: aggregate.rag!.unsupportedClaimRate,
      paperteam: aggregate.paperteam!.unsupportedClaimRate,
      paperteamVsPlain: aggregate.paperteam!.unsupportedClaimRate - aggregate["plain-llm"]!.unsupportedClaimRate,
      paperteamVsRag: aggregate.paperteam!.unsupportedClaimRate - aggregate.rag!.unsupportedClaimRate,
    },
    fabricatedCitationRate: {
      plainLlm: aggregate["plain-llm"]!.fabricatedCitationRate,
      rag: aggregate.rag!.fabricatedCitationRate,
      paperteam: aggregate.paperteam!.fabricatedCitationRate,
      paperteamVsPlain: aggregate.paperteam!.fabricatedCitationRate - aggregate["plain-llm"]!.fabricatedCitationRate,
      paperteamVsRag: aggregate.paperteam!.fabricatedCitationRate - aggregate.rag!.fabricatedCitationRate,
    },
    evidenceCoverage: {
      plainLlm: aggregate["plain-llm"]!.evidenceCoverage,
      rag: aggregate.rag!.evidenceCoverage,
      paperteam: aggregate.paperteam!.evidenceCoverage,
    },
  };
  return {
    experiment: 1,
    name: "evidence-grounding",
    arms,
    aggregate,
    comparison,
    limitations: [
      "scripted 离线实验：度量的是三段核验管道对注入故障的确定性拦截率，不是真实模型的生成错误率",
      "rag 臂的「检索命中即消除捏造引文」是 RAG 生成条件化的建模（quote 替换为检索 chunk 逐字切片），检索命中本身由真实 RetrievalService 实测",
      "metadata 核验的权威记录是数据集内置的 ground-truth provider，不是真实 Crossref/OpenAlex",
    ],
    issues,
  };
}
