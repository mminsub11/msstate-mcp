# Product Requirements Document: MSU Policies MCP Server

**Author**: mminsub11
**Date**: 2026-05-07
**Status**: Draft (v1)
**Stakeholders**: Project owner (portfolio + learning piece). No external sponsors. Adjacent audiences acknowledged but not built for: MSU legal/comms, SACSCOC accreditors, other SEC-school admins evaluating the template.
**Implementation reference**: [`PLAN.md`](./PLAN.md) (v6) — this PRD aligns intent; PLAN.md is the build spec.

---

## 1. Executive Summary

Ship an MCP server that exposes Mississippi State University's ~218 Operating Policies as **grounded, citation-bearing answers** to any LLM client (Claude Code, Claude Desktop, Cursor, Windsurf, claude.ai, etc.). The MCP returns official policy text from the canonical source on every call, so the LLM only ever paraphrases or quotes from real MSU documents — eliminating the hallucination failure mode that makes general-purpose Claude unreliable on policy questions today.

The project is framed as a **portfolio / learning piece** plus a **reusable ".edu policy MCP" template** rather than a product chasing adoption. Success is measured by accuracy on a 50-question eval, not install counts.

## 2. Background & Context

**Problem.** MSU students, staff, and faculty regularly ask LLMs questions whose answers exist verbatim in MSU Operating Policies (amnesty, FERPA, withdrawal, sick leave, travel reimbursement, IT acceptable use, Title IX, grade appeals, etc.). Without grounding, an LLM will:
- Confidently fabricate policy numbers.
- Paraphrase load-bearing language ("you must apply within 5 days" → "apply soon").
- Mix up MSU's policies with other universities' policies it saw in pretraining.
- Refuse or hedge unhelpfully when it should give a definite answer.

The wrong answer on a deadline, fee, eligibility threshold, or appeal procedure can cause real harm. Existing alternatives are unsatisfactory: MSU's policy site is searchable but only by humans (not optimized for LLM retrieval), and an ad-hoc "tell Claude to use WebSearch" approach gets patchy, stale, badly-ranked results — Google's index of policies.msstate.edu is incomplete and mixes current with superseded versions.

**Architectural reference.** The design closely mirrors [`chrisryugj/korean-law-mcp`](https://github.com/chrisryugj/korean-law-mcp): expose **search + fetch primitives** plus one **chain** tool that bundles search→fetch into a single call. Grounding arises naturally — the LLM only ever sees official text the MCP just returned.

**Demand.** Demand for an MSU-specific tool is unvalidated and the realistic audience is small (dozens, not thousands). v6 of the plan reframes the project as a portfolio piece + reusable template rather than a product chasing adoption. Build quality, eval rigor, and template portability are the real bars.

**Verified site structure.** A saved copy of `policies.msstate.edu/current` confirms: index is a Drupal `<table id="datatable">`, policy text lives in PDFs (not on landing pages), and Drupal taxonomy term IDs (`Volume I…IX`, 35 sections) are DB surrogate keys — they renumber on Drupal restores, so we parse the dropdowns at runtime rather than hardcoding IDs.

## 3. Objectives & Success Metrics

### Goals

1. **Ship a working MCP server** with 5 tools (`search_policies`, `get_policy`, `chain_find_relevant_policies`, `cite_policy`, `health_check`) that returns grounded answers from MSU Operating Policies on any MCP-capable client.
2. **Hit the three accuracy sub-metrics** on a 50-question hand-written eval set (see Success Metrics).
3. **Friction-matched distribution.** Ship four install paths so any audience segment can reach the same MCP: Claude Code plugin, plain MCP via `npx`, claude.ai MCP-connector, and a Claude Project starter zip for free claude.ai users.
4. **Architectural portability.** Site-specific code lives only in `src/sources/msstate.ts`; the rest of the codebase is reusable for any Drupal-based policy site or, post-v1.0, additional MSU datasets (course catalog).
5. **Eval-gated quality assurance.** A repeatable harness scores retrieval, answer, and refusal correctness independently — quality is measured, not vibes-based.

### Non-Goals (explicitly out of scope for v1.0)

1. **Hosted web demo.** Deferred until eval + install signals justify hosting cost. Claude Project starter zip is the v1 stopgap for users without local install.
2. **Telemetry server.** Only opt-in local counters, off by default.
3. **5 of the original 8 tools** (`find_by_topic`, `get_recent_changes`, `get_policy_history`, `list_by_volume`, `list_by_section`). Redundant with `search_policies({include_body: true})` or require additional fetch paths not justified pre-eval.
4. **Course catalog.** Roadmapped as v2.0, not v1.0. v1.0 ships policies only.
5. **Live enrollment / schedule-of-classes / GradeData integration.** Permanently out of scope even for v2.0 — these belong in Banner / SoC / GradeData, not a policies-or-catalog MCP. Tool descriptions will redirect, not fabricate.
6. **Historical / superseded policy versions** beyond what the PDF metadata block already exposes.
7. **Bundled ONNX embedding model.** Considered for v0.2 to remove the optional `OPENAI_API_KEY` dependency; deferred — adds ~25 MB and complicates esbuild.
8. **Adoption / install gates.** Low usage with passing eval is **not** failure — that's the v6 portfolio framing.

### Success Metrics

| Metric | Current | Target | Measurement |
|---|---|---|---|
| **Retrieval correctness** (gate) | n/a (no system today) | ≥ 99% on 50-question eval | Deterministic: does `chain_find_relevant_policies(q).results` include `expected_op_numbers[0]`? |
| **Answer correctness** (gate) | n/a | 0 observed errors on eval (≈99% lower-bound at this n) | LLM-judge (Claude API) grades each answer against retrieved policy text + 100% manual review pre-release |
| **Refusal correctness** (gate) | n/a | 100% on 12 negative-case eval questions | Deterministic: response contains a refusal phrase AND no fabricated `\d{2}\.\d{2}` OP number |
| **Time-to-answer p50** (observational) | n/a | < 6s warm, < 12s cold | `chain_find_relevant_policies` wall-clock |
| **Stale-content incidents** (observational) | n/a | 0 | Cache served text superseded by newer revision in live index |
| **Activation %** (observational) | n/a | watched out of curiosity | % of installs with ≥1 successful `tools/call` within 24h |
| **Install / use signals** (observational) | n/a | watched, not targeted | npm downloads, Project zip downloads, GitHub stars |

**Kill criteria.** The only thing that kills v1.0 is failing the accuracy bars: retrieval correctness drops below 95% on the eval, OR answer-correctness errors persist across two consecutive eval runs that aren't a stale-content fluke. Adoption signals do not trigger kill — low usage with passing eval = a working portfolio piece + template, which is the deliverable.

## 4. Target Users & Segments

**Primary audience: the MSU community broadly** — students, staff, faculty, RAs, advisors, conduct officers, anyone who asks a question that has an answer in an MSU Operating Policy. JTBD: *"ask Claude a policy question, get an answer grounded in official MSU policy text."* No privileged persona; the build doesn't optimize around any one segment.

**Friction-matched install paths** (all four ship in v1.0; same `dist/index.js` runs behind all of them):

| Surface | Who it serves | Friction |
|---|---|---|
| Claude Code plugin (`/plugin install msstate-policies@msstate-mcp`) | Anyone using Claude Code | 2 commands, no JSON |
| Plain MCP via `npx` (Claude Desktop, Cursor, Windsurf, Zed) | Power users on any MCP-capable desktop client | Paste a JSON config snippet |
| claude.ai MCP-connector (documented copy-paste path) | Paid claude.ai users | UI install, no JSON edit |
| Claude Project starter zip (curated PDFs + system-prompt template) | Free claude.ai users; anyone who wants no install | Drag-and-drop into a Project |

**Secondary audience: developers wanting an .edu policy MCP template.** The repo is structured so `src/sources/msstate.ts` is the only site-specific module; cloning, replacing that file, and re-running the eval should produce a working MCP for any other Drupal-based policy site.

**Adjacent audiences acknowledged but not built for**: SACSCOC accreditors (reaffirmation cycles), MSU legal/comms team, other SEC universities. These represent the actual TAM story if the project ever pivots to product.

## 5. User Stories & Requirements

### P0 — Must Have (v1.0 launch blockers)

| # | User Story | Acceptance Criteria |
|---|---|---|
| 1 | As an MSU community member, I can ask Claude a natural-language MSU policy question and get a grounded answer that quotes verbatim from the canonical policy text. | `chain_find_relevant_policies(question)` returns full text of top-k policies; tool description enforces "quote verbatim, refuse if uncertain." Eval's answer-correctness sub-metric gates this. |
| 2 | As that same user, I can verify any answer against the official source. | Every `get_policy` and `chain_find_relevant_policies` response includes `landingUrl` (canonical) and `retrievedAt` (ISO timestamp). README documents this. |
| 3 | As that same user, when no MSU policy applies to my question, I get a plain refusal, not a fabricated citation. | Refusal-correctness sub-metric: 100% on 12 negative eval cases. Tool description tells Claude to refuse + recommend the responsible office; eval blocks fabricated `\d{2}\.\d{2}` OP numbers in refusals. |
| 4 | As an installer using Claude Code, I can install in 2 commands. | `/plugin marketplace add mminsub11/msstate-mcp` → `/plugin install msstate-policies@msstate-mcp` → tool calls work. Verified manually pre-release. |
| 5 | As an installer using Claude Desktop / Cursor / Windsurf / Zed, I can install via `npx` with a JSON snippet. | `examples/claude_desktop_config.json` ships a working snippet; `npx -y msstate-policies-mcp` resolves the published npm package and runs the same `dist/index.js`. |
| 6 | As an installer using paid claude.ai, I can install via the MCP-connector UI. | README documents the copy-paste path; manual verification on claude.ai. |
| 7 | As a free claude.ai user with no MCP support, I can use a Claude Project starter zip. | `scripts/build-project-bundle.mjs` produces a zip containing ~30 high-traffic policy PDFs + a system-prompt template ("answer only from these PDFs, quote verbatim, cite OP number, refuse if not covered"). Released as a GitHub release asset. |
| 8 | As an operator (or the LLM itself), I can see when the scraper is broken. | `health_check` tool returns `{index_row_count, last_index_fetch, last_index_error, volumes_discovered, sections_discovered, cache_hit_rate, version, git_sha}`. LLM uses it to apologize coherently rather than confidently say "MSU has no policy on amnesty" when really the index is empty due to a WAF challenge. |
| 9 | As a maintainer, I can re-run the eval before any release and trust the score. | `eval/questions.jsonl` (50 questions) + `scripts/run-eval.mjs` produce per-sub-metric pass/fail JSON. Three sub-metrics measured independently: retrieval (deterministic), answer (LLM-judge + manual review), refusal (deterministic). |
| 10 | As a maintainer, CI catches the most common silent-failure modes. | CI runs typecheck, build, `git diff --exit-code dist/` (drift check), fixture tests, and a `tools/list` smoke test asserting exactly 5 tools. |

### P1 — Should Have (in v1.0 if time allows; ship blockers if missing)

| # | User Story | Acceptance Criteria |
|---|---|---|
| 11 | As any user asking conceptual questions ("can my RA write me up for a candle"), I get the canonically-relevant policy even when keyword overlap is weak. | Hybrid retrieval: BM25-lite (field-weighted) + pre-computed embeddings (`text-embedding-3-small`, ~5 MB `dist/embeddings.json` committed at build time), fused via Reciprocal Rank Fusion. Top-20 from each, RRF score = `1/(60+bm25_rank) + 1/(60+embed_rank)`. |
| 12 | As an installer without an OpenAI API key, the tool still works. | If `OPENAI_API_KEY` is unset, semantic retrieval is silently skipped (stderr warning) and the system falls back to BM25-only. Tools never throw on missing key. |
| 13 | As a user, I get a clean citation in any answer. | `cite_policy(number, style?)` returns formatted citation, e.g. *"Mississippi State University Operating Policy 91.100, 'Title', effective YYYY-MM-DD. Retrieved from {url} on {today}."* |
| 14 | As a maintainer, I have confidence that PDF parsing won't silently degrade. | `scripts/audit-pdfs.mjs` runs all ~218 PDFs through `pdf-parse`; pass criteria ≥ 95% yield ≥ 500 chars/page; output committed to `eval/audit-{date}.csv`. If we fail this, switch to `pdfjs-dist` (heavier but maintained). |
| 15 | As a future contributor, the codebase is selector-fix-friendly. | All scraper selectors/regexes isolated at the top of `src/sources/msstate.ts`. Drupal taxonomy IDs are runtime-discovered (parsed from `<select>` options) — no hardcoded IDs anywhere. |

### P2 — Nice to Have / Future

| # | User Story | Phase |
|---|---|---|
| 16 | As an installer with no API key, semantic retrieval still works (no degradation). | v0.2 — bundle a small ONNX model (e.g. `all-MiniLM-L6-v2`) into `dist/`; ~25 MB bundle cost. |
| 17 | As any web user, I can use this without installing anything. | v0.x — hosted web demo. Deferred until eval + install signals justify hosting. |
| 18 | As an MSU student, I can ask course-related questions ("what are CSE 1284's prereqs?") and get grounded answers. | v2.0 — second source module `src/sources/msstate-courses.ts`, new tool surface (`find_courses`, `get_prereq_chain`, `search_courses`). Different data shape (structured records, not prose), different retrieval (filter + graph + text), different freshness (per-term, not annual), different accuracy bar (~95%, not 99.99%). Static catalog only — live enrollment, schedule of classes, and GradeData explicitly out of scope. |
| 19 | As a developer at another .edu, I can fork this and produce a working MCP for my own university's policy site. | v0.x — README "Reusing this template" section; replace `src/sources/msstate.ts`, retune eval set, ship. |
| 20 | As a user, I can find policies by topic, list by volume/section, or see recent changes. | v0.2+ — `find_by_topic`, `list_by_volume`, `list_by_section`, `get_recent_changes`, `get_policy_history`. Deferred until eval data shows the gap. |

## 6. Solution Overview

**High-level data flow.** Cron-on-demand scrape → in-memory + optional disk-cached index (1h TTL) → on policy fetch, download PDF, extract via `pdf-parse`, NFKC-normalize, cache 24h → on query, hybrid BM25+embedding retrieval with RRF fusion → MCP tools return structured `PolicyDocument` objects with `landingUrl` and `retrievedAt` → LLM client renders grounded answer.

**Stack.** TypeScript / Node ≥ 18 (global `fetch`); MCP SDK (`@modelcontextprotocol/sdk`, stdio transport); `cheerio` (HTML); `pdf-parse` (PDFs, pinned exact version, inner-module import to avoid the index file's test-PDF loader); `zod` runtime validation with JSON Schema derived via `zod-to-json-schema` (no parallel hand-written schemas); `esbuild` produces a single committed `dist/index.js`. All logging to stderr (stdout reserved for JSON-RPC framing). Cross-platform cache paths via `env-paths`.

**Distribution.** Repo root is a Claude Code marketplace (`.claude-plugin/marketplace.json`); `msstate-policies/` subdir is *both* the Claude Code plugin (`.claude-plugin/plugin.json`) *and* a publishable npm package — the same `dist/index.js` runs in both paths. Version is single-sourced from the npm `package.json`, synced to the plugin manifest by `scripts/sync-version.mjs`.

**Site-specific isolation.** All MSU-Drupal-specific code (selectors, URL patterns, taxonomy parsing) lives in one module. The rest of the codebase (search, MCP wiring, tools, eval, packaging) is source-agnostic. This is the precondition for v2.0 (course catalog) and the .edu template story.

**Safety contract.** The single highest-leverage prompt-engineering surface in this project is the `chain_find_relevant_policies` tool description, which tells Claude:

> Use ONLY the returned text. For any normative claim (deadlines, eligibility criteria, dollar amounts, exceptions), QUOTE VERBATIM and cite OP number + URL. If returned policies don't clearly answer, say so and recommend contacting the responsible office; do NOT extrapolate. Always include `retrievedAt` and `landingUrl`.

This is loaded into Claude's context every conversation via the MCP tool description — the contract is centralized, consistent, and version-controlled, not left to each user's system prompt.

**Eval as quality gate.** 50 hand-written questions covering 10 student-life + 10 academic + 10 HR/faculty + 8 conceptual stress-test + 12 negative-case (no-policy-applies) questions. Three sub-metrics scored independently. Eval runs nightly on schedule and on `release/*` branches; not on every push (live MSU requests).

See [`PLAN.md`](./PLAN.md) §"Stack & Layout", §"Tools", §"Scraper Design", §"Search", §"MCP Wiring", §"Eval set" for full implementation details.

## 7. Open Questions

| # | Question | Owner | Resolved by |
|---|---|---|---|
| 1 | Is `pdf-parse` good enough for ≥95% of the corpus, or do we switch to `pdfjs-dist`? | mminsub11 | Phase 0 — `scripts/audit-pdfs.mjs` output. Decision before any tool code is written. |
| 2 | Does Reciprocal Rank Fusion actually beat BM25-only and embeddings-only on our eval, or do we ship one method standalone? | mminsub11 | Phase 2 — eval comparison run. Eval gates the final retrieval choice. |
| 3 | Does the no-`OPENAI_API_KEY` BM25-only fallback hurt accuracy enough that we need to prioritize the v0.2 ONNX bundle? | mminsub11 | Phase 2 — eval run with `OPENAI_API_KEY` unset, compared to with-key run. Quantifies the gap. |
| 4 | What % of WAF challenges actually fire vs. how often do we get clean 200s? Worth a more robust solution (e.g. Playwright fallback) or fine to surface as a `health_check` error? | mminsub11 | Phase 1 — observed during scraper development. Default: surface via `health_check`, defer Playwright unless rate is non-trivial. |
| 5 | Should v1.0 README publish a "DIY baseline comparison" eval (web-search-only agent vs. our MCP) as part of the portfolio narrative? | mminsub11 | Phase 2 — once v1.0 eval numbers are in. Adds maybe ~$1 of API cost; strong portfolio signal if the gap is large. |
| 6 | When (if ever) does install / use signal justify the hosted web demo lift? | mminsub11 | Post-launch (60-day review). |

## 8. Timeline & Phasing

This is a portfolio project with no calendar deadlines; **sequencing matters more than dates**. Phases are gated by exit criteria, not weeks.

### Phase 0 — Audit (pre-build)
- Run `scripts/audit-pdfs.mjs` on all 218 PDFs.
- **Exit criteria**: ≥ 95% yield ≥ 500 chars/page; < 5% parse errors. If failed, switch to `pdfjs-dist` before proceeding.

### Phase 1 — Build (v1.0 scope)
- Scraper (`src/sources/msstate.ts`): index fetch, PDF fetch, WAF detection, sanity assertions, runtime taxonomy discovery.
- Retrieval (`src/search.ts`, `src/embed.ts`): BM25-lite + pre-computed embeddings + RRF fusion. Graceful fallback if no API key.
- 5 tools (`src/tools/*.ts`) + MCP wiring (`src/index.ts`).
- Build pipeline: `esbuild` → `dist/index.js`, version sync, banner injection, embedding pre-compute → `dist/embeddings.json`.
- Distribution scaffolding: marketplace manifest, plugin manifest, npm package, examples, Claude Project zip script.
- CI: typecheck, build, `dist/` drift check, fixture tests, `tools/list` smoke test.
- **Exit criteria**: all CI green; manual smoke test of all 4 install paths passes.

### Phase 2 — Validate
- Run full 50-question eval.
- **Gate 1** (retrieval correctness ≥ 99%) — if missed, debug retrieval before proceeding.
- **Gate 2** (answer correctness, 0 observed errors) — LLM-judge run + 100% manual review.
- **Gate 3** (refusal correctness 100% on negative cases) — deterministic check.
- Publish per-sub-metric numbers in README. Honest, not aspirational.
- **Exit criteria**: all 3 gates pass on a single run; eval output committed to `eval/eval-{date}.json`.

### Phase 3 — Ship v1.0
- Release: marketplace push + npm publish + GitHub release with Claude Project starter zip.
- README opens with "Unofficial" disclaimer; documents all 4 install paths; quotes eval numbers honestly.
- Tag the commit; bundle banner self-identifies version + git SHA.

### Phase 4 — Watch & decide (60 days post-launch)
- Re-run eval nightly; investigate any regression.
- Watch (don't gate on) install / use signals.
- **Decision point**: if eval still passing, project is "done" as a portfolio piece — proceed to Phase 5 if motivated. If eval regresses (kill criteria), sunset or pivot.

### Phase 5 — v2.0 course catalog (optional, post-v1.0 stable)
- New source module `src/sources/msstate-courses.ts`; new tools (`find_courses`, `get_prereq_chain`, `search_courses`); per-term freshness; ~95% accuracy bar; new eval slice.
- Reuses MCP plumbing, eval harness, packaging, CI from v1.0 unchanged. **This is the test of whether the v6 architecture decision was right** — if v2.0 requires touching the framework, the source-isolation pattern failed and we learn something.
- Static catalog data only; live enrollment / schedule / GPA explicitly redirected, not fabricated.

---

## Next steps

The PRD is now in place alongside the build spec (`PLAN.md`). Suggested follow-ups, in likely order of usefulness:

1. **Break v1.0 into a sprint-1 task list** (10–15 first tasks in dependency order).
2. **Run `/pm-execution:pre-mortem`** against the PRD to surface launch risks not yet captured in PLAN.md §"Open Risks."
3. **Run `/pm-execution:write-stories`** against the P0 list to expand each into Card / Conversation / Confirmation user-story format with INVEST acceptance criteria.

Tell me which (if any) you want next.
