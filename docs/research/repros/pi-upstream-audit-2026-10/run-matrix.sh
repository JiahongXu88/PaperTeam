#!/usr/bin/env bash
# Run every scenario against every SDK build and save JSON evidence.
# Usage: ./run-matrix.sh <results-dir> <label=sdkdir> [<label=sdkdir> ...]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$1"; shift
mkdir -p "$out"
scenarios=(note-url note-cite note-valid note-u-short note-u-valid tex-usepackage tex-cite)
printf "%-14s %-16s %-10s %-9s %-34s %s\n" "sdk" "scenario" "stop" "turns" "tool-received-params" "tool-result"
for pair in "$@"; do
	label="${pair%%=*}"; dir="${pair#*=}"
	for s in "${scenarios[@]}"; do
		f="$out/${label}__${s}.json"
		env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY node "$here/run-scenario.mjs" --sdk "$dir" --scenario "$s" --json --quiet > "$f" 2> "$f.err"
		node -e '
			const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
			const params = r.toolReceivedParams.map(p => JSON.stringify(p.params)).join(" | ") || "(tool not executed)";
			const end = r.events.find(e => e.type === "tool_execution_end");
			const res = end ? `${end.isError ? "ERROR: " : ""}${(end.resultText || "").split("\n")[0].slice(0, 90)}` : "-";
			console.log(`${process.argv[2].padEnd(14)} ${r.scenario.padEnd(16)} ${String(r.finalStopReason).padEnd(10)} ${String(r.assistantTurns).padEnd(9)} ${params.slice(0, 34).padEnd(34)} ${res}`);
		' "$f" "$label"
	done
	# abort-during-tool scenario
	f="$out/${label}__abort-slow-tool.json"
	env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY node "$here/run-scenario.mjs" --sdk "$dir" --scenario abort-slow-tool --abort-during-tool --json --quiet > "$f" 2> "$f.err"
	node -e '
		const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		const settled = r.events.find(e => e.type === "agent_settled");
		console.log(`${process.argv[2].padEnd(14)} ${"abort-slow-tool".padEnd(16)} ${String(r.finalStopReason).padEnd(10)} ${String(r.assistantTurns).padEnd(9)} errorMessage=${JSON.stringify(r.finalErrorMessage)} settled.aborted=${settled ? settled.aborted : "n/a"} slowTool=${JSON.stringify(r.slowToolState)}`);
	' "$f" "$label"
done
