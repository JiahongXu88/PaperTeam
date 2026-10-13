import { describe, expect, it } from "vitest";
import { parseStreamingJson, repairJson } from "../src/utils/json-parse.ts";

describe("repairJson", () => {
	it("doubles the backslash of \\u that is not followed by four hex digits", () => {
		// LaTeX commands starting with u and Windows paths are the common real-world cases.
		expect(repairJson(String.raw`{"text":"\url{https://example.org}"}`)).toBe(
			String.raw`{"text":"\\url{https://example.org}"}`,
		);
		expect(repairJson(String.raw`{"text":"\usepackage{graphicx}"}`)).toBe(
			String.raw`{"text":"\\usepackage{graphicx}"}`,
		);
		expect(repairJson(String.raw`{"path":"C:\users\x"}`)).toBe(String.raw`{"path":"C:\\users\\x"}`);
		expect(repairJson(String.raw`{"text":"\u12G4"}`)).toBe(String.raw`{"text":"\\u12G4"}`);
		// Fewer than four characters before the closing quote.
		expect(repairJson(String.raw`{"text":"x\u12"}`)).toBe(String.raw`{"text":"x\\u12"}`);
		expect(repairJson(String.raw`{"text":"x\u00"}`)).toBe(String.raw`{"text":"x\\u00"}`);
		expect(repairJson(String.raw`{"\ukey":1}`)).toBe(String.raw`{"\\ukey":1}`);
	});

	it("keeps valid escapes, \\u escapes, surrogate pairs and already doubled backslashes", () => {
		const json = String.raw`{"text":"line\nquote \" caf\u00e9 \ud83d\ude00 \\url{x} \\u0041 tab\t"}`;
		expect(repairJson(json)).toBe(json);
		expect(JSON.parse(json)).toEqual({ text: 'line\nquote " café \u{1f600} \\url{x} \\u0041 tab\t' });
	});

	it("escapes raw control characters inside strings", () => {
		expect(repairJson('{"text":"a\nb"}')).toBe(String.raw`{"text":"a\nb"}`);
	});
});

describe("parseStreamingJson", () => {
	it("repairs an invalid \\u escape like any other invalid escape", () => {
		expect(parseStreamingJson(String.raw`{"text":"See \cite{knuth84}"}`)).toEqual({
			text: String.raw`See \cite{knuth84}`,
		});
		expect(parseStreamingJson(String.raw`{"text":"See \url{https://example.org}"}`)).toEqual({
			text: String.raw`See \url{https://example.org}`,
		});
	});

	it("keeps the properties after a value with an invalid \\u escape", () => {
		expect(
			parseStreamingJson(
				String.raw`{"path":"main.tex","content":"\documentclass{article}\n\usepackage{graphicx}\n","mode":"w"}`,
			),
		).toEqual({
			path: "main.tex",
			content: "\\documentclass{article}\n\\usepackage{graphicx}\n",
			mode: "w",
		});
	});

	it("keeps valid \\u escapes", () => {
		expect(parseStreamingJson(String.raw`{"text":"caf\u00e9 \u2014 ok"}`)).toEqual({ text: "café — ok" });
	});

	it("still salvages a partial object while a \\u escape is incomplete", () => {
		// A streamed delta can end inside an escape that the next delta completes.
		expect(parseStreamingJson(String.raw`{"path":"main.tex","content":"caf\u00`)).toEqual({
			path: "main.tex",
			content: "caf",
		});
		expect(parseStreamingJson(String.raw`{"path":"main.tex","content":"caf\u`)).toEqual({
			path: "main.tex",
			content: "caf",
		});
	});
});
