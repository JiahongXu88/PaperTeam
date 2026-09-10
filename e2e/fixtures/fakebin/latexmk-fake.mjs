// e2e fake LaTeX toolchain: simulate latexmk (test stack has no real TeX).
// Probe: --version exits 0; compile: write a minimal pdf into -output-directory.
// Called via latexmk.cmd (spawn uses shell:true on Windows).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("Latexmk 4.89 (fake, PaperTeam e2e)");
  process.exit(0);
}
const outdirArg = args.find((arg) => arg.startsWith("-output-directory="));
if (outdirArg !== undefined) {
  const outdir = outdirArg.slice("-output-directory=".length).replace(/^"|"$/g, "");
  if (outdir !== "") {
    await writeFile(join(outdir, "main.pdf"), "%PDF-1.5\n%%PaperTeam e2e fake latexmk\n", "utf8");
  }
}
console.log("fake latexmk: done");
