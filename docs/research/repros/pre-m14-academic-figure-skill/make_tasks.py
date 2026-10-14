"""Generate the 8 deterministic benchmark tasks (synthetic data + task.json).

Every number is produced from fixed seeds so data fidelity can be checked mechanically.
Run:  python make_tasks.py   (idempotent; writes tasks/<id>/...)
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent


def write_task(task_id: str, meta: dict, files: dict[str, pd.DataFrame | str]) -> None:
    d = ROOT / task_id
    d.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        if isinstance(content, pd.DataFrame):
            content.to_csv(d / name, index=False, encoding="utf-8")
        else:
            (d / name).write_text(content, encoding="utf-8")
    meta = {"id": task_id, **meta, "files": list(files.keys())}
    (d / "task.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", task_id, list(files.keys()))


# ---------------------------------------------------------------- t1
def t1() -> None:
    rng = np.random.default_rng(101)
    methods = ["SORT", "DeepSORT", "ByteTrack", "Ours"]
    datasets = ["MOT17", "MOT20", "DanceTrack"]
    base = {"SORT": 43.1, "DeepSORT": 45.6, "ByteTrack": 55.8, "Ours": 58.9}
    shift = {"MOT17": 0.0, "MOT20": -4.2, "DanceTrack": -8.7}
    rows = []
    for m in methods:
        for ds in datasets:
            mean = round(base[m] + shift[ds] + rng.normal(0, 0.6), 1)
            std = round(float(rng.uniform(0.3, 1.4)), 2)
            rows.append({"method": m, "dataset": ds, "hota_mean": mean, "hota_std": std, "n_seeds": 3})
    df = pd.DataFrame(rows)
    write_task(
        "t1_grouped_bar_en",
        {
            "lang": "en",
            "figure_type": "grouped bar chart with error bars (benchmark comparison)",
            "intent": "Compare the HOTA score of four multi-object trackers (SORT, DeepSORT, ByteTrack, Ours) on three "
            "benchmarks (MOT17, MOT20, DanceTrack). Error bars are the standard deviation over 3 training seeds "
            "(column hota_std, n_seeds=3). The message: 'Ours' is the best tracker on every benchmark, and the gap is "
            "largest on DanceTrack.",
            "target": "Single-column figure for a two-column IEEE/CVPR-style paper: width 86 mm (3.4 in), height at "
            "your discretion (about 55-65 mm). Font: a standard sans-serif such as Arial/Helvetica/DejaVu Sans, "
            "text legible at print size (7-9 pt).",
            "expected_labels": ["SORT", "DeepSORT", "ByteTrack", "Ours", "MOT17", "MOT20", "DanceTrack", "HOTA"],
            "target_width_mm": 86,
            "paperteam_arm_c": {"kind": "plot", "plotType": "grouped_bar", "note": "no error bars supported"},
        },
        {"data.csv": df},
    )


# ---------------------------------------------------------------- t2
def t2() -> None:
    rng = np.random.default_rng(202)
    variants = ["完整模型", "去除外观特征", "去除运动补偿", "去除轨迹复活", "去除方向约束"]
    means = [71.8, 66.2, 68.9, 69.7, 70.4]
    rows = []
    for v, m in zip(variants, means):
        rows.append({"variant": v, "idf1_mean": round(m + rng.normal(0, 0.15), 1), "idf1_std": round(float(rng.uniform(0.2, 0.9)), 2), "n_runs": 3})
    df = pd.DataFrame(rows)
    write_task(
        "t2_ablation_zh",
        {
            "lang": "zh",
            "figure_type": "ablation bar chart (Chinese labels)",
            "intent": "消融实验：比较完整模型与分别去除四个模块（外观特征、运动补偿、轨迹复活、方向约束）后的 IDF1(%)。"
            "误差棒为 3 次独立训练的标准差（idf1_std, n_runs=3）。核心信息：去除外观特征导致的性能下降最大。"
            "所有坐标轴标题、刻度标签、图例必须使用中文，并在 PDF 中正确渲染（不能出现方框/缺字）。",
            "target": "中文硕士学位论文正文插图：宽 14 cm，高约 7-8 cm。中文字体可用本机已安装的 SimSun / SimHei / "
            "Microsoft YaHei 或 FandolSong / FandolHei（matplotlib 可通过 font_manager 找到）。字号与论文正文五号（10.5 pt）协调。",
            "expected_labels": ["完整模型", "去除外观特征", "去除运动补偿", "去除轨迹复活", "去除方向约束", "IDF1"],
            "target_width_mm": 140,
            "paperteam_arm_c": {"kind": "plot", "plotType": "bar", "note": "CJK labels via ctex; no error bars"},
        },
        {"data.csv": df},
    )


# ---------------------------------------------------------------- t3
def t3() -> None:
    rng = np.random.default_rng(303)
    methods = {"Baseline": (62.0, 0.055), "Baseline+Aug": (65.5, 0.06), "Ours": (69.3, 0.07)}
    rows = []
    for m, (plateau, rate) in methods.items():
        for seed in range(3):
            noise_scale = 0.9
            for epoch in range(1, 61):
                val = plateau * (1 - np.exp(-rate * epoch)) + rng.normal(0, noise_scale) + seed * 0.3
                rows.append({"method": m, "seed": seed, "epoch": epoch, "val_map": round(float(val), 2)})
    df = pd.DataFrame(rows)
    write_task(
        "t3_training_curves_en",
        {
            "lang": "en",
            "figure_type": "training curves: mean line with ±1 std shaded band",
            "intent": "Validation mAP (%) versus training epoch for three methods (Baseline, Baseline+Aug, Ours), "
            "each trained with 3 seeds (seed column). Plot the per-epoch mean across seeds as a line and the ±1 "
            "standard deviation across seeds as a shaded band. Message: Ours converges to a higher plateau and the "
            "ordering is stable after epoch 20.",
            "target": "Single-column figure, width 86 mm, height about 60 mm, sans-serif font, legend not covering data.",
            "expected_labels": ["Baseline", "Baseline+Aug", "Ours", "Epoch", "mAP"],
            "target_width_mm": 86,
            "paperteam_arm_c": {"kind": "plot", "plotType": "line", "note": "mean only; no band"},
        },
        {"data.csv": df},
    )


# ---------------------------------------------------------------- t4
def t4() -> None:
    rng = np.random.default_rng(404)
    classes = ["car", "bus", "truck", "van", "motorcycle", "bicycle"]
    n = len(classes)
    mat = np.zeros((n, n), dtype=int)
    totals = [1840, 312, 455, 388, 221, 197]
    confusion_pairs = {(0, 3): 0.07, (3, 0): 0.11, (1, 2): 0.06, (2, 1): 0.09, (4, 5): 0.12, (5, 4): 0.10, (2, 3): 0.04}
    for i in range(n):
        remaining = totals[i]
        for j in range(n):
            if i == j:
                continue
            p = confusion_pairs.get((i, j), 0.012)
            c = int(round(totals[i] * p + rng.normal(0, 1.5)))
            c = max(c, 0)
            mat[i, j] = c
            remaining -= c
        mat[i, i] = max(remaining, 0)
    df = pd.DataFrame(mat, index=classes, columns=classes)
    df.index.name = "true_class"
    df = df.reset_index()
    write_task(
        "t4_confusion_heatmap_en",
        {
            "lang": "en",
            "figure_type": "row-normalised confusion matrix heatmap with cell annotations",
            "intent": "Confusion matrix of a 6-class vehicle detector (rows = true class, columns = predicted class, "
            "cell = count). Draw the row-normalised matrix (percent of each true class) as a heatmap with a "
            "perceptually uniform sequential colormap, annotate each cell with the percentage (one decimal) and show "
            "the raw count in smaller text or in the notes. Message: the main confusions are van↔car and "
            "motorcycle↔bicycle.",
            "target": "Single-column figure, width 86 mm, square-ish, colorbar labelled, all class names readable.",
            "expected_labels": ["car", "bus", "truck", "van", "motorcycle", "bicycle", "True", "Predicted"],
            "target_width_mm": 86,
            "paperteam_arm_c": None,
        },
        {"confusion.csv": df},
    )


# ---------------------------------------------------------------- t5
def t5() -> None:
    rng = np.random.default_rng(505)
    methods = {"SORT": (58, 9), "DeepSORT": (61, 8.5), "ByteTrack": (69, 7), "OC-SORT": (70.5, 6.5), "Ours": (73, 5.5)}
    rows = []
    for m, (mu, sd) in methods.items():
        vals = np.clip(rng.normal(mu, sd, 40), 20, 98)
        for k, v in enumerate(vals, start=1):
            rows.append({"method": m, "sequence": f"seq{k:02d}", "idf1": round(float(v), 1)})
    df = pd.DataFrame(rows)
    write_task(
        "t5_distribution_en",
        {
            "lang": "en",
            "figure_type": "distribution comparison (box or violin with individual points)",
            "intent": "Per-sequence IDF1 (%) of five trackers over the same 40 test sequences. Show the distribution per "
            "method (box or violin) together with the individual sequence values (strip/jitter), so that both the "
            "median shift and the reduced spread of 'Ours' are visible. Order methods by median.",
            "target": "Single-column figure, width 86 mm, height about 60 mm. No chartjunk.",
            "expected_labels": ["SORT", "DeepSORT", "ByteTrack", "OC-SORT", "Ours", "IDF1"],
            "target_width_mm": 86,
            "paperteam_arm_c": None,
        },
        {"data.csv": df},
    )


# ---------------------------------------------------------------- t6
def t6() -> None:
    rng = np.random.default_rng(606)
    models = ["YOLOv5s", "YOLOv5m", "YOLOv8s", "YOLOv8m", "YOLOX-s", "YOLOX-m", "RT-DETR-R18", "本文方法"]
    params = [7.2, 21.2, 11.2, 25.9, 9.0, 25.3, 20.0, 12.6]
    maps = [37.4, 45.4, 44.9, 50.2, 40.5, 46.9, 46.5, 49.8]
    fps = [156, 98, 141, 87, 132, 85, 108, 119]
    a = pd.DataFrame({"model": models, "params_m": params, "map50_95": maps})
    b = pd.DataFrame({"model": models, "fps": fps})
    rows = []
    for name, (start, rate) in {"基线": (2.8, 0.045), "基线+数据增强": (2.75, 0.05), "本文方法": (2.7, 0.065)}.items():
        for ep in range(1, 81):
            rows.append({"method": name, "epoch": ep, "train_loss": round(float(start * np.exp(-rate * ep) + 0.35 + rng.normal(0, 0.012)), 4)})
    c = pd.DataFrame(rows)
    dets = ["YOLOv8s", "YOLOX-s", "RT-DETR-R18", "本文方法"]
    ious = ["0.50", "0.60", "0.70", "0.80", "0.90"]
    heat = []
    base_ap = {"YOLOv8s": 62.1, "YOLOX-s": 58.9, "RT-DETR-R18": 63.4, "本文方法": 66.2}
    drop = [0, 4.1, 10.2, 21.5, 38.0]
    for d in dets:
        for iou, dr in zip(ious, drop):
            heat.append({"detector": d, "iou_threshold": iou, "ap": round(base_ap[d] - dr + rng.normal(0, 0.4), 1)})
    dmat = pd.DataFrame(heat)
    write_task(
        "t6_multipanel_zh",
        {
            "lang": "zh",
            "figure_type": "2×2 multi-panel composite figure (scatter / bar / line / heatmap), Chinese labels",
            "intent": "学位论文中的综合对比图，四个子图：(a) 各检测器参数量(M)与 mAP@0.5:0.95 的散点图，每个点标注模型名，"
            "突出『本文方法』；(b) 各检测器推理速度 FPS 柱状图；(c) 三种训练设置的训练损失收敛曲线（epoch 1-80）；"
            "(d) 四个检测器在不同 IoU 阈值下 AP 的热图（标注数值）。子图编号 (a)(b)(c)(d) 置于左上角。"
            "全部坐标轴标题与图例使用中文，必须在 PDF 中正确渲染。核心信息：本文方法以中等参数量取得接近最高的精度，"
            "且在高 IoU 阈值下优势更明显。",
            "target": "学位论文整页宽度插图：宽 15 cm，高约 12 cm；中文字体用本机 SimSun / SimHei / Microsoft YaHei / "
            "FandolSong；四个子图风格统一（同一字号、同一配色体系）。",
            "expected_labels": ["参数量", "FPS", "本文方法", "YOLOv8s", "RT-DETR-R18", "训练损失", "IoU", "(a)", "(b)", "(c)", "(d)"],
            "target_width_mm": 150,
            "paperteam_arm_c": None,
        },
        {"a_params_map.csv": a, "b_fps.csv": b, "c_train_loss.csv": c, "d_ap_iou.csv": dmat},
    )


# ---------------------------------------------------------------- t7
def t7() -> None:
    spec = {
        "title": "Overview of the proposed tracking framework",
        "groups": [{"id": "core", "label": "Tracking core (per frame)"}],
        "nodes": [
            {"id": "video", "label": "Input video\nframe t"},
            {"id": "det", "label": "Detector\n(YOLOX)"},
            {"id": "reid", "label": "Appearance\nencoder (ReID)", "group": "core"},
            {"id": "motion", "label": "Motion model\n(Kalman, XYWH)", "group": "core"},
            {"id": "assoc", "label": "Association\n(Hungarian)", "group": "core"},
            {"id": "mgmt", "label": "Track management\nbirth / death / revival", "group": "core"},
            {"id": "mem", "label": "Appearance\nmemory bank"},
            {"id": "out", "label": "Output\ntracks"},
        ],
        "edges": [
            {"from": "video", "to": "det"},
            {"from": "det", "to": "reid", "label": "boxes"},
            {"from": "det", "to": "motion", "label": "boxes"},
            {"from": "reid", "to": "assoc", "label": "embeddings"},
            {"from": "motion", "to": "assoc", "label": "predictions"},
            {"from": "assoc", "to": "mgmt"},
            {"from": "mgmt", "to": "out"},
            {"from": "mem", "to": "assoc", "label": "long-term features"},
            {"from": "mgmt", "to": "mem", "label": "update"},
        ],
    }
    write_task(
        "t7_pipeline_diagram_en",
        {
            "lang": "en",
            "figure_type": "method architecture / pipeline diagram (schematic, no dataset)",
            "intent": "Draw the architecture diagram described in diagram.json: a left-to-right pipeline with 8 nodes "
            "and 9 edges; the four nodes with group=core must be visually grouped inside a labelled container "
            "'Tracking core (per frame)'; the memory bank is a side module that both feeds Association and is "
            "updated by Track management (bidirectional relationship drawn as two edges). Edge labels must be "
            "shown. Use the exact node labels from the JSON (line breaks are '\\n').",
            "target": "Single-column figure, width 86 mm (may use the double-column 178 mm width if legibility requires, "
            "state which), vector PDF, sans-serif, consistent box style, arrows with clear heads, no overlap.",
            "expected_labels": ["Detector", "YOLOX", "Kalman", "Hungarian", "memory bank", "Tracking core", "Output", "embeddings"],
            "target_width_mm": 86,
            "paperteam_arm_c": {"kind": "diagram", "note": "pipeline variant; groups supported; edge labels supported"},
        },
        {"diagram.json": json.dumps(spec, ensure_ascii=False, indent=2)},
    )


# ---------------------------------------------------------------- t8
def t8() -> None:
    rng = np.random.default_rng(808)
    trackers = ["SORT", "DeepSORT", "MOTDT", "JDE", "FairMOT", "CenterTrack", "TraDeS", "ByteTrack", "OC-SORT", "StrongSORT", "BoT-SORT", "Ours"]
    fps = [143, 13.8, 20.6, 18.5, 25.9, 17.5, 15.0, 29.6, 29.0, 7.1, 4.5, 24.2]
    hota = [43.1, 45.6, 46.9, 48.2, 59.3, 52.2, 52.7, 63.1, 63.2, 64.4, 65.0, 65.7]
    params = [0.0, 11.2, 11.2, 65.1, 19.0, 20.1, 20.1, 99.0, 99.0, 110.4, 110.4, 101.3]
    df = pd.DataFrame({"tracker": trackers, "fps": fps, "hota": hota, "params_m": params})
    write_task(
        "t8_pareto_scatter_en",
        {
            "lang": "en",
            "figure_type": "speed–accuracy scatter with labelled points and Pareto frontier",
            "intent": "Scatter of 12 trackers: x = inference speed in FPS (log scale), y = HOTA on MOT17. Label every "
            "point with its tracker name without overlaps, draw the Pareto frontier (upper-right, non-dominated set) "
            "as a step/dashed line, and highlight 'Ours'. Optionally encode params_m as marker size with a size "
            "legend. Message: Ours lies on the frontier with the best HOTA at real-time speed (>20 FPS).",
            "target": "Single-column figure, width 86 mm, height about 65 mm, sans-serif, vector PDF.",
            "expected_labels": ["SORT", "ByteTrack", "OC-SORT", "StrongSORT", "BoT-SORT", "Ours", "FPS", "HOTA"],
            "target_width_mm": 86,
            "paperteam_arm_c": {"kind": "plot", "plotType": "scatter", "note": "no point labels, no frontier, no log axis"},
        },
        {"data.csv": df},
    )


if __name__ == "__main__":
    for fn in (t1, t2, t3, t4, t5, t6, t7, t8):
        fn()
