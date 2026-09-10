/**
 * scriptedRuntime 的按项目转向（E2E 标记；M4.7）：
 * - [review:...] 只影响携带标记的项目，其它项目走默认序列
 * - [latex:broken / unfixable] 只破坏 introduction 相关写作输出（halt-on-error
 *   下一次定位一个文件；unfixable 时修复 / 修订输出也保持损坏）
 */

import { describe, expect, it } from "vitest";

import {
  createScriptedRuntime,
  REPAIRED_SECTION_TEX,
  REVISED_SECTION_TEX,
  SECTION_FINDINGS_JSON,
  SECTION_TEX,
  UNDEFINED_MACRO_TEX,
} from "../../src/runtime/scriptedRuntime.js";

function call(
  runtime: ReturnType<typeof createScriptedRuntime>["runtime"],
  scope: string,
  projectId = "p-steer001",
  task = "写作章节：引言（introduction.tex）",
): Promise<string> {
  return runtime
    .runAgent({ agentId: "writer", task, projectId, contextScope: scope })
    .then((taskResult) => taskResult.output ?? "");
}

/** 一次完整 review 轮（fact + academic + style 三路都调用，轮次计数才前进） */
async function reviewRound(
  runtime: ReturnType<typeof createScriptedRuntime>["runtime"],
  projectId: string,
): Promise<string> {
  const fact = await call(runtime, "review/fact", projectId);
  await call(runtime, "review/academic", projectId);
  await call(runtime, "review/style", projectId);
  return JSON.parse(fact)["summary"] as string;
}

describe("scriptedRuntime 按项目转向（E2E 标记）", () => {
  it("[review:...] 只影响携带标记的项目；轮次按项目隔离", async () => {
    const { runtime } = createScriptedRuntime(); // 默认全 pass
    // 标记项目 A：fail,fail2,pass；未标记项目 B：默认 pass
    await call(runtime, "research", "p-a", "研究 Idea：…… [review:fail,fail2,pass]");
    await call(runtime, "research", "p-b", "研究 Idea：普通项目");

    expect(await reviewRound(runtime, "p-a")).toContain("存在无证据支撑");
    expect(await reviewRound(runtime, "p-b")).toContain("均有证据支撑");
    // A 的第 2 轮推进到 fail2（fact 摘要与 fail / pass 均可区分）；B 仍是 pass
    expect(await reviewRound(runtime, "p-a")).toBe("关键论断有证据支撑。");
    expect(await reviewRound(runtime, "p-b")).toContain("均有证据支撑");
    // A 的第 3 轮 pass；B 依然 pass（轮次互不串台）
    expect(await reviewRound(runtime, "p-a")).toContain("均有证据支撑");
    expect(await reviewRound(runtime, "p-b")).toContain("均有证据支撑");
  });

  it("[latex:broken]：只破坏 introduction 章节；[latex:unfixable]：修复 / 修订输出也保持损坏", async () => {
    const broken = createScriptedRuntime();
    await call(broken.runtime, "research", "p-broken", "研究 Idea：…… [latex:broken]");
    const sectionIntro = await call(broken.runtime, "writing/sections", "p-broken");
    const sectionOther = await call(
      broken.runtime,
      "writing/sections",
      "p-broken",
      "写作章节：相关工作（related-work.tex）",
    );
    expect(sectionIntro).toBe(`${SECTION_TEX}\n${UNDEFINED_MACRO_TEX}`);
    expect(sectionOther).toBe(SECTION_TEX);
    // broken：修复输出正常（修复后编译通过）
    expect(await call(broken.runtime, "writing/repair", "p-broken", "修复「sections/introduction.tex」")).toBe(
      REPAIRED_SECTION_TEX,
    );

    const unfixable = createScriptedRuntime();
    await call(unfixable.runtime, "research", "p-unfix", "研究 Idea：…… [latex:unfixable]");
    expect(await call(unfixable.runtime, "writing/repair", "p-unfix", "修复「sections/introduction.tex」")).toBe(
      `${REPAIRED_SECTION_TEX}\n${UNDEFINED_MACRO_TEX}`,
    );
    expect(await call(unfixable.runtime, "writing/revision", "p-unfix", "修订论文章节「引言」")).toBe(
      `${REVISED_SECTION_TEX}\n${UNDEFINED_MACRO_TEX}`,
    );
    // 无标记项目不受影响
    const plain = createScriptedRuntime();
    await call(plain.runtime, "research", "p-plain", "研究 Idea：普通项目");
    expect(await call(plain.runtime, "writing/sections", "p-plain")).toBe(SECTION_TEX);
  });

  it("review/section/* 返回合法 findings JSON（快速 Review 只读 E2E 用）", async () => {
    const { runtime } = createScriptedRuntime();
    const output = await call(runtime, "review/section/sec01", "p-sec");
    expect(JSON.parse(output)["findings"]).toHaveLength(1);
    expect(output).toBe(SECTION_FINDINGS_JSON);
  });
});
