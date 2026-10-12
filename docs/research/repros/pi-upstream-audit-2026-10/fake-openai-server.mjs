// In-process fake OpenAI-compatible chat completions server (SSE).
// Deterministic, zero-cost. Scenario is selected by the `model` field of the request.
// Each scenario is a function (requestIndex, body) -> { status?, json? } | { events: [...] }.
import http from "node:http";

function sseChunk(obj) {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

function chunk(delta, finishReason = null, usage) {
	const base = {
		id: "chatcmpl-fake",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "fake",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	if (usage) base.usage = usage;
	return base;
}

const USAGE = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 };

/** Build the SSE event list for a single tool call whose `arguments` is the RAW string the model emitted. */
export function toolCallEvents(name, rawArguments, { pieces = 3 } = {}) {
	const events = [chunk({ role: "assistant", content: null })];
	events.push(
		chunk({
			tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }],
		}),
	);
	// Split the raw argument string into a few deltas, like a real stream.
	const size = Math.max(1, Math.ceil(rawArguments.length / pieces));
	for (let i = 0; i < rawArguments.length; i += size) {
		events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: rawArguments.slice(i, i + size) } }] }));
	}
	events.push(chunk({}, "tool_calls", USAGE));
	return events;
}

export function textEvents(text) {
	return [chunk({ role: "assistant", content: "" }), chunk({ content: text }), chunk({}, "stop", USAGE)];
}

/**
 * Scenario registry. `latex` strings are written exactly as a model that forgot to
 * double-escape backslashes would emit them inside the JSON `arguments` string.
 */
export const SCENARIOS = {
	// add_note({text}) with an invalid \u escape (LaTeX \url). Expect: arguments collapse to {}.
	"note-url": (i) =>
		i === 0
			? { events: toolCallEvents("add_note", String.raw`{"text":"See \url{https://example.org/paper}"}`) }
			: { events: textEvents("done") },
	// Control: invalid \c escape (LaTeX \cite) is repaired by Pi today.
	"note-cite": (i) =>
		i === 0
			? { events: toolCallEvents("add_note", String.raw`{"text":"See \cite{knuth84}"}`) }
			: { events: textEvents("done") },
	// Control: properly escaped JSON.
	"note-valid": (i) =>
		i === 0
			? { events: toolCallEvents("add_note", String.raw`{"text":"See \\cite{knuth84} and \\url{https://example.org}"}`) }
			: { events: textEvents("done") },
	// write_tex({path, content?}) where content holds \usepackage: expect `content` silently dropped.
	"tex-usepackage": (i) =>
		i === 0
			? {
					events: toolCallEvents(
						"write_tex",
						String.raw`{"path":"main.tex","content":"\documentclass{article}\n\usepackage{graphicx}\n"}`,
					),
				}
			: { events: textEvents("done") },
	// Control: same shape but only \c / \d invalid escapes (repaired today).
	"tex-cite": (i) =>
		i === 0
			? {
					events: toolCallEvents(
						"write_tex",
						String.raw`{"path":"main.tex","content":"\documentclass{article}\nSee \cite{knuth84}.\n"}`,
					),
				}
			: { events: textEvents("done") },
	// A complete-but-invalid \u escape with fewer than 4 following chars before the closing quote.
	"note-u-short": (i) =>
		i === 0
			? { events: toolCallEvents("add_note", String.raw`{"text":"x\u12"}`) }
			: { events: textEvents("done") },
	// A valid \u escape must stay untouched.
	"note-u-valid": (i) =>
		i === 0
			? { events: toolCallEvents("add_note", String.raw`{"text":"caf\u00e9 \u2014 ok"}`) }
			: { events: textEvents("done") },
	// Abort-during-tool scenario: first turn calls slow_tool, second turn (if reached) answers.
	"abort-slow-tool": (i) =>
		i === 0
			? { events: toolCallEvents("slow_tool", String.raw`{"seconds": 30}`) }
			: { events: textEvents("done after tool") },
	// Retry scenarios: first request fails with HTTP 500, second succeeds.
	"error-500-then-ok": (i) =>
		i === 0 ? { status: 500, json: { error: { message: "internal server error (fake)", type: "server_error" } } } : { events: textEvents("recovered") },
	// Every request fails with HTTP 500 (retry exhaustion / abort during backoff).
	"error-500-always": () => ({ status: 500, json: { error: { message: "internal server error (fake)", type: "server_error" } } }),
	// First request streams a tool call, the tool result request fails once with 500, then succeeds.
	"tool-then-500-then-ok": (i) =>
		i === 0
			? { events: toolCallEvents("add_note", String.raw`{"text":"first turn"}`) }
			: i === 1
				? { status: 500, json: { error: { message: "internal server error (fake)", type: "server_error" } } }
				: { events: textEvents("recovered after tool") },
	// Timeout probes. "stall" plans are handled specially by the server loop.
	"stall-no-headers": () => ({ stall: "before-headers" }),
	"stall-after-headers": () => ({ stall: "after-headers" }),
	// Stall after headers but keep sending SSE comment pings every second (bytes flow, no events).
	"stall-after-headers-pings": () => ({ stall: "after-headers-pings" }),
	"drop-mid-stream": (i) => (i === 0 ? { stall: "drop-mid-stream" } : { events: textEvents("recovered after drop") }),
	// Success (usage anchor) followed by permanent 500s: probes getContextUsage after retry omissions.
	"tool-then-500-always": (i) =>
		i === 0
			? { events: toolCallEvents("add_note", String.raw`{"text":"first turn"}`) }
			: { status: 500, json: { error: { message: "internal server error (fake)", type: "server_error" } } },
	// Plain text answer (sanity).
	plain: () => ({ events: textEvents("hello") }),
};

export async function startFakeServer({ interChunkDelayMs = 5, log = () => {} } = {}) {
	const requests = [];
	const counters = new Map();
	const server = http.createServer(async (req, res) => {
		let raw = "";
		for await (const part of req) raw += part;
		if (!req.url?.endsWith("/chat/completions") || req.method !== "POST") {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
			return;
		}
		const body = JSON.parse(raw);
		const scenarioName = body.model;
		const scenario = SCENARIOS[scenarioName];
		const index = counters.get(scenarioName) ?? 0;
		counters.set(scenarioName, index + 1);
		const record = { index, model: scenarioName, at: Date.now(), messages: body.messages, tools: body.tools?.map((t) => t.function?.name) };
		requests.push(record);
		log(`[fake-server] request #${index} model=${scenarioName} messages=${body.messages.length}`);
		if (!scenario) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `unknown scenario ${scenarioName}` } }));
			return;
		}
		const plan = scenario(index, body);
		if (plan.stall === "before-headers") {
			log("[fake-server] stalling before headers (socket stays open)");
			req.socket.setTimeout(0);
			return; // never respond
		}
		if (plan.stall === "after-headers") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(sseChunk(chunk({ role: "assistant", content: "" })));
			log("[fake-server] stalling after headers + 1 chunk (socket stays open)");
			return; // never finish
		}
		if (plan.stall === "after-headers-pings") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(sseChunk(chunk({ role: "assistant", content: "" })));
			log("[fake-server] stalling after headers; sending ': ping' comments every 1s");
			const timer = setInterval(() => {
				if (res.writableEnded || res.destroyed) return clearInterval(timer);
				res.write(": ping\n\n");
			}, 1000);
			req.on("close", () => clearInterval(timer));
			return;
		}
		if (plan.stall === "drop-mid-stream") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(sseChunk(chunk({ role: "assistant", content: "" })));
			res.write(sseChunk(chunk({ content: "partial text " })));
			await new Promise((r) => setTimeout(r, 50));
			log("[fake-server] destroying socket mid-stream");
			req.socket.destroy();
			return;
		}
		if (plan.status) {
			res.writeHead(plan.status, { "content-type": "application/json" });
			res.end(JSON.stringify(plan.json ?? { error: { message: `status ${plan.status}` } }));
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		for (const event of plan.events) {
			res.write(sseChunk(event));
			if (interChunkDelayMs > 0) await new Promise((r) => setTimeout(r, interChunkDelayMs));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
