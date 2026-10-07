/**
 * TargetProfileService（M12 Batch 2 · A7）单元测试。
 *
 * 覆盖：确定性分位带 golden（同语料同 profile）/ 部分覆盖（无解析产论文零
 * 贡献）/ 语料 n<5 维度 insufficient / 损坏 profile fail-closed / freshness
 * 三键失效（revision / fingerprint / extractorSchemaVersion）/ ensureCurrent
 * 显式重建 / bounded 摘要（成功 / 1 次 repair / 失败转 UNAVAILABLE / 未配置）。
 */

import { afterAll, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TargetModelCaller, TargetSummaryModel } from "../../src/target/TargetProfileService.js";
import {
  SIX_PAPERS,
  TARGET,
  VALID_SUMMARY_JSON,
  papersOf,
  setupTargetHarness,
} from "./profileFixtures.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function scriptedModel(outputs: readonly string[]): TargetSummaryModel & { callCount(): number } {
  let calls = 0;
  const caller: TargetModelCaller = {
    async completeSimple() {
      const output = outputs[Math.min(calls, outputs.length - 1)] ?? "";
      calls += 1;
      return { content: [{ type: "text", text: output }], stopReason: "stop" };
    },
  };
  return {
    caller,
    catalogEntry: { id: "fake-text-model" },
    spec: "fake-text-model@test",
    callCount: () => calls,
  };
}

describe("TargetProfileService（A7）确定性提取", () => {
  it("golden：分位带线性插值可手算（totals 1000–3500 → p25=1625/median=2250/p75=2875）", async () => {
    const { projectId, profile } = await setupTargetHarness(SIX_PAPERS, { roots });
    const artifact = await profile.generate(projectId);
    expect(artifact.n).toBe(6);
    // totals [1000,1500,2000,2500,3000,3500]：idx=(n-1)p → p25=1625；median=2250；p75=2875
    expect(artifact.dimensions.structure.totalLengthWords).toEqual({
      n: 6, min: 1000, p25: 1625, median: 2250, p75: 2875, max: 3500,
    });
    // abstract [100,120,140,160,180,200]：p25=125；median=150；p75=175
    expect(artifact.dimensions.structure.abstractLengthWords).toEqual({
      n: 6, min: 100, p25: 125, median: 150, p75: 175, max: 200,
    });
    // refEntries [10,14,18,22,26,30]：p25=15；median=20；p75=25
    expect(artifact.dimensions.literature.citationCount).toEqual({
      n: 6, min: 10, p25: 15, median: 20, p75: 25, max: 30,
    });
    // 文献年龄：paperYear 全 2023，refs 2019/2019/2020/2020/2021/2021 → median 3
    expect(artifact.dimensions.literature.medianReferenceAgeYears).toBe(3);
    // tables [2,3,4,5,6,7]：p25=3.25；median=4.5；p75=5.75
    expect(artifact.dimensions.experiments.tableCount).toEqual({
      n: 6, min: 2, p25: 3.25, median: 4.5, p75: 5.75, max: 7,
    });
    // figures [4,5,6,7,8,9]：p25=5.25；median=6.5；p75=7.75
    expect(artifact.dimensions.visuals.figureCount).toEqual({
      n: 6, min: 4, p25: 5.25, median: 6.5, p75: 7.75, max: 9,
    });
    // 章节模式：六篇全部设 method 章
    expect(artifact.dimensions.structure.sectionPattern["method"]).toEqual({
      present: 6,
      medianLengthWords: expect.any(Number),
    });
    expect(artifact.dimensions.structure.availability).toBe("available");
    expect(artifact.dimensions.structure.coverage).toBe(6);
    // 比例字段（确定性）：ablation P003–P006；方法总览图 P002–P006；limitations P005–P006
    expect(artifact.dimensions.experiments.ablationPresent).toBeCloseTo(4 / 6, 2);
    expect(artifact.dimensions.visuals.methodDiagramPresent).toBeCloseTo(5 / 6, 2);
    expect(artifact.dimensions.writing.limitationsPresent).toBeCloseTo(2 / 6, 2);
    // provenance 分离：确定性字段不含 method/writing 摘要字段
    expect(artifact.provenance.deterministicFields).not.toContain("dimensions.method.depthNote");
    // dataset 启发式口径披露
    expect(artifact.notes.some((note) => note.includes("dataset 广度"))).toBe(true);
  });

  it("同语料 + 同摘要输出 → 同 profile（确定性重算复现）", async () => {
    const model = scriptedModel([VALID_SUMMARY_JSON]);
    const { projectId, profile } = await setupTargetHarness(SIX_PAPERS, { summaryModel: model, roots });
    const first = await profile.generate(projectId);
    const second = await profile.generate(projectId);
    expect(second).toEqual(first);
  });

  it("部分覆盖：无解析产物的论文零贡献（coverage 如实降低，不按语料总数伪造）", async () => {
    const specs = SIX_PAPERS.map((spec, index) => (index >= 3 ? { ...spec, noDoc: true } : spec));
    const { projectId, profile } = await setupTargetHarness(specs, { roots });
    const artifact = await profile.generate(projectId);
    expect(artifact.n).toBe(6); // 语料行数不变
    expect(artifact.dimensions.structure.coverage).toBe(3);
    expect(artifact.dimensions.structure.availability).toBe("insufficient");
    expect(artifact.dimensions.structure.reason).toContain("3 篇有效样本");
    expect(artifact.notes.some((note) => note.includes("3/6 篇语料论文无可用解析产物"))).toBe(true);
    expect(artifact.dimensions.visuals.coverage).toBe(3);
  });

  it("语料 n<5：全部维度 insufficient + notes 明示（readiness 将 INSUFFICIENT_EVIDENCE）", async () => {
    const { projectId, profile } = await setupTargetHarness(SIX_PAPERS.slice(0, 3), { roots });
    const artifact = await profile.generate(projectId);
    expect(artifact.n).toBe(3);
    expect(artifact.dimensions.structure.availability).toBe("insufficient");
    expect(artifact.dimensions.literature.availability).toBe("insufficient");
    expect(artifact.dimensions.experiments.availability).toBe("insufficient");
    expect(artifact.dimensions.visuals.availability).toBe("insufficient");
    expect(artifact.notes.some((note) => note.includes("语料仅 3 篇"))).toBe(true);
  });

  it("无参考文献节的论文对文献维度零贡献（不伪造 0 条目）", async () => {
    const specs = SIX_PAPERS.map((spec, index) => (index < 3 ? { ...spec, refEntries: 0 } : spec));
    const { projectId, profile } = await setupTargetHarness(specs, { roots });
    const artifact = await profile.generate(projectId);
    expect(artifact.dimensions.literature.coverage).toBe(3); // 只有后三篇有 [n] 标记
    expect(artifact.dimensions.literature.citationCount?.n).toBe(3);
  });
});

describe("TargetProfileService（A7）读容错与 freshness", () => {
  it("未生成 → null；损坏 JSON / 非法 schemaVersion → fail-closed 抛错", async () => {
    const { projects, projectId, profile } = await setupTargetHarness(SIX_PAPERS, { roots });
    expect(await profile.get(projectId)).toBeNull();
    await profile.generate(projectId);
    await writeFile(join(projects.researchDir(projectId), "target-profile.json"), "{ not-json", "utf8");
    await expect(profile.get(projectId)).rejects.toMatchObject({ code: "TARGET_PROFILE_CORRUPTED" });
    await writeFile(
      join(projects.researchDir(projectId), "target-profile.json"),
      JSON.stringify({ schemaVersion: 99, dimensions: {} }),
      "utf8",
    );
    await expect(profile.get(projectId)).rejects.toThrow(/损坏/);
  });

  it("freshness 三键：revision / 指纹（exclude）/ 提取器版本 → stale；ensureCurrent 显式重建", async () => {
    const { projects, projectId, benchmark, profile } = await setupTargetHarness(SIX_PAPERS, { roots });
    await profile.generate(projectId);
    expect((await profile.get(projectId))?.fresh).toBe(true);

    // 1) revision 变化（refresh）
    const refreshed = await benchmark.refresh(projectId, { target: TARGET, papers: papersOf(SIX_PAPERS) });
    expect(refreshed.revision).toBe(1);
    let envelope = await profile.get(projectId);
    expect(envelope?.fresh).toBe(false);
    expect(envelope?.staleReason).toBe("benchmark_revision_changed");

    // ensureCurrent 重建 → 新鲜；已新鲜 → 不重建
    const ensured = await profile.ensureCurrent(projectId);
    expect(ensured.regenerated).toBe(true);
    expect(ensured.profile.benchmarkRevision).toBe(1);
    expect((await profile.get(projectId))?.fresh).toBe(true);
    expect((await profile.ensureCurrent(projectId)).regenerated).toBe(false);

    // 2) 指纹变化（同 revision exclude——有效语料变）
    await benchmark.exclude(projectId, "P006", "测试剔除");
    envelope = await profile.get(projectId);
    expect(envelope?.fresh).toBe(false);
    expect(envelope?.staleReason).toBe("corpus_fingerprint_changed");

    // 3) 提取器版本不匹配（手改 extractorSchemaVersion）
    await profile.ensureCurrent(projectId);
    const rawPath = join(projects.researchDir(projectId), "target-profile.json");
    const raw = JSON.parse(await readFile(rawPath, "utf8")) as Record<string, unknown>;
    await writeFile(rawPath, JSON.stringify({ ...raw, extractorSchemaVersion: 999 }), "utf8");
    envelope = await profile.get(projectId);
    expect(envelope?.fresh).toBe(false);
    expect(envelope?.staleReason).toBe("extractor_schema_version_changed");
  });
});

describe("TargetProfileService（A7）bounded LLM 摘要（method/writing）", () => {
  it("摘要成功：两维 available + provenance.model/modelSummarizedFields 标注", async () => {
    const model = scriptedModel([VALID_SUMMARY_JSON]);
    const { projectId, profile } = await setupTargetHarness(SIX_PAPERS, { summaryModel: model, roots });
    const artifact = await profile.generate(projectId);
    expect(artifact.dimensions.method.availability).toBe("available");
    expect(artifact.dimensions.method.depthNote).toContain("目标带论文");
    expect(artifact.dimensions.writing.availability).toBe("available");
    expect(artifact.provenance.model).toBe("fake-text-model@test");
    expect(artifact.provenance.modelSummarizedFields).toContain("dimensions.method.depthNote");
  });

  it("首次违约 → 1 次 repair 成功（恰好两次调用）", async () => {
    const model = scriptedModel(["这不是 JSON", VALID_SUMMARY_JSON]);
    const { projectId, profile } = await setupTargetHarness(SIX_PAPERS, { summaryModel: model, roots });
    const artifact = await profile.generate(projectId);
    expect(model.callCount()).toBe(2);
    expect(artifact.dimensions.method.availability).toBe("available");
  });

  it("repair 仍失败 → 两维 UNAVAILABLE + summaryFailure（确定性维度不受影响）", async () => {
    const model = scriptedModel(["still not json"]);
    const { projectId, profile } = await setupTargetHarness(SIX_PAPERS, { summaryModel: model, roots });
    const artifact = await profile.generate(projectId);
    expect(model.callCount()).toBe(2); // 有界：至多 1 次 repair
    expect(artifact.dimensions.method.availability).toBe("unavailable");
    expect(artifact.dimensions.method.reason).toContain("模型摘要失败");
    expect(artifact.dimensions.writing.availability).toBe("unavailable");
    expect(artifact.provenance.summaryFailure).toContain("repair");
    expect(artifact.dimensions.structure.totalLengthWords).toBeDefined(); // 确定性主轴不受影响
  });

  it("未配置 summaryModel → 两维 UNAVAILABLE（注明未配置，不伪造）", async () => {
    const { projectId, profile } = await setupTargetHarness(SIX_PAPERS, { roots });
    const artifact = await profile.generate(projectId);
    expect(artifact.dimensions.method.availability).toBe("unavailable");
    expect(artifact.dimensions.method.reason).toContain("摘要模型未配置");
    expect(artifact.provenance.modelSummarizedFields).toEqual([]);
  });

  it("摘要输入零论文原文（反抄袭红线）：prompt 只含聚合统计", async () => {
    const captured: string[] = [];
    const caller: TargetModelCaller = {
      async completeSimple(_model, context) {
        const first = (context.messages[0] as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
        captured.push(first);
        return { content: [{ type: "text", text: VALID_SUMMARY_JSON }], stopReason: "stop" };
      },
    };
    const { projectId, profile } = await setupTargetHarness(SIX_PAPERS, {
      summaryModel: { caller, catalogEntry: {}, spec: "captured@test" },
      roots,
    });
    await profile.generate(projectId);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("章节模式");
    // fixture 正文词元 w0..wN / 参考文献句式不得进入摘要输入
    expect(captured[0]).not.toMatch(/\bw1500\b/);
    expect(captured[0]).not.toContain("Title about things");
  });
});
