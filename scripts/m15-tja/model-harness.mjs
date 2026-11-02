/**
 * M15 TJA 付费模型调用 harness：全局账本（跨脚本累计）+ 硬上限 80 次（协议 §2）。
 *
 * 账本：D:\PaperTeamData\M15\TargetJournalAssessment\budget\calls.jsonl（append-only；每次调用一行，
 * 含用途、时长、token 用量）。达到上限 → 抛错，调用方停止，不申请加额。
 * 模型：PAPERTEAM_PI_MODEL 或缺省 zai-coding-cn/glm-5.3；凭据只经 Pi agentDir/auth.json 读取（不打印）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
export const DATA = "D:\\PaperTeamData\\M15\\TargetJournalAssessment";
const LEDGER = join(DATA, "budget", "calls.jsonl");
export const MAX_CALLS = 80;

export function callsUsed() {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "").length;
}

export async function createModel() {
  const distUrl = (...p) => pathToFileURL(join(REPO, "backend", "dist", ...p)).href;
  const { loadConfig } = await import(distUrl("config", "config.js"));
  const config = loadConfig();
  const spec = process.env.PAPERTEAM_PI_MODEL ?? "zai-coding-cn/glm-5.3";
  const piUrl = pathToFileURL(join(REPO, "backend", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href;
  const { ModelRuntime } = await import(piUrl);
  const runtime = await ModelRuntime.create({ authPath: join(config.pi.agentDir, "auth.json"), modelsPath: join(config.pi.agentDir, "models.json") });
  const [provider, ...rest] = spec.split("/");
  const entry = runtime.getModel(provider, rest.join("/"));
  if (entry === undefined || entry === null || !runtime.hasConfiguredAuth(provider)) throw new Error(`模型 ${spec} 未在目录中或未配置凭据`);
  mkdirSync(dirname(LEDGER), { recursive: true });

  /** 单次调用（计入账本）；返回 { text, usage, durationMs } */
  async function complete(purpose, systemPrompt, userText, maxTokens = 3000) {
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
    appendFileSync(LEDGER, `${JSON.stringify({ n: used + 1, at: new Date().toISOString(), purpose, model: spec, durationMs, usage, ...(error !== undefined ? { error: error.slice(0, 300) } : {}) })}\n`, "utf8");
    if (error !== undefined) throw new Error(error);
    const text = (message.content ?? []).filter((part) => part.type === "text" || part.type === undefined).map((part) => part.text ?? "").join("").trim();
    return { text, usage, durationMs };
  }
  return { spec, complete };
}

/** 从模型输出中取第一个 JSON 对象（宽松：去围栏） */
export function parseJsonObject(text) {
  const stripped = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("无 JSON 对象");
  return JSON.parse(stripped.slice(start, end + 1));
}

/** 证据引文确定性回放：去空白 + 小写后的子串匹配（≥ 12 字符才计） */
export function quoteFound(quote, text) {
  const norm = (value) => String(value).normalize("NFKC").toLowerCase().replace(/[\s*_`#>|]+/g, "");
  const q = norm(quote);
  return q.length >= 12 && norm(text).includes(q);
}

/** 论文级 bootstrap 95% CI（均值），确定性 seed */
export function bootstrapCi(values, iterations = 2000, seed = 20261102) {
  if (values.length === 0) return { mean: null, low: null, high: null };
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const means = [];
  for (let i = 0; i < iterations; i += 1) means.push(mean(values.map(() => values[Math.floor(rand() * values.length)])));
  means.sort((a, b) => a - b);
  return { mean: mean(values), low: means[Math.floor(0.025 * iterations)], high: means[Math.floor(0.975 * iterations)] };
}
