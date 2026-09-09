/**
 * Claim-Citation Semantic Verification v4 测试（Fake Runtime，无真实模型/网络）。
 *
 * 核验粒度 = atomic claim × citation group（不再是 sentence × every reference）：
 * - 复合句 + [1] / [2] / [3,4,5] 三组：拆成原子论断，各自绑定邻近组——
 *   [3,4,5] 是一条组记录（3 篇共同支撑），不是 3 条「各自支撑整句」的记录；
 * - 组证据合并 judge：某篇组员只承担部分责任 / 无摘要 / 真实性未确立
 *   都不自动变成 UNSUPPORTED；
 * - metadata-only → INSUFFICIENT_EVIDENCE（info，不是论文问题）；无证据零模型调用
 *   （含拆解层）；
 * - CONTRADICTED 必须带逐字 keyQuote（引不出 → 确定性降级 INSUFFICIENT）；
 * - contradiction_only 三值口径；拆解失败 / 预算耗尽走确定性兜底；缓存复用。
 *
 * 全部 fixture 为通用学术语句结构，无任何特定论文特判。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";
import { CitationIntegrityService } from "../../src/citation/CitationIntegrityService.js";
import {
  groupCalloutsBySentence,
  type SentenceCalloutGroup,
} from "../../src/citation/claimDecomposition.js";
import type {
  CitationCallout,
  CitationVerificationRecord,
} from "../../src/citation/integrity.js";
import type { PaperDocument } from "../../src/paper/types.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";

const R001_ABSTRACT =
  "We present architecture A, a recurrent architecture for sequence modeling. It achieves state of the art results on language modeling benchmarks.";

const R002_ABSTRACT =
  "We present architecture B, a gated recurrent architecture. It matches state of the art results on sequence transduction benchmarks.";

const R003_ABSTRACT =
  "We study sequence-to-sequence learning for machine translation with recurrent models. Our models establish new state of the art results for neural machine translation and language modeling.";

const R006_ABSTRACT =
  "The dominant sequence transduction models are based on recurrent or convolutional networks that include attention mechanisms. We propose the Transformer, a model architecture relying entirely on attention mechanisms. Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task and improves accuracy substantially.";

/** 复合句：三组引用共存（[1] / [2] / [3, 4, 5]）——v4 关键场景 */
const COMPOUND_SENTENCE =
  "Architecture A [1] and architecture B [2] have been firmly established as state of the art approaches in sequence modeling and transduction problems such as language modeling and machine translation [3, 4, 5].";

// ---- Fake Runtime：judge 按 claimCitationId 脚本化；拆解按 scope 分派 ----

class FakeJudgeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: Array<{ scope: string; taskChars: number; task: string }> = [];
  /** claimCitationId → judge JSON 输出；未配置的 claim 默认 INSUFFICIENT_EVIDENCE */
  readonly scripted = new Map<string, string>();
  /** 拆解批量输出（citation/decompose/* scope 一律返回该串） */
  decomposeOutput: string | undefined;
  failJudge = false;
  failDecompose = false;
  private counter = 0;

  async healthCheck(): Promise<RuntimeHealth> {
    return {
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "fake",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    };
  }

  async runAgent(input: { agentId: string; contextScope?: string; task: string }): Promise<AgentTask> {
    this.counter += 1;
    const scope = input.contextScope ?? "";
    this.calls.push({ scope, taskChars: input.task.length, task: input.task });
    const now = new Date().toISOString();
    if (scope.startsWith("citation/decompose/")) {
      if (this.failDecompose) {
        throw new Error("fake decomposer unavailable");
      }
      return {
        taskId: `fake-${this.counter}`,
        agentId: input.agentId,
        status: "completed",
        createdAt: now,
        updatedAt: now,
        output: this.decomposeOutput ?? "not json",
        metadata: { model: "fake-decomposer" },
      };
    }
    if (this.failJudge) {
      throw new Error("fake model unavailable");
    }
    const claimId = scope.replace("citation/semantic/", "").toUpperCase();
    const output =
      this.scripted.get(claimId) ??
      JSON.stringify({ verdict: "INSUFFICIENT_EVIDENCE", reason: "未脚本化" });
    return {
      taskId: `fake-${this.counter}`,
      agentId: input.agentId,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      output,
      metadata: { model: "fake-judge" },
    };
  }

  async startAgent(input: Parameters<AgentRuntime["startAgent"]>[0]) {
    const task = await this.runAgent(input);
    return {
      taskId: task.taskId,
      sessionKey: "fake",
      events: async function* () {},
      cancel: async () => {},
      result: async () => task,
    };
  }

  async getTask(): Promise<AgentTask> {
    throw new Error("not implemented");
  }

  async close() {}
}

// ---- fixture ----

function semanticDocument(projectId: string): PaperDocument {
  const chunk = (id: string, sequence: number, sectionId: string, page: number, text: string) => ({
    chunkId: id,
    sequence,
    pageStart: page,
    pageEnd: page,
    sectionId,
    text,
    charCount: text.length,
  });
  return {
    schemaVersion: 1,
    projectId,
    documentId: "paper-1",
    originalFileName: "s.pdf",
    bytes: 1,
    sha256: "c".repeat(64),
    parse: {
      parserId: "test",
      parsedAt: "2026-09-06T00:00:00.000Z",
      durationMs: 1,
      pageCount: 3,
      extractionQuality: "good",
    },
    pages: Array.from({ length: 3 }, (_, i) => ({
      pageId: `P${String(i + 1).padStart(3, "0")}`,
      pageNumber: i + 1,
      text: "",
      charCount: 0,
    })),
    sections: [
      { sectionId: "SEC01", title: "Introduction", level: 1, pageStart: 1, pageEnd: 1, charCount: 0, source: "toc" },
      { sectionId: "SEC02", title: "Method and Experiments", level: 1, pageStart: 1, pageEnd: 2, charCount: 0, source: "toc" },
      { sectionId: "SEC03", title: "References", level: 1, pageStart: 3, pageEnd: 3, charCount: 0, source: "toc" },
    ],
    chunks: [
      chunk("C0001", 1, "SEC01", 1, "Intro body."),
      chunk("C0002", 2, "SEC02", 2, "Method body."),
      chunk("C0003", 3, "SEC03", 3, "[1]…[2]…[3]…[4]…[5]…[6]…[7]…[8]…"),
    ],
    referencesSectionId: "SEC03",
    ingestedAt: "2026-09-06T00:00:00.000Z",
  };
}

function callout(
  id: string,
  chunkId: string,
  sectionId: string,
  rawText: string,
  relations: CitationCallout["references"],
  sentence: string,
  page = 1,
): CitationCallout {
  return {
    citationId: id,
    style: "numeric",
    references: relations,
    rawText,
    page,
    sectionId,
    chunkId,
    sentence,
  };
}

function resolved(label: string, referenceId: string): CitationCallout["references"][number] {
  return { label, referenceId, status: "resolved" };
}

function metadataFixture(
  referenceId: string,
  status: CitationVerificationRecord["status"],
  options: { abstract?: string; fabrication?: boolean } = {},
): CitationVerificationRecord {
  return {
    referenceId,
    status,
    probableFabrication: options.fabrication ?? false,
    ...(status === "NOT_FOUND" || status === "UNRESOLVED" || status === "PROVIDER_ERROR"
      ? {}
      : {
          canonical: {
            provider: "openalex",
            recordId: `w-${referenceId}`,
            title: `Canonical paper ${referenceId}`,
            authors: ["Ashish Vaswani"],
            year: 2017,
            doi: `10.1000/${referenceId.toLowerCase()}`,
            ...(options.abstract !== undefined ? { abstract: options.abstract } : {}),
            retrievedAt: "2026-09-06T00:00:00.000Z",
          },
        }),
    attempts: [{ provider: "openalex", outcome: status === "VERIFIED" ? "match" : "not_found" }],
    checkedAt: "2026-09-06T00:00:00.000Z",
    fingerprint: `fp-${referenceId}`,
  };
}

describe("M4.3.5 语义核验 v4（atomic claim × citation group，Fake Runtime）", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let projectId: string;
  let runtime: FakeJudgeRuntime;
  let service: CitationIntegrityService;
  let compoundGroup: SentenceCalloutGroup;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-semantic-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    const project = await projects.create("语义核验");
    projectId = project.id;

    const document = semanticDocument(projectId);
    await store.saveIngest(projectId, document);

    const references = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      referenceId: `R00${n}`,
      number: n,
      rawText: `[${n}] reference ${n}`,
      fingerprint: `fp-R00${n}`,
      page: 3,
      sectionId: "SEC03",
    }));
    // 复合句的三组 callout（同一 chunk、同一句子文本 → 归入同一句）
    const callouts: CitationCallout[] = [
      callout("CT001", "C0001", "SEC01", "[1]", [resolved("1", "R001")], COMPOUND_SENTENCE),
      callout("CT002", "C0001", "SEC01", "[2]", [resolved("2", "R002")], COMPOUND_SENTENCE),
      callout(
        "CT003",
        "C0001",
        "SEC01",
        "[3, 4, 5]",
        [resolved("3", "R003"), resolved("4", "R004"), resolved("5", "R005")],
        COMPOUND_SENTENCE,
      ),
      callout("CT004", "C0002", "SEC02", "[6]", [resolved("6", "R006")], "Our baseline follows the attention mechanism [6].", 2),
      callout("CT005", "C0001", "SEC01", "[7]", [{ label: "7", status: "unresolved" }], "An unresolved citation backs this claim [7]."),
      callout("CT006", "C0001", "SEC01", "[8]", [resolved("8", "R008")], "A metadata-only reference supports this [8]."),
      callout("CT007", "C0001", "SEC01", "[6]", [resolved("6", "R006")], "The cited work contradicts our claim entirely [6]."),
      callout("CT008", "C0002", "SEC02", "[6]", [resolved("6", "R006")], "The cited method reduces accuracy on this benchmark [6].", 2),
      callout("CT009", "C0001", "SEC01", "[6]", [resolved("6", "R006")], "Quantum error correction improves translation quality [6]."),
      callout("CT010", "C0001", "SEC01", "[6]", [resolved("6", "R006")], "The architecture processes images end to end [6]."),
    ];
    await store.saveExtraction(projectId, { references, callouts });

    const metadata = [
      metadataFixture("R001", "VERIFIED", { abstract: R001_ABSTRACT }),
      metadataFixture("R002", "VERIFIED", { abstract: R002_ABSTRACT }),
      metadataFixture("R003", "VERIFIED", { abstract: R003_ABSTRACT }),
      metadataFixture("R004", "VERIFIED"), // 组内成员：真实但无摘要（不参与证据）
      metadataFixture("R005", "NOT_FOUND"), // 组内成员：真实性未确立（Layer 1 问题）
      metadataFixture("R006", "VERIFIED", { abstract: R006_ABSTRACT }),
      metadataFixture("R007", "UNRESOLVED"),
      metadataFixture("R008", "VERIFIED"), // metadata-only
    ];
    for (const record of metadata) {
      await store.saveRecord(projectId, "metadata", record.referenceId, record);
    }
    await store.saveStage(projectId, {
      stage: "metadata",
      status: "ok",
      inputFingerprint: "preseeded",
      updatedAt: "2026-09-06T00:00:00.000Z",
    });

    runtime = new FakeJudgeRuntime();
    // 复合句拆解（按真实 sentenceKey 组装，避免测试硬编码哈希）
    compoundGroup = groupCalloutsBySentence(callouts)[0]!;
    runtime.decomposeOutput = JSON.stringify({
      sentences: [
        {
          id: compoundGroup.sentenceKey,
          claims: [
            {
              text: "Architecture A has been firmly established as a state of the art approach in sequence modeling and transduction problems.",
              markers: ["CT001"],
            },
            {
              text: "Architecture B has been firmly established as a state of the art approach in sequence modeling and transduction problems.",
              markers: ["CT002"],
            },
            {
              text: "Architecture A and architecture B are used for language modeling and machine translation.",
              markers: ["CT003"],
            },
          ],
        },
      ],
    });
    // judge 脚本
    runtime.scripted.set("CT001-AC1", JSON.stringify({
      verdict: "SUPPORTED",
      reason: "证据明确给出 architecture A 在语言建模上的 SOTA 结果。",
      keyQuote: "It achieves state of the art results on language modeling benchmarks.",
    }));
    runtime.scripted.set("CT002-AC2", JSON.stringify({
      verdict: "SUPPORTED",
      reason: "证据明确给出 architecture B 的 SOTA 结论。",
    }));
    // 组级 judge：三篇共同支撑 → SUPPORTED（不要求每篇单独覆盖）
    runtime.scripted.set("CT003-AC3", JSON.stringify({
      verdict: "SUPPORTED",
      reason: "组内证据给出循环模型在机器翻译与语言建模上的 SOTA 结论，共同支撑该论断。",
      keyQuote: "Our models establish new state of the art results for neural machine translation and language modeling.",
    }));
    runtime.scripted.set("CT004-AC1", JSON.stringify({
      verdict: "PARTIALLY_SUPPORTED",
      reason: "证据支持 attention 机制本身，但未提及其作为 baseline 的用法。",
    }));
    // CONTRADICTED + 编造引文（不在任何证据中）→ 剥离 + 确定性降级
    runtime.scripted.set("CT007-AC1", JSON.stringify({
      verdict: "CONTRADICTED",
      reason: "证据与论断相反。",
      keyQuote: "This quote was invented by the judge and never appeared in any evidence.",
    }));
    // CONTRADICTED + 逐字引文（来自证据）→ 保留
    runtime.scripted.set("CT008-AC1", JSON.stringify({
      verdict: "CONTRADICTED",
      reason: "证据报告该方法大幅提升准确率，与「降低准确率」的论断明确相反。",
      keyQuote: "improves accuracy substantially",
    }));
    // 主题无关但证据具体：judge 给出 UNSUPPORTED（收紧口径下合法）
    runtime.scripted.set("CT009-AC1", JSON.stringify({
      verdict: "UNSUPPORTED",
      reason: "证据研究的是翻译任务的序列模型，与量子纠错无关，不能支撑该论断。",
    }));
    // 证据笼统 → INSUFFICIENT_EVIDENCE
    runtime.scripted.set("CT010-AC1", JSON.stringify({
      verdict: "INSUFFICIENT_EVIDENCE",
      reason: "摘要未提及图像处理，无法判断。",
    }));

    service = new CitationIntegrityService({
      projects,
      store,
      runtime,
      citationAgentId: "citation",
      scholarly: { providers: [] },
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("复合句 × [1]/[2]/[3,4,5]：原子论断绑定邻近组；组不展开成逐篇整句记录", async () => {
    const result = await service.verifyClaims(projectId);
    const byId = new Map(result.records.map((r) => [r.claimCitationId, r]));

    // 复合句产出 3 条记录（每组一条），不是 5 条（组员不成条）
    expect(byId.has("CT001-AC1")).toBe(true);
    expect(byId.has("CT002-AC2")).toBe(true);
    expect(byId.has("CT003-AC3")).toBe(true);
    expect(result.records.filter((r) => r.citationId === "CT003")).toHaveLength(1);

    // 原子论断：各自只含本组的命题；无引用标记残留
    const c1 = byId.get("CT001-AC1")!;
    expect(c1.claimText).toContain("Architecture A");
    expect(c1.claimText).not.toContain("Architecture B");
    expect(c1.claimText).not.toContain("[1]");
    expect(c1.claimIndex).toBe(1);
    expect(c1.sourceSentence).toBe(COMPOUND_SENTENCE);
    expect(byId.get("CT002-AC2")!.claimText).toContain("Architecture B");

    // 组记录：成员共同承担，rawText 保留
    const group = byId.get("CT003-AC3")!;
    expect(group.referenceIds).toEqual(["R003", "R004", "R005"]);
    expect(group.referenceId).toBe("R003"); // anchor
    expect(group.groupRawText).toBe("[3, 4, 5]");
    expect(group.claimText).toContain("language modeling and machine translation");
    expect(group.claimText).not.toContain("Architecture A [1]");

    // 汇总：组形态 + 原子论断数
    expect(result.summary.groupShape).toEqual({ single: result.summary.total - 1, group: 1 });
    expect(result.summary.atomicClaims).toBe(9); // 10 callouts - CT005（unresolved 无记录）
  });

  it("citation group 共同支撑：组级 judge + 组员不完整覆盖不自动 UNSUPPORTED", async () => {
    const result = await service.verifyClaims(projectId);
    const byId = new Map(result.records.map((r) => [r.claimCitationId, r]));
    const group = byId.get("CT003-AC3")!;

    // 组 verdict = judge 的组级结论（SUPPORTED），而不是任何单篇「不支持整句」
    expect(group.verdict).toBe("SUPPORTED");
    expect(group.severity).toBe("info");
    // 证据只来自有摘要的组员（R003）；无摘要 / NOT_FOUND 组员未参与
    expect(group.evidence).toHaveLength(1);
    expect(group.evidence[0]?.source).toContain("w-R003");
    expect(group.excludedReferenceIds).toEqual(["R004", "R005"]);

    // 组级 prompt：组语义口径 + 原子论断 + 禁止记忆（取最近一次该 scope 的调用）
    const ct003Calls = runtime.calls.filter((c) => c.scope.toLowerCase().endsWith("ct003-ac3"));
    const call = ct003Calls[ct003Calls.length - 1];
    expect(call).toBeDefined();
    expect(call!.task).toContain("引用组");
    expect(call!.task).toContain("共同支撑");
    expect(call!.task).toContain("不要求任何一篇单独覆盖");
    expect(call!.task).toContain("[3, 4, 5]");
    expect(call!.task).toContain("禁止使用自己的记忆");
    expect(call!.task).toContain("Architecture A and architecture B are used for language modeling and machine translation.");
    // 单篇组员（如 R004/R005）从未被单独要求支撑整句
    const memberScopes = runtime.calls.filter((c) =>
      ["ct003-r003", "ct003-r004", "ct003-r005"].some((id) => c.scope.toLowerCase().endsWith(id)),
    );
    expect(memberScopes).toHaveLength(0);
  });

  it("PARTIALLY_SUPPORTED 语义（obligatory → major）；UNSUPPORTED 只在证据足够具体时成立", async () => {
    const result = await service.verifyClaims(projectId);
    const byId = new Map(result.records.map((r) => [r.claimCitationId, r]));

    const partial = byId.get("CT004-AC1")!;
    expect(partial.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(partial.priority).toBe("obligatory"); // Method 节
    expect(partial.severity).toBe("major");

    const unsupported = byId.get("CT009-AC1")!;
    expect(unsupported.verdict).toBe("UNSUPPORTED");
    expect(unsupported.severity).toBe("minor"); // helpful + UNSUPPORTED

    const insufficient = byId.get("CT010-AC1")!;
    expect(insufficient.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(insufficient.reasonCode).toBe("ABSTRACT_ONLY");
    expect(insufficient.severity).toBe("info");
  });

  it("metadata-only / 真实性未确立：零模型调用；INSUFFICIENT 不是论文问题", async () => {
    const result = await service.verifyClaims(projectId, { force: true });
    const byId = new Map(result.records.map((r) => [r.claimCitationId, r]));

    // 无摘要（metadata-only）→ INSUFFICIENT_EVIDENCE（NO_EVIDENCE），evidence 空
    const noAbstract = byId.get("CT006-AC1")!;
    expect(noAbstract.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(noAbstract.reasonCode).toBe("NO_EVIDENCE");
    expect(noAbstract.evidence).toHaveLength(0);
    expect(noAbstract.status).toBe("verified");
    expect(noAbstract.severity).toBe("info"); // 不是 minor/major——不构成 Finding
    expect(noAbstract.reason).toContain("不代表引用存在问题");

    // 组内无可关联文献（unresolved）→ 不进 semantic（无记录）
    expect(result.records.some((r) => r.citationId === "CT005")).toBe(false);

    // telemetry：短路零模型调用
    expect(result.telemetry.skippedNoEvidence).toBe(1);
    // CT005 组 0 resolved 成员 → buildClaimRecords 直接跳过（不占 skippedNoMetadata）
    // 模型调用 = 拆解 1 批 + judge 8 条
    expect(result.telemetry.decompositionCalls).toBe(1);
    expect(result.telemetry.modelCalls).toBe(8);
  });

  it("CONTRADICTED 必须带逐字引文：编造引文 → 剥离并确定性降级 INSUFFICIENT", async () => {
    const result = await service.verifyClaims(projectId);
    const byId = new Map(result.records.map((r) => [r.claimCitationId, r]));

    // 编造引文的矛盾：降级
    const unquoted = byId.get("CT007-AC1")!;
    expect(unquoted.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(unquoted.reasonCode).toBe("UNQUOTED_CONTRADICTION");
    expect(unquoted.severity).toBe("info");
    expect(unquoted.evidence[0]?.text).not.toContain("[judge 关键引文]");

    // 逐字引文的矛盾：保留 CONTRADICTED（obligatory → critical）
    const quoted = byId.get("CT008-AC1")!;
    expect(quoted.verdict).toBe("CONTRADICTED");
    expect(quoted.severity).toBe("critical");
    expect(quoted.evidence[0]?.text).toContain("[judge 关键引文] improves accuracy substantially");

    // 全库只有一条真 CONTRADICTED
    expect(result.summary.byVerdict.CONTRADICTED).toBe(1);
  });

  it("Quality Gate：INSUFFICIENT 不阻断；UNSUPPORTED/CONTRADICTED critical 阻断", async () => {
    const report = await service.integrityReport(projectId);
    // R005 NOT_FOUND 且被 obligatory 引用？——引用组在 Introduction（helpful），
    // notFoundObligatory 只统计 obligatory 记录：本 fixture 为 0
    expect(report.semantic.gate.unsupportedCritical).toBe(1); // CT008-AC1 CONTRADICTED critical
    expect(report.semantic.gate.insufficientEvidence).toBe(3); // CT006 NO_EVIDENCE + CT007 降级 + CT010 ABSTRACT_ONLY

    const failing = evaluateQualityGate(
      {
        review: passingReview(),
        citation: null,
        evidence: { contradictory: 0 } as never,
        feasibility: null,
        citationIntegrity: report.semantic.gate,
      },
      { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: false },
    );
    const failedRules = failing.rules.filter((rule) => !rule.passed).map((rule) => rule.rule);
    // R005 单源 NOT_FOUND（非多源一致）→ 不判捏造，fabrication 规则通过
    expect(failedRules).not.toContain("citation_fabrication_zero");
    expect(failedRules).toContain("citation_unsupported_critical_zero"); // CT008-AC1 CONTRADICTED critical
    expect(failedRules).not.toContain("citation_insufficient_evidence_review"); // 永不阻断

    const clean = evaluateQualityGate(
      {
        review: passingReview(),
        citation: null,
        evidence: { contradictory: 0 } as never,
        feasibility: null,
        citationIntegrity: {
          probableFabricated: 0,
          notFoundObligatory: 0,
          unsupportedCritical: 0,
          mismatchCritical: 0,
          insufficientEvidence: 99, // 只有证据不足 → 通过
        },
      },
      { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: false },
    );
    expect(clean.passed).toBe(true);
  });

  it("指纹复用：重跑零模型调用、零拆解调用（拆解缓存命中）", async () => {
    const callsBefore = runtime.calls.length;
    const again = await service.verifyClaims(projectId);
    expect(runtime.calls.length).toBe(callsBefore);
    expect(again.reused).toBe(9);
    expect(again.telemetry.decompositionCalls).toBe(0);
    expect(again.telemetry.decompositionCacheHits).toBe(1);
    const persisted = await service.listClaimRecords(projectId);
    expect(persisted).toHaveLength(9);
  });

  it("拆解失败 → 确定性兜底（整句单论断、绑定全部组）；核验仍完整", async () => {
    runtime.failDecompose = true;
    const result = await service.verifyClaims(projectId, { force: true });
    runtime.failDecompose = false;
    const byId = new Map(result.records.map((r) => [r.claimCitationId, r]));

    // 复合句兜底：单论断（整句去标记）+ 三组各一条记录（都绑定该论断）
    const fallbackClaims = result.records.filter((r) => r.sourceSentence === COMPOUND_SENTENCE);
    expect(fallbackClaims).toHaveLength(3); // CT001/CT002/CT003 各一条（AC1）
    expect(new Set(fallbackClaims.map((r) => r.claimIndex)).size).toBe(1);
    expect(fallbackClaims.every((r) => r.claimText === fallbackClaims[0]!.claimText)).toBe(true);
    expect(fallbackClaims[0]!.claimText).not.toContain("[3, 4, 5]");
    expect(fallbackClaims.map((r) => r.citationId).sort()).toEqual(["CT001", "CT002", "CT003"]);
    // 拆解失败：复合句退兜底；简单句本来就走兜底（8 句全部 fallback 计划）
    expect(result.telemetry.sentencesPlanned).toBe(8);
    expect(result.telemetry.fallbackSentencePlans).toBe(8);
    expect(result.telemetry.decompositionCalls).toBe(1); // 调用过但失败（failDecompose）
    // 兜底记录照常核验（judge 收到的是去标记整句）
    const c1 = byId.get("CT001-AC1")!;
    expect(["SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED", "CONTRADICTED", "INSUFFICIENT_EVIDENCE"]).toContain(c1.verdict);
    // 恢复正常拆解，为后续用例还原状态
    await service.verifyClaims(projectId, { force: true });
  });

  it("judge 模型故障 → 单条 failed（可重试），不拖垮其他条目", async () => {
    runtime.failJudge = true;
    const failed = await service.verifyClaims(projectId, { force: true, limit: 3 });
    expect(failed.telemetry.failed).toBe(3);
    expect(failed.records.filter((r) => r.status === "failed")).toHaveLength(3);
    runtime.failJudge = false;
    const recovered = await service.verifyClaims(projectId);
    expect(recovered.records.every((r) => r.status !== "failed")).toBe(true);
  });

  it("contradiction_only：三值口径；full verdict 非法 → failed；无证据 → SKIPPED", async () => {
    runtime.scripted.set("CT001-AC1", JSON.stringify({ verdict: "NO_CONTRADICTION_DETECTED", reason: "证据未发现相反结论" }));
    runtime.scripted.set("CT003-AC3", JSON.stringify({ verdict: "NO_CONTRADICTION_DETECTED", reason: "组证据未发现相反结论" }));
    runtime.scripted.set("CT002-AC2", JSON.stringify({ verdict: "NO_CONTRADICTION_DETECTED", reason: "证据未发现相反结论" }));
    runtime.scripted.set("CT004-AC1", JSON.stringify({ verdict: "CONTRADICTED", reason: "证据明确相反", keyQuote: "We propose the Transformer, a model architecture relying entirely on attention mechanisms." }));
    runtime.scripted.set("CT007-AC1", JSON.stringify({ verdict: "NO_CONTRADICTION_DETECTED", reason: "证据未发现相反结论" }));
    runtime.scripted.set("CT008-AC1", JSON.stringify({ verdict: "NO_CONTRADICTION_DETECTED", reason: "证据未发现相反结论" }));
    runtime.scripted.set("CT009-AC1", JSON.stringify({ verdict: "INSUFFICIENT_EVIDENCE", reason: "证据与论断主题无关，无法核对矛盾" }));
    runtime.scripted.set("CT010-AC1", JSON.stringify({ verdict: "NO_CONTRADICTION_DETECTED", reason: "证据未发现相反结论" }));
    // full 口径的 verdict 在 contradiction 模式非法 → 该条 failed（严格解析，不静默降级）
    runtime.scripted.set("CT006-AC1", JSON.stringify({ verdict: "SUPPORTED", reason: "不该出现" }));

    const result = await service.verifyClaims(projectId, { mode: "contradiction_only" });
    expect(result.mode).toBe("contradiction_only");
    expect(result.reused).toBe(0); // full 模式的旧记录一律重跑（指纹含 mode）

    const byId = new Map(result.records.map((r) => [r.claimCitationId, r]));
    // 无证据（metadata-only）→ SKIPPED，不产生 INSUFFICIENT 噪音
    const noEvidence = byId.get("CT006-AC1")!;
    expect(noEvidence.status).toBe("skipped");
    // 注：CT006-AC1 的脚本输出（SUPPORTED）因无证据短路根本没有机会到达 judge；
    // 非法 verdict 用例换到有证据的条目上验证：
    runtime.scripted.set("CT010-AC1", JSON.stringify({ verdict: "SUPPORTED", reason: "不该出现" }));
    const reRun = await service.verifyClaims(projectId, { mode: "contradiction_only", force: true });
    const reById = new Map(reRun.records.map((r) => [r.claimCitationId, r]));
    expect(reById.get("CT010-AC1")!.status).toBe("failed");

    // 汇总口径：CONTRADICTED / NO_CONTRADICTION_DETECTED / INSUFFICIENT_EVIDENCE 计数
    expect(result.summary.byVerdict.CONTRADICTED).toBe(1);
    expect(result.summary.byVerdict.NO_CONTRADICTION_DETECTED).toBe(6);
    expect(result.summary.byVerdict.INSUFFICIENT_EVIDENCE).toBe(1); // CT009（证据无关，无法核对矛盾）
    expect(result.summary.byVerdict.SKIPPED).toBe(1); // CT006 无证据短路
    // contradiction prompt：组语义 + 三值口径（取最近一次该 scope 的调用）
    const ct003Calls = runtime.calls.filter((c) => c.scope.toLowerCase().endsWith("ct003-ac3"));
    const call = ct003Calls[ct003Calls.length - 1];
    expect(call).toBeDefined();
    expect(call!.task).toContain("实质性矛盾");
    expect(call!.task).toContain("CONTRADICTED / NO_CONTRADICTION_DETECTED / INSUFFICIENT_EVIDENCE");
    // 还原 full 模式脚本
    runtime.scripted.delete("CT006-AC1");
    runtime.scripted.set("CT010-AC1", JSON.stringify({ verdict: "INSUFFICIENT_EVIDENCE", reason: "摘要未提及图像处理，无法判断。" }));
  });
});

describe("M4.3.5 无证据项目：全程零模型调用（拆解也不烧）", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let projectId: string;
  let runtime: FakeJudgeRuntime;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-semantic-none-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    const project = await projects.create("全部 metadata-only");
    projectId = project.id;
    const document = semanticDocument(projectId);
    await store.saveIngest(projectId, document);
    const references = [1, 2, 3, 4].map((n) => ({
      referenceId: `R00${n}`,
      number: n,
      rawText: `[${n}] reference ${n}`,
      fingerprint: `fp-R00${n}`,
      page: 3,
      sectionId: "SEC03",
    }));
    const sentence =
      "Architecture A [1] and architecture B [2] are widely used for task C [3, 4] in many settings.";
    const callouts: CitationCallout[] = [
      callout("CT001", "C0001", "SEC01", "[1]", [resolved("1", "R001")], sentence),
      callout("CT002", "C0001", "SEC01", "[2]", [resolved("2", "R002")], sentence),
      callout("CT003", "C0001", "SEC01", "[3, 4]", [resolved("3", "R003"), resolved("4", "R004")], sentence),
    ];
    await store.saveExtraction(projectId, { references, callouts });
    for (const n of [1, 2, 3, 4]) {
      await store.saveRecord(projectId, "metadata", `R00${n}`, metadataFixture(`R00${n}`, "VERIFIED")); // 全部无摘要
    }
    await store.saveStage(projectId, {
      stage: "metadata",
      status: "ok",
      inputFingerprint: "preseeded",
      updatedAt: "2026-09-06T00:00:00.000Z",
    });
    runtime = new FakeJudgeRuntime();
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("全部 metadata-only：modelCalls=0、decompositionCalls=0，全 INSUFFICIENT_EVIDENCE", async () => {
    const service = new CitationIntegrityService({
      projects,
      store,
      runtime,
      citationAgentId: "citation",
      scholarly: { providers: [] },
    });
    const result = await service.verifyClaims(projectId);
    expect(result.telemetry.modelCalls).toBe(0);
    expect(result.telemetry.decompositionCalls).toBe(0); // 无可判证据的句子不拆解
    expect(result.telemetry.skippedNoEvidence).toBe(3);
    expect(result.records.every((r) => r.verdict === "INSUFFICIENT_EVIDENCE")).toBe(true);
    expect(result.records.every((r) => r.severity === "info")).toBe(true);
    expect(runtime.calls).toHaveLength(0);
    // 组记录形态仍然正确（[3,4] 是一条组记录）
    expect(result.records.find((r) => r.citationId === "CT003")!.referenceIds).toEqual(["R003", "R004"]);
  });
});

function passingReview() {
  return {
    generatedAt: "2026-09-06T00:00:00.000Z",
    round: 1,
    issues: [],
    counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
    scores: { academicScore: 90, styleRisk: 10, factVerdicts: null },
    openCritical: 0,
    openMajor: 0,
    unsupportedCriticalClaims: 0,
    reportPaths: [],
  };
}
