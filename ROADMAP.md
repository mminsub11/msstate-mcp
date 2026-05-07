# Roadmap — MSU Policies MCP Server

**Date**: 2026-05-07
**Format**: outcome-focused. Each phase states the user/portfolio outcome first; tasks are supporting evidence, not the goal itself.
**Sources**: [`PLAN.md`](./PLAN.md) v6, [`PRD.md`](./PRD.md), [`PRE_MORTEM.md`](./PRE_MORTEM.md), [`USER_STORIES.md`](./USER_STORIES.md).
**Time horizon**: 3 sprints to v1.0, then a 60-day watch phase, then optional v2.0. **No calendar dates** — sprints are gated by exit criteria, not weeks. Solo portfolio project; explicit flexibility.

---

## Strategic outcomes (the whole project)

A normal product roadmap rolls up to a single business goal (revenue, retention). This is a portfolio + reusable-template piece, so the strategic frame is different. **Three top-level outcomes drive every sprint below**, and each sprint outcome ladders up to one or more of them:

| # | Strategic outcome | Measurement |
|---|---|---|
| **S1** | **Demonstrate eval-driven LLM-tooling engineering judgment.** Enable a portfolio reviewer (recruiter, hiring manager, peer) to evaluate the developer's design and quality-engineering skill in 30 seconds *so that* this project differentiates the portfolio from generic "I built an MCP" projects. | README + recorded demo + published eval results signal "this person measures their own work." Reviewer can articulate the safety-contract design without installing the tool. |
| **S2** | **Produce a reusable .edu policy MCP architecture.** Enable other developers to fork and produce a working MCP for a different Drupal-based policy site *so that* the architectural decisions are validated by reuse, not just by claim. | At least one second-source demonstration exists by Phase 5, OR a labeled "untested template" hedge in README is in place by v1.0. |
| **S3** | **Eliminate the "Claude hallucinates MSU policy details" failure mode** for the realistic audience (dozens of MSU community members) *so that* high-stakes questions (deadlines, fees, eligibility, Title IX, FERPA) get correct, citation-bearing answers. | Eval's three sub-metrics: retrieval correctness ≥ 99%, answer correctness 0 observed errors at n=50, refusal correctness 100% on negative cases. |

---

## Phase overview

```
Sprint 1 ─────→ Sprint 2 ──────→ Sprint 3 ──────→ Phase 4 ─────→ Phase 5 (optional)
architecture    accuracy +       distribution     post-launch    v2.0 course
validation      privacy          + launch         60-day watch   catalog

~2 weeks        ~2-3 weeks       ~1-2 weeks       60 days        ~4-6 weeks
(end-to-end     (hybrid retrieval, (4 install     (nightly eval, (second source,
 MVP via npx)    eval harness,     paths, Tigers   kill-or-       template story
                 ext eval Qs)      mitigated,      continue       validated)
                                   v1.0 ship)      decision)
```

Effort key throughout: **S** ≈ < 1 day, **M** ≈ 1–3 days, **L** ≈ 3–5 days. Solo developer working part-time roughly doubles these.

---

# Sprint 1 — Architecture validation

## Outcome

**Enable the developer (and a handful of trusted testers)** to confirm the entire chain-answer pipeline works end-to-end on real MSU data through a single install path *so that* Sprints 2 and 3 build on a validated foundation rather than discovering architectural problems after distribution surfaces are committed.

**Ladders up to**: S3 (the user-value outcome can't exist if the pipeline doesn't work) + secondary S1 (early CI rigor demonstrates the engineering-judgment story).

## Sprint goal

Get a working `chain_find_relevant_policies` answer flowing end-to-end (live MSU fetch → BM25 retrieval → MCP tool response → grounded answer in a Claude client), with CI passing, on **one** install path (`npx`). No embeddings, no plugin marketplace, no eval-harness implementation, no Project zip — those land in Sprint 2 and 3.

The point of Sprint 1 is to **prove the architecture works** before scaling out distribution and quality surfaces. If anything in the design is wrong (pdf-parse can't handle the corpus, MCP wiring leaks stdout, taxonomy parsing breaks on edge cases), we want to find out now.

## Definition of Done (sprint exit criteria)

- [ ] `node msstate-policies/dist/index.js` starts an MCP server on stdio, version + git SHA logged to stderr, no stdout output.
- [ ] `tools/list` returns exactly 5 tools.
- [ ] `chain_find_relevant_policies({question: "what's MSU's policy on amnesty?"})` returns ≥ 1 `PolicyDocument` with full PDF text, `landingUrl`, `retrievedAt`, and the `disclaimer` field from Story T4.
- [ ] `health_check` returns non-zero `index_row_count` after the first fetch.
- [ ] CI green: typecheck, build, `git diff --exit-code dist/`, fixture tests, `tools/list` smoke test (5 tools).
- [ ] README skeleton in place with **honest accuracy phrasing** (T3), **privacy section** (T5), and **disclaimer language** (T4). No "99.99%" headline; no missing privacy disclosure.
- [ ] Manual smoke from a clean checkout: `npm ci && npm run build && node dist/index.js` works on a machine that's never seen the project.

**Outcome metric**: pipeline validated end-to-end on real data; tagged `v0.1.0-alpha`.

## Tasks (dependency-ordered)

| # | Task | Effort | Depends on | Story / risk |
|---|---|---|---|---|
| **1** | **PDF audit (Phase 0).** `scripts/audit-pdfs.mjs` downloads all 218 PDFs and runs each through `pdf-parse`. Output `eval/audit-{date}.csv`. **Decision gate**: ≥ 95% yield ≥ 500 chars/page → use `pdf-parse`; else switch to `pdfjs-dist` *before any tool code*. | M | — | PLAN §"PDF audit" |
| **2** | **Repo scaffolding.** Verify `package.json`, `tsconfig.json`, `.gitignore` (dist/ NOT ignored). Pin exact `pdf-parse` version. `LICENSE` (MIT). Write `build.mjs` (esbuild, CJS, node18 target, banner). `scripts/sync-version.mjs`. | S | 1 | Stories 4, 5 |
| **3** | **Test fixtures.** Save current `/current` HTML to `tests/fixtures/current.html`. Commit one representative PDF (e.g. `91100.pdf`). | S | — (parallel) | Story 10 |
| **4** | **`src/log.ts`.** Stderr-only structured JSON logger. Grep-check no `console.log` anywhere. | S | 2 | PLAN §"Logging" |
| **5** | **`src/http.ts`.** `fetch()` wrapper with desktop UA (identifying project + contact email per E5), retry-on-429 honoring `Retry-After`, concurrency 4, WAF challenge detection. | M | 4 | PLAN §"Scraper", PRE_MORTEM TR2 |
| **6** | **`src/types.ts`.** `PolicyEntry`, `PolicyDocument` (with `landingUrl`, `retrievedAt`, `disclaimer` field per T4), `HealthCheckResponse`. | S | 2 | Stories 1, 2, T4 |
| **7** | **`src/cache.ts`.** `TTLCache<T>` in-memory. **Critical**: must NOT cache empty results from `WAFChallengeError`. Unit test that case. | S | 5 | PLAN §"TTLs" |
| **8** | **`src/sources/msstate.ts`: `fetchIndex()`.** cheerio-parse `#datatable`. **Runtime taxonomy parsing** (no hardcoded IDs). Sanity assertions on row count + dropdown sizes. | M | 5, 6, 7 | Stories 1, 8 |
| **9** | **`src/sources/msstate.ts`: `fetchPolicy()`.** PDF download + `pdf-parse`, NFKC normalize, metadata regex (Effective Date, etc.). Missing fields → omit (don't leak `null` per F2). Fallback to landing-page text if extraction fails. | M | 8 | Stories 1, F2 |
| **10** | **`tests/scraper.test.ts`.** Parse fixture HTML; assert ≥ 100 rows, all numbers match `/^\d{2}\.\d{2}$/`, ≥ 1 volume + section in taxonomy maps. **No hardcoded IDs**. | S | 8 | Story 10 |
| **11** | **`src/search.ts`: BM25-lite.** Lowercase + NFKC tokenize. Field weights title × 3, number × 2, body × 1. Explicit "no stemmer" comment. Embeddings + RRF deferred to Sprint 2. | M | 9 | Story 1 |
| **12** | **5 tool modules** under `src/tools/`. Tool descriptions written verbatim from PLAN.md §"Tools" — highest-leverage prompt engineering. Include T4 disclaimer-in-payload in chain + get_policy. `chain_find_relevant_policies` uses BM25 + `fetchPolicy()` for top-`k=2`. `health_check` reads cache + scraper state. | M | 9, 11 | Stories 1, 2, 3, 8, T4 |
| **13** | **`src/index.ts`: MCP wiring.** `Server`, `ListToolsRequestSchema` (5 tools, deterministic order, schemas via `zod-to-json-schema`), `CallToolRequestSchema` dispatcher with `isError` wrapping. `StdioServerTransport`. Startup: log version + git SHA + node version; **if `OPENAI_API_KEY` set, log T5 stderr disclosure** (even though semantic isn't enabled in v0.1-alpha — anchors the surface). | M | 12 | Stories 1, T5 |
| **14** | **CI workflow.** `.github/workflows/ci.yml`: `npm ci` → typecheck → build → `git diff --exit-code dist/` → tests → `tools/list` smoke (5 tools). Eval is **not** in this workflow. | M | 13, 10 | Story 10 |
| **15** | **README skeleton with launch-tiger fixes baked in.** Sections: front-matter disclaimer, install (npx only for v0.1-alpha), tools, **Privacy** (T5), **Accuracy** (T3 phrasing: "0 errors observed at n=50; aspirational target is 99.99%, lower-bound is ~94%; eval results forthcoming"), troubleshooting. | S | — (parallel) | Stories T3, T5 |

### Optional Sprint 1 background work (parallel-safe)

| # | Task | Effort | Why early |
|---|---|---|---|
| **A** | **Email MSU IT/Communications** with project URL + unofficial framing. One paragraph. | S (30 min) | E5 — courtesy outreach is essentially free; pays back if takedown risk ever surfaces |
| **B** | **Recruit a non-author** for blind eval-question writing. | S (30 min) | T2 — finding the person and briefing them takes calendar time |
| **C** | **Start drafting eval questions** in `eval/questions.jsonl`. Even 20 questions in the right schema means Sprint 2 starts faster. | M (cumulative) | Story 9 |
| **D** | **Survey r/msstate, MSU FAQs** for ~15 externally-sourced eval questions. Capture in `eval/SOURCES.md` with attribution. | M | Story T2 |

## Daily checkpoint sketch

| End of day | What should be working |
|---|---|
| Day 1 | Audit run, parser decision made, scaffolding committed (#1, #2, #3) |
| Day 3 | log/http/types/cache complete with unit tests (#4–#7) |
| Day 5 | `fetchIndex()` working against fixture; scraper test green (#8, #10) |
| Day 7 | `fetchPolicy()` working against fixture PDF; metadata extraction null-safe (#9) |
| Day 9 | BM25 search returning sensible top-k against live corpus (#11) |
| Day 11 | All 5 tools implemented; MCP server starts cleanly; tools/list returns 5 (#12, #13) |
| Day 13 | CI green on first push; README skeleton committed (#14, #15) |
| Day 14 | End-to-end smoke on clean machine; tag `v0.1.0-alpha` |

Evenings only: multiply by ~2.5×.

## Sprint 1 risks

| Risk | Mitigation |
|---|---|
| PDF audit fails 95% threshold → switch to `pdfjs-dist`, replan #2 and #9 | Run audit on **day 1**, not later |
| WAF starts blocking the scraper mid-sprint | `http.ts` lands WAF detection early; slow concurrency to 2 if it triggers; E5 outreach helps |
| MCP SDK API drift | Pin SDK version; read CHANGELOG before #13 |
| Going over sprint | If Day 7 has no `fetchPolicy()`, descope: ship index-only metadata as `v0.1.0-alpha-no-bodies`, pick up PDF bodies in Sprint 2 |

---

# Sprint 2 — Accuracy under conceptual queries + privacy

## Outcomes

### Outcome 2A (S3)
**Enable MSU community members asking conceptual or paraphrased questions** ("can my RA write me up for a candle," "rules around firearms in dorms") **to get the canonically-relevant policy** *so that* the system handles real-world question variance, not just keyword-matchable surface.

### Outcome 2B (S1, S3)
**Enable the maintainer to make defensible accuracy claims** to portfolio reviewers and end users *so that* the README's "0 errors at n=50" statement reflects an externally-validated eval, not a self-flattering question set.

### Outcome 2C (S3)
**Enable privacy-conscious users (especially asking about Title IX, harassment, substance use, FERPA)** to get usable retrieval **without** their queries leaving their machine to a third-party API *so that* sensitive-topic users aren't forced into a trade-off they didn't anticipate.

## Definition of Done

- [ ] Hybrid retrieval (BM25 + pre-computed embeddings, RRF fusion) live; eval shows hybrid beats either method standalone, OR config falls back to whichever wins.
- [ ] `dist/embeddings.json` committed (~5 MB, all 218 policies chunked + embedded).
- [ ] BM25-only fallback works cleanly when `OPENAI_API_KEY` is unset; stderr discloses retrieval mode on every startup.
- [ ] 50 eval questions complete with ≥ 15 externally sourced (Tiger T2). `eval/SOURCES.md` documents attribution.
- [ ] First eval run committed under `eval/eval-{date}.json` with three sub-metric scores. Manual review of 100% of LLM-judge answers complete.
- [ ] Eval gates: retrieval ≥ 99%, answer correctness 0 observed errors, refusal correctness 100%.
- [ ] Disk cache via `env-paths` (cross-platform); WAF detection battle-tested against real failure responses.
- [ ] T4 disclaimer surfacing rate ≥ 80% on a 5-question high-stakes subset across Claude Sonnet, Claude Opus, and one non-Claude client.
- [ ] Tag `v0.2.0-beta`.

## Tasks (dependency-ordered)

| # | Task | Effort | Depends on | Story / risk |
|---|---|---|---|---|
| **2.1** | **Source ≥ 15 externally-sourced eval questions.** Survey r/msstate, MSU advising FAQs, MSU Bullies threads, plus 5 from a blind-author friend. Capture in `eval/SOURCES.md`. | M | Sprint 1 task B (recruited non-author) | Story T2 |
| **2.2** | **Complete `eval/questions.jsonl` to 50.** Composition: 10 student-life + 10 academic + 10 HR/faculty + 8 conceptual stress-test + 12 negative cases. Each row in the schema. | M | 2.1 | Story 9 |
| **2.3** | **`scripts/build-embeddings.mjs`.** Chunk all 218 policies (~1k-token chunks, 200-token overlap), embed with `text-embedding-3-small`, write `dist/embeddings.json`. Run once per release. | M | Sprint 1 #9 | PLAN §"Search" |
| **2.4** | **`src/embed.ts`.** Runtime query embedding via `text-embedding-3-small`. Graceful fallback (silent skip + stderr warning) if no `OPENAI_API_KEY`. Tools never throw on missing key. | S | 2.3 | Story 1 P1 |
| **2.5** | **Update `src/search.ts`: hybrid retrieval + RRF.** Top-20 from BM25 + top-20 from embeddings; score = `1/(60+bm25_rank) + 1/(60+embed_rank)`; return top-`k`. | M | 2.3, 2.4, Sprint 1 #11 | Story 1 P1 |
| **2.6** | **`scripts/run-eval.mjs`.** Drives MCP server via stdio JSON-RPC. Three sub-metrics scored independently. Outputs `eval/eval-{date}.json`. | M | 2.2, Sprint 1 #13 | Story 9 |
| **2.7** | **LLM-judge for answer correctness.** Separate Claude API call grades each answer against retrieved policy text. Prompt enforces "flag any normative claim not supported by quoted text." | M | 2.6 | Story 9 |
| **2.8** | **First full eval run.** Run all 50 questions through harness; commit `eval/eval-{date}.json`. **Manual review of 100% of LLM-judge answers** before declaring pass. | M | 2.7 | Story 9 |
| **2.9** | **Eval comparison run** — BM25-only vs embeddings-only vs RRF-fused. If RRF underperforms either, configure to use the winning method. | S | 2.8 | PLAN §"Search" eval gate |
| **2.10** | **Disk cache via `env-paths`.** Cross-platform: Windows → LOCALAPPDATA, macOS → ~/Library/Caches, Linux → XDG_CACHE_HOME. Migrate in-memory `TTLCache` to optionally persist. | S | Sprint 1 #7 | PLAN §"TTLs" |
| **2.11** | **WAF detection battle-test.** Trigger a real challenge response (e.g. via a script that hits the site faster than the rate limit allows). Verify `WAFChallengeError` fires, cache doesn't poison, `health_check` surfaces the failure. | S | Sprint 1 #5 | PRE_MORTEM TR2, F3 |
| **2.12** | **T4 disclaimer surfacing test.** 5 high-stakes question conversations across Claude Sonnet, Claude Opus, and one non-Claude client (Cursor or Windsurf). Measure: does the LLM surface the `disclaimer` field in its answer? Target ≥ 80%. If short of target, tighten tool description and re-run. | M | 2.8 | Story T4, PRE_MORTEM TR4 |
| **2.13** | **README updates with real eval numbers.** Replace "eval results forthcoming" placeholder with actual three sub-metric scores from 2.8. Privacy section finalized. | S | 2.8 | Stories T3, T5 |
| **2.14** | **Scheduled eval workflow.** `.github/workflows/eval-nightly.yml` runs eval nightly + on `release/*` branches. On regression, auto-files an issue. | S | 2.6 | PRE_MORTEM F3 |

## Sprint 2 risks

| Risk | Mitigation |
|---|---|
| RRF underperforms on the eval | 2.9 explicitly handles this: configure to use whichever single method wins; document the choice |
| Externally-sourced questions are too easy or too varied | Iterate; the 50-question floor is a minimum, not a ceiling. Better to expand to 70 questions before v1.0 than ship a known-weak eval |
| OpenAI rate-limits during build-time embedding | Build embeddings during off-hours; chunk requests; if persistent, document that an API key with reasonable tier is required for building (not for users) |
| Disclaimer doesn't surface reliably across clients (T4 < 80%) | Iterate on tool description; if non-Claude clients are systematically worse, document as a Track Tiger and recommend Claude clients for high-stakes use |

---

# Sprint 3 — Distribution + launch

## Outcomes

### Outcome 3A (S3)
**Enable any MSU community member, regardless of which Claude client they use,** to install and use the MCP through the install path that matches their friction tolerance *so that* adoption isn't gated by technical sophistication.

### Outcome 3B (S1)
**Enable a portfolio reviewer to evaluate the project in 30 seconds** via README + recorded demo + visible eval results *so that* the project's portfolio value isn't gated by the reviewer installing and configuring an MCP server (which they won't).

### Outcome 3C (cross-cutting)
**Enable end users to verify any high-stakes answer** via in-payload disclaimer + canonical URL + retrieval timestamp *so that* the unofficial-MCP trust model holds at the moment of use, not just in the README.

## Definition of Done

- [ ] All 12 items in PRE_MORTEM Go/No-Go checklist verified.
- [ ] Four install paths working: Claude Code plugin, npx for desktop clients, claude.ai MCP-connector (or honest documentation of any limitation), Project starter zip with **URL list + script** (Tiger T1, NOT bundled PDFs).
- [ ] README opens with recorded demo, leads with eval-results table, has honest accuracy phrasing (T3), privacy section (T5), unofficial disclaimer prominent.
- [ ] Marketplace publishing flow verified working (Tiger F4 resolved).
- [ ] `STALENESS.md` and dated eval badge convention in place (Elephant E1).
- [ ] README header dates the project against current Claude version (Elephant E4).
- [ ] "Untested template" hedge in README (Elephant E3).
- [ ] `docs/release.md` documents release process + rollback steps.
- [ ] Tag `v1.0.0`. npm publish. Marketplace publish.

## Tasks (dependency-ordered)

| # | Task | Effort | Depends on | Story / risk |
|---|---|---|---|---|
| **3.1** | **Marketplace publishing spike.** Verify on a throwaway plugin that `/plugin marketplace add mminsub11/<repo>` works for end users without manual review. Document the actual flow in `docs/release.md`. | S | — | PRE_MORTEM F4 |
| **3.2** | **claude.ai MCP-connector spike.** Does the connector accept stdio-via-npx, or only remote HTTP? Resolve the open question from PRD §7. | S | — | Story 6 |
| **3.3** | **Plugin manifests.** `.claude-plugin/marketplace.json` (repo root) + `msstate-policies/.claude-plugin/plugin.json`. Version-sync verified. | S | 3.1 | Story 4 |
| **3.4** | **npm publish dry-run + actual publish.** Verify `prepublishOnly` runs build + version-sync. Publish `msstate-policies-mcp` to npm. | M | Sprint 2 done | Story 5 |
| **3.5** | **Adapt `examples/`** for Cursor, Windsurf, Zed; document paths in README. | S | 3.4 | Story 5 |
| **3.6** | **claude.ai docs.** Either working install steps or honest limitation note (depends on 3.2). | S | 3.2 | Story 6 |
| **3.7** | **`scripts/build-project-bundle.mjs` (T1 fix).** Produces a small zip containing: `policies.txt` (canonical URLs), `system-prompt.md` (template), `download.sh`, `download.ps1`. **Zero PDFs in the zip.** | S | — | Stories 7, T1 |
| **3.8** | **3-min recorded demo** (Loom or asciinema). Show: install via npx → ask amnesty question → see grounded answer with citation + disclaimer. Embed at top of README. | M | Sprint 2 done | Elephant E2 |
| **3.9** | **README final pass.** Front-matter disclaimer, four install paths, recorded demo embedded, eval table inline (not buried in JSON), Privacy section, Accuracy section (T3 phrasing), Troubleshooting, kill-criteria note. | M | 3.4–3.8 | Stories T3, T5; Elephants E2, E4 |
| **3.10** | **`STALENESS.md`** with eval-age badge convention. README badge: green if eval < 90 days old, yellow < 180 days, red beyond. | S | — | Elephant E1 |
| **3.11** | **`docs/release.md`.** Release process, version bump, npm publish, marketplace publish, rollback steps (unpublish, marketplace removal). | S | 3.4 | PRE_MORTEM rollback plan |
| **3.12** | **Walk through Go/No-Go checklist** from PRE_MORTEM. All 12 items must check; any unchecked → fix and re-run, do not ship. | M | 3.1–3.11 | PRE_MORTEM |
| **3.13** | **Tag `v1.0.0`. Push. npm publish. Marketplace publish.** | S | 3.12 (Go/No-Go all green) | — |
| **3.14** | **Post-launch smoke** from a clean machine following only README instructions. Independent verification that "as documented" works. | S | 3.13 | — |

## Sprint 3 risks

| Risk | Mitigation |
|---|---|
| Marketplace requires manual review with multi-week SLA | 3.1 verifies on a throwaway *before* committing to a launch date. If review queue exists, factor it in; consider launching the npx path first |
| claude.ai connector is HTTP-only, can't use stdio | 3.2 + 3.6: document limitation honestly; promote the desktop path for paid claude.ai users; consider a lightweight HTTP wrapper as v0.x candidate (not v1.0 scope) |
| Demo recording reveals an unexpected UX bug | Re-record after fix; better to delay the launch tag than ship a broken demo |
| MSU updates the Drupal site between Sprint 2 eval and Sprint 3 launch | F3 mitigation: post-Sprint 2 nightly eval catches it. If it triggers, fix in Sprint 3 before launch |

---

# Phase 4 — Post-launch watch (60 days)

## Outcome

**Enable the maintainer to make a defensible kill-or-continue decision at day 60** based on accuracy stability and stale-content signals *so that* the project either proceeds to v2.0 with confidence or is sunset cleanly rather than decaying into stale, increasingly-wrong answers (Elephant E1).

**Ladders up to**: S1 (a portfolio piece that decays into wrong answers actively damages the portfolio).

## What "achieving the outcome" looks like

- Nightly eval runs are happening on schedule via the GitHub Action from task 2.14; results committed; regressions auto-file an issue.
- `health_check` continues to surface scraper state to operators and the LLM.
- A 60-day retro post (`docs/post-launch-60d.md`) documents observed eval drift, any Tigers that fired, any Elephants that materialized, and the kill / continue / pivot decision with reasoning.

## Activities (passive monitoring + one decision point)

| Activity | Cadence | Output |
|---|---|---|
| Monitor nightly eval results | Daily glance, weekly review | Eval drift trend chart in `docs/post-launch-60d.md` |
| Triage GitHub issues if any | As they arrive | Issue responses; bug fixes if eval-impacting |
| Watch observational metrics (npm downloads, install activations, Project zip downloads, GitHub stars) | Weekly | Numbers logged in `docs/post-launch-60d.md` for the retro — for context only, not decision input |
| 60-day retro | Day 60 | `docs/post-launch-60d.md` filled in with kill/continue/pivot decision |

## Decision tree at day 60

| If eval gates still pass... | If eval gates have regressed... |
|---|---|
| AND development capacity exists → start Phase 5 (v2.0 course catalog) | AND root cause is fixable (selectors, MSU site change) → fix + re-eval, stay in Phase 4 |
| AND development capacity is gone → mark "complete," commit `STALENESS.md` cadence, leave repo intact as a stable portfolio artifact | AND root cause is structural (PDF format change, MSU rearchitects site) → sunset gracefully: archive repo with pinned README banner pointing to MSU's official site |

**Outcome metric**: the decision is documented and defensible regardless of which way it goes. Low usage with passing eval = the working portfolio outcome. Eval regression = the only failure mode.

---

# Phase 5 (optional) — v2.0 course catalog

## Outcomes

### Outcome 5A (S3, S2)
**Enable MSU students asking course-related questions** ("what are CSE 1284's prereqs?", "is MA 1713 offered in fall?", "what counts as a humanities elective?") **to get grounded answers** *so that* the project's user value scales to the question category that's *more* common than policy questions for the average student.

### Outcome 5B (S2 — the "is the architecture actually reusable" test)
**Enable the architectural claim** that v6's source-isolation pattern supports multi-source MCPs **to be validated empirically** *so that* the "reusable .edu template" story (Elephant E3) graduates from claim to demonstrated.

## Definition of Done

- [ ] Second source module `src/sources/msstate-courses.ts` ships alongside `msstate.ts`. MCP plumbing, eval harness, packaging, CI from v1.0 reused **without modification** — that's the test of whether source isolation actually held.
- [ ] New tools (`find_courses`, `get_prereq_chain`, `search_courses`) layered alongside policy tools, with tool descriptions enforcing the "static catalog only; redirect live-enrollment / GPA questions to Banner / SoC / GradeData" boundary.
- [ ] v2.0-specific eval slice (~30 questions) scores course-question accuracy at ~95% (lower bar than policies' 99.99%; course-info errors are recoverable).
- [ ] README + PRD updated to reflect dual-dataset coverage; "untested template" hedge replaced with "second source instantiation: courses, see /sources."
- [ ] Per-term freshness handling — schedule changes between fall/spring → more aggressive cache invalidation than the policy module.
- [ ] `docs/template-lessons.md` captures any v1.0 framework changes that *did* prove necessary (signals where the source-isolation pattern needs work for the next reuser).
- [ ] Tag `v2.0.0`.

## Task sketch (deferred until Phase 4 decision says "go")

| # | Task | Effort |
|---|---|---|
| **5.1** | Pick the course-catalog data source (Banner / Coursicle / Drupal page); commit a saved fixture | M |
| **5.2** | Write `src/sources/msstate-courses.ts` (different shape: structured records, not prose) | L |
| **5.3** | Implement `find_courses(filters)` — credits, department, term, requirements buckets | M |
| **5.4** | Implement `get_prereq_chain(course)` — graph traversal | M |
| **5.5** | Implement `search_courses(query)` — text search on description + title | M |
| **5.6** | New eval slice (~30 questions); 8 negative-case redirects (live data) | M |
| **5.7** | Per-term freshness: schedule-aware cache invalidation; document in `docs/freshness.md` | M |
| **5.8** | Run eval; commit results; tag `v2.0.0` | S |
| **5.9** | README + PRD updates; replace "untested template" hedge | S |

## Phase 5 risks

| Risk | Mitigation |
|---|---|
| Source isolation pattern doesn't hold (have to modify framework code to integrate the new source) | Document the deviation in `docs/template-lessons.md`; treat it as a v6→v7 architecture lesson; the failure-to-validate IS the lesson |
| Course catalog data isn't accessible via scrape (locked behind login, etc.) | Punt to a different second source (academic calendar, financial aid deadlines) — anything that validates the multi-source story |
| Live-data questions repeatedly hit the boundary | Tool description tightens; eval slice gets more boundary-redirect cases |

---

# Cross-cutting work threads (the Elephants)

These don't fit cleanly into any single sprint but matter for the project to succeed *as a portfolio piece*. They run as background work threads.

| Elephant | Outcome | Lands in |
|---|---|---|
| **E1: bus factor of one** | Enable users to know whether the corpus is fresh *so that* they don't act on a stale answer thinking it's current | `STALENESS.md` + dated badge in Sprint 3 (#3.10); cadence updated based on Phase 4 observations |
| **E2: portfolio invisibility** | Enable a 30-second portfolio review *so that* value isn't gated by installation | Recorded demo + inline eval table in Sprint 3 (#3.8, #3.9) |
| **E3: untested template claim** | Enable the "reusable .edu template" story to be either honestly hedged (v1.0) or empirically demonstrated (v2.0+) *so that* the claim isn't aspirational marketing | Hedge language in v1.0 README (#3.9); replaced with reuse evidence in Phase 5 (#5.9) |
| **E4: model-progress half-life** | Enable a 2028 reviewer to read the project as a 2026 snapshot *so that* portfolio value doesn't expire when domain MCPs become less novel | README header dates the project ("Built against Claude 4.7 / 2026-Q2") in Sprint 3 (#3.9) |
| **E5: MSU not informed** | Enable MSU communications to encounter the project as courtesy outreach *so that* takedown risk drops materially | One email, sometime in Sprint 1 (task A) |

---

# Dependencies & sequencing

**Critical path**:
```
Sprint 1 ─→ Sprint 2 ─→ Sprint 3 ─→ Phase 4 ─→ Phase 5 (optional)
```

**Within Sprint 1**: PDF audit (#1) gates everything depending on `pdf-parse`. Run it day 1.

**Cross-sprint**:
- Externally-sourced eval questions (T2): sourcing starts in Sprint 1 (parallel-safe), implementation in Sprint 2.
- Tool description text (Stories 1, 3, T4): write all three in one PR, in Sprint 1, to avoid sequential drift.
- claude.ai connector spike: resolve in early Sprint 3 before committing to that path's user story.
- Marketplace publishing flow (F4): verify in mid-Sprint 3 before v1.0 tag, so launch isn't surprised by a review queue.

---

# Key assumptions (any of these breaking re-shapes the roadmap)

1. **`pdf-parse` (or `pdfjs-dist`) extracts ≥ 95% of MSU's policy text usably.** Verified by Sprint 1 #1. If false → switch parser, possibly re-architect away from PDFs.
2. **MSU's Drupal site doesn't change selectors mid-sprint.** Mitigated by `health_check` and runtime taxonomy parsing, but a major migration would force a Sprint 1 redo.
3. **No takedown notice from MSU.** Mitigated by Tiger T1 fix (no PDF redistribution), Elephant E5 outreach, "unofficial" disclaimer in payload.
4. **Claude Code marketplace is self-serve and reasonably timely.** Verified by 3.1 spike. If gated behind multi-week review, Sprint 3 launch slips.
5. **OpenAI embeddings stay available at flat-rate pricing.** If pricing/limits shift, v0.2 ONNX-bundle priority bumps up.
6. **The developer has continued capacity through Sprint 3.** Solo project's biggest risk is losing interest. Mitigation: explicit kill-criteria framing — *low usage isn't failure*, only eval regression is.
7. **LLM clients honor tool descriptions reliably enough that the safety contract holds.** Cross-client variance is a Track Tiger; if it materializes loudly, eval expands.

---

# Flexibility notes (what this roadmap deliberately does NOT commit to)

- **No calendar dates.** Sprint exit criteria gate phase transitions, not "by end of June." A solo portfolio project shouldn't pretend to schedule precision it doesn't have.
- **Phase 5 (v2.0) is explicitly optional.** If Phase 4 retro concludes v1.0 is "done as a portfolio piece," v2.0 is fine to skip — the architecture's reuse story can be hedged honestly in README instead.
- **Install paths are not all required.** Sprint 3 ships whichever of the four work; e.g. if claude.ai connector is HTTP-only, that path becomes "documented limitation" instead of "supported install path." Outcome 3A is met for the surfaces that work.
- **Eval question count is a floor, not a ceiling.** 50 is the v1.0 minimum; if Sprint 2 finds the eval is missing real-world variance, expand to 70-100 before v1.0 ships.
- **The "99.99% accuracy" target is aspirational, not a launch gate.** v1.0 ships when the three sub-metrics hit measurable targets (≥99% retrieval, 0 observed answer errors at n=50, 100% refusal); 99.99% never appears in marketing.

---

# After-roadmap suggested next moves

1. **Start Sprint 1 task #1** (PDF audit) — gates everything downstream.
2. **Schedule the parallel-safe Sprint 1 background work** (MSU outreach, recruit blind-author for eval questions) — both 30-minute investments with disproportionate downstream value.
3. **Set up GitHub Project board** with three sprint columns + Phase 4/5 backlog. Pull Sprint 1 stories from `USER_STORIES.md` into the active column.
4. **Re-read PRE_MORTEM Go/No-Go checklist** before tagging v1.0 (Sprint 3 #3.12). The roadmap's outcomes assume those mitigations land.
