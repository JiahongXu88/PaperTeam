"""Build the local evaluation dashboard (static HTML) from dashboard/results.json + rendered PNGs.
Run after evaluate.py:  python dashboard.py  →  dashboard/index.html
"""
from __future__ import annotations

import html
import json
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent
DASH = ROOT / "dashboard"
RUNS = ROOT / "runs"
IMG = DASH / "img"


def render(pdf: Path, png: Path) -> bool:
    try:
        d = fitz.open(pdf)
        d[0].get_pixmap(dpi=160).save(png)
        d.close()
        return True
    except Exception:  # noqa: BLE001
        return False


def main() -> None:
    data = json.loads((DASH / "results.json").read_text(encoding="utf-8"))
    IMG.mkdir(exist_ok=True)
    rubric = {}
    rp = DASH / "visual_rubric.json"
    if rp.exists():
        rubric = json.loads(rp.read_text(encoding="utf-8"))
    tasks: dict[str, dict] = {}
    for r in data["ab"]:
        tasks.setdefault(r["task"], {}).setdefault(f"{r['arm']}r{r['rep']}", r)
    for r in data["arm_c"]:
        tasks.setdefault(r["task"], {})[f"C:{r['variant'].split('__')[-1] if '__' in r['variant'] else 'base'}"] = r

    def img_for(r: dict, key: str) -> str:
        if r.get("arm") == "C":
            if not r.get("pdf_path"):
                return f"<div class='na'>NOT SUPPORTED / REJECTED<br><small>{html.escape(str((r.get('failure') or {}).get('message') or r.get('note') or ''))[:200]}</small></div>"
            src = Path(r["pdf_path"])
        else:
            src = RUNS / r["run_id"] / "verify" / "out" / "figure.pdf"
            if not src.exists():
                src = RUNS / r["run_id"] / "verify2" / "out" / "figure.pdf"
            if not src.exists():
                src = RUNS / r["run_id"] / "out" / "figure.pdf"
            if not src.exists():
                return "<div class='na'>NO PDF DELIVERED</div>"
        png = IMG / f"{r['run_id']}.png"
        if not png.exists() and not render(src, png):
            return "<div class='na'>RENDER ERROR</div>"
        return f"<a href='img/{png.name}' target='_blank'><img src='img/{png.name}'></a>"

    def facts(r: dict) -> str:
        if r.get("arm") == "C":
            p = r.get("pdf", {})
            return f"ok={r['ok']} · {r.get('ms')} ms · {p.get('pdf_width_mm')} mm · fonts {len(p.get('fonts', []))} · labels {p.get('label_recall')}<br><small>{html.escape(r.get('note') or '')}</small>"
        s = r.get("session", {}); v = r.get("verify", {}); p = r.get("pdf", {}); sc = r.get("script", {})
        rub = rubric.get(r["run_id"])
        rub_s = f" · rubric {rub['total']}/25" if rub else ""
        return (f"{s.get('subtype')} · turns {s.get('num_turns')} · ${s.get('cost_usd', 0) or 0:.2f} · {s.get('wall_seconds')} s{rub_s}<br>"
                f"verify_ok={v.get('verify_exec_ok')} full_rows={v.get('all_inputs_loaded_full')} glyph_warn={v.get('glyph_missing_warnings')} np.random={sc.get('uses_np_random')}<br>"
                f"vector={p.get('pdf_vector')} width={p.get('pdf_width_mm')} mm fonts={html.escape(', '.join(p.get('fonts', []))[:70])} labels={p.get('label_recall')}"
                f"{' cjk_font=' + str(p.get('cjk_font_present')) if 'cjk_font_present' in p else ''}")

    rows = []
    for task_id in sorted(tasks):
        cells = tasks[task_id]
        keys = sorted(cells, key=lambda k: (k[0] != "A", k[0] != "B", k))
        tds = "".join(f"<td><div class='k'>{html.escape(k)}</div>{img_for(cells[k], k)}<div class='f'>{facts(cells[k])}</div></td>" for k in keys)
        rows.append(f"<tr><th>{html.escape(task_id)}</th>{tds}</tr>")
    ledger = json.loads((RUNS / "ledger.json").read_text(encoding="utf-8")) if (RUNS / "ledger.json").exists() else []
    cost = sum(e.get("cost_usd") or 0 for e in ledger)
    page = f"""<!doctype html><meta charset='utf-8'><title>Academic Figure Skill A/B dashboard</title>
<style>body{{font-family:Segoe UI,Arial,sans-serif;margin:16px}} table{{border-collapse:collapse}} td,th{{border:1px solid #ccc;vertical-align:top;padding:6px;max-width:360px}}
img{{max-width:340px;max-height:260px;display:block}} .k{{font-weight:bold;color:#246}} .f{{font-size:11px;color:#333;margin-top:4px}} .na{{width:300px;height:120px;background:#f3f3f3;color:#a33;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px}}
th{{text-align:left;background:#f7f7f7}}</style>
<h1>academic-figure-skill — A/B/C dashboard (private, local)</h1>
<p>A = baseline headless Claude session · B = same + SKILL.md injected + read-only skill dir · C = PaperTeam FigureCompiler (0 model calls).
Sessions in ledger: {len(ledger)} · total model cost ${cost:.2f}. Images are 160-dpi renders of the <em>operator re-run</em> PDF (verify/), not the session's own PNG.</p>
<table>{''.join(rows)}</table>
<p>Source of truth: <code>results.json</code>, <code>results.md</code>, <code>runs/ledger.json</code>, <code>visual_rubric.json</code>.</p>"""
    (DASH / "index.html").write_text(page, encoding="utf-8")
    print("dashboard written", DASH / "index.html")


if __name__ == "__main__":
    main()
