/**
 * M15 长程 E2 复验（零模型，环境门控 PAPERTEAM_M15_REALRUN_PROJECT=<真实运行项目目录> + PAPERTEAM_M15_REALRUN_OUT=<输出 json>）：
 * 把真实运行 rev-1 快照复制到全新项目根，重放确定性引用语法归一——输出必须逐文件等于真实 rev-2，且每个写入都有
 * candidate_accepted 事件（appliedHash 与真实 rev-2 文件哈希一致）。源目录只读。
 */
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { EditContractEvent } from "../../src/quality/editContractStore.js";
import { revisionSourceHash } from "../../src/review/revisionScope.js";
import { normalizeManuscriptCitationSyntax } from "../../src/workflow/definitions.js";
import { ValidatedWriteRegistry } from "../../src/workflow/editContractEnforcement.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 120_000 });
const SOURCE = process.env["PAPERTEAM_M15_REALRUN_PROJECT"];
const OUT = process.env["PAPERTEAM_M15_REALRUN_OUT"];
let t: TestStack;
afterAll(async () => t?.cleanup());

describe.skipIf(SOURCE === undefined || OUT === undefined)("真实运行 rev-1 → 归一重放 ≡ rev-2 + 事件", () => {
  it("重放", async () => {
    t = await startTestStack(scriptedIdeaRuntime().runtime);
    const project = await t.store.create("realrun-normalize-replay", {});
    const dir = t.store.manuscriptDir(project.id);
    await mkdir(dir, { recursive: true });
    await cp(join(SOURCE!, "manuscript", "revisions", "rev-1"), dir, { recursive: true });
    const events: EditContractEvent[] = [];
    await normalizeManuscriptCitationSyntax(t.stack.workflowServices, project.id, { registry: new ValidatedWriteRegistry(), runId: "replay", events });
    const rev2 = join(SOURCE!, "manuscript", "revisions", "rev-2", "sections");
    const rows = [];
    for (const name of await readdir(rev2)) {
      const real = await readFile(join(rev2, name), "utf8");
      const replayed = await readFile(join(dir, "sections", name), "utf8");
      const event = events.find((entry) => entry.target === `sections/${name}`);
      rows.push({ file: name, equal: real === replayed, event: event?.kind ?? null, hashMatches: event === undefined ? null : event.appliedHash === revisionSourceHash(real) });
    }
    await writeFile(OUT!, JSON.stringify({ source: SOURCE, events: events.length, rows }, null, 2), "utf8");
    expect(rows.every((row) => row.equal)).toBe(true);
    const changed = rows.filter((row) => row.event !== null);
    expect(changed.length).toBe(4);
    expect(changed.every((row) => row.event === "candidate_accepted" && row.hashMatches === true)).toBe(true);
  });
});
