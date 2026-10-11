# M13.7.3 fixed cross-section acceptance assets

`dev.json` is the development topic (Transformer); `frozen.json` is the held-out
topic (DPR/RAG). Both inputs were frozen before candidate implementation.
`freeze-sha256.json` hashes the exact input bytes. Quotes preserve their actual
scope: the Transformer snapshot is a previously grounded full-text excerpt;
DPR/RAG records are manually checked public abstract excerpts, not full-text
verification. The deliberately broader partial claims must not become facts.

The evaluated baseline is `a81176e1947415d76836714d23261d0518432609` (before
M13.7.2); the current version is `a80e949bd189d452e646090922891b8564da8812`.
`rejected-candidate.patch` applies to the latter and reproduces the candidate
explicit-context change and three regression tests. It is an experimental asset;
the candidate failed the writing-quality acceptance and is not production code.

Use compiled isolated checkouts with existing lockfile dependencies and the
server's authorized runtime configuration. Never copy credentials into this
directory. Run the existing Pi adapter serially, with every output directory
under the same external parent so its `model-budget.json` enforces 32 reserved
tasks across phases. A failed reservation still consumes budget. Output directories
must be new; prior failures are retained. There is no HTTP service.

```sh
node scripts/acceptance/cross-section-writing-live.mjs \
  /isolated/before /isolated/current \
  scripts/acceptance/fixtures/m13-7-3/dev.json /private/data/dev

node scripts/acceptance/cross-section-writing-live.mjs \
  /isolated/before /isolated/current \
  scripts/acceptance/fixtures/m13-7-3/frozen.json /private/data/frozen-ab

# Apply rejected-candidate.patch only in a separate experimental checkout,
# compile it, and retain the exact same frozen input and model settings.
node scripts/acceptance/cross-section-writing-live.mjs \
  /isolated/before /isolated/candidate \
  scripts/acceptance/fixtures/m13-7-3/frozen.json /private/data/frozen-candidate fixed

node scripts/acceptance/cross-section-writing-live.mjs \
  /isolated/before /isolated/candidate \
  scripts/acceptance/fixtures/m13-7-3/frozen.json /private/data/review review \
  /private/data/frozen-candidate/fixed-manuscript.tex
```

These commands reserve 28 tasks (10 + 10 + 5 + 3); the recorded execution also
retains one initialization failure before any provider request, for 29 total
reservations. The chapter runs share history within each variant, while variants
use separate sessions. The adapter and configuration are fixed across variants;
version-specific Writer prompt builders and available seed skills vary. Skills
were available but not read in the recorded runs. This is sequential multi-section
prompt acceptance, not `idea_to_paper` or `topic_survey` E2E. Survey synthesis,
tool-based evidence supply, citation semantic judging and publication gates are
not executed by this runner. Reviewer mode consumes the generated text directly;
it does not execute the production digest/grounding/revision/gate pipeline.

See the [public report](../../../../docs/research/M13_7_3_CROSS_SECTION_WRITING_QUALITY.md)
for manual evidence, negative outcomes and the decision not to ship the candidate.
