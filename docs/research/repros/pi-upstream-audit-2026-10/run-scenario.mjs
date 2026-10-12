// Standalone Pi SDK scenario driver. No PaperTeam code involved.
// Usage: node run-scenario.mjs --sdk <pi-coding-agent package dir> --scenario <name> [--abort-during-tool] [--json]
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startFakeServer } from "./fake-openai-server.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const sdkDir = opt("sdk");
const scenario = opt("scenario", "plain");
const abortDuringTool = flag("abort-during-tool");
const abortDelayMs = Number(opt("abort-delay-ms", "1500"));
const jsonOut = flag("json");
const retryEnabled = flag("retry");
const abortOnRetry = flag("abort-on-retry");
const retryBaseDelayMs = Number(opt("retry-base-delay-ms", "1500"));
const quiet = flag("quiet");
const providerTimeoutMs = opt("provider-timeout-ms");
const httpIdleTimeoutMs = opt("http-idle-timeout-ms");
const abortAfterMs = opt("abort-after-ms");
const watchdogMs = Number(opt("watchdog-ms", "60000"));
if (!sdkDir) {
	console.error("--sdk <dir> required");
	process.exit(2);
}

const log = (...m) => {
	if (!quiet) console.error(...m);
};

const sdkPkg = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
const sdk = await import(pathToFileURL(join(sdkDir, "dist/index.js")).href);
const { createAgentSession, ModelRuntime, SessionManager, SettingsManager, defineTool } = sdk;

const server = await startFakeServer({ log });
const root = mkdtempSync(join(tmpdir(), "pi-audit-"));
const agentDir = join(root, "agent");
const cwd = join(root, "cwd");
const { mkdirSync } = await import("node:fs");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify(
		{
			providers: {
				"faux-local": {
					baseUrl: server.baseUrl,
					api: "openai-completions",
					apiKey: "fake-key",
					models: [
						{
							id: scenario,
							name: `scenario ${scenario}`,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					],
				},
			},
		},
		null,
		2,
	),
);
writeFileSync(join(agentDir, "auth.json"), "{}");

const received = [];
const slowToolState = { started: false, abortedSignal: false, completed: false };

const addNote = defineTool({
	name: "add_note",
	label: "add_note",
	description: "Append a note",
	parameters: {
		type: "object",
		properties: { text: { type: "string", description: "note text" } },
		required: ["text"],
	},
	async execute(_id, params) {
		received.push({ tool: "add_note", params });
		return { content: [{ type: "text", text: `noted (${params.text.length} chars)` }], details: {} };
	},
});
const writeTex = defineTool({
	name: "write_tex",
	label: "write_tex",
	description: "Write a LaTeX file",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "file path" },
			content: { type: "string", description: "file content (optional: empty file when omitted)" },
		},
		required: ["path"],
	},
	async execute(_id, params) {
		received.push({ tool: "write_tex", params });
		return {
			content: [{ type: "text", text: `wrote ${params.path} (${params.content === undefined ? "NO CONTENT" : `${params.content.length} chars`})` }],
			details: {},
		};
	},
});
const slowTool = defineTool({
	name: "slow_tool",
	label: "slow_tool",
	description: "Sleep",
	parameters: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
	async execute(_id, params, signal) {
		slowToolState.started = true;
		received.push({ tool: "slow_tool", params });
		await new Promise((resolve, reject) => {
			const t = setTimeout(resolve, params.seconds * 1000);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					slowToolState.abortedSignal = true;
					reject(signal.reason ?? new Error("aborted"));
				},
				{ once: true },
			);
		});
		slowToolState.completed = true;
		return { content: [{ type: "text", text: "slept" }], details: {} };
	},
});

const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
const model = modelRuntime.getModel("faux-local", scenario);
if (!model) throw new Error("model not found: " + modelRuntime.getError?.());

const settings = {
	compaction: { enabled: false },
	retry: retryEnabled ? { enabled: true, maxRetries: 3, baseDelayMs: retryBaseDelayMs } : { enabled: false },
};
if (providerTimeoutMs !== undefined) settings.retry.provider = { timeoutMs: Number(providerTimeoutMs), maxRetries: 0 };
if (httpIdleTimeoutMs !== undefined) settings.httpIdleTimeoutMs = Number(httpIdleTimeoutMs);
const { session } = await createAgentSession({
	cwd,
	agentDir,
	model,
	modelRuntime,
	sessionManager: SessionManager.inMemory(cwd),
	settingsManager: SettingsManager.inMemory(settings),
	tools: ["add_note", "write_tex", "slow_tool"],
	customTools: [addNote, writeTex, slowTool],
});

const events = [];
const t0 = Date.now();
const ev = (type, data) => events.push({ t: Date.now() - t0, type, ...data });
let abortTimer;
session.subscribe((e) => {
	switch (e.type) {
		case "tool_execution_start":
			ev(e.type, { toolName: e.toolName, args: e.args });
			if (abortDuringTool && !abortTimer) {
				abortTimer = setTimeout(() => {
					ev("session.abort()", {});
					void session.abort();
				}, abortDelayMs);
			}
			break;
		case "tool_execution_end":
			ev(e.type, {
				toolName: e.toolName,
				isError: e.isError,
				resultText: e.result?.content?.map((c) => c.text).join("") ?? null,
			});
			break;
		case "message_end":
			if (e.message.role === "assistant") {
				ev(e.type, {
					role: "assistant",
					stopReason: e.message.stopReason,
					errorMessage: e.message.errorMessage,
					usage: e.message.usage?.totalTokens,
					toolCalls: e.message.content.filter((c) => c.type === "toolCall").map((c) => ({ name: c.name, arguments: c.arguments })),
				});
			} else if (e.message.role === "toolResult") {
				ev(e.type, { role: "toolResult", isError: e.message.isError, text: e.message.content?.map((c) => c.text).join("") });
			}
			break;
		case "agent_end":
			ev(e.type, { willRetry: e.willRetry });
			if (abortOnRetry && e.willRetry && !abortTimer) {
				abortTimer = setTimeout(() => {
					ev("session.abort()", { during: "retry backoff" });
					void session.abort();
				}, Math.min(500, retryBaseDelayMs / 3));
			}
			break;
		case "auto_retry_start":
			ev(e.type, { attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs, errorMessage: e.errorMessage });
			break;
		case "auto_retry_end":
			ev(e.type, { success: e.success, attempt: e.attempt, finalError: e.finalError });
			break;
		case "agent_settled":
			ev(e.type, { aborted: e.aborted });
			break;
		default:
			break;
	}
});

let watchdogFired = false;
const watchdog = setTimeout(() => {
	watchdogFired = true;
	console.error(`WATCHDOG: prompt did not settle in ${watchdogMs}ms; aborting session`);
	ev("watchdog.abort()", {});
	void session.abort();
}, watchdogMs);
if (abortAfterMs !== undefined) {
	setTimeout(() => {
		ev("session.abort()", { after: Number(abortAfterMs) });
		void session.abort();
	}, Number(abortAfterMs));
}

let promptError;
try {
	await session.prompt("Run the scenario.", { expandPromptTemplates: false });
} catch (error) {
	promptError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
clearTimeout(watchdog);
clearTimeout(abortTimer);

const assistant = events.filter((e) => e.type === "message_end" && e.role === "assistant");
const last = assistant[assistant.length - 1];
let contextUsage = null;
try {
	contextUsage = typeof session.getContextUsage === "function" ? session.getContextUsage() : "n/a";
} catch (error) {
	contextUsage = { error: String(error) };
}
const summary = {
	elapsedMs: Date.now() - t0,
	watchdogFired,
	providerTimeoutMs: providerTimeoutMs === undefined ? null : Number(providerTimeoutMs),
	httpIdleTimeoutMs: httpIdleTimeoutMs === undefined ? null : Number(httpIdleTimeoutMs),
	contextUsage,
	retryEnabled,
	abortOnRetry,
	sdk: { name: sdkPkg.name, version: sdkPkg.version, dir: sdkDir },
	node: process.version,
	platform: process.platform,
	scenario,
	abortDuringTool,
	promptError: promptError ?? null,
	finalStopReason: last?.stopReason ?? null,
	finalErrorMessage: last?.errorMessage ?? null,
	assistantTurns: assistant.length,
	toolReceivedParams: received,
	slowToolState,
	serverRequests: server.requests.map((r) => ({
		index: r.index,
		messages: r.messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content.slice(0, 300) : m.content, tool_calls: m.tool_calls })),
	})),
	events,
};

try {
	session.dispose();
} catch {}
await server.close();
rmSync(root, { recursive: true, force: true });

if (jsonOut) {
	console.log(JSON.stringify(summary, null, 2));
} else {
	console.log(JSON.stringify({ ...summary, events: undefined, serverRequests: undefined }, null, 2));
}
process.exit(0);
