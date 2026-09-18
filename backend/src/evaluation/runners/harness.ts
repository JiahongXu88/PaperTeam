/**
 * Evaluation Harness（M6.8）：评估栈构建 + 驱动辅助。
 *
 * 两条装配路径（都不 import backend/test——评估代码必须独立于测试代码）：
 * - GroundingHarness（Experiment 1）：最小服务集直连（ProjectStore /
 *   SourceStore / Retrieval / Evidence 候选管道 / 三段核验），Resolver 注入
 *   GroundTruthScholarlyProvider（按 scenario 权威记录裁决 match/mismatch），
 *   judge 注入 GroundTruthJudgeRuntime（按 ground truth 返回 supported /
 *   unsupported——唯一 LLM 阶段的确定性替身）；
 * - WorkflowHarness（Experiment 2/3）：完整 buildServiceStack +
 *   WorkflowOrchestrator（与生产同一条 workflow 引擎），scripted runtime
 *   驱动（含 [fact:mutate] / [cite:drop] / [strength:escalate] 故障标记），
 *   LaTeX 用假 runner（编译恒成功并产出 main.pdf——构建真实性属产品测试
 *   职责，评估不重复）。
 *
 * 所有根目录用 mkdtemp 独立命名空间，评估跑完即删（--keep 可保留取证）。
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  GroundingCorpusSource,
  GroundingScenario,
  RevisionFaultMarker,
  RevisionHitlPolicy,
} from "../types.js";
import { buildServiceStack, type ServiceStack } from "../../serviceStack.js";
import { LatexCompiler, type CommandRunner } from "../../latex/LatexCompiler.js";
import { ProjectStore } from "../../project/ProjectStore.js";
import { SourceStore } from "../../sources/SourceStore.js";
import { ChunkStore } from "../../retrieval/ChunkStore.js";
import { RetrievalService } from "../../retrieval/RetrievalService.js";
import { SourceChunker } from "../../retrieval/SourceChunker.js";
import { EvidenceStore } from "../../evidence/EvidenceStore.js";
import { EvidenceCandidateStore } from "../../evidence/candidates.js";
import { ChunkAccess } from "../../evidence/chunkAccess.js";
import { EvidenceGroundingService } from "../../evidence/EvidenceGroundingService.js";
import { ScholarlyResolver } from "../../citation/scholarly.js";
import type {
  LookupOutcome,
  ProviderContext,
  ScholarlyProvider,
  ScholarlyQuery,
} from "../../citation/scholarly.js";
import type { CanonicalPaperRecord, CitationFieldMismatch } from "../../citation/integrity.js";
import type {
  AgentRunHandle,
  AgentRuntime,
  AgentTask,
  RuntimeHealth,
} from "../../runtime/types.js";
import { createScriptedRuntime } from "../../runtime/scriptedRuntime.js";
import { scriptedRevision } from "../../runtime/scriptedRuntime.js";
import { WorkflowOrchestrator } from "../../workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "../../workflow/runStore.js";
import { createIdeaToPaperDefinition } from "../../workflow/definitions.js";
import type { WorkflowState } from "../../workflow/types.js";
import { extractCitationKeys } from "../../review/styleInvariants.js";

// ============================================================
// 公共：临时根
// ============================================================

export interface HarnessRoot {
  root: string;
  cleanup: () => Promise<void>;
}

export async function createTempRoot(prefix: string): Promise<HarnessRoot> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// ============================================================
// Experiment 1：Grounding 直连栈
// ============================================================

/**
 * Ground-truth scholarly provider（确定性替身，name 借用合法枚举 "crossref"）：
 * 按 scenario 的权威记录比对 query——存储元数据与权威记录冲突（年份错位）
 * → mismatch（带字段明细）；一致 → match；未知标题 → not_found。
 */
class GroundTruthScholarlyProvider implements ScholarlyProvider {
  readonly name = "crossref" as const;
  private readonly byTitle: Map<string, { truth: CanonicalPaperRecord; authoritativeYear?: number }>;

  constructor(corpus: readonly GroundingCorpusSource[]) {
    this.byTitle = new Map(
      corpus.map((source) => [
        normalizeTitleKey(source.title),
        {
          authoritativeYear: source.metadataCorrupted === true ? authoritativeYearOf(source) : undefined,
          truth: {
            provider: "crossref",
            recordId: `ground-truth:${source.fileName}`,
            title: source.title,
            authors: source.authors,
            year: source.metadataCorrupted === true ? authoritativeYearOf(source) : source.year,
            retrievedAt: "2026-09-18T00:00:00Z",
          },
        },
      ]),
    );
  }

  async lookup(query: ScholarlyQuery, _ctx: ProviderContext): Promise<LookupOutcome> {
    const key = normalizeTitleKey(query.title ?? "");
    const entry = key !== "" ? this.byTitle.get(key) : undefined;
    if (entry === undefined) {
      return { kind: "not_found" };
    }
    const mismatches: CitationFieldMismatch[] = [];
    if (
      entry.authoritativeYear !== undefined &&
      query.year !== undefined &&
      query.year !== entry.authoritativeYear
    ) {
      mismatches.push({
        field: "year",
        expected: String(query.year),
        actual: String(entry.authoritativeYear),
        note: "ground-truth: 存储元数据年份与权威记录冲突",
      });
    }
    if (mismatches.length > 0) {
      return { kind: "mismatch", record: entry.truth, mismatches };
    }
    return { kind: "match", record: entry.truth };
  }
}

/**
 * metadataCorrupted 来源的权威年份推导：存储年份 + 校正偏移没有意义，直接
 * 要求场景显式声明（缺省 2024）——校验测试会钉住显式声明。
 */
function authoritativeYearOf(source: GroundingCorpusSource): number {
  return source.authoritativeYear ?? 2024;
}

function normalizeTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
}

/**
 * Ground-truth judge runtime（Stage 3 语义裁决的确定性替身）：prompt 内出现
 * scenario 标注的 unsupported claim 文本 → unsupported 裁决；否则 supported。
 * 只应被 EvidenceGroundingService 以 citation/evidence/* scope 调用。
 */
export function createGroundTruthJudgeRuntime(unsupportedClaims: readonly string[]): AgentRuntime {
  let calls = 0;
  const runtime: AgentRuntime = {
    provider: "pi",
    healthCheck: async (): Promise<RuntimeHealth> => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ground-truth judge（评估确定性替身，不访问模型）",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    runAgent: async (input): Promise<AgentTask> => {
      calls += 1;
      const scope = input.contextScope ?? "";
      let output = JSON.stringify({
        verdict: "supported",
        reason: "ground-truth 裁决：论断被原文支撑（评估确定性输出）",
      });
      if (scope.startsWith("citation/evidence/")) {
        const unsupported = unsupportedClaims.find((claim) => input.task.includes(claim));
        if (unsupported !== undefined) {
          output = JSON.stringify({
            verdict: "unsupported",
            reason: `ground-truth 裁决：论断超出引文支撑范围（${unsupported.slice(0, 40)}…）`,
          });
        }
      }
      const now = new Date().toISOString();
      return {
        taskId: `judge-${calls}`,
        agentId: input.agentId,
        status: "completed",
        createdAt: now,
        updatedAt: now,
        output,
      };
    },
    startAgent: async (input): Promise<AgentRunHandle> => {
      const task = await runtime.runAgent(input);
      return {
        taskId: task.taskId,
        sessionKey: `agent:${input.agentId}:eval-judge`,
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    getTask: async (taskId): Promise<AgentTask> => {
      throw new Error(`not implemented（评估 judge runtime 不支持 getTask：${taskId}）`);
    },
    close: async () => {},
  };
  return runtime;
}

export interface GroundingHarness {
  root: string;
  projectId: string;
  sources: SourceStore;
  retrieval: RetrievalService;
  chunkStore: ChunkStore;
  evidence: EvidenceStore;
  grounding: EvidenceGroundingService;
  /** 添加语料（arm B/C 用；arm A 不加任何来源） */
  addCorpus: (corpus: readonly GroundingCorpusSource[]) => Promise<Map<string, string>>;
  /** 触发索引构建并按 needle 解析 chunkId（quote 锚点） */
  resolveChunkByNeedle: (fileName: string, needle: string) => Promise<{ sourceId: string; chunkId: string }>;
  cleanup: () => Promise<void>;
}

export interface GroundingHarnessOptions {
  /**
   * Stage 3 judge 用的 Runtime（M6.9.1 live 模式注入真实 PiRuntimeAdapter；
   * 缺省 = ground-truth 确定性替身，scripted 路径行为不变）。
   */
  judgeRuntime?: AgentRuntime;
}

export async function createGroundingHarness(
  scenario: GroundingScenario,
  options: GroundingHarnessOptions = {},
): Promise<GroundingHarness> {
  const { root, cleanup } = await createTempRoot("paperteam-eval-g-");
  const projects = new ProjectStore({ root });
  const project = await projects.create(`eval-${scenario.id}`);
  const sources = new SourceStore(projects);
  const chunkStore = new ChunkStore(projects);
  const chunker = new SourceChunker();
  const retrieval = new RetrievalService({ projects, sources, chunker, chunkStore, log: () => {} });
  const evidence = new EvidenceStore(projects);
  const candidates = new EvidenceCandidateStore(projects);
  const chunkAccess = new ChunkAccess({ projects, chunkStore, sources });
  const unsupportedClaims = scenario.faults
    .filter((fault) => fault.faultClass === "unsupported_claim")
    .map((fault) => fault.claim);
  const judgeRuntime = options.judgeRuntime ?? createGroundTruthJudgeRuntime(unsupportedClaims);
  const resolver = new ScholarlyResolver({
    providers: [new GroundTruthScholarlyProvider(scenario.corpus)],
    log: () => {},
  });
  const grounding = new EvidenceGroundingService({
    projects,
    candidates,
    evidence,
    chunkAccess,
    scholarly: resolver,
    runtime: judgeRuntime,
    citationAgentId: "citation",
    log: () => {},
  });

  const fileNameToSourceId = new Map<string, string>();
  const addCorpus = async (corpus: readonly GroundingCorpusSource[]) => {
    for (const item of corpus) {
      const { source } = await sources.add(project.id, {
        fileName: item.fileName,
        content: Buffer.from(item.content, "utf8"),
        metadata: {
          title: item.title,
          year: item.year,
          ...(item.authors !== undefined ? { authors: item.authors } : {}),
        },
      });
      fileNameToSourceId.set(item.fileName, source.sourceId);
    }
    return fileNameToSourceId;
  };

  const resolveChunkByNeedle = async (fileName: string, needle: string) => {
    const sourceId = fileNameToSourceId.get(fileName);
    if (sourceId === undefined) {
      throw new Error(`语料文件未添加：${fileName}`);
    }
    // 触发 lazy 索引构建（ChunkAccess 只读落盘产物）
    await retrieval.search(project.id, fileName, { topK: 1 });
    const chunks = await chunkStore.readChunks(project.id, sourceId);
    const chunk = (chunks ?? []).find((item) => item.text.includes(needle));
    if (chunk === undefined) {
      throw new Error(`needle 未命中任何 chunk（${fileName}）：${needle.slice(0, 60)}…`);
    }
    return { sourceId, chunkId: chunk.chunkId };
  };

  return {
    root,
    projectId: project.id,
    sources,
    retrieval,
    chunkStore,
    evidence,
    grounding,
    addCorpus,
    resolveChunkByNeedle,
    cleanup,
  };
}

// ============================================================
// Experiment 2/3：完整 workflow 栈 + 驱动
// ============================================================

/** 编译恒成功并产出 main.pdf 的假 runner（与 testStack 同形；评估不测编译真实性） */
const fakeSuccessfulRunner: CommandRunner = async (command, args) => {
  if (args.includes("--version")) {
    return { code: 0, stdout: `${command} 1.0`, stderr: "" };
  }
  const outputDir = args.find((arg) => arg.startsWith("-output-directory="));
  if (outputDir) {
    await writeFile(join(outputDir.slice("-output-directory=".length), "main.pdf"), "%PDF-1.5");
  }
  return { code: 0, stdout: "compiled", stderr: "" };
};

export interface WorkflowHarness {
  root: string;
  stack: ServiceStack;
  orchestrator: WorkflowOrchestrator;
  store: ProjectStore;
  runtimeCalls: { agentId: string; contextScope?: string }[];
  cleanup: () => Promise<void>;
}

export async function createWorkflowHarness(options: {
  reviewSequence: ("pass" | "fail" | "fail2" | "fail3")[];
}): Promise<WorkflowHarness> {
  const { root, cleanup } = await createTempRoot("paperteam-eval-w-");
  const store = new ProjectStore({ root });
  const scripted = createScriptedRuntime({ reviewSequence: options.reviewSequence });
  const latex = new LatexCompiler({ timeoutMs: 10_000, runner: fakeSuccessfulRunner });
  const stack = buildServiceStack({
    runtime: scripted.runtime,
    projects: store,
    latex,
    agentIds: { writer: "writer", researcher: "researcher", reviewer: "reviewer", citation: "citation" },
    stageTimeoutMs: 10_000,
    stageMaxAttempts: 2,
    review: { sectionRetryBackoffMs: [0, 0] },
    citation: { metadataEnabled: false, scholarly: { providers: [] } },
    search: {
      disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"],
      providerTimeoutMs: 2_000,
    },
    log: () => {},
  });
  const orchestrator = new WorkflowOrchestrator({
    projects: store,
    runStore: new WorkflowRunStore(store),
    definitionFactory: (kind) => {
      switch (kind) {
        case "idea_to_paper":
          return createIdeaToPaperDefinition(stack.workflowServices);
        default:
          throw new Error(`评估只驱动 idea_to_paper（收到 ${kind}）`);
      }
    },
    retryDelayMs: 0,
    log: () => {},
  });
  return {
    root,
    stack,
    orchestrator,
    store,
    runtimeCalls: scripted.calls,
    cleanup: async () => {
      await orchestrator.close();
      await cleanup();
    },
  };
}

// ---- HITL 驱动 ----

export interface DriveOptions {
  hitlPolicy: RevisionHitlPolicy;
  maxResumes?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface DriveResult {
  run: WorkflowState;
  hitlStages: string[];
  timedOut: boolean;
}

/**
 * 驱动 run 到终态（completed / failed / cancelled）：
 * - hitl.feasibility_confirm / hitl.outline_confirm → approve；
 * - hitl.revision_validation → 策略（默认 reject = 恢复修订前快照的安全缺省）；
 * - hitl.revision_stalled / hitl.revision_overflow → accept_draft（用户知情
 *   接受 Draft——评估记录终态，不冒充 Final）；
 * - 未知 HITL → approve（保守推进）。
 * 超预算 resume 次数即停（timedOut=true，如实上报，不伪造终态）。
 */
export async function driveRunToTerminal(
  harness: WorkflowHarness,
  runId: string,
  options: DriveOptions,
): Promise<DriveResult> {
  const maxResumes = options.maxResumes ?? 40;
  const pollIntervalMs = options.pollIntervalMs ?? 20;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const hitlStages: string[] = [];
  let timedOut = false;
  for (let resumes = 0; ; ) {
    const run = await harness.orchestrator.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return { run, hitlStages, timedOut };
    }
    if (Date.now() > deadline || resumes > maxResumes) {
      timedOut = true;
      return { run, hitlStages, timedOut };
    }
    if (run.status === "awaiting_input" && run.awaiting?.stageId !== undefined) {
      const stageId = run.awaiting.stageId;
      hitlStages.push(stageId);
      const decision = hitlDecisionFor(stageId, options.hitlPolicy);
      await harness.orchestrator.resume(runId, { decision });
      resumes += 1;
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function hitlDecisionFor(stageId: string, policy: RevisionHitlPolicy): string {
  if (stageId === "hitl.revision_validation") {
    return policy;
  }
  if (stageId === "hitl.revision_stalled" || stageId === "hitl.revision_overflow") {
    return "accept_draft";
  }
  return "approve";
}

// ---- 产物读取 ----

export interface ManuscriptSnapshot {
  text: string;
  files: string[];
  citationKeys: string[];
}

export async function readManuscriptSnapshot(root: string, projectId: string): Promise<ManuscriptSnapshot> {
  const sectionsDir = join(root, projectId, "manuscript", "sections");
  let files: string[] = [];
  try {
    files = (await readdir(sectionsDir)).filter((name) => name.endsWith(".tex"));
  } catch {
    return { text: "", files: [], citationKeys: [] };
  }
  const contents: string[] = [];
  for (const name of files) {
    contents.push(await readFile(join(sectionsDir, name), "utf8"));
  }
  const text = contents.join("\n");
  return {
    text,
    files: files.map((name) => `sections/${name}`),
    citationKeys: [...new Set(contents.flatMap((content) => extractCitationKeys(content)))],
  };
}

export interface ValidationRoundSummary {
  round: number;
  blocked: boolean;
  reasonCodes: string[];
}

export async function readRevisionValidations(root: string, projectId: string): Promise<ValidationRoundSummary[]> {
  const dir = join(root, projectId, "reviews");
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const summaries: ValidationRoundSummary[] = [];
  for (const name of names.filter((entry) => /^revision-validation-r\d+\.json$/.test(entry)).sort()) {
    const round = Number.parseInt(name.match(/\d+/)![0]!, 10);
    const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as {
      blocked?: boolean;
      items?: { reasonCodes?: string[] }[];
    };
    const reasonCodes = [
      ...new Set((parsed.items ?? []).flatMap((item) => item.reasonCodes ?? [])),
    ];
    summaries.push({ round, blocked: parsed.blocked === true, reasonCodes });
  }
  return summaries;
}

export interface GateRoundSummary {
  round: number;
  failedRules: string[];
}

export async function readQualityGates(root: string, projectId: string): Promise<GateRoundSummary[]> {
  const dir = join(root, projectId, "reviews");
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const summaries: GateRoundSummary[] = [];
  for (const name of names.filter((entry) => /^quality-gate-r\d+\.json$/.test(entry)).sort()) {
    const round = Number.parseInt(name.match(/\d+/)![0]!, 10);
    const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as {
      gate?: { rules?: { rule: string; passed: boolean }[] };
    };
    summaries.push({
      round,
      failedRules: (parsed.gate?.rules ?? []).filter((rule) => !rule.passed).map((rule) => rule.rule),
    });
  }
  return summaries;
}

// ============================================================
// Experiment 2 baseline：Writer 故障输出物化（与 scriptedRuntime 同源）
// ============================================================

/**
 * baseline 臂（Reviewer → Writer，无计划 / 验证 / 门禁）的「被接受稿件」：
 * 直接复用 src 侧 scriptedRevision（[fact:mutate] / [cite:drop] 的唯一事实源
 * 实现）物化故障修订输出——与 paperteam 臂 workflow 内部走的是同一份注入
 * 代码，两臂只差「有没有安全机制」。
 *
 * currentSection 需与 scripted writing/sections 输出同形（含 \cite / 公式 /
 * 数字）；marker=null 时返回干净修订。
 */
export function materializeWriterFaultOutput(
  marker: RevisionFaultMarker | null,
  currentSection: string,
): string {
  const dropCitations = marker === "cite:drop";
  const mutateFacts = marker === "fact:mutate";
  // 与 scriptedRuntime writing/revision 分支的 prompt 切片协议一致
  const prompt = `===== 修订计划 =====\n（baseline：无计划约束）\n===== 本章节当前内容 =====\n${currentSection}\n===== 修订要求 =====\n按审稿意见修订本章节。`;
  const base = scriptedRevision(prompt, dropCitations, mutateFacts);
  if (marker === "strength:escalate") {
    return `${base}\n\n综上所述，本方法在该任务上的效果显著提升，显著优于现有方法。`;
  }
  return base;
}

/** scripted writing/sections 的章节内容（baseline 场景的「修订前稿件」） */
export function baselineSectionContent(experimentsWithSecondCitation: boolean): string {
  const base = [
    "\\section{章节标题}",
    "",
    "本章节论述基于证据的核心观点 \\cite{gao2023survey}。",
    "检索质量与幻觉率的关系如式 \\eqref{eq:1} 所示。",
    "",
    "\\begin{equation}",
    "  q = \\alpha r + (1-\\alpha) g",
    "\\end{equation}",
  ].join("\n");
  return experimentsWithSecondCitation ? `${base}\n\n开创性工作亦见 \\cite{lewis2020rag}。` : base;
}
