"""A/B session runner for the academic-figure-skill evaluation.

Usage:
  python run_ab.py --task t1_grouped_bar_en --arm A --rep 1
  python run_ab.py --plan plan.json --concurrency 2     # list of {task, arm, rep}

Each session = one headless `claude -p` run in an isolated run directory. After the session the
operator re-executes figure.py in a fresh verify/ directory (reproducibility + data-fidelity instrumentation).
Every call is appended to runs/ledger.json (budget source of truth).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TASKS = ROOT / "tasks"
RUNS = ROOT / "runs"
SKILL_DIR = ROOT / "skill-source" / "academic-figure-skill"
LEDGER = RUNS / "ledger.json"
_ledger_lock = threading.Lock()

# Pilot finding (2026-10-13, quarantined in runs/_invalid_pilot): with --permission-prompts none plus a Bash
# allow-list, every file-creation path (heredoc, touch, Edit) was auto-denied, so arm A could not deliver at all.
# The sessions therefore run with permissions bypassed inside their isolated run directory, with an explicit DENY
# list for package installation, network and git. The skill clone is checked with `git status` after each arm-B run.
DISALLOWED_TOOLS = [
    "Bash(pip *)", "Bash(pip3 *)", "Bash(python -m pip *)", "Bash(python3 -m pip *)", "Bash(py -m pip *)",
    "Bash(uv *)", "Bash(conda *)", "Bash(npm *)", "Bash(npx *)", "Bash(git *)", "Bash(curl *)", "Bash(wget *)",
    "Bash(Rscript *)", "Bash(R *)", "WebFetch", "WebSearch", "Agent", "Task",
]
MAX_TURNS = 40
MAX_BUDGET_USD = 6.0  # default; --budget overrides (protocol amendment 1 for replication runs)


def resolve_claude_cli() -> list[str]:
    """Return the argv prefix that launches the Claude Code CLI via node (avoids cmd.exe quoting)."""
    pkg = Path(os.environ["APPDATA"]) / "npm" / "node_modules" / "@anthropic-ai" / "claude-code"
    meta = json.loads((pkg / "package.json").read_text(encoding="utf-8"))
    bin_field = meta.get("bin")
    rel = bin_field["claude"] if isinstance(bin_field, dict) else bin_field
    entry = pkg / rel
    if not entry.exists():
        raise SystemExit(f"claude entry not found: {entry}")
    if entry.suffix.lower() == ".exe":
        return [str(entry)]
    return ["node", str(entry)]


def load_task(task_id: str) -> dict:
    return json.loads((TASKS / task_id / "task.json").read_text(encoding="utf-8"))


def base_prompt(task: dict) -> str:
    files = "\n".join(f"- `{f}`" for f in task["files"])
    lang_note = (
        "The figure language is Chinese (zh-CN): all axis titles, tick labels, legends and annotations must be in "
        "Chinese and must render correctly in the PDF (no missing-glyph boxes). Chinese fonts installed on this "
        "machine include SimSun, SimHei, Microsoft YaHei (C:/Windows/Fonts) and FandolSong/FandolHei (MiKTeX); "
        "use matplotlib.font_manager to locate one and register it explicitly."
        if task["lang"] == "zh"
        else "The figure language is English."
    )
    return f"""# Task: produce one publication-quality academic figure

You are working in an isolated directory (your current working directory). All input files are already here:
{files}

Figure type: {task["figure_type"]}

Scientific intent / message:
{task["intent"]}

Target / format:
{task["target"]}
{lang_note}

## Mandatory deliverables (exact relative paths)

1. `figure.py` — ONE self-contained Python 3 script using matplotlib (numpy / pandas allowed). It must read the
   input files from the current directory by relative path, and save BOTH `out/figure.pdf` (vector) and
   `out/figure.png` (300 dpi). `python figure.py` must be re-runnable deterministically from this directory.
2. `out/figure.pdf` and `out/figure.png` — actually produced by running your script here.
3. `NOTES.md` — short notes: design decisions, how each data column maps to a visual element, any data that was
   dropped or transformed (there must be none dropped), fonts used, and the QA you performed.

## Hard constraints

- Use ALL provided data rows exactly as given. Never fabricate, round away, resample, or "clean" values.
- Runtime: Python 3.11 with matplotlib 3.11, numpy, pandas ONLY. No seaborn, no R, no Graphviz, no internet,
  and package installation is NOT permitted (do not run pip).
- Create files with Bash (e.g. `cat > figure.py << 'EOF' ... EOF`) or with python; run the script with
  `python figure.py` and confirm the outputs exist. Fix errors until the script runs cleanly.
- The author has already confirmed the figure plan. Do not ask questions; proceed to completion autonomously.
- When everything is in place, reply with a single final line: DONE
"""


def skill_prompt(task: dict) -> str:
    skill_md = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    skill_path = str(SKILL_DIR).replace("\\", "/")
    header = f"""<skill name="academic-figure-skill" location="{skill_path}">
The following skill has been activated for this task. Its supporting files (references/*.md, scripts/*.py,
assets/figures/<type>/) are readable at the location above (read-only; do not modify them). Follow the skill's
workflow end-to-end: load the "Always Load" references, run the production asset scan and Copy-First / parameter
inheritance logic, inject the style baseline, run its data validation and QA protocol, and include its
Statistics & Reproducibility Report inside NOTES.md. Where the skill would ask the user a question, the user has
already answered: the plan below is confirmed; the archetype/panel count follow the task text.
Environment note for the skill's Step 2: Python 3.11 available; R is NOT available; package installation is NOT
permitted — handle this exactly as the skill instructs (inform in NOTES.md, degrade explicitly, never silently).

{skill_md}
</skill>

"""
    return header + base_prompt(task)


def append_ledger(entry: dict) -> None:
    with _ledger_lock:
        data = json.loads(LEDGER.read_text(encoding="utf-8")) if LEDGER.exists() else []
        data.append(entry)
        LEDGER.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def run_session(task_id: str, arm: str, rep: int, dry: bool = False, budget: float = MAX_BUDGET_USD) -> dict:
    task = load_task(task_id)
    run_id = f"{task_id}__{arm}__r{rep}"
    run_dir = RUNS / run_id
    if run_dir.exists() and (run_dir / "claude_result.json").exists():
        print(f"[skip] {run_id} already has a result")
        return json.loads((run_dir / "claude_result.json").read_text(encoding="utf-8"))
    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True)
    for f in task["files"]:
        shutil.copy(TASKS / task_id / f, run_dir / f)
    prompt = skill_prompt(task) if arm == "B" else base_prompt(task)
    (run_dir / "prompt.txt").write_text(prompt, encoding="utf-8")

    cmd = resolve_claude_cli() + [
        "-p", "--bare", "--no-session-persistence", "--output-format", "json",
        "--max-turns", str(MAX_TURNS), "--max-budget-usd", str(budget),
        "--dangerously-skip-permissions", "--disallowedTools", *DISALLOWED_TOOLS,
    ]
    if arm == "B":
        cmd += ["--add-dir", str(SKILL_DIR)]
    (run_dir / "command.json").write_text(json.dumps(cmd, indent=2), encoding="utf-8")
    if dry:
        print("[dry]", run_id, " ".join(cmd))
        return {}

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["MPLBACKEND"] = "Agg"
    t0 = time.time()
    print(f"[start] {run_id}")
    proc = subprocess.run(
        cmd, cwd=str(run_dir), input=prompt.encode("utf-8"), capture_output=True, env=env, timeout=60 * 40,
    )
    wall = time.time() - t0
    (run_dir / "session_stdout.txt").write_bytes(proc.stdout)
    (run_dir / "session_stderr.txt").write_bytes(proc.stderr)
    try:
        result = json.loads(proc.stdout.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        result = {"parse_error": True, "returncode": proc.returncode}
    result["_run_id"] = run_id
    result["_wall_seconds"] = round(wall, 1)
    (run_dir / "claude_result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    append_ledger({
        "run_id": run_id, "task": task_id, "arm": arm, "rep": rep, "budget_cap_usd": budget,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t0)),
        "wall_seconds": round(wall, 1),
        "cost_usd": result.get("total_cost_usd"), "num_turns": result.get("num_turns"),
        "subtype": result.get("subtype"), "is_error": result.get("is_error"),
        "session_id": result.get("session_id"),
        "input_tokens": (result.get("usage") or {}).get("input_tokens"),
        "cache_creation": (result.get("usage") or {}).get("cache_creation_input_tokens"),
        "cache_read": (result.get("usage") or {}).get("cache_read_input_tokens"),
        "output_tokens": (result.get("usage") or {}).get("output_tokens"),
        "permission_denials": len(result.get("permission_denials") or []),
    })
    print(f"[done] {run_id} subtype={result.get('subtype')} turns={result.get('num_turns')} cost=${result.get('total_cost_usd')} wall={wall:.0f}s")
    if arm == "B":
        st = subprocess.run(["git", "status", "--short"], cwd=str(SKILL_DIR), capture_output=True, text=True)
        (run_dir / "skill_dir_git_status.txt").write_text(st.stdout, encoding="utf-8")
        if st.stdout.strip():
            print(f"[WARN] {run_id}: skill directory modified by session: {st.stdout!r}")
    verify_run(run_dir, task)
    return result


VERIFY_WRAPPER = r'''
import json, runpy, sys, os
import pandas as pd, numpy as np
loaded = []
_orig_read_csv = pd.read_csv
def _rc(*a, **k):
    df = _orig_read_csv(*a, **k)
    loaded.append({"api": "pd.read_csv", "arg": str(a[0]) if a else str(k.get("filepath_or_buffer")), "rows": int(df.shape[0]), "cols": int(df.shape[1])})
    return df
pd.read_csv = _rc
for name in ("loadtxt", "genfromtxt"):
    _o = getattr(np, name)
    def _mk(_o=_o, name=name):
        def f(*a, **k):
            arr = _o(*a, **k)
            loaded.append({"api": "np." + name, "arg": str(a[0]) if a else "", "rows": int(getattr(arr, "shape", [0])[0]) if getattr(arr, "ndim", 0) else 0})
            return arr
        return f
    setattr(np, name, _mk())
import builtins, json as _json
_orig_json_load = _json.load
def _jl(fp, *a, **k):
    obj = _orig_json_load(fp, *a, **k)
    loaded.append({"api": "json.load", "arg": getattr(fp, "name", "?")})
    return obj
_json.load = _jl
rand_calls = []
_orig_default_rng = np.random.default_rng
def _drng(*a, **k):
    rand_calls.append({"api": "default_rng", "seed": repr(a[0]) if a else None})
    return _orig_default_rng(*a, **k)
np.random.default_rng = _drng
_orig_seed = np.random.seed
def _seed(*a, **k):
    rand_calls.append({"api": "seed", "seed": repr(a[0]) if a else None}); return _orig_seed(*a, **k)
np.random.seed = _seed
status = {"ok": True, "error": None}
try:
    runpy.run_path("figure.py", run_name="__main__")
except SystemExit as e:
    status["ok"] = (e.code in (None, 0)); status["error"] = f"SystemExit({e.code})" if not status["ok"] else None
except Exception as e:
    import traceback; status["ok"] = False; status["error"] = traceback.format_exc()[-3000:]
json.dump({"status": status, "loaded": loaded, "rand_calls": rand_calls}, open("verify_meta.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
'''


def verify_run(run_dir: Path, task: dict) -> None:
    """Re-execute figure.py in a clean verify/ directory with instrumentation."""
    v = run_dir / "verify"
    if v.exists():
        shutil.rmtree(v)
    v.mkdir()
    script = run_dir / "figure.py"
    meta = {"script_present": script.exists()}
    if not script.exists():
        (v / "verify_result.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
        print(f"[verify] {run_dir.name}: figure.py missing")
        return
    shutil.copy(script, v / "figure.py")
    for f in task["files"]:
        shutil.copy(run_dir / f, v / f)
    (v / "_verify_wrapper.py").write_text(VERIFY_WRAPPER, encoding="utf-8")
    env = dict(os.environ)
    env["MPLBACKEND"] = "Agg"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONWARNINGS"] = "default"
    t0 = time.time()
    try:
        proc = subprocess.run([sys.executable, "_verify_wrapper.py"], cwd=str(v), capture_output=True, env=env, timeout=240)
        meta.update({"returncode": proc.returncode, "timed_out": False})
        (v / "stderr.txt").write_bytes(proc.stderr)
        (v / "stdout.txt").write_bytes(proc.stdout)
    except subprocess.TimeoutExpired as e:
        meta.update({"returncode": None, "timed_out": True})
        (v / "stderr.txt").write_bytes(e.stderr or b"")
    meta["seconds"] = round(time.time() - t0, 1)
    meta["pdf_present"] = (v / "out" / "figure.pdf").exists()
    meta["png_present"] = (v / "out" / "figure.png").exists()
    (v / "verify_result.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"[verify] {run_dir.name}: rc={meta.get('returncode')} pdf={meta['pdf_present']} png={meta['png_present']}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task")
    ap.add_argument("--arm", choices=["A", "B"])
    ap.add_argument("--rep", type=int, default=1)
    ap.add_argument("--plan")
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--budget", type=float, default=MAX_BUDGET_USD)
    args = ap.parse_args()
    RUNS.mkdir(exist_ok=True)
    if args.verify_only:
        for d in sorted(RUNS.iterdir()):
            if d.is_dir() and (d / "claude_result.json").exists():
                verify_run(d, load_task(d.name.split("__")[0]))
        return
    if args.plan:
        plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            futs = [ex.submit(run_session, p["task"], p["arm"], p.get("rep", 1), args.dry, args.budget) for p in plan]
            for f in futs:
                f.result()
    else:
        run_session(args.task, args.arm, args.rep, args.dry, args.budget)


if __name__ == "__main__":
    main()
