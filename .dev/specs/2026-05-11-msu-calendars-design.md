# MSU Calendars (academic dates) — design

**Date:** 2026-05-11
**Status:** Design (awaiting implementation plan)
**Scope:** Add two new MCP tools to the existing `msstate-policies` server that answer questions about MSU academic dates, deadlines, and residence-life milestones by scraping six curated MSU subdomains.

## Goal

Extend the running MCP server so users on any supported client (Claude Code, Claude Desktop, claude.ai connector, ChatGPT Plus/Pro connector, OpenAI API) can ask date-anchored questions like *"When does spring break start?"*, *"When is FAFSA due for fall?"*, *"When are halls closing?"* and get a grounded answer that quotes the date, names the calendar source, and links the canonical MSU URL.

Same surface model as policies: one chain tool for natural-language queries (the primary entry) and one raw getter for power users. Tool count grows from 5 to 7.

## Non-goals

This round is academic dates and residence-life milestones only. Out of scope:

- Event-discovery questions like *"what's happening tonight on campus?"* — the MSU Events calendar, library events, ORED seminars, alumni events, research compliance training, extension events are all deferred.
- Third-party calendars listed at `msstate.edu/calendars` but hosted off-domain: hailstate.com (athletics, Sidearm Sports app), mshorsepark.com, outlook.office365.com (published IT Services Outlook calendar). These would require expanding the corpus rule to non-msstate.edu domains and are explicitly excluded this round.
- Course-level schedules (your specific class times). Different system (myState / Banner), different access model.
- Calendar reminders, push notifications, ICS feed generation — read-only lookup only.
- New MCP server. Tools land inside the existing `msstate-policies` server bundle; npm package name, Worker URL, and plugin id stay unchanged. The README will reframe the server's coverage from "MSU operating policies" to "MSU operating policies + MSU academic dates" without renaming.
- Version bump strategy — to be decided during implementation; this spec assumes a single minor bump (0.3.0 → 0.4.0) at release time.

## Sources

Six pages on five msstate.edu subdomains. All URLs are hardcoded — no dynamic URL construction is permitted under the corpus rule extension below.

| # | Calendar | URL | Subdomain | Parser shape |
|---|---|---|---|---|
| 1 | Academic Calendar | `https://www.registrar.msstate.edu/calendars/academic-calendar` | registrar | A (single-page date table) |
| 2 | Examination Schedule | `https://www.registrar.msstate.edu/students/schedules/exam-schedule` | registrar | A |
| 3 | University Holidays | `https://www.hrm.msstate.edu/benefits/holidays/` | hrm | A |
| 4 | Graduate School Calendar | `https://www.grad.msstate.edu/students/graduate-school-calendar` | grad | A |
| 5 | Financial Aid Important Dates | `https://www.sfa.msstate.edu/calendars/` (index) + `/calendars/academic-calendar/<year>/<term>` sub-pages | sfa | B (term-index + per-term date tables) |
| 6 | Housing Calendar | `https://www.housing.msstate.edu/events/` | housing | C (paginated Drupal event listing) |

### Parser shapes

**Shape A — single-page date table.** One HTTP fetch per source. Page contains a table or definition-list mapping event names to dates or date ranges. Parser extracts rows directly. Sources 1–4.

**Shape B — index + per-term sub-pages.** SFA's `/calendars/` page is a hub listing terms by academic year. Each term has its own sub-page at `/calendars/academic-calendar/<year>/<term>` (currently 21 sub-pages spanning 2 academic years). Build pipeline fetches the index, extracts term URLs, fetches each, parses the date table on each. Concurrency limit 4 with per-fetch 15s timeout.

**Shape C — paginated Drupal event listing.** Housing's `/events/` page renders events with title + date (or date range) + description. Build pipeline walks page 1 only (covers the current ~3-month window — events further out aren't typically published). Each event normalizes to a single row; date ranges are preserved (`start` ≠ `end` allowed).

## Architecture

Mirrors the existing policy pipeline structurally. No shared-infra refactor of `scraper.ts` / `search.ts` / `corpus.ts` — calendars get parallel files. The policy code stays untouched.

### New files

```
msstate-policies/src/calendars/
├── parsers/
│   ├── date_table.ts         # Shape A — selectors per source, returns rows
│   ├── term_index.ts         # Shape B — SFA index walk + per-term parsing
│   └── event_list.ts         # Shape C — Housing pagination + event extraction
├── scraper.ts                # Top-level: fetch + dispatch to the right parser
├── corpus.ts                 # Worker-snapshot reader; local-mode live fetch
├── search.ts                 # BM25 over event names + descriptions (weighted: event 3×, description 1×); ranks for chain tool
└── types.ts                  # CalendarRow, CalendarSource, etc.

msstate-policies/src/tools/
├── find_msu_date.ts          # Chain tool — natural-language entry
└── get_msu_calendar.ts       # Raw getter — by source + optional term

msstate-policies/tests/fixtures/calendars/
├── registrar_academic.html
├── registrar_exams.html
├── hrm_holidays.html
├── grad_school.html
├── sfa_index.html
├── sfa_term_2026_fall.html   # representative term sub-page
└── housing_events.html

msstate-policies/eval/
└── eval-calendars-2026-05-11.json   # ~15–20 hand-written Qs
```

### Modified files

- `msstate-policies/src/index.ts` — register `find_msu_date` and `get_msu_calendar` in `TOOLS`; tool count 5 → 7.
- `msstate-policies/src/tools/health_check.ts` — add fields: `calendars_row_count`, `calendars_last_build`, `calendars_per_source` (row count per source id), `calendars_last_error` (per source).
- `msstate-policies/src/types.ts` — add calendar types (or import from the new `calendars/types.ts`).
- `scripts/build-worker-corpus.mjs` — scrape all 6 sources, write a new top-level `academic_calendar` key to `worker/corpus.json` alongside the existing policy data. WAF challenge on any source aborts the calendar block of the build (does not poison the corpus). Same `mkdirSync({ mode: 0o700 })` / `writeFileSync({ mode: 0o600 })` discipline applied to any disk cache that lands.
- `worker/src/index.ts` — expose `find_msu_date` and `get_msu_calendar` from the Worker too, reading from the same `corpus.json`'s `academic_calendar` block. Maintains parity with stdio server. Same 64 KB body cap, same 4096-char query length cap, same JSON-RPC error response shape.
- `worker/wrangler.toml` — no change (corpus.json is the only build artifact, size grows by tens of KB).
- `tools/security-checklist.sh` — extend with greps that enforce: (a) the new corpus URLs are hardcoded, (b) no `https://` fetch in `calendars/` touches non-msstate.edu hosts, (c) the disk-cache mode bits apply to any new cache file, (d) Worker error path for new tools follows the structured-message pattern (no `(err as Error).message` leaks). Target: keep score at 192/192 or extend the gate proportionally if new check categories land.
- `README.md` — add a paragraph to the "What this does" / overview area noting calendar coverage. Update the example questions list to include 1–2 date questions. Tool-count references update from 5 → 7.
- `CLAUDE.md` — add the CORPUS RULE addendum (see below).

## Tool surface

### `find_msu_date({ q: string })`

Natural-language chain tool — the primary entry. Mirrors `chain_find_relevant_policies`. Returns up to 5 matching rows ranked by BM25 score, each with the row fields below plus a one-line citation. Includes a `notes` field that surfaces ambiguity (*"'break' matched Spring Break + Thanksgiving Break + Fall Break — disambiguate by asking which term"*).

Input schema:
```json
{ "q": "string (1..4096 chars)" }
```

Output:
```json
{
  "matches": [ /* up to 5 CalendarRow */ ],
  "notes": "string",
  "corpus_built_at": "ISO-8601 | null"
}
```

`corpus_built_at` is the build timestamp of the Worker snapshot when running in Worker mode. In the local-install live-fetch path there is no corpus, so the field is `null` — the LLM should fall back to the per-row `retrieved_at` for freshness signaling.

### `get_msu_calendar({ source: string, term?: string })`

Raw dump. `source` is one of 6 fixed ids (see CalendarSource enum below). `term` is optional and matches against the row's `term` field with case-insensitive substring (`"Fall 2026"`, `"2026"`, or `"fall"` all valid). No `term` returns all rows for that source.

Input schema:
```json
{
  "source": "academic_calendar | exam_schedule | university_holidays | grad_school_calendar | sfa_financial_aid | housing",
  "term": "string (optional)"
}
```

Output:
```json
{
  "rows": [ /* CalendarRow[] */ ],
  "source_url": "string",
  "corpus_built_at": "ISO-8601 | null"
}
```

Same `corpus_built_at` convention as the chain tool: Worker mode populates it; local-install live-fetch returns null.

### `health_check` extension

Existing tool. Adds the calendar status fields described under "Modified files." No new tool, just more keys in the JSON it returns.

## Data shape

```typescript
type CalendarSource =
  | "academic_calendar"
  | "exam_schedule"
  | "university_holidays"
  | "grad_school_calendar"
  | "sfa_financial_aid"
  | "housing";

type CalendarRow = {
  source: CalendarSource;
  event: string;            // e.g. "Spring Break", "Halls Close for Spring 2026"
  start: string;            // ISO date, YYYY-MM-DD
  end: string;              // ISO date; equals `start` for single-day events
  time?: string;            // optional, e.g. "12:00 PM CST" for housing rows
  term?: string;            // normalized, e.g. "Spring 2026", "Fall 2026"; null when not applicable (holidays)
  description?: string;     // free-text from the source, truncated to 500 chars
  source_url: string;       // canonical URL on msstate.edu
  retrieved_at: string;     // ISO-8601 UTC
};
```

All times in `time` are preserved verbatim from the source — no timezone normalization. MSU pages use CST/CDT inconsistently and we don't want to lose that signal.

## Freshness model

Parallel to policies:

- **Worker (hosted via the connector at `msstate-policies-mcp.mminsub90.workers.dev/mcp`)**: reads from the `academic_calendar` block of `worker/corpus.json`. Snapshot is refreshed at build time, same release cadence as the policy snapshot.
- **Local install (`npx -y msstate-policies-mcp`)**: live-scrapes each source on cold request, caches in memory. Optional disk cache via existing `MSSTATE_POLICIES_CACHE=disk` (no new env var). Cache TTL: 6h for housing (volatile), 24h for the other 5 (stable).

Housing's freshness profile is the only non-uniform one. All 6 sources' rows include `retrieved_at`; consumers can detect staleness themselves. The chain tool's response includes `corpus_built_at` so the LLM can say "*as of [date], the nearest matching event is…*" when relevant.

## Corpus rule extension

The CORPUS RULE in `CLAUDE.md` currently locks the server to `policies.msstate.edu` only. This round extends it. New section to add under the existing CORPUS RULE, with this exact intent:

> **Corpus extension (2026-05-11) — academic dates.** The corpus also includes six named pages on msstate.edu subdomains:
>
> 1. `https://www.registrar.msstate.edu/calendars/academic-calendar`
> 2. `https://www.registrar.msstate.edu/students/schedules/exam-schedule`
> 3. `https://www.hrm.msstate.edu/benefits/holidays/`
> 4. `https://www.grad.msstate.edu/students/graduate-school-calendar`
> 5. `https://www.sfa.msstate.edu/calendars/` and its `/calendars/academic-calendar/<year>/<term>` sub-pages
> 6. `https://www.housing.msstate.edu/events/` and its event-detail sub-pages
>
> All other corpus rule prohibitions apply unchanged: no training-data fallback, no third-party mirrors, no fetches against non-msstate.edu hosts, no WebSearch on these topics. Source URLs are hardcoded — no dynamic URL construction; SFA's per-term sub-page URLs are extracted at runtime from the SFA index page (which is itself in the allowlist), not built from a template against arbitrary external input.

The same per-pattern enforcement that protects the policy corpus moves to the calendar corpus: WAF challenge aborts the build; no `(err as Error).message` leakage in Worker error paths for the new tools; same 64 KB body cap and 4096-char query cap on the new endpoints.

`SECURITY.md`'s "Out of scope: client-side circumvention" section already covers the relevant abuse classes (local edits to the bundle, prompt-level circumvention, fork-the-corpus, LLM hallucination). No new section needed there.

## Error handling

Same posture as policies. Per-tool failure modes the implementation must handle:

| Failure | Worker | Local install |
|---|---|---|
| Source returned non-200 | Tool returns `{ matches: [], notes: "Worker corpus may be stale" }` if cached; otherwise generic JSON-RPC error with `id` | Tool returns structured error; logs HTTP code to stderr; retries are NOT automatic |
| Source returned WAF challenge | At build time: aborts the calendar block of the build, does NOT poison the corpus | At runtime: returns generic error; logs `WAF challenge detected on <source>` to stderr |
| Parser returned 0 rows | At build time: build aborts (silent regression is worst-case failure mode per CLAUDE.md) | At runtime: tool returns empty + populates `health_check`'s `calendars_last_error` |
| Source HTML structure drifted (selectors miss a row) | Detected at parser-test time on the fixture, not at runtime | Same — relies on fixture tests in CI |
| Query > 4096 chars | Worker rejects at body-read time with 413 | Local install rejects at handler entry |

Worker error paths must NOT echo `(err as Error).message` to the client. Structured fields are logged server-side; the client gets `{ "error": { "code": -32000, "message": "find_msu_date failed", "data": { "id": "<jsonrpc-id>" } } }`.

## Testing

### Parser unit tests

One fixture HTML file per source, captured from a known-good fetch at design time. Tests assert the parser extracts the expected number of rows and that key rows (a recognizable holiday, a recognizable academic milestone) match expected shape. Lives at `msstate-policies/tests/fixtures/calendars/` with corresponding `*.test.ts` next to each parser.

Fixture refresh policy: when a parser test fails because of legitimate site drift, the fixture and the parser are updated together in one PR. The fixture is the source of truth for "what the page looked like when we last verified."

### End-to-end eval

15–20 hand-written questions at `msstate-policies/eval/eval-calendars-2026-05-11.json`, similar to the existing policy eval. Each entry has:

```json
{
  "q": "When does spring break start in spring 2026?",
  "expected_source": "academic_calendar",
  "expected_event_substring": "Spring Break",
  "expected_start_date": "<actual ISO date filled in from the live scrape during eval authoring>",
  "tags": ["academic", "registrar"]
}
```

The `expected_start_date` placeholder above is illustrative only — the eval-authoring task populates real ISO dates pulled from the actual MSU pages at write time, per the corpus rule.

Judge: same Sonnet 4.6 setup as the policy eval. A correct answer must quote the date verbatim from the chain tool's response and cite the source URL.

### CI smoke test

The existing `build-and-test` job runs `scripts/build-worker-corpus.mjs` end-to-end against the live MSU sites. Calendar fetch failures fail the build. This is the only thing standing between transient MSU outages and a poisoned corpus, per CLAUDE.md's note on the existing policy build.

## Documentation deliverables

Once the implementation lands:

- **README.md** — new bullet in the "What this does" section, two additional example questions ("When does spring break start?" and "When is fall move-in?"), updated tool count (5 → 7). No new top-level section unless we discover ChatGPT or Claude needs different framing during testing.
- **CLAUDE.md** — corpus rule addendum text from above.
- **docs/BUILD.md** — new subsection under the existing architecture notes covering the three parser shapes, the SFA two-level crawl, and the housing snapshot freshness caveat.
- **`msstate-policies/eval/eval-calendars-2026-05-11.json`** — new file with the eval set.
- **`SECURITY.md`** — no change needed; the "client-side circumvention" out-of-scope section already covers the abuse classes.

## Risks

**R1. Source HTML drifts and a parser silently returns 0 rows.**
Likelihood: high over a multi-year horizon, low per-quarter. Mitigation: CI smoke test fails the build if any source returns 0 rows; fixture tests catch the drift on the next PR. Same defense the policy scraper relies on.

**R2. SFA's per-term URL pattern changes.**
Likelihood: medium. SFA's URLs use a `/calendars/academic-calendar/<year>/<term>` slug that may shift. Mitigation: SFA parser doesn't construct URLs — it extracts them from the index page at build time, so a slug change is automatically picked up. The pattern is only fragile if SFA restructures the index itself, which trips R1.

**R3. Housing event listing changes pagination structure.**
Likelihood: low-medium. Drupal events listings are reasonably standardized. Mitigation: parser fetches only page 1, so pagination changes don't matter as long as page 1 still loads. Fixture test detects layout changes.

**R4. Date parsing edge cases.**
"November 25-29, 2025" vs "Nov 25 - Nov 29" vs "Tuesday, November 25" vs "Nov 25-29" — multiple formats appear across MSU pages. Mitigation: each parser owns its date-string normalization, tested against the fixture. Don't try to share a single date parser across all 6 sources; the cost of "one good parser to rule them all" is higher than the value.

**R5. Snapshot staleness on housing.**
Likelihood: certain. The Worker snapshot is at most as fresh as the last release; housing publishes new events between releases. Mitigation: `find_msu_date` response includes `corpus_built_at`; chain tool's instruction text tells the LLM to surface staleness when the answer is housing-related. Users wanting always-fresh data run the local install.

**R6. CORPUS RULE expansion creates a slippery slope.**
Likelihood: medium. Once "msstate.edu subdomains other than policies" is allowed, adding more (athletics → hailstate, library events, etc.) becomes a smaller ask each time. Mitigation: the addendum lists six hardcoded URLs, not "any *.msstate.edu page". Adding a seventh requires a new spec and a new addendum entry.

**R7. Tool naming collides with future MCP additions.**
`find_msu_date` is broad. If we later add event-discovery or course-schedule tools, naming will need to differentiate. Acceptable risk — renaming tools later is mechanical, and this round's tool names match this round's scope.

## Acceptance criteria

This spec is "done" when ALL of:

1. The 7 tools list correctly across all clients (Claude Code plugin, claude.ai connector, ChatGPT Plus connector, local Claude Desktop, OpenAI API path).
2. `find_msu_date` answers each of the 15–20 eval questions correctly per the judge (target: 95%+ to match the policy eval bar, with documented misses).
3. `get_msu_calendar` returns a non-empty result for each of the 6 sources when called without a `term` filter.
4. `health_check` reports `calendars_row_count > 0` and `calendars_last_error: null` for all 6 sources on a green build.
5. `tools/security-checklist.sh` scores 192/192 (or higher if new check categories land) on the merge commit.
6. README, CLAUDE.md, and docs/BUILD.md all reflect the new scope.
7. The CORPUS RULE addendum is present in `CLAUDE.md` and the per-URL grep enforcement is in `tools/security-checklist.sh`.

## Implementation plan

Created via `superpowers:writing-plans` after user approval of this spec. Plan will be sized accordingly — likely 8–12 tasks covering (in dependency order): parsers + fixture tests → corpus loader + search → chain tool + raw getter → build script extension → Worker integration → health_check extension → eval set → docs + security-checklist updates → release.
