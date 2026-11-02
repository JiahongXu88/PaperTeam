#!/usr/bin/env bash
# M16 后续：按冻结选篇顺序逐篇串行运行真实生产链路（PROTOCOL §6 / §7；预算拦截在 production.mjs）。
# 只在 score-b 四项全 PASS 后手动启动。每篇结束记录可用内存与 node 进程数。
set -u
ROOT=/d/PaperTeamData/M16/VerifiedFindingsHybridReview
REPO=/d/Projects/PaperTeam
cd "$REPO"
SEL="$ROOT/B/heldout-selection.json"
rows=$(node -e 'const s=require(process.argv[1]).selected;for(const p of s)console.log(p.id+"|"+p.mdPath.replace(/^benchmark\/MD\//,""))' "D:/PaperTeamData/M16/VerifiedFindingsHybridReview/B/heldout-selection.json")
total=$(echo "$rows" | wc -l)
i=0
for row in $rows; do
  i=$((i+1)); left=$((total-i+1))
  id=${row%%|*}; md=${row#*|}
  echo "[$(date -Is)] start $id ($i/$total, papers-left=$left)"
  node scripts/m16-verified-findings/production.mjs --mode live --case "$id" --tag v2 --papers-left "$left" --md "D:/PaperTeamData/M16/VerifiedFindingsHybridReview/external/cocoreviewbench-md/$md" 2>&1 | grep -v -E "UNDICI|trace-warnings"
  code=${PIPESTATUS[0]}
  free=$(powershell -NoProfile -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)")
  nodes=$(powershell -NoProfile -Command "(Get-Process node -ErrorAction SilentlyContinue).Count")
  echo "[$(date -Is)] end $id exit=$code calls=$(wc -l < $ROOT/budget/calls.jsonl) freeGB=$free nodeProcs=$nodes"
  if [ "$code" = "4" ]; then echo "BUDGET_STOP"; break; fi
done
echo ALL_DONE
