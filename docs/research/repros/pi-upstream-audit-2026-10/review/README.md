# Pi upstream candidate C1 — Review Package

**REVIEW REQUIRED — NOT SUBMITTED UPSTREAM**

This package exists so that an independent reviewer (a person or a model) can check the candidate without access to the
author's machines. Nothing here has been posted to github.com/earendil-works/pi. No Issue, PR, Discussion or comment
was created. The author (JiahongXu88) is not on the upstream approved-contributor list; per upstream `CONTRIBUTING.md`
an Issue written in the author's own words must receive a maintainer `lgtm` before any PR may be opened.

Prepared 2026-10-13 by Claude Code (Fable 5.1) under the author's direction. AI assistance must be disclosed upstream if
any of this text is reused there (see §10).

## 0. Identity

| Item | Value |
|---|---|
| Upstream repository | https://github.com/earendil-works/pi |
| Upstream `main` checked | `7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6` (2026-10-12 23:37 UTC; upstream CI: success) |
| Latest release | `v1.2.0` = `06a466935` (npm `@earendil-works/pi-ai@1.2.0`, published 2026-10-12) |
| Candidate patch base | `7d75a0e3e` |
| Candidate commit (Windows research branch, private, not pushed) | `cf79153df` on `audit/json-repair-invalid-unicode-escape-v2` |
| Same patch applied on Linux via `git am` | `dc32372af` on `audit/json-repair-invalid-unicode-escape-v3` (server checkout, not pushed) |
| Patch file | `0001-fix-ai-treat-u-without-four-hex-digits-as-an-invalid.patch` (sha256 `8f36bf688da0668fdf72c1ddbec505c155277f875859351a7fe25e94f53455d9`) |
| Files touched | `packages/ai/src/utils/json-parse.ts` (+2 −1), `packages/ai/test/json-parse.test.ts` (new, 69 lines, 7 tests) |
| Affected file unchanged since | `e58d631c8` (2026-04-21, "own Anthropic SSE parsing to avoid SDK JSON.parse hard-failures") — the bug has existed since `repairJson` was introduced |
| Versions reproduced | 1.0.1, 1.1.0, 1.2.0 (npm packages) and main `7d75a0e3e` (local build); Windows 11 (Node 22.22.3) and Ubuntu 24.04 (Node 22.20.0) |
| partial-json (fallback parser) | 0.1.7, pinned by upstream, not changed |
| Previous-round candidate superseded | `ab9c50d93` (+22 −3, base `148622bc6`); see §3.4 for why |

Package contents:

```
review/
  README.md                                   this file
  0001-fix-ai-treat-u-without-four-hex-digits-as-an-invalid.patch   git format-patch, base 7d75a0e3e
  json-parse.test.ts                          the new test file as committed (same as inside the patch)
  differential-repair.mjs                     pure-function probe: upstream vs minimal fix vs previous-round patch, over all streaming prefixes
  differential-repair.output.txt              its output (Windows; Linux output identical)
  evidence/
    win-baseline-v1.0.1-v1.1.0-v1.2.0.txt     end-to-end matrix on released packages (unpatched)
    win-baseline-main-7d75a0e3e.txt           end-to-end matrix on unpatched main build
    win-patched-main-254edb710.txt            end-to-end matrix on patched main build (source identical to cf79153df)
    win-char-streaming-intermediate-states.txt one-character-per-delta streams, every intermediate parsed state, 1.2.0 vs patched
    vitest-json-parse-unpatched-win.log       new tests against unpatched main (3 fail / 4 pass)
    vitest-json-parse-patched-win.log         new + adjacent tests against patched main (all pass)
    npm-run-check-patched-win.log             `npm run check` tail (exit 0)
    tmp-anthropic-invalid-u.test.ts           evidence-only provider-level test for the Anthropic path (not in the patch)
    linux-baseline-main.txt                   Linux end-to-end matrix, unpatched main
    linux-patched-main.txt                    Linux end-to-end matrix, patched main
    linux-char-streaming-intermediate-states.txt
    linux-test-sh-summary.txt                 all `./test.sh` runs (unpatched, patched ×3) and the flaky-test isolation data
```

The end-to-end harness (`../fake-openai-server.mjs`, `../run-scenario.mjs`, `../run-matrix.sh`) lives one directory up and
is documented in `../README.md`. It drives the public SDK (`createAgentSession`) against an in-process fake
OpenAI-compatible SSE server. No API keys, no network.

## 1. Problem

`packages/ai/src/utils/json-parse.ts` exports `repairJson`, `parseJsonWithRepair` and `parseStreamingJson`. Every provider
in `pi-ai` finalizes streamed tool-call arguments through `parseStreamingJson` (anthropic-messages, openai-completions,
openai-responses-shared, bedrock-converse-stream, mistral-conversations, pi-messages, and `assistant-message-frame`).
All three functions are public exports of `@earendil-works/pi-ai`.

`repairJson`'s documented job is to make model output that forgot to escape a literal backslash parseable by
"doubling backslashes before invalid escape characters". `\c` → `\\c` works. But `"u"` was also listed in the
single-character valid-escape set, so a `\u` that is **not** followed by four hex digits took the "valid escape, keep
verbatim" branch. The dedicated four-hex check above that branch was therefore dead code as far as output is concerned.

Consequence chain for a complete tool-call argument string containing `\url{x}`:

1. `JSON.parse` fails (invalid unicode escape).
2. `repairJson` returns the input unchanged → `parseJsonWithRepair` rethrows.
3. `parseStreamingJson` falls back to `partial-json`, whose `parseStr` throws `MalformedJSON` on the string and whose
   `parseObj` catches it and **returns the object built so far**. The property with the bad string and every property
   after it are dropped.

Observable results on 1.0.1 / 1.1.0 / 1.2.0 / main:

| Model output (raw `arguments`) | Tool receives | Visible effect |
|---|---|---|
| `{"text":"See \url{https://example.org/paper}"}` | `{}` | `Validation failed for tool "add_note"` — model is told the schema is wrong |
| `{"path":"C:\users\x"}` | `{}` | same |
| `{"text":"x\u12"}` | `{}` | same |
| `{"path":"main.tex","content":"\documentclass{article}\n\usepackage{graphicx}\n"}` | `{"path":"main.tex"}` | **`content` silently lost**; a write tool runs with no content |
| `{"text":"See \cite{knuth84}"}` (control) | `{"text":"See \\cite{knuth84}"}` | repaired today |

Every LaTeX command starting with `u` (`\url`, `\usepackage`, `\underline`, `\uline`, `\upshape`) hits this; so does any
Windows path or regex fragment like `\users`. Commands starting with `b f n r t` are *valid* JSON escapes and are not
distinguishable from intended escapes; they are out of scope and unchanged.

Why this is Pi's bug and not the caller's: the function already commits to repairing exactly this class of model error
for every other letter. The inconsistency is internal to one function, and the behaviour it produces (field loss without
an error) is worse than either rejecting or repairing.

## 2. Minimal reproduction (no credentials)

Against the published package, five lines:

```js
// node repro.mjs   (in a directory where `npm i @earendil-works/pi-ai@1.2.0` was run)
import { parseStreamingJson } from "@earendil-works/pi-ai";
const BS = "\\";
console.log(JSON.stringify(parseStreamingJson(`{"text":"See ${BS}cite{x}"}`)));   // {"text":"See \\cite{x}"}
console.log(JSON.stringify(parseStreamingJson(`{"text":"See ${BS}url{x}"}`)));    // {}
console.log(JSON.stringify(parseStreamingJson(`{"path":"a.tex","content":"${BS}usepackage{x}","mode":"w"}`))); // {"path":"a.tex"}
```

Observed on 1.2.0 (2026-10-13): exactly the three outputs in the comments.

Pure-function differential over streaming prefixes (needs any checkout or install that has `node_modules/partial-json`):

```
node differential-repair.mjs <dir containing node_modules/partial-json>
```

End-to-end through the SDK (from `..`):

```
./run-matrix.sh out main=<pi-coding-agent package dir>
node run-scenario.mjs --sdk <pi-coding-agent package dir> --scenario tex-usepackage-chars --json
```

## 3. Results

### 3.1 New unit tests, before and after

| Tree | `packages/ai/test/json-parse.test.ts` (7 tests) |
|---|---|
| upstream `7d75a0e3e` | **3 failed / 4 passed** — `repairJson` doubling of non-hex `\u`; `parseStreamingJson` parity with `\c`; later properties kept |
| patched (Windows `cf79153df`) | 7/7 passed; adjacent `anthropic-sse-parsing`, `assistant-message-frame`, `openai-responses-partial-json-cleanup` all pass (35 tests) |
| patched (Linux) | same |

### 3.2 End-to-end matrix (openai-completions provider path, public SDK)

Unpatched 1.0.1 / 1.1.0 / 1.2.0 / main are identical in outcome on both platforms (`evidence/win-baseline-*.txt`,
`evidence/linux-baseline-main.txt`). Patched main (`evidence/win-patched-main-254edb710.txt`, `evidence/linux-patched-main.txt`):

| Scenario | Unpatched (all four versions) | Patched main |
|---|---|---|
| `note-url` | tool not executed, schema validation error | `{"text":"See \\url{https://example.org/paper}"}` → `noted (35 chars)` |
| `note-u-short` (`x\u12`) | tool not executed | `{"text":"x\\u12"}` → `noted (5 chars)` |
| `tex-usepackage` | `{"path":"main.tex"}` → `wrote main.tex (NO CONTENT)` | `content` 46 chars preserved |
| `note-cite`, `tex-cite` (controls, `\c` `\d`) | repaired | unchanged |
| `note-valid` (already `\\`-escaped) | correct | unchanged |
| `note-u-valid` (`caf\u00e9 \u2014`) | `café — ok` | unchanged |
| `abort-slow-tool` (unrelated C2 control) | `stopReason=error` | unchanged |

Anthropic provider path (`evidence/tmp-anthropic-invalid-u.test.ts`, run inside the checkout then deleted): with the
upstream file the tool call lacks `content`; with the patch it is `{ path: "main.tex", content: "\\usepackage{graphicx}" }`.

### 3.3 Streaming semantics: one character per delta

`evidence/win-char-streaming-intermediate-states.txt` (Linux counterpart identical) lists every distinct parsed-arguments
state observed on `message_update`/`toolcall_delta` while the fake server streams the arguments one character at a time.

- `note-url-chars`: 1.2.0 and patched main produce the **identical** sequence `{}` → `{"text":""}` → … → `{"text":"See "}` → `{}`
  (collapse when `\u` arrives, exactly as `\c` collapses today); patched main then adds one final state with the full,
  repaired arguments. 1.2.0 ends on `{}`.
- `tex-usepackage-chars`: identical 12 intermediate states; patched adds the final complete object.
- `note-u-valid-chars` (`\u00e9` split across deltas): identical 9 states on both; never flickers to a literal backslash.

Conclusion: the change is invisible mid-stream and only alters the terminal state of inputs that previously could not
parse at all.

### 3.4 Differential probe (`differential-repair.output.txt`) and why the previous-round patch was dropped

20 corpus strings, 588 prefixes, three variants (A upstream, B this patch, C previous-round patch `ab9c50d93` with a
"keep `\u` when cut off inside the escape" branch):

- A vs B: **12 differing prefixes, all 12 are complete inputs** (the LaTeX / invalid-`\u` cases). Zero intermediate differences.
- B vs C: **0 differences** through `parseStreamingJson` or `parseJsonWithRepair`. `partial-json` threw on 0 prefixes, so the
  third fallback tier (`partialParse(repairJson(x))`) is never reached for string-level faults inside objects or arrays;
  `parseObj`/`parseArr` catch everything and return the partial container. The extra branch in C was therefore
  unobservable through any caller, which is why the +22 −3 patch was replaced by this one-line change.

An independent adversarial review (§12) extended this with a ~770k-input prefix fuzz: `regress: 0`, `oldNonEmptyChanged: 0`.

### 3.5 Linux and the full upstream suite

Server: Ubuntu 24.04, Node 22.20.0, 4 vCPU. Tools installed in user space only (`~/.local/bin/{rg,fd}`,
`~/.cargo` rustup 1.96.0 per `packages/env/daemon/rust-toolchain.toml`); no system packages, services or
production containers touched. The previous round's Linux failures (grep/find tests: `rg`/`fd` missing; `pi-env` suites:
daemon not built) were environment gaps and are closed. The `pi-env` tests needed `cargo build` of `packages/env/daemon`, not sshd.

| Run | Result |
|---|---|
| `./test.sh` on **unpatched** `7d75a0e3e` | **exit 0, 0 FAIL** (all packages; `pi-ai` 144 files / 1342 tests, 868 skipped without keys) |
| `npm run check` on patched tree (Windows and Linux) | exit 0, biome applied no fixes |
| `./test.sh` on patched `eb8e28f00` (first commit of this change), run 1 and run 2 | exit 1 both times, the same two tests: `packages/ai/test/radius-oauth.test.ts` "exchanges the browser callback code…" (30 s timeout + unhandled `fetch failed / other side closed` from the local OAuth test server) and `packages/coding-agent/test/auth-storage.test.ts` "keeps a coalesced reload alive…" (`old` instead of `new`). Neither file imports `json-parse`. |
| Isolation, patched tree | `radius-oauth` 3/3 pass; `auth-storage` fails 3 of 5 runs |
| Isolation, **unpatched** `pi-ai` source + rebuilt dist, same machine | `radius-oauth` 3/3 pass; `auth-storage` fails 3 of 5 runs |
| Windows, patched | `auth-storage` 3/3 pass (28 passed, 2 skipped per run) |
| `./test.sh` on the final patch (`dc32372af`) | exit 1 with **one** failure, `auth-storage` again; the whole `pi-ai` package is green (145 files / 1349 tests incl. `radius-oauth`). Full ledger in `evidence/linux-test-sh-summary.txt`. |

Reading: both failures are pre-existing flakiness of upstream tests on this Linux box (lock/reload race in
`AuthStorage`, and a local OAuth server that times out under full-suite load). They fail at the same rate with and
without the patch and pass on Windows. The unpatched full run happened to pass. This is stated plainly rather than hidden:
a maintainer running CI will see their own flake rate, not ours.

Windows full `./test.sh` was not run because the development shell carries `ANTHROPIC_*` credentials for the coding
assistant; upstream's rule is to never run the full suite where provider env vars are present. Windows evidence is the
targeted tests, `npm run check`, and the end-to-end harness.

## 4. Source diff

```diff
diff --git a/packages/ai/src/utils/json-parse.ts b/packages/ai/src/utils/json-parse.ts
index f39f9f09d..282b7e078 100644
--- a/packages/ai/src/utils/json-parse.ts
+++ b/packages/ai/src/utils/json-parse.ts
@@ -1,6 +1,7 @@
 import { parse as partialParse } from "partial-json";
 
-const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
+// `\u` is not listed: it is only valid with four hex digits, which repairJson checks separately.
+const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
 
 function isControlCharacter(char: string): boolean {
 	const codePoint = char.codePointAt(0);
```

The unchanged surrounding logic, for the reviewer's convenience:

```ts
if (char === "\\") {
	const nextChar = json[index + 1];
	if (nextChar === undefined) { repaired += "\\\\"; continue; }           // trailing backslash
	if (nextChar === "u") {
		const unicodeDigits = json.slice(index + 2, index + 6);
		if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) { repaired += `\\u${unicodeDigits}`; index += 5; continue; }
	}
	if (VALID_JSON_ESCAPES.has(nextChar)) { repaired += `\\${nextChar}`; index += 1; continue; }
	repaired += "\\\\";                                                    // invalid escape: literal backslash
	continue;
}
```

With `"u"` removed, a `\u` that fails the four-hex test falls through to the last line like `\c` does. An alternative
with identical behaviour (keep `"u"`, add an `else` doubling inside the `\u` branch) is three lines and duplicates the
fall-through; the Set removal is the minimal diff.

## 5. Regression tests (`json-parse.test.ts`, 7 tests)

- `repairJson` doubles non-hex `\u`: `\url`, `\usepackage`, `C:\users\x` (both `\u` and `\x`), `\u12G4`, `x\u12` and `x\u00`
  (fewer than four characters before the closing quote), `\ukey` in a property name.
- `repairJson` leaves unchanged and `JSON.parse`-able: `\n`, `\"`, `\t`, `\u00e9`, surrogate pair `\ud83d\ude00`, already
  doubled `\\url{x}` and `\\u0041`.
- `repairJson` escapes a raw control character (existing behaviour, baseline for a previously untested file).
- `parseStreamingJson`: `\c` and `\u` repaired identically; `path`/`content`/`mode` all kept after the faulty value; valid
  `\u` kept; a stream cut inside `\u00` or right after `\u` still salvages `{"path":"main.tex","content":"caf"}` (guards
  streaming semantics).

Upstream style followed: tabs, `String.raw`, line width 120, `.ts` import specifier, vitest `describe/it`, no helpers,
no emoji literals (the surrogate pair is written as a JS escape). `npm run check` passes with no reformatting.
Upstream's rule "add a comment with the GitHub issue number next to regression tests" cannot be met yet because no
Issue exists; add `// #<issue>` to the `\u` tests once the Issue number is known.

## 6. Behaviour changes, exhaustively

Changed:

- `repairJson(x)` for any `x` containing, inside a string literal, a backslash followed by `u` where the next four
  characters are not all hex digits (including fewer than four characters remaining): the backslash is doubled. Before:
  kept verbatim.
- Therefore `parseJsonWithRepair` / `parseStreamingJson` now succeed on complete JSON whose only defect is such a `\u`,
  returning the literal backslash sequence, instead of failing / falling back to a truncated object.
- `parseJsonWithRepair` on *complete* but still-unparseable input containing such a `\u` now throws the error from
  parsing the repaired string instead of the original error. Only one caller sees that error: `anthropic-messages.ts`
  wraps it into `Could not parse Anthropic SSE event …` — message text may differ, control flow identical.

Unchanged:

- Any input that parsed or was repaired before (differential + fuzz: zero differences on previously-successful inputs;
  `repairJson` only runs after `JSON.parse` has failed, so well-formed input never reaches it).
- `\uXXXX` with four hex digits, including hex-by-coincidence sequences such as `\udead` or `\uabcd` in a path: still
  treated as a unicode escape, as before. Not fixable at this layer and not attempted.
- Every intermediate `parseStreamingJson` state during streaming (tier 2 parses the original text with `partial-json`).
- `partial-json` version and usage; no new state, branch, helper, dependency or export.

## 7. Potential regressions and known trade-off

| Concern | Assessment |
|---|---|
| **Known trade-off**: a *complete* payload where the model truncated a real escape, e.g. `{"a":"caf\u00e","b":1}` or `{"a":"\ud83d\ude0"}` | Before: `{}` (field dropped). After: `{"a":"caf\\u00e","b":1}` / lone high surrogate plus literal `\ude0`. The repaired string is "garbage" where the old result was "missing". This is the same policy the repairer already applies to `\c`, `\x` and every other letter, and it only applies to complete inputs, never to streaming prefixes. Worth one sentence in the PR. |
| Property names | Repaired the same way as values (`{"te\ut":1}`), consistent with `\c` today. |
| Odd backslash runs (`\\\url`) | `\\` consumed as a valid pair, then `\u` doubled → `\\\\url` → parses to `\\url`. Same rule as `\\\c` today. |
| Raw-quote desync inside a string (`{"a":"say "hi" \usepackage","b":2}`) | `{"a":"say "}` before and after; the string tracker already desyncs on raw quotes, unchanged. |
| Performance (#9265 complains about per-delta re-parsing) | No extra work: `repairJson` already runs on every delta in tier 1. |
| Open PRs touching the same code | #9461 (defer argument parsing) and #9569 (coerce JSON-encoded arguments) do not touch `json-parse.ts`; no conflict. |
| Anthropic strict-tool grammar mangling (`\ub0b4` → `\b0b4`, #10074) | Different mechanism (dropped `u`, result is valid JSON); unaffected. |

## 8. Upstream rules check

| Rule (AGENTS.md / CONTRIBUTING.md at `7d75a0e3e`) | Status |
|---|---|
| Core minimal, no new abstraction | 1 source line + 1 comment |
| Read target file in full before editing | done (file is 115 lines) |
| Top-level static imports, erasable TS only, no `any`, no emojis in code | complies |
| Use existing test tooling (vitest, `node .../vitest/dist/cli.js --run test/x.test.ts`) | done |
| `npm run check` after code changes, fix all output | exit 0, Windows and Linux |
| `./test.sh` must pass before PR | unpatched green; patched runs show two pre-existing flaky tests (§3.5) |
| Do not edit CHANGELOG | not edited |
| Commit message `fix(ai): …`, informative | `fix(ai): treat \u without four hex digits as an invalid escape in repairJson` |
| Only stage own files, no `git add -A`, no reset/stash/clean | followed; one commit on a private research branch, not pushed |
| New contributor: Issue first (Bug template), own voice, one screen, say if you will implement; wait for `lgtm`; `lgtmi` only unblocks issues | **not yet done — user action** |
| AI-generated text must be labelled | the Issue must be written by the user; if AI-drafted text is reused, add a clearly labelled comment |
| Regression test references issue number | add after Issue exists |
| Weekend submissions deprioritised | 2026-10-13 is a Tuesday |

## 9. Related upstream items (checked 2026-10-13)

- No Issue or PR describes this `\u` gap. Searched: "unicode escape", "invalid escape", "repairJson", "json-parse", "\u".
- #6274 (closed, no-action): GLM-5.2 single-escaped backslashes in `edit` args — the general class, no `\u` angle.
- #8858 (closed, no-action): fenced `arguments` → `{}`; describes the same "partial-json truncates → `{}`" failure mode.
- #6762 (closed; `lgtm` given): control characters in tool JSON → led to the current `repairJson` design.
- #10074 (open): Anthropic strict tools drop the `u` of `\uXXXX` → `\b`/`\f`; related symptom, different cause.
- #9643, #9897 (closed): other malformed-argument-stream reports; maintainer asked for current version / exact wiring.
- #3694 (closed): a test-only PR for `repairJson`/`parseStreamingJson`, auto-closed by the gate, never reviewed.
- Open PRs #9461, #9569: adjacent, no file overlap.
- #9265 (open): O(n²) re-parsing of streamed arguments — argues against adding work per delta; this patch adds none.

## 10. Recommended contribution strategy

1. The user opens a **Bug Report** Issue in their own words (not this text), labelled `pkg:ai`, roughly containing:
   package and versions (1.0.1–1.2.0, main `7d75a0e3e`), the five-line repro from §2 with its three outputs, one sentence
   on the cause (`"u"` in the single-character escape set makes the four-hex check dead), one sentence on impact
   (field loss without an error for LaTeX `\url`/`\usepackage` and `C:\users\…` content), and "I have a one-line fix with
   tests and would like to send the PR". If any AI-drafted sentence is pasted, follow up with a clearly labelled comment.
2. Wait for `lgtm` (not just `lgtmi`).
3. Then push the branch and open the PR with the commit as-is; add the `// #<issue>` comments to the `\u` tests first.
   Suggested PR body: the commit message, the known trade-off from §7, and "npm run check and ./test.sh pass" with the
   Linux evidence (name the two flaky tests honestly if they fail in CI too).
4. Do not bundle anything else (C2/C3) into that PR.

## 11. Questions an independent reviewer should try to answer

- Can you construct an input that parsed successfully before and parses differently now? (We could not; §3.4, §12.)
- Is there a streaming prefix whose intermediate result changes? (None over 588 hand-built prefixes and ~770k fuzzed ones.)
- Is the one-line comment useful or noise? (Kept to stop someone re-adding `"u"`; the reviewer in §12 called it defensible.)
- Should the four-hex check be restructured instead? (Any restructuring changes more lines for the same behaviour.)
- Would a maintainer prefer the test file merged into `anthropic-sse-parsing.test.ts`'s existing "repairs malformed…" test
  instead of a new file? (A unit file isolates the shared utility; both are defensible.)
- Is the known trade-off in §7 acceptable? (We argue yes: parity with every other invalid escape.)

## 12. Independent adversarial review (2026-10-13, separate agent, fresh context)

Method reported by the reviewer: built old and new copies of `json-parse.ts`, hand-crafted differentials plus a ~770k-input
prefix fuzz mixing `\`, `u`, hex, `"`, braces and control characters; ran the test file; biome check.

Verdict: **ACCEPT-WITH-NITS**.

- No regression for well-formed or previously-repairable input (proof: `repairJson` only runs after `JSON.parse` throws; the
  string tracker agrees with `JSON.parse` on any accepted output; fuzz `regress: 0`).
- No streaming intermediate-state change (tier 2 parses the original; tier 3 unreachable for objects/arrays).
- Known trade-off (§7) identified and judged acceptable.
- SHOULD-FIX applied: emoji literal in the test replaced by a JS escape; `C:\users\x` added to tests and commit message.
- NITs applied: redundant layer assertions removed (test count 9 → 7); boundaries `\\u0041` and `x\u00"` added.
- NIT not applied: shortening the one-line comment (kept as written).
