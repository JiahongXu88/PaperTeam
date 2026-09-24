/**
 * Claim Grounding 测试（M9.7.6）：
 * - 判定端复用 Fact Reviewer verdict（不新增 LLM 判定）：报告统计 / 绑定有效性
 * - evidenceBound 判定 = verdict 有支撑 且 evidenceId 解析到 formal evidence
 *   （verified + sourceId + chunk 锚点）——citation-backed ≠ claim-supported
 * - unsupported claim → formal 池确定性词面候选（bounded Top-K，不足阈值返回空）
 * - Repair Directive 只携带 formal evidence 候选（SUPPORT 只允许 verified 证据）
 * - legacy 产物兼容：M9.7.6 之前的项目没有 claim-grounding 文件 → null，不报错
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { FactClaimCheck } from "../../src/agents/ReviewerService.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import {
  buildClaimRepairDirectives,
  claimFingerprint,
  computeClaimGroundingReport,
  findEvidenceCandidates,
} from "../../src/review/claimGrounding.js";
import { ReviewArtifactStore } from "../../src/review/reviewArtifacts.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";

function evidence(input: Partial<EvidenceRecord> & { id: string }): EvidenceRecord {
  return {
    claim: "",
    verificationStatus: "verified",
    source: { sourceId: `S-${input.id}`, title: `Paper ${input.id}`, year: 2023 },
    location: { chunk: `${input.id}:SEC01:0001:a1b2c3d4e5` },
    createdBy: "test",
    createdAt: "2026-09-24T00:00:00Z",
    ...input,
  } as EvidenceRecord;
}

const BIB = [
  { key: "yao2023react", title: "ReAct", year: 2023, doi: "10.1/react", sourceId: "S-E001" },
  { key: "park2023generative", title: "Generative Agents", year: 2023, sourceId: "S-E002" },
  { key: "wei2022cot", title: "Chain-of-Thought", year: 2022, sourceId: "S-E003" },
];

const FORMAL_POOL: EvidenceRecord[] = [
  evidence({
    id: "E001",
    claim: "ReAct 在 HotpotQA 上超越标准提示基线",
    quote: "ReAct outperforms standard prompting on HotpotQA",
  }),
  evidence({
    id: "E002",
    claim: "生成式智能体的多智能体协作提升了任务完成率",
    quote: "multi-agent collaboration improves task completion",
  }),
  evidence({
    id: "E003",
    claim: "思维链提示在算术推理上提升准确率",
    quote: "chain-of-thought improves arithmetic reasoning accuracy",
  }),
];

const NON_FORMAL = evidence({
  id: "E099",
  claim: "ReAct 消融实验数据",
  verificationStatus: "unverified",
});

describe("computeClaimGroundingReport", () => {
  it("verified evidence 可形成 claim 绑定：SUPPORTED + formal evidenceId → bound + 正确 citation key", () => {
    const claims: FactClaimCheck[] = [
      {
        section: "sections/reasoning-acting.tex",
        claim: "ReAct 在 HotpotQA 上优于标准提示",
        verdict: "SUPPORTED",
        evidenceId: "E001",
      },
    ];
    const report = computeClaimGroundingReport({
      projectId: "p1",
      round: 1,
      factClaims: claims,
      formalEvidence: FORMAL_POOL,
      bibEntries: BIB,
      generatedAt: "2026-09-24T00:00:00Z",
    });
    expect(report.totalClaims).toBe(1);
    expect(report.supportedClaims).toBe(1);
    expect(report.evidenceBoundClaims).toBe(1);
    expect(report.evidenceBindingRate).toBe(1);
    const entry = report.claims[0]!;
    expect(entry.evidenceFormal).toBe(true);
    expect(entry.citationKey).toBe("yao2023react"); // sourceId → key（与 Writer 引用同源解析链）
    expect(entry.claimId).toBe(claimFingerprint(entry.section, entry.claim));
  });

  it("unverified evidence 不进入 formal 绑定（citation key 存在也不算 bound）", () => {
    const claims: FactClaimCheck[] = [
      {
        section: "sections/reasoning-acting.tex",
        claim: "某个论断",
        verdict: "SUPPORTED",
        evidenceId: "E099", // 指向 unverified 记录
      },
    ];
    const report = computeClaimGroundingReport({
      projectId: "p1",
      round: 1,
      factClaims: claims,
      formalEvidence: [...FORMAL_POOL, NON_FORMAL],
      bibEntries: BIB,
    });
    expect(report.supportedClaims).toBe(1);
    expect(report.evidenceBoundClaims).toBe(0); // evidenceFormal=false → 不计 bound
    expect(report.evidenceBindingRate).toBe(0);
    expect(report.claims[0]?.evidenceFormal).toBe(false);
    expect(report.claims[0]?.citationKey).toBeUndefined();
  });

  it("UNSUPPORTED claim 携带 bounded 候选；报告统计与 unsupportedClaimIds 正确", () => {
    const claims: FactClaimCheck[] = [
      {
        section: "sections/reasoning-acting.tex",
        claim: "ReAct 在 HotpotQA 上的表现",
        verdict: "UNSUPPORTED",
      },
      {
        section: "sections/reflection.tex",
        claim: "反思机制完全没有代价",
        verdict: "PARTIALLY_SUPPORTED",
        evidenceId: "E003",
      },
      {
        section: "sections/multi-agent.tex",
        claim: "协作提升完成率",
        verdict: "CONTRADICTED",
      },
    ];
    const report = computeClaimGroundingReport({
      projectId: "p1",
      round: 2,
      factClaims: claims,
      formalEvidence: FORMAL_POOL,
      bibEntries: BIB,
    });
    expect(report.totalClaims).toBe(3);
    expect(report.unsupportedClaims).toBe(1);
    expect(report.contradictedClaims).toBe(1);
    expect(report.partiallySupportedClaims).toBe(1);
    expect(report.evidenceBoundClaims).toBe(1); // PARTIAL + formal
    // UNSUPPORTED / CONTRADICTED 都进 unsupportedClaimIds 且获得候选
    expect(report.unsupportedClaimIds).toEqual([
      report.claims[0]!.claimId,
      report.claims[2]!.claimId,
    ]);
    expect(report.claims[0]!.repairCandidates.length).toBeGreaterThan(0);
    expect(report.claims[0]!.repairCandidates[0]!.evidenceId).toBe("E001"); // 词面最相关
    expect(report.claims[1]!.repairCandidates).toEqual([]); // 有支撑的 claim 无候选
  });

  it("无 fact claims（legacy / fact 模式未产出）：全零报告，不报错", () => {
    const report = computeClaimGroundingReport({
      projectId: "p1",
      round: 1,
      factClaims: [],
      formalEvidence: FORMAL_POOL,
      bibEntries: BIB,
    });
    expect(report.totalClaims).toBe(0);
    expect(report.evidenceBindingRate).toBe(0);
    expect(report.claims).toEqual([]);
  });
});

describe("findEvidenceCandidates", () => {
  it("不相关证据不被强绑定：词面重叠 < 2 个不同词 → 无候选", () => {
    const hits = findEvidenceCandidates("量子纠错码的表面码阈值", FORMAL_POOL);
    expect(hits).toEqual([]);
  });

  it("候选排序确定性：matchedTerms 降序 → score → id 字典序；Top-K 有界", () => {
    const many: EvidenceRecord[] = [];
    for (let index = 0; index < 8; index += 1) {
      many.push(
        evidence({
          id: `E1${index}`,
          claim: `ReAct 在 HotpotQA 上的消融变体 ${index}`,
          quote: "ReAct HotpotQA ablation",
        }),
      );
    }
    const first = findEvidenceCandidates("ReAct 在 HotpotQA 上的表现", many);
    const second = findEvidenceCandidates("ReAct 在 HotpotQA 上的表现", many);
    expect(first).toEqual(second); // 确定性
    expect(first.length).toBeLessThanOrEqual(5); // bounded Top-K
  });
});

describe("buildClaimRepairDirectives", () => {
  it("SUPPORT 只允许 verified evidence：候选 id 解析不到 formal 记录 → 丢弃该候选", () => {
    const report = computeClaimGroundingReport({
      projectId: "p1",
      round: 1,
      factClaims: [
        { section: "sections/reasoning-acting.tex", claim: "ReAct 在 HotpotQA 上的表现", verdict: "UNSUPPORTED" },
      ],
      formalEvidence: FORMAL_POOL,
      bibEntries: BIB,
    });
    // 池里只放 E002（E001 不在 evidenceById）：E001 候选必须被丢弃，不得渲染不可用 id
    const evidenceById = new Map([["E002", FORMAL_POOL[1]!]]);
    const directives = buildClaimRepairDirectives(
      report,
      () => true,
      evidenceById,
      BIB,
    );
    expect(directives).toHaveLength(1);
    expect(directives[0]!.candidates.every((c) => c.evidenceId === "E002")).toBe(true);
  });

  it("无候选 evidence → 指令照常派发（空候选 = 只能 WEAKEN / REMOVE 路径）", () => {
    const report = computeClaimGroundingReport({
      projectId: "p1",
      round: 1,
      factClaims: [
        { section: "sections/challenges.tex", claim: "量子纠错码的表面码阈值", verdict: "UNSUPPORTED" },
      ],
      formalEvidence: FORMAL_POOL,
      bibEntries: BIB,
    });
    const directives = buildClaimRepairDirectives(report, () => true, new Map(), BIB);
    expect(directives).toHaveLength(1);
    expect(directives[0]!.candidates).toEqual([]);
  });

  it("章节匹配过滤：只派发命中目标章节的 claim（fuzzy 与修订派发同口径）", () => {
    const report = computeClaimGroundingReport({
      projectId: "p1",
      round: 1,
      factClaims: [
        { section: "sections/reasoning-acting.tex", claim: "ReAct 在 HotpotQA 上的表现", verdict: "UNSUPPORTED" },
        { section: "sections/multi-agent.tex", claim: "多智能体协作提升任务完成率", verdict: "UNSUPPORTED" },
      ],
      formalEvidence: FORMAL_POOL,
      bibEntries: BIB,
    });
    const directives = buildClaimRepairDirectives(
      report,
      (section) => section.includes("multi-agent"),
      new Map(FORMAL_POOL.map((record) => [record.id, record])),
      BIB,
    );
    expect(directives).toHaveLength(1);
    expect(directives[0]!.claim).toContain("多智能体协作");
    expect(directives[0]!.candidates[0]?.citationKey).toBe("park2023generative");
  });
});

describe("ReviewArtifactStore：claim-grounding 产物读写与 legacy 兼容", () => {
  it("save / load 往返一致；缺失与损坏文件 → null（M9.7.6 之前的项目不受影响）", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-cg-"));
    const store = new ProjectStore({ root });
    const artifacts = new ReviewArtifactStore(store);
    const project = await store.create("Claim Grounding Test");
    try {
      // legacy：文件不存在 → null（旧项目 revise 跳过 Repair Context）
      expect(await artifacts.loadClaimGrounding(project.id, 1)).toBeNull();
      expect(await artifacts.latestClaimGrounding(project.id)).toBeNull();

      const report = computeClaimGroundingReport({
        projectId: project.id,
        round: 1,
        factClaims: [
          { section: "s", claim: "c", verdict: "UNSUPPORTED" },
        ],
        formalEvidence: FORMAL_POOL,
        bibEntries: BIB,
      });
      const path = await artifacts.saveClaimGrounding(project.id, report);
      expect(path).toBe("reviews/claim-grounding-r1.json");

      const loaded = await artifacts.loadClaimGrounding(project.id, 1);
      expect(loaded?.reportId).toBe("cg-r1");
      expect(loaded?.unsupportedClaimIds).toHaveLength(1);
      expect(await artifacts.latestClaimGrounding(project.id)).not.toBeNull();

      // 损坏文件（结构不对）→ null，不抛错
      await writeFile(
        join(store.reviewsDir(project.id), "claim-grounding-r2.json"),
        JSON.stringify({ broken: true }),
        "utf8",
      );
      expect(await artifacts.loadClaimGrounding(project.id, 2)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reviews/ 目录尚不存在时读取不抛错（新建项目直接读 latest → null）", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-cg-"));
    const store = new ProjectStore({ root });
    const artifacts = new ReviewArtifactStore(store);
    const project = await store.create("No Reviews Dir");
    try {
      await mkdir(store.reviewsDir(project.id), { recursive: true });
      await rm(store.reviewsDir(project.id), { recursive: true, force: true });
      expect(await artifacts.latestClaimGrounding(project.id)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
