"""Deterministic evaluator for all runs (arms A/B) + arm C artefacts.

Writes dashboard/results.json, dashboard/results.md and blinded PNG copies for visual rubric scoring.
Run:  python evaluate.py
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import fitz  # pymupdf

ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
TASKS = ROOT / "tasks"
DASH = ROOT / "dashboard"
SKILL_SCRIPTS = ROOT / "skill-source" / "academic-figure-skill" / "scripts"
ARM_C = ROOT / "paperteam-arm" / "out"

CJK = re.compile(r"[一-鿿]")


def pdf_facts(pdf: Path, expected_labels: list[str], lang: str) -> dict:
    out: dict = {"pdf_bytes": pdf.stat().st_size}
    try:
        doc = fitz.open(pdf)
    except Exception as e:  # noqa: BLE001
        out["pdf_open_error"] = str(e)[:200]
        return out
    out["pdf_pages"] = doc.page_count
    page = doc[0]
    out["pdf_width_mm"] = round(page.rect.width / 72 * 25.4, 1)
    out["pdf_height_mm"] = round(page.rect.height / 72 * 25.4, 1)
    text = "\n".join(p.get_text() for p in doc)
    out["text_chars"] = len(text)
    drawings = 0
    images = 0
    for p in doc:
        drawings += len(p.get_drawings())
        images += len(p.get_images(full=True))
    out["vector_drawings"] = drawings
    out["raster_images"] = images
    out["pdf_vector"] = drawings > 0
    fonts = set()
    embedded_all = True
    for p in doc:
        for f in p.get_fonts(full=True):
            # (xref, ext, type, basefont, name, encoding, referencer)
            name = f[3]
            fonts.add(name)
            # type3 / non-embedded detection: ext == 'n/a' means not embedded
            if f[1] == "n/a":
                embedded_all = False
    out["fonts"] = sorted(fonts)
    out["fonts_embedded_all"] = embedded_all
    norm = text.replace(" ", "").replace("\n", "").lower()
    found = [lab for lab in expected_labels if lab.replace(" ", "").lower() in norm]
    out["labels_found"] = found
    out["labels_missing"] = [lab for lab in expected_labels if lab not in found]
    out["label_recall"] = round(len(found) / max(1, len(expected_labels)), 3)
    if lang == "zh":
        out["cjk_chars_in_text_layer"] = len(CJK.findall(text))
        out["cjk_font_present"] = any(re.search(r"SimSun|SimHei|YaHei|Fandol|Noto|Source Han|Song|Hei|Kai|STSong|STHeiti|PingFang|WenQuanYi", f, re.I) for f in fonts)
    doc.close()
    return out


def script_facts(script: Path, task: dict) -> dict:
    s = script.read_text(encoding="utf-8", errors="replace")
    reads = re.findall(r"read_csv\(|loadtxt\(|genfromtxt\(|json\.load\(|open\(", s)
    out = {
        "script_lines": s.count("\n") + 1,
        "read_calls": len(reads),
        "reads_input_files": [f for f in task["files"] if f in s],
        "uses_np_random": bool(re.search(r"np\.random\.|numpy\.random|random\.(seed|uniform|normal|choice)", s)),
        "uses_seaborn": "seaborn" in s,
        "uses_sample_or_head": bool(re.search(r"\.sample\(|\.head\(\d|\.iloc\[:\s*\d+\]|\.nlargest\(|\.nsmallest\(", s)),
        "sets_font_family": bool(re.search(r"font\.family|font\.sans-serif|FontProperties|fontManager\.addfont", s)),
        "savefig_pdf": "figure.pdf" in s,
        "savefig_png_300": bool(re.search(r"dpi\s*=\s*300", s)),
        "figsize_inches": re.findall(r"figsize\s*=\s*\(([^)]*)\)", s)[:3],
        "sha256": hashlib.sha256(s.encode("utf-8", errors="replace")).hexdigest()[:16],
    }
    return out


def skill_qa(script: Path) -> dict:
    """Run the skill's own QA checkers (its rubric, reported as such)."""
    res = {}
    for mod in ("check_colors", "check_fontsize", "check_dimensions", "check_export"):
        try:
            p = subprocess.run([sys.executable, str(SKILL_SCRIPTS / f"{mod}.py"), str(script)], capture_output=True, text=True, timeout=60, encoding="utf-8", errors="replace")
            res[mod] = {"exit": p.returncode, "tail": (p.stdout or p.stderr)[-600:]}
        except Exception as e:  # noqa: BLE001
            res[mod] = {"exit": None, "tail": str(e)[:200]}
    return res


def second_chance_verify(run: Path, task: dict) -> dict | None:
    """Re-run figure.py once more with out/ pre-created (scripts that rely on the session's `mkdir out`).
    Reported separately as verify2_* so the strict reproducibility result stays visible."""
    v2 = run / "verify2"
    if v2.exists():
        shutil.rmtree(v2)
    v2.mkdir()
    (v2 / "out").mkdir()
    shutil.copy(run / "figure.py", v2 / "figure.py")
    for f in task["files"]:
        shutil.copy(run / f, v2 / f)
    import os
    env = dict(os.environ); env["MPLBACKEND"] = "Agg"; env["PYTHONIOENCODING"] = "utf-8"
    try:
        p = subprocess.run([sys.executable, "figure.py"], cwd=str(v2), capture_output=True, env=env, timeout=240)
        return {"verify2_exec_ok": p.returncode == 0, "verify2_pdf_present": (v2 / "out" / "figure.pdf").exists(), "verify2_stderr_tail": p.stderr.decode("utf-8", "replace")[-300:]}
    except subprocess.TimeoutExpired:
        return {"verify2_exec_ok": False, "verify2_pdf_present": False, "verify2_stderr_tail": "timeout"}


def verify_facts(run: Path, task: dict) -> dict:
    v = run / "verify"
    out = {}
    vr = v / "verify_result.json"
    if vr.exists():
        out.update(json.loads(vr.read_text(encoding="utf-8")))
    vm = v / "verify_meta.json"
    if vm.exists():
        meta = json.loads(vm.read_text(encoding="utf-8"))
        out["verify_exec_ok"] = bool(meta["status"]["ok"])
        out["verify_error"] = (meta["status"]["error"] or "")[-400:] or None
        out["loaded"] = meta["loaded"]
        out["rand_calls"] = meta["rand_calls"]
        # data fidelity: every input CSV loaded with full row count
        expected_rows = {}
        for f in task["files"]:
            if f.endswith(".csv"):
                expected_rows[f] = sum(1 for _ in (TASKS / task["id"] / f).open(encoding="utf-8")) - 1
        loaded_rows = {}
        for l in meta["loaded"]:
            for f in expected_rows:
                if f in str(l.get("arg", "")) and l.get("rows") is not None:
                    loaded_rows[f] = l["rows"]
        out["expected_rows"] = expected_rows
        out["loaded_rows"] = loaded_rows
        out["all_inputs_loaded_full"] = all(loaded_rows.get(f) == n for f, n in expected_rows.items()) if expected_rows else None
    stderr = v / "stderr.txt"
    if stderr.exists():
        se = stderr.read_text(encoding="utf-8", errors="replace")
        out["glyph_missing_warnings"] = len(re.findall(r"Glyph .* missing", se))
        out["font_not_found_warnings"] = len(re.findall(r"findfont: Font family .* not found", se))
        out["stderr_tail"] = se[-500:] if se.strip() else ""
    return out


def evaluate_run(run: Path) -> dict:
    task_id, arm, rep = run.name.split("__")
    task = json.loads((TASKS / task_id / "task.json").read_text(encoding="utf-8"))
    rec = {"run_id": run.name, "task": task_id, "arm": arm, "rep": int(rep[1:]), "lang": task["lang"], "target_width_mm": task["target_width_mm"]}
    cr = run / "claude_result.json"
    if cr.exists():
        r = json.loads(cr.read_text(encoding="utf-8"))
        rec["session"] = {
            "subtype": r.get("subtype"), "is_error": r.get("is_error"), "num_turns": r.get("num_turns"),
            "cost_usd": r.get("total_cost_usd"), "wall_seconds": r.get("_wall_seconds"),
            "input_tokens": (r.get("usage") or {}).get("input_tokens"),
            "cache_creation": (r.get("usage") or {}).get("cache_creation_input_tokens"),
            "cache_read": (r.get("usage") or {}).get("cache_read_input_tokens"),
            "output_tokens": (r.get("usage") or {}).get("output_tokens"),
            "final_line": (r.get("result") or "")[-120:].strip().splitlines()[-1:] ,
        }
    deliver = {
        "figure_py": (run / "figure.py").exists(),
        "notes_md": (run / "NOTES.md").exists(),
        "pdf": (run / "out" / "figure.pdf").exists(),
        "png": (run / "out" / "figure.png").exists(),
    }
    rec["deliverables"] = deliver
    if deliver["figure_py"]:
        rec["script"] = script_facts(run / "figure.py", task)
        rec["skill_qa"] = skill_qa(run / "figure.py")
    rec["verify"] = verify_facts(run, task)
    vpdf = run / "verify" / "out" / "figure.pdf"
    if deliver["figure_py"] and rec["verify"].get("verify_exec_ok") is False and "out/figure" in (rec["verify"].get("verify_error") or ""):
        rec["verify"].update(second_chance_verify(run, task) or {})
        rec["verify"]["missing_outdir_only"] = bool(rec["verify"].get("verify2_exec_ok"))
        if rec["verify"].get("verify2_pdf_present"):
            vpdf = run / "verify2" / "out" / "figure.pdf"
    if vpdf.exists():
        rec["pdf"] = pdf_facts(vpdf, task["expected_labels"], task["lang"])
    elif deliver["pdf"]:
        rec["pdf"] = {"note": "verify re-run produced no PDF; session PDF evaluated instead", **pdf_facts(run / "out" / "figure.pdf", task["expected_labels"], task["lang"])}
    if (run / "skill_dir_git_status.txt").exists():
        rec["skill_dir_modified"] = bool((run / "skill_dir_git_status.txt").read_text(encoding="utf-8").strip())
    if (run / "NOTES.md").exists():
        n = (run / "NOTES.md").read_text(encoding="utf-8", errors="replace")
        rec["notes"] = {"chars": len(n), "mentions_statistics_report": bool(re.search(r"Statistic|统计|Reproducib", n)), "mentions_dropped": bool(re.search(r"drop|丢弃|removed|excluded", n, re.I))}
    return rec


def evaluate_arm_c() -> list[dict]:
    f = ARM_C / "arm_c_results.json"
    if not f.exists():
        return []
    rows = []
    for r in json.loads(f.read_text(encoding="utf-8")):
        task_id = r["task"].replace("__nocycle", "")
        task = json.loads((TASKS / task_id / "task.json").read_text(encoding="utf-8"))
        rec = {"run_id": f"{r['task']}__C", "task": task_id, "arm": "C", "variant": r["task"], "ok": r["ok"], "note": r.get("note"), "ms": r.get("ms"), "failure": r.get("failure"), "unsupported": r.get("unsupported", False)}
        if r.get("ok") and r.get("pdf"):
            rec["pdf"] = pdf_facts(Path(r["pdf"]), task["expected_labels"], task["lang"])
            rec["pdf_path"] = r["pdf"]
        rows.append(rec)
    return rows


def render_png(pdf: Path, png: Path, dpi: int = 150) -> None:
    doc = fitz.open(pdf)
    pix = doc[0].get_pixmap(dpi=dpi)
    pix.save(png)
    doc.close()


def main() -> None:
    DASH.mkdir(exist_ok=True)
    results = []
    for run in sorted(RUNS.iterdir()):
        if run.is_dir() and not run.name.startswith("_") and (run / "claude_result.json").exists():
            results.append(evaluate_run(run))
    armc = evaluate_arm_c()
    (DASH / "results.json").write_text(json.dumps({"ab": results, "arm_c": armc}, ensure_ascii=False, indent=1), encoding="utf-8")

    # blinded PNG gallery for visual rubric
    blind_dir = DASH / "blind"
    if blind_dir.exists():
        shutil.rmtree(blind_dir)
    blind_dir.mkdir()
    blind_map = {}
    items = []
    for r in results:
        src = RUNS / r["run_id"] / "verify" / "out" / "figure.pdf"
        if not src.exists():
            src = RUNS / r["run_id"] / "verify2" / "out" / "figure.pdf"
        if not src.exists():
            src = RUNS / r["run_id"] / "out" / "figure.pdf"
        if src.exists():
            items.append((r["run_id"], src))
    for r in armc:
        if r.get("pdf_path"):
            items.append((r["run_id"], Path(r["pdf_path"])))
    import random
    rng = random.Random(20261013)
    rng.shuffle(items)
    for i, (rid, src) in enumerate(items, start=1):
        bid = f"blind-{i:02d}"
        blind_map[bid] = rid
        try:
            render_png(src, blind_dir / f"{bid}.png")
        except Exception as e:  # noqa: BLE001
            (blind_dir / f"{bid}.ERROR.txt").write_text(str(e), encoding="utf-8")
    (DASH / "blind_map.json").write_text(json.dumps(blind_map, indent=1), encoding="utf-8")

    # markdown summary
    lines = ["# Results (auto)", "", "| run | subtype | turns | cost $ | wall s | py | pdf | verify ok | vector | width mm | fonts emb | label recall | full rows | glyph warn | skill_dir_mod |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        s = r.get("session", {}); d = r["deliverables"]; v = r.get("verify", {}); p = r.get("pdf", {})
        lines.append(f"| {r['run_id']} | {s.get('subtype')} | {s.get('num_turns')} | {s.get('cost_usd') if s.get('cost_usd') is None else round(s['cost_usd'],3)} | {s.get('wall_seconds')} | {int(d['figure_py'])} | {int(d['pdf'])} | {v.get('verify_exec_ok')}{'(+outdir ok)' if v.get('missing_outdir_only') else ''} | {p.get('pdf_vector')} | {p.get('pdf_width_mm')} | {p.get('fonts_embedded_all')} | {p.get('label_recall')} | {v.get('all_inputs_loaded_full')} | {v.get('glyph_missing_warnings')} | {r.get('skill_dir_modified')} |")
    lines += ["", "## Arm C (PaperTeam FigureCompiler, 0 model calls)", "", "| variant | ok | ms | width mm | vector | fonts | label recall | note |", "|---|---|---|---|---|---|---|---|"]
    for r in armc:
        p = r.get("pdf", {})
        lines.append(f"| {r['variant']} | {r['ok']} | {r.get('ms')} | {p.get('pdf_width_mm')} | {p.get('pdf_vector')} | {', '.join(p.get('fonts', []))[:60]} | {p.get('label_recall')} | {(r.get('note') or (r.get('failure') or {}).get('message') or '')[:90]} |")
    (DASH / "results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
