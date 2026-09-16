/**
 * SourceIdentity 归一化与分层键测试（M6.2）：
 * DOI / arXiv / URL / PMID 归一化、身份键分层、同身份判定、
 * preprint vs 正式版不互相合并。
 */

import { describe, expect, it } from "vitest";

import {
  buildIdentity,
  canonicalUrl,
  firstAuthorFamily,
  identityFromMetadata,
  identityKey,
  normalizeArxivId,
  normalizeDoi,
  normalizePmid,
  sameIdentity,
} from "../../src/sources/identity.js";

describe("normalizeDoi", () => {
  it("三种输入形态归一为同一小写裸 DOI", () => {
    expect(normalizeDoi("https://doi.org/10.1234/abc.def")).toBe("10.1234/abc.def");
    expect(normalizeDoi("http://dx.doi.org/10.1234/ABC.DEF")).toBe("10.1234/abc.def");
    expect(normalizeDoi("doi:10.1234/abc.def")).toBe("10.1234/abc.def");
    expect(normalizeDoi("  10.1234/abc.def ")).toBe("10.1234/abc.def");
  });

  it("剥离复制粘贴拖带的句末标点 / 括号", () => {
    expect(normalizeDoi("10.1234/abc.def.")).toBe("10.1234/abc.def");
    expect(normalizeDoi("(doi:10.1234/abc.def)")).toBe("10.1234/abc.def");
    expect(normalizeDoi("10.1234/abc.def,")).toBe("10.1234/abc.def");
  });

  it("malformed DOI 返回 undefined（不猜测修复）", () => {
    expect(normalizeDoi("not-a-doi")).toBeUndefined();
    expect(normalizeDoi("10.12/abc")).toBeUndefined(); // registry 位数不足
    expect(normalizeDoi("https://example.com/10.1234/abc")).toBeUndefined();
    expect(normalizeDoi("")).toBeUndefined();
    expect(normalizeDoi("10.1234/ with space")).toBeUndefined();
  });
});

describe("normalizeArxivId", () => {
  it("URL / 前缀 / 版本号形态归一为同一 ID", () => {
    expect(normalizeArxivId("2401.12345")).toBe("2401.12345");
    expect(normalizeArxivId("arXiv:2401.12345v2")).toBe("2401.12345");
    expect(normalizeArxivId("https://arxiv.org/abs/2401.12345v2")).toBe("2401.12345");
    expect(normalizeArxivId("https://arxiv.org/pdf/2401.12345")).toBe("2401.12345");
  });

  it("老式分类编号支持", () => {
    expect(normalizeArxivId("cs/0501034")).toBe("cs/0501034");
    expect(normalizeArxivId("arXiv:math.GT/0309136")).toBe("math.gt/0309136");
  });

  it("非法输入返回 undefined", () => {
    expect(normalizeArxivId("not-arxiv")).toBeUndefined();
    expect(normalizeArxivId("2401.123.45")).toBeUndefined();
    expect(normalizeArxivId("")).toBeUndefined();
  });
});

describe("canonicalUrl", () => {
  it("追踪参数剥离、参数排序、尾部斜杠折叠", () => {
    expect(canonicalUrl("https://Example.com/paper/?utm_source=x&id=2&id=1")).toBe(
      "https://example.com/paper?id=1&id=2",
    );
    expect(canonicalUrl("http://example.com/a/#section")).toBe("http://example.com/a");
    expect(canonicalUrl("https://example.com")).toBe("https://example.com/");
  });

  it("非 http(s) 与非法 URL 拒绝", () => {
    expect(canonicalUrl("ftp://example.com/x")).toBeUndefined();
    expect(canonicalUrl("not a url")).toBeUndefined();
    expect(canonicalUrl("")).toBeUndefined();
  });

  it("仅追踪参数差异与大小写 host 不产生不同身份键", () => {
    const a = buildIdentity({ url: "https://arxiv.org/abs/2401.12345?utm_campaign=push" });
    const b = buildIdentity({ url: "https://ARXIV.org/abs/2401.12345/" });
    expect(identityKey(a!)).toBe(identityKey(b!));
  });
});

describe("firstAuthorFamily", () => {
  it("given-family 与 family-given 两种写法归一", () => {
    expect(firstAuthorFamily(["Jiahong Xu"])).toBe("xu");
    expect(firstAuthorFamily(["Xu, Jiahong"])).toBe("xu");
    expect(firstAuthorFamily(["徐佳宏"])).toBe("徐佳宏");
    expect(firstAuthorFamily([])).toBeUndefined();
    expect(firstAuthorFamily(undefined)).toBeUndefined();
  });
});

describe("identityKey 分层", () => {
  it("DOI > arXiv > PMID > 标题指纹+年份+一作 > URL", () => {
    const doiFirst = buildIdentity({ doi: "10.1234/x", arxivId: "2401.00001", title: "T", authors: ["A B"], year: 2024 });
    expect(identityKey(doiFirst!)).toBe("doi:10.1234/x");
    const arxivSecond = buildIdentity({ arxivId: "2401.00001", pmid: "123", title: "T", authors: ["A B"], year: 2024 });
    expect(identityKey(arxivSecond!)).toBe("arxiv:2401.00001");
    const pmidThird = buildIdentity({ pmid: "123", title: "T", authors: ["A B"], year: 2024 });
    expect(identityKey(pmidThird!)).toBe("pmid:123");
    const tfFourth = buildIdentity({ title: "Attention Is All You Need", authors: ["A B"], year: 2017 });
    expect(identityKey(tfFourth!)).toBe("tf:attentionisallyouneed|2017|b");
    const urlFifth = buildIdentity({ url: "https://example.com/x" });
    expect(identityKey(urlFifth!)).toBe("url:https://example.com/x");
  });

  it("仅标题（缺年份或一作）不构成身份键——不凭标题相似合并", () => {
    expect(identityKey(buildIdentity({ title: "Some Paper" })!)).toBeUndefined();
    expect(identityKey(buildIdentity({ title: "Some Paper", year: 2024 })!)).toBeUndefined();
    expect(identityKey(buildIdentity({ title: "Some Paper", authors: ["A B"] })!)).toBeUndefined();
  });

  it("无任何身份字段 → buildIdentity 返回 null", () => {
    expect(buildIdentity({})).toBeNull();
    expect(buildIdentity({ doi: "garbage" })).toBeNull();
  });
});

describe("sameIdentity", () => {
  it("同 DOI 不同写法 → 同一身份", () => {
    const a = buildIdentity({ doi: "https://doi.org/10.1234/abc" });
    const b = buildIdentity({ doi: "doi:10.1234/ABC" });
    expect(sameIdentity(a!, b!)).toBe(true);
  });

  it("arXiv preprint 与 DOI 正式版是不同身份（不互相覆盖）", () => {
    const preprint = buildIdentity({
      arxivId: "2401.12345",
      title: "Great Method",
      authors: ["Alice Smith"],
      year: 2024,
    });
    const published = buildIdentity({
      doi: "10.9999/great-method",
      title: "Great Method",
      authors: ["Alice Smith"],
      year: 2025,
    });
    expect(sameIdentity(preprint!, published!)).toBe(false);
    expect(identityKey(preprint!)).not.toBe(identityKey(published!));
  });

  it("标题+年份+一作完全一致且无强键 → 同身份（tier-4）", () => {
    const a = buildIdentity({ title: "Deep SORT", authors: ["Nico Wenhardt"], year: 2016 });
    const b = buildIdentity({ title: "Deep-SORT", authors: ["Wenhardt, Nico"], year: 2016 });
    expect(sameIdentity(a!, b!)).toBe(true);
  });
});

describe("identityFromMetadata（老数据 lazy 推导）", () => {
  it("从 M5 形状的 metadata 推导出归一身份", () => {
    const identity = identityFromMetadata({
      doi: "https://doi.org/10.9999/old",
      title: "Old Paper",
      authors: ["John Doe"],
      year: 2020,
    });
    expect(identity?.doi).toBe("10.9999/old");
    expect(identityKey(identity!)).toBe("doi:10.9999/old");
  });

  it("无 DOI 时落到标题指纹键", () => {
    const identity = identityFromMetadata({ title: "Paper X", authors: ["Jane Roe"], year: 2021 });
    expect(identity?.doi).toBeUndefined();
    expect(identityKey(identity!)).toBe("tf:paperx|2021|roe");
  });
});

describe("normalizePmid", () => {
  it("纯数字通过，其余拒绝", () => {
    expect(normalizePmid("12345678")).toBe("12345678");
    expect(normalizePmid("PMID:12345")).toBeUndefined();
    expect(normalizePmid("abc")).toBeUndefined();
  });
});
