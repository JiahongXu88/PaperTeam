/**
 * M11.1.2 Structured Synthesis fixture workflow 测试：
 * 真实 MatrixService 构建矩阵 → SynthesisService 全链路（taxonomy 确定性
 * 聚合 + 六类 LLM batch + 引用 fail-closed 核验 + EvidenceGroundingService
 * 真实核验管道 + deriveGroundingLevel 判定 + dedup + 持久化）。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SurveyMatrixEntry } from "../../src/survey/matrixTypes.js";
import type { SurveySynthesisItem } from "../../src/survey/synthesisTypes.js";
import {
  FIXTURE_ABSTRACT_ONLY,
  FIXTURE_PAPERS,
  addFulltextPaper,
  addMetadataOnlyPaper,
  newSurveyFixture,
  type SurveyFixture,
} from "./fixtures.js";

let fixture: SurveyFixture;

beforeAll(async () => {
  fixture = await newSurveyFixture();
});

afterAll(async () => {
  await fixture.cleanup();
});

/** 按 sourceId 定制的 matrix 抽取脚本（family / subFamily / limitation 可控） */
function matrixScript(options: {
  family: string;
  subFamily?: string;
  limitation?: string;
  strength?: string;
  keyFinding?: string;
}): (input: { chunkIds: string[] }) => string {
  return ({ chunkIds }) =>
    JSON.stringify({
      researchProblem: "多目标跟踪中的数据关联",
      methodFamily: options.family,
      ...(options.subFamily !== undefined ? { subFamily: options.subFamily } : {}),
      mainIdea: "利用检测置信度与关联线索保持身份稳定",
      ...(options.strength !== undefined ? { strength: options.strength } : {}),
      ...(options.limitation !== undefined ? { limitation: options.limitation } : {}),
      keyFindings: [options.keyFinding ?? "关联策略显著影响身份保持"],
      anchors: chunkIds.length > 0 ? [{ field: "mainIdea", chunkIds: [chunkIds[0]!] }] : [],
    });
}

/** seed 全部 7 篇（S001-S006 fulltext + S007 abstract-only）并构建矩阵 */
async function seedAndBuildMatrix(): Promise<Map<string, SurveyMatrixEntry>> {
  const scripts: Record<string, ReturnType<typeof matrixScript>> = {
    // S001 ByteTrack / S002 DeepSORT / S005 OC-SORT / S006 StrongSORT 同族不同 sub
    S001: matrixScript({ family: "tracking_association", subFamily: "motion_based" }),
    S002: matrixScript({
      family: "tracking_association",
      subFamily: "appearance_based",
      limitation: "外观特征在低照度场景显著退化，且嵌入推理带来额外实时开销",
    }),
    S005: matrixScript({ family: "tracking_association", subFamily: "motion_based" }),
    S006: matrixScript({
      family: "tracking_association",
      subFamily: "joint",
      limitation: "外观分支在低照度下不可靠，联合代价矩阵的实时性受限",
    }),
    S003: matrixScript({ family: "re_identification" }),
    S004: matrixScript({ family: "evaluation_benchmark", keyFinding: "IDF1 与 MOTA 提供互补视角" }),
  };
  for (const [sourceId, script] of Object.entries(scripts)) {
    fixture.runtime.setScript(sourceId, script);
  }
  // S007 abstract-only：模型给出生造标签 → unclassified（M11.1.1 fail-closed）
  fixture.runtime.setScript("S007", () =>
    JSON.stringify({
      researchProblem: "综述多目标跟踪方法",
      methodFamily: "comprehensive_review", // 不在 taxonomy → unclassified + issue
      mainIdea: "对跟踪方法做系统回顾",
    }),
  );

  const papers = FIXTURE_PAPERS; // S001 bytetrack, S002 deepsort, S003 osnet, S004 motchallenge, S005 ocsort, S006 strongsort
  for (const paper of papers) {
    await addFulltextPaper(fixture.sources, fixture.projectId, paper);
  }
  await addMetadataOnlyPaper(fixture.sources, fixture.projectId, FIXTURE_ABSTRACT_ONLY);

  const result = await fixture.matrix.buildMatrix(fixture.projectId);
  expect(result.summary.failed).toBe(0);
  return new Map(result.matrix.entries.map((entry) => [entry.entryId, entry]));
}

describe("SynthesisService fixture workflow", () => {
  let entryById: Map<string, SurveyMatrixEntry>;

  beforeAll(async () => {
    entryById = await seedAndBuildMatrix();
  });

  it("前置：矩阵含 6 fulltext + 1 abstract-only（S007 unclassified）", () => {
    expect(entryById.size).toBe(7);
    expect(entryById.get("M-S007")!.interpretationDepth).toBe("abstract_only");
    expect(entryById.get("M-S007")!.methodFamily).toBe("unclassified");
    expect(entryById.get("M-S001")!.anchors.length).toBeGreaterThan(0);
  });

  it("全链路 build：七类全部产出，grounding 分级与 evidence 回溯符合规则", async () => {
    const result = await fixture.synthesis.buildSynthesis(fixture.projectId);
    expect(result.summary.reused).toBe(false);
    expect(result.summary.batches).toBe(6); // trend/comparison/consensus/disagreement（tracking 族）+ gap + future（全局）
    expect(result.summary.byKind).toMatchObject({
      taxonomy: expect.any(Number),
      trend: 1,
      comparison: 1,
      consensus: 1,
      disagreement: 1,
      research_gap: 1,
      future_direction: 2, // cited + inferred
    });

    const items = result.synthesis.items;
    const byKind = (kind: string) => items.filter((item) => item.kind === kind);

    // ---- taxonomy：确定性聚合（family/subFamily leaf + unclassified；空族不生成） ----
    const taxonomyItems = byKind("taxonomy");
    const families = taxonomyItems.map((item) => (item.detail as { family: string }).family);
    expect(families).toContain("tracking_association");
    expect(families).toContain("re_identification");
    expect(families).toContain("evaluation_benchmark");
    expect(families).toContain("unclassified");
    // 空家族（survey / detection / generative_model 等）绝不生成 node
    for (const empty of ["survey", "detection", "generative_model", "theory_analysis"]) {
      expect(families).not.toContain(empty);
    }
    // subFamily leaf：motion_based 2 篇 / appearance_based 1 篇 / joint 1 篇
    const leaves = taxonomyItems.map((item) => item.detail as { family: string; subFamily?: string });
    const motion = leaves.find((leaf) => leaf.family === "tracking_association" && leaf.subFamily === "motion_based")!;
    expect(motion).toBeDefined();
    expect(byId(items, "tracking_association", "motion_based").derivedFrom.entryIds).toEqual([
      "M-S001",
      "M-S005",
    ]);
    expect(byId(items, "tracking_association", "appearance_based").derivedFrom.entryIds).toEqual(["M-S002"]);
    // unclassified 不被猜回任何 family，且计入 abstract-only 条目
    const unclassified = taxonomyItems.find((item) => (item.detail as { family: string }).family === "unclassified")!;
    expect(unclassified.derivedFrom.entryIds).toEqual(["M-S007"]);
    for (const item of taxonomyItems) {
      expect(item.groundingLevel).toBe("literature_cited"); // 组织骨架封顶
      expect(item.evidenceIds).toEqual([]);
    }

    // ---- trend：4 来源 + 2 proposals verified → evidence_backed ----
    const trend = byKind("trend")[0]!;
    expect(trend.sourceIds).toEqual(["S001", "S002", "S005", "S006"]);
    expect(trend.groundingLevel).toBe("evidence_backed");
    expect(trend.evidenceIds.length).toBeGreaterThanOrEqual(2);
    await expectEvidenceTraceable(trend);

    // ---- comparison：无 proposal → literature_cited；双侧 entry 齐全 ----
    const comparison = byKind("comparison")[0]!;
    expect(comparison.groundingLevel).toBe("literature_cited");
    const sides = (comparison.detail as { sides: Array<{ entryIds: string[] }> }).sides;
    expect(sides.length).toBeGreaterThanOrEqual(2);
    for (const side of sides) {
      expect(side.entryIds.length).toBeGreaterThan(0);
      for (const entryId of side.entryIds) {
        expect(entryById.has(entryId)).toBe(true);
      }
    }

    // ---- consensus：3 来源 + 3 verified（judge supported）→ evidence_backed ----
    const consensus = byKind("consensus")[0]!;
    expect(consensus.sourceIds.length).toBe(3);
    expect(consensus.groundingLevel).toBe("evidence_backed");
    expect(consensus.evidenceIds.length).toBe(3);
    expect((consensus.detail as { distinctSources: number }).distinctSources).toBe(3);
    await expectEvidenceTraceable(consensus);

    // ---- disagreement：双侧存在但 verified 只覆盖一侧 → literature_cited ----
    const disagreement = byKind("disagreement")[0]!;
    expect(disagreement.groundingLevel).toBe("literature_cited");
    expect(disagreement.groundingReason).toContain("verified evidence 不足");
    const detail = disagreement.detail as { sideA: { entryIds: string[] }; sideB: { entryIds: string[] } };
    expect(detail.sideA.entryIds.length).toBeGreaterThan(0);
    expect(detail.sideB.entryIds.length).toBeGreaterThan(0);

    // ---- research_gap：trigger 白名单内 → literature_cited（不可能 evidence_backed） ----
    const gap = byKind("research_gap")[0]!;
    expect((gap.detail as { trigger: string }).trigger).toBe("literature_limitation");
    expect(gap.groundingLevel).toBe("literature_cited");

    // ---- future_direction：cited → evidence_backed；inferred → speculative（硬规则） ----
    const futures = byKind("future_direction");
    const cited = futures.find((item) => (item.detail as { origin: string }).origin === "cited_future_work")!;
    const inferred = futures.find((item) => (item.detail as { origin: string }).origin === "inferred")!;
    expect(cited.groundingLevel).toBe("evidence_backed");
    expect(inferred.groundingLevel).toBe("speculative");
    expect(inferred.evidenceIds).toEqual([]); // inferred 不进核验管道
    await expectEvidenceTraceable(cited);

    // ---- 全体引用 fail-closed 不变量 ----
    for (const item of items) {
      expect(item.synthesisId).toMatch(/^SYN-[0-9a-f]{10}$/);
      for (const entryId of item.derivedFrom.entryIds) {
        expect(entryById.has(entryId)).toBe(true);
      }
      // sourceIds 恰为 entryIds 派生集合
      expect(item.sourceIds).toEqual([
        ...new Set(item.derivedFrom.entryIds.map((entryId) => entryById.get(entryId)!.sourceId)),
      ].sort());
    }
  });

  it("幂等：Matrix 未变 → 复用 artifact（零 LLM 调用）；force 重建 → 同 ID 无重复", async () => {
    const before = await fixture.synthesis.getSynthesis(fixture.projectId);
    expect(before).not.toBeNull();
    const runtimeCallsBefore = fixture.runtime.calls.length;

    const reuse = await fixture.synthesis.buildSynthesis(fixture.projectId);
    expect(reuse.summary.reused).toBe(true);
    expect(reuse.synthesis.items.map((item) => item.synthesisId)).toEqual(
      before!.items.map((item) => item.synthesisId),
    );
    expect(fixture.runtime.calls.length).toBe(runtimeCallsBefore); // 复用不触发任何模型调用

    const evidenceBefore = (await fixture.evidence.list(fixture.projectId)).length;
    const rebuilt = await fixture.synthesis.buildSynthesis(fixture.projectId, { force: true });
    expect(rebuilt.summary.reused).toBe(false);
    expect(rebuilt.synthesis.items.map((item) => item.synthesisId).sort()).toEqual(
      before!.items.map((item) => item.synthesisId).sort(),
    );
    // evidence 不重复追加（findGroundedRecord 幂等守卫复用既有 verified 记录）
    const evidenceAfter = (await fixture.evidence.list(fixture.projectId)).length;
    expect(evidenceAfter).toBe(evidenceBefore);
  });

  it("kinds 过滤：只构建 taxonomy（零 LLM batch）", async () => {
    const result = await fixture.synthesis.buildSynthesis(fixture.projectId, {
      kinds: ["taxonomy"],
      force: true,
    });
    expect(result.summary.batches).toBe(0);
    expect(new Set(result.synthesis.items.map((item) => item.kind))).toEqual(new Set(["taxonomy"]));
    // 恢复全量 artifact（后续用例依赖）
    await fixture.synthesis.buildSynthesis(fixture.projectId, { force: true });
  });

  it("fake 引用 fail-closed：不存在的 entryId / chunkId 不落盘", async () => {
    fixture.runtime.setSynthesisScript("consensus", ({ entryIds, chunkIdsByEntry }) =>
      JSON.stringify({
        candidates: [
          {
            kind: "consensus",
            claim: "伪造引用的共识",
            detail: {},
            entryIds: ["M-S999", "M-S998", "M-S997"], // 全部不存在
            evidenceProposals: [],
          },
          {
            kind: "consensus",
            claim: "部分伪造的共识",
            detail: {},
            entryIds: [entryIds[0], "M-S999"],
            evidenceProposals: [
              // chunkId 不属于该 entry → proposal 剔除；candidate 保留（引用面仍 1 源 → 不足 2 源拒绝）
              { entryId: entryIds[0]!, chunkId: "S999:SEC01:0001:deadbeef99", evidenceClaim: "伪造锚点断言" },
              // 引用别家 entry 的合法 chunk → 剔除（不属于 M-S001 的 anchor 集）
              ...(entryIds[1] !== undefined && (chunkIdsByEntry[entryIds[1]] ?? []).length > 0
                ? [
                    {
                      entryId: entryIds[0]!,
                      chunkId: chunkIdsByEntry[entryIds[1]]![0]!,
                      evidenceClaim: "跨条目伪造锚点",
                    },
                  ]
                : []),
            ],
          },
        ],
      }),
    );
    const result = await fixture.synthesis.buildSynthesis(fixture.projectId, {
      kinds: ["consensus"],
      force: true,
    });
    expect(result.synthesis.items.filter((item) => item.kind === "consensus")).toHaveLength(0);
    expect(result.rejections.length).toBeGreaterThanOrEqual(2);
    expect(result.rejections.some((rejection) => rejection.reason.includes("引用全部无效"))).toBe(true);
    expect(result.rejections.some((rejection) => rejection.reason.includes("至少需要 2 个不同来源"))).toBe(true);
    // 落盘 artifact 也不含任何 consensus
    const persisted = await fixture.synthesis.getSynthesis(fixture.projectId);
    expect(persisted!.items.some((item) => item.kind === "consensus")).toBe(false);
    fixture.runtime.clearSynthesisScript("consensus");
  });

  it("模型自报 evidence_backed 无效：groundingLevel 只由代码判定", async () => {
    fixture.runtime.setSynthesisScript("trend", ({ entryIds }) =>
      JSON.stringify({
        candidates: [
          {
            kind: "trend",
            claim: "模型自称 grounded 的趋势",
            groundingLevel: "evidence_backed", // 必须被忽略
            evidenceIds: ["E999"], // 必须被忽略
            detail: { period: "2017-2023", direction: "自报方向" },
            entryIds: [entryIds[0]!, entryIds[1] ?? entryIds[0]!],
            evidenceProposals: [], // 无 proposal → 无 verified evidence
          },
        ],
      }),
    );
    const result = await fixture.synthesis.buildSynthesis(fixture.projectId, {
      kinds: ["trend"],
      force: true,
    });
    const trend = result.synthesis.items.find((item) => item.kind === "trend")!;
    expect(trend).toBeDefined();
    expect(trend.groundingLevel).toBe("literature_cited"); // 代码判：未达阈值
    expect(trend.evidenceIds).toEqual([]);
    expect(trend).not.toHaveProperty("modelClaimedGrounding");
    fixture.runtime.clearSynthesisScript("trend");
  });

  it("单来源 trend 拒绝；两篇一致只算 observed agreement", async () => {
    fixture.runtime.setSynthesisScript("trend", ({ entryIds }) =>
      JSON.stringify({
        candidates: [
          { kind: "trend", claim: "单来源趋势", detail: { period: "2022", direction: "x" }, entryIds: [entryIds[0]!], evidenceProposals: [] },
        ],
      }),
    );
    fixture.runtime.setSynthesisScript("consensus", ({ entryIds }) =>
      JSON.stringify({
        candidates: [
          { kind: "consensus", claim: "两篇一致", detail: {}, entryIds: [entryIds[0]!, entryIds[1]!], evidenceProposals: [] },
        ],
      }),
    );
    const result = await fixture.synthesis.buildSynthesis(fixture.projectId, {
      kinds: ["trend", "consensus"],
      force: true,
    });
    expect(result.synthesis.items.filter((item) => item.kind === "trend")).toHaveLength(0);
    const consensus = result.synthesis.items.find((item) => item.kind === "consensus")!;
    expect(consensus.groundingLevel).toBe("literature_cited");
    expect((consensus.detail as { observedAgreement: boolean }).observedAgreement).toBe(true);
    expect(result.rejections.some((rejection) => rejection.reason.includes("至少需要 2 个不同来源"))).toBe(true);
    fixture.runtime.clearSynthesisScript("trend");
    fixture.runtime.clearSynthesisScript("consensus");
  });

  it("disagreement 一侧 abstract-only 立论 → literature_cited（不能 evidence_backed）", async () => {
    fixture.runtime.setSynthesisScript("disagreement", ({ entryIds }) =>
      JSON.stringify({
        candidates: [
          {
            kind: "disagreement",
            claim: "外观必要性与摘要综述结论的分歧",
            detail: {
              issue: "外观模型是否必要",
              sideA: { label: "全文证据侧", entryIds: [entryIds[0]!] },
              sideB: { label: "摘要立论侧", entryIds: ["M-S007"] }, // abstract-only、无锚点
            },
            entryIds: [entryIds[0]!, "M-S007"],
            evidenceProposals: [
              { entryId: entryIds[0]!, chunkId: "", evidenceClaim: "占位（chunkId 为空被剔除）" },
            ],
          },
        ],
      }),
    );
    const result = await fixture.synthesis.buildSynthesis(fixture.projectId, {
      kinds: ["disagreement"],
      force: true,
    });
    const disagreement = result.synthesis.items.find((item) => item.kind === "disagreement")!;
    expect(disagreement).toBeDefined();
    expect(disagreement.groundingLevel).toBe("literature_cited");
    expect(disagreement.groundingReason).toContain("可靠 chunk 锚点");
    fixture.runtime.clearSynthesisScript("disagreement");
  });

  it("gap trigger 白名单外 → parse 期拒绝入账目", async () => {
    fixture.runtime.setSynthesisScript("research_gap", () =>
      JSON.stringify({
        candidates: [
          { kind: "research_gap", claim: "直觉空缺", detail: { trigger: "intuition", basis: "感觉" }, entryIds: ["M-S001"] },
        ],
      }),
    );
    const result = await fixture.synthesis.buildSynthesis(fixture.projectId, {
      kinds: ["research_gap"],
      force: true,
    });
    expect(result.synthesis.items.filter((item) => item.kind === "research_gap")).toHaveLength(0);
    expect(result.rejections[0]!.reason).toContain("literature_limitation");
    fixture.runtime.clearSynthesisScript("research_gap");
  });

  it("未构建矩阵 → 400（先 Matrix 后 Synthesis 的顺序约束）", async () => {
    const other = await fixture.projects.create("无矩阵项目");
    await expect(fixture.synthesis.buildSynthesis(other.id)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("batch 失败是数据不是异常：任务 failed 记账目、其余 kind 不受影响", async () => {
    fixture.runtime.setSynthesisScript("trend", () => ({ fail: true, error: "fixture 注入失败" }));
    const result = await fixture.synthesis.buildSynthesis(fixture.projectId, {
      kinds: ["trend", "comparison"],
      force: true,
    });
    expect(result.synthesis.items.some((item) => item.kind === "comparison")).toBe(true);
    expect(result.synthesis.items.some((item) => item.kind === "trend")).toBe(false);
    expect(result.rejections.some((rejection) => rejection.reason.includes("batch 失败"))).toBe(true);
    fixture.runtime.clearSynthesisScript("trend");
  });
});

// ---- 断言辅助 ----

function byId(
  items: SurveySynthesisItem[],
  family: string,
  subFamily?: string,
): SurveySynthesisItem {
  const found = items.find(
    (item) =>
      item.kind === "taxonomy" &&
      (item.detail as { family: string; subFamily?: string }).family === family &&
      (item.detail as { family: string; subFamily?: string }).subFamily === subFamily,
  );
  expect(found).toBeDefined();
  return found!;
}

/** evidence 回溯不变量：每个 evidenceId 真实存在、verified、归属该 synthesis 的来源 */
async function expectEvidenceTraceable(item: SurveySynthesisItem): Promise<void> {
  expect(item.evidenceIds.length).toBeGreaterThan(0);
  for (const evidenceId of item.evidenceIds) {
    const record = await fixture.evidence.get(fixture.projectId, evidenceId);
    expect(record).not.toBeNull();
    expect(record!.verificationStatus).toBe("verified");
    expect(item.sourceIds).toContain(record!.source!.sourceId);
    expect(record!.location?.chunk).toBeDefined(); // 单源单锚点语义保留
  }
}
