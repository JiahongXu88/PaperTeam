/**
 * M4.3.5 Claim-Citation Semantic Verification 测试（Fake Runtime，无真实模型/网络）：
 * A 支撑 B 部分 C 不支撑 D 文献不存在→SKIPPED E 证据不足→INSUFFICIENT +
 * 引文伪造剥离 + (claim,citation) 单记录 + 确定性 severity + Gate 规则。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";
import { CitationIntegrityService } from "../../src/citation/CitationIntegrityService.js";
import type {
  CitationCallout,
  CitationVerificationRecord,
} from "../../src/citation/integrity.js";
import type { PaperDocument } from "../../src/paper/types.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";

const R001_ABSTRACT =
  "The dominant sequence transduction models are based on recurrent or convolutional networks that include attention mechanisms. We propose the Transformer, a model architecture relying entirely on attention mechanisms. Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task.";

// ---- Fake Runtime：按 claim scope 脚本化 judge 输出 ----

class FakeJudgeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: Array<{ scope: string; taskChars: number }> = [];
  /** claimCitationId → judge JSON 输出；未配置的 claim 抛错 */
  readonly scripted = new Map<string, string>();
  failAll = false;
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
    this.calls.push({ scope, taskChars: input.task.length });
    if (this.failAll) {
      throw new Error("fake model unavailable");
    }
    const claimId = scope.replace("citation/semantic/", "").toUpperCase();
    const output =
      this.scripted.get(claimId) ??
      JSON.stringify({ verdict: "INSUFFICIENT_EVIDENCE", reason: "未脚本化" });
    const now = new Date().toISOString();
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

function semanticDocument(): PaperDocument {
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
    projectId: "p-semantic",
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
      chunk("C0001", 1, "SEC01", 1, "Intro body with markers."),
      chunk("C0002", 2, "SEC02", 2, "Method body with markers."),
      chunk("C0003", 3, "SEC03", 3, "[1] Vaswani… [2] He… [3] Ghost… [4] Unresolved… [5] NoAbstract…"),
    ],
    referencesSectionId: "SEC03",
    ingestedAt: "2026-09-06T00:00:00.000Z",
  };
}

function calloutFixture(id: string, sectionId: string, chunkId: string, referenceId: string, sentence: string): CitationCallout {
  return {
    citationId: id,
    style: "numeric",
    references: [{ referenceId, label: referenceId.slice(1), status: "resolved" }],
    page: sectionId === "SEC02" ? 2 : 1,
    sectionId,
    chunkId,
    sentence,
  };
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
    ...(status === "NOT_FOUND" || status === "UNRESOLVED"
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

describe("M4.3.5 (claim, citation) 语义核验（Fake Runtime）", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let projectId: string;
  let runtime: FakeJudgeRuntime;
  let service: CitationIntegrityService;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-semantic-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    const project = await projects.create("语义核验");
    projectId = project.id;

    const document = semanticDocument();
    document.projectId = projectId;
    await store.saveIngest(projectId, document);

    // references + callouts 直接持久化（extract stage 产物形态）
    const references = [1, 2, 3, 4, 5].map((n) => ({
      referenceId: `R00${n}`,
      number: n,
      rawText: `[${n}] reference ${n}`,
      fingerprint: `fp-R00${n}`,
      page: 3,
      sectionId: "SEC03",
    }));
    const callouts: CitationCallout[] = [
      calloutFixture("CT001", "SEC01", "C0001", "R001", "The dominant models included attention [1]."),
      calloutFixture("CT002", "SEC02", "C0002", "R001", "Our baseline follows the attention mechanism [1]."),
      calloutFixture("CT003", "SEC01", "C0001", "R002", "Segmentation fully solves this problem [2]."),
      calloutFixture("CT004", "SEC02", "C0002", "R002", "Our method doubles the reported accuracy [2]."),
      calloutFixture("CT005", "SEC02", "C0002", "R003", "Ghost et al. proved this lemmas [3]."),
      calloutFixture("CT006", "SEC01", "C0001", "R004", "An unresolved citation backs this [4]."),
      calloutFixture("CT007", "SEC01", "C0001", "R005", "A no-abstract reference supports this [5]."),
      calloutFixture("CT008", "SEC01", "C0001", "R001", "The paper contradicts our claim entirely [1]."),
    ];
    await store.saveExtraction(projectId, { references, callouts });

    // metadata 记录（Layer 1 前置）
    const metadata = [
      metadataFixture("R001", "VERIFIED", { abstract: R001_ABSTRACT }),
      metadataFixture("R002", "VERIFIED", { abstract: "Deep residual learning for image recognition improves classification substantially." }),
      metadataFixture("R003", "NOT_FOUND", { fabrication: true }),
      metadataFixture("R004", "UNRESOLVED"),
      metadataFixture("R005", "VERIFIED"), // 无摘要
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
    runtime.scripted.set("CT001-R001", JSON.stringify({
      verdict: "SUPPORTED",
      reason: "证据说明模型依赖 attention 机制并给出 28.4 BLEU 结果。",
      keyQuote: "We propose the Transformer, a model architecture relying entirely on attention mechanisms.",
    }));
    runtime.scripted.set("CT002-R001", JSON.stringify({
      verdict: "PARTIALLY_SUPPORTED",
      reason: "证据支持 attention 机制本身，但未提及其作为 baseline 的用法。",
    }));
    runtime.scripted.set("CT003-R002", JSON.stringify({
      verdict: "UNSUPPORTED",
      reason: "证据只说改进分类，没有说完全解决该问题。",
    }));
    runtime.scripted.set("CT004-R002", JSON.stringify({
      verdict: "UNSUPPORTED",
      reason: "证据没有任何 doubling accuracy 的数字。",
    }));
    runtime.scripted.set("CT008-R001", JSON.stringify({
      verdict: "CONTRADICTED",
      reason: "（测试引文伪造剥离）",
      keyQuote: "This quote was invented by the judge and never appeared in any evidence.",
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

  it("A/B/C/D/E 全场景 + (claim,citation) 单记录 + 确定性 severity", async () => {
    const result = await service.verifyClaims(projectId);
    const byId = new Map(result.records.map((r) => [r.claimCitationId, r]));

    // A：真实文献 + 明确支持 → SUPPORTED（judge 引文来自证据原文，保留）
    const a = byId.get("CT001-R001")!;
    expect(a.verdict).toBe("SUPPORTED");
    expect(a.status).toBe("verified");
    expect(a.evidence[0]?.text).toContain("[judge 关键引文] We propose the Transformer");
    expect(a.evidence[0]?.evidenceLevel).toBe("abstract"); // 诚实标注证据等级
    expect(a.severity).toBe("info");

    // 同一文献 R001 三处被引 = 三条独立记录
    expect(byId.has("CT002-R001")).toBe(true);
    expect(byId.has("CT008-R001")).toBe(true);

    // B：部分支持 + obligatory → major
    const b = byId.get("CT002-R001")!;
    expect(b.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(b.priority).toBe("obligatory");
    expect(b.severity).toBe("major");

    // C：不支持（helpful → minor / obligatory → critical，确定性派生）
    expect(byId.get("CT003-R002")!.severity).toBe("minor");
    expect(byId.get("CT004-R002")!.severity).toBe("critical");

    // D：文献不存在 / 真实性未确立 → SKIPPED（模型不参与）
    const d = byId.get("CT005-R003")!;
    expect(d.verdict).toBe("SKIPPED");
    expect(d.status).toBe("skipped");
    expect(d.reason).toContain("真实性未确立");
    expect(byId.get("CT006-R004")!.verdict).toBe("SKIPPED");

    // E：无摘要证据 → INSUFFICIENT_EVIDENCE（确定性短路，零模型调用）
    const e = byId.get("CT007-R005")!;
    expect(e.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(e.status).toBe("verified");
    expect(e.evidence).toHaveLength(0);

    // judge 伪造引文 → 剥离（记录中无 [judge 关键引文]）
    const invented = byId.get("CT008-R001")!;
    expect(invented.verdict).toBe("CONTRADICTED");
    expect(invented.evidence[0]?.text).not.toContain("[judge 关键引文]");

    // telemetry：模型只被调 5 次（D/E/短路路径零调用）
    expect(result.telemetry.modelCalls).toBe(5);
    expect(result.telemetry.skippedNoMetadata).toBe(2);
    expect(result.telemetry.skippedNoEvidence).toBe(1);
    expect(runtime.calls.every((call) => call.taskChars < 8000)).toBe(true); // 上下文受控（不含整篇 PDF）

    // gate 汇总
    expect(result.summary.gate).toEqual({
      probableFabricated: 1,
      notFoundObligatory: 1,
      unsupportedCritical: 1,
      mismatchCritical: 0,
      insufficientEvidence: 1,
    });
  });

  it("指纹复用：重跑零模型调用；记录已持久化", async () => {
    const callsBefore = runtime.calls.length;
    const again = await service.verifyClaims(projectId);
    expect(runtime.calls.length).toBe(callsBefore);
    expect(again.reused).toBe(8);
    const persisted = await service.listClaimRecords(projectId);
    expect(persisted).toHaveLength(8);
  });

  it("模型故障 → 单条 failed（可重试），不拖垮其他条目", async () => {
    runtime.failAll = true;
    const failed = await service.verifyClaims(projectId, { force: true, limit: 3 });
    expect(failed.telemetry.failed).toBe(3);
    expect(failed.records.filter((r) => r.status === "failed")).toHaveLength(3);
    runtime.failAll = false;
    const recovered = await service.verifyClaims(projectId);
    expect(recovered.records.every((r) => r.status !== "failed")).toBe(true);
  });

  it("integrityReport + QualityGate 合并规则", async () => {
    const report = await service.integrityReport(projectId);
    expect(report.metadataByStatus.VERIFIED).toBe(3);
    expect(report.metadataByStatus.NOT_FOUND).toBe(1);
    expect(report.probableFabrications).toEqual(["R003"]);
    expect(report.semantic.gate.probableFabricated).toBe(1);

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
    expect(failedRules).toContain("citation_fabrication_zero");
    expect(failedRules).toContain("citation_not_found_obligatory_zero");
    expect(failedRules).toContain("citation_unsupported_critical_zero");
    expect(failedRules).not.toContain("citation_insufficient_evidence_review"); // 不阻断

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
          insufficientEvidence: 3,
        },
      },
      { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: false },
    );
    expect(clean.passed).toBe(true); // INSUFFICIENT_EVIDENCE 不等于 fabricated，不阻断
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
