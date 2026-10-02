/**
 * M11.1.3 SurveyOutlineService 编排测试（fixture 全链）：
 * Matrix → Synthesis → Outline（真实 chunk 管线 + 脚本化 runtime 三链分派）、
 * staleness fail-closed、blocking 重规划、SURVEY_OUTLINE_INVALID、
 * outline.json round-trip（refs 归一）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  addFulltextPaper,
  addMetadataOnlyPaper,
  defaultOutlineOutput,
  FIXTURE_ABSTRACT_ONLY,
  FIXTURE_PAPERS,
  newSurveyFixture,
} from "./fixtures.js";

describe("SurveyOutlineService", () => {
  it("全链：Matrix + Synthesis → Survey Outline 落盘 outline.json（refs 有效）", async () => {
    const fixture = await newSurveyFixture();
    try {
      for (const paper of FIXTURE_PAPERS) {
        await addFulltextPaper(fixture.sources, fixture.projectId, paper);
      }
      await addMetadataOnlyPaper(fixture.sources, fixture.projectId, FIXTURE_ABSTRACT_ONLY);

      await fixture.matrix.buildMatrix(fixture.projectId, {});
      await fixture.synthesis.buildSynthesis(fixture.projectId, {});

      const result = await fixture.outline.buildSurveyOutline(fixture.projectId, {});
      expect(result.validation.blocking).toEqual([]);
      expect(result.summary.matrixEntries).toBe(7);
      expect(result.summary.synthesisItems).toBeGreaterThan(0);
      expect(result.summary.planningAttempts).toBe(1);

      // 落盘 round-trip：outline.json 带 refs 且已归一（去重 + 升序）
      const raw = JSON.parse(
        await readFile(join(fixture.root, fixture.projectId, "manuscript", "outline.json"), "utf8"),
      ) as { sections: Array<{ id: string; synthesisRefs?: string[]; literatureRefs?: string[] }> };
      const withRefs = raw.sections.filter((section) => section.synthesisRefs !== undefined);
      expect(withRefs.length).toBeGreaterThan(0);
      for (const section of withRefs) {
        expect(section.synthesisRefs).toEqual([...new Set(section.synthesisRefs)].sort());
        for (const ref of section.synthesisRefs!) {
          expect(ref).toMatch(/^SYN-[0-9a-f]{10}$/);
        }
      }
      // taxonomy 章节绑 taxonomy synthesis；future 章节含 speculative
      const taxonomySection = raw.sections.find((section) => section.id === "taxonomy");
      expect(taxonomySection?.synthesisRefs?.length).toBeGreaterThan(0);
      const futureSection = raw.sections.find((section) => section.id === "future-directions");
      expect(futureSection?.synthesisRefs?.length).toBeGreaterThan(0);

      // Fixture 验收（M11.1.3 §18）：综合章节（trend/comparison）、gap、future 齐备；
      // speculative 只出现在 future 章节（blocking 为空已保证，这里显式断言隔离）
      expect(raw.sections.find((section) => section.id === "trends-comparison")).toBeDefined();
      expect(raw.sections.find((section) => section.id === "gaps")).toBeDefined();
      const synthesis = await fixture.synthesis.getSynthesis(fixture.projectId);
      const speculativeIds = new Set(
        (synthesis?.items ?? []).filter((item) => item.groundingLevel === "speculative").map((item) => item.synthesisId),
      );
      expect(speculativeIds.size).toBeGreaterThan(0);
      for (const section of raw.sections) {
        const hasSpeculative = (section.synthesisRefs ?? []).some((ref) => speculativeIds.has(ref));
        if (section.id === "future-directions") {
          expect(hasSpeculative).toBe(true);
        } else {
          expect(hasSpeculative).toBe(false);
        }
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("缺 Matrix / 缺 Synthesis → INVALID_REQUEST 指引先构建上游", async () => {
    const fixture = await newSurveyFixture();
    try {
      await expect(fixture.outline.buildSurveyOutline(fixture.projectId, {})).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("survey/matrix/build"),
      });

      for (const paper of FIXTURE_PAPERS.slice(0, 2)) {
        await addFulltextPaper(fixture.sources, fixture.projectId, paper);
      }
      await fixture.matrix.buildMatrix(fixture.projectId, {});
      await expect(fixture.outline.buildSurveyOutline(fixture.projectId, {})).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("survey/synthesis/build"),
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("Synthesis 过期（Matrix 指纹不一致）→ 拒绝并指引重建 synthesis", async () => {
    const fixture = await newSurveyFixture();
    try {
      for (const paper of FIXTURE_PAPERS.slice(0, 2)) {
        await addFulltextPaper(fixture.sources, fixture.projectId, paper);
      }
      await fixture.matrix.buildMatrix(fixture.projectId, {});
      await fixture.synthesis.buildSynthesis(fixture.projectId, {});
      // Matrix 增量（新增一篇）→ 指纹变化 → synthesis 过期
      await addFulltextPaper(fixture.sources, fixture.projectId, FIXTURE_PAPERS[2]!);
      await fixture.matrix.buildMatrix(fixture.projectId, {});
      await expect(fixture.outline.buildSurveyOutline(fixture.projectId, {})).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("重建 synthesis"),
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("blocking → 校验错误作为 feedback 重规划；第二次通过 → planningAttempts=2", async () => {
    const fixture = await newSurveyFixture();
    try {
      for (const paper of FIXTURE_PAPERS) {
        await addFulltextPaper(fixture.sources, fixture.projectId, paper);
      }
      await addMetadataOnlyPaper(fixture.sources, fixture.projectId, FIXTURE_ABSTRACT_ONLY);
      await fixture.matrix.buildMatrix(fixture.projectId, {});
      await fixture.synthesis.buildSynthesis(fixture.projectId, {});

      let calls = 0;
      fixture.runtime.setOutlineScript((input) => {
        calls += 1;
        if (calls === 1) {
          // 首轮：伪劣输出——taxonomy 章节绑悬空 SYN id
          const parsed = JSON.parse(defaultOutlineOutput(input)) as {
            sections: Array<{ id: string; synthesisRefs?: string[] }>;
          };
          const taxonomy = parsed.sections.find((section) => section.id === "taxonomy")!;
          taxonomy.synthesisRefs = ["SYN-doesnotex0"];
          return JSON.stringify(parsed);
        }
        return defaultOutlineOutput(input);
      });

      const result = await fixture.outline.buildSurveyOutline(fixture.projectId, {});
      expect(result.summary.planningAttempts).toBe(2);
      expect(result.validation.blocking).toEqual([]);
      // 第二轮 prompt 携带首轮校验错误反馈
      expect(fixture.runtime.calls.filter((call) => call.sourceId === "outline")).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("两轮均 blocking → SURVEY_OUTLINE_INVALID（fail-closed，不落盘）", async () => {
    const fixture = await newSurveyFixture();
    try {
      for (const paper of FIXTURE_PAPERS) {
        await addFulltextPaper(fixture.sources, fixture.projectId, paper);
      }
      await addMetadataOnlyPaper(fixture.sources, fixture.projectId, FIXTURE_ABSTRACT_ONLY);
      await fixture.matrix.buildMatrix(fixture.projectId, {});
      await fixture.synthesis.buildSynthesis(fixture.projectId, {});

      fixture.runtime.setOutlineScript((input) => {
        const parsed = JSON.parse(defaultOutlineOutput(input)) as {
          sections: Array<{ id: string; synthesisRefs?: string[] }>;
        };
        // 每轮都绑悬空 id（重规划也修不好）
        const taxonomy = parsed.sections.find((section) => section.id === "taxonomy")!;
        taxonomy.synthesisRefs = ["SYN-doesnotex0"];
        return JSON.stringify(parsed);
      });

      await expect(fixture.outline.buildSurveyOutline(fixture.projectId, {})).rejects.toMatchObject({
        code: "SURVEY_OUTLINE_INVALID",
        message: expect.stringContaining("SYN-doesnotex0"),
      });
      // 未落盘：outline.json 不存在
      await expect(
        readFile(join(fixture.root, fixture.projectId, "manuscript", "outline.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("feedback（HITL 修订意见）透传到 planner prompt", async () => {
    const fixture = await newSurveyFixture();
    try {
      for (const paper of FIXTURE_PAPERS.slice(0, 2)) {
        await addFulltextPaper(fixture.sources, fixture.projectId, paper);
      }
      await fixture.matrix.buildMatrix(fixture.projectId, {});
      await fixture.synthesis.buildSynthesis(fixture.projectId, {});

      const prompts: string[] = [];
      fixture.runtime.setOutlineScript((input) => {
        prompts.push(input.prompt);
        return defaultOutlineOutput(input);
      });
      const result = await fixture.outline.buildSurveyOutline(fixture.projectId, {
        feedback: "请把分类章节拆成两小节",
      });
      expect(result.summary.planningAttempts).toBe(1);
      expect(prompts[0]).toContain("请把分类章节拆成两小节");
    } finally {
      await fixture.cleanup();
    }
  });
});
