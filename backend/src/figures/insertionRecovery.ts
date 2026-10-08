/** Durable, single-project Figure insertion intent. All paths are derived by the caller. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BusinessError } from "../errors.js";
import { collectLatexFiles } from "../manuscript/LatexFiles.js";
import { buildVisualInventory, persistVisualInventory } from "../manuscript/visualInventory.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeFileAtomic, writeJsonAtomic } from "../util/atomic.js";
import { fingerprintJson } from "../util/hash.js";
import type { InsertResult } from "./FigureService.js";
import type { FigureStore } from "./figureStore.js";

type FileChange = { before: string | null; after: string; content: string };
export type InsertionIntent = {
  schemaVersion: 1;
  status: "pending" | "complete";
  requestHash: string;
  targetFile: string;
  target: FileChange;
  main?: FileChange;
  manifest: FileChange;
  revision: number;
  result: InsertResult;
};

export function hashText(value: string | null): string | null {
  return value === null ? null : createHash("sha256").update(value).digest("hex");
}

export function requestFingerprint(params: unknown): string {
  return fingerprintJson(params);
}

export function change(before: string | null, content: string): FileChange {
  return { before: hashText(before), after: hashText(content)!, content };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

function recoveryRequired(detail: string): never {
  throw new BusinessError("FIGURE_RECOVERY_REQUIRED", `Figure 插入需要人工对账：${detail}`);
}

export async function readIntent(store: FigureStore): Promise<InsertionIntent | null> {
  const raw = await readOptional(join(store.root, "insertion-intent.json"));
  if (raw === null) return null;
  let value: InsertionIntent;
  try { value = JSON.parse(raw) as InsertionIntent; } catch { return recoveryRequired("intent JSON 损坏"); }
  if (value.schemaVersion !== 1 || !["pending", "complete"].includes(value.status) ||
      !/^(?!.*(?:^|\/)\.\.\/)[A-Za-z0-9_./-]+\.tex$/.test(value.targetFile) ||
      value.targetFile.startsWith("/") ||
      !validChange(value.target) || !validChange(value.manifest) ||
      (value.main !== undefined && !validChange(value.main)) ||
      !/^[0-9a-f]{64}$/.test(value.requestHash) || !value.result ||
      value.result.file !== value.targetFile ||
      typeof value.result.environment !== "string" || !value.target.content.includes(value.result.environment) ||
      typeof value.revision !== "number") {
    return recoveryRequired("intent 结构或路径无效");
  }
  return value;
}

function validChange(value: FileChange | undefined): boolean {
  return value !== undefined && typeof value.content === "string" &&
    (value.before === null || /^[0-9a-f]{64}$/.test(value.before)) &&
    value.after === hashText(value.content);
}

export async function saveIntent(store: FigureStore, intent: InsertionIntent): Promise<void> {
  await writeJsonAtomic(join(store.root, "insertion-intent.json"), intent);
}

/** Called under FigureService's project lock before every insert. Never restores old bytes. */
export async function recoverInsertion(projects: ProjectStore, projectId: string, store: FigureStore): Promise<InsertionIntent | null> {
  const intent = await readIntent(store);
  if (intent === null || intent.status === "complete") return intent;
  const manuscriptDir = projects.manuscriptDir(projectId);
  const targetPath = join(manuscriptDir, intent.targetFile);
  const mainPath = projects.mainTexPath(projectId);
  const states = [
    { name: intent.targetFile, path: targetPath, data: intent.target },
    ...(intent.main === undefined ? [] : [{ name: "main.tex", path: mainPath, data: intent.main }]),
    { name: "figure manifest", path: store.manifestPath, data: intent.manifest },
  ];
  // Preflight every file before any recovery write: an unexpected later edit blocks the whole operation.
  const observed = await Promise.all(states.map(async (entry) => hashText(await readOptional(entry.path))));
  for (let index = 0; index < states.length; index += 1) {
    const entry = states[index]!;
    if (observed[index] !== entry.data.before && observed[index] !== entry.data.after) {
      recoveryRequired(`${entry.name} 与 intent 的前后指纹均不一致；保留当前文件，禁止自动覆盖`);
    }
  }
  for (let index = 0; index < states.length; index += 1) {
    const entry = states[index]!;
    for (let prior = 0; prior < index; prior += 1) {
      const applied = states[prior]!;
      if (hashText(await readOptional(applied.path)) !== applied.data.after) {
        recoveryRequired(`${applied.name} 在后续写入前又发生变化`);
      }
    }
    if (observed[index] === entry.data.before && entry.data.before !== entry.data.after) {
      // Recheck directly before writing to narrow the external-writer race window.
      if (hashText(await readOptional(entry.path)) !== entry.data.before) {
        recoveryRequired(`${entry.name} 在恢复期间变化`);
      }
      await testBoundary(index === 0 ? "before-target" : entry.name === "main.tex" ? "before-main" : "before-manifest");
      await writeFileAtomic(entry.path, entry.data.content);
      await testBoundary(index === 0 ? "target" : entry.name === "main.tex" ? "main" : "manifest");
    }
  }
  const assertApplied = async (): Promise<void> => {
    for (const entry of states) {
      if (hashText(await readOptional(entry.path)) !== entry.data.after) {
        recoveryRequired(`${entry.name} 在派生 Inventory 重建时发生变化`);
      }
    }
  };
  await assertApplied();
  const files = await collectLatexFiles(manuscriptDir);
  const inventory = buildVisualInventory(
    files.allTex.map((file) => ({ file: file.relativePath, content: file.content })),
    { manuscriptRevision: intent.revision },
  );
  await testBoundary("before-inventory");
  await persistVisualInventory(projects, projectId, inventory);
  await testBoundary("inventory");
  await assertApplied();
  const complete: InsertionIntent = { ...intent, status: "complete" };
  await saveIntent(store, complete);
  return complete;
}

/** Test-only deterministic boundary. An abrupt child exit uses the same seam. */
async function testBoundary(name: string): Promise<void> {
  if (process.env["NODE_ENV"] !== "test" || process.env["PAPERTEAM_FIGURE_TEST_FAILURE"] !== name) return;
  if (process.env["PAPERTEAM_FIGURE_TEST_EXIT"] === "1") {
    process.kill(process.pid, "SIGKILL");
    process.exit(73);
  }
  if (process.env["PAPERTEAM_FIGURE_TEST_WRITE_FAILURE"] === "1") {
    throw Object.assign(new Error(`FIGURE_TEST_INTERRUPTED:${name}`), { code: "EIO" });
  }
  throw new Error(`FIGURE_TEST_INTERRUPTED:${name}`);
}
