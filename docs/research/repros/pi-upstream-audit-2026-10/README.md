# Pi upstream audit — standalone reproduction harness (2026-10)

Deterministic, zero-cost reproductions used by
[`PI_UPSTREAM_DEEP_AUDIT_2026_10.md`](../../PI_UPSTREAM_DEEP_AUDIT_2026_10.md) and
[`PI_UPSTREAM_CONTRIBUTION_REVIEW_2026_10.md`](../../PI_UPSTREAM_CONTRIBUTION_REVIEW_2026_10.md).
The candidate upstream patch, its tests and all before/after evidence are in
[`review/`](review/README.md) (**READY FOR ISSUE — NOT SUBMITTED UPSTREAM**; independently reviewed, see its §13).
Nothing here depends on PaperTeam code: the driver talks to the public
`@earendil-works/pi-coding-agent` SDK and to an in-process fake
OpenAI-compatible SSE server.

## Files

| File | Purpose |
|---|---|
| `fake-openai-server.mjs` | In-process `POST /v1/chat/completions` SSE server. The request `model` selects a scenario (tool call with raw LaTeX backslashes, HTTP 500, stall before/after headers, mid-stream TCP drop, slow tool, …). |
| `run-scenario.mjs` | SDK driver: writes a temporary `models.json` pointing at the fake server, creates an `AgentSession` with three custom tools (`add_note`, `write_tex`, `slow_tool`), runs one prompt, records every event and what the tools received, prints a JSON summary. |
| `run-matrix.sh` | Runs the JSON-escape scenarios plus the abort-during-tool scenario against one or more SDK builds and prints a table. |

## Requirements

- Node.js ≥ 22.19 (tested with 22.22.3 on Windows 11 and 22.20.0 on Ubuntu 24.04).
- A directory containing a built `@earendil-works/pi-coding-agent` package (`dist/index.js` present), for example:
  - `npm install --ignore-scripts @earendil-works/pi-coding-agent@1.1.0` in an empty directory → `node_modules/@earendil-works/pi-coding-agent`
  - a built upstream checkout → `<pi>/packages/coding-agent`
- Strip proxy variables when running (`env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY`); the fake server listens on `127.0.0.1`.

## Usage

```bash
# one scenario
node run-scenario.mjs --sdk <pi-coding-agent dir> --scenario note-url --json

# JSON-escape matrix + abort-during-tool, several SDK builds
./run-matrix.sh results/out "v1.1.0=<dir>" "main=<pi>/packages/coding-agent"

# timeout probes
node run-scenario.mjs --sdk <dir> --scenario stall-no-headers    --provider-timeout-ms 3000 --watchdog-ms 15000 --json
node run-scenario.mjs --sdk <dir> --scenario stall-after-headers --http-idle-timeout-ms 3000 --watchdog-ms 15000 --json

# retry probes
node run-scenario.mjs --sdk <dir> --scenario error-500-always --retry --abort-on-retry --json
node run-scenario.mjs --sdk <dir> --scenario tool-then-500-always --retry --retry-base-delay-ms 300 --json
```

## Scenarios

| Scenario | What the fake provider does | What to look at |
|---|---|---|
| `note-url` | tool call `add_note` with raw `{"text":"See \url{…}"}` (invalid `\u` escape) | tool receives `{}` → validation error (bug) |
| `note-cite` | same with `\cite` (invalid `\c` escape) | repaired to a literal backslash (control) |
| `note-valid` | properly escaped JSON | untouched (control) |
| `note-u-short` | `{"text":"x\u12"}` | `{}` before the fix, literal `x\u12` after |
| `note-u-valid` | `café —` | must stay a valid escape |
| `tex-usepackage` | `write_tex` with `content` holding `\usepackage` | `content` silently dropped (bug) |
| `tex-cite` | `write_tex` with `\documentclass` / `\cite` only | content preserved (control) |
| `note-url-chars`, `tex-usepackage-chars`, `note-u-valid-chars` | the same inputs streamed **one character per delta** | the driver's `intermediateArgs` lists every distinct parsed-arguments state seen on `toolcall_delta`, and `toolcallDeltaTrace` the state after every single delta; used to show that the C1 fix changes nothing while the object is still open (see `review/`) |
| `note-url-trailing-ws-chars` | `{"text":"See \url{…}"}` one character per delta, then one more delta containing only `\n` | the closed object is a complete JSON text before the stream ends: unpatched stays `{}` at the `}` and `\n` deltas, patched shows the repaired object from the `}` delta on (the boundary an independent review asked to be stated explicitly) |
| `abort-slow-tool` + `--abort-during-tool` | tool call to a signal-aware sleep, `session.abort()` 1.5 s later | final `stopReason` is `error` + `This operation was aborted` (known upstream bug, PR #8635) |
| `error-500-then-ok`, `error-500-always`, `tool-then-500-then-ok`, `tool-then-500-always` | HTTP 500 sequences | agent-level retry events, `getContextUsage()` after retry omissions |
| `stall-no-headers`, `stall-after-headers`, `stall-after-headers-pings`, `drop-mid-stream` | silence before headers, after headers, with SSE comment pings, TCP destroy mid-stream | which timeout fires, error text |
| `plain` | plain text answer | sanity |

All argument strings in the fake server are written exactly as a model that
forgot to double-escape backslashes would emit them inside the JSON
`arguments` string. No credentials, endpoints or paper data are involved;
the provider API key is the literal `fake-key`.
