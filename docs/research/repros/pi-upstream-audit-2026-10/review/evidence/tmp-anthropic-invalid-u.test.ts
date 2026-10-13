// EVIDENCE ONLY — not part of the upstream patch. Copy of the temporary test that was run inside the Pi checkout
// (packages/ai/test/) on 2026-10-13 against the Anthropic provider path, then deleted from the checkout.
//
// Result with upstream json-parse.ts (7d75a0e3e):   1 failed  — received arguments lack `content`
// Result with the patched json-parse.ts (254edb710): 1 passed  — `{ path: "main.tex", content: "\\usepackage{graphicx}" }`
//
// It mirrors the fixture style of upstream packages/ai/test/anthropic-sse-parsing.test.ts
// ("repairs malformed SSE JSON and malformed streamed tool JSON"), which covers `\H` but not `\u`.
import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { ToolCall } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		beta: { messages: { create: () => ({ asResponse: async () => response }) } },
	} as unknown as Anthropic;
}

describe("TEMP anthropic-messages: tool arguments with an invalid \\u escape", () => {
	it("delivers the full arguments instead of dropping fields", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Use the write tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "write",
					description: "Write a file.",
					parameters: Type.Object({ path: Type.String(), content: Type.String() }),
				},
			],
		});
		// The model's raw bytes {"path":"main.tex","content":"\usepackage{x}"} as they appear inside the
		// provider's own (valid) JSON envelope: partial_json is a JSON string, so its backslash is doubled on the wire.
		const rawArgs = String.raw`{"path":"main.tex","content":"\usepackage{graphicx}"}`;
		const deltas = [rawArgs.slice(0, 20), rawArgs.slice(20, 40), rawArgs.slice(40)];
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: { id: "msg_test", usage: { input_tokens: 12, output_tokens: 0 } },
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_test", name: "write", input: {} },
				}),
			},
			...deltas.map((partial_json) => ({
				event: "content_block_delta",
				data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } }),
			})),
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: { input_tokens: 12, output_tokens: 5 },
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();
		expect(result.stopReason).toBe("toolUse");
		const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall?.arguments).toEqual({ path: "main.tex", content: String.raw`\usepackage{graphicx}` });
	});
});
