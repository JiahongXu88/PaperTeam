# Security Policy

PaperTeam is a self-hosted, single-user research workbench. It stores
manuscripts, evidence, and model API keys on the machine it runs on.

## Reporting a vulnerability

Please report privately via
[GitHub security advisories](https://github.com/JiahongXu88/PaperTeam/security/advisories/new).
Do not open a public issue for security problems.

## What counts as a security issue here

- Anything that exposes stored **API keys** (`~/.paperteam`) or returns them
  through any HTTP endpoint.
- Any path where a project's documents leave the machine other than calls to the
  model provider the user configured (e.g., unintended outbound requests).
- Command injection or argument injection in the subprocess toolchains
  (PDF parsing, LaTeX compilation), especially via uploaded file names or
  project content.
- Authentication/session issues if you deploy the Docker image on a shared host
  (the product is single-user by design; the web endpoint has **no
  authentication** — do not expose it to untrusted networks).

## Non-goals / known boundaries

- No multi-tenancy, no login system (by design, see `docs/DEPLOYMENT.md`).
- Reviewer comments and unpublished manuscripts are sensitive data; the repo's
  issue tracker is not the place for them.
