/**
 * M16 工程可靠性收口：真实 smoke 的 harness（复制自 m16-verified-findings/lib.mjs，只改 ROOT 与上限）。
 * 账本：<ROOT>\budget\calls.jsonl（append-only，一次物理调用一行）；本轮上限 24 次真实调用（任务书 §6）。
 * 历史目录（VerifiedFindingsHybridReview 等）只读：输入 MD 从那里读取，任何产物只写本轮 ROOT。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "..", "..");
export const ROOT = "D:\\PaperTeamData\\M16\\EngineeringReliabilityClosure";
export const FROZEN = "D:\\PaperTeamData\\M16\\VerifiedFindingsHybridReview";
export const PREV = "D:\\PaperTeamData\\M16\\OriginalQualityGateGoalClosure";
export const PREV2 = "D:\\PaperTeamData\\M16\\ReviewFidelityAndBenchmark_Closure";
export const M16 = "D:\\PaperTeamData\\M16\\AcademicReviewValidity";
export const M15 = "D:\\PaperTeamData\\M15\\TargetJournalAssessment";
export const COCO = join(M15, "external", "cocoreviewbench-2580687");
export const MD_DIR = join(FROZEN, "external", "cocoreviewbench-md");
export const LEDGER = join(ROOT, "budget", "calls.jsonl");
export const MAX_CALLS = 24;
export const MODEL_SPEC = process.env.M16_MODEL ?? "zai-coding-cn/glm-5.3";

export const sha = (s) => createHash("sha256").update(s).digest("hex");
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
    const text = message === undefined ? "" : (message.content ?? []).filter((part) => part.type === "text" || part.type === undefined).map((part) => part.text ?? "").join("").trim();
    appendLedger({ purpose, model: MODEL_SPEC, durationMs, usage, inputSha256: sha(systemPrompt + "\n" + userText), outputSha256: sha(text), ...(error !== undefined ? { error: error.slice(0, 300) } : {}) });
    if (error !== undefined) throw new Error(error);
    return { text, usage, durationMs };
  }
  return { spec: MODEL_SPEC, complete };
}
