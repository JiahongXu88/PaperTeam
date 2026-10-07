/**
 * M12 Batch 2 · B3：VisualReviewService 集成（scripted，零网络零真实模型）。
 *
 * 覆盖：
 * - 确定性-only 降级（无 modelRuntime）：capability 报告 + 四项 vision 检查
 *   skipped + 确定性检查全量运行 + 绝不声称「全部通过」；
 * - 有 runtime 但能力不可用（目录无 image 声明）→ 结构化原因码降级；
 * - scripted vision 可用流：ScriptedVisionRuntime 四项检查 → findings 三种
 *   verdict 映射（inconsistent → model_observation / unclear → needs_author_review）；
 * - 模型输出持续非法 → failed 诚实记录（无无限重试、不抛异常）；
 * - runForProject 落盘 / latestVisualReview 读回 / round 递增；
 * - 生成图（PDF 资产）vision 跳过原因如实呈现。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ScriptedVisionRuntime } from "../../src/vision/scriptedVisionRuntime.js";
import {
  buildVisualReviewService,
  VISUAL_VISION_CHECK_IDS,
  type VisualReviewService,
} from "../../src/vision/VisualReviewService.js";
import type { VisionModelRuntime } from "../../src/vision/types.js";

const NOW = new Date("2026-10-07T10:00:00.000Z");
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const TEX = [
  "\\section{Experiments}",
  "MOT tracklet achieves a MOTA of 76.3 as shown in Table~\\ref{tab:main}.",
  "\\begin{figure}[t]",
  "  \\caption{Overall architecture of the tracker.}",
  "  \\label{fig:overview}",
  "  \\includegraphics{figs/overview.png}",
  "\\end{figure}",
  "\\begin{table}[t]",
  "  \\caption{Main results on the benchmark.}",
  "  \\label{tab:main}",
  "  \\begin{tabular}{lcc}",
  "    Method & MOTA & IDS \\\\",
  "    MOT tracklet & 78.2 & 101 \\\\",
  "  \\end{tabular}",
  "\\end{table}",
].join("\n");

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(manuscriptMainTex?: string): Promise<{ service: VisualReviewService; projects: ProjectStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-vr-"));
  roots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("visual review test");
  if (manuscriptMainTex !== undefined) {
    await mkdir(projects.manuscriptDir(project.id), { recursive: true });
    await writeFile(join(projects.manuscriptDir(project.id), "main.tex"), manuscriptMainTex, "utf8");
  }
  const service = buildVisualReviewService({ projects, now: () => NOW });
  return { service, projects, projectId: project.id };
}

const TEX_INPUT = { texFiles: [{ file: "main.tex", content: TEX }] };

describe("M12 B3 VisualReviewService：确定性-only 降级（一等路径）", () => {
  it("无 modelRuntime：确定性检查全量 + 四项 vision 检查 skipped + capability 报告如实", async () => {
    const { service, projectId } = await makeProject();
    const report = await service.runVisualReview({ projectId, ...TEX_INPUT });

    expect(report.capability.visionAvailable).toBe(false);
    expect(report.capability.reason).toBe("not_configured");
    expect(report.capability.skippedChecks).toEqual([...VISUAL_VISION_CHECK_IDS]);
    // 确定性六项检查全部执行（非 skipped）
    const deterministic = report.checks.filter((check) => check.kind === "deterministic");
    expect(deterministic.map((check) => check.checkId).sort()).toEqual(
      [
        "caption-reference-mismatch",
        "duplicate-label",
        "label-ref-resolution",
        "missing-caption",
        "table-text-numeric",
        "unreferenced-artifact",
      ].sort(),
    );
    // vision 四项检查全部 skipped 且带原因说明
    const visionChecks = report.checks.filter((check) => check.kind === "vision");
    expect(visionChecks).toHaveLength(4);
    for (const check of visionChecks) {
      expect(check.status).toBe("skipped");
      expect(check.detail).toContain("vision 不可用");
    }
    // 确定性 finding 存在（数值冲突）；vision finding 为零
    const sources = new Set(report.findings.map((finding) => finding.source));
    expect(sources.has("deterministic-visual")).toBe(true);
    expect(report.findings.every((finding) => finding.source !== "vision-assisted")).toBe(true);
    // 报告无任何「全部通过」断言：降级由 capability + skipped 显式呈现
    expect(JSON.stringify(report)).not.toContain("allPassed");
    expect(JSON.stringify(report)).not.toContain("全部通过");
  });

  it("有 runtime 但目录未声明 image → no_vision_model 结构化降级", async () => {
    const textOnlyRuntime: VisionModelRuntime = {
      getModel: () => ({ input: ["text"] }),
      hasConfiguredAuth: () => true,
      async completeSimple() {
        throw new Error("不应被调用（能力判定必须前置）");
      },
    };
    const root = await mkdtemp(join(tmpdir(), "paperteam-vr-"));
    roots.push(root);
    const projects = new ProjectStore({ root });
    const project = await projects.create("text-only model");
    const service = buildVisualReviewService({
      projects,
      modelRuntime: textOnlyRuntime,
      modelCandidates: () => ({ visionModel: "zai/glm-5.3" }),
      now: () => NOW,
    });
    const report = await service.runVisualReview({ projectId: project.id, ...TEX_INPUT });
    expect(report.capability.visionAvailable).toBe(false);
    expect(report.capability.reason).toBe("no_vision_model");
    expect(report.capability.detail).toContain("image");
    expect(report.checks.filter((check) => check.kind === "vision").every((check) => check.status === "skipped")).toBe(true);
  });
});

describe("M12 B3 VisualReviewService：scripted vision 可用流", () => {
  async function scriptedService() {
    const root = await mkdtemp(join(tmpdir(), "paperteam-vr-"));
    roots.push(root);
    const projects = new ProjectStore({ root });
    const project = await projects.create("scripted vision");
    const runtime = new ScriptedVisionRuntime({ now: () => NOW });
    const service = buildVisualReviewService({
      projects,
      modelRuntime: runtime,
      modelCandidates: () => ({ visionModel: "test/vision-model" }),
      now: () => NOW,
    });
    return { service, projectId: project.id, runtime };
  }

  it("PNG 资产 figure：四项检查 → 三种 verdict 映射（inconsistent/consistent/unclear）", async () => {
    const { service, projectId, runtime } = await scriptedService();
    const report = await service.runVisualReview({
      projectId,
      ...TEX_INPUT,
      figureAssetBytes: new Map([["tex:main.tex:figure-1", PNG_1X1]]),
    });

    // 模型真的被调用了一次（图片随消息发送）
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.hasImage).toBe(true);
    expect(runtime.calls[0]?.promptText).toContain("四项一致性检查");
    expect(runtime.calls[0]?.promptText).toContain("tex:main.tex:figure-1");
    expect(runtime.calls[0]?.promptText).toContain("Overall architecture of the tracker.");

    expect(report.capability.visionAvailable).toBe(true);
    expect(report.capability.modelSpec).toBe("test/vision-model");
    expect(report.capability.visionFiguresCompleted).toBe(1);
    expect(report.capability.visionFiguresFailed).toBe(0);
    expect(report.capability.skippedChecks).toEqual([]);

    // verdict 映射：inconsistent → major + model_observation；unclear → info + needs_author_review
    const visionFindings = report.findings.filter((finding) => finding.source === "vision-assisted");
    expect(visionFindings).toHaveLength(2);
    const inconsistent = visionFindings.find((f) => f.findingId.endsWith("figure-caption-consistency"));
    expect(inconsistent).toMatchObject({
      category: "visual",
      severity: "major",
      figureEnvRef: "tex:main.tex:figure-1",
      visualConfidence: "high",
      verificationStatus: "model_observation",
    });
    expect(inconsistent?.message).toContain("未经自动核验");
    const unclear = visionFindings.find((f) => f.findingId.endsWith("legend-axis-consistency"));
    expect(unclear).toMatchObject({ severity: "info", verificationStatus: "needs_author_review" });

    // 检查项聚合：caption/legend → finding；claim/diagram → passed
    const statusOf = (checkId: string) => report.checks.find((c) => c.checkId === checkId)?.status;
    expect(statusOf("figure-caption-consistency")).toBe("finding");
    expect(statusOf("figure-claim-consistency")).toBe("passed");
    expect(statusOf("legend-axis-consistency")).toBe("finding");
    expect(statusOf("diagram-method-consistency")).toBe("passed");

    // 确定性检查与 vision 检查共存；usage 聚合如实
    expect(report.capability.usage).toMatchObject({ inputTokens: 1024, outputTokens: 256 });
    // 确定性数值冲突仍在（vision 不取代确定性）
    expect(report.findings.some((f) => f.source === "deterministic-visual" && f.findingId.includes("table-text-numeric"))).toBe(true);
  });

  it("无资产的 figure：skippedFigures 如实记录，不调用模型", async () => {
    const { service, projectId, runtime } = await scriptedService();
    const report = await service.runVisualReview({ projectId, ...TEX_INPUT });
    expect(runtime.calls).toHaveLength(0);
    expect(report.capability.visionFiguresCompleted).toBe(0);
    expect(report.capability.skippedFigures).toEqual([
      { visualArtifactId: "tex:main.tex:figure-1", reason: expect.stringContaining("读取失败") },
    ]);
    expect(report.checks.filter((check) => check.kind === "vision").every((c) => c.status === "skipped")).toBe(true);
  });

  it("生成图（PDF 资产）：跳过原因 = 非 PNG/JPEG，不调用模型", async () => {
    const { service, projectId, runtime } = await scriptedService();
    const report = await service.runVisualReview({
      projectId,
      ...TEX_INPUT,
      generatedFigures: [
        {
          figId: "fig-abc123def456",
          kind: "plot",
          caption: "训练曲线。",
          assetRef: "figs/generated/fig-abc123def456.pdf",
          createdAt: NOW.toISOString(),
        },
      ],
    });
    expect(runtime.calls).toHaveLength(0);
    // latex figure（资产不在盘）与生成图（PDF 资产）都被如实跳过
    expect(report.capability.skippedFigures).toEqual([
      { visualArtifactId: "tex:main.tex:figure-1", reason: expect.stringContaining("读取失败") },
      { visualArtifactId: "gen:fig-abc123def456", reason: expect.stringContaining("PDF") },
    ]);
    expect(report.inputs.generatedFigureIds).toEqual(["fig-abc123def456"]);
    expect(report.artifacts.bySourceKind).toMatchObject({ latex_env: 2, generated: 1 });
    expect(report.checks.filter((check) => check.kind === "vision").every((check) => check.status === "skipped")).toBe(true);
  });

  it("模型输出持续非法：failed 诚实记录（1 次 repair 后不再重试，不抛异常，不产生 finding）", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-vr-"));
    roots.push(root);
    const projects = new ProjectStore({ root });
    const project = await projects.create("garbage model");
    let calls = 0;
    const garbageRuntime: VisionModelRuntime = {
      getModel: () => ({ input: ["text", "image"] }),
      hasConfiguredAuth: () => true,
      async completeSimple() {
        calls += 1;
        return { content: [{ type: "text", text: "这不是 JSON" }], stopReason: "stop" };
      },
    };
    const service = buildVisualReviewService({
      projects,
      modelRuntime: garbageRuntime,
      modelCandidates: () => ({ visionModel: "test/garbage" }),
      now: () => NOW,
      requestTimeoutMs: 5_000,
    });
    const report = await service.runVisualReview({
      projectId: project.id,
      ...TEX_INPUT,
      figureAssetBytes: new Map([["tex:main.tex:figure-1", PNG_1X1]]),
    });
    // 首次 + 1 次 repair = 恰 2 次调用（无无限重试）
    expect(calls).toBe(2);
    expect(report.capability.visionFiguresFailed).toBe(1);
    expect(report.capability.visionFiguresCompleted).toBe(0);
    expect(report.findings.filter((f) => f.source === "vision-assisted")).toHaveLength(0);
    expect(report.checks.filter((check) => check.kind === "vision").every((check) => check.status === "failed")).toBe(true);
  });
});

describe("M12 B3 VisualReviewService：runForProject 落盘与读回", () => {
  it("manuscript/main.tex 真实磁盘链：runForProject → r1 落盘 + latestVisualReview 等价 + 二轮 r2", async () => {
    const { service, projects, projectId } = await makeProject(TEX);
    const first = await service.runForProject(projectId);
    expect(first.round).toBe(1);
    expect(first.reportPath).toBe("reviews/visual-review-r1.json");
    // inventory 同步落盘（derived 随评审重建）
    const inventoryRaw = JSON.parse(
      await readFile(join(projects.researchDir(projectId), "manuscript-visuals.json"), "utf8"),
    );
    expect(inventoryRaw.files[0]?.tables).toHaveLength(1);

    const latest = await service.latestVisualReview(projectId);
    expect(latest).not.toBeNull();
    expect(latest?.round).toBe(1);
    expect(latest?.findings).toEqual(first.findings);
    expect(latest?.capability.visionAvailable).toBe(false);

    const second = await service.runForProject(projectId);
    expect(second.round).toBe(2);
    expect(await service.latestVisualReview(projectId)).toMatchObject({ round: 2 });
  });

  it("无 manuscript 项目：latex 侧如实跳过（notes），不抛异常", async () => {
    const { service, projectId } = await makeProject();
    const report = await service.runForProject(projectId);
    expect(report.inputs.texFiles).toEqual([]);
    expect(report.notes.join("\n")).toContain("未收集到 .tex 文件");
    expect(report.findings).toHaveLength(0);
    expect(report.checks.find((c) => c.checkId === "label-ref-resolution")?.status).toBe("skipped");
  });
});
