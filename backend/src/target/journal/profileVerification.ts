/**
 * Journal profile 来源验真：官方原句回放（零模型）。
 *
 * - htmlToText：去 script/style/标签、解码实体；quoteKey：NFKC + 去全部空白（中文页面空格不稳定）；
 * - 页面 HTML 整体哈希只作「是否逐字节同快照」披露，不作为规则失效依据（页面导航 / 统计脚本
 *   常变）；规则是否仍有效 = 其 officialQuote 是否仍出现在该官方页面文本中；
 * - 抓取失败 → UNREACHABLE（不把旧快照升级为在线验证）。
 */
import { createHash } from "node:crypto";

import type { JournalProfile, JournalProfileVerification, JournalProfileVerificationStatus } from "./profileTypes.js";

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–", hellip: "…", middot: "·" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

export function quoteKey(text: string): string {
  return text.normalize("NFKC").replace(/[\s​‌‍﻿]+/g, "");
}

/** profile 中全部需回放的原句（规则 / 范围 / 稿型 / 收录自述） */
export function profileQuotes(profile: JournalProfile): Array<{ ref: string; sourceUrl: string; quote: string }> {
  const quotes = [
    { ref: "scope", sourceUrl: profile.scope.sourceUrl, quote: profile.scope.officialQuote },
    ...profile.articleTypes.map((item) => ({ ref: `articleType:${item.type}`, sourceUrl: item.sourceUrl, quote: item.officialQuote })),
    ...profile.rules.map((rule) => ({ ref: `rule:${rule.id}`, sourceUrl: rule.sourceUrl, quote: rule.officialQuote })),
    ...profile.indexing
      .filter((item) => item.officialQuote !== undefined && item.sourceUrl !== undefined)
      .map((item) => ({ ref: `indexing:${item.label}`, sourceUrl: item.sourceUrl!, quote: item.officialQuote! })),
  ];
  return quotes;
}

/** 纯函数：给定已抓取页面（url → html | 失败），计算验真结果 */
export function verifyProfileAgainstPages(
  profile: JournalProfile,
  pages: ReadonlyMap<string, { httpStatus: number | null; html: string | null; error?: string }>,
  checkedAt: string,
): JournalProfileVerification {
  const texts = new Map<string, string>();
  const pageResults: JournalProfileVerification["pages"] = [];
  const urls = [...new Set([...profile.source.pages.map((page) => page.url), ...profileQuotes(profile).map((quote) => quote.sourceUrl)])];
  for (const url of urls) {
    const fetched = pages.get(url);
    const ok = fetched !== undefined && fetched.html !== null && fetched.httpStatus !== null && fetched.httpStatus >= 200 && fetched.httpStatus < 300;
    const sha256 = ok ? createHash("sha256").update(fetched!.html!).digest("hex") : null;
    const snapshot = profile.source.pages.find((page) => page.url === url)?.sha256;
    if (ok) texts.set(url, quoteKey(htmlToText(fetched!.html!)));
    pageResults.push({
      url,
      httpStatus: fetched?.httpStatus ?? null,
      sha256,
      ...(ok ? {} : { error: fetched?.error ?? (fetched === undefined ? "not_fetched" : `http_${fetched.httpStatus}`) }),
      identicalToSnapshot: sha256 === null || snapshot === undefined ? null : sha256 === snapshot,
    });
  }
  const quotes = profileQuotes(profile).map((item) => {
    const text = texts.get(item.sourceUrl);
    return { ref: item.ref, sourceUrl: item.sourceUrl, found: text === undefined ? null : text.includes(quoteKey(item.quote)) };
  });
  const status: JournalProfileVerification["status"] = quotes.some((quote) => quote.found === false)
    ? "SOURCE_CHANGED"
    : quotes.some((quote) => quote.found === null)
      ? "UNREACHABLE"
      : "VERIFIED_LIVE";
  return { schemaVersion: "journal-profile-verification/v1", journalId: profile.journalId, rulesVersion: profile.rulesVersion, checkedAt, pages: pageResults, quotes, status };
}

/** 抓取全部来源页（串行 + 间隔：遵守 PLOS robots Crawl-delay 量级；只 GET 公开页面） */
export async function fetchProfilePages(
  profile: JournalProfile,
  fetchImpl: typeof fetch,
  options: { delayMs?: number; timeoutMs?: number } = {},
): Promise<Map<string, { httpStatus: number | null; html: string | null; error?: string }>> {
  const result = new Map<string, { httpStatus: number | null; html: string | null; error?: string }>();
  const urls = [...new Set([...profile.source.pages.map((page) => page.url), ...profileQuotes(profile).map((quote) => quote.sourceUrl)])];
  for (const [index, url] of urls.entries()) {
    if (index > 0 && (options.delayMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    try {
      const response = await fetchImpl(url, {
        headers: { "user-agent": "PaperTeam journal-profile verifier (official guideline quote replay)" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        redirect: "follow",
      });
      const html = response.ok ? await response.text() : null;
      result.set(url, { httpStatus: response.status, html });
    } catch (error) {
      result.set(url, { httpStatus: null, html: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
  }
  return result;
}

/**
 * profile 当前可信状态：
 * - 最近一次在线复核（verification）优先：SOURCE_CHANGED 恒不可信；VERIFIED_LIVE 在 TTL 内可信；
 * - 无在线复核：内置快照在 TTL 内 → VERIFIED_SNAPSHOT；超 TTL → STALE；用户提供 → UNVERIFIED；
 * - 在线复核 UNREACHABLE 不降级仍在 TTL 内的快照（离线可用，但披露复核失败）。
 */
export function profileTrust(
  profile: JournalProfile,
  verification: JournalProfileVerification | null,
  now: Date,
): { status: JournalProfileVerificationStatus; verifiedAt: string | null; ageDays: number | null; trusted: boolean; note: string } {
  const ttlMs = profile.source.ttlDays * 86_400_000;
  const applicable = verification !== null && verification.rulesVersion === profile.rulesVersion ? verification : null;
  if (applicable?.status === "SOURCE_CHANGED") {
    const missing = applicable.quotes.filter((quote) => quote.found === false).map((quote) => quote.ref);
    return { status: "SOURCE_CHANGED", verifiedAt: applicable.checkedAt, ageDays: ageDays(applicable.checkedAt, now), trusted: false, note: `官方页面已不含以下原句：${missing.join("、")}——旧规则不再视为现行官方要求，需维护者重新提取` };
  }
  if (applicable?.status === "VERIFIED_LIVE") {
    const age = ageDays(applicable.checkedAt, now);
    if (now.getTime() - Date.parse(applicable.checkedAt) <= ttlMs) {
      return { status: "VERIFIED_LIVE", verifiedAt: applicable.checkedAt, ageDays: age, trusted: true, note: `${applicable.checkedAt.slice(0, 10)} 在线复核：全部官方原句仍在页面中` };
    }
    return { status: "STALE", verifiedAt: applicable.checkedAt, ageDays: age, trusted: false, note: `上次在线复核已超过 ${profile.source.ttlDays} 天，请刷新复核` };
  }
  if (profile.source.origin === "user_provided") {
    return { status: "UNVERIFIED", verifiedAt: null, ageDays: null, trusted: false, note: "用户提供的规则，尚未经官方页面原句回放复核" };
  }
  const age = ageDays(profile.source.retrievedAt, now);
  const unreachable = applicable?.status === "UNREACHABLE" ? `（${applicable.checkedAt.slice(0, 10)} 在线复核失败：官方页面不可达）` : "";
  if (now.getTime() - Date.parse(profile.source.retrievedAt) <= ttlMs) {
    return { status: "VERIFIED_SNAPSHOT", verifiedAt: profile.source.retrievedAt, ageDays: age, trusted: true, note: `使用 ${profile.source.retrievedAt.slice(0, 10)} 官方页面快照（${age} 天前；不是即时规则）${unreachable}` };
  }
  return { status: applicable?.status === "UNREACHABLE" ? "UNREACHABLE" : "STALE", verifiedAt: profile.source.retrievedAt, ageDays: age, trusted: false, note: `内置快照已超过 ${profile.source.ttlDays} 天未复核${unreachable}` };
}

function ageDays(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000));
}
