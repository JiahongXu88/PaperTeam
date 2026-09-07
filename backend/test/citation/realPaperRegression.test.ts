/**
 * 真实论文 false-negative 回归（D:\Tmp\paper.pdf 实测三条 NOT_FOUND 的复现与修复验证）。
 *
 * 输入用 PDF 提取的真实污染形态（"Byte- track" / "Rethink- ing" / "as- sociation"），
 * fake provider 模拟真实检索引擎：按 token 精确匹配（"sociation" 匹配不到 "association"），
 * 候选是学术库返回的真实 canonical 记录（含预印本版本与相邻 SORT 系列干扰项）。
 * 全部 mock，无公网。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ArxivLookupProvider,
  CrossrefProvider,
  METADATA_VERIFICATION_VERSION,
  ScholarlyResolver,
  buildQueryPlan,
  pickFromSearch,
  type LookupOutcome,
  type ProviderContext,
  type ScholarlyProvider,
  type ScholarlyQuery,
} from "../../src/citation/scholarly.js";
import type { CanonicalPaperRecord, CitationVerificationRecord, ReferenceEntry } from "../../src/citation/integrity.js";
import { CitationIntegrityService } from "../../src/citation/CitationIntegrityService.js";
import { HYPHENATION_MARKER, stripHyphenationMarkers } from "../../src/citation/referenceText.js";
import { ReferenceExtractor } from "../../src/paper/ReferenceExtractor.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import type { PaperDocument } from "../../src/paper/types.js";

const NOW = "2026-09-07T00:00:00.000Z";

// ---- 真实 canonical 记录（OpenAlex / Crossref 实查结果的静态快照，仅测试期 ground truth） ----

function rec(provider: CanonicalPaperRecord["provider"], overrides: Partial<CanonicalPaperRecord>): CanonicalPaperRecord {
  return { provider, recordId: overrides.doi ?? "x", retrievedAt: NOW, ...overrides };
}

const BYTETRACK_ECCV = rec("crossref", {
  title: "ByteTrack: Multi-object Tracking by Associating Every Detection Box",
  authors: ["Yifu Zhang", "Peize Sun", "Yi Jiang", "Dongdong Yu", "Fucheng Weng", "Zehuan Yuan", "Ping Luo", "Wenyu Liu", "Xinggang Wang"],
  year: 2022,
  venue: "Lecture Notes in Computer Science",
  doi: "10.1007/978-3-031-20047-2_1",
});
const BYTETRACK_ARXIV = rec("openalex", {
  title: "ByteTrack: Multi-Object Tracking by Associating Every Detection Box",
  authors: ["Yifu Zhang", "Peize Sun"],
  year: 2021,
  doi: "10.48550/arxiv.2110.06864",
});
const OCSORT_CVPR = rec("crossref", {
  title: "Observation-Centric SORT: Rethinking SORT for Robust Multi-Object Tracking",
  authors: ["Jinkun Cao", "Jiangmiao Pang", "Xinshuo Weng", "Rawal Khirodkar", "Kris Kitani"],
  year: 2023,
  doi: "10.1109/cvpr52729.2023.00934",
});
const OCSORT_ARXIV = rec("openalex", {
  title: "Observation-Centric SORT: Rethinking SORT for Robust Multi-Object Tracking",
  authors: ["Jinkun Cao", "Jiangmiao Pang"],
  year: 2022,
  doi: "10.48550/arxiv.2203.14360",
});
const DEEPSORT_ICIP = rec("crossref", {
  title: "Simple online and realtime tracking with a deep association metric",
  authors: ["Nicolai Wojke", "Alex Bewley", "Dietrich Paulus"],
  year: 2017,
  doi: "10.1109/icip.2017.8296962",
});
const DEEPSORT_ARXIV = rec("openalex", {
  title: "Simple Online and Realtime Tracking with a Deep Association Metric",
  authors: ["Nicolai Wojke", "Alex Bewley", "Dietrich Paulus"],
  year: 2017,
  doi: "10.48550/arxiv.1703.07402",
});
// 干扰项：同领域、共享关键词/作者的真实论文
const SORT_2016 = rec("crossref", {
  title: "Simple online and realtime tracking",
  authors: ["Alex Bewley", "Zongyuan Ge", "Lionel Ott", "Fabio Ramos", "Ben Upcroft"],
  year: 2016,
  doi: "10.1109/icip.2016.7533003",
});
const BOTSORT = rec("openalex", {
  title: "BoT-SORT: Robust Associations Multi-Pedestrian Tracking",
  authors: ["Nir Aharon", "Roy Orfaig", "Ben-Zion Bobrovsky"],
  year: 2022,
  doi: "10.48550/arxiv.2206.14651",
});
const HYBRIDSORT = rec("openalex", {
  title: "Hybrid-SORT: Weak Cues Matter for Online Multi-Object Tracking",
  authors: ["Mingzhan Yang", "Guangxin Han"],
  year: 2024,
  doi: "10.1609/aaai.v38i7.28471",
});
const BYTETRACK_SEG = rec("openalex", {
  title: "ByteTrack for Single Object Segmentation",
  authors: ["Some Author"],
  year: 2022,
  doi: "10.1000/fake.seg",
});

const INDEX = [BYTETRACK_ECCV, BYTETRACK_ARXIV, OCSORT_CVPR, OCSORT_ARXIV, DEEPSORT_ICIP, DEEPSORT_ARXIV, SORT_2016, BOTSORT, HYBRIDSORT, BYTETRACK_SEG];

// ---- fake 检索引擎：token 精确匹配（模拟 "sociation" 命中不到 "association"） ----

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4));
}

/** 查询里的长 token 全部出现在候选中才召回（真实引擎对断词碎片的召回失败就是这样） */
function searchIndex(query: ScholarlyQuery, records: CanonicalPaperRecord[]): CanonicalPaperRecord[] {
  if (query.doi !== undefined) {
    const doi = query.doi.toLowerCase();
    return records.filter((record) => record.doi === doi);
  }
  const needles = [...tokens(query.title ?? "")];
  return records
    .filter((record) => {
      const haystack = tokens(record.title ?? "");
      return needles.length > 0 && needles.every((needle) => haystack.has(needle));
    })
    .slice(0, 5);
}

class FakeSearchProvider implements ScholarlyProvider {
  readonly queries: ScholarlyQuery[] = [];
  constructor(
    readonly name: ScholarlyProvider["name"],
    private readonly records: CanonicalPaperRecord[],
    private readonly failWith?: (query: ScholarlyQuery) => LookupOutcome | undefined,
  ) {}

  async lookup(query: ScholarlyQuery): Promise<LookupOutcome> {
    this.queries.push(query);
    const forced = this.failWith?.(query);
    if (forced !== undefined) {
      return forced;
    }
    return pickFromSearch(query, searchIndex(query, this.records).map((record) => ({ ...record, provider: this.name })));
  }
}

// ---- 三条真实 ReferenceEntry（字段与 D:\Tmp\paper.pdf 提取结果一致） ----

const BYTETRACK_QUERY: ScholarlyQuery = {
  title: "Byte- track: Multi-object tracking by associating every detection box",
  authors: ["Y. Zhang", "P. Sun", "Y. Jiang", "D. Yu", "F. Weng", "Z. Yuan", "P. Luo", "W. Liu", "X. Wang"],
  year: 2022,
};
const OCSORT_QUERY: ScholarlyQuery = {
  title: "Observation-centric sort: Rethink- ing sort for robust multi-object tracking",
  authors: ["J. Cao", "J. Pang", "X. Weng", "R. Khirodkar", "K. Kitani"],
  year: 2023,
};
const DEEPSORT_QUERY: ScholarlyQuery = {
  title: "Simple online and realtime tracking with a deep as- sociation metric",
  authors: ["N. Wojke", "A. Bewley", "D. Paulus"],
  year: 2017,
};

describe("真实论文回归：PDF 断词污染标题 → 正确 canonical（三篇）", () => {
  const resolverWith = () => {
    const crossref = new FakeSearchProvider("crossref", INDEX);
    const openalex = new FakeSearchProvider("openalex", INDEX);
    return { resolver: new ScholarlyResolver({ providers: [crossref, openalex] }), crossref, openalex };
  };

  it("ByteTrack（ECCV 2022）→ match，选正式发表版而非 arXiv 预印本", async () => {
    const { resolver, crossref } = resolverWith();
    const verdict = await resolver.resolve(BYTETRACK_QUERY);
    expect(verdict.outcome).toBe("match");
    expect(verdict.canonical?.doi).toBe("10.1007/978-3-031-20047-2_1");
    expect(verdict.canonical?.year).toBe(2022);
    // 首个 variant（拼合 "Bytetrack"）就命中：只发了 1 次查询
    expect(crossref.queries).toHaveLength(1);
    expect(crossref.queries[0]?.title).toBe("Bytetrack: Multi-object tracking by associating every detection box");
    expect(verdict.attempts[0]?.note).toContain("title#1");
  });

  it("OC-SORT（CVPR 2023）→ match，年份精确的正式版优先于 2022 预印本（不判 ambiguous）", async () => {
    const { resolver } = resolverWith();
    const verdict = await resolver.resolve(OCSORT_QUERY);
    expect(verdict.outcome).toBe("match");
    expect(verdict.canonical?.doi).toBe("10.1109/cvpr52729.2023.00934");
    expect(verdict.mismatches).toBeUndefined();
  });

  it("Deep SORT（ICIP 2017）→ match；同年预印本与正式版并存时选正式 DOI", async () => {
    const { resolver } = resolverWith();
    const verdict = await resolver.resolve(DEEPSORT_QUERY);
    expect(verdict.outcome).toBe("match");
    expect(verdict.canonical?.doi).toBe("10.1109/icip.2017.8296962");
  });

  it("retrieval fallback：首个 variant 召回失败时继续下一个 variant，而不是 NOT_FOUND", async () => {
    // 引擎只认 "as-sociation" 形态（第二个 variant）：模拟原词其实是带连字符的复合词
    const weird = [rec("crossref", { ...DEEPSORT_ICIP, title: "Simple online and realtime tracking with a deep as-sociation metric" })];
    const provider = new FakeSearchProvider("crossref", weird);
    const resolver = new ScholarlyResolver({ providers: [provider] });
    const verdict = await resolver.resolve(DEEPSORT_QUERY);
    expect(verdict.outcome).toBe("match");
    expect(provider.queries.map((q) => q.title)).toEqual([
      "Simple online and realtime tracking with a deep association metric",
      "Simple online and realtime tracking with a deep as-sociation metric",
    ]);
  });

  it("年份写错（ByteTrack 写成 2019）→ mismatch(year) 而不是 NOT_FOUND，也不是 VERIFIED", async () => {
    const { resolver } = resolverWith();
    const verdict = await resolver.resolve({ ...BYTETRACK_QUERY, year: 2019 });
    expect(verdict.outcome).toBe("mismatch");
    expect(verdict.mismatches).toEqual([{ field: "year", expected: "2019", actual: "2022" }]);
    expect(verdict.canonical?.doi).toBe("10.1007/978-3-031-20047-2_1");
  });

  it("年份 ±1（写成 2021）→ match（预印本 / 正式发表年差容忍）", async () => {
    const { resolver } = resolverWith();
    const verdict = await resolver.resolve({ ...BYTETRACK_QUERY, year: 2021 });
    expect(verdict.outcome).toBe("match");
  });
});

describe("真实论文回归：假阳性防线", () => {
  it("SORT（2016，Bewley）不会被 Deep SORT 顶替；Deep SORT 也不会被 SORT 顶替", async () => {
    const onlyDeep = new FakeSearchProvider("crossref", [DEEPSORT_ICIP, BOTSORT]);
    const resolver = new ScholarlyResolver({ providers: [onlyDeep, new FakeSearchProvider("openalex", [DEEPSORT_ICIP])] });
    const verdict = await resolver.resolve({ title: "Simple online and realtime tracking", authors: ["A. Bewley", "Z. Ge"], year: 2016 });
    expect(verdict.outcome).toBe("not_found");

    const onlySort = new FakeSearchProvider("crossref", [SORT_2016]);
    const verdict2 = await new ScholarlyResolver({ providers: [onlySort, new FakeSearchProvider("openalex", [SORT_2016])] }).resolve(DEEPSORT_QUERY);
    expect(verdict2.outcome).toBe("not_found");
  });

  it("含 ByteTrack 关键词的另一篇论文不会被判为 ByteTrack", async () => {
    const provider = new FakeSearchProvider("crossref", [BYTETRACK_SEG, BOTSORT, HYBRIDSORT]);
    const resolver = new ScholarlyResolver({ providers: [provider, new FakeSearchProvider("openalex", [BYTETRACK_SEG])] });
    const verdict = await resolver.resolve(BYTETRACK_QUERY);
    expect(verdict.outcome).toBe("not_found");
    expect(verdict.canonical).toBeUndefined();
  });

  it("捏造标题即使与真实论文共享大量关键词也 not_found", async () => {
    const { outcome } = await new ScholarlyResolver({
      providers: [new FakeSearchProvider("crossref", INDEX), new FakeSearchProvider("openalex", INDEX)],
    }).resolve({ title: "Multi-object tracking by associating every detection box with a deep association metric", year: 2023 });
    expect(outcome).toBe("not_found");
  });

  it("真正不同的两篇论文都 strong 命中 → ambiguous（不猜）", () => {
    const twin = rec("crossref", { ...DEEPSORT_ICIP, authors: ["Someone Else"], doi: "10.1000/twin", year: 2017 });
    const outcome = pickFromSearch({ title: DEEPSORT_QUERY.title!, year: 2017 }, [DEEPSORT_ICIP, twin]);
    expect(outcome.kind).toBe("ambiguous");
  });
});

describe("多 provider 错误语义与 query plan", () => {
  it("429 / 503 / timeout → error（不计入 not_found）；仅 1 个 not_found → UNRESOLVED", async () => {
    const limited = new FakeSearchProvider("semantic-scholar", INDEX, () => ({ kind: "error", note: "semantic-scholar 查询失败：http-429" }));
    const down = new FakeSearchProvider("openalex", INDEX, () => ({ kind: "error", note: "openalex 查询失败：http-503" }));
    const empty = new FakeSearchProvider("crossref", []);
    const resolver = new ScholarlyResolver({ providers: [empty, down, limited] });
    const verdict = await resolver.resolve({ title: "Some Real Paper Nobody Indexed Yet", year: 2026 });
    expect(verdict.outcome).toBe("unresolved");
    expect(verdict.attempts.map((a) => a.outcome)).toEqual(["not_found", "error", "error"]);
    // error 的 provider 不再被后续 variant 加压：每个只调用 2 次（1 次 + 1 次重试）
    expect(limited.queries).toHaveLength(2);
  });

  it("error 的 provider 不会为 variants 重复加压；not_found 才试下一个 variant", async () => {
    const empty = new FakeSearchProvider("crossref", []);
    const resolver = new ScholarlyResolver({ providers: [empty] });
    await resolver.resolve(BYTETRACK_QUERY);
    expect(empty.queries).toHaveLength(3); // 3 个 variant 全部 not_found
  });

  it("DOI 抄错（404）→ 退回标题检索仍能找到真实文献并记 doi mismatch", async () => {
    const provider = new FakeSearchProvider("crossref", INDEX, (query) =>
      query.doi !== undefined ? { kind: "error", note: "crossref 查询失败：http-404" } : undefined,
    );
    const resolver = new ScholarlyResolver({ providers: [provider] });
    const verdict = await resolver.resolve({ ...DEEPSORT_QUERY, doi: "10.1109/icip.2017.0000000" });
    expect(verdict.outcome).toBe("mismatch");
    expect(verdict.mismatches?.map((m) => m.field)).toEqual(["doi"]);
    expect(verdict.canonical?.doi).toBe("10.1109/icip.2017.8296962");
    expect(verdict.attempts[0]?.note).toContain("(404)");
  });

  it("DOI 限流（429）→ 不退回标题（避免加压），该 provider 记 error", async () => {
    const provider = new FakeSearchProvider("crossref", INDEX, (query) =>
      query.doi !== undefined ? { kind: "error", note: "crossref 查询失败：http-429" } : undefined,
    );
    const resolver = new ScholarlyResolver({ providers: [provider] });
    const verdict = await resolver.resolve({ ...DEEPSORT_QUERY, doi: "10.1109/icip.2017.8296962" });
    expect(verdict.outcome).toBe("unresolved");
    expect(provider.queries.every((q) => q.doi !== undefined)).toBe(true);
  });

  it("buildQueryPlan：DOI 先行，variants 上限 3，无标题只 arXiv", () => {
    const plan = buildQueryPlan({ ...BYTETRACK_QUERY, doi: "10.1007/978-3-031-20047-2_1" });
    expect(plan.map((step) => step.kind)).toEqual(["doi", "title", "title", "title"]);
    expect(plan[1]?.query.authors).toEqual(BYTETRACK_QUERY.authors);
    expect(buildQueryPlan({ arxivId: "2110.06864" }).map((step) => step.kind)).toEqual(["arxiv"]);
    expect(buildQueryPlan({})).toEqual([]);
  });

  it("真实 CrossrefProvider：title + subtitle 拆分的记录拼回完整标题后命中", async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          message: {
            items: [
              {
                DOI: "10.1109/CVPR52729.2023.00934",
                title: ["Observation-Centric SORT"],
                subtitle: ["Rethinking SORT for Robust Multi-Object Tracking"],
                author: [{ given: "Jinkun", family: "Cao" }, { given: "Jiangmiao", family: "Pang" }],
                issued: { "date-parts": [[2023, 6]] },
              },
            ],
          },
        }),
      }) as unknown as Response) as unknown as typeof fetch;
    const ctx: ProviderContext = { fetchImpl, timeoutMs: 1000 };
    const outcome = await new CrossrefProvider().lookup({ title: OCSORT_QUERY.title!, year: 2023 }, ctx);
    expect(outcome.kind).toBe("match");
    if (outcome.kind === "match") {
      expect(outcome.record.title).toBe("Observation-Centric SORT: Rethinking SORT for Robust Multi-Object Tracking");
    }
  });

  it("真实 ArxivLookupProvider：Atom 候选按新打分裁决（污染标题命中）", async () => {
    const xml = `<feed><entry><id>http://arxiv.org/abs/2110.06864v3</id><title>ByteTrack: Multi-Object Tracking by
  Associating Every Detection Box</title><summary>We propose ByteTrack.</summary></entry></feed>`;
    const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => xml }) as unknown as Response) as unknown as typeof fetch;
    const outcome = await new ArxivLookupProvider().lookup({ title: BYTETRACK_QUERY.title!, year: 2022 }, { fetchImpl, timeoutMs: 1000 });
    expect(outcome.kind).toBe("match");
  });
});

// ---- 端到端：pymupdf 跨列 block 断词 → 提取 → 核验 → 缓存失效 ----

function realLayoutDocument(): PaperDocument {
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
    projectId: "p-real",
    documentId: "paper-1",
    originalFileName: "paper.pdf",
    bytes: 1,
    sha256: "c".repeat(64),
    parse: { parserId: "pymupdf", parsedAt: NOW, durationMs: 1, pageCount: 2, extractionQuality: "good" },
    pages: [
      { pageId: "P001", pageNumber: 1, text: "", charCount: 0 },
      { pageId: "P002", pageNumber: 2, text: "", charCount: 0 },
    ],
    sections: [
      { sectionId: "SEC01", title: "Method", level: 1, pageStart: 1, pageEnd: 1, charCount: 0, source: "toc" },
      { sectionId: "SEC02", title: "References", level: 1, pageStart: 2, pageEnd: 2, charCount: 0, source: "toc" },
    ],
    chunks: [
      chunk("C0001", 1, "SEC01", 1, "We adopt ByteTrack [5] and OC-SORT [6] as baselines, with Deep SORT [20] appearance features."),
      // 与 D:\Tmp\paper.pdf 的 chunks.jsonl 一致：断词处是 block 边界（\n\n），而非行内换行
      chunk(
        "C0002",
        2,
        "SEC02",
        2,
        [
          "[5] Y. Zhang, P. Sun, Y. Jiang, D. Yu, F. Weng, Z. Yuan,\nP. Luo, W. Liu, and X. Wang, “Byte-",
          "track: Multi-object tracking by associating every detection box,” in Proceedings of the European Conference on Computer Vision (ECCV), 2022, pp. 1–21.",
          "[6] J. Cao, J. Pang, X. Weng, R. Khirodkar, and K. Kitani, “Observation-centric sort: Rethink-",
          "ing sort for robust multi-object tracking,” in Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR), 2023, pp. 9686–9696.",
          "[20] N. Wojke, A. Bewley, and D. Paulus, “Simple online and\nrealtime tracking with a deep as-",
          "sociation metric,” in Proceedings of the IEEE International Conference on Image Processing (ICIP), 2017, pp. 3645–3649.",
        ].join("\n\n"),
      ),
    ],
    referencesSectionId: "SEC02",
    ingestedAt: NOW,
  };
}

describe("端到端：block 边界断词提取 + 核验 + 旧记录自动失效", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let projectId: string;
  let service: CitationIntegrityService;
  let crossref: FakeSearchProvider;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-real-regression-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    projectId = (await projects.create("真实论文回归")).id;
    const document = realLayoutDocument();
    document.projectId = projectId;
    await store.saveIngest(projectId, document);
    crossref = new FakeSearchProvider("crossref", INDEX);
    service = new CitationIntegrityService({
      projects,
      store,
      scholarly: { providers: [crossref, new FakeSearchProvider("openalex", INDEX)] },
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ReferenceExtractor：跨 block 断词在切单元前修复为软连字符标记，标题不再是 “Byte- track”", () => {
    const { references } = new ReferenceExtractor().extract(realLayoutDocument());
    expect(references.map((r) => r.title)).toEqual([
      `Byte${HYPHENATION_MARKER}track: Multi-object tracking by associating every detection box`,
      `Observation-centric sort: Rethink${HYPHENATION_MARKER}ing sort for robust multi-object tracking`,
      `Simple online and realtime tracking with a deep as${HYPHENATION_MARKER}sociation metric`,
    ]);
    expect(references.map((r) => stripHyphenationMarkers(r.title ?? ""))).toEqual([
      "Bytetrack: Multi-object tracking by associating every detection box",
      "Observation-centric sort: Rethinking sort for robust multi-object tracking",
      "Simple online and realtime tracking with a deep association metric",
    ]);
    expect(references[0]?.authors?.[0]).toBe("Y. Zhang");
    expect(references[0]?.year).toBe(2022);
    expect(references[2]?.venue).toContain("ICIP");
  });

  it("verifyMetadata：三篇全部 VERIFIED，canonical 为正式发表 DOI", async () => {
    await service.extract(projectId);
    const result = await service.verifyMetadata(projectId);
    expect(result.byStatus.VERIFIED).toBe(3);
    expect(result.byStatus.NOT_FOUND).toBe(0);
    expect(result.records.map((r) => r.canonical?.doi)).toEqual([
      "10.1007/978-3-031-20047-2_1",
      "10.1109/cvpr52729.2023.00934",
      "10.1109/icip.2017.8296962",
    ]);
    expect(result.records.every((r) => r.algorithmVersion === METADATA_VERIFICATION_VERSION)).toBe(true);
  });

  it("缓存失效：旧算法版本的 NOT_FOUND 记录（指纹相同）不会被复用", async () => {
    const references = await store.loadReferences<ReferenceEntry>(projectId);
    const target = references[0]!;
    const stale: CitationVerificationRecord = {
      referenceId: target.referenceId,
      status: "NOT_FOUND",
      probableFabrication: false,
      attempts: [{ provider: "crossref", outcome: "not_found" }, { provider: "openalex", outcome: "not_found" }],
      checkedAt: "2026-09-07T04:29:55.852Z",
      fingerprint: target.fingerprint, // 条目原文未变
      // 无 algorithmVersion：修复前的记录
    };
    await store.saveRecord(projectId, "metadata", target.referenceId, stale);
    const callsBefore = crossref.queries.length;
    const cacheHitsBefore = service.scholarlyResolver.telemetry.cacheHits;
    const result = await service.verifyMetadata(projectId);
    expect(result.reused).toBe(2); // 另两条（新版本）复用；过期的这条重查
    // 重查经过 resolver（进程内查询缓存命中，不再打 provider）——过期记录没有被磁盘复用
    expect(crossref.queries.length + service.scholarlyResolver.telemetry.cacheHits).toBeGreaterThan(callsBefore + cacheHitsBefore);
    const refreshed = result.records.find((r) => r.referenceId === target.referenceId)!;
    expect(refreshed.status).toBe("VERIFIED");
    expect(refreshed.algorithmVersion).toBe(METADATA_VERIFICATION_VERSION);
  });

  it("旧提取结果（extractor 版本变化）：extract 不复用，重新提取", async () => {
    const stages = await store.loadStages(projectId);
    await store.saveStage(projectId, { ...stages["references"]!, inputFingerprint: "legacy-fingerprint-without-version" });
    const { reused } = await service.extract(projectId);
    expect(reused).toBe(false);
  });

  it("UNRESOLVED（provider 瞬时失败）不被复用：下次核验自动重试并拿到结论", async () => {
    const references = await store.loadReferences<ReferenceEntry>(projectId);
    const target = references[1]!;
    const transient: CitationVerificationRecord = {
      referenceId: target.referenceId,
      status: "UNRESOLVED",
      probableFabrication: false,
      attempts: [{ provider: "crossref", outcome: "error", note: "crossref 查询失败：timeout(8000ms)" }],
      checkedAt: NOW,
      fingerprint: target.fingerprint,
      algorithmVersion: METADATA_VERIFICATION_VERSION, // 同版本、同指纹——只因 status 而重试
      error: "crossref 查询失败：timeout(8000ms)",
    };
    await store.saveRecord(projectId, "metadata", target.referenceId, transient);
    const result = await service.verifyMetadata(projectId);
    expect(result.reused).toBe(2);
    expect(result.records.find((r) => r.referenceId === target.referenceId)?.status).toBe("VERIFIED");
  });
});
