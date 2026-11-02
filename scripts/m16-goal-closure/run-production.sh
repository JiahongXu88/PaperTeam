#!/usr/bin/env bash
# M16 原始目标收口 · C：按冻结选篇顺序逐篇运行真实生产链路（PROTOCOL §2 / §7；预算拦截在 production.mjs）。
set -u
ROOT=/d/PaperTeamData/M16/OriginalQualityGateGoalClosure
REPO=/d/Projects/PaperTeam
cd "$REPO"
for row in $(node -e 'const s=require("D:/PaperTeamData/M16/OriginalQualityGateGoalClosure/B/heldout-selection.json").selected;for(const p of s)console.log(p.id+"|"+p.mdPath.replace(/^benchmark\/MD\//,""))'); do
  id=${row%%|*}; md=${row#*|}
  echo "[$(date -Is)] start $id"
  node scripts/m16-goal-closure/production.mjs --mode live --case "$id" --md "D:/PaperTeamData/M16/OriginalQualityGateGoalClosure/external/cocoreviewbench-md/$md" 2>&1 | grep -v -E "UNDICI|trace-warnings"
  code=${PIPESTATUS[0]}
  echo "[$(date -Is)] end $id exit=$code calls=$(wc -l < $ROOT/budget/calls.jsonl)"
  if [ "$code" = "4" ]; then echo "BUDGET_STOP"; break; fi
done
echo ALL_DONE
