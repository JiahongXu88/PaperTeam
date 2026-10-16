/**
 * M14.3 真实学术材料端到端验收（env 门控：PAPERTEAM_M143_RUN=1；默认跳过，不进 CI）。
 *
 * 运行（服务器）：
 *   PAPERTEAM_M143_RUN=1 \
 *   PAPERTEAM_M143_INPUTS_DIR=/data/paperteam-m14-3/generation-inputs \
 *   PAPERTEAM_M143_PROJECTS_ROOT=/data/paperteam-m14-3/projects-caseA \
 *   PAPERTEAM_M143_LOG_DIR=/data/paperteam-m14-3/logs \
 *   PAPERTEAM_M143_DOCLING_PYTHON=/data/paperteam-m14-3/docling-python.sh \
 *   PAPERTEAM_M143_RUNTIME_ROOT=/data/paperteam-m14-2/runtime \
 *   npx vitest run test/thesis/m143RealRun.e2e.test.ts --testTimeout=14400000
 *
 * 真实链路：真实 PDF（范登平 4 篇开放小论文 / 李谨杰 CDC 论文）→ 真实 docling
 * 解析 → ResearchInput 登记 → thesis_from_papers 全工作流（真实模型：贡献提取 /
 * 主线大纲 / 分章写作 / Review / Revision / Gate）→ 真实 xelatex Draft PDF。
 *
 * 隔离纪律：本驱动只读 generation-inputs/；heldout 学位论文从不进入任何生成
 * 上下文（ISOLATION_MANIFEST.json）。
 *
 * 作者决定以 actor=test_fixture 模拟（testStack 显式开启；产物标记第三方公开
 * 案例研究验证 Draft）。冲突裁决策略（确定性）：采纳较新论文一侧的数值
 * （CVPR19 > IJCAI18 > ECCV18 > ICCV17），并记录完整台账。
 *
 * 重新附着：PAPERTEAM_M143_PROJECT_ID / PAPERTEAM_M143_RUN_ID 指向既有项目与
 * run 时跳过创建/导入，直接进入轮询循环（断点恢复由引擎 checkpoint 承担）。
 *
 * M14.5（案例 B 真实验收）增补：
 * - 案例 B 书目元数据修正（M14.3 的 B 规格曾写错标题/作者——指向了另一篇 arXiv 论文）；
 * - 预算：PAPERTEAM_M143_MAX_MODEL_CALLS / PAPERTEAM_M143_MAX_RUN_TOKENS → run 级
 *   RunBudgetLedgerRuntime（M14.4，planner 优雅降级）；PAPERTEAM_M143_GLOBAL_LEDGER +
 *   PAPERTEAM_M143_GLOBAL_MAX_CALLS / PAPERTEAM_M143_GLOBAL_MAX_TOKENS → 跨实验统一总
 *   预算（任务 §8.2：单 run 账本不能约束多次实验合计；本驱动在 adapter 之下按文件
 *   账本硬拦截，重启不重置、失败重试不获新额度、所有 run/smoke 共享同一账本）；
 * - PAPERTEAM_M143_AUTHOR_DECISION_POLICY=pause：到达 hitl.author_decision 时不自动
 *   替作者决定，以 awaiting_input 合法暂停收尾（AUTHOR_DECISION_REQUIRED 终态）；
 *   之后以 PROJECT_ID/RUN_ID 重新附着 + 默认策略即可验证 Resume；
 * - 报告增加 stageResults / HITL awaiting payload / run 账本 / 全局账本快照。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { registerStoredCustomProviders } from "../../src/settings/ModelSettingsService.js";
import { ModelSettingsStore, resolveStartupModelSpec } from "../../src/settings/ModelSettingsStore.js";
import { DoclingParser } from "../../src/ingestion/DoclingParser.js";
import { LegacyPdfTextParser } from "../../src/ingestion/LegacyPdfTextParser.js";
import { PyMuPdfParser } from "../../src/paper/PdfParser.js";
import { GlobalBudgetLedger } from "../helpers/globalBudgetLedger.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

const live = process.env["PAPERTEAM_M143_RUN"] === "1";
const caseId = process.env["PAPERTEAM_M143_CASE"] ?? "A";

interface CaseSpec {
  caseId: "A" | "B";
  title: string;
  documentType: "doctoral_thesis" | "master_thesis";
  inputs: Array<{
    file: string;
    inputType: "published_paper";
    title: string;
    authors: string[];
    arxivId?: string;
    doi?: string;
    versionLabel: string;
    publicationStatus: "published";
    provenanceUri: string;
    /** 冲突裁决优先级（大者新；用于确定性 adopt 选择） */
    recency: number;
  }>;
}

/** 案例材料元数据：全部为公开可核验的书目事实（标题/作者/会议/arXiv id） */
function caseSpec(id: "A" | "B"): CaseSpec {
  if (id === "A") {
    return {
      caseId: "A",
      title: "M14.3 案例A 范登平研究成果学位论文（第三方公开案例研究验证 Draft）",
      documentType: "doctoral_thesis",
      inputs: [
        {
          file: "Fan2017_Smeasure_ICCV_arXiv1708.00786.pdf",
          inputType: "published_paper",
          title: "Structure-measure: A New Way to Evaluate Foreground Maps",
          authors: ["Deng-Ping Fan", "Ming-Ming Cheng", "Yun Liu", "Tao Li", "Ali Borji"],
          arxivId: "1708.00786",
          versionLabel: "arXiv 1708.00786",
          publicationStatus: "published",
          provenanceUri: "https://arxiv.org/abs/1708.00786",
          recency: 2017,
        },
        {
          file: "Fan2018_SOC_ECCV_arXiv1803.06091.pdf",
          inputType: "published_paper",
          title: "Salient Objects in Clutter: Bringing Salient Object Detection to the Foreground",
          authors: ["Deng-Ping Fan", "Ming-Ming Cheng", "Yun Liu", "Shang-Hua Gao", "Qibin Hou", "Ali Borji"],
          arxivId: "1803.06091",
          versionLabel: "arXiv 1803.06091",
          publicationStatus: "published",
          provenanceUri: "https://arxiv.org/abs/1803.06091",
          recency: 2018,
        },
        {
          file: "Fan2018_Emeasure_IJCAI_arXiv1805.10421.pdf",
          inputType: "published_paper",
          title: "Enhanced-Alignment Measure for Binary Foreground Map Evaluation",
          authors: ["Deng-Ping Fan", "Cheng Gong", "Yun Liu", "Ming-Ming Cheng", "Ali Borji"],
          arxivId: "1805.10421",
          versionLabel: "arXiv 1805.10421",
          publicationStatus: "published",
          provenanceUri: "https://arxiv.org/abs/1805.10421",
          recency: 2018,
        },
        {
          file: "Fan2019_VideoSOD_CVPR2019.pdf",
          inputType: "published_paper",
          title: "Shifting More Attention to Video Salient Object Detection",
          authors: ["Deng-Ping Fan", "Wenguan Wang", "Ming-Ming Cheng", "Jianbing Shen"],
          versionLabel: "CVF open access camera-ready",
          publicationStatus: "published",
          provenanceUri: "https://openaccess.thecvf.com/content_CVPR_2019/papers/Fan_Shifting_More_Attention_to_Video_Salient_Object_Detection_CVPR_2019_paper.pdf",
          recency: 2019,
        },
      ],
    };
  }
  // M14.5：书目元数据以 arXiv 2304.07794v2 首页与 Crossref DOI 为准（M14.3 的 B 规格
  // 曾误写为另一篇论文的标题/作者；案例 B 在 M14.3 未实际运行，故未暴露）
  return {
    caseId: "B",
    title: "案例B 李谨杰研究成果学位论文（第三方公开案例研究验证 Draft）",
    documentType: "master_thesis",
    inputs: [
      {
        file: "Li2023_NDP_NMPC_CDC_arXiv2304.07794v2.pdf",
        inputType: "published_paper",
        title: "Nonlinear MPC for Quadrotors in Close-Proximity Flight with Neural Network Downwash Prediction",
        authors: ["Jinjie Li", "Liang Han", "Haoyang Yu", "Yuheng Lin", "Qingdong Li", "Zhang Ren"],
        arxivId: "2304.07794",
        doi: "10.1109/CDC49753.2023.10383632",
        versionLabel: "arXiv 2304.07794v2（IEEE CDC 2023 发表；学位论文答辩时为 Submitted）",
        publicationStatus: "published",
        provenanceUri: "https://arxiv.org/abs/2304.07794",
        recency: 2023,
      },
    ],
  };
}

interface RunReport {
  caseId: string;
  projectId?: string;
  runId?: string;
  startedAt: string;
  finishedAt?: string;
  wallMs?: number;
  inputs: Array<{ file: string; sourceId?: string; inputId?: string; blocks?: number; tables?: number; pages?: number; facts?: number }>;
  hitlDecisions: Array<{ at: string; stageId: string; decision: string; payload: Record<string, unknown>; awaitingPayload?: unknown }>;
  stageTimeline: Array<{ at: string; event: string; stageId?: string; detail?: string }>;
  finalStatus?: string;
  /** M14.5：合法暂停（AUTHOR_DECISION_REQUIRED 等）时记录停在哪个 HITL 与其 payload */
  pausedAt?: { stageId: string; payload?: unknown };
  gate?: Record<string, unknown>;
  stageResults?: Record<string, unknown>;
  draftArtifact?: Record<string, unknown>;
  usageTotals?: Record<string, unknown>;
  modelCalls?: number;
  /** M14.5：run 级账本（research/model-ledger.json）与跨实验全局账本快照 */
  runModelLedger?: unknown;
  globalBudget?: unknown;
  budgetConfig?: Record<string, unknown>;
  error?: string;
}

describe.skipIf(!live)(`M14.3 真实材料端到端（案例 ${caseId}）`, () => {
  it("真实 PDF → thesis_from_papers 全工作流 → Draft PDF", { timeout: 14_400_000 }, async () => {
    const spec = caseSpec(caseId === "B" ? "B" : "A");
    const inputsDir = process.env["PAPERTEAM_M143_INPUTS_DIR"] ?? "/data/paperteam-m14-3/generation-inputs";
    const projectsRoot = process.env["PAPERTEAM_M143_PROJECTS_ROOT"] ?? `/data/paperteam-m14-3/projects-case${spec.caseId}`;
    const logDir = process.env["PAPERTEAM_M143_LOG_DIR"] ?? "/data/paperteam-m14-3/logs";
    const doclingPython = process.env["PAPERTEAM_M143_DOCLING_PYTHON"] ?? "/data/paperteam-m14-3/docling-python.sh";
    const runtimeRoot =
      process.env["PAPERTEAM_M143_RUNTIME_ROOT"] ?? join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? tmpdir(), ".paperteam");
    const report: RunReport = { caseId: spec.caseId, startedAt: new Date().toISOString(), inputs: [], hitlDecisions: [], stageTimeline: [] };
    const mark = (event: string, detail?: string, stageId?: string) => {
      report.stageTimeline.push({ at: new Date().toISOString(), event, ...(stageId !== undefined ? { stageId } : {}), ...(detail !== undefined ? { detail } : {}) });
    };

    // ---- 真实模型 runtime（凭据隔离目录；不打印密钥） ----
    const agentDir = join(runtimeRoot, "runtime", "pi", "agent");
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const customProviderStore = new CustomProviderStore({ settingsDir: join(runtimeRoot, "settings") });
    await registerStoredCustomProviders(modelRuntime, customProviderStore, () => {});
    const startupSpec = await resolveStartupModelSpec(
      process.env["PAPERTEAM_M143_MODEL"],
      new ModelSettingsStore({ settingsDir: join(runtimeRoot, "settings") }),
    );
    expect(startupSpec).toBeDefined();
    const adapter = new PiRuntimeAdapter({
      modelSpec: startupSpec!,
      agentDir,
      // 生产语义：reviewer 等带文件工具的 agent 以 <workspaceRoot>/<projectId>
      // 为工作区（Round 1 实测 tmpdir 会让 reviewer 看到空稿件 → 幻觉 finding）
      workspaceRoot: projectsRoot,
      runTimeoutMs: 900_000,
      modelRuntime,
    });
    report.modelCalls = 0;
    const usageTotals: Record<string, number> = {
      runs: 0, runsWithUsage: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0, assistantTurns: 0,
    };
    // ---- M14.5 预算（任务 §8）：run 级（RunBudgetLedgerRuntime）+ 跨实验全局（文件账本）----
    const perRunMaxCalls = Number(process.env["PAPERTEAM_M143_MAX_MODEL_CALLS"] ?? "0");
    const perRunMaxTokens = Number(process.env["PAPERTEAM_M143_MAX_RUN_TOKENS"] ?? "0");
    const globalLedgerPath = process.env["PAPERTEAM_M143_GLOBAL_LEDGER"];
    const globalMaxCalls = Number(process.env["PAPERTEAM_M143_GLOBAL_MAX_CALLS"] ?? "0");
    const globalMaxTokens = Number(process.env["PAPERTEAM_M143_GLOBAL_MAX_TOKENS"] ?? "0");
    const experimentId = process.env["PAPERTEAM_M143_EXPERIMENT_ID"] ?? `m143-case${spec.caseId}-${report.startedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    const globalLedger = globalLedgerPath !== undefined
      ? new GlobalBudgetLedger(globalLedgerPath, experimentId, { maxCalls: globalMaxCalls, maxTokens: globalMaxTokens })
      : undefined;
    report.budgetConfig = {
      experimentId,
      perRun: { maxModelCallsPerRun: perRunMaxCalls, maxRunTokensPerRun: perRunMaxTokens },
      global: globalLedger !== undefined ? { path: globalLedgerPath, maxCalls: globalMaxCalls, maxTokens: globalMaxTokens } : null,
      model: startupSpec,
    };
    type UsageShape = Partial<Record<"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "estimatedCost" | "assistantTurns", number>>;
    const accountUsage = (usage: UsageShape | undefined) => {
      usageTotals["runs"] = (usageTotals["runs"] ?? 0) + 1;
      if (usage !== undefined) {
        usageTotals["runsWithUsage"] = (usageTotals["runsWithUsage"] ?? 0) + 1;
        for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "estimatedCost", "assistantTurns"] as const) {
          usageTotals[key] = (usageTotals[key] ?? 0) + (usage[key] ?? 0);
        }
      }
      globalLedger?.chargeUsage(usage);
    };
    // PiRuntimeAdapter.runAgent 内部经 this.startAgent（不经 Proxy）——两个入口都拦截
    // 不会重复计数；业务服务全部走 runAgent，startAgent 分支为直调兜底。
    const countingAdapter = new Proxy(adapter, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "runAgent" && typeof value === "function") {
          return async (...args: unknown[]) => {
            globalLedger?.chargeCall(); // 超限抛 MODEL_BUDGET_EXCEEDED（启动前）
            report.modelCalls = (report.modelCalls ?? 0) + 1;
            mark("model-call", `#${report.modelCalls}`);
            const task = (await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)) as { usage?: UsageShape };
            accountUsage(task?.usage);
            return task;
          };
        }
        if (prop === "startAgent" && typeof value === "function") {
          return async (...args: unknown[]) => {
            globalLedger?.chargeCall();
            report.modelCalls = (report.modelCalls ?? 0) + 1;
            mark("model-call", `#${report.modelCalls}（startAgent）`);
            const handle = (await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)) as { result: () => Promise<{ usage?: UsageShape }> };
            void handle.result().then((task) => accountUsage(task?.usage), () => accountUsage(undefined));
            return handle;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    // ---- 真实栈：真实 docling（容器 wrapper）+ 真实 pymupdf 回退 + 真实 LaTeX ----
    const stack: TestStack = await startTestStack(countingAdapter as unknown as typeof adapter, {
      realLatex: true,
      root: projectsRoot,
      stageBudget: { timeoutMs: 900_000, maxAttempts: 3 },
      // M14.5：run 级模型预算由 RunBudgetLedgerRuntime 硬性执行（planner 优雅降级 → Draft）
      ...(perRunMaxCalls > 0 || perRunMaxTokens > 0
        ? { runBudget: { maxModelCallsPerRun: perRunMaxCalls, maxRunTokensPerRun: perRunMaxTokens } }
        : {}),
      ingestion: {
        structuredParser: new DoclingParser({ pythonCommand: doclingPython, timeoutMs: 600_000 }),
        fallbackParser: new LegacyPdfTextParser({ pdfParser: new PyMuPdfParser({}) }),
      },
    });

    try {
      // ---- 项目与材料导入（reattach 时跳过） ----
      let projectId = process.env["PAPERTEAM_M143_PROJECT_ID"];
      let runId = process.env["PAPERTEAM_M143_RUN_ID"];
      const recencyByInputId = new Map<string, number>();

      if (projectId === undefined) {
        const created = await stack.request("POST", "/api/projects", { title: spec.title, language: "zh", documentType: spec.documentType });
        expect(created.status).toBe(201);
        projectId = (created.body["project"] as { id: string })["id"];
        report.projectId = projectId;
        mark("project-created", projectId);

        for (const input of spec.inputs) {
          const bytes = await readFile(join(inputsDir, input.file));
          const upload = await stack.request("POST", `/api/projects/${projectId}/sources`, {
            fileName: input.file,
            contentBase64: bytes.toString("base64"),
          });
          expect(upload.status).toBeLessThan(300);
          const sourceId = (upload.body["source"] as { sourceId: string })["sourceId"];
          mark("source-uploaded", `${input.file} → ${sourceId}`);

          // 等待后台 docling 解析完成（每篇 30–180s；轮询 15min 上限）
          const deadline = Date.now() + 900_000;
          let parsed = false;
          while (Date.now() < deadline) {
            const doc = await stack.request("GET", `/api/projects/${projectId}/sources/${sourceId}/document`);
            const body = doc.body["document"] as { status?: string; pageCount?: number; blockCount?: number; tableCount?: number } | null;
            if (doc.status === 200 && body !== null && (body.status === "ok" || body.status === "failed")) {
              if (body.status === "failed") throw new Error(`docling 解析失败：${input.file}`);
              parsed = true;
              report.inputs.push({
                file: input.file,
                sourceId,
                blocks: body.blockCount,
                tables: body.tableCount,
                pages: body.pageCount,
              });
              mark("docling-parsed", `${input.file}: ${body.blockCount} blocks / ${body.tableCount} tables / ${body.pageCount}p`);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5_000));
          }
          if (!parsed) throw new Error(`docling 解析超时：${input.file}`);

          const registered = await stack.request("POST", `/api/projects/${projectId}/research-inputs`, {
            sourceId,
            inputType: input.inputType,
            title: input.title,
            authors: input.authors,
            provenanceUri: input.provenanceUri,
            ...(input.arxivId !== undefined ? { arxivId: input.arxivId } : {}),
            ...(input.doi !== undefined ? { doi: input.doi } : {}),
            versionLabel: input.versionLabel,
            publicationStatus: { value: input.publicationStatus },
          });
          expect(registered.status).toBeLessThan(300);
          const inputId = (registered.body["input"] as { inputId: string })["inputId"];
          recencyByInputId.set(inputId, input.recency);
          report.inputs[report.inputs.length - 1]!.inputId = inputId;
          mark("research-input-registered", `${input.file} → ${inputId}`);
        }
      } else {
        report.projectId = projectId;
        mark("reattach-project", projectId);
        for (const input of spec.inputs) {
          const list = await stack.request("GET", `/api/projects/${projectId}/research-inputs`);
          const match = (list.body["inputs"] as Array<{ inputId: string; title: string }> | undefined)?.find(
            (item) => item.title === input.title,
          );
          if (match !== undefined) recencyByInputId.set(match.inputId, input.recency);
        }
      }

      // ---- 启动工作流（reattach 时复用 runId） ----
      if (runId === undefined) {
        const start = await stack.request("POST", `/api/projects/${projectId}/workflows`, { kind: "thesis_from_papers" });
        expect(start.status).toBe(202);
        runId = start.body["runId"] as string;
      }
      report.runId = runId;
      mark("workflow-started", runId);

      // ---- 主循环：轮询 → HITL 决策（确定性策略）→ 终态 ----
      const deadline = Date.now() + Number(process.env["PAPERTEAM_M143_LOOP_HOURS"] ?? "12") * 3_600_000;
      const authorDecisionPolicy = process.env["PAPERTEAM_M143_AUTHOR_DECISION_POLICY"] === "pause" ? "pause" : "write_as_limitation";
      // M14.5：在任意 HITL 节点合法暂停（进程退出 → 以 PROJECT_ID/RUN_ID 重新附着验证 checkpoint 恢复与 Resume）
      const pauseAt = process.env["PAPERTEAM_M143_PAUSE_AT"];
      let lastStage: string | undefined;
      let factsConfirmed = false;
      for (;;) {
        const runBody = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as {
          status: string;
          currentStage?: string;
          awaiting?: { stageId: string; payload?: Record<string, unknown> };
          error?: { code?: string; message?: string; stageId?: string };
        };
        if (runBody.currentStage !== undefined && runBody.currentStage !== lastStage) {
          lastStage = runBody.currentStage;
          mark("stage-enter", undefined, runBody.currentStage);
        }
        if (runBody.status === "awaiting_input" && runBody.awaiting !== undefined) {
          const { stageId, payload } = runBody.awaiting;
          // M14.5：缺材料作者决定不自动代答（policy=pause）→ 以合法暂停收尾（AUTHOR_DECISION_REQUIRED）
          if ((stageId === "hitl.author_decision" && authorDecisionPolicy === "pause") || (pauseAt !== undefined && stageId === pauseAt)) {
            report.pausedAt = { stageId, payload };
            report.finalStatus = "awaiting_input";
            mark("paused-legally", `${stageId}（${stageId === pauseAt ? "PAUSE_AT" : "policy=pause；不替作者决定"}）`, stageId);
            break;
          }
          const decisionRecord = await decideAndResume(stack, runId, projectId!, stageId, payload, {
            recencyByInputId,
            factsConfirmedRef: () => factsConfirmed,
            markFactsConfirmed: () => { factsConfirmed = true; },
            mark,
            authorizeTables: Number(process.env["PAPERTEAM_M143_AUTHORIZE_TABLES"] ?? "0"),
          });
          report.hitlDecisions.push({ ...decisionRecord, awaitingPayload: payload });
          continue;
        }
        if (runBody.status === "completed" || runBody.status === "failed" || runBody.status === "cancelled") {
          report.finalStatus = runBody.status;
          if (runBody.status !== "completed") {
            report.error = `${runBody.error?.code ?? ""} ${runBody.error?.message ?? ""}（stage ${runBody.error?.stageId ?? "?"}）`;
          }
          break;
        }
        if (Date.now() > deadline) {
          report.error = `主循环超时（status=${runBody.status}, stage=${runBody.currentStage}）`;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }

      // ---- 终局采集：gate / Draft 产物 / usage ----
      const finalRun = ((await stack.request("GET", `/api/runs/${runId}`)).body["run"] ?? {}) as {
        status: string;
        stageResults?: Record<string, unknown>;
      };
      const gateResult = finalRun.stageResults?.["quality.gate"];
      if (gateResult !== undefined) report.gate = gateResult as Record<string, unknown>;
      report.stageResults = finalRun.stageResults ?? {};
      try {
        report.runModelLedger = JSON.parse(await readFile(join(projectsRoot, projectId!, "research", "model-ledger.json"), "utf8"));
      } catch {
        report.runModelLedger = null;
      }
      report.globalBudget = globalLedger?.snapshot() ?? null;
      const artifacts = await stack.request("GET", `/api/projects/${projectId}/artifacts`);
      // M14.5 修正：产物清单字段是 artifactId（ArtifactStore 契约），旧驱动读 item.id 永远 undefined
      //（M14.3 三轮都未走到这条断言——R3 人工编译——所以从未暴露）
      const drafts = (artifacts.body["artifacts"] as Array<Record<string, unknown>> | undefined)?.filter(
        (item) => {
          const id = item["artifactId"] ?? item["id"];
          return typeof id === "string" && id.startsWith("art-draft");
        },
      );
      if (drafts !== undefined && drafts.length > 0) report.draftArtifact = drafts[drafts.length - 1];
      report.usageTotals = usageTotals;
      report.finishedAt = new Date().toISOString();
      report.wallMs = Date.now() - Date.parse(report.startedAt);
      await mkdir(logDir, { recursive: true });
      await writeFile(join(logDir, `m143-case${spec.caseId}-report-${experimentId}.json`), JSON.stringify(report, null, 2), "utf8");

      if (report.finalStatus === "awaiting_input") {
        // 合法暂停终态（AUTHOR_DECISION_REQUIRED）：不是失败，也不冒充 Draft
        expect(report.pausedAt).toBeDefined();
      } else {
        expect(report.finalStatus).toBe("completed");
        expect(report.draftArtifact).toBeDefined();
      }
      mark("acceptance-done", JSON.stringify({ status: report.finalStatus, draft: report.draftArtifact?.["id"], pausedAt: report.pausedAt?.stageId }));
    } finally {
      await adapter.close().catch(() => undefined);
    }
  });
});

/** HITL 决策策略（确定性；全部 actor=test_fixture，台账可审计） */
async function decideAndResume(
  stack: TestStack,
  runId: string,
  projectId: string,
  stageId: string,
  payload: Record<string, unknown> | undefined,
  helpers: {
    recencyByInputId: Map<string, number>;
    factsConfirmedRef: () => boolean;
    markFactsConfirmed: () => void;
    mark: (event: string, detail?: string, stage?: string) => void;
    /** M14.3 继承表格：事实确认后授权前 N 张候选（0 = 不授权） */
    authorizeTables: number;
  },
): Promise<{ at: string; stageId: string; decision: string; payload: Record<string, unknown> }> {
  const body: Record<string, unknown> = {};
  let decision: string;

  if (stageId === "hitl.scope_and_version") {
    const proposed = (payload?.["inputs"] as { proposed?: Array<{ inputId: string }> } | undefined)?.proposed ?? [];
    const pending = (payload?.["pendingDecisions"] as Array<{ type: string; subject: string }> | undefined) ?? [];
    const contributions = (payload?.["contributions"] as Array<{ id: string; status: string }> | undefined) ?? [];
    const unconfirmed = contributions.filter((item) => item.status === "proposed").map((item) => item.id);
    if (proposed.length > 0) {
      decision = "include";
      Object.assign(body, { inputId: proposed[0]!.inputId });
    } else {
      const unpublished = pending.find((item) => item.type === "unpublished_material_policy");
      if (unpublished !== undefined) {
        decision = "allow_unpublished";
        Object.assign(body, { inputId: unpublished.subject });
      } else {
        // 事实确认（HTTP 决策端点）：核心实验数值进入 authorConfirmed 白名单。
        // 幂等：重复确认同一事实集合不会改写状态。
        if (!helpers.factsConfirmedRef()) {
          const included = (payload?.["inputs"] as { included?: Array<{ inputId: string }> } | undefined)?.included ?? [];
          let confirmed = 0;
          for (const input of included) {
            const factsResponse = await stack.request("GET", `/api/projects/${projectId}/research-inputs/facts?inputId=${input.inputId}`);
            const facts = (factsResponse.body["facts"] as Array<{ factId: string; verification?: { status?: string; sourceCheck?: string } }> | undefined) ?? [];
            // 只确认已通过文本层核验的事实（extracted-only 不冒充作者确认）
            const verified = facts.filter((f) => f.verification?.["sourceCheck"] === "verified").map((f) => f.factId);
            if (verified.length > 0) {
              const decisionResponse = await stack.request("POST", `/api/projects/${projectId}/research-inputs/decisions`, {
                actor: { kind: "test_fixture", note: "M14.3 真实材料验收：模拟作者确认已核验事实" },
                payload: { type: "fact_confirmation", factIds: verified, outcome: "confirmed" },
              });
              expect(decisionResponse.status).toBeLessThan(300);
              confirmed += verified.length;
            }
          }
          helpers.markFactsConfirmed();
          helpers.mark("facts-confirmed", `${confirmed} verified facts`);
          // M14.3 继承表格：候选只对 scope=included 的输入构建（M14.5 发现旧驱动在工作流
          // 启动前刷新 → 输入尚未入选 → 0 候选 → 从未授权）；现移到入选 + 事实确认之后。
          if (helpers.authorizeTables > 0) {
            const refresh = await stack.request("POST", `/api/projects/${projectId}/research-inputs/table-assets`);
            expect(refresh.status).toBeLessThan(300);
            const assets = (refresh.body["assets"] as Array<{
              assetId: string;
              status: string;
              captionZh: string;
              verification: { verifiedCells: number };
            }>) ?? [];
            const candidates = assets
              .filter((asset) => asset.status === "candidate")
              .sort((a, b) => b.verification.verifiedCells - a.verification.verifiedCells);
            let authorized = 0;
            for (const asset of candidates.slice(0, helpers.authorizeTables)) {
              const decisionResponse = await stack.request("POST", `/api/projects/${projectId}/research-inputs/decisions`, {
                actor: { kind: "test_fixture", note: "真实材料验收：模拟作者授权表格继承" },
                payload: { type: "table_inheritance", assetId: asset.assetId, outcome: "authorized" },
              });
              expect(decisionResponse.status).toBeLessThan(300);
              authorized += 1;
            }
            helpers.mark("table-assets-authorized", `${authorized}/${candidates.length} candidates`);
          }
        }
        if (unconfirmed.length > 0) {
          decision = "confirm_contribution";
          Object.assign(body, { contributionIds: unconfirmed });
        } else {
          decision = "approve";
        }
      }
    }
  } else if (stageId === "hitl.fact_conflicts") {
    // 冲突裁决：采纳较新论文一侧（确定性 recency 策略）。
    // awaiting payload 的 parties 不带 researchInputId —— 从 conflicts API 取完整双方。
    const conflictsResponse = await stack.request("GET", `/api/projects/${projectId}/research-inputs/conflicts`);
    const conflicts = (conflictsResponse.body["conflicts"] as Array<{
      conflictId: string;
      status?: string;
      parties?: Array<{ factId: string; researchInputId: string; raw: string; location: string }>;
    }> | undefined) ?? [];
    const unresolved = conflicts.filter((item) => (item.status ?? "unresolved") === "unresolved");
    if (unresolved.length > 0) {
      const conflict = unresolved[0]!;
      const parties = conflict.parties ?? [];
      // 采纳 recency 最大的论文一侧；并列时取先出现者（确定性）
      let chosen = parties[0];
      for (const party of parties.slice(1)) {
        const recency = helpers.recencyByInputId.get(party.researchInputId) ?? 0;
        const best = helpers.recencyByInputId.get(chosen?.researchInputId ?? "") ?? 0;
        if (recency > best) chosen = party;
      }
      decision = "adopt_fact";
      Object.assign(body, { conflictId: conflict.conflictId, ...(chosen !== undefined ? { adoptedFactId: chosen.factId } : {}), rationale: "M14.3 确定性策略：采纳较新论文数值" });
    } else {
      decision = "approve";
    }
  } else if (stageId === "hitl.outline_confirm") {
    decision = "approve";
  } else if (stageId === "hitl.author_decision") {
    const missing = (payload?.["missingChapters"] as Array<{ chapterId: string }> | undefined) ?? [];
    if (missing.length > 0) {
      decision = "write_as_limitation";
      Object.assign(body, { subject: missing[0]!.chapterId, rationale: "M14.3 验收：材料不足章按限制口径撰写" });
    } else {
      decision = "approve";
    }
  } else if (stageId === "hitl.revision_validation" || stageId === "hitl.revision_stalled" || stageId === "hitl.revision_overflow") {
    // M14.4 修正：stalled 的合法选项是 accept_draft / revise_more / cancel——
    // 旧驱动答 "approve" 会被 applyStalledDecision 400 拒绝（R3 期间不收敛决策
    // 无法自动落地，只能人工介入）。确定性验收策略 = 接受当前稿为 Draft。
    decision = stageId === "hitl.revision_overflow" || stageId === "hitl.revision_stalled" ? "accept_draft" : "approve";
  } else if (stageId === "hitl.style_polish") {
    // M14.3 验收不做语言润色轮（保留建议不应用；科研事实路径已由 review/revision 覆盖）
    decision = "skip";
  } else {
    throw new Error(`未预期的 HITL 阶段：${stageId}`);
  }

  Object.assign(body, { actorKind: "test_fixture" });
  const resume = await stack.request("POST", `/api/runs/${runId}/resume`, { decision, payload: body });
  if (resume.status >= 300) {
    throw new Error(`resume 失败（${stageId}/${decision} → ${resume.status}）：${JSON.stringify(resume.body).slice(0, 400)}`);
  }
  // M14.5：重复 Resume 幂等探针（任务 §七.8）——同一待办已被回答后再次提交必须被状态机拒绝
  //（不产生第二次决定、不推进第二次）；只在显式开启时执行，结果进入 report。
  if (process.env["PAPERTEAM_M143_PROBE_DUPLICATE_RESUME"] === "1") {
    const duplicate = await stack.request("POST", `/api/runs/${runId}/resume`, { decision, payload: body });
    helpers.mark("duplicate-resume-probe", `${stageId}/${decision} → HTTP ${duplicate.status} ${JSON.stringify(duplicate.body).slice(0, 160)}`, stageId);
  }
  return { at: new Date().toISOString(), stageId, decision, payload: body };
}
