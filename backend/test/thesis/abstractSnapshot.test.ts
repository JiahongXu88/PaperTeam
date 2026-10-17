/**
 * M14.7 — 摘要快照绑定（abstractSnapshot）单元测试。
 *
 * 覆盖：正文节指纹的确定性（排序 / 内容敏感 / 缺文件确定性）、事实与决定指纹、
 * compareAbstractSnapshot 的三分支（绑定缺失 / 一致 / 过期含差异明细）。
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compareAbstractSnapshot,
  computeAuthorDecisionFingerprint,
  computeConfirmedFactFingerprint,
  computeManuscriptSectionsFingerprint,
  type AbstractSnapshotBinding,
} from "../../src/thesis/abstractSnapshot.js";
import type { ProjectStore } from "../../src/project/ProjectStore.js";
import type { AuthorDecision, FactView } from "../../src/thesis/researchInputTypes.js";

let root: string;
let projects: ProjectStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "m147-abstract-snapshot-"));
  projects = { manuscriptDir: (projectId: string) => join(root, projectId, "manuscript") } as unknown as ProjectStore;
  const sections = join(root, "p-1", "manuscript", "sections");
  await mkdir(sections, { recursive: true });
  await writeFile(join(sections, "intro.tex"), "正文 A\n", "utf8");
  await writeFile(join(sections, "method.tex"), "方法 75.37%\n", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const fact = (id: string, surface: string) => ({ factId: id, surface }) as unknown as FactView;
const decision = (type: string, id: string) => ({ type, decisionId: id }) as unknown as AuthorDecision;

describe("M14.7 computeManuscriptSectionsFingerprint", () => {
  it("内容不变 → 指纹稳定（与调用次数 / 传入顺序无关）", async () => {
    const a = await computeManuscriptSectionsFingerprint(projects, "p-1", ["intro.tex", "method.tex"]);
    const b = await computeManuscriptSectionsFingerprint(projects, "p-1", ["method.tex", "intro.tex"]);
    expect(a).toBe(b);
  });

  it("内容变化 → 指纹变化；缺文件 → 确定性变化（不抛错）", async () => {
    const before = await computeManuscriptSectionsFingerprint(projects, "p-1", ["intro.tex", "method.tex"]);
    const missing = await computeManuscriptSectionsFingerprint(projects, "p-1", ["intro.tex", "gone.tex"]);
    expect(missing).not.toBe(before);
    const missingAgain = await computeManuscriptSectionsFingerprint(projects, "p-1", ["intro.tex", "gone.tex"]);
    expect(missingAgain).toBe(missing);
    const sections = join(root, "p-1", "manuscript", "sections");
    await writeFile(join(sections, "intro.tex"), "正文 A（修订后）\n", "utf8");
    const after = await computeManuscriptSectionsFingerprint(projects, "p-1", ["intro.tex", "method.tex"]);
    expect(after).not.toBe(before);
    await writeFile(join(sections, "intro.tex"), "正文 A\n", "utf8");
  });

  it("文件名集合变化（增删节）→ 指纹变化", async () => {
    const base = await computeManuscriptSectionsFingerprint(projects, "p-1", ["intro.tex", "method.tex"]);
    const added = await computeManuscriptSectionsFingerprint(projects, "p-1", ["intro.tex", "method.tex", "extra.tex"]);
    expect(added).not.toBe(base);
  });
});

describe("M14.7 事实 / 决定指纹", () => {
  it("顺序无关；surface 变化敏感", () => {
    const a = computeConfirmedFactFingerprint([fact("F1", "75.37%"), fact("F2", "0.1s")]);
    const b = computeConfirmedFactFingerprint([fact("F2", "0.1s"), fact("F1", "75.37%")]);
    expect(a).toBe(b);
    expect(computeConfirmedFactFingerprint([fact("F1", "75.37%"), fact("F2", "0.2s")])).not.toBe(a);
  });

  it("决定集合变化敏感（新增 / 移除）", () => {
    const a = computeAuthorDecisionFingerprint([decision("fact_confirmation", "D1")]);
    expect(computeAuthorDecisionFingerprint([decision("fact_confirmation", "D1"), decision("writing_pause", "D2")])).not.toBe(a);
    expect(computeAuthorDecisionFingerprint([])).not.toBe(a);
  });
});

describe("M14.7 compareAbstractSnapshot", () => {
  const current = {
    revision: 2,
    manuscriptFingerprint: "fp-manuscript",
    confirmedFactFingerprint: "fp-facts",
    authorDecisionFingerprint: "fp-decisions",
  };
  const bound: AbstractSnapshotBinding = {
    schemaVersion: 1,
    revision: 1,
    manuscriptFingerprint: "fp-manuscript",
    confirmedFactFingerprint: "fp-facts",
    authorDecisionFingerprint: "fp-decisions",
    generatedAt: "2026-10-17T00:00:00Z",
  };

  it("指纹全一致 → current（修订号不同不判过期：commit 指纹幂等，内容才是权威）", () => {
    const result = compareAbstractSnapshot(bound, current);
    expect(result.current).toBe(true);
    expect(result.detail).toContain("rev-1");
  });

  it("绑定缺失 → stale（ABSTRACT_STALE：无法证明一致）", () => {
    const result = compareAbstractSnapshot(undefined, current);
    expect(result.current).toBe(false);
    expect(result.detail).toContain("ABSTRACT_STALE");
  });

  it("正文 / 事实 / 决定任一变化 → stale 且明细点名差异", () => {
    expect(compareAbstractSnapshot({ ...bound, manuscriptFingerprint: "fp-other" }, current).detail).toContain("正文已变化");
    expect(compareAbstractSnapshot({ ...bound, confirmedFactFingerprint: "fp-other" }, current).detail).toContain("事实集合已变化");
    expect(compareAbstractSnapshot({ ...bound, authorDecisionFingerprint: "fp-other" }, current).detail).toContain("作者决定状态已变化");
    expect(compareAbstractSnapshot({ ...bound, manuscriptFingerprint: "x", confirmedFactFingerprint: "y" }, current).current).toBe(false);
  });
});
