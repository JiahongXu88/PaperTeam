// e2e fake LaTeX toolchain: simulate bibtex (test stack has no real TeX).
// Probe: --version exits 0; run (cwd=buildDir, job "main"): write a non-empty
// main.blg (15 entries — not the "0 entries" failure form) and main.bbl.
// Called via bibtex.cmd (spawn uses shell:true on Windows).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("BibTeX fake (PaperTeam e2e)");
  process.exit(0);
}

const cwd = process.cwd();
await writeFile(join(cwd, "main.blg"), "This is fake BibTeX: You've used 15 entries.\n", "utf8");
await writeFile(join(cwd, "main.bbl"), "\\bibitem{fake2026e2e} PaperTeam e2e fake entry.\n", "utf8");
console.log("fake bibtex: done");
