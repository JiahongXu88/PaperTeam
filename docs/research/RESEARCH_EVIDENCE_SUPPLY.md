# Research → RAG → Evidence supply

`idea_to_paper` now prepares literature inside `evidence.ground`, after Researcher
returns and before feasibility, outline and Writer. Other workflow kinds retain
their existing selection and frozen-corpus semantics.

## Bounds and selection

- Review the first 12 non-rejected academic-search candidates in stored order,
  including accepted candidates for recovery. Manual and web candidates are excluded.
- Require title, authors, year and DOI/arXiv/PMID identity, deduplicate by existing
  identity rules, and require at least two topic tokens in title/abstract.
  English stop words and single-character tokens are excluded. Topic tokens come
  from project title/idea and Researcher's related-work directions.
- Rank this bounded pool by token overlap; promote at most six with an auditable
  selection reason. Promotion defers its background fulltext request so the supply
  stage performs one sequential request per source. Relevant scholarly library
  sources can fill unused slots; reference/rejected sources are excluded.
- Prepare at most six sources through existing lawful fulltext resolution,
  ingestion and lexical chunk indexing. Metadata and snippets never become quotes.
- Ground at most six existing Researcher assertions (evidence claims followed by
  domain-overview sentences). No new Researcher round, embedding vendor or quote
  generation is introduced. Each claim retrieves top six chunks and attempts at
  most three, stopping at its first verified result: at most 18 semantic attempts.
  Provider/judge failures or rate limits stop further automatic attempts.

## Integrity and recovery

Each proposal contains sourceId, chunkId, an exact contiguous slice of chunk text,
and the existing assertion. The original quote, metadata and semantic judge stages
remain authoritative. Unsupported/mismatched proposals stay rejected; unavailable
judges produce no formal evidence. Source existence alone never establishes support.

All-state candidate deduplication and serialized grounding prevent duplicate records
on retries or concurrent requests. Existing append-before-resolution recovery is
retained. Cancellation is checked before source work, each chunk and verified writes.
Project stores and retrieval filters keep the chain within the current project.

Stage results expose reviewed/selected/deduplicated, promotion outcomes, accessible
fulltext/chunk counts, proposal/verification outcomes, failure categories, and hashed
claim-to-source/chunk mappings. Phase logs contain counters, without quotes or research
text. Writer uses the existing formal evidence selection. Successful automatic supply
skips the technical promotion prompt; missing support remains visible in diagnostics
and the existing human supply path. Scientific author decisions are retained.

## Validation scope

`backend/test/evidence/researchEvidenceSupply.test.ts` uses public synthetic PDF text,
real stores/chunk extraction/lexical retrieval/grounding/Writer selection, with a
controlled fulltext downloader, scholarly provider and semantic judge. It covers
success, absent fulltext, invalid quotes, opposing claims, retries, cancellation,
concurrent grounding, budget limits, rate limits, workflow ordering and Writer input.
This validates program behavior; live external-provider support requires a separate
bounded acceptance run with an authorized model configuration.
