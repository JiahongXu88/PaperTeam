/**
 * M12 Batch 2 Smoke B：Multimodal Review live smoke。
 *
 * 运行：
 *   PAPERTEAM_LIVE_SMOKE=1 npx vitest run test/vision/visualReviewLive.smoke.test.ts
 * 默认跳过。确定性路径不依赖任何模型（真实 fixture 手稿 → 真实 findings）；
 * vision 路径按当前部署真实解析（settings 的 visionModel / 默认模型经 Pi 目录
 * input 元数据判定）：可用 → 真实视觉理解调用；不可用 → capability 报告原因码
 * + 四项 vision 检查 skipped（绝不宣称全部通过）。两种结局都是合法 smoke 结论，
 * 断言只锁定「如实」而非「vision 必须可用」。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { loadConfig } from "../../src/config/config.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelSettingsStore, resolveStartupModelSpec } from "../../src/settings/ModelSettingsStore.js";
import { buildVisualReviewService } from "../../src/vision/VisualReviewService.js";
import { resolveVisionModel } from "../../src/vision/capabilities.js";

const live = process.env["PAPERTEAM_LIVE_SMOKE"] === "1";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** 真实 PNG 图片资产（200×120 渐变图；Z.AI 拒收 1×1 退化图 code 1210，故用真实图） */
const REAL_PNG_PATH = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "manuscript",
  "visual-review-sample",
  "tiny-chart.png",
);

describe.skipIf(!live)("M12 Batch 2 Smoke B：visual review（fixture 手稿 + 部署真实 vision 能力解析）", () => {
  it(
    "确定性 findings 全量 + vision 路径按部署能力如实运行/降级",
    { timeout: 300_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "paperteam-smokeb-"));
      roots.push(root);
      const projects = new ProjectStore({ root });
      const project = await projects.create("Smoke B visual review live");
      const projectId = project.id;

      // fixture 手稿：Agent B 的 visual-review-sample（数值冲突/题注不符/未解析引用断言面）
      // + 追加一个真实 PNG figure（vision 路径需要 PNG/JPEG 资产；PDF 资产按设计跳过）
      const manuscriptDir = projects.manuscriptDir(projectId);
      await mkdir(join(manuscriptDir, "figs"), { recursive: true });
      const fixtureTex = await readFile(
        join(import.meta.dirname, "..", "fixtures", "manuscript", "visual-review-sample", "main.tex"),
        "utf8",
      );
      const pngFigure = [
        "",
        "% live smoke 追加：真实 PNG figure（完整规范：caption/label/引用齐全 → 不新增确定性 finding）",
        "As illustrated in Figure~\\ref{fig:tiny-png}, the pipeline is end-to-end.",
        "\\begin{figure}[t]",
        "  \\includegraphics[width=0.4\\linewidth]{figs/tiny.png}",
        "  \\caption{A gradient test chart from blue to red.}",
        "  \\label{fig:tiny-png}",
        "\\end{figure}",
        "",
      ].join("\n");
      await writeFile(
        join(manuscriptDir, "main.tex"),
        fixtureTex.replace("\\end{document}", `${pngFigure}\\end{document}`),
        "utf8",
      );
      await writeFile(join(manuscriptDir, "figs", "overview.pdf"), Buffer.from("%PDF-1.4\n%%EOF\n"));
      await writeFile(join(manuscriptDir, "figs", "tiny.png"), await readFile(REAL_PNG_PATH));

      // 真实 Pi Runtime + 真实 settings（与生产同路径：loadConfig 的 runtimeRoot；
      // visionModel / defaultModel / auth 都按当前部署真实解析——live smoke 语义）
      const config = loadConfig();
      const modelRuntime = await ModelRuntime.create({
        authPath: join(config.pi.agentDir, "auth.json"),
        modelsPath: join(config.pi.agentDir, "models.json"),
      });
      const modelSettingsStore = new ModelSettingsStore({
        settingsDir: join(config.runtimeRoot, "settings"),
      });
      const defaultModel = await resolveStartupModelSpec(undefined, modelSettingsStore);
      const stored = await modelSettingsStore.load();

      const service = buildVisualReviewService({
        projects,
        modelRuntime,
        modelCandidates: () => ({
          visionModel: stored.visionModel,
          defaultModel,
        }),
        log: () => {},
      });
      const report = await service.runVisualReview({ projectId });

      // 1) 确定性路径恒运行：fixture 断言面（Agent B 锁定 = 恰 5 条确定性 findings；
      // vision 可用时另有模型观察 findings（数量随模型输出而变——只断言来源与状态约束）
      const deterministicFindings = report.findings.filter(
        (finding) => finding.source === "deterministic-visual",
      );
      expect(deterministicFindings.length).toBe(5);
      expect(report.findings.every((finding) => finding.category === "visual")).toBe(true);
      expect(
        report.findings
          .filter((finding) => finding.source === "vision-assisted")
          .every(
            (finding) =>
              finding.verificationStatus === "model_observation" ||
              finding.verificationStatus === "needs_author_review",
          ),
      ).toBe(true);
      // 数值冲突 finding 可追溯到具体表格锚
      const numeric = report.findings.find((finding) => finding.message.includes("76.3") ?? false);
      expect(numeric ?? report.findings.find((f) => f.figureEnvRef?.includes("table"))).toBeTruthy();
      // 确定性检查组状态：有 finding 的检查如实 finding
      const deterministic = report.checks.filter((check) => check.kind === "deterministic");
      expect(deterministic.some((check) => check.status === "finding")).toBe(true);

      console.log(
        "[smoke-b] capability:",
        JSON.stringify({
          visionAvailable: report.capability.visionAvailable,
          modelSpec: report.capability.modelSpec,
          completed: report.capability.visionFiguresCompleted,
          failed: report.capability.visionFiguresFailed,
          usage: report.capability.usage,
        }),
      );
      // 2) vision 路径：按部署真实能力如实（两种结局都合法，断言只锁诚实性）
      const selection = resolveVisionModel(modelRuntime, {
        visionModel: stored.visionModel,
        defaultModel,
      });
      if (report.capability.visionAvailable) {
        // vision 真实运行：四项 vision 检查不得全 skipped；产物不得宣称 verified
        expect(selection.available).toBe(true);
        const visionChecks = report.checks.filter((check) => check.kind === "vision");
        expect(visionChecks.some((check) => check.status !== "skipped")).toBe(true);
        expect(
          report.findings.every(
            (finding) =>
              finding.verificationStatus === undefined ||
              finding.verificationStatus === "model_observation" ||
              finding.verificationStatus === "needs_author_review" ||
              finding.verificationStatus === "verified_deterministic",
          ),
        ).toBe(true);
      } else {
        // 部署降级（当前 GLM-5.3 主模型文本-only 的预期常态）：原因码 + 四项全 skipped
        expect(selection.available).toBe(false);
        expect(report.capability.skippedChecks.length).toBe(4);
        expect(report.capability.reason ?? "").not.toBe("");
        // 绝不出现「全部视觉检查通过」的伪 PASS：skipped 状态如实保留
        expect(
          report.checks.filter((check) => check.kind === "vision" && check.status === "skipped").length,
        ).toBe(4);
      }

      // 3) 持久化往返：runForProject 落盘 + latest 可读
      const persisted = await service.runForProject(projectId);
      expect(persisted.round).toBe(1);
      expect(
        persisted.findings.filter((finding) => finding.source === "deterministic-visual").length,
      ).toBe(5);
      const latest = await service.latestVisualReview(projectId);
      expect(latest?.round).toBe(1);
      expect(
        latest?.findings.filter((finding) => finding.source === "deterministic-visual").length,
      ).toBe(5);
    },
  );
});
