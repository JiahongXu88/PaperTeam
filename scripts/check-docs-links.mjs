#!/usr/bin/env node
/**
 * Markdown 相对链接检查（M11.5）：零依赖。
 * 检查 README 与 docs 目录下所有 .md 的仓库内相对链接（文件存在性），
 * 不检查外链（http/https/mailto）与纯锚点。
 * 用法：node scripts/check-docs-links.mjs [--roots README.md,docs]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rootsArgIdx = args.indexOf("--roots");
const roots =
  rootsArgIdx !== -1 && args[rootsArgIdx + 1]
    ? args[rootsArgIdx + 1].split(",")
    : ["README.md", "README.zh-CN.md", "CONTRIBUTING.md", "SECURITY.md", "docs"];

function* walkMarkdown(entry) {
  const abs = join(repoRoot, entry);
  if (!existsSync(abs)) return;
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) {
      if (name === "node_modules" || name === "report" || name === "test-results") continue;
      yield* walkMarkdown(join(entry, name));
    }
  } else if (entry.endsWith(".md")) {
    yield entry;
  }
}

const linkPattern = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const problems = [];
let checked = 0;

for (const root of roots) {
  for (const file of walkMarkdown(root)) {
    const text = readFileSync(join(repoRoot, file), "utf8");
    // 跳过代码块（``` 围栏）内的伪链接
    const stripped = text.replace(/```[\s\S]*?```/g, "");
    for (const match of stripped.matchAll(linkPattern)) {
      const target = match[1];
      if (/^(https?:|mailto:|#)/i.test(target)) continue;
      const pathPart = target.split("#")[0];
      if (pathPart === "") continue; // 纯锚点
      checked += 1;
      const resolved = resolve(repoRoot, dirname(file), decodeURIComponent(pathPart));
      if (!existsSync(resolved)) {
        problems.push(`${file}: 链接目标不存在 → ${target}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`[FAIL] ${problems.length} 个坏链接（检查 ${checked} 个相对链接）：`);
  for (const line of problems) console.error("  - " + line);
  process.exit(1);
}
console.log(`[OK] 相对链接全部有效（${checked} 个，roots: ${roots.join(", ")}）`);
