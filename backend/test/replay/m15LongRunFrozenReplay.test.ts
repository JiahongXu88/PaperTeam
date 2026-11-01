/**
 * M15 长程 C3：冻结真实作者稿的零模型回放（环境门控：PAPERTEAM_M15_FROZEN_REPLAY_OUT=<输出目录>）。
 *
 * 只读源：D:\PaperTeamData 下的冻结项目；回放前整体复制到输出目录下的全新 projects 根，源目录不写。
 * 对每个项目：手动 POST /quality-gate（与 workflow 同一 evaluateProjectQualityGate，零模型）→ 落盘分层报告；
 * 反事实：删除被审修订快照 / 引用核验报告后重评——必须不可冻结（缺核验工件不得 PASS）。
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";
import type { QualityReport } from "../../src/quality/qualityReport.js";

vi.setConfig({ testTimeout: 600_000 });

const OUT = process.env["PAPERTEAM_M15_FROZEN_REPLAY_OUT"];
const DATA = process.env["PAPERTEAM_DATA_ROOT"] ?? "D:\\PaperTeamData";
const SOURCES: Array<{ label: string; id: string; dir: string }> = [
  { label: "MOT R5.1 长篇中文作者稿", id: "p-e6770bf79fed", dir: join(DATA, "MOT_PaperTeam_R5_1_Acceptance", "workflow", "projects", "p-e6770bf79fed") },
  { label: "M15.19 E1 PDF 重建作者稿", id: "p-b6a2677fdf05", dir: join(DATA, "M15", "M15_19", "e2e-stack", "p-b6a2677fdf05") },
];

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

function compact(report: QualityReport) {
  return {
    overall: report.overall,
    binding: report.binding,
    layers: Object.fromEntries(Object.entries(report.layers).map(([id, layer]) => [id, {
      status: layer.status,
      blocking: layer.blocking,
      unknowns: layer.unknowns,
      items: layer.items.map((item) => ({ id: item.id, status: item.status, required: item.required, grade: item.evidenceGrade, detail: item.detail.slice(0, 400) })),
    }])),
    compat: report.compat,
    externalValidity: report.externalValidity,
  };
}

describe.skipIf(OUT === undefined)("M15 长程 C3：冻结作者稿零模型回放", () => {
  let stack: TestStack;
  const results: Record<string, unknown> = {};

  it("复制冻结项目到全新根（源只读）", async () => {
    const root = join(OUT!, "projects");
    if (existsSync(root)) throw new Error(`输出根已存在（不覆盖既有回放）：${root}`);
    await mkdir(root, { recursive: true });
    for (const source of SOURCES) {
      if (!existsSync(source.dir)) throw new Error(`冻结源不存在：${source.dir}`);
      await cp(source.dir, join(root, source.id), { recursive: true });
    }
    stack = await startTestStack(scriptedIdeaRuntime().runtime, { root, registerCleanup: (cleanup) => cleanups.push(cleanup) });
  });

  for (const source of SOURCES) {
    it(`${source.label}：分层报告可追踪已审 / 未知；移除核验工件后不可冻结`, async () => {
      const evaluate = async () => {
        const response = await stack.request("POST", `/api/projects/${source.id}/quality-gate`);
        expect(response.status, JSON.stringify(response.body).slice(0, 400)).toBe(200);
        return response.body["qualityReport"] as QualityReport;
      };
      const baseline = await evaluate();
      expect(baseline.schemaVersion).toBe("quality-report/v1");
      expect(baseline.layers.L4.status).toBe("UNVALIDATED");
      const reviewed = baseline.binding.reviewedRevision;

      const projectDir = stack.store.projectDir(source.id);
      // 反事实 1：被审修订快照缺失 → 跨节一致性输入不存在 → 必需未评估
      const counterfactuals: Record<string, unknown> = {};
      if (reviewed !== null) {
        await rm(join(projectDir, "manuscript", "revisions", `rev-${reviewed}`), { recursive: true, force: true });
        const noSnapshot = await evaluate();
        counterfactuals["snapshot_removed"] = compact(noSnapshot);
        expect(noSnapshot.overall.finalizable).toBe(false);
        expect(noSnapshot.layers.L1.items.find((item) => item.id === "cross_section_numeric_consistency")).toMatchObject({ status: "NOT_EVALUATED", required: true });
      }
      // 反事实 2：引用核验报告缺失 → 虚构引用检查必需未评估
      await rm(join(projectDir, "reviews", "citation-report.json"), { force: true });
      const noCitation = await evaluate();
      counterfactuals["citation_report_removed"] = compact(noCitation);
      expect(noCitation.overall.finalizable).toBe(false);
      expect(noCitation.layers.L1.items.find((item) => item.id === "hallucinated_citations_zero")?.status).toBe("NOT_EVALUATED");

      results[source.id] = { label: source.label, source: source.dir, baseline: compact(baseline), counterfactuals };
      await writeFile(join(OUT!, `frozen-replay-${source.id}.json`), JSON.stringify(results[source.id], null, 2), "utf8");
    });
  }
});
