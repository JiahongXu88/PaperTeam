// Differential probe for the Pi `repairJson` candidates. Pure functions only, no provider, no credentials.
//
// Variant A = upstream main (packages/ai/src/utils/json-parse.ts at 7d75a0e3e, unchanged since e58d631c8).
// Variant B = minimal fix: drop "u" from VALID_JSON_ESCAPES so a `\u` without four hex digits is an invalid escape.
// Variant C = previous-round patch (ab9c50d93): B plus "keep `\u` when the input ends inside the escape".
//
// For every corpus string and every prefix of it (streaming deltas), run the three variants through the exact
// parseJsonWithRepair / parseStreamingJson wrappers used by Pi and report where the outputs differ.
//
// Usage: node differential-repair.mjs <path-to-pi-checkout-or-node_modules-root>
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = process.argv[2];
if (!root) {
	console.error("usage: node differential-repair.mjs <pi checkout root (must contain node_modules/partial-json)>");
	process.exit(2);
}
const require = createRequire(resolve(root, "package.json"));
const { parse: partialParse } = require("partial-json");

function isControlCharacter(char) {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}
function escapeControlCharacter(char) {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/** Shared skeleton; `onUnicode(json, index)` decides what to do at a `\u` and returns [text, newIndex] or null. */
function makeRepair(validEscapes, onUnicode) {
	return function repairJson(json) {
		let repaired = "";
		let inString = false;
		for (let index = 0; index < json.length; index++) {
			const char = json[index];
			if (!inString) {
				repaired += char;
				if (char === '"') inString = true;
				continue;
			}
			if (char === '"') {
				repaired += char;
				inString = false;
				continue;
			}
			if (char === "\\") {
				const nextChar = json[index + 1];
				if (nextChar === undefined) {
					repaired += "\\\\";
					continue;
				}
				if (nextChar === "u") {
					const handled = onUnicode(json, index);
					if (handled) {
						repaired += handled[0];
						index = handled[1];
						continue;
					}
				}
				if (validEscapes.has(nextChar)) {
					repaired += `\\${nextChar}`;
					index += 1;
					continue;
				}
				repaired += "\\\\";
				continue;
			}
			repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
		}
		return repaired;
	};
}

const SINGLE = ['"', "\\", "/", "b", "f", "n", "r", "t"];
const fourHex = (json, index) => {
	const digits = json.slice(index + 2, index + 6);
	return /^[0-9a-fA-F]{4}$/.test(digits) ? [`\\u${digits}`, index + 5] : null;
};
// A: "u" is also in the single-character set, so a non-hex `\u` is kept verbatim.
const repairA = makeRepair(new Set([...SINGLE, "u"]), fourHex);
// B: "u" removed from the set; a non-hex `\u` falls through to the invalid-escape branch.
const repairB = makeRepair(new Set(SINGLE), fourHex);
// C: B + keep `\u` when fewer than four characters remain and all are hex (previous-round patch).
const repairC = makeRepair(new Set(SINGLE), (json, index) => {
	const digits = json.slice(index + 2, index + 6);
	if (/^[0-9a-fA-F]{4}$/.test(digits)) return [`\\u${digits}`, index + 5];
	if (digits.length < 4 && /^[0-9a-fA-F]*$/.test(digits)) return ["\\u", index + 1];
	return ["\\\\", index];
});

function wrap(repairJson) {
	function parseJsonWithRepair(json) {
		try {
			return JSON.parse(json);
		} catch (error) {
			const repairedJson = repairJson(json);
			if (repairedJson !== json) return JSON.parse(repairedJson);
			throw error;
		}
	}
	function parseStreamingJson(partialJson) {
		if (!partialJson || partialJson.trim() === "") return {};
		try {
			return parseJsonWithRepair(partialJson);
		} catch {
			try {
				return partialParse(partialJson) ?? {};
			} catch {
				try {
					return partialParse(repairJson(partialJson)) ?? {};
				} catch {
					return {};
				}
			}
		}
	}
	return { repairJson, parseJsonWithRepair, parseStreamingJson };
}

const variants = { A: wrap(repairA), B: wrap(repairB), C: wrap(repairC) };
const BS = "\\";
const S = (...parts) => parts.join("");
const corpus = [
	// invalid \u (LaTeX commands starting with u)
	S('{"text":"See ', BS, 'url{https://example.org/paper}"}'),
	S('{"path":"main.tex","content":"', BS, 'documentclass{article}', BS, 'n', BS, 'usepackage{graphicx}', BS, 'n"}'),
	S('{"text":"', BS, 'underline{x} and ', BS, 'upshape"}'),
	// \u + partial hex then non-hex / closing quote
	S('{"text":"', BS, 'u12G4"}'),
	S('{"text":"x', BS, 'u12"}'),
	S('{"text":"x', BS, 'u"}'),
	S('{"text":"', BS, 'uabc"}'),
	// valid \u, surrogate pairs, mixed with text
	S('{"text":"caf', BS, 'u00e9 ', BS, 'u2014 ok"}'),
	S('{"text":"', BS, 'ud83d', BS, 'ude00"}'),
	S('{"text":"', BS, 'uD83D', BS, 'uDE00 smile"}'),
	// already double-escaped
	S('{"text":"See ', BS, BS, 'url{x} and ', BS, BS, 'cite{y}"}'),
	// mixed valid and invalid escapes
	S('{"text":"a', BS, 'tb ', BS, 'cite{x} ', BS, 'url{y} ', BS, '"q', BS, '" ', BS, 'u00e9"}'),
	// escapes in property names
	S('{"te', BS, 'ut":"v","next":1}'),
	S('{"te', BS, 'u0078t":"v","next":1}'),
	// later properties after the fault
	S('{"a":1,"b":"', BS, 'url{x}","c":[1,2],"d":{"e":"f"}}'),
	// control characters
	'{"text":"a\nb\tc"}',
	// \c control as it is repaired today
	S('{"text":"See ', BS, 'cite{knuth84}"}'),
	// odd backslash runs
	S('{"text":"', BS, BS, BS, 'url{x}"}'),
	S('{"text":"', BS, BS, BS, BS, 'u00e9"}'),
	// \u + exactly 4 non-hex-looking letters that are LaTeX
	S('{"text":"', BS, 'uline{x}"}'),
	// A closed object followed by whitespace that the stream delivers after the closing brace. The closed prefix
	// is a complete JSON text, yet it is still an intermediate state of this stream.
	S('{"text":"See ', BS, 'url{x}"} '),
	S('{"text":"See ', BS, 'url{x}"}\n'),
	// Same shape with a valid \u escape and with the \c control: trailing whitespace must change nothing.
	S('{"text":"caf', BS, 'u00e9"}\n'),
	S('{"text":"See ', BS, 'cite{x}"} '),
];

function show(v) {
	return JSON.stringify(v);
}

/**
 * Structural classification of a streaming prefix, independent of the repair variants: `closed` when every
 * object/array opened in the prefix has been closed and only whitespace follows (the prefix is a complete JSON
 * text, whether or not it parses); `open` otherwise. Backslash handling follows the JSON grammar (a backslash
 * consumes the next character) so an invalid `\u` cannot desynchronise the string tracker.
 */
function classifyPrefix(prefix) {
	let inString = false;
	let depth = 0;
	let opened = false;
	let closedAt = -1;
	for (let index = 0; index < prefix.length; index++) {
		const char = prefix[index];
		if (inString) {
			if (char === "\\") index++;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") {
			depth++;
			opened = true;
		} else if (char === "}" || char === "]") {
			depth--;
			if (opened && depth === 0) closedAt = index;
		}
	}
	if (!opened || depth !== 0 || inString) return "open";
	return /^\s*$/.test(prefix.slice(closedAt + 1)) ? "closed" : "open";
}

let abDiffs = 0;
let bcDiffs = 0;
let abClosed = 0;
let abOpen = 0;
let abClosedNotLast = 0;
const lines = [];
for (const full of corpus) {
	for (let n = 1; n <= full.length; n++) {
		const prefix = full.slice(0, n);
		const out = {};
		for (const [name, fns] of Object.entries(variants)) out[name] = show(fns.parseStreamingJson(prefix));
		const kind = classifyPrefix(prefix);
		const tag = `${kind.toUpperCase().padEnd(6)}${n === full.length ? " last" : " mid "}`;
		if (out.A !== out.B) {
			abDiffs++;
			if (kind === "closed") {
				abClosed++;
				if (n !== full.length) abClosedNotLast++;
			} else abOpen++;
			lines.push(`${tag} A!=B  ${show(prefix)}\n    A=${out.A}\n    B=${out.B}`);
		}
		if (out.B !== out.C) {
			bcDiffs++;
			lines.push(`${tag} B!=C  ${show(prefix)}\n    B=${out.B}\n    C=${out.C}`);
		}
	}
}
console.log(lines.join("\n"));
console.log("\n=== summary ===");
console.log(`corpus strings: ${corpus.length}; prefixes checked: ${corpus.reduce((a, s) => a + s.length, 0)}`);
console.log(`A (main) vs B (minimal): ${abDiffs} differing prefixes`);
console.log(`  closed (object already complete, possibly followed by whitespace): ${abClosed}`);
console.log(`    of which not the last prefix of their stream (closed object, whitespace still to come): ${abClosedNotLast}`);
console.log(`  open (object not yet closed): ${abOpen}`);
console.log(`B (minimal) vs C (old patch): ${bcDiffs} differing prefixes through parseStreamingJson`);

// A closed object with an invalid \u followed by streamed whitespace: show A and B for each step of the tail.
console.log("\n=== closed object followed by streamed whitespace (A vs B at each step) ===");
for (const tail of [" ", "\n"]) {
	const closed = S('{"text":"See ', BS, 'url{x}"}');
	for (const s of [closed, closed + tail]) {
		console.log(`${show(s)}\n    A=${show(variants.A.parseStreamingJson(s))}\n    B=${show(variants.B.parseStreamingJson(s))}`);
	}
}

// repairJson itself differs between B and C on truncated hex — show it so the reader can see the exact delta.
console.log("\n=== raw repairJson B vs C on truncated escapes ===");
for (const s of [S('{"text":"caf', BS, 'u00'), S('{"text":"caf', BS, 'u'), S('{"text":"caf', BS, 'u00e')]) {
	console.log(`${show(s)}\n    B=${show(variants.B.repairJson(s))}\n    C=${show(variants.C.repairJson(s))}`);
}

// Does partial-json ever throw on a string-level fault inside an object? (If not, tier 3 of parseStreamingJson
// cannot be reached for these inputs and the difference between B and C is invisible to callers.)
console.log("\n=== partial-json throw census over corpus prefixes ===");
let throwsCount = 0;
for (const full of corpus) {
	for (let n = 1; n <= full.length; n++) {
		try {
			partialParse(full.slice(0, n));
		} catch (e) {
			throwsCount++;
			if (throwsCount <= 10) console.log(`throws on ${show(full.slice(0, n))}: ${e.constructor.name}: ${e.message}`);
		}
	}
}
console.log(`partial-json threw on ${throwsCount} prefixes`);
