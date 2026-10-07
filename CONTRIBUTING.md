# Contributing to PaperTeam

Thanks for your interest in improving PaperTeam. This project is an academic
research & writing workbench, so two rules matter more than usual: **no
fabricated science** and **no secrets**.

## Setup

```bash
git clone https://github.com/JiahongXu88/PaperTeam.git
cd PaperTeam
npm run install:all
npm run doctor        # Node / dependencies / PDF toolchain self-check
```

Requirements: Node 22/24/25 (see `engines` in `package.json`). Optional:
Python 3.10+ with `pymupdf` (PDF import), a LaTeX distribution (`xelatex` +
`bibtex`) for PDF output tests that compile. Details:
[docs/development.md](docs/development.md).

## Before you open a PR

```bash
npm run typecheck     # backend + frontend
npm run build         # backend tsc + frontend build
npm test              # backend + frontend vitest (scripted agent runtime, no model needed)
git diff --check      # no whitespace errors
```

All three must pass. Backend tests officially run with 4 workers
(`vitest run --maxWorkers=4`); please don't raise that in CI or locally without
reason — PDF/parser subprocess tests are memory-sensitive.

## What we care about in review

- **Determinism over prompting.** Flow control, validation, and gates are
  ordinary TypeScript. If a safety property can be enforced by code, it must be.
- **Test-first for regressions.** If you fix a bug, add the failing test that
  reproduces it. Reliability work follows this repo's "failure shape → fix →
  regression" loop (see `docs/research/` for examples).
- **Research honesty.** Never add a code path that fabricates results, citations,
  or evidence. Feasibility limits, author decisions, and negative results are
  reported honestly.
- **No scope creep in agents.** The agent team is deliberately small
  (`D-0009` in `docs/DECISIONS.md`); new capabilities should usually be tools,
  evidence-layer features, or gate rules, not new agents.
- **UI language.** The workbench UI and docs are written in Chinese; keep new
  user-facing strings consistent with existing tone and terminology
  (`frontend/src/constants/projectMeta.ts` is the label registry).

## No secrets, no confidential data

- Never commit API keys, `.env` files, or anything under `~/.paperteam`.
- Never commit real (unpublished) manuscripts, reviewer comments, or private
  research data as fixtures. Use synthetic content.
- `projects/` and `backend/projects/` are gitignored on purpose — keep it that way.

## Reporting bugs

Open a GitHub issue with: what you did, what you expected, what happened, the
run/stage names from the Workbench (工作流 tab), and your environment
(OS / Node / browser). Attach logs only after removing keys and personal data.

## Security

Please report security issues privately via
[GitHub security advisories](https://github.com/JiahongXu88/PaperTeam/security/advisories/new)
— see [SECURITY.md](SECURITY.md).
