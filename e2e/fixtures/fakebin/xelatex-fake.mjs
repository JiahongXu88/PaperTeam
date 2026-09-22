// e2e fake LaTeX toolchain: simulate xelatex (test stack has no real TeX).
// Probe: --version exits 0; compile (M9.5.1 orchestration runs in buildDir=cwd,
// no -output-directory): write main.aux / main.log / main.pdf into cwd.
// Called via xelatex.cmd (spawn uses shell:true on Windows).
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("XeTeX fake (PaperTeam e2e)");
  process.exit(0);
}

const cwd = process.cwd();
let tex = "";
try {
  tex = await readFile(join(cwd, "main.tex"), "utf8");
} catch {
  tex = "";
}
const cites = [...tex.matchAll(/\\cite\{([^}]*)\}/g)].flatMap((m) => m[1].split(","));
const auxLines = ["\\relax", ...cites.map((key) => `\\citation{${key.trim()}}`)];
if (/\\bibliography\{|\\addbibresource\{/.test(tex)) {
  auxLines.push("\\bibdata{references}", "\\bibstyle{unsrt}");
}
await writeFile(join(cwd, "main.aux"), auxLines.join("\n") + "\n", "utf8");
// 无 Rerun / 无 undefined 引用提示 → 编排在 pass 2 后收敛
await writeFile(join(cwd, "main.log"), "This is fake XeTeX for PaperTeam e2e.\n", "utf8");
await writeFile(join(cwd, "main.pdf"), "%PDF-1.5\n%%PaperTeam e2e fake xelatex\n", "utf8");
console.log("fake xelatex: done");
