/**
 * M10.2 Live Vision smoke（真实 Vision-capable 模型；环境门控）。
 *
 * 门控：PAPERTEAM_VISION_LIVE=1 才运行（CI / 默认 npm test 跳过——自动
 * 化单测不依赖 live model）。模型规格：PAPERTEAM_VISION_LIVE_MODEL
 * （缺省 zai-coding-cn/glm-4.6v——本机 Pi 目录中声明 image input 且凭据
 * 就绪的 Vision 模型；能力判定仍走 catalog input 元数据，不硬编码信任）。
 *
 * 链路（§24）：standalone PNG / PDF 抽取 figure（真实 docling）/
 * Notebook 图片输出 → 真实模型调用 → schema 合法 + provenance 正确 +
 * 结果落盘 + 值可读性（宽松断言：真实输出不要求逐词一致）。
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../../src/config/config.js";
import { applyEnvFile, findEnvFile } from "../../src/config/envFile.js";
import { DoclingParser } from "../../src/ingestion/DoclingParser.js";
import { VisionAnalysisService } from "../../src/vision/VisionAnalysisService.js";
import { FigureAnalysisStore } from "../../src/vision/FigureAnalysisStore.js";
import { ParsedDocumentStore } from "../../src/ingestion/ParsedDocumentStore.js";
import { IngestionService } from "../../src/ingestion/IngestionService.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { resolveVisionModel } from "../../src/vision/capabilities.js";
import type { FigureAnalysis, VisionModelRuntime } from "../../src/vision/types.js";

const live = process.env["PAPERTEAM_VISION_LIVE"] === "1";
describe.skipIf(!live)("M10.2 live vision smoke（真实模型）", () => {
  const liveModelSpec = process.env["PAPERTEAM_VISION_LIVE_MODEL"]?.trim() || "zai-coding-cn/glm-4.6v";

  let root: string;
  let projects: ProjectStore;
  let sources: SourceStore;
  let ingestion: IngestionService;
  let vision: VisionAnalysisService;
  let modelRuntime: ModelRuntime;
  let fixtures: Record<string, string>;
  let projectId: string;
  const outputs: string[] = [];

  beforeAll(async () => {
    // .env 补缺（与 evaluation liveRuntime 同法；真实环境变量优先）
    const here = fileURLToPath(new URL("../../", import.meta.url));
    for (const candidate of [resolve(process.cwd(), ".env"), resolve(here, ".env"), resolve(here, "../.env")]) {
      const envFile = findEnvFile([candidate]);
      if (envFile !== null) {
        applyEnvFile(process.env, envFile.values);
        break;
      }
    }
    const config = loadConfig();
    modelRuntime = await ModelRuntime.create({
      authPath: join(config.pi.agentDir, "auth.json"),
      modelsPath: join(config.pi.agentDir, "models.json"),
    });

    root = await mkdtemp(join(tmpdir(), "paperteam-vision-live-"));
    projects = new ProjectStore({ root });
    const project = await projects.create("vision live smoke");
    projectId = project.id;
    sources = new SourceStore(projects);
    const evidence = new EvidenceStore(projects);
    const documents = new ParsedDocumentStore(projects);
    ingestion = new IngestionService({
      projects,
      sources,
      documents,
      structuredParser: new DoclingParser({
        ...(config.pdf.doclingPythonCommand !== undefined
          ? { pythonCommand: config.pdf.doclingPythonCommand }
          : {}),
        log: () => {},
      }),
      evidence,
      log: () => {},
    });
    const analyses = new FigureAnalysisStore(projects);
    vision = new VisionAnalysisService({
      projects,
      sources,
      documents,
      analyses,
      ingestion,
      evidence,
      modelRuntime: modelRuntime as unknown as VisionModelRuntime,
      modelCandidates: () => ({ visionModel: liveModelSpec }),
      log: () => {},
    });

    // deterministic fixtures（PyMuPDF 真实图表）
    const fixturesDir = join(root, "fixtures");
    const script = fileURLToPath(new URL("../../../scripts/gen_m10_2_fixtures.py", import.meta.url));
    const gen = spawn("python", [script, fixturesDir], { stdio: ["ignore", "pipe", "pipe"] });
    let genError = "";
    gen.stderr.on("data", (chunk) => (genError += chunk));
    const code = await new Promise<number>((resolveCode) => gen.on("close", resolveCode));
    if (code !== 0) {
      throw new Error(`fixtures 生成失败：${genError.slice(0, 400)}`);
    }
    fixtures = {
      lineChart: join(fixturesDir, "line-chart.png"),
      barChart: join(fixturesDir, "bar-chart.png"),
      samplePdf: join(fixturesDir, "sample.pdf"),
    };
  }, 600_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    for (const line of outputs) {
      console.log(line);
    }
  });

  it("capability 解析：目录确认 image input + 凭据就绪", () => {
    const selection = resolveVisionModel(modelRuntime as unknown as VisionModelRuntime, {
      visionModel: liveModelSpec,
    });
    expect(selection.available).toBe(true);
    if (selection.available) {
      outputs.push(`[vision-live] model=${selection.modelSpec} source=${selection.source}`);
    }
  });

  it(
    "链路 A：standalone PNG（真实折线图）→ 真实分析 → 值可读",
    async () => {
      const png = await readFile(fixtures["lineChart"]!);
      const { source } = await sources.add(projectId, {
        fileName: "line-chart.png",
        content: png,
      });
      await ingestion.ingest(projectId, source.sourceId);
      const result = await vision.analyze(projectId, source.sourceId);
      const figure = result.status.figures[0]!;
      expect(figure.status).toBe("completed");
      const analysis = (await new FigureAnalysisStore(projects).load(projectId, source.sourceId))!
        .analyses[0] as FigureAnalysis;
      expect(analysis.description?.length ?? 0).toBeGreaterThan(20);
      outputs.push(`[vision-live] A(PNG) figureType=${analysis.figureType}`);
      outputs.push(`[vision-live] A(PNG) description=${(analysis.description ?? "").slice(0, 200)}`);
      for (const fact of analysis.candidateFacts) {
        outputs.push(`[vision-live] A(PNG) fact ${fact.confidence}: ${fact.claim}${fact.value !== undefined ? ` (=${fact.value})` : ""}`);
      }
      // 值可读性（宽松）：图表明确标注 peak 82.4——分析文本应出现 82 或 82.4
      const allText = [
        analysis.description ?? "",
        ...analysis.observations,
        ...analysis.candidateFacts.map((fact) => `${fact.claim} ${fact.value ?? ""}`),
      ].join(" ");
      expect(allText).toMatch(/82(\.4)?/);
      expect(analysis.usage?.totalTokens ?? 0).toBeGreaterThan(0);
    },
    300_000,
  );

  it(
    "链路 B：Notebook 图片输出（真实柱状图）→ 真实分析",
    async () => {
      const bar = await readFile(fixtures["barChart"]!);
      const notebook = {
        cells: [
          { cell_type: "markdown", id: "i", metadata: {}, source: ["# bar chart"] },
          {
            cell_type: "code",
            id: "b",
            metadata: {},
            execution_count: 1,
            source: ["plt.show()"],
            outputs: [
              {
                output_type: "execute_result",
                execution_count: 1,
                metadata: {},
                data: { "image/png": bar.toString("base64") },
              },
            ],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      };
      const { source } = await sources.add(projectId, {
        fileName: "analysis.ipynb",
        content: Buffer.from(JSON.stringify(notebook)),
      });
      await ingestion.ingest(projectId, source.sourceId);
      const result = await vision.analyze(projectId, source.sourceId);
      const figure = result.status.figures[0]!;
      expect(figure.status).toBe("completed");
      expect(figure.cellIndex).toBe(1);
      const analysis = (await new FigureAnalysisStore(projects).load(projectId, source.sourceId))!
        .analyses[0] as FigureAnalysis;
      outputs.push(`[vision-live] B(notebook) figureType=${analysis.figureType} desc=${(analysis.description ?? "").slice(0, 160)}`);
      // 柱状图 Baseline 78.2 vs Ours 82.4——宽松值断言（78 或 82 任一）
      const allText = [
        analysis.description ?? "",
        ...analysis.observations,
        ...analysis.candidateFacts.map((fact) => `${fact.claim} ${fact.value ?? ""}`),
      ].join(" ");
      expect(allText).toMatch(/7[89](\.\d)?|82(\.4)?/);
    },
    300_000,
  );

  it(
    "链路 C：PDF 抽取 figure（真实 docling）→ 真实分析",
    async () => {
      const pdf = await readFile(fixtures["samplePdf"]!);
      const { source } = await sources.add(projectId, { fileName: "sample.pdf", content: pdf });
      const document = await ingestion.ingest(projectId, source.sourceId);
      expect(document.counts["figure"] ?? 0).toBeGreaterThanOrEqual(1);
      const result = await vision.analyze(projectId, source.sourceId);
      const figure = result.status.figures.find((entry) => entry.status === "completed");
      expect(figure).toBeDefined();
      const analysis = (await new FigureAnalysisStore(projects).load(projectId, source.sourceId))!
        .analyses.find((entry) => entry.status === "completed") as FigureAnalysis;
      outputs.push(
        `[vision-live] C(pdf figure ${analysis.figureBlockId} page=${analysis.provenance.page}) figureType=${analysis.figureType}`,
      );
      outputs.push(`[vision-live] C(pdf) desc=${(analysis.description ?? "").slice(0, 200)}`);
      expect(analysis.provenance.assetName).toMatch(/^fig-\d+\.png$/);
      expect(analysis.description?.length ?? 0).toBeGreaterThan(20);
    },
    600_000,
  );
});
