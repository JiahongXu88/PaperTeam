#!/usr/bin/env node
/**
 * M15 TJA：内置期刊 profile 的官方原句回放（零模型、只读）。
 *
 * 用法：
 *   node scripts/m15-tja/replay-profile-quotes.mjs --snapshots <dir>   # 对已保存的官方页面快照回放（离线）
 *   node scripts/m15-tja/replay-profile-quotes.mjs --live               # 在线抓取官方页面回放（页面间隔 31s）
 *   [--out <file.json>]
 *
 * 快照目录中的文件名按 profile.source.pages 的 sha256 匹配（不依赖文件名）。
 * 前置：npm --prefix backend run build（使用 backend/dist 中与产品同一份验真代码）。
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";


const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = new URL("../../backend/dist/target/journal/", import.meta.url);
const { BUILTIN_JOURNAL_PROFILES } = await import(new URL("profileRegistry.js", root));
const { verifyProfileAgainstPages, fetchProfilePages } = await import(new URL("profileVerification.js", root));

const results = [];
for (const profile of BUILTIN_JOURNAL_PROFILES) {
  let pages;
  if (args.includes("--live")) {
    pages = await fetchProfilePages(profile, fetch, { delayMs: 31_000 });
  } else {
    const dir = opt("--snapshots");
    if (dir === undefined) throw new Error("需要 --snapshots <dir> 或 --live");
    const bySha = new Map();
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".html")) continue;
      const html = await readFile(join(dir, name));
      bySha.set(createHash("sha256").update(html).digest("hex"), { name, html: html.toString("utf8") });
    }
    pages = new Map(
      profile.source.pages.map((page) => {
        const hit = bySha.get(page.sha256);
        return [page.url, hit !== undefined ? { httpStatus: 200, html: hit.html } : { httpStatus: null, html: null, error: "snapshot_missing" }];
      }),
    );
  }
  const verification = verifyProfileAgainstPages(profile, pages, new Date().toISOString());
  results.push({
    journalId: profile.journalId,
    rulesVersion: profile.rulesVersion,
    status: verification.status,
    quotesFound: verification.quotes.filter((q) => q.found === true).length,
    quotesTotal: verification.quotes.length,
    missing: verification.quotes.filter((q) => q.found !== true),
    pages: verification.pages,
  });
}
const report = { mode: args.includes("--live") ? "live" : "snapshot", checkedAt: new Date().toISOString(), results };
const out = opt("--out");
if (out !== undefined) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(results.map(({ journalId, status, quotesFound, quotesTotal, missing }) => ({ journalId, status, quotesFound, quotesTotal, missing: missing.map((m) => m.ref) })), null, 2));
