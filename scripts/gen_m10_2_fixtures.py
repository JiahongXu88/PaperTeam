"""M10.2 deterministic multimodal fixtures generator (PyMuPDF only, no new deps).

Usage: python scripts/gen_m10_2_fixtures.py <out-dir>

Produces:
  line-chart.png     MOT threshold sweep line chart (MOTA/IDF1 vs threshold)
  bar-chart.png      Baseline vs Ours bar chart
  arch-diagram.png   Input->Backbone->Association->Output architecture diagram
  sample.pdf         one-page PDF embedding line-chart.png + caption + context text

All content is deterministic (fixed values: threshold 0.1/0.3/0.5/0.7 ->
MOTA 78.1/80.2/82.4/81.6; Baseline 78.2 vs Ours 82.4) — usable by both the
scripted mock E2E and the live vision smoke.
"""

import json
import os
import sys

import fitz  # PyMuPDF

# ---- deterministic data (shared with assertions) ----
THRESHOLDS = [0.1, 0.3, 0.5, 0.7]
MOTA = [78.1, 80.2, 82.4, 81.6]
IDF1 = [74.0, 76.5, 79.1, 78.2]
BASELINE_MOTA = 78.2
OURS_MOTA = 82.4


def _new_page(w=600, h=450):
    doc = fitz.open()
    page = doc.new_page(width=w, height=h)
    return doc, page


def _save_png(doc, page, path, dpi=150):
    pix = page.get_pixmap(dpi=dpi)
    pix.save(path)
    doc.close()


def line_chart(path):
    doc, page = _new_page()
    shape = page.new_shape()
    ox, oy, x_max, y_min = 70.0, 380.0, 560.0, 50.0
    # frame + axes
    shape.draw_rect(fitz.Rect(ox, y_min, x_max, oy))
    shape.finish(color=(0.1, 0.1, 0.1), width=1.5)
    # x ticks + labels
    for t, x in zip(THRESHOLDS, [130, 250, 370, 490]):
        shape.draw_line(fitz.Point(x, oy), fitz.Point(x, oy + 6))
        shape.finish(color=(0.1, 0.1, 0.1), width=1)
        shape.insert_text(fitz.Point(x - 10, oy + 22), f"{t:.1f}", fontsize=12, color=(0.1, 0.1, 0.1))
    # y ticks + labels (76..84)
    for v in range(76, 85, 2):
        y = oy - (v - 76) / 8 * (oy - y_min)
        shape.draw_line(fitz.Point(ox - 6, y), fitz.Point(ox, y))
        shape.finish(color=(0.1, 0.1, 0.1), width=1)
        shape.insert_text(fitz.Point(ox - 30, y + 4), str(v), fontsize=11, color=(0.1, 0.1, 0.1))
    # MOTA line (blue)
    pts = [fitz.Point(x, oy - (v - 76) / 8 * (oy - y_min)) for x, v in zip([130, 250, 370, 490], MOTA)]
    shape.draw_polyline(pts)
    shape.finish(color=(0.05, 0.25, 0.85), width=3)
    for p in pts:
        shape.draw_circle(p, 4)
        shape.finish(color=(0.05, 0.25, 0.85), fill=None, width=2)
    # IDF1 line (red)
    pts2 = [fitz.Point(x, oy - (v - 76) / 8 * (oy - y_min)) for x, v in zip([130, 250, 370, 490], IDF1)]
    shape.draw_polyline(pts2)
    shape.finish(color=(0.85, 0.15, 0.1), width=3)
    for p in pts2:
        shape.draw_circle(p, 4)
        shape.finish(color=(0.85, 0.15, 0.1), fill=None, width=2)
    # peak annotation
    peak = pts[2]
    shape.insert_text(fitz.Point(peak.x + 8, peak.y - 8), f"peak {MOTA[2]}", fontsize=12, color=(0.05, 0.25, 0.85))
    # titles / legend / axis labels
    shape.insert_text(fitz.Point(170, 28), "Impact of threshold tau on MOTA and IDF1", fontsize=15, color=(0, 0, 0))
    shape.insert_text(fitz.Point(260, 430), "threshold", fontsize=13, color=(0, 0, 0))
    shape.insert_text(fitz.Point(20, 30), "metric", fontsize=13, color=(0, 0, 0))
    shape.draw_line(fitz.Point(400, 30), fitz.Point(430, 30))
    shape.finish(color=(0.05, 0.25, 0.85), width=3)
    shape.insert_text(fitz.Point(436, 35), "MOTA (ours)", fontsize=12, color=(0, 0, 0))
    shape.draw_line(fitz.Point(400, 48), fitz.Point(430, 48))
    shape.finish(color=(0.85, 0.15, 0.1), width=3)
    shape.insert_text(fitz.Point(436, 53), "IDF1 (ours)", fontsize=12, color=(0, 0, 0))
    shape.commit()
    _save_png(doc, page, path)


def bar_chart(path):
    doc, page = _new_page()
    shape = page.new_shape()
    ox, oy, x_max, y_min = 70.0, 380.0, 560.0, 50.0
    shape.draw_rect(fitz.Rect(ox, y_min, x_max, oy))
    shape.finish(color=(0.1, 0.1, 0.1), width=1.5)
    for v in range(70, 90, 5):
        y = oy - (v - 70) / 20 * (oy - y_min)
        shape.draw_line(fitz.Point(ox - 6, y), fitz.Point(ox, y))
        shape.finish(color=(0.1, 0.1, 0.1), width=1)
        shape.insert_text(fitz.Point(ox - 34, y + 4), str(v), fontsize=11, color=(0.1, 0.1, 0.1))
    # bars
    for x0, v, color, label in [
        (170, BASELINE_MOTA, (0.55, 0.55, 0.55), "Baseline"),
        (380, OURS_MOTA, (0.05, 0.25, 0.85), "Ours"),
    ]:
        top = oy - (v - 70) / 20 * (oy - y_min)
        shape.draw_rect(fitz.Rect(x0, top, x0 + 100, oy))
        shape.finish(color=color, fill=color, width=1)
        shape.insert_text(fitz.Point(x0 + 20, top - 8), f"{v}", fontsize=14, color=(0, 0, 0))
        shape.insert_text(fitz.Point(x0 + 18, oy + 22), label, fontsize=13, color=(0, 0, 0))
    shape.insert_text(fitz.Point(200, 28), "MOTA on MOT17: Baseline vs Ours", fontsize=15, color=(0, 0, 0))
    shape.insert_text(fitz.Point(240, 430), "method", fontsize=13, color=(0, 0, 0))
    shape.commit()
    _save_png(doc, page, path)


def arch_diagram(path):
    doc, page = _new_page(520, 560)
    shape = page.new_shape()
    boxes = [
        ("Input", "video frames + detections"),
        ("Backbone", "ResNet-50 features"),
        ("Association", "ByteTrack-style matching"),
        ("Output", "online trajectories"),
    ]
    y = 40.0
    rects = []
    for title, subtitle in boxes:
        rect = fitz.Rect(110, y, 410, y + 80)
        rects.append(rect)
        shape.draw_rect(rect)
        shape.finish(color=(0.05, 0.25, 0.85), width=2.5)
        shape.insert_text(fitz.Point(rect.x0 + 30, rect.y0 + 34), title, fontsize=17, color=(0, 0, 0))
        shape.insert_text(fitz.Point(rect.x0 + 30, rect.y0 + 56), subtitle, fontsize=11, color=(0.3, 0.3, 0.3))
        y += 130
    for a, b in zip(rects, rects[1:]):
        mid_x = (a.x0 + a.x1) / 2
        shape.draw_line(fitz.Point(mid_x, a.y1), fitz.Point(mid_x, b.y0))
        shape.finish(color=(0.1, 0.1, 0.1), width=2.5)
        # arrowhead
        shape.draw_polyline([fitz.Point(mid_x - 7, b.y0 - 12), fitz.Point(mid_x, b.y0), fitz.Point(mid_x + 7, b.y0 - 12)])
        shape.finish(color=(0.1, 0.1, 0.1), width=2)
    shape.insert_text(fitz.Point(150, 20), "Tracker architecture overview", fontsize=15, color=(0, 0, 0))
    shape.commit()
    _save_png(doc, page, path)


def sample_pdf(path, chart_png):
    doc = fitz.open()
    page = doc.new_page()  # A4 595x842
    y = 60.0
    page.insert_text((72, y), "Sensitivity Analysis of Association Threshold", fontsize=18)
    y += 34
    body = (
        "We further evaluate the sensitivity of the association threshold tau on "
        "tracking accuracy. Figure 1 reports MOTA and IDF1 as tau sweeps from 0.1 "
        "to 0.7 on the MOT17 validation split."
    )
    y += 14
    for line in _wrap(page, body, 10.5, 450):
        page.insert_text((72, y), line, fontsize=11)
        y += 16
    y += 10
    # embedded chart + caption (docling extracts this image as a figure)
    page.insert_image(fitz.Rect(110, y, 480, y + 260), filename=chart_png)
    y += 274
    page.insert_text((110, y), "Figure 1: Impact of threshold tau on MOTA and IDF1. MOTA peaks at 82.4 when tau = 0.5.", fontsize=10.5)
    y += 26
    tail = (
        "The curve peaks at the middle of the range: raising tau beyond 0.5 "
        "slightly degrades MOTA to 81.6 while IDF1 drops to 78.2."
    )
    for line in _wrap(page, tail, 10.5, 450):
        page.insert_text((72, y), line, fontsize=11)
        y += 16
    doc.save(path)
    doc.close()


def _wrap(page, text, fontsize, width):
    words = text.split(" ")
    lines, current = [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if fitz.get_text_length(candidate, fontsize=fontsize) <= width:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)
    line = os.path.join(out_dir, "line-chart.png")
    bar = os.path.join(out_dir, "bar-chart.png")
    arch = os.path.join(out_dir, "arch-diagram.png")
    line_chart(line)
    bar_chart(bar)
    arch_diagram(arch)
    sample_pdf(os.path.join(out_dir, "sample.pdf"), line)
    print(json.dumps({
        "lineChart": line,
        "barChart": bar,
        "archDiagram": arch,
        "samplePdf": os.path.join(out_dir, "sample.pdf"),
        "values": {
            "thresholds": THRESHOLDS,
            "mota": MOTA,
            "idf1": IDF1,
            "baselineMota": BASELINE_MOTA,
            "oursMota": OURS_MOTA,
        },
    }))


if __name__ == "__main__":
    main()
