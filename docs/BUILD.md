# msstate-mcp — development notes

> Maintainer-facing. End users: see [`README.md`](../README.md). Future Claude sessions: also read [`CLAUDE.md`](../CLAUDE.md) for the corpus rule.

This file consolidates everything that used to live across `PLAN.md`, `PRD.md`, `PRE_MORTEM.md`, `USER_STORIES.md`, `ROADMAP.md`, `plan-codex-fixes.md`, `codex_review.md`, and the per-eval-run notes under `msstate-policies/eval/*.md`. Those were deleted on 2026-05-08 in the consolidation pass — git history has the originals.

## What this is

A Model Context Protocol server that exposes two MSU content areas:

- **Operating Policies** — the entire `/current` index at <https://www.policies.msstate.edu/current> (~218 policies).
- **Academic dates** — six msstate.edu sources (registrar academic + exam calendars, university holidays, graduate-school PDFs, financial aid, housing) — added in v0.4.0 (2026-05-11).

Ask Claude (or Cursor / Windsurf / Zed / claude.ai / ChatGPT Plus connector) a natural-language question; the MCP fetches the relevant content straight from MSU and the model answers grounded in that text. Tool count: 7 (4 policy + 2 calendar + 1 health).

Framed as a **portfolio piece + reusable .edu-content MCP template**, not an adoption-chasing product. Real audience is small (dozens, not thousands). Optimizations: build quality, eval rigor, template portability. Adoption metrics are watched, not gated.

## Corpus rule (load-bearing — see CLAUDE.md too)

Every fact this server returns must trace back to an HTTP fetch of `policies.msstate.edu` OR one of the six MSU calendar URLs listed in [CLAUDE.md's corpus extension](../CLAUDE.md#corpus-extension-2026-05-11--academic-dates) — made by *this* server. **No** Claude memory, **no** WebSearch, **no** Wayback Machine, **no** third-party mirror. The whole grounding story collapses if inputs are contaminated. A wrong answer about amnesty / Title IX / FERPA, or the wrong date for finals or move-in, is the worst-case failure mode.

Practical: don't seed `dist/embeddings.json`, the eval set, or any corpus snapshot (policies OR calendars) from anything other than scrape output. Don't author eval `expected_op_numbers` or `expected_start_date` from memory. Either confirm against the live source or leave a `TODO: confirm against live source`.

## Architecture

### Source layout

```
msstate-mcp/                              # repo root = Claude Code marketplace
├── .claude-plugin/marketplace.json       # marketplace manifest
├── README.md                             # user-facing
├── CLAUDE.md                             # session bootstrap for future Claude sessions
├── docs/BUILD.md                         # this file
├── examples/claude_desktop_config.json   # ready-to-paste snippet
├── scripts/
│   ├── audit-pdfs.mjs                    # one-time pdf-parse yield audit
│   ├── build-embeddings.mjs              # build dist/embeddings.json
│   ├── build-project-bundle.mjs          # Claude Project starter zip
│   ├── build-worker-corpus.mjs           # build worker/corpus.json (policies + calendars)
│   ├── _scrape-calendars.ts              # subprocess called by build-worker-corpus.mjs
│   │                                     #  to scrape the 6 calendar sources (uses tsx)
│   ├── calibrate-thresholds.mts          # F2 fused/raw-BM25 score sweep
│   ├── run-eval.mjs                      # MCP-driven eval harness
│   └── sync-version.mjs                  # syncs package.json -> plugin.json
├── worker/                               # Cloudflare Worker variant (HTTP/JSON-RPC)
│   ├── src/index.ts                      # MCP-over-HTTP, all 7 tools, BM25 only
│   ├── corpus.json                       # pre-extracted policies + academic_calendar block
│   ├── wrangler.toml                     # Cloudflare deploy config
│   ├── package.json                      # devDeps: wrangler, workers-types
│   └── tsconfig.json                     # ES2022/WebWorker target
└── msstate-policies/                     # the plugin == the npm package
    ├── .claude-plugin/plugin.json        # plugin manifest (mcpServers entry)
    ├── package.json                      # publishable to npm
    ├── build.mjs                         # esbuild bundler
    ├── eval/
    │   ├── questions.jsonl               # 50 grounded-answer policy eval questions
    │   ├── audit-2026-05-07.csv          # PDF-parse yield audit
    │   ├── eval-2026-05-08-*.json        # policy eval run results
    │   └── eval-calendars-2026-05-11.json # 16-question calendar eval (v0.4.0)
    ├── tests/                            # tsx --test tests/*.test.ts
    │   ├── fixtures/calendars/           # captured HTML + 1 PDF for parser tests
    │   └── parsers-*.test.ts             # per-shape parser tests
    ├── dist/
    │   ├── index.js                      # COMMITTED bundle (~14 MB)
    │   └── embeddings.json               # COMMITTED embeddings (~24 MB)
    └── src/
        ├── index.ts                      # MCP server entry (stdio) — registers all 7 tools
        ├── log.ts                        # stderr-only structured logger
        ├── types.ts                      # PolicyEntry, PolicyDocument, PolicyIndex, HealthState
        ├── cache.ts                      # TTLCache<T> (mem + opt-in disk)
        ├── calendars/                    # Calendar tools (v0.4.0) — parallel to policy modules
        │   ├── types.ts                  # CalendarSource, CalendarRow, CALENDAR_URLS (hardcoded)
        │   ├── scraper.ts                # Live-fetch dispatcher for 4 shapes + WAF detection
        │   ├── corpus.ts                 # TTL-cached loader (24h stable, 6h housing)
        │   ├── search.ts                 # BM25 over event(×3) + description(×1) + term(×1)
        │   └── parsers/
        │       ├── date_table.ts         # Shape A — university_holidays
        │       ├── term_pages.ts         # Shape B — registrar academic + exam + SFA
        │       ├── event_list.ts         # Shape C — housing
        │       └── pdf_calendar.ts       # Shape D — grad school PDFs (via pdf-parse)
        ├── http.ts                       # fetch with UA, retry, WAF detection
        ├── scraper.ts                    # fetchIndex(), fetchPolicy()
        ├── search.ts                     # BM25 + embeddings + RRF + gate
        ├── corpus.ts                     # batch fetchPolicy with concurrency
        ├── embed.ts                      # runtime query-embedding via OpenAI
        └── tools/
            ├── search_policies.ts
            ├── get_policy.ts
            ├── chain_find_relevant.ts
            ├── cite_policy.ts
            └── health_check.ts
```

### Tools (5)

| Tool | Purpose |
|---|---|
| `search_policies` | Keyword search over the index. |
| `get_policy` | Fetch one policy in full by number (`91.100`) or URL. |
| `chain_find_relevant_policies` | One call: hybrid retrieval + fetch top-`k` bodies. The right tool for natural-language questions. |
| `cite_policy` | Format a citation string. |
| `health_check` | Inspect scraper state — index row count, cache hit rate, last error. |

### Bundling and dist/

- TypeScript source under `msstate-policies/src/`, bundled by `build.mjs` (esbuild → CJS, single file, target node18, **non-minified** so diffs are readable).
- `dist/index.js` (~14 MB) and `dist/embeddings.json` (~24 MB) are **committed**. The plugin path resolves to `${CLAUDE_PLUGIN_ROOT}/dist/index.js` after a `claude plugin install` clone, with no `npm install` step. CI verifies `git diff --exit-code dist/` after `npm run build` (catches any source/bundle drift).
- `pdf-parse` is **pinned** (no caret) — the inner-module import (`pdf-parse/lib/pdf-parse.js`) skips the test-PDF loader, but inner layout drifts between minor versions.
- All runtime logging goes to **stderr only**. `stdout` is reserved for MCP JSON-RPC framing. One stray `console.log` corrupts the protocol. Use `src/log.ts`.

### Retrieval

Three modes selectable via `MSSTATE_POLICIES_RETRIEVAL=`:
- `bm25` (default) — BM25 over title + number + body tokens.
- `embed` — cosine over `dist/embeddings.json` chunks (~1k tokens each, 200 overlap).
- `hybrid` — RRF fusion of both ranks: `score = 1/(60+bm25Rank) + 1/(60+embedRank)`.

Default is `bm25` because the comparative eval (see "Eval results" below) found that hybrid (RRF) underperforms BM25-only. Embed-only ties BM25; BM25 wins on operational simplicity (no API key needed at runtime).

`embedSearch` returns `[]` when `OPENAI_API_KEY` is unset, so `hybrid` mode silently degrades to BM25 if the key isn't available.

Body tokens are **pre-attached** at startup from the shipped `dist/embeddings.json` chunks — this is what makes BM25-only viable for body-content queries even without the embedding model at runtime.

### Cache

`TTLCache<T>` is in-memory by default; opt in to disk persistence by setting `MSSTATE_POLICIES_CACHE=disk`. When enabled, the policy-body cache (24h TTL) writes/reads JSON at the env-paths cache dir (`%LOCALAPPDATA%` / `~/Library/Caches` / `$XDG_CACHE_HOME` per platform). Index cache stays in-memory because PolicyIndex contains cheerio-derived Maps that don't JSON round-trip cleanly, and a cold rescrape is cheap.

Persistence is best-effort: corrupt files, missing dirs, or write failures degrade to in-memory and log a warn line — they do not throw from `get()` / `set()`.

### Scraper

Index page is one `<table id="datatable">`. Each row: number (`NN.NN` or `NN.NNN`), title (links to `/policy/{slug}` where slug = number with dot stripped), status, "Date Authored" (NOT last-revised — true revision dates live in PDF metadata), attachment column, download link.

PDF URL paths are **not** stable — most are `/sites/.../files/policies/{slug}.pdf`, some are `/sites/.../files/YYYY-MM/{slug}.pdf`, and some carry `_0`/`_N` suffixes. Always **read the href verbatim from `<a class="btn-download">`**; never reconstruct it from the slug.

Volume IDs (`name="volume"`) and section IDs (`name="section"`) are Drupal taxonomy term surrogate keys. **Don't hardcode them** — parse the dropdowns at runtime to build a label↔id map. Hardcoded IDs silently break the day MSU touches Drupal.

WAF detection: site is normally fronted by F5 (its `id="f5_cspm"` script is *always* present in normal responses). Use it as a challenge signal **only** when combined with an absent `#datatable`. Cloudflare-style patterns probably never fire here.

PDF text extraction: `pdf-parse` inner-module import → NFKC normalize → strip excessive whitespace. If extracted text < `MIN_USABLE_POLICY_TEXT_CHARS = 200`, fall back to landing page; if both fail, throw — do not cache empty success.

## Cloudflare Worker variant — claude.ai web + mobile

`worker/` ships a remote HTTP/JSON-RPC variant of the same 5 tools so that Anthropic's claude.ai web connector and Claude mobile can use this server (the local stdio path doesn't work there — connectors are HTTP/SSE only).

**Live URL:** <https://msstate-policies-mcp.mminsub90.workers.dev/mcp>

### Deployment cycle

```bash
# 1. Refresh the corpus snapshot (live MSU scrape, ~3-5 min)
node scripts/build-worker-corpus.mjs

# 2. Deploy
cd worker
export CLOUDFLARE_API_TOKEN=<token from dash.cloudflare.com/profile/api-tokens>
npx wrangler deploy
```

`wrangler login` (the OAuth flow) doesn't work cleanly in Codespaces because it uses `localhost` for the OAuth callback. Use an API token instead.

### Architectural difference vs. stdio

| Aspect | stdio (Path A/B) | Worker (Path C) |
|---|---|---|
| Where it runs | User's machine | Cloudflare edge |
| Corpus freshness | Live scrape per request | Snapshot, refreshed at build time |
| Retrieval | BM25 + optional embeddings/hybrid | BM25 only (embeddings would blow the bundle limit) |
| `retrievedAt` | Now | Build timestamp from `corpus.json` |
| PDF parsing | At request time | At build time only (Workers have no `node:fs`) |
| Cost | $0 (runs locally) | $0 on Cloudflare free tier (100k req/day) |

The corpus rule still holds: text comes only from `policies.msstate.edu`. Just sampled at build time, not request time.

### Worker code summary

- `worker/src/index.ts` — hand-rolled JSON-RPC 2.0 handler (the MCP TypeScript SDK uses Node `http` which doesn't exist in Workers). Implements `initialize`, `notifications/initialized`, `notifications/cancelled`, `tools/list`, `tools/call`, `ping`. Protocol version `2025-06-18`.
- BM25 logic mirrors `msstate-policies/src/search.ts`: same TOKEN_SPLIT, same FIELD_WEIGHTS (title×3, number×2, body×1), same K1=1.2, B=0.75. Tokenization happens once at module load (within Cloudflare's "Initialization Period" — not subject to per-request CPU limits).
- Tool descriptions copied verbatim from the stdio version so client-side LLM behavior matches.
- CORS open (`Access-Control-Allow-Origin: *`) so the connector can reach it from any origin.
- 5 routes: `GET /` / `GET /info` (server info JSON), `GET /health` (uptime probe), `POST /mcp` (the MCP endpoint), `OPTIONS *` (CORS preflight), `* *` (404).

### What the Worker doesn't have (deliberate)

- No embeddings — `dist/embeddings.json` is 24 MB; Worker bundle limit is 10 MB compressed (free) / 25 MB (paid). BM25-only is the better trade-off here. The comparative eval already showed BM25 ties embed at 86/88, so this isn't a real loss.
- No live scrape — pre-built snapshot only. Rebuild + redeploy weekly to keep fresh.
- No disk cache — Workers have no filesystem. In-memory only (per-isolate).
- No `health_check.last_index_error` — there's no scrape at request time. `health_check` reports `corpus_built_at` instead.

### Calendar tools (v0.4.0, 2026-05-11)

Two tools (`find_msu_date`, `get_msu_calendar`) cover six msstate.edu calendar sources via four parser shapes:

- **Shape A** (single-page date table): HRM university holidays. One fetch per source.
- **Shape B** (term-index + per-term HTML sub-pages): registrar academic calendar, registrar exam schedule, SFA financial aid. Index lists ~10â25 sub-pages per source; bounded concurrency 4 with 15s per-fetch timeout.
- **Shape C** (paginated Drupal event list): housing. Page 1 only.
- **Shape D** (term-index + per-term PDF files): graduate school. Per-term PDFs parsed via the existing `pdf-parse` dependency. Concurrency 4 with 30s per-PDF timeout.

The original brainstorm misclassified 3 of these as Shape A; empirical verification of the canonical URLs (which all turned out to be index pages) forced a mid-flight reclassification into 4 shapes. Implementation history in `git log --grep "Shape [ABCD]\|calendar"` on `main`.

Worker reads from `worker/corpus.json`'s `academic_calendar` block; local install live-scrapes with TTL cache (6h housing, 24h others). WAF detection mirrors the policy build â any challenge aborts the calendar block of the build (the build script refuses to ship a poisoned calendar corpus).

Corpus rule addendum in [`CLAUDE.md`](../CLAUDE.md#corpus-extension-2026-05-11--academic-dates) lists all six URL bases; `tools/security-checklist.sh` enforces (CAL1-4) that calendar URLs are hardcoded, calendar code never touches non-msstate.edu hosts, the Worker caps `find_msu_date` query length, and the build aborts on WAF/empty.

Tool count: 5 â 7. Eval set at [`msstate-policies/eval/eval-calendars-2026-05-11.json`](../msstate-policies/eval/eval-calendars-2026-05-11.json) (16 questions, mixed across the 6 sources + 1 refusal case).

### Calendar quality improvements (v0.4.1, 2026-05-11)

Three quality-of-life fixes on top of v0.4.0:

- **Within-source dedup at the parser + scraper-aggregation boundaries.** Each parser dedupes by `event|start` within a single page-parse; `scrapeTermB` and `scrapeGradD` dedupe by `source|event|start|term` across sub-page merges. The spec-key includes `term` deliberately so cross-term variants survive (a "Classes begin" entry that legitimately appears under both `Spring 2026` and `Spring Mini-Term One 2026` is two different facts, not a duplicate). On the v0.4.1 rebuild against live MSU: 0 duplicates by the spec key; ~921 rows total (varies by MSU's sub-page availability on rebuild day). The dedup catches pathological cases (same event listed twice on the same sub-page) without collapsing legitimate cross-term variants.
- **`citation` field on every `CalendarRow`.** Pre-formatted markdown link `[event, term](url)` computed at scrape time so the LLM can include the source URL verbatim in answers. 100% coverage in the corpus. Reduces the rate at which the LLM drops URLs when summarizing tool output. The `formatCitation` helper lives in `src/calendars/types.ts`.
- **Smart fallback in `find_msu_date`.** When a query mentions a term (e.g., "Spring 2027") and the primary BM25 results have no non-academic rows for that term while having other non-academic results, the chain tool (a) tags existing BM25-found academic rows for that term with `fallback: true`, and (b) appends up to 3 additional academic-calendar rows from the corpus that BM25 missed — also tagged. Logic mirrored in the Worker (`worker/src/index.ts`). Driven by the `CALENDAR_PARENT` constant in `src/calendars/types.ts` (currently documentation-only; the live filter hardcodes `academic_calendar` since it's the only non-null parent value). Lets the LLM answer "grad student, when does Spring 2027 start?" honestly: "Your grad calendar doesn't list this for 2027 yet, but the academic calendar shows January 13."

Semantic embedding for calendars is **deferred to v0.5.0** — the BM25 semantic gap on natural-language queries like *"when does the semester start"* vs the event title *"Classes begin"* remains until then. v0.4.1's smart-fallback path mitigates the most painful cases (queries that name a specific term) but doesn't solve the broader semantic-match problem.

### Calendar synonym expansion (v0.5.0, 2026-05-12)

Adds LLM-generated paraphrases on each calendar row to close the BM25 semantic gap:

- **Anthropic Claude Haiku at build time.** `scripts/build-worker-corpus.mjs` paraphrases each event title into 5 short keyword-search-friendly synonyms (no dates, no digits, ≤80 chars each). Cached by `contentHash` so incremental rebuilds only re-paraphrase changed rows. Cost: ~$0.50 per full rebuild.
- **Zero runtime API.** `find_msu_date` runs pure 4-field BM25 (`event`×3, `synonyms`×2, `term`×1, `description`×1) at query time. No fetch, no key needed.
- **Sidecar `dist/calendar-synonyms.json`** lets the stdio plugin (which scrapes live) attach baked synonyms to scraped rows by `contentHash`.
- **Eval methodology.** `evals/calendar-synonyms-eval.ts` ships 30 ground-truth queries. Ship-blocker thresholds: semantic_gap lift ≥ +10pp, bm25_favorable regression ≤ 5pp. v0.5.0 ships at +13.3pp lift, 0pp regression.
- **Security envelope.** Round-2 checklist 192 → 220 via SYN1-SYN6 + CAL5 regression guard. **SYN4 is load-bearing**: `api.anthropic.com` must never appear in `msstate-policies/src/` or `worker/src/` — only in the build script.
- **Robust JSON extraction.** Build script strips markdown code fences from Haiku responses and uses an assistant-prefill `[` to force JSON-array continuation. Honors `retry-after` on 429s with concurrency tuned to 2 for tier-1 rate limits.

Pivot history: an earlier v0.5.0 design used query-time Voyage embeddings; that was rejected on the zero-runtime-cost constraint (see the **Design summary (v0.5.0 / v0.6.0)** subsection below for the load-bearing decisions preserved from the brainstorm specs).

### Course catalog (v0.6.0, 2026-05-12)

Adds three tools (`search_msu_courses`, `get_msu_course`, `get_msu_course_graph`) sourced from `catalog.msstate.edu`. Same baked-corpus model as policies and calendars — zero runtime fetch surface.

- **Two-pass prereq parser.** Inside the parenthesized prereq sentence: Pass 1 is a high-recall regex `\b[A-Z]{2,4}\s\d{4}\b` that populates `required_courses` losslessly (this is the field the DAG walker depends on). Pass 2 is best-effort — `logic` (or/and/mixed), `min_grade`, and `non_course` strings ("consent of instructor", "junior standing"). When pass 2 is uncertain, `logic` is set to `"mixed"` and `raw_prose` serves as the human/LLM escape valve. Tool descriptions document the split so clients know which fields to trust unconditionally.
- **DAG built at scrape time.** `forward_dag` (course → prereqs) and `reverse_dag` (prereq → unlockers) are computed once from `required_courses` arrays and baked into `corpus.json.courses`. Query-time graph walks are pure BFS with visited-set cycle detection; depth clamped to `[1, 10]`, default 5, `truncated:true` whenever the walk hit the cap or a cycle.
- **URL discipline.** `CATALOG_ROOTS` frozen allowlist + per-course URLs constructed only after the course code passes `/^[A-Z]{2,4}\s\d{4}$/` validation, with `encodeURIComponent` on the dept prefix. `isAllowedCatalogUrl()` re-validates host + prefix before every fetch.
- **Live-scrape robustness.** Concurrency 2, jitter 200–600 ms, 3 retries with exponential backoff (500ms / 1.5s / 4s) on transient errors. WAF challenges (CatalogWafError) and HTTP 4xx are non-transient and fail immediately. The earlier v0.6.0 first-attempt scrape (concurrency 4, no retries) hit the CAT3 5% parse-exception guard at 10.68%; the retry+conc=2 fix landed in commit `6773bb8`.
- **CAT3 guard is load-bearing.** Build aborts with the canonical string `"refusing to ship a poisoned course corpus"` on any of: subprocess failure, unparseable JSON, missing `records`, `< 500` records, empty `reverse_dag` with non-empty `forward_dag`, prereq parse-exception rate `> 5%`.
- **Security envelope.** Round-3 checklist 220 → **230** via CAT1–CAT4. Per-check intent documented in the Round-3 audit closure subsection of `## Security` below.
- **Eval shape.** 52 rows split across 3 buckets: `course_explain` (23 — paraphrase → expected_codes), `prereq_chain` (14 — root → forward-DAG subset), `unlocks` (15 — root → reverse-DAG subset). Every expected_code value derived from the live scrape in the same session per the corpus rule. Ship thresholds: ≥90% / ≥95% / ≥95%. v0.6.0 ships at 100% / 100% / 100%.

### Design summary (v0.5.0 / v0.6.0)

The brainstorm specs that drove v0.5.0 and v0.6.0 are not preserved in-tree (post-ship cleanup per `.dev/README.md`). The load-bearing decisions are captured here so the rationale survives `git log` rot:

**v0.5.0 calendar synonyms — why build-time, not runtime:**
- The first spec proposed query-time embeddings (Voyage / OpenAI / Workers AI). Rejected on the "zero ongoing operational cost" hard requirement — `find_msu_date` is the lowest-cost-per-query tool we have, and any runtime egress contradicts the project's no-recurring-cost premise.
- The shipped design generates synonyms once per build via Anthropic Haiku, bakes them into `worker/corpus.json`, and runs pure 4-field BM25 at query time. `api.anthropic.com` mechanically banned from `src/` by SYN4. Build cost is small and one-shot per release.

**v0.6.0 course tools — why all three:**
- Brainstorm identified 3 user pains: prereq chain ("what do I need before X?"), course explainer ("what's MSU's networking class?"), reverse unlock ("what does X enable?"). All three fit one corpus + one DAG, so they shipped together rather than over multiple minor releases.
- Degree-program structure (`get_msu_program`), archived catalog editions, and course-offerings/professor data are explicitly **out of scope** for v0.6.0 (deferred items D2/D3/D6 in the brainstorm).
- Search is BM25-only — embeddings deferred (D1). Three upgrade paths if a future eval flags a semantic gap on the course corpus: (a) reuse v0.5.0's build-time Anthropic Haiku synonym pattern with a `synonyms` field per `Course`; (b) Cloudflare Workers AI (`@cf/baai/bge-small-en-v1.5`, 10k neurons/day free tier); (c) dept-alias dictionary. No decision needed pre-eval.
- Cross-listed courses stored as both records with `cross_listed: ["<other>"]` arrays (D4 — best-effort canonicalization deferred). Co-reqs parsed into a separate `Coreq` block but excluded from graph walks by default (D5).
- Refresh cadence: catalog editions ship ~yearly; a v0.6.x release pinned to each edition is the expected operating model (D7). No cron, no scheduled re-scrape.

**Corpus-rule continuity across versions:** v0.4.0 added `*.msstate.edu` subdomain sources, v0.6.0 adds `catalog.msstate.edu`. All other corpus-rule prohibitions are unchanged — no training-data fallback, no third-party mirrors, no non-msstate.edu fetches, no `WebSearch` on these topics. The frozen URL allowlists (calendar URLs in `src/calendars/types.ts`; `CATALOG_ROOTS` in `src/courses/types.ts`) are the trust anchors mechanical CAL1 / CAT1 grep checks defend.

## Decision log (chronological)

### Plan revisions (v1 → v7, all in git history)

- **v1**: 8 tools. Eval deferred. Hardcoded Drupal taxonomy IDs.
- **v2**: 5 tools. Eval = v1 prereq. Hardcoded IDs removed. `dist/` drift defended via CI.
- **v3**: Audience broadened from a single persona to "MSU community". Accuracy north star = 99.99%. Tool descriptions push verbatim quoting + refusal.
- **v4**: Project framed as portfolio + reusable .edu template (not adoption-chasing). Site-isolation: scraping logic in `src/sources/` so the rest can be reused.
- **v5**: Adoption metrics downgraded to observational; accuracy is the only kill gate.
- **v6**: Roadmap section, MSU course catalog as planned v2.0 second source.
- **v7**: Live-site verification (2026-05-07): policy-number regex corrected (`91.100` was previously rejected); PDF URL path variability documented; F5 WAF detection signature added.

### Sprint 1 — architecture validation (code-complete; never tagged `v0.1.0-alpha`)

End-to-end pipeline works on real MSU data through `npx`. CI green: typecheck, build, fixture tests, `tools/list` returns 5. README skeleton with honest accuracy phrasing.

### Sprint 2 — accuracy + privacy (mostly complete; not tagged `v0.2.0-beta`)

#### Codex adversarial review (2026-05-07)

External adversarial review flagged 4 findings on the working tree:

| ID | Finding | Resolution |
|---|---|---|
| F1 | Conceptual queries degrade to title-only retrieval when embeddings absent | `3f6b743` — pre-attach body tokens from `dist/embeddings.json` chunks before `bm25Search` |
| F2 | No confidence/scope gate before returning policies | `0edf9e4` + `dc0735f` — `gateRetrieval` with `DEFAULT_MIN_SCORE=0.01` (fused) |
| F3 | Empty/poisoned cache after PDF + landing fallback both fail | `75244b9` — `MIN_USABLE_POLICY_TEXT_CHARS=200`, `isPolicyTextUsable`, `fetchPolicy` throws on unusable text |
| F4 | Whole-doc evidence inflates distractor load | `cba897f` + `fd4bfde` — `extractMatchedPassages` + `buildEvidenceResult` surface `primaryEvidence: MatchedPassage[]` per result |

Validation eval (`ba7e67e`) confirmed clean improvement: composite **81/87 → 86/88** (+5 answer-pass).

#### F2 v2 calibration finding (2026-05-08)

Static analysis via `scripts/calibrate-thresholds.mts` showed a clean apparent gap in BM25-only mode — passing cases' top-1 BM25 was ≥ 11.93, failing cases' top-1 was ≤ 11.20. Set `DEFAULT_MIN_BM25_SCORE = 11.5` (`94ce7d8`).

Empirical eval at k=5 with Sonnet judge ($0.66) showed regression: composite **86/88 → 78/88** (−8). Root cause: `run-eval.mjs` grades retrieval as a pass when the expected OP appears in chain top-k OR via cross-references from top-k policies. Hard-rejecting at top-1 BM25 < 11.5 cuts off that recovery path for ~4 weak-keyword questions.

Rolled back in `a95db00`: `DEFAULT_MIN_BM25_SCORE = 0` (gate disabled by default). Plumbing kept (`FusedHit.bm25Score`, `GateThresholds.minBm25Score`, gate branch + test) for per-call opt-in / future hybrid-mode use.

**Architectural takeaway:** in BM25-only mode with cross-ref grounding active, the eval's retrieval metric is *more* permissive than top-k membership. To gate at the MCP layer without regressing, either the eval needs a "did MCP refuse correctly?" sub-metric, or the gate needs a multi-signal threshold. The codex F2 goal (MCP-layer refusal) stays partially open in BM25-only mode by design.

#### Disk cache via env-paths (`9018ae4`)

`TTLCache<T>` accepts `{ttlMs, persistKey?, persistDir?}` alongside the legacy number-only constructor. Policy-body cache opts in via `MSSTATE_POLICIES_CACHE=disk`. 6 TDD tests cover backward-compat, write/reload across instances, expired-entry filtering on load, `clear()` unlinking, cold-start, and corrupt-file resilience.

#### Comparative retrieval eval (2026-05-08)

Three modes, identical eval, same 50 questions, k=5, Sonnet-4-6 judge:

| Mode | Retrieval | Answer | Refusal | Composite | Cost |
|---|---:|---:|---:|---:|---:|
| **BM25 only** | 37/38 | 37/38 | 12/12 | **86/88** | $0.82 |
| Hybrid (RRF) | 36/38 | 36/38 | 12/12 | **84/88** | $0.82 |
| **Embed only** | 37/38 | 37/38 | 12/12 | **86/88** | $0.83 |

Hybrid uniquely failed "What happens if I get cited for underage drinking at a tailgate?" — embedding signal pulled `03.04` (Sexual Misconduct) to top-1 because `tailgate`/`cited` embeds near consent / Title IX language; `60.121` (HR personnel rule) to top-2/3; ejected canonical `91.119` (Sanctions for Alcohol and Drug Offenses) from top-5. RRF rank-averaging then preserved the bad ordering.

The tornado case fails all three modes — corpus-boundary issue (see "Open issues" below).

Per "if RRF underperforms either method, configure to use the winning method" (then-Sprint-2 task 2.9), default flipped to `bm25` in `72ac7c2`. Hybrid and embed remain available via `MSSTATE_POLICIES_RETRIEVAL=hybrid|embed`.

#### Manual judge-answer review (2026-05-08)

Skim of all 38 positive cases' `judge_answer` fields against question + expected_op_numbers. **No weak passes.** Patterns observed: explicit OP citation, verbatim quoting for normative claims, appropriate refusal on sub-questions the policy doesn't address (e.g. ADHD-specific accommodation list), thoughtful cross-ref usage, no fabricated OP numbers, no paraphrased binding language. The single fail (tornado, `01.04`) is correctly graded as a fail; the model refused with a redirect to MSU Emergency Management.

## Eval methodology

### The 50-question set (`eval/questions.jsonl`)

50 hand-written questions, every `expected_op_numbers` confirmed against the live MSU `/current` index on 2026-05-07 (no trained-knowledge guesses):

| Bucket | n | Example |
|---|---:|---|
| Student-life — direct (title overlap) | 10 | "What is MSU's hazing policy?" → `91.208` |
| Academic — direct | 10 | "What's the policy on final examinations?" → `12.04` |
| HR / faculty / staff — direct | 10 | "What governs employee leave and leave without pay?" → `60.201` |
| Conceptual — weak title overlap | 8 | "Can my RA write me up for lighting a candle in my dorm room?" → `91.100` (Code of Student Conduct — no candle/dorm/RA in the title) |
| Negative — no OP applies | 12 | "What's the weather forecast for Starkville next weekend?" → `null` |

Sub-metrics:

1. **Retrieval correctness** — deterministic. Pass if expected OP is in chain top-k OR via cross-references from the returned policies.
2. **Answer correctness** — Sonnet-4-6 judge (separate Claude API call) grades the final prose answer against retrieved policy text.
3. **Refusal correctness** — deterministic. For negatives, response must contain a refusal phrase AND must NOT contain a fabricated OP number matching `/\b\d{2}\.\d{2,3}\b/`.

### Current state — composite **86/88**

`msstate-policies/eval/eval-2026-05-08-k5-sonnet-4-6.json` (BM25-only, Sonnet-4-6 judge):

```
retrieval  37 / 38 passed   (1 miss: tornado conceptual case)
answer     37 / 38 passed   (1 miss: same tornado case)
refusal    12 / 12 passed
```

The Sprint 2 DoD targets ≥ 99% retrieval / 0 observed answer errors / 100% refusal. **Refusal is met; retrieval and answer are 1 short** because of the tornado case.

### Eval artifacts in `msstate-policies/eval/`

- `questions.jsonl` — the 50 questions.
- `audit-2026-05-07.csv` — Sprint 1 PDF-parse yield audit (per-policy bytes / pages / extracted chars / parse errors).
- `eval-2026-05-08-k5-sonnet-4-6.json` — **canonical** validated baseline (BM25-only, 86/88).
- `eval-2026-05-08-k5-sonnet-4-6-{bm25,hybrid,embed}.json` — comparative eval per mode.
- `eval-2026-05-08-k5-sonnet-4-6-F2v2-regression.json` — preserved snapshot of the F2 v2 regression run (78/88) so the calibration finding stays reproducible.
- `eval-2026-05-07-k5-sonnet-4-6.json` — the pre-codex-fix baseline (81/87).

### Re-running

Cheap (free, no judge):

```bash
cd msstate-policies && node --env-file=.env ../scripts/run-eval.mjs --no-judge --k 5
```

Full Sonnet judge (~$0.82):

```bash
cd msstate-policies && node --env-file=.env ../scripts/run-eval.mjs --k 5 --model sonnet-4-6
```

The eval harness writes `eval-{date}-k{N}-{model}.json` and overwrites if the file exists. Snapshot the canonical baseline before re-running if you want to preserve it.

## Open issues

### Tornado case — corpus boundary

Question: "Are there protocols if a tornado warning hits during my class?" (expected `01.04`).

OP 01.04 ("Emergency Operations") is a one-page meta-policy that says "MSU shall maintain a Campus Emergency Management Plan" and points at `emergency.msstate.edu/files/cemp.pdf`. The actual tornado protocols live in that external CEMP, **outside our corpus**. OP 01.04's text contains zero tornado-adjacent words ("tornado", "severe weather", "shelter", "warning", "evacuation", "inclement") — BM25 has nothing to match, embeddings drift to other emergency-shaped policies, and even when 01.04 is retrieved the LLM correctly says "I cannot answer from the policy text" because the answer isn't in the OP itself.

This is a corpus-shape issue, not a retrieval-quality bug. Three honest options:

1. **Test hybrid mode** ($0.66) — already done; hybrid was *worse* on this case. Skip.
2. **Revise the eval question** — either remove it, or change to a refusal-mode test ("system should respond with the OP pointer + redirect to `emergency.msstate.edu`"). Most honest given the corpus boundary.
3. **Accept and document** — README already includes the unofficial disclaimer; the OP corpus is meta-policy-shaped, some questions point to external documents we don't index. Treat 86/88 as the realistic ceiling with this corpus shape.

### Eval set is single-author

All 50 questions were author-written against the live policy index. The eval risks self-flattery: the author wrote questions knowing the answers, so retrieval may look easier than on questions composed by someone with the actual JTBD.

The fix is to source ≥ 15 questions from places where MSU community members ask things in their own voice:
- `r/msstate` (Reddit) — public threads
- MSU advising / financial aid / dean-of-students FAQ pages
- MSU Bullies (Facebook) — public posts
- A non-author cohort told only the topic, not the policy text

The corpus rule applies: the **question text** can come from anywhere, but the `expected_op_numbers` must still be looked up against the live `/current` index, not guessed. If a sourced question has no clear OP answer, mark `negative: true` instead of guessing.

This is human work — the corpus rule explicitly forbids AI-generated questions.

### WAF detection battle-test

Unit tests assert `WAFChallengeError` fires on mocked challenge responses; "battle-tested" means actually triggering it on the live MSU site once. Hand-run script that hits the site faster than rate limit allows (or with a stripped User-Agent), verifies:

1. Scraper detects the challenge (throws `WAFChallengeError` instead of returning empty success).
2. Cache doesn't pollute on the failed response (F3 fix is the relevant code path).
3. `health_check` surfaces the failure.
4. Chain tool returns a structured error rather than a confident wrong answer.

Should be done once, with care to respect MSU's site (back off on completion, document outcome).

### T4 disclaimer surfacing test

5 high-stakes question conversations across Claude Sonnet, Claude Opus, and one non-Claude client (Cursor or Windsurf). Measure: does the LLM surface the `disclaimer` field from the tool response in its answer? Target ≥ 80%. If short, tighten the tool description and re-run. Manual UI testing.

### `v0.2.0-beta` not yet tagged

Gated on the eval close-out (above) and a release decision. Sprint 3 is publishing (npm publish, marketplace listing, recorded demo, README final pass) — see git history for the original ROADMAP detail if needed.

## Next steps in priority order

1. **Decide on the tornado eval question** — option 1, 2, or 3 above.
2. **Source ≥ 15 externally-sourced eval questions** (Tiger T2). Real user voice.
3. **WAF detection battle-test** — hand-run script against live MSU site, document outcome.
4. **T4 disclaimer surfacing test** — manual UI test across 3 clients.
5. **Tag `v0.2.0-beta`** once 1–4 are addressed (or explicitly waived in the README).
6. **Sprint 3 — publish:** marketplace publishing spike, claude.ai connector spike, npm publish, examples for Cursor/Windsurf/Zed, recorded demo, README final pass, `STALENESS.md`, `docs/release.md`, Go/No-Go walkthrough, tag `v1.0.0`.

## Test inventory

`npm test` runs `tsx --test tests/*.test.ts`. Currently 23 tests:

| File | Asserts |
|---|---|
| `tests/scraper.test.ts` | Index parsing fixture; policy-number regex; only-valid-numbers emitted; normalizeText / looksLikeDataTable. |
| `tests/policy-text-usable.test.ts` | `isPolicyTextUsable` rejects empty/short/whitespace, accepts substantial text. |
| `tests/parse-fixture.test.ts` | `pdf-parse` extracts text from the committed fixture PDF. |
| `tests/body-attached-search.test.ts` | BM25 finds policies by body content once bodies are attached (F1 acceptance). |
| `tests/matched-passages.test.ts` | `extractMatchedPassages` windows around hits, merges overlap, capacity-limits. |
| `tests/retrieval-gate.test.ts` | Empty/low-score/margin gate (legacy fused signal); raw BM25 score floor when caller opts in. |
| `tests/retrieval-mode.test.ts` | `MSSTATE_POLICIES_RETRIEVAL` env var: default bm25, all three values accepted, unrecognized falls back to bm25. |
| `tests/cache-disk.test.ts` | TTLCache backward-compat, write/reload across instances, expired-entry skip on load, `clear()` unlinks file, cold-start, corrupt-file resilience. |

CI runs typecheck + build + `git diff --exit-code dist/` + tests + `tools/list` smoke (5 tools) per `.github/workflows/ci.yml`.

## Env vars

| Var | Effect |
|---|---|
| `OPENAI_API_KEY` | Enables runtime query embedding for `embed` and `hybrid` retrieval modes. Without it, those modes degrade to BM25. |
| `ANTHROPIC_API_KEY` | Used by the eval harness for the LLM-judge stage. Loaded from `.env` via `node --env-file=.env`. |
| `MSSTATE_POLICIES_RETRIEVAL` | `bm25` (default) / `embed` / `hybrid`. Controls retrieval mode. |
| `MSSTATE_POLICIES_CACHE` | Set to `disk` to enable cross-platform on-disk policy-body cache via env-paths. Default in-memory. |

## Security

Reporting flow + supported versions live in [`SECURITY.md`](../SECURITY.md). This section captures the architectural pieces — threat model, trust anchor, deferred items — that maintainers need when reasoning about changes.

### Threat model

The deployment surface is shaped by three realities, and the threat model follows from them:

| Surface | Threat | Mitigation |
|---|---|---|
| **Public Cloudflare Worker** at `https://msstate-policies-mcp.mminsub90.workers.dev` (no auth, open CORS) | DoS to exhaust Cloudflare free tier; resource-consumption via oversized payloads; abuse as a free policy-lookup proxy | CF DDoS protection; `Content-Length` 64 KB cap rejects oversized bodies before `request.json()`; input length cap (`MAX_QUERY_CHARS=4096`) on `query`/`question` in tool handlers; generic error messages on both handler-catch AND parse-catch (no `err.message` echo); `console.error` logs structured fields only (no bare `err` object → no stack in CF logs); CORS `Allow-Headers` no longer advertises `Authorization` |
| **Published npm package** (`msstate-policies-mcp`) | Supply-chain compromise (typosquatted or malicious version); compromised release artifacts | 2FA on npm account + granular tokens with short TTL; `prepublishOnly` builds from src; future publishes should use `npm publish --provenance` from CI (see "Provenance" below) |
| **Stdio MCP server** (local install) | PDF prompt injection (only if MSU's site is compromised); supply-chain via `npx -y` resolving to a malicious version; `pdf-parse@1.1.1` is pinned-old | Tool description pushes verbatim quoting + refusal-on-uncertainty; corpus rule constrains all inputs to MSU domain; `pdf-parse` only runs at build time on the Worker variant |
| **Build pipeline** (`scripts/build-*.mjs`) | Tampered output (corpus.json or embeddings.json) baked into deploy artifact | Build runs against live MSU site (TLS); commits are visible in git; CI verifies `git diff --exit-code dist/` after rebuilds |

The Worker's lack of auth is **intentional** — claude.ai's connector requires HTTP/SSE without app-level auth. Treating "open Worker" as a vulnerability would defeat the install path. Rate-limiting via Durable Objects is documented as a deferred item below.

### Corpus rule = trust anchor

The single load-bearing security claim is the corpus rule (mirrored in [`CLAUDE.md`](../CLAUDE.md) and the project overview at the top of this doc):

> Every fact this server returns must trace back to an HTTP fetch of `policies.msstate.edu` made by *this* server.

Everything else — verbatim-quoting tool descriptions, refusal-on-uncertainty rules, the lack of an `expected_op_numbers` heuristic — is downstream of that. If an attacker can plant content in `worker/corpus.json` or in the live PDFs that this server doesn't actually fetch, the trust model collapses.

Implications for security review:

- Any change that introduces a non-MSU data source is a **breaking change to the security model**, not just a functional one.
- The verifier `tools/security-checklist.sh` includes a `corpus rule + trust` check (L4) so future BUILD.md edits don't accidentally drop this section.
- A malicious PDF on `policies.msstate.edu` (requires MSU site control) is **the only viable prompt-injection vector**. The mitigation is the verbatim-quoting tool description plus the user's ability to verify against the canonical landing URL in every response.

### Provenance for npm releases

The current `npm publish` flow on a developer machine produces an unsigned tarball. Moving forward, releases should use [npm provenance](https://docs.npmjs.com/generating-provenance-statements) so the package metadata cryptographically links to the source commit:

```bash
# In a GitHub Actions workflow with id-token: write permission:
npm publish --provenance
```

This requires running from a trusted CI (GitHub Actions, GitLab CI, CircleCI, Buildkite). It's a deferred-but-recommended item: when we set up the next release pipeline, do it with provenance, not without. Until then, package signature is "trust the maintainer's npm 2FA + the GitHub commit history."

### Deferred security items

These are known and intentionally not in scope for the current release pass. Each has a reason and a rough cost estimate.

| Item | Why deferred | What it would cost |
|---|---|---|
| **M1 — Worker rate limiting** | Anonymous public endpoint with CF free-tier limits is acceptable. Real DoS would burn 100k req/day, then the Worker stops responding until reset — annoying, not catastrophic. | Durable Objects per-IP counter (paid plan), or a Cloudflare WAF custom rule. ~½ day of work + ~$5/mo on the cheapest paid CF tier. Implement when actual abuse is observed in CF logs. |
| **M2 — GitHub branch protection** | Codespaces-issued GITHUB_TOKEN lacks admin scope (HTTP 403 on `gh repo edit --default-branch` and on adding rules). Single-maintainer repo so the day-to-day risk of a stray force-push is low. | One-time GitHub Settings click-through: require PR + status checks on `main`. ~5 min when the maintainer is signed in via the GitHub UI. |
| **M6 — Automated weekly corpus rebuild** | Stale-content drift exists but the freshness loss between manual rebuilds is small (most policies don't change month-to-month). Adding a CI cron means storing a long-lived Cloudflare API token in GitHub Secrets — meaningful trust-shift. | GitHub Actions workflow + a CF token scoped to `Edit Cloudflare Workers` only, with rotation reminders. ~½ day of work + ongoing token-hygiene discipline. |

If any of these items become real (DDoS observed, policy-text drift complaint, accidental force-push), revisit the cost-benefit. They're tracked here rather than in a separate ticket so a future maintainer reading this doc sees the full backlog.

### Round-2 audit closure (2026-05-08)

A second `$autoresearch security` sweep widened the lens beyond the round-1 checklist and surfaced ten net-new findings (N1–N10) plus an out-of-scope disclaimer (DISC). All eleven landed in a bounded fix loop the same day. The per-iteration log lives at `security/260508-1755-fix-loop/results.tsv`, and the per-finding mitigation commits are searchable via `git log --grep '^experiment: N'` (each commit's body includes the finding label and rationale).

Key downstream changes maintainers should know about:

- **`tools/security-checklist.sh` extended from 100 → 192 pts.** Added one mechanical check per finding (N1–N10 + DISC). Current score is **192/192**. The CI workflow (see N6 below) gates on `>= 100` so round-1 floor is permanently enforced and round-2 progress is permanently visible.
- **CI now hard-gates on security.** `.github/workflows/ci.yml` runs `npm audit --audit-level=high` (both packages) and `bash tools/security-checklist.sh` on every push and PR. A regression below 100 fails the build.
- **Worker hardening landed (N1, N4, N5, N10):** generic message on the parse-error path, `Content-Length > 64 KB → 413` cap, scrubbed `console.error` payload, `Authorization` removed from CORS `Allow-Headers`. The threat-model table above reflects the updated mitigations.
- **Build chain hardening landed (N3, N7):** `esbuild` bumped to `^0.28.0` (closes the moderate `npm audit` advisory; `dist/index.js` rebuilt); `scripts/build-worker-corpus.mjs` now ships its own `looksLikeWafChallenge` check and aborts the build on a hit. The latter is a prerequisite for any future M6 (auto-rebuild) cron, so do NOT regress it when M6 lands.
- **Local-server hardening landed (N8, N9):** `new Function` removed from `msstate-policies/src/index.ts`; disk cache writes now use `mkdirSync({ mode: 0o700 })` + `writeFileSync({ mode: 0o600 })` so the cache isn't world-readable on multi-user hosts.
- **`SECURITY.md` gained an `## Out of scope: client-side circumvention` section** that disclaims responsibility for the user-side abuse classes that aren't part of this server's threat model (local edits to the bundle, prompt-level instruction of the LLM, fork-the-corpus, LLM hallucination, indirect prompt injection inside published MSU PDFs). Treat that section as authoritative for "what we're NOT promising to defend."

The G4 cross-gate in `tools/corpus-rule-checklist.sh` was widened from literal `= "100"` to numeric `>= 100` so round-2 progress doesn't trip the round-2 corpus-rule loop's anti-regression check. If you ever add another scoring axis to either checklist, mirror that pattern.

The two M-tier deferred items relevant to security (M1 rate limiting, M2 branch protection, M6 auto-rebuild) are unchanged — see the table above. The only outstanding manual actions sit out-of-band: rotate the npm publish token used for `0.2.0`, and revoke the Cloudflare API token used to deploy the Worker.

### Round-3 audit closure (v0.6.0 courses) — 2026-05-12

`tools/security-checklist.sh` grew from 220 → 230 pts (v0.5.0 had previously taken it from 192 → 220 via SYN1–SYN6 + CAL5). The four new checks are CAT1–CAT4 (see `## Security notes` in `CLAUDE.md`). Per-check intent:

- **CAT1 (4 pts)** — pins the courses module to `msstate.edu` hosts (no third-party URLs anywhere under `msstate-policies/src/courses/`). Mirrors CAL1.
- **CAT2 (2 pts)** — `MAX_QUERY_CHARS = 4096` input-length cap in the Worker for all three course tools (`search_msu_courses`, `get_msu_course`, `get_msu_course_graph`) before tokenize/parse.
- **CAT3 (2 pts)** — the build script aborts with the canonical marker `"refusing to ship a poisoned course corpus"` on any of: subprocess failure, unparseable JSON, missing `records`, `< 500` records, empty `reverse_dag` with non-empty `forward_dag`, or prereq parse-exception rate `> 5%` (the latter enforced inside `scrapeAllCourses`).
- **CAT4 (2 pts)** — `CATALOG_ROOTS` frozen allowlist in `msstate-policies/src/courses/types.ts`; per-course URLs are extracted from live HTML, not constructed from external input. The scrape-time helper `isAllowedCatalogUrl(url)` re-validates `https://` + host == `catalog.msstate.edu` + prefix in `CATALOG_ROOTS` before every fetch.

The corpus rule's third source (`catalog.msstate.edu`) now joins `policies.msstate.edu` and the six calendar URLs as a permitted egress target. `SECURITY.md`'s "Out of scope" and "Trust model" sections were broadened accordingly. The script `scripts/_scrape-catalog.ts` mirrors `_scrape-calendars.ts` (one-shot subprocess, stdout=JSON, stderr=logs, `console.log → stderr` early to keep the pipe clean).

## Conventions

- Single-responsibility files. `chain_find_relevant.ts` orchestrates; index/scoring lives in `search.ts`/`corpus.ts`; gating in pure `gateRetrieval`; evidence assembly in `buildEvidenceResult`.
- Pure functions where possible. Scoring, gating, passage-extraction are testable without network or model calls.
- No fail-open paths. Every catch either logs + rethrows, or logs + returns a structured error envelope. Empty strings as success markers are banned (the F3 root cause).
- Threshold values live in one place. All magic numbers (k, score floors, margins, passage windows) declared as named constants at the top of their owning module.
- All logging via `src/log.ts` to stderr only. `console.log` is forbidden in this codebase.
- Don't hardcode Drupal taxonomy IDs. Parse the dropdowns at runtime.

## What's NOT in this codebase

- Trained-knowledge content. Per the corpus rule.
- AI-sourced eval questions. Same.
- A hosted web demo. Deferred until eval + install signals justify hosting cost.
- Historical / superseded policies beyond what PDF metadata exposes.
- Telemetry server. Out of scope.
- Hardcoded policy text or cite examples. Anything that didn't come from the live site in this same session is "placeholder" or "example only" or labeled as such.
