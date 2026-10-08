# M13.2 synthetic fixtures

All numeric values in these ZIPs are invented test inputs, not real research findings.
Rebuild deterministically with `python scripts/m13_2_create_fixtures.py`.

- `synthetic-normal.zip`: main, baseline, ablation, config, JSON, log, notebook.
- `synthetic-incomplete.zip`: missing protocol, damaged CSV, unknown format.
- `synthetic-protocol-conflict.zip`: two incompatible explicit protocols in one candidate group.
- `synthetic-malicious-*.zip`: traversal, case collision, extreme ratio, symlink, nested ZIP.
