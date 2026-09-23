/**
 * M9.7.4 P0-3 Academic Metadata Identity Hardening 测试。
 *
 * 回归 fixture（M9.7.3 真实案例，全离线 mock，不依赖线上 OpenAlex）：
 *   query DOI = 10.48550/arxiv.2210.03629（期望论文 ReAct）
 *   OpenAlex 返回 outcome=match 但 title 是错误论文
 *   （"Distributing Accountability, Not Capability: Phase Separation…"）
 *
 * 覆盖（任务书 §8-10~13）：
 * 10. wrong DOI result rejected（arXiv 权威交叉验证 → mismatch）
 * 11. wrong arXiv identity rejected（query DOI 与 candidate arXiv ID 不一致 → mismatch）
 * 12. correct identity accepted（权威 title 与 provider title 一致 → match）
 * 13. provider not_found → 优雅降级（not_found / unresolved，绝不误判 match）
 */

import { describe, expect, it } from "vitest";

import {
  ArxivLookupProvider,
  OpenAlexProvider,
  ScholarlyResolver,
  arxivIdFromDoi,
} from "../../src/citation/scholarly.js";
import { compareFields } from "../../src/citation/candidateScoring.js";
import type { CanonicalPaperRecord } from "../../src/citation/integrity.js";

const REACT_DOI = "10.48550/arxiv.2210.03629";
const REACT_TITLE = "ReAct: Synergizing Reasoning and Acting in Language Models";
const WRONG_TITLE =
  "Distributing Accountability, Not Capability: Phase Separation in Distributed Machine Learning";

/** minimal fake fetch：按 URL 前缀分发固定响应 */
function fakeFetch(routes: Array<{ match: (url: string) => boolean; status: number; body: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    for (const route of routes) {
      if (route.match(url)) {
        return new Response(route.body, {
          status: route.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const openalexWrongPaper = (doi: string, title: string) =>
  JSON.stringify({
    id: "https://openalex.org/W999",
    title,
    publication_year: 2022,
    doi: `https://doi.org/${doi}`,
    authorships: [{ author: { display_name: "Someone Else" } }],
  });

const arxivAtom = (arxivId: string, title: string, authors: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/${arxivId}v3</id>
    <title>${title}</title>
    <summary>${authors.join(", ")} propose a method.</summary>
  </entry>
</feed>`;

function recordOf(partial: Partial<CanonicalPaperRecord>): CanonicalPaperRecord {
  return {
    provider: "openalex",
    recordId: "W999",
    retrievedAt: "2026-09-23T00:00:00Z",
    title: partial.title,
    ...(partial.authors !== undefined ? { authors: partial.authors } : {}),
    ...(partial.year !== undefined ? { year: partial.year } : {}),
    ...(partial.doi !== undefined ? { doi: partial.doi } : {}),
    ...(partial.arxivId !== undefined ? { arxivId: partial.arxivId } : {}),
  } as CanonicalPaperRecord;
}

describe("arxivIdFromDoi", () => {
  it("arXiv DOI → arXiv ID（新式 / 老式编号 / 前缀形态）", () => {
    expect(arxivIdFromDoi("10.48550/arxiv.2210.03629")).toBe("2210.03629");
    expect(arxivIdFromDoi("10.48550/arxiv.cs/0501034")).toBe("cs/0501034");
  });

  it("非 arXiv DOI / 非法值 → undefined", () => {
    expect(arxivIdFromDoi("10.1109/icra.2023.10160")).toBeUndefined();
    expect(arxivIdFromDoi("10.48550/arxiv.not-an-id!!")).toBeUndefined();
    expect(arxivIdFromDoi("")).toBeUndefined();
  });
});

describe("compareFields：arXiv DOI ↔ arXiv ID 身份交叉校验", () => {
  it("query DOI 是 arXiv DOI 而 candidate 声称不同 arXiv ID → mismatch（arxivId 字段）", () => {
    const mismatches = compareFields(
      { doi: REACT_DOI, title: REACT_TITLE },
      recordOf({ title: REACT_TITLE, doi: REACT_DOI, arxivId: "2303.11366" }),
    );
    expect(mismatches.some((m) => m.field === "arxivId")).toBe(true);
  });

  it("candidate arXiv ID 与 DOI 推导一致（含版本号形态）→ 无 arxivId mismatch", () => {
    const mismatches = compareFields(
      { doi: REACT_DOI, title: REACT_TITLE },
      recordOf({ title: REACT_TITLE, doi: REACT_DOI, arxivId: "2210.03629" }),
    );
    expect(mismatches.some((m) => m.field === "arxivId")).toBe(false);
  });
});

describe("ScholarlyResolver：DOI-only query 的 arXiv 权威交叉验证", () => {
  /** providers = [openalex, arxiv]（跳过 crossref/S2，聚焦 M9.7.3 场景） */
  function resolverOf(fetchImpl: typeof fetch): ScholarlyResolver {
    return new ScholarlyResolver({
      providers: [new OpenAlexProvider(), new ArxivLookupProvider()],
      fetchImpl,
      politenessDelayMs: 0,
    });
  }

  it("10. M9.7.3 真实案例：OpenAlex 错配论文 + arXiv 权威源 → 不得 match（mismatch）", async () => {
    const resolver = resolverOf(
      fakeFetch([
        {
          match: (url) => url.includes("api.openalex.org/works/https://doi.org/"),
          status: 200,
          body: openalexWrongPaper(REACT_DOI, WRONG_TITLE),
        },
        {
          match: (url) => url.includes("export.arxiv.org/api/query"),
          status: 200,
          body: arxivAtom("2210.03629", REACT_TITLE, ["Yao, Shunyu", "Zhao, Jeffrey"]),
        },
      ]),
    );
    const verdict = await resolver.resolve({ doi: REACT_DOI });
    // 修复前：DOI-only query → tier=doi 回显即采信 → match + 错误 title 进库
    expect(verdict.outcome).not.toBe("match");
    expect(verdict.outcome).toBe("mismatch");
    expect(verdict.mismatches?.some((m) => m.field === "title")).toBe(true);
    const authorityAttempt = verdict.attempts.find((a) => a.provider === "arxiv-authority");
    expect(authorityAttempt?.outcome).toBe("mismatch");
  });

  it("12. 正确身份：provider title 与 arXiv 权威 title 一致 → match", async () => {
    const resolver = resolverOf(
      fakeFetch([
        {
          match: (url) => url.includes("api.openalex.org/works/https://doi.org/"),
          status: 200,
          body: openalexWrongPaper(REACT_DOI, REACT_TITLE),
        },
        {
          match: (url) => url.includes("export.arxiv.org/api/query"),
          status: 200,
          body: arxivAtom("2210.03629", REACT_TITLE, ["Yao, Shunyu"]),
        },
      ]),
    );
    const verdict = await resolver.resolve({ doi: REACT_DOI });
    expect(verdict.outcome).toBe("match");
    expect(verdict.canonical?.title).toBe(REACT_TITLE);
  });

  it("13a. arXiv 权威源不可用（error）→ unresolved（保守降级，不给 wrong match）", async () => {
    const resolver = resolverOf(
      fakeFetch([
        {
          match: (url) => url.includes("api.openalex.org/works/https://doi.org/"),
          status: 200,
          body: openalexWrongPaper(REACT_DOI, WRONG_TITLE),
        },
        // arXiv 网络失败（500）
        {
          match: (url) => url.includes("export.arxiv.org/api/query"),
          status: 500,
          body: "server error",
        },
      ]),
    );
    const verdict = await resolver.resolve({ doi: REACT_DOI });
    expect(verdict.outcome).not.toBe("match");
    expect(verdict.outcome).toBe("unresolved");
  });

  it("13b. arXiv 权威源查无此 ID → unresolved", async () => {
    const resolver = resolverOf(
      fakeFetch([
        {
          match: (url) => url.includes("api.openalex.org/works/https://doi.org/"),
          status: 200,
          body: openalexWrongPaper(REACT_DOI, WRONG_TITLE),
        },
        {
          match: (url) => url.includes("export.arxiv.org/api/query"),
          status: 200,
          body: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
        },
      ]),
    );
    const verdict = await resolver.resolve({ doi: REACT_DOI });
    expect(verdict.outcome).toBe("unresolved");
  });

  it("13c. provider 全部无法确认（404 / 空结果）→ unresolved 优雅降级（不误判存在）", async () => {
    const resolver = resolverOf(
      fakeFetch([
        {
          match: (url) => url.includes("api.openalex.org"),
          status: 404,
          body: "not found",
        },
        {
          match: (url) => url.includes("export.arxiv.org"),
          status: 200,
          body: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
        },
      ]),
    );
    const verdict = await resolver.resolve({ doi: "10.48550/arxiv.2401.99999" });
    // openalex 404（DOI-only plan 无标题可退 → error）+ arXiv 空结果（not_found）：
    // 不足两源权威 not_found → unresolved（D-0023：NOT_FOUND ≠ 检索失败）
    expect(verdict.outcome).toBe("unresolved");
    expect(verdict.outcome).not.toBe("match");
  });

  it("非 arXiv 的普通 DOI-only query 不触发交叉验证（保持既有行为）", async () => {
    const resolver = resolverOf(
      fakeFetch([
        {
          match: (url) => url.includes("api.openalex.org/works/https://doi.org/"),
          status: 200,
          body: openalexWrongPaper("10.1109/icra.2023.10160", "A Normal Conference Paper"),
        },
      ]),
    );
    const verdict = await resolver.resolve({ doi: "10.1109/icra.2023.10160" });
    expect(verdict.outcome).toBe("match"); // 普通 DOI 实体查询保持现状（如实边界）
    expect(verdict.attempts.find((a) => a.provider === "arxiv-authority")).toBeUndefined();
  });

  it("query 带 title 时仍由 compareFields 直接拦截（现有防线不回归）", async () => {
    const resolver = resolverOf(
      fakeFetch([
        {
          match: (url) => url.includes("api.openalex.org/works"),
          status: 200,
          body: openalexWrongPaper(REACT_DOI, WRONG_TITLE),
        },
      ]),
    );
    const verdict = await resolver.resolve({ doi: REACT_DOI, title: REACT_TITLE, year: 2022 });
    expect(verdict.outcome).toBe("mismatch");
    expect(verdict.mismatches?.some((m) => m.field === "title")).toBe(true);
  });
});
