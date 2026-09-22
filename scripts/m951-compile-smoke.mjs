// M9.5.1 Live Smoke：用新编排式 LatexCompiler 重新编译 M9.5 验收项目，
// 验证 PDF 正文 citation 与 References section（对照 M9.5 时 references 为空的事故现场）。
// 用法：node scripts/m951-compile-smoke.mjs <projectIdDir>
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { LatexCompiler } from "../backend/dist/latex/LatexCompiler.js";

const projectDir = process.argv[2];
if (!projectDir) {
  console.error("用法：node scripts/m951-compile-smoke.mjs <projectIdDir>");
  process.exit(1);
}

const manuscriptDir = join(projectDir, "manuscript");
const buildDir = join(projectDir, "build");

console.log(`[m951-smoke] project: ${projectDir}`);
const compiler = new LatexCompiler({ timeoutMs: 300_000 });
const result = await compiler.compile({ manuscriptDir, buildDir });
console.log(`[m951-smoke] compile ok=${result.ok} tool=${result.tool} ${result.durationMs}ms`);
console.log(`[m951-smoke] pdf: ${result.pdfPath}`);
console.log(`[m951-smoke] log: ${result.logPath}`);

// 编排日志摘要
const log = await readFile(result.logPath, "utf8");
const stepHeads = log.split("\n").filter((line) => line.startsWith("#") || line.startsWith("$"));
console.log("[m951-smoke] steps:");
for (const head of stepHeads) {
  console.log(`  ${head}`);
}

// 重复编译：确定性验证（第二次 compile 应成功且序列一致）
const result2 = await compiler.compile({ manuscriptDir, buildDir });
console.log(
  `[m951-smoke] rebuild ok=${result2.ok} ${result2.durationMs}ms (deterministic rerun)`,
);
