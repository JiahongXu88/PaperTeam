/**
 * software 类引用核验回归（YOLO11 场景）。
 *
 * Ground truth：Ultralytics YOLO11 是真实软件/模型，没有正式 research paper——
 * Crossref/OpenAlex/arXiv 未收录是事实，推不出 Reference NOT_FOUND。
 * 正确语义：kind=software，经官方 repository / documentation 核验真实性。
 * 全部 fake fetch / fake scholarly providers，无公网。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";
import { CitationIntegrityService } from "../../src/citation/CitationIntegrityService.js";
import { METADATA_VERIFICATION_VERSION, ScholarlyResolver } from "../../src/citation/scholarly.js";
import {
  SoftwareReferenceResolver,
  SOFTWARE_VERIFICATION_VERSION,
} from "../../src/citation/softwareResolver.js";
import { extractRepositoryRef, inferReferenceKind } from "../../src/citation/referenceKinds.js";
import type { CitationCallout, ReferenceEntry } from "../../src/citation/integrity.js";
import type { PaperDocument } from "../../src/paper/types.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";

const NOW = "2026-09-07T00:00:00.000Z";

/** D:\Tmp\paper.pdf 提取出的真实条目（Reference [2]，原文一致） */
const YOLO11_REFERENCE: ReferenceEntry = {
  referenceId: "R002",
  number: 2,
  rawText:
    "[2] G. Jocher and J. Qiu, “Ultralytics yolo11,” 2024, version 11.0.0. [Online]. Available: https://github.com/ultralytics/ultralytics",
  year: 2024,
  authors: ["G. Jocher", "J. Qiu"],
  title: "Ultralytics yolo11",
  page: 25,
  sectionId: "SEC36",
  chunkId: "C0040",
  fingerprint: "fp-yolo11",
};

const GITHUB_API_ULTRALYTICS = {
  full_name: "ultralytics/ultralytics",
  name: "ultralytics",
  description:
    "Ultralytics YOLO26, YOLO11, YOLOv8 — object detection, instance segmentation, semantic segmentation, image classification, pose estimation, object tracking",
  html_url: "https://github.com/ultralytics/ultralytics",
  homepage: "https://docs.ultralytics.com",
  stargazers_count: 60000,
  created_at: "2022-05-12T00:00:00Z",
  pushed_at: "2026-09-07T00:00:00Z",
  owner: { login: "ultralytics" },
};

const GITHUB_PAGE_HTML =
  '<html><head><meta property="og:title" content="GitHub - ultralytics/ultralytics: Ultralytics YOLO11, YOLOv8 object detection toolkit" /><meta name="description" content="Ultralytics YOLO11, YOLOv8 object detection toolkit - ultralytics/ultralytics" /></head><body></body></html>';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function htmlResponse(body: string, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response;
}

// ---- kind 推断 ----

describe("引用类型推断（referenceKinds）", () => {
  it("YOLO11 条目（含 GitHub 链接）→ software；ByteTrack 论文条目 → scholarly_paper", () => {
    expect(inferReferenceKind(YOLO11_REFERENCE)).toBe("software");
    const paper: ReferenceEntry = {
      ...YOLO11_REFERENCE,
      referenceId: "R001",
      rawText: "[1] Y. Zhang et al., “ByteTrack: Multi-object tracking…,” ECCV, 2022.",
      title: "ByteTrack: Multi-object tracking",
      url: undefined,
    };
    expect(inferReferenceKind(paper)).toBe("scholarly_paper");
  });

  it("repository 链接提取：url 字段优先，rawText 兜底（.git / 尾随路径归一）", () => {
    expect(extractRepositoryRef(YOLO11_REFERENCE)).toEqual({
      host: "github.com",
      owner: "ultralytics",
      repo: "ultralytics",
      url: "https://github.com/ultralytics/ultralytics",
    });
    expect(
      extractRepositoryRef({ rawText: "see https://github.com/pytorch/pytorch.git/tree/main" })?.url,
    ).toBe("https://github.com/pytorch/pytorch");
    expect(extractRepositoryRef({ rawText: "no link here" })).toBeUndefined();
    // 有正式 paper 的数据集（BDD100K）：无 repository 链接，不误标 software
    expect(
      inferReferenceKind({
        ...YOLO11_REFERENCE,
        rawText: "[3] F. Yu et al., “Bdd100k: A diverse driving dataset,” CVPR, 2020.",
        title: "Bdd100k: A diverse driving dataset",
      }),
    ).toBe("scholarly_paper");
  });
});

// ---- SoftwareReferenceResolver ----

describe("SoftwareReferenceResolver（fake fetch）", () => {
  it("GitHub API 命中 → match + canonical（repository / 官方文档 / 描述作为证据）", async () => {
    const fetchImpl = (async () =>
      jsonResponse(GITHUB_API_ULTRALYTICS)) as unknown as typeof fetch;
    const resolver = new SoftwareReferenceResolver({ fetchImpl });
    const outcome = await resolver.resolve(
      { title: "Ultralytics yolo11", repository: extractRepositoryRef(YOLO11_REFERENCE)! },
      NOW,
    );
    expect(outcome.kind).toBe("match");
    if (outcome.kind === "match") {
      expect(outcome.canonical.provider).toBe("github");
      expect(outcome.canonical.recordId).toBe("ultralytics/ultralytics");
      expect(outcome.canonical.software?.repositoryUrl).toBe("https://github.com/ultralytics/ultralytics");
      expect(outcome.canonical.software?.homepage).toBe("https://docs.ultralytics.com");
      expect(outcome.canonical.abstract).toContain("YOLO11");
    }
  });

  it("API 限流（403）→ 降级仓库页面核验（og:title 元数据）仍 match", async () => {
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes("api.github.com")
        ? jsonResponse({ message: "rate limit exceeded" }, 403)
        : htmlResponse(GITHUB_PAGE_HTML)) as unknown as typeof fetch;
    const resolver = new SoftwareReferenceResolver({ fetchImpl });
    const outcome = await resolver.resolve(
      { title: "Ultralytics yolo11", repository: extractRepositoryRef(YOLO11_REFERENCE)! },
      NOW,
    );
    expect(outcome.kind).toBe("match");
    expect(resolver.telemetry.htmlCalls).toBe(1);
  });

  it("仓库 404（API 与页面一致）→ 权威 not_found", async () => {
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes("api.github.com")
        ? jsonResponse({ message: "Not Found" }, 404)
        : htmlResponse("Not Found", 404)) as unknown as typeof fetch;
    const outcome = await new SoftwareReferenceResolver({ fetchImpl }).resolve(
      { title: "Some Software", repository: extractRepositoryRef({ rawText: "https://github.com/a/b" })! },
      NOW,
    );
    expect(outcome.kind).toBe("not_found");
  });

  it("查询失败（网络异常）→ error（PROVIDER_ERROR 语义，绝不折叠成 not_found）", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const outcome = await new SoftwareReferenceResolver({ fetchImpl }).resolve(
      { title: "Ultralytics yolo11", repository: extractRepositoryRef(YOLO11_REFERENCE)! },
      NOW,
    );
    expect(outcome.kind).toBe("error");
  });

  it("仓库存在但标题对不上 → mismatch(title)（链接可能抄错，不是 NOT_FOUND）", async () => {
    const fetchImpl = (async () => jsonResponse(GITHUB_API_ULTRALYTICS)) as unknown as typeof fetch;
    const outcome = await new SoftwareReferenceResolver({ fetchImpl }).resolve(
      { title: "PyTorch: An imperative deep learning framework", repository: extractRepositoryRef(YOLO11_REFERENCE)! },
      NOW,
    );
    expect(outcome.kind).toBe("mismatch");
    if (outcome.kind === "mismatch") {
      expect(outcome.mismatches[0]?.field).toBe("title");
    }
  });

  it("软件核验版本纳入常量（算法升级 → 旧记录失效）", () => {
    expect(SOFTWARE_VERIFICATION_VERSION).toBeGreaterThan(0);
    expect(METADATA_VERIFICATION_VERSION).toMatch(/^v3\./);
  });
});

// ---- 端到端：CitationIntegrityService（YOLO11 真实场景回归） ----

/** 学术库全部 not_found（YOLO11 没有正式 paper——这是事实，不是不存在） */
class AllNotFoundScholarly {
  readonly name = "crossref" as const;
  async lookup(): Promise<{ kind: "not_found" }> {
    return { kind: "not_found" };
  }
}

class FakeJudgeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: string[] = [];
  async healthCheck(): Promise<RuntimeHealth> {
    return { ok: true, provider: "pi", status: "healthy", detail: "fake", latencyMs: 1, checkedAt: NOW };
  }
  async runAgent(input: { agentId: string; contextScope?: string; task: string }): Promise<AgentTask> {
    this.calls.push(input.contextScope ?? "");
    return {
      taskId: `fake-${this.calls.length}`,
      agentId: input.agentId,
      status: "completed",
      createdAt: NOW,
      updatedAt: NOW,
      // judge 依据 repository 描述仍无法判定 claim → INSUFFICIENT_EVIDENCE（ABSTRACT_ONLY）
      output: JSON.stringify({ verdict: "INSUFFICIENT_EVIDENCE", reason: "仓库描述不足以支持该论断" }),
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

function yolo11Document(projectId: string): PaperDocument {
  return {
    schemaVersion: 1,
    projectId,
    documentId: "paper-1",
    originalFileName: "paper.pdf",
    bytes: 1,
    sha256: "c".repeat(64),
    parse: { parserId: "test", parsedAt: NOW, durationMs: 1, pageCount: 1, extractionQuality: "good" },
    pages: [{ pageId: "P001", pageNumber: 1, text: "", charCount: 0 }],
    sections: [
      { sectionId: "SEC01", title: "Experiments", level: 1, pageStart: 1, pageEnd: 1, charCount: 0, source: "toc" },
      { sectionId: "SEC36", title: "References", level: 1, pageStart: 1, pageEnd: 1, charCount: 0, source: "toc" },
    ],
    chunks: [
      {
        chunkId: "C0001",
        sequence: 1,
        pageStart: 1,
        pageEnd: 1,
        sectionId: "SEC01",
        text: "We compare against YOLO11 [2] as the baseline detector.",
        charCount: 60,
      },
    ],
    referencesSectionId: "SEC36",
    ingestedAt: NOW,
  };
}

describe("端到端：YOLO11 software 核验（学术库 not_found + GitHub 权威源）", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let projectId: string;
  let service: CitationIntegrityService;
  let runtime: FakeJudgeRuntime;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-software-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    const project = await projects.create("YOLO11 软件核验回归");
    projectId = project.id;

    const document = yolo11Document(projectId);
    await store.saveIngest(projectId, document);

    const callout: CitationCallout = {
      citationId: "CT001",
      style: "numeric",
      references: [{ referenceId: "R002", label: "2", status: "resolved" }],
      page: 1,
      sectionId: "SEC01",
      chunkId: "C0001",
      sentence: "We compare against YOLO11 [2] as the baseline detector.",
    };
    await store.saveExtraction(projectId, { references: [YOLO11_REFERENCE], callouts: [callout] });

    runtime = new FakeJudgeRuntime();
    service = new CitationIntegrityService({
      projects,
      store,
      runtime,
      citationAgentId: "citation",
      // 学术库对 YOLO11 一致未收录（真实行为）
      scholarly: { providers: [new AllNotFoundScholarly() as never] },
      // GitHub API 命中（真实 ultralytics 仓库快照）
      software: {
        fetchImpl: (async (url: string | URL | Request) =>
          String(url).includes("api.github.com")
            ? jsonResponse(GITHUB_API_ULTRALYTICS)
            : htmlResponse(GITHUB_PAGE_HTML)) as unknown as typeof fetch,
      },
      now: () => new Date(NOW),
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("核心回归：学术库未收录 ≠ 未找到——YOLO11 经官方仓库核验为 VERIFIED / kind=software", async () => {
    const result = await service.verifyMetadata(projectId);
    expect(result.byStatus.VERIFIED).toBe(1);
    expect(result.byStatus.NOT_FOUND).toBe(0);
    const record = result.records[0]!;
    expect(record.kind).toBe("software");
    expect(record.canonical?.provider).toBe("github");
    expect(record.canonical?.software?.repositoryUrl).toBe("https://github.com/ultralytics/ultralytics");
    expect(record.canonical?.software?.homepage).toBe("https://docs.ultralytics.com");
    expect(record.attempts.map((a) => a.provider)).toEqual(["github"]);
    // 软件核验画像计入 telemetry
    expect(result.profile.software.apiCalls).toBe(1);
  });

  it("旧 NOT_FOUND 记录（v2 算法）自动失效重核验，无需用户删 workspace", async () => {
    await store.saveRecord(projectId, "metadata", "R002", {
      referenceId: "R002",
      status: "NOT_FOUND",
      probableFabrication: false,
      attempts: [{ provider: "crossref", outcome: "not_found" }],
      checkedAt: NOW,
      fingerprint: YOLO11_REFERENCE.fingerprint,
      algorithmVersion: "v2.n2", // 修复前的版本
    });
    const result = await service.verifyMetadata(projectId);
    expect(result.reused).toBe(0);
    expect(result.records[0]!.status).toBe("VERIFIED");
    expect(result.records[0]!.algorithmVersion).toBe(METADATA_VERIFICATION_VERSION);
  });

  it("语义核验：software 证据等级 = repository；judge 无法判定 → INSUFFICIENT_EVIDENCE + ABSTRACT_ONLY", async () => {
    const result = await service.verifyClaims(projectId);
    expect(result.telemetry.modelCalls).toBe(1);
    const claim = result.records[0]!;
    expect(claim.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(claim.reasonCode).toBe("ABSTRACT_ONLY");
    expect(claim.evidence[0]?.evidenceLevel).toBe("repository");
    expect(claim.evidence[0]?.source).toBe("github:ultralytics/ultralytics");
  });

  it("PROVIDER_ERROR 元数据 → 语义核验 SKIPPED + REFERENCE_UNVERIFIED（不允许验证未核验文献）", async () => {
    const errorFetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const offline = new CitationIntegrityService({
      projects,
      store,
      runtime,
      citationAgentId: "citation",
      scholarly: { providers: [new AllNotFoundScholarly() as never] },
      software: { fetchImpl: errorFetch },
      now: () => new Date(NOW),
    });
    const result = await offline.verifyMetadata(projectId, { force: true });
    expect(result.byStatus.PROVIDER_ERROR).toBe(1);
    expect(result.byStatus.NOT_FOUND).toBe(0); // 查询失败绝不折叠成未找到

    // PROVIDER_ERROR 前置 → 语义核验跳过（零模型调用）
    const claims = await offline.verifyClaims(projectId);
    const claim = claims.records.find((r) => r.status === "skipped");
    expect(claim?.verdict).toBe("SKIPPED");
    expect(claim?.reasonCode).toBe("REFERENCE_UNVERIFIED");
    expect(claims.telemetry.modelCalls).toBe(0); // provider error 不烧模型

    // PROVIDER_ERROR 不被复用：网络恢复后自动重试拿到结论
    const retry = await service.verifyMetadata(projectId);
    expect(retry.records[0]!.status).toBe("VERIFIED");
  });

  it("模型预算只约束 judge 调用：无证据短路不占额度", async () => {
    // 构造 3 条 claim：全部无摘要可判（VERIFIED 但 canonical 无 abstract）
    const noAbstractService = new CitationIntegrityService({
      projects,
      store,
      runtime,
      citationAgentId: "citation",
      scholarly: { providers: [] },
      software: {
        fetchImpl: (async () =>
          jsonResponse({
            ...GITHUB_API_ULTRALYTICS,
            description: null, // 仓库无描述 → 无可判证据
          })) as unknown as typeof fetch,
      },
      now: () => new Date(NOW),
    });
    const callouts: CitationCallout[] = [1, 2, 3].map((n) => ({
      citationId: `CT00${n}`,
      style: "numeric" as const,
      references: [{ referenceId: "R002", label: "2", status: "resolved" as const }],
      page: 1,
      sectionId: "SEC01",
      chunkId: "C0001",
      sentence: `Claim number ${n} about YOLO11 [2].`,
    }));
    await store.saveExtraction(projectId, { references: [YOLO11_REFERENCE], callouts });
    await noAbstractService.verifyMetadata(projectId, { force: true });
    // limit=1：若无证据短路也占额度，3 条会留 2 条 pending
    const result = await noAbstractService.verifyClaims(projectId, { limit: 1 });
    expect(result.records.every((r) => r.status === "verified")).toBe(true);
    expect(result.telemetry.modelCalls).toBe(0);
    expect(result.telemetry.skippedNoEvidence).toBe(3);
    const noEvidence = result.records[0]!;
    expect(noEvidence.reasonCode).toBe("NO_EVIDENCE");
    expect(noEvidence.reason).toContain("仓库"); // software 条目的无证据理由（vs 学术条的 metadata 理由）
  });
});

// ---- resolver 共享（防止软件路径意外触发学术库） ----

describe("scholarly resolver 不参与 software 条目", () => {
  it("学术库 resolver 保持原语义（unresolved → 服务层映射 PROVIDER_ERROR）", async () => {
    const resolver = new ScholarlyResolver({ providers: [] });
    const verdict = await resolver.resolve({ title: "Anything" });
    expect(verdict.outcome).toBe("unresolved");
  });
});
