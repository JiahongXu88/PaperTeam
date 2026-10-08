"""Rebuild the small, explicitly synthetic M13.2 experiment ZIP fixtures."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[1] / "backend/test/fixtures/experiments"
root.mkdir(parents=True, exist_ok=True)

with ZipFile(root / "synthetic-normal.zip", "w", ZIP_DEFLATED) as z:
    z.writestr("README.md", "SYNTHETIC TEST DATA ONLY. Values are invented solely to test parsing; they are not research results.\n")
    z.writestr("config/experiment.yaml", "model: Ours\ndataset: MOT17\nseed: 42\nprotocol: synthetic-protocol-v1\n")
    z.writestr("config/model.json", json.dumps({"model": "Ours", "batch_size": 8}))
    z.writestr("main/results.csv", "method,dataset,seed,HOTA,IDF1\nOurs,MOT17,42,63.4,76.0\n")
    z.writestr("main/metrics.json", json.dumps({"HOTA": 63.4, "IDF1": 76.0}))
    z.writestr("baselines/baseline_a.csv", "method,dataset,seed,HOTA,IDF1\nBaseline A,MOT17,42,62.1,75.2\n")
    z.writestr("ablation/no_attention.csv", "method,dataset,seed,HOTA,IDF1\nNo attention,MOT17,42,61.2,74.1\n")
    z.writestr("logs/main_train.log", "synthetic training log: model Ours, seed 42\n")
    z.writestr("notebooks/analysis.ipynb", json.dumps({"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}))

with ZipFile(root / "synthetic-incomplete.zip", "w", ZIP_DEFLATED) as z:
    z.writestr("README.md", "SYNTHETIC INCOMPLETE TEST DATA. Protocol deliberately missing.\n")
    z.writestr("results.csv", "method,dataset,seed,score\nA,Sample,1,0.5\n")
    z.writestr("broken.csv", b"method,score\nA,\x00invalid\n")
    z.writestr("unknown.bin", b"synthetic unknown format")

with ZipFile(root / "synthetic-protocol-conflict.zip", "w", ZIP_DEFLATED) as z:
    z.writestr("README.md", "SYNTHETIC CONFLICT TEST DATA ONLY.\n")
    z.writestr("main/results.csv", "method,dataset,protocol,score\nA,Sample,protocol-1,0.5\nA,Sample,protocol-2,0.6\n")

with ZipFile(root / "synthetic-malicious-traversal.zip", "w", ZIP_DEFLATED) as z:
    z.writestr("../outside.csv", "SYNTHETIC TEST ATTACK,score\nA,1\n")
with ZipFile(root / "synthetic-malicious-duplicate.zip", "w", ZIP_DEFLATED) as z:
    z.writestr("main/results.csv", "a,b\n1,2\n")
    z.writestr("MAIN/RESULTS.csv", "a,b\n3,4\n")
with ZipFile(root / "synthetic-malicious-ratio.zip", "w", ZIP_DEFLATED) as z:
    z.writestr("bomb.txt", b"A" * 200_000)
with ZipFile(root / "synthetic-malicious-symlink.zip", "w", ZIP_DEFLATED) as z:
    link = ZipInfo("linked.csv")
    link.create_system = 3
    link.external_attr = 0o120777 << 16
    z.writestr(link, "../../outside.csv")
with ZipFile(root / "synthetic-malicious-nested.zip", "w", ZIP_DEFLATED) as z:
    z.writestr("nested.zip", (root / "synthetic-malicious-ratio.zip").read_bytes())
