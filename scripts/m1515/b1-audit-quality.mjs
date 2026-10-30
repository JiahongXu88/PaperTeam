#!/usr/bin/env node
/**
 * M15.15 B1 — after 提取质量审计：对照「DOI/URL 终止符计数」代理金标准定位分歧。
 * 输出每样本：extractor 条数、DOI 终止符数、无 DOI 条目、疑似碎片（<60 字符）条目。
 */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const PARSE_SCRIPT = resolve("D:\\Projects\\PaperTeam\\backend\\tools\\parse_paper_pdf.py");
const SAMPLES = "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples";
const after = JSON.parse(
  await readFile("D:\\PaperTeamData\\M15\\M15_15\\phase-b\\after\\extraction.json", "utf8"),
);

for (const result of after.results) {
  if (result.sample === "b1-original") continue;
  const { stdout } = await execFileAsync("python", [PARSE_SCRIPT, join(SAMPLES, `${result.sample}.pdf`)], {
    timeout: 120_000, maxBuffer: 256 * 1024 * 1024, encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf8", PYTHONDONTWRITEBYTECODE: "1" },
  });
  const raw = JSON.parse(stdout.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "{}");
  const blocks = raw.blocks ?? [];
  let ti = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].text.includes("参考文献")) { ti = i; break; }
  }
  const refText = blocks.slice(ti + 1).map((b) => b.text).join("\n");
  const doiTerminators = (refText.match(/DOI[：:][^］\]]*[］\]]/g) ?? []).length;
  const urlTerminators = (refText.match(/https?:\/\//gi) ?? []).length;
  const noDoi = result.references.filter((r) => r.doi === null);
  const short = result.references.filter((r) => r.rawText.length < 60);
  const withDoi = result.references.filter((r) => r.doi !== null).length;
  console.log(`${result.sample}: extracted=${result.referenceCount} doi=${withDoi} noDoi=${noDoi.length} short(<60ch)=${short.length} | proxy: DOI-terms=${doiTerminators} urls=${urlTerminators}`);
  if (noDoi.length > 0 && noDoi.length <= 12) {
    for (const r of noDoi.slice(0, 12)) console.log(`   noDoi: ${r.rawText.slice(0, 110)}`);
  }
}
