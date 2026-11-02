/**
 * M16 学术审稿有效性：共享 harness（全局调用账本 + 硬上限 120 + 模型适配 + 统计工具）。
 *
 * 账本：<ROOT>\budget\calls.jsonl（append-only；单次 LLM 调用一行，含用途、臂、时长、token）。
 * 生产链路臂的子调用由 c-production.mjs 在运行后逐条补记（purpose = "production/<case>/<scope>"），
 * 运行前用 GlobalBudgetLedger 把该次运行硬限在剩余额度内——两处口径相同，都按物理调用计。
 * 模型：缺省 zai-coding-cn/glm-5.3（= 当前产品 Settings 的 model.json，生产臂同一模型）；凭据只经 Pi agentDir 读取，不打印。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "..", "..");
export const ROOT = "D:\\PaperTeamData\\M16\\AcademicReviewValidity";
export const M15 = "D:\\PaperTeamData\\M15\\TargetJournalAssessment";
export const LEDGER = join(ROOT, "budget", "calls.jsonl");
export const MAX_CALLS = 120;
export const MODEL_SPEC = process.env.M16_MODEL ?? "zai-coding-cn/glm-5.3";

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

export function callsUsed() {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "").length;
}

export function appendLedger(entry) {
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify({ n: callsUsed() + 1, at: new Date().toISOString(), ...entry })}\n`, "utf8");
}

export async function createModel() {
  const { loadConfig } = await import(pathToFileURL(join(REPO, "backend", "dist", "config", "config.js")).href);
  const config = loadConfig();
  const { ModelRuntime } = await import(pathToFileURL(join(REPO, "backend", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
  const runtime = await ModelRuntime.create({ authPath: join(config.pi.agentDir, "auth.json"), modelsPath: join(config.pi.agentDir, "models.json") });
  const [provider, ...rest] = MODEL_SPEC.split("/");
  const entry = runtime.getModel(provider, rest.join("/"));
  if (entry === undefined || entry === null || !runtime.hasConfiguredAuth(provider)) throw new Error(`模型 ${MODEL_SPEC} 未在目录中或未配置凭据`);

  /** 单次调用（先查额度再调用；无论成败都计入账本） */
  async function complete(purpose, systemPrompt, userText, maxTokens = 4000) {
    const used = callsUsed();
    if (used >= MAX_CALLS) throw new Error(`[budget] 已达 ${MAX_CALLS} 次上限（${used}）`);
    const startedAt = Date.now();
    let message;
    let error;
    try {
      message = await runtime.completeSimple(entry, { systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] }, { maxTokens });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const durationMs = Date.now() - startedAt;
    const usage = message?.usage ?? null;
    appendLedger({ purpose, model: MODEL_SPEC, durationMs, usage, ...(error !== undefined ? { error: error.slice(0, 300) } : {}) });
    if (error !== undefined) throw new Error(error);
    const text = (message.content ?? []).filter((part) => part.type === "text" || part.type === undefined).map((part) => part.text ?? "").join("").trim();
    return { text, usage, durationMs };
  }
  return { spec: MODEL_SPEC, complete };
}

/** 从模型输出中取第一个 JSON 对象（宽松：去围栏） */
export function parseJsonObject(text) {
  const stripped = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("无 JSON 对象");
  return JSON.parse(stripped.slice(start, end + 1));
}

/** 证据引文确定性回放（与 M15 TJA 同口径）：去空白 + 小写后的子串匹配（≥ 12 字符才计） */
export function quoteFound(quote, text) {
  const norm = (value) => String(value).normalize("NFKC").toLowerCase().replace(/[\s*_`#>|\\{}$]+/g, "");
  const q = norm(quote);
  return q.length >= 12 && norm(text).includes(q);
}

/** 论文级 bootstrap 95% CI（均值），确定性 seed；配对差值直接传差值数组 */
export function bootstrapCi(values, iterations = 4000, seed = 20261102) {
  if (values.length === 0) return { n: 0, mean: null, low: null, high: null };
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const means = [];
  for (let i = 0; i < iterations; i += 1) means.push(mean(values.map(() => values[Math.floor(rand() * values.length)])));
  means.sort((a, b) => a - b);
  return { n: values.length, mean: mean(values), low: means[Math.floor(0.025 * iterations)], high: means[Math.floor(0.975 * iterations)] };
}

/** CoCoReviewBench 正确性过滤后的人类弱点意见（与 M15 D2 同一过滤口径），附原子意见文本 */
export function humanWeaknesses(record) {
  const weaknessIds = new Set();
  for (const thread of record.reviews) {
    for (const turn of thread) {
      if (!/^Reviewer/.test(turn.role)) continue;
      const value = turn.sentence_ids?.value;
      const parsed = typeof value === "string" ? JSON.parse(value.replace(/'/g, '"')) : value;
      for (const id of parsed?.weaknesses ?? []) weaknessIds.add(id);
    }
  }
  const out = [];
  record.opinions.forEach((opinion, index) => {
    if (record.conflicts_validation?.[index] === "incorrect" || record.rebuttal_validation?.[index] === "incorrect") return;
    const parts = opinion.data.filter((d) => /^Reviewer/.test(d.role));
    if (!parts.some((d) => d.sentence_ids.some((id) => weaknessIds.has(id)))) return;
    const text = parts.flatMap((d) => d.sentence_ids.map((id) => record.sentence_texts[id])).join(" ");
    out.push({ opinionIndex: index, category: opinion.category.filter((c) => c !== "N/A"), text });
  });
  return out;
}

export function loadCocoRecords(ids) {
  const wanted = new Set(ids);
  const lines = readFileSync(join(M15, "external", "cocoreviewbench-2580687", "benchmark_ICLR_2025.jsonl"), "utf8").split(/\r?\n/);
  const map = new Map();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const r = JSON.parse(line);
    if (wanted.has(r.id)) map.set(r.id, r);
  }
  return map;
}

// 不读论文的通用审稿套话（冻结；用于检验裁判是否只按「泛泛同类」就判匹配）
export const GENERIC_CONTROL = [
  "The experimental evaluation is limited and should include more datasets and stronger baselines.",
  "The novelty of the proposed method is limited compared with prior work.",
  "Some parts of the paper are unclear and the writing could be improved.",
  "The paper lacks ablation studies to justify the design choices.",
  "Implementation details and hyperparameters are insufficient for reproducibility.",
  "The theoretical analysis is limited or lacks rigorous justification.",
  "The computational cost and scalability of the method are not discussed.",
  "The statistical significance of the reported improvements is not established.",
  "The related work discussion misses some relevant recent methods.",
  "The limitations of the approach are not adequately discussed.",
];


const SEVERITY_RANK = { critical: 0, blocking: 0, major: 1, minor: 2, info: 3 };
/** 生产 findings：review-summary 的 issues，按严重度稳定排序（与产品优先展示同口径） */
export function productionFindings(caseId) {
  const summary = readJson(join(ROOT, "C", "production", caseId, "artifacts", "review-summary-r1.json"));
  return summary.issues
    .map((issue, index) => ({ index, category: issue.category, severity: issue.severity, text: issue.description, quote: issue.quote ?? issue.evidence?.quote ?? issue.claimText ?? null }))
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4) || a.index - b.index);
}
