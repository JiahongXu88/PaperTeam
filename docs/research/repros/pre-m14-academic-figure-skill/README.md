# Pre-M14 — academic-figure-skill independent evaluation: reproduction kit

Scripts used for the A/B/C benchmark reported in
[`../../PRE_M14_ACADEMIC_FIGURE_SKILL_EVALUATION.md`](../../PRE_M14_ACADEMIC_FIGURE_SKILL_EVALUATION.md).
They are copied verbatim from the private evaluation directory (`D:\PaperTeamData\AcademicFigureSkillEvaluation`);
no raw model outputs, session logs or rendered figures are committed — only the code and the protocol.

| File | Purpose |
| --- | --- |
| `PROTOCOL.md` | Pre-declared protocol (arms, tasks, metrics, honesty rules) + Amendment 1 (replication budget cap) |
| `make_tasks.py` | Generates the 8 synthetic, seeded benchmark tasks (`tasks/<id>/task.json` + CSV/JSON data) |
| `run_ab.py` | Headless `claude -p` session runner for arms A (baseline) / B (SKILL.md injected + read-only skill dir); isolated run dir per session; ledger; operator re-run (`verify/`) with pandas/numpy instrumentation |
| `evaluate.py` | Deterministic metrics (pymupdf PDF facts, label recall, data-fidelity, skill's own QA checkers, second-chance verify) → `dashboard/results.{json,md}` |
| `dashboard.py` | Static HTML dashboard (`dashboard/index.html`) from `results.json` + rendered PNGs + `visual_rubric.json` |
| `run_arm_c.mjs` | Arm C: drives PaperTeam's existing `FigureCompiler` (backend/dist) on the same datasets, zero model calls |

Reproduction (Windows, Claude Code CLI ≥ 2.1 logged in, Python 3.11 + matplotlib + pandas + pymupdf, MiKTeX):

```bash
cd D:/PaperTeamData/AcademicFigureSkillEvaluation           # or any directory; adjust ROOT-relative paths
git clone --depth 1 https://github.com/TingxiYu/academic-figure-skill skill-source/academic-figure-skill  # commit 1df9940
python tasks/make_tasks.py
python run_ab.py --plan plan_full.json --concurrency 2       # 16 primary sessions, 6 USD cap
python run_ab.py --plan plan_reps.json --concurrency 2 --budget 12   # 6 replications (Amendment 1)
node paperteam-arm/run_arm_c.mjs                             # needs `npm --prefix backend run build` first
python evaluate.py && python dashboard.py
```

Model calls are only made by `run_ab.py`; every call is appended to `runs/ledger.json`.
