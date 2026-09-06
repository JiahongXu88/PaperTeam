---
name: verify-citations
description: Use when asked to verify, check, or audit the citations/references in
  a paper draft or preprint — whether each cited work is real, whether its
  authors/venue/year are correct, and whether it actually supports the claim it
  is attached to. Produces a fixed citation-verification table.
---

# Verify the citations in a paper

Your job is to catch citation problems *before a reviewer does*: fabricated or
wrong references, incorrect metadata, and citations that don't actually support
the claim they're attached to.

> **Contract note.** This skill is the single source of truth for the method,
> the output **table**, and the value **vocabularies**. The table is rendered
> deterministically in Python from `CitationRecord` objects
> (`src/citation_verifier/render.py`), never hand-authored by the model — every
> column below maps 1:1 to a field of the frozen schema
> (`src/citation_verifier/schema.py`). The machine tokens used by the schema and
> the human strings used in the table are listed in **Value vocabularies** at the
> end; do not invent values outside them.

## The one rule that matters most

**Never decide correctness from memory.** An LLM "remembering" that a paper
exists is exactly the failure mode you are here to catch. Every statement about
whether a paper is real, and about its authors / venue / year, MUST be grounded
in a `lookup_paper` result (Crossref / arXiv / DBLP, optionally Semantic Scholar
/ OpenAlex) or a web result you actually retrieved. If you cannot verify
something, label it `unresolved` — never guess. A web hit alone never upgrades
`unresolved -> yes` without a corroborating structured record.

## Workflow

1. **Read the draft.** Prefer the LaTeX e-print (`.bbl`/`.bib` + `\cite`
   call-sites give the exact reference *and* the claim site). Fall back to
   `Read` on the PDF. Locate the reference list AND the in-text citations.
2. **Build the citation list.** For each reference, record: (a) the full
   reference string as written, and (b) every place it is cited in the body,
   with the exact sentence/claim it supports. A reference cited in several places
   may be obligatory in one spot and background in another — emit one row per
   `(claim, citation)` pair.
3. **Verify correctness** — call `lookup_paper` with the *fullest* reference
   string you have (authors + title + year + venue; a bare title is noisy).
   Compare the returned canonical record(s) against what the draft claims (see
   rubric below). Validate the cited URL/DOI/arXiv id actually resolves. If
   `lookup_paper` returns nothing, try `WebSearch` (gated, last-resort) before
   concluding a paper is fabricated — it may be a book, thesis, workshop, or
   non-indexed venue.
4. **Verify relevance** — for each citation *use*, judge whether the cited paper
   actually supports that specific claim. Base this on evidence you retrieved:
   the abstract from `lookup_paper`, or `WebFetch` the paper's page for more.
   Quote the supporting (or contradicting) snippet. If you couldn't retrieve
   enough, mark `inconclusive`.
5. **Assign priority** — obligatory vs. helpful (rubric below).
6. **(Optional) Comparison objectiveness** — for *obligatory* citations that are
   competing methods/baselines, check whether the draft actually compares against
   them in its experiments. Flag top-priority baselines that are cited but never
   compared. (Reserved seam: `compared_against`; n/a for the MVP.)
7. **Emit the table and summary** (format below).

## Correctness rubric

For each reference decide **Exists?** = `yes` / `no` / `unresolved`, then list
**metadata issues** by comparing claimed vs. canonical:

- **Exists = no** — no strong title match in Crossref, arXiv, DBLP, or on the
  web. This is the most serious finding (likely fabricated or hallucinated).
  State where you looked.
- **Author errors** — wrong first author, missing/extra authors, misspellings,
  wrong "et al." attribution.
- **Venue errors** — wrong conference/journal; or cited as a formal publication
  when it is only an arXiv preprint (or vice-versa); citing a workshop as the
  main conference.
- **Year errors** — any mismatch. Watch the common arXiv-vs-published year gap,
  and ignore mirror/repost DOIs that show a much later year than the original.
- **Wrong-paper** — the title/DOI cited resolves to a *different* paper than the
  one the claim clearly intends.
- Cross-check sources: if Crossref and arXiv disagree, prefer the
  original/canonical record and say which you trusted.

## Relevance rubric

**Supports claim?** (relevance) renders as one of — the **machine tokens are
unchanged**, only the displayed label is the relevance vocabulary:

- `Relevant` — the cited paper clearly backs the specific claim (quote evidence).
  *(Token: `supports`.)*
- `Partly Relevant` — related but weaker than the claim implies (e.g. claim says
  "proven", paper only shows it empirically on one dataset). *(Token: `partial`.)*
- `Irrelevant` — the paper does not support, or even contradicts, the claim.
  Serious. *(Token: `does_not`.)*
- `Inconclusive` — you could not retrieve enough of the cited paper to judge.
  *(Token: `inconclusive`.)*
- `Skipped` — the citation sits in a results **table or figure**, not a prose
  claim, so it carries **no** relevance verdict (existence/metadata are still
  checked). Distinct from `Inconclusive` (an attempted-but-undetermined judgement):
  a `Skipped` row is **excluded from the relevance distribution** and listed in a
  separate report appendix. Set from `in_table`, not judged by the model.
  *(Token: `skipped`.)*

### Constructing the relevance justification (STEP 2)

Treat relevance as a small, repeatable sub-skill, not a vibe. For each
`(claim, citation)` pair:

1. **Restate the claim** in one sentence — exactly what is being asserted.
2. **Retrieve evidence** from the cited paper (abstract, then a fetched
   snippet). Never judge from memory.
3. **Align** the retrieved evidence to the claim and pick the verdict above.
4. **Quote** the single most decisive sentence as `evidence[]` (with its
   source). The verdict must be defensible from that quote alone.
5. **Prioritize** the check: spend the justification budget on `obligatory`
   pairs first; for `helpful` background a lighter check is acceptable, but say
   so in the scope line rather than silently skipping.

## Priority rubric

**Priority** = `obligatory` or `helpful`:

- **obligatory** — the claim depends on this specific source: a method being
  used or extended, a baseline/competing method, a dataset used, a specific
  quantitative result, a direct quote, or "X showed that …". If this citation is
  wrong or missing, the claim is unsupported.
- **helpful** — background / breadth: "see also", surveys, general context,
  motivation. Removing it would not break a specific claim.

A wrong **obligatory** citation is high severity; a wrong **helpful** one is low.

## Output format

First a one-line scope statement (how many references; if there are many, which
you deep-checked for relevance and which you only checked for existence — never
silently cap; say what you sampled).

Then the table — exactly these columns:

| # | Citation (authors, title, year) | Cited where (the claim) | Exists? | Match notes | Supports claim? | Explanation |
|---|---|---|---|---|---|---|

- Keep each cell short; put detail (quoted evidence, the canonical record) in
  footnotes under the table if needed.
- **Cited where (the claim)**: when one claim cites several references (e.g.
  `… and more [6, 7]`), prefix each such row with its own marker (`[6]` / `[7]`)
  so the (claim, citation) pair the row refers to is unambiguous.
- **Explanation**: a short free-text justification for the row — the relevance
  finding, the resolved source link, or why a citation is unresolved / skipped.
  No severity word here; it carries only the explanation and any link.

Severity is still computed (`high` / `medium` / `low` / `ok`, **derived
deterministically** from `(exists, supports_claim, priority)` by
`derive_severity()` — see `docs/DECISIONS.md`) but is surfaced only in the
Summary, not as a per-row column.

Then a **Summary**: counts of references checked, not-found, metadata errors,
relevance problems; and a short **Fix before submission** list of the
high-severity items in priority order.

## Value vocabularies (FROZEN — must match schema.py token-for-token)

| Column            | Machine tokens (schema)                         | Rendered strings (table)                    |
|-------------------|-------------------------------------------------|---------------------------------------------|
| Exists?           | `yes` / `no` / `unresolved`                     | yes / no / unresolved                       |
| Supports claim?   | `supports` / `partial` / `does_not` / `inconclusive` / `skipped` | Relevant / Partly Relevant / Irrelevant / Inconclusive / Skipped |

The rendered relevance labels are the **relevance vocabulary** (`supports` ->
`Relevant`, `partial` -> `Partly Relevant`, `does_not` -> `Irrelevant`,
`inconclusive` -> `Inconclusive`, `skipped` -> `Skipped`); the **machine tokens are
unchanged**. `Skipped` (table/figure citation sites — no relevance verdict) renders
only in the report's "Skipped" appendix, never in the main table or the verdict
distribution.

`priority` (`obligatory` / `helpful`) and `severity` (`high` / `medium` / `low` /
`ok`) remain schema enums but are no longer per-row columns: severity is shown in
the **Summary**, and priority is internal (it feeds `derive_severity()`).

## Style

- Be specific and verifiable. Quote evidence; cite the DOI/arXiv id you matched.
- No hedging adjectives. If something is wrong, say what is wrong and how to fix
  it.
- Distinguish "I verified this is wrong" from "I could not verify" — they are
  different and the table must not blur them.
