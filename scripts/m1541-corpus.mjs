#!/usr/bin/env node
/**
 * M15.4.1 语料工具（零模型）：dump（表+数值句清单）/ validate（机械校验 + materialize 编辑案例）。
 * 用法：
 *   node scripts/m1541-corpus.mjs dump <familyKey> [--sentences|--tables]
 *   node scripts/m1541-corpus.mjs validate <familyKey>
 * 数据在 D:\PaperTeamData\M15\M15_4_1\（仓库外）；本脚本入仓库（轻量可复现）。
 */
import { readFile, readdir, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = "D:\\PaperTeamData\\M15\\M15_4_1";
const dist = (...p) => `file://${join("D:\\Projects\\PaperTeam\\backend\\dist", ...p).replaceAll("\\", "/")}`;
const { parseLatexTables, plainLatexText } = await import(dist("review", "latexTable.js"));
const { locateQuote } = await import(dist("review", "claimAuditText.js"));
const { buildCertificateDocument, locateAtom } = await import(dist("review", "claimCertificate.js"));

const FAMILIES = {
  // 计划偏差（FREEZE_MANIFEST 登记）：原 F1=2608.04501 解包后发现是综述型论文（分类表+阈值句，
  // 无「本方法达到 X」类实验论断），冻结后、任何标注/模型调用前替换为同批下载的实验型论文 2609.22148。
  "F1-sleepeff": { arxiv: "2609.22148", split: "EXPOSED_DEV" },
  "F2-faultloc": { arxiv: "2608.11277", split: "EXPOSED_DEV" },
  "F3-npudenoise": { arxiv: "2605.03680", split: "EXPOSED_DEV" },
  "F4-msleep": { arxiv: "2606.13694", split: "FROZEN_HELDOUT" },
  "F5-continuir": { arxiv: "2608.23799", split: "FROZEN_HELDOUT" },
  "F6-vulndet": { arxiv: "2604.19031", split: "FROZEN_HELDOUT" },
  "F7-lqrs": { arxiv: "2510.10580", split: "FROZEN_HELDOUT" },
};

async function familyFiles(familyKey) {
  const dir = join(ROOT, "candidates", FAMILIES[familyKey].arxiv);
  const files = [];
  const walk = async (d) => {
    for (const name of await readdir(d, { withFileTypes: true })) {
      if (name.isDirectory()) await walk(join(d, name.name));
      else if (name.name.endsWith(".tex")) files.push({ abs: join(d, name.name), rel: join(d, name.name).slice(dir.length + 1).replaceAll("\\", "/") });
    }
  };
  await walk(dir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const out = [];
  for (const f of files) out.push({ path: f.rel, content: await readFile(f.abs, "utf8") });
  return { dir, files: out };
}

function docOf(files) {
  return buildCertificateDocument(files.map((f) => ({ file: f.path, content: f.content })));
}

const sha256 = (t) => createHash("sha256").update(t, "utf8").digest("hex");

async function loadCases(familyKey) {
  try {
    return JSON.parse(await readFile(join(ROOT, "corpus", `${familyKey}-cases.json`), "utf8"));
  } catch {
    return null;
  }
}

async function cmdDump(familyKey, what) {
  const { files } = await familyFiles(familyKey);
  const doc = docOf(files);
  if (what === "--tables" || what === undefined) {
    for (const file of doc.files) {
      for (const table of file.tables) {
        console.log(`\n=== ${file.file} table#${table.tableIndex} id=${table.tableId} caption=${table.caption ?? ""} label=${table.label ?? ""} issues=${table.parseIssues.join(",") || "none"}`);
        for (const row of table.rows) {
          const cells = row.cells.map((c) => (c.isHeader ? `[H]${c.text}` : c.value !== null ? `${c.value.raw}` : c.rowKey.length > 0 ? `[K]${c.text}` : c.text)).join(" | ");
          console.log(`  R${row.index + 1}(${row.kind}): ${cells}`);
        }
      }
    }
  }
  if (what === "--sentences" || what === undefined) {
    console.log("\n==== NUMERIC SENTENCES ====");
    for (const file of doc.files) {
      const tables = parseLatexTables(file.content);
      let masked = file.content;
      for (const t of [...tables].sort((a, b) => b.start - a.start)) masked = masked.slice(0, t.start) + " ".repeat(t.end - t.start) + masked.slice(t.end);
      const plain = plainLatexText(masked);
      for (const match of plain.matchAll(/[^.!?]*\d+\.\d+[^.!?]*[.!?]/g)) {
        const sentence = match[0].replace(/\s+/g, " ").trim();
        if (sentence.length < 25 || sentence.length > 600) continue;
        if (/^\s*(?:in|the)\s+(?:table|figure)/i.test(sentence)) continue;
        console.log(`- ${file.file}: ${sentence}`);
      }
    }
  }
}

async function cmdValidate(familyKey) {
  const corpus = await loadCases(familyKey);
  if (corpus === null) {
    console.log(`no cases file for ${familyKey}`);
    return;
  }
  const { files } = await familyFiles(familyKey);
  const problems = [];
  const counts = {};
  /** 每案例独立 materialized 视图（同文件多编辑互不污染） */
  const viewOf = (kase) => {
    const edited = kase.editValue !== null && kase.editValue !== undefined;
    const fileEntry = files.find((f) => f.path === kase.file);
    if (fileEntry === undefined) return { error: `${kase.caseId}: file ${kase.file} missing` };
    let content = fileEntry.content;
    let effectiveQuote = kase.claimQuote;
    if (edited) {
      const quoteSpan = locateQuote(content, kase.claimQuote);
      if (quoteSpan === null) return { error: `${kase.caseId}: original quote not found (pre-edit)` };
      const inQuote = content.slice(quoteSpan.start, quoteSpan.end);
      const replaced = inQuote.replace(kase.originalValue, kase.editValue);
      if (replaced === inQuote) return { error: `${kase.caseId}: edit target ${kase.originalValue} not in quote` };
      content = content.slice(0, quoteSpan.start) + replaced + content.slice(quoteSpan.end);
      effectiveQuote = replaced;
      // 编辑不触碰表格环境：解析 tableId 序列零漂移
      const a = parseLatexTables(fileEntry.content).map((t) => t.tableId);
      const b = parseLatexTables(content).map((t) => t.tableId);
      if (JSON.stringify(a) !== JSON.stringify(b)) return { error: `${kase.caseId}: materialize parse drift` };
    }
    const view = files.map((f) => ({ path: f.path, content: f.path === kase.file ? content : f.content }));
    return { view, effectiveQuote, edited, content };
  };
  const editedViews = [];
  for (const kase of corpus.cases) {
    counts[kase.kind] = (counts[kase.kind] ?? 0) + 1;
    const v = viewOf(kase);
    if (v.error !== undefined) { problems.push(v.error); continue; }
    if (v.edited) editedViews.push({ kase, content: v.content });
    const docM = docOf(v.view);
    const fileContent = v.view.find((f) => f.path === kase.file).content;
    const quoteSpan = locateQuote(fileContent, v.effectiveQuote);
    if (quoteSpan === null) { problems.push(`${kase.caseId}: effective quote not locatable post-edit`); continue; }
    const claimValue = kase.editValue ?? kase.targetValue;
    const located = locateAtom(docM, kase.file, quoteSpan.start, quoteSpan.end, claimValue);
    if (located.atom === null) { problems.push(`${kase.caseId}: atom not located (${located.reason}) value=${claimValue}`); continue; }
    if (kase.kind === "ATOMIC-CONSIST") {
      if (kase.expectedRelation !== "SUPPORTED") problems.push(`${kase.caseId}: CONSIST must be SUPPORTED`);
    } else if (kase.kind === "SCALE-PROBE") {
      // 表示差探针：金格存在但正文/表格显示表示不同（百分比 vs 小数）——不做逐字等值要求，两臂预期 SCALE_AMBIGUOUS 弃判
      if (kase.expectedCertifiable !== false) problems.push(`${kase.caseId}: SCALE-PROBE must be expectedCertifiable=false`);
      for (const gold of kase.goldCells) {
        const table = docM.files.find((f) => f.file === gold.file)?.tables.find((t) => t.tableId === gold.tableId);
        const cell = table?.cells.find((c) => c.row === gold.row && c.col === gold.col);
        if (cell === undefined || cell.value === null) problems.push(`${kase.caseId}: gold cell not found`);
      }
    } else if (kase.kind === "DERIVED-TAB") {
      if (!["SUPPORTED", "ABSTAIN_ONLY"].includes(kase.expectedRelation)) problems.push(`${kase.caseId}: DERIVED-TAB relation must be SUPPORTED or ABSTAIN_ONLY`);
    }
    if (kase.kind === "ATOMIC-CONSIST" || (kase.kind === "DERIVED-TAB" && kase.goldCells.length > 0) || false) {
      for (const gold of kase.goldCells) {
        const table = docM.files.find((f) => f.file === gold.file)?.tables.find((t) => t.tableId === gold.tableId);
        const cell = table?.cells.find((c) => c.row === gold.row && c.col === gold.col);
        if (cell === undefined || cell.value === null) { problems.push(`${kase.caseId}: gold cell not found/valueless`); continue; }
        if (cell.value.raw !== kase.targetValue) problems.push(`${kase.caseId}: gold value ${cell.value.raw} != claim ${kase.targetValue}`);
      }
    } else if (kase.kind === "ATOMIC-CONTRADICT") {
      if (!["CONTRADICTED", "ABSTAIN_ONLY"].includes(kase.expectedRelation)) problems.push(`${kase.caseId}: CONTRADICT relation must be CONTRADICTED or ABSTAIN_ONLY (guard probe)`);
      for (const gold of kase.goldCells) {
        const table = docM.files.find((f) => f.file === gold.file)?.tables.find((t) => t.tableId === gold.tableId);
        const cell = table?.cells.find((c) => c.row === gold.row && c.col === gold.col);
        if (cell === undefined || cell.value === null) { problems.push(`${kase.caseId}: gold cell not found`); continue; }
        if (cell.value.raw === kase.editValue) problems.push(`${kase.caseId}: edit value equals gold value`);
        if (cell.value.raw !== kase.targetValue) problems.push(`${kase.caseId}: gold ${cell.value.raw} != original ${kase.targetValue}`);
      }
    } else if (kase.kind === "ATOMIC-AMBIG") {
      if (kase.goldCells.length !== 0 || kase.expectedRelation !== "ABSTAIN_ONLY") problems.push(`${kase.caseId}: AMBIG must have empty gold + ABSTAIN_ONLY`);
      if (!kase.oracleBasis.includes("competitors")) problems.push(`${kase.caseId}: AMBIG basis must name competitors`);
    }
  }
  // 落盘每案例独立 materialized 副本（eval 用）与 provenance
  for (const { kase, content } of editedViews) {
    const outDir = join(ROOT, "materialized", familyKey, kase.caseId);
    await mkdir(outDir, { recursive: true });
    for (const f of files) await copyFile(join(ROOT, "candidates", FAMILIES[familyKey].arxiv, f.path), join(outDir, f.path)).catch(() => {});
    await writeFile(join(outDir, kase.file), content, "utf8");
  }
  const provenance = {
    familyKey, arxiv: FAMILIES[familyKey].arxiv, split: FAMILIES[familyKey].split, license: corpus.license,
    files: files.map((f) => ({ path: f.path, sha256: sha256(f.content), bytes: f.content.length })),
    caseCount: corpus.cases.length, kinds: counts, editedCases: editedViews.map((e) => e.kase.caseId),
    validatedAt: new Date().toISOString(), problems,
  };
  await writeFile(join(ROOT, "corpus", `${familyKey}-provenance.json`), JSON.stringify(provenance, null, 2), "utf8");
  console.log(`${familyKey}: cases=${corpus.cases.length} kinds=${JSON.stringify(counts)} edited=${editedViews.length}`);
  console.log(problems.length === 0 ? "ALL MECHANICAL CHECKS PASS" : `PROBLEMS:\n${problems.join("\n")}`);
}

const [cmd, familyKey, what] = process.argv.slice(2);
if (cmd === "dump") await cmdDump(familyKey, what);
else if (cmd === "validate") await cmdValidate(familyKey);
else console.log("usage: dump|validate <familyKey>");
