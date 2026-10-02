/**
 * M11.1.1 MatrixService 集成测试（真实 stores + 脚本化 researcher runtime）：
 * Literature → 检索 → 抽取 → 校验 → Matrix → artifact 的完整链路，
 * 以及 dedup / 单篇失败隔离 / HITL 修正。
 */

import { describe, expect, it } from "vitest";

import { BusinessError } from "../../src/errors.js";
import {
  FIXTURE_ABSTRACT_ONLY,
  FIXTURE_PAPERS,
  addFulltextPaper,
  addMetadataOnlyPaper,
  newSurveyFixture,
  type SurveyScript,
} from "./fixtures.js";
import { UNCLASSIFIED_FAMILY } from "../../src/survey/matrixTypes.js";

const BOGUS_CHUNK_ID = "S999:sec9:0001:deadbeef99";

/** S001：合法 family + subFamily + 有效锚点 */
const s001Script: SurveyScript = ({ chunkIds }) =>
  JSON.stringify({
    researchProblem: "检测质量下降时如何保持跟踪关联精度",
    methodFamily: "tracking_association",
    subFamily: "motion_based",
    mainIdea: "低分检测框参与两段式关联，第二段恢复漏检目标。",
    keyTechnique: "按检测置信度分段的 IoU 级联匹配",
    datasetContext: "MOT17 行人跟踪序列",
    strength: "无外观模型时 IDSW 显著下降。",
    limitation: "低照度下检测质量主导，关联无增益。",
    comparedMethods: ["SORT", "DeepSORT", "sort"],
    keyFindings: ["MOT17 上 IDSW 下降约 40%", "保持实时帧率", "无需 ReID 特征", "多余的第四条"],
    anchors: [
      { field: "mainIdea", chunkIds: chunkIds.slice(0, 1) },
      { field: "strength", chunkIds: chunkIds.slice(0, 1) },
    ],
  });

/** S003：非法 family 标签 + 混入无效 chunkId 的锚点 */
const s003Script: SurveyScript = ({ chunkIds }) =>
  JSON.stringify({
    researchProblem: "跨相机行人重识别的特征学习",
    methodFamily: "quantum_flux_matching",
    mainIdea: "全向尺度不变的特征聚合网络。",
    anchors: [
      { field: "mainIdea", chunkIds: [chunkIds[0] ?? BOGUS_CHUNK_ID, BOGUS_CHUNK_ID] },
    ],
  });

/** S005（abstract-only）：脚本违规输出评价字段与 anchors → 服务层强制降级 */
const s005Script: SurveyScript = () =>
  JSON.stringify({
    researchProblem: "缺乏对 MOT 方法的系统综述",
    methodFamily: "survey",
    mainIdea: "综述 tracking-by-detection 与联合检测嵌入两类方法。",
    strength: "覆盖全面（脚本违规输出，应被剥离）。",
    keyFindings: ["开放问题包括拥挤场景（脚本违规输出，应被剥离）"],
    anchors: [{ field: "mainIdea", chunkIds: [BOGUS_CHUNK_ID] }],
  });

describe("MatrixService.buildMatrix（完整链路）", () => {
  it("5 篇固定文献：fulltext 锚定 / abstract-only 降级 / taxonomy fail-closed / artifact 可重载", async () => {
    const fixture = await newSurveyFixture({
      S001: s001Script,
      S002: ({ chunkIds }) =>
        JSON.stringify({
          researchProblem: "外观嵌入如何改进在线跟踪",
          methodFamily: "tracking_association",
          subFamily: "appearance_based",
          mainIdea: "运动预测与外观余弦距离级联融合。",
          anchors: [{ field: "mainIdea", chunkIds: chunkIds.slice(0, 1) }],
        }),
      S003: s003Script,
      S004: () =>
        JSON.stringify({
          researchProblem: "跟踪器之间如何公平比较",
          methodFamily: "evaluation_benchmark",
          mainIdea: "标准化评测协议与公开真值。",
          anchors: [],
        }),
      S005: s005Script,
    });
    try {
      for (const paper of FIXTURE_PAPERS) {
        await addFulltextPaper(fixture.sources, fixture.projectId, paper);
      }
      await addMetadataOnlyPaper(fixture.sources, fixture.projectId, FIXTURE_ABSTRACT_ONLY);

      const result = await fixture.matrix.buildMatrix(fixture.projectId);
      expect(result.summary).toEqual({
        total: 5,
        built: 5,
        skippedExisting: 0,
        failed: 0,
        removedOrphans: 0,
      });
      expect(result.matrix.entries.length).toBe(5);

      const bySource = new Map(result.matrix.entries.map((entry) => [entry.sourceId, entry]));

      // 确定性 entryId + 每个 sourceId 恰好一行
      for (const entry of result.matrix.entries) {
        expect(entry.entryId).toBe(`M-${entry.sourceId}`);
      }

      // fulltext 条目（S001–S004）：锚点存在且可经 ChunkAccess 回取
      for (const sourceId of ["S001", "S002", "S003", "S004"]) {
        const entry = bySource.get(sourceId)!;
        expect(entry.interpretationDepth).toBe("fulltext");
        for (const anchor of entry.anchors) {
          for (const chunkId of anchor.chunkIds) {
            const resolved = await fixture.chunkAccess.resolve(fixture.projectId, chunkId);
            expect(resolved.chunk.sourceId).toBe(sourceId);
          }
        }
      }

      // S001：列表归一（comparedMethods 去重 / keyFindings 截断）与双锚点
      const s001 = bySource.get("S001")!;
      expect(s001.methodFamily).toBe("tracking_association");
      expect(s001.subFamily).toBe("motion_based");
      expect(s001.comparedMethods).toEqual(["SORT", "DeepSORT"]);
      expect(s001.keyFindings?.length).toBe(3);
      expect(s001.anchors.map((anchor) => anchor.field).sort()).toEqual(["mainIdea", "strength"]);

      // S003：非法标签 → unclassified + issue；无效 chunkId 剔除、有效锚点保留；
      // 非法标签没有被静默加进 taxonomy
      const s003 = bySource.get("S003")!;
      expect(s003.methodFamily).toBe(UNCLASSIFIED_FAMILY);
      expect(s003.issues?.some((issue) => issue.code === "method_family_not_in_taxonomy")).toBe(true);
      expect(
        result.matrix.taxonomy.families.some((family) => family.label === "quantum_flux_matching"),
      ).toBe(false);
      expect(s003.anchors.length).toBe(1);
      expect(s003.anchors[0]!.field).toBe("mainIdea");
      expect(s003.anchors[0]!.chunkIds.length).toBe(1);
      expect(s003.anchors[0]!.chunkIds[0]).not.toBe(BOGUS_CHUNK_ID);
      expect(s003.anchors[0]!.chunkIds[0]!.startsWith("S003:")).toBe(true);
      expect(s003.issues?.some((issue) => issue.code === "anchor_chunk_invalid")).toBe(true);

      // S004：fulltext 但模型零锚点 → 弱溯源 issue（不拒绝条目）
      const s004 = bySource.get("S004")!;
      expect(s004.methodFamily).toBe("evaluation_benchmark");
      expect(s004.anchors).toEqual([]);
      expect(s004.issues?.some((issue) => issue.code === "no_valid_anchors")).toBe(true);

      // S005：abstract_only——评价字段剥离、anchors 强制清空、无 fake chunkId
      const s005 = bySource.get("S005")!;
      expect(s005.interpretationDepth).toBe("abstract_only");
      expect(s005.methodFamily).toBe("survey");
      expect(s005.mainIdea).toBeDefined();
      expect(s005.strength).toBeUndefined();
      expect(s005.keyFindings).toBeUndefined();
      expect(s005.anchors).toEqual([]);
      expect(s005.issues?.some((issue) => issue.code === "abstract_only_field_dropped")).toBe(true);
      expect(s005.issues?.some((issue) => issue.code === "abstract_only_anchors_forced_empty")).toBe(true);

      // artifact 可重新加载（round-trip 与条目一致）
      const reloaded = await fixture.matrix.getMatrix(fixture.projectId);
      expect(reloaded?.entries.length).toBe(5);
      expect(reloaded?.entries.map((entry) => entry.entryId)).toEqual(
        result.matrix.entries.map((entry) => entry.entryId),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("重复 build 不产生重复行（全部 skipped_existing）；force 重算替换单条", async () => {
    const fixture = await newSurveyFixture({ S001: s001Script });
    try {
      const ids: string[] = [];
      for (const paper of FIXTURE_PAPERS) {
        ids.push(await addFulltextPaper(fixture.sources, fixture.projectId, paper));
      }
      const first = await fixture.matrix.buildMatrix(fixture.projectId);
      expect(first.summary.built).toBe(4);

      const second = await fixture.matrix.buildMatrix(fixture.projectId);
      expect(second.summary).toMatchObject({ built: 0, skippedExisting: 4, failed: 0 });
      expect(second.matrix.entries.length).toBe(4);
      // 每个 sourceId 仍然至多一行
      const sourceIds = second.matrix.entries.map((entry) => entry.sourceId);
      expect(new Set(sourceIds).size).toBe(sourceIds.length);

      // force 重算单篇：替换既有条目（同 entryId，条目数不增）
      const forced = await fixture.matrix.buildMatrix(fixture.projectId, {
        sourceIds: [ids[0]!],
        force: true,
      });
      expect(forced.summary).toMatchObject({ built: 1, skippedExisting: 0 });
      expect(forced.matrix.entries.length).toBe(4);
    } finally {
      await fixture.cleanup();
    }
  });

  it("单篇失败不污染其他条目（partial success；force 重算失败保留旧条目）", async () => {
    const fixture = await newSurveyFixture({
      S004: () => ({ fail: true, error: "模型任务失败（fixture）" }),
    });
    try {
      for (const paper of FIXTURE_PAPERS) {
        await addFulltextPaper(fixture.sources, fixture.projectId, paper);
      }
      const result = await fixture.matrix.buildMatrix(fixture.projectId);
      expect(result.summary).toEqual({
        total: 4,
        built: 3,
        skippedExisting: 0,
        failed: 1,
        removedOrphans: 0,
      });
      const failed = result.results.find((item) => item.outcome === "failed");
      expect(failed?.sourceId).toBe("S004");
      expect(failed?.error).toContain("模型任务失败");
      // 失败篇目没有条目，其余条目完好
      expect(result.matrix.entries.some((entry) => entry.sourceId === "S004")).toBe(false);
      expect(result.matrix.entries.length).toBe(3);

      // 下一次 build 自动重试失败篇目（脚本改为成功）
      fixture.runtime.setScript("S004", () =>
        JSON.stringify({ methodFamily: "evaluation_benchmark", mainIdea: "评测协议。" }),
      );
      const retry = await fixture.matrix.buildMatrix(fixture.projectId);
      expect(retry.summary).toMatchObject({ built: 1, skippedExisting: 3, failed: 0 });
      expect(retry.matrix.entries.length).toBe(4);
    } finally {
      await fixture.cleanup();
    }
  });

  it("显式 sourceIds：不存在 / reference 角色 / 已否决 → 拒绝整批", async () => {
    const fixture = await newSurveyFixture();
    try {
      await addFulltextPaper(fixture.sources, fixture.projectId, FIXTURE_PAPERS[0]!);
      await expect(
        fixture.matrix.buildMatrix(fixture.projectId, { sourceIds: ["S001", "S099"] }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

      await fixture.sources.update(fixture.projectId, "S001", { sourceRole: "reference" });
      await expect(
        fixture.matrix.buildMatrix(fixture.projectId, { sourceIds: ["S001"] }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

      await expect(fixture.matrix.buildMatrix(fixture.projectId, { sourceIds: [] })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("孤儿条目清理：source 删除后 build 移除其条目", async () => {
    const fixture = await newSurveyFixture();
    try {
      await addFulltextPaper(fixture.sources, fixture.projectId, FIXTURE_PAPERS[0]!);
      await addFulltextPaper(fixture.sources, fixture.projectId, FIXTURE_PAPERS[1]!);
      const first = await fixture.matrix.buildMatrix(fixture.projectId);
      expect(first.matrix.entries.length).toBe(2);

      await fixture.sources.remove(fixture.projectId, "S001");
      const second = await fixture.matrix.buildMatrix(fixture.projectId);
      expect(second.summary.removedOrphans).toBe(1);
      expect(second.matrix.entries.map((entry) => entry.sourceId)).toEqual(["S002"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("taxonomy 覆盖：既有条目标签失效 → unclassified + issue；非法 taxonomy → 拒绝", async () => {
    const fixture = await newSurveyFixture();
    try {
      await addFulltextPaper(fixture.sources, fixture.projectId, FIXTURE_PAPERS[0]!);
      await fixture.matrix.buildMatrix(fixture.projectId);
      expect((await fixture.matrix.getMatrix(fixture.projectId))!.entries[0]!.methodFamily).toBe(
        "tracking_association",
      );

      const replaced = await fixture.matrix.buildMatrix(fixture.projectId, {
        taxonomy: {
          families: [
            { label: "detection", description: "检测" },
            { label: "survey", description: "综述" },
          ],
        },
      });
      const entry = replaced.matrix.entries[0]!;
      expect(entry.methodFamily).toBe(UNCLASSIFIED_FAMILY);
      expect(entry.issues?.some((issue) => issue.code === "entry_reclassified")).toBe(true);
      // taxonomy 变化 + 全部 skipped：artifact 仍被写回（词表生效）
      expect(replaced.matrix.taxonomy.families.map((family) => family.label)).toEqual([
        "detection",
        "survey",
      ]);

      await expect(
        fixture.matrix.buildMatrix(fixture.projectId, { taxonomy: { families: [] } }),
      ).rejects.toMatchObject({ code: "AGENT_RUN_FAILED" });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("MatrixService.updateEntry（HITL 修正）", () => {
  async function builtFixture() {
    const fixture = await newSurveyFixture({ S001: s001Script });
    await addFulltextPaper(fixture.sources, fixture.projectId, FIXTURE_PAPERS[0]!);
    await fixture.matrix.buildMatrix(fixture.projectId);
    return fixture;
  }

  it("修正 taxonomy 标签并确认：status=confirmed", async () => {
    const fixture = await builtFixture();
    try {
      const updated = await fixture.matrix.updateEntry(fixture.projectId, "M-S001", {
        methodFamily: "detection",
        status: "confirmed",
      });
      expect(updated.methodFamily).toBe("detection");
      expect(updated.status).toBe("confirmed");
      const matrix = await fixture.matrix.getMatrix(fixture.projectId);
      expect(matrix?.entries[0]?.methodFamily).toBe("detection");
      expect(matrix?.entries[0]?.status).toBe("confirmed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("非法标签 / 非法 subFamily → 400 fail-closed", async () => {
    const fixture = await builtFixture();
    try {
      await expect(
        fixture.matrix.updateEntry(fixture.projectId, "M-S001", { methodFamily: "made_up_family" }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        fixture.matrix.updateEntry(fixture.projectId, "M-S001", { subFamily: "not_in_list" }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("已确认条目被编辑内容 → 回退 draft", async () => {
    const fixture = await builtFixture();
    try {
      await fixture.matrix.updateEntry(fixture.projectId, "M-S001", { status: "confirmed" });
      const edited = await fixture.matrix.updateEntry(fixture.projectId, "M-S001", {
        mainIdea: "修正后的核心思想。",
      });
      expect(edited.status).toBe("draft");
      expect(edited.mainIdea).toBe("修正后的核心思想。");
    } finally {
      await fixture.cleanup();
    }
  });

  it("超长字段 / keyFindings 超限 → 400（人的输入得到明确反馈，不静默截断）", async () => {
    const fixture = await builtFixture();
    try {
      await expect(
        fixture.matrix.updateEntry(fixture.projectId, "M-S001", { mainIdea: "长".repeat(301) }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        fixture.matrix.updateEntry(fixture.projectId, "M-S001", {
          keyFindings: ["a", "b", "c", "d"],
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("anchors 整体替换：有效 chunkId 通过；无效 / 跨文献 chunk → 400", async () => {
    const fixture = await builtFixture();
    try {
      const matrix = await fixture.matrix.getMatrix(fixture.projectId);
      const validChunkId = matrix!.entries[0]!.anchors[0]!.chunkIds[0]!;
      const updated = await fixture.matrix.updateEntry(fixture.projectId, "M-S001", {
        anchors: [{ field: "limitation", chunkIds: [validChunkId] }],
      });
      expect(updated.anchors).toEqual([{ field: "limitation", chunkIds: [validChunkId] }]);

      await expect(
        fixture.matrix.updateEntry(fixture.projectId, "M-S001", {
          anchors: [{ field: "mainIdea", chunkIds: [BOGUS_CHUNK_ID] }],
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("矩阵不存在 / 条目不存在 → 404", async () => {
    const fixture = await newSurveyFixture();
    try {
      await expect(
        fixture.matrix.updateEntry(fixture.projectId, "M-S001", { mainIdea: "x" }),
      ).rejects.toBeInstanceOf(BusinessError);
      await addFulltextPaper(fixture.sources, fixture.projectId, FIXTURE_PAPERS[0]!);
      await fixture.matrix.buildMatrix(fixture.projectId);
      await expect(
        fixture.matrix.updateEntry(fixture.projectId, "M-S099", { mainIdea: "x" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await fixture.cleanup();
    }
  });
});
