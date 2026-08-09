# memgw - Benchmarks

How well does the pipeline actually remember? Measured end to end on
[LoCoMo](https://github.com/snap-research/locomo), the multi-session
conversational-memory benchmark used by most memory systems for comparison.

## Method

Every conversation is pushed through the REAL pipeline — capture, extraction,
dedup — session by session, exactly as live traffic would be. Questions are then
answered from memory search alone: `/search/facts` (distilled facts) plus
`/search/events` (raw stored turns) — exactly the two search tools a connected
agent has (`memory_search` and `conversation_search`). The answering model never
sees the benchmark transcript itself; everything it gets has passed through
capture and search. The score therefore measures the retrieval system an agent
actually experiences — both layers together, not extraction alone.

One deliberate deviation from per-conversation protocols: all ten LoCoMo
conversations are ingested into ONE shared store and searched globally, because
that is how memgw runs in real life — one store across every project and agent.
Retrieval therefore has to beat cross-conversation distractors that an isolated
per-sample store never sees, which makes these scores conservative rather than
inflated; keep the protocol difference in mind when comparing against systems
benchmarked with one store per conversation.

Run it yourself (~$4 with gpt-5-mini, ~1 hour; use a scratch `MEMGW_HOME`,
never your real store). The harness talks to a running gateway, so start one
against the scratch home first:

```bash
# one-time scratch store with your LLM key on a spare port
mkdir -p /tmp/memgw-bench
printf 'MEMGW_KEY=bench-key-0123456789abcdef\nMEMGW_PORT=8940\nMEMGW_MCP_PORT=8941\nMEMGW_LLM_API_KEY=sk-...\nMEMGW_LLM_MODEL=gpt-5-mini\n' > /tmp/memgw-bench/env
MEMGW_HOME=/tmp/memgw-bench node bin/memgw.mjs start &   # leave running

curl -sL https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json -o /tmp/locomo10.json
MEMGW_HOME=/tmp/memgw-bench node scripts/bench-locomo.mjs /tmp/locomo10.json
```

`--category 1 --skip-ingest` re-runs a single question category against an
already-ingested store; `--iterative` allows the answering step one follow-up
search, which is how a real agent uses the MCP tools. The summary numbers below
are committed as machine-readable data in
[benchmark-results.json](benchmark-results.json); `--resume <file>` writes a
per-question predictions log (question, gold answer, prediction, verdict — judge rationales and retrieved snippets are not retained).

## Results

LoCoMo full set: 10 conversations, ~200 sessions, 1,986 questions.
Extraction and answering model: `gpt-5-mini`. Storage: SQLite FTS5 (BM25,
porter stemming), no embeddings.

| Category | n | Accuracy |
|---|---|---|
| single-hop | 841 | 63.0% |
| temporal | 321 | 56.4% |
| multi-hop | 282 | 17.0% |
| open-domain | 96 | 29.2% |
| adversarial (must refuse) | 446 | 84.5% |
| **Overall** | 1,986 | **58.6%** |

These are the numbers of the LOGGED run (per-question log in
`benchmark-logs/`). An earlier unlogged run scored 58.0% overall — with an LLM
judge, run-to-run variance is roughly ±3 points per category, which is also
your error bar when comparing against other systems.

Published results on the same dataset, for scale (LLM-judged, adversarial
excluded, so compare against memgw's ~51% on categories 1–4): full-context
upper bound ~73%, Mem0 ~67%, LangMem ~58%, OpenAI memory ~52%.

## Reading the numbers

- **Adversarial 84.5% is the number that matters most for a personal store.**
  When memory does not contain the answer, the system says so instead of
  inventing one. A memory that fabricates recollections is worse than none.
- **Temporal doubled (28% → 56%) after two fixes** that this benchmark surfaced:
  porter stemming in FTS5 ("research" now matches "researching") and the
  extraction rule that resolves relative time ("yesterday") to absolute dates.
  Both fixes ship in the product, not the benchmark harness.
- **Multi-hop is the weak spot, and half of it is harness modesty**: the
  default harness performs a single search per question, while a real agent
  session may call `memory_search` several times with different queries. See
  the iterative results below for what one extra search buys.
- **Open-domain trivia is a deliberate trade.** The extractor keeps what will
  still matter in three months and drops the rest; a benchmark that quizzes
  everything penalises that filter. This is the signal-vs-noise design choice
  (see `scripts/test-effectiveness.sh` T2), not a defect.

## Optional embeddings: the measured upgrade

Setting `MEMGW_EMBED_MODEL` (e.g. `text-embedding-3-small`) turns on the hybrid
retrieval path: BM25 and brute-force cosine over Float32 BLOBs in SQLite, fused
with reciprocal-rank fusion. Same store, same questions, single-search mode:

| Category | BM25 only | Hybrid | Δ |
|---|---|---|---|
| multi-hop | 17.0% | 32.6% | +15.6 |
| single-hop | 63.0% | 73.7% | +10.7 |
| open-domain | 29.2% | 36.5% | +7.3 |
| temporal | 56.4% | 66.7% | +10.3 |
| adversarial | 84.5% | 80.3% | −4.2 |
| **Overall** | 58.6% | **66.4%** | **+7.8** |

(Both columns are logged runs on the same ingested store; the two runs happened
a day apart, so the ±3-point judge variance applies to the deltas too.)

Every substantive category gains 7-16 points and abstention gives back a few
— unlike iterative retrieval below, this is close to a free win. The price:
an embeddings API dependency (one more thing that can be down; search falls
back to BM25 when it is), and roughly $0.05/month at personal scale. Embedding
an existing store is a one-off ~$0.01 per few thousand rows; vectors are
backfilled automatically in the background.

## PersonaMem: personalization across sessions

[PersonaMem](https://github.com/bowen-upenn/PersonaMem) (COLM 2025) measures
whether a system tracks a user's *evolving* preferences: 589 multiple-choice
questions (32k tier, 37 personas), each anchored to a point mid-conversation.
The adapter (`scripts/bench-personamem.mjs`) ingests each persona's history
incrementally to that point through the real pipeline, answers from memory
search alone, and scores by letter match — no judge. One persona per store;
run cost ~$5 with gpt-5-mini.

| Skill | n | Accuracy |
|---|---|---|
| generalizing to new scenarios | 57 | 77.2% |
| recalling reasons behind preference updates | 99 | 75.8% |
| recall user-shared facts | 129 | 72.9% |
| preference-aligned recommendations | 55 | 69.1% |
| track full preference evolution | 139 | 54.0% |
| recalling facts mentioned by the user | 17 | 35.3% |
| suggest new ideas | 93 | 20.4% |
| **Overall** | 589 | **59.6%** (chance = 25%) |

For scale: TencentDB Agent Memory reports 48% without memory and 76% with
their full stack on PersonaMem (tier and model unstated, so treat the
comparison as directional). Two failure modes are worth naming honestly:

- **"Suggest new ideas" scores below chance.** These questions ask which
  suggestion the user has NOT seen before — the correct option is precisely
  the one memory does not contain. A retrieval system biased toward
  memory-aligned options picks systematically wrong. Solving it needs
  negative reasoning over the whole history, not better recall.
- **"Track full preference evolution" (54%) pays for supersede-on-update.**
  When a preference changes, the old fact is retired from search; the full
  timeline survives only in raw events. Correct for a personal store (you
  want the CURRENT preference), costly for questions that quiz the history.

## Iterative retrieval is a trade, not a free win

`--iterative` lets the answering step request ONE follow-up search when it can
name the missing piece — the closest scripted approximation of how an agent
actually uses `memory_search`. Measured A/B on the same ingested store:

| Category | single search | + one extra search |
|---|---|---|
| multi-hop | 18.1% | **25.9%** (+7.8) |
| adversarial | 82.1% | 76.9% (−5.2) |

The extra search assembles more multi-fact answers, but the extra
loosely-related snippets also tempt the model into answering questions it
should refuse. Net effect over the full set is roughly zero — which is why
single-search stays the reported default, and why in live use the right place
for this decision is the agent (which searches again only when it actually
needs to), not a blanket second round.
