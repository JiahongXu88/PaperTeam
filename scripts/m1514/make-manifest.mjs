#!/usr/bin/env node
/**
 * M15.14 — 数据目录 MANIFEST.json 生成（全文件 SHA256 + 许可/可公开性登记）。
 * 零模型。用法：node scripts/m1514/make-manifest.mjs
 */
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");

/** 可公开性规则： manuscripts/（作者版权 PDF）、sequester/（评审原文 CC BY 4.0 但
 * 仅内部）不进公开仓库；其余（协议/清单/聚合指标/守卫审计）可公开。 */
function publishability(relPath) {
  const p = relPath.replaceAll("\\", "/");
  if (p.startsWith("manuscripts/")) return { publishable: false, reason: "author-copyright PDF (internal analysis only)" };
  if (p.startsWith("sequester/")) return { publishable: false, reason: "PeerRead review text (internal analysis only)" };
  if (p.startsWith("phase-c/pools/cache/")) return { publishable: true, reason: "OpenAlex API cache (public metadata)" };
  return { publishable: true, reason: "protocol/manifest/metrics (no copyrighted content)" };
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const files = await walk(ROOT);
const records = [];
for (const full of files.sort()) {
  const rel = relative(ROOT, full);
  if (rel === "MANIFEST.json") continue;
  const content = await readFile(full);
  const info = await stat(full);
  const pub = publishability(rel);
  records.push({
    path: rel,
    bytes: info.size,
    sha256: createHash("sha256").update(content).digest("hex"),
    publishable: pub.publishable,
    note: pub.reason,
  });
}
const manifest = {
  generatedAt: new Date().toISOString(),
  milestone: "M15.14",
  dataRoot: ROOT,
  codeBaseline: "d04d39a14f2610966a99a35da4063f99e50c8cbf",
  fileCount: records.length,
  files: records,
};
await writeFile(join(ROOT, "MANIFEST.json"), JSON.stringify(manifest, null, 1), "utf8");
const nonPub = records.filter((r) => !r.publishable).length;
console.log(JSON.stringify({ files: records.length, nonPublishable: nonPub, output: join(ROOT, "MANIFEST.json") }, null, 1));
