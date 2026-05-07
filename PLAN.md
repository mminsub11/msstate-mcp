# MSU Policies MCP Server — Plan (v2)

> **What changed from v1:** scope cut from 8 tools to 3, eval set is now a v1 prerequisite, hardcoded Drupal taxonomy IDs removed, MCP gotchas (stderr logging, zod→JSON Schema, `isError`) made explicit, success metrics + kill criteria added, license picked (MIT), CI specified, `dist/` drift defended with a CI check.

## Context

The user wants an MCP server analogous to [`chrisryugj/korean-law-mcp`](https://github.com/chrisryugj/korean-law-mcp) but for **Mississippi State University Operating Policies** at <https://www.policies.msstate.edu/current>. Architecture mirrors `korean-law-mcp`: expose **search + fetch primitives** plus one **chain** tool that bundles search→fetch into a single call. Grounding arises naturally — the LLM only ever sees official MSU text the MCP just returned.

The user uploaded a saved copy of `/current` so we have ground truth on the markup; the scraper is written against verified selectors rather than guesses.

### Verified site structure (from uploaded HTML)

- Index page is a Drupal view with one table `<table id="datatable">`.
- Each `<tr>` has six cells: `Number` (e.g. `01.01`), `Title` (links to `/policy/{slug}` where slug is the 4-digit concatenation, e.g. `0101`), `Status` (`<span class="badge bg-success">Current</span>`), `Date Authored` (`<time datetime="ISO">` — see note below), `Attachment` (yes/no), `Download` (`<a class="btn-download" href="/sites/www.policies.msstate.edu/files/policies/{slug}.pdf">`).
- **Policy text lives in the PDF**, not on the landing page. The landing page only shows metadata + a download button. So `get_policy` must download and parse the PDF.
- Filters: `<select name="volume">` (9 volumes labeled `Volume I … Volume IX`) and `<select name="section">` (35 sections, e.g. `Academic OP/Faculty`, `Intercollegiate Athletics`).
  - **Important: do not hardcode the option values.** Drupal taxonomy term IDs are DB surrogate keys, not stable identifiers — they renumber on migrations, restores, or re-imports. Parse the dropdowns at runtime to build a `label ↔ id` map; tools accept human inputs ("Volume I", "Intercollegiate Athletics") and resolve through the map. Hardcoding `36–44` / `1–35` (as v1 of this plan did) silently breaks the day MSU touches Drupal.
- Volume/section is **not** inferable from the policy number prefix (`01.02 Sports Wagering` is Athletics, not Presidential Matters). Membership requires the filtered request.
- Policy numbers are **NN.NN** (regex `^\d{2}\.\d{2}$`), 4 digits total. Slug = number with dot stripped.
- "Date Authored" ≠ "Last Revised". Treat the index `<time datetime>` as **first-authored / table sort date** only. True revision dates live in the PDF metadata block; do not surface "recent changes" semantics off the index column alone.

## Users & Problem (be honest about the segments)

The headline JTBD — "*a student asks Claude 'what are the rules on amnesty?' at 11pm and gets a grounded answer*" — collapses three different personas with very different distribution fits:

| Persona | Volume / urgency | MCP install fit | Best surface |
|---|---|---|---|
| Undergrad in a jam at 11pm | Spiky, high urgency | Near zero — won't edit JSON config | **Hosted web demo** (post-v1) |
| Staff / RA / advisor answering the same question repeatedly | Steady, business hours | Moderate — Claude Desktop plausible | **MCP server** (this v1) |
| Faculty / dept admin (HR 91.xx, travel, IP, grants) | Low volume, citation-grade | High — already power users | **MCP server** (this v1) |

**v1 explicitly targets the staff/faculty personas**, where MCP install friction is acceptable. The 11pm-undergrad surface is deferred to v0.2 (see "Out of scope for v1" below) and will likely be a thin hosted web app sharing the same scraper/search modules.

Hidden segments worth noting but not building for: Title IX / conduct officers, internal auditors, accreditors (SACSCOC reaffirmation cycles), MSU's own legal/comms team, and other SEC universities who'd want the same shape of tool for their policy site (the actual TAM story).

## Success metrics & kill criteria

PLAN.md v1 had none. v1 ships with these instrumented from day one (the eval set is the only one that needs new infra; the rest are log counters):

1. **Grounded-answer rate** (the only metric that says the product *works*): on a hand-built eval set of 30 representative questions, % where the model's answer cites a correct OP number AND that OP is the canonical source. **Target ≥ 85%.** Eval lives in `msstate-policies/eval/questions.jsonl` and is run by `npm run eval` against a local Claude session via the MCP inspector or scripted JSON-RPC.
2. **Activation:** % of installs that issue ≥1 successful `tools/call` within 24h. Target ≥ 60%.
3. **Time-to-answer:** p50 wall-clock from `chain_find_relevant_policies` invocation → return. Target < 6s warm, < 12s cold.
4. **Stale-content incidents:** count of cases where cache served text from a revision superseded by a newer one in the live index. Target = 0; alert (log-level `error`) if > 0.
5. **Weekly active questions:** opt-in anonymous counter (off by default) or, failing that, npm download trend + GitHub stars/issues as proxy.

**Kill criteria** (explicit so the project doesn't zombie-run): if 60 days post-launch we have < 25 weekly install-and-use signals OR eval grounded-answer rate < 70%, sunset the project or pivot to the hosted web surface.

## Distribution — dual mode (plugin + plain MCP)

End users land in two camps:
- **Claude Code users** → `/plugin marketplace add mminsub11/msstate-mcp` then `/plugin install msstate-policies@msstate-mcp`. Two commands, no JSON editing.
- **Claude Desktop / Cursor / Windsurf / Zed / claude.ai connector users** → can't use Claude Code plugins, so they need the plain MCP-server path: `npx -y msstate-policies-mcp` plus a config snippet they paste into their MCP-client config.

Both paths run **the same `dist/index.js`**. The repo plays two roles:
- The **repo root** is a Claude Code marketplace (`.claude-plugin/marketplace.json`).
- The `msstate-policies/` subdir is *both* the plugin (`.claude-plugin/plugin.json` inside it) *and* a publishable npm package (its own `package.json`).

To make the plugin path work without `npm install` on the user's machine, the build **bundles all dependencies into a single `dist/index.js`** with esbuild, and that `dist/` is **committed to the repo** (otherwise `${CLAUDE_PLUGIN_ROOT}/dist/index.js` wouldn't exist after `claude plugin install` clones the repo). For npm/npx the same bundle is what gets published.

**Version sync:** `msstate-policies/package.json#version` is the single source of truth. A `scripts/sync-version.mjs` step (run by `prepublishOnly` and `npm run build`) writes the same value into `msstate-policies/.claude-plugin/plugin.json`. Don't hand-edit the plugin manifest's version.

### Out of scope for v1 (deliberate)

- **Hosted web demo** for the undergrad JTBD.
- **Embeddings-based search** (Voyage / `text-embedding-3-small`). Token+BM25 is fine for 218 docs.
- **Historical / superseded policies** beyond what the PDF metadata block exposes.
- **Telemetry server** beyond opt-in local counters.
- **5 of the original 8 tools** (`find_by_topic`, `get_recent_changes`, `get_policy_history`, `list_by_volume`, `list_by_section`) — see "Tools" section.

## Stack & Layout

- **Language:** TypeScript, Node ≥ 18 (uses global `fetch`)
- **MCP SDK:** `@modelcontextprotocol/sdk` (stdio transport)
- **Parsing:** `cheerio` for HTML; `pdf-parse` for the actual policy PDFs.
  - Bundle pdf-parse via the inner module: `import 'pdf-parse/lib/pdf-parse.js'` to skip the index file's test-PDF loader.
  - **Pin the exact `pdf-parse` version** in `package.json` (no caret). The inner-module trick depends on internal layout that has shifted between versions.
  - CI runs a fixture-PDF smoke test (`tests/parse-fixture.test.ts`) that imports the bundled `dist/index.js` and parses one committed sample PDF. Catches transitive breaks before publish.
- **Validation:** `zod` for runtime input validation. **Derive JSON Schema for `tools/list` from zod via `zod-to-json-schema`** — do not hand-write parallel schemas, they will drift.
- **Bundling:** `esbuild` → single `dist/index.js`, committed.
  - Config: `platform: 'node'`, `target: 'node18'`, `format: 'cjs'` (avoid ESM-vs-pdf-parse-CJS pain), `bundle: true`, `minify: false` (committed code should be diff-readable).
  - `--banner:js="#!/usr/bin/env node\n// msstate-policies-mcp <version> <git-sha> built <iso-date>"` so the bundle self-identifies.
- **Logging:** **All logging goes to stderr.** stdio's stdout is reserved for JSON-RPC framing; one stray `console.log` corrupts the protocol. Use a tiny `log(level, msg, fields?)` helper that writes JSON lines to stderr.
- **TTLs (mirroring korean-law-mcp):** index/search results cached **1 h**, individual policy bodies cached **24 h**. In-memory by default; opt-in disk cache under a cross-platform path via `env-paths` (so Windows users land in `LOCALAPPDATA`, not `~/.cache/`).

```
msstate-mcp/                              # repo root = Claude Code marketplace
├── .claude-plugin/
│   └── marketplace.json                  # marketplace manifest
├── README.md                             # both install paths + "unofficial" disclaimer
├── LICENSE                               # MIT
├── .gitignore                            # ignores node_modules/, NOT dist/
├── .github/workflows/ci.yml              # typecheck, build, dist-clean check, fixture tests
├── examples/
│   └── claude_desktop_config.json
└── msstate-policies/                     # the plugin == the npm package
    ├── .claude-plugin/
    │   └── plugin.json                   # plugin manifest (mcpServers entry)
    ├── package.json                      # publishable to npm; bin: dist/index.js
    ├── tsconfig.json                     # typecheck only (noEmit)
    ├── build.mjs                         # esbuild bundler + version sync + banner
    ├── README.md                         # plugin-local readme
    ├── eval/
    │   ├── questions.jsonl               # 30 grounded-answer eval questions
    │   └── run-eval.mjs                  # MCP-driven scoring harness
    ├── tests/
    │   ├── fixtures/
    │   │   ├── current.html              # saved /current (ground truth)
    │   │   └── 91100.pdf                 # one real PDF, committed
    │   ├── scraper.test.ts               # parse fixtures, assert row counts + IDs
    │   └── parse-fixture.test.ts         # imports dist/index.js, parses fixture PDF
    ├── dist/
    │   └── index.js                      # COMMITTED bundle
    └── src/
        ├── index.ts                      # MCP server entry (stdio)
        ├── log.ts                        # stderr-only structured logger
        ├── types.ts                      # PolicyEntry, PolicyDocument, PolicyIndex
        ├── cache.ts                      # TTLCache<T> (mem + optional disk)
        ├── http.ts                       # fetch with UA, retry, WAF detection
        ├── scraper.ts                    # fetchIndex(), fetchPolicy()
        ├── search.ts                     # tokenize + score (NFKC, lowercase, BM25-lite)
        ├── corpus.ts                     # lazy body fetches with concurrency-4 + disk cache
        └── tools/
            ├── search_policies.ts
            ├── get_policy.ts
            ├── chain_find_relevant.ts
            ├── cite_policy.ts
            └── health_check.ts
```

## Tools (5 — 3 product + cite + health)

The pattern is intentional: the LLM uses **`search_policies` → `get_policy`** when it wants to think iteratively, and uses **`chain_find_relevant_policies`** for one-shot natural-language questions. Either way the LLM only sees official MSU text, so the answer is grounded. `cite_policy` is a 30-line citation formatter. `health_check` lets operators (and the LLM) see when the scraper is broken.

Tool descriptions are the single highest-leverage piece of prompt engineering in this project. They are written verbatim below — not "TBD."

| Tool | Input | Output / behavior |
|---|---|---|
| `search_policies` | `{ query: string, limit?: number = 10, include_body?: boolean = false }` | Token-match `query` against title + number; if `include_body`, also against full PDF text. Returns ranked list of `{ number, title, url, snippet, score }`. Description: *"Search Mississippi State University Operating Policies by keyword. Returns policy numbers + titles + URLs + match snippets, ranked by relevance. Use this when the user asks about a topic and you need to find which policies apply. For one-shot natural-language questions ('what's the rule on X?'), prefer `chain_find_relevant_policies` instead, which fetches full bodies in one call."* |
| `get_policy` | `{ number?: string, url?: string }` | Resolve via index → `pdfUrl`, fetch PDF, extract text + metadata. Returns full `PolicyDocument` including `retrievedAt` ISO timestamp and the canonical landing URL. Description: *"Fetch the full text of one MSU Operating Policy by number (e.g. '91.100') or URL. Returns policy text from the official PDF, plus effective/revised dates and responsible office. Use after `search_policies` to read a specific policy in full."* |
| **`chain_find_relevant_policies`** *(chain)* | `{ question: string, k?: number = 2 }` | Runs `search_policies` (full-text), picks top-`k` (**default 2 to keep response under ~16k tokens**), fetches each full body, returns array of `PolicyDocument`. Description: *"One-call workflow for natural-language MSU policy questions like 'what are the rules on amnesty?' Searches and returns the full text of the top-k most relevant policies. Answer the user's question using ONLY the returned text and cite the policy number + URL. If none of the returned policies actually answer the question, say so plainly — do not extrapolate."* |
| `cite_policy` | `{ number: string, style?: "short" \| "full" }` | Returns formatted citation, e.g. *"Mississippi State University Operating Policy 91.100, 'Title', effective YYYY-MM-DD. Retrieved from {url} on {today}."* |
| `health_check` | `{}` | Returns `{ index_row_count, last_index_fetch, last_index_error, volumes_discovered, sections_discovered, cache_hit_rate, version, git_sha }`. Visible to the LLM so it can apologize coherently when the scraper is broken instead of cheerfully saying "MSU has no policy on amnesty." |

### Deferred to v0.2 (write the schema once we have eval data showing the gap)

- `find_by_topic` — redundant with `search_policies({ include_body: true })`.
- `get_recent_changes` — semantically ambiguous against the index's "Date Authored"; needs per-policy revision date extraction first.
- `get_policy_history` — history block isn't in `/current`, requires a separate fetch path.
- `list_by_volume`, `list_by_section` — Claude can filter post-hoc from one full index call; defer until eval shows it actually helps grounding.

### Tool error contract

Tools never throw across the MCP boundary. On failure, return `{ isError: true, content: [{ type: "text", text: structured_message }] }` where `structured_message` is one of: `"MSU site returned NNN"`, `"Policy {number} not found"`, `"PDF could not be parsed for {number}"`, `"WAF challenge page detected — try again later"`, `"Index parse returned 0 rows — selectors may be stale, see health_check"`. The LLM can recover or apologize coherently from these; it cannot from a thrown stack trace.

## Scraper Design

### Index fetch (`scraper.fetchIndex({ volumeId?, sectionId? })`)
1. GET `https://www.policies.msstate.edu/current` (with optional `?volume={id}` or `?section={id}`) using a desktop User-Agent. Concurrency 4, retry on 429 honoring `Retry-After`.
2. **WAF / challenge detection:** if the response body contains `Just a moment...`, `cf-chl-bypass`, or `<meta http-equiv="refresh"` pointing back to the same host with a token, throw `WAFChallengeError`. Do NOT cache empty results from a challenge page for an hour.
3. cheerio: select `#datatable tbody tr`. For each row:
   - `td:nth-child(1)` text → `number`. Skip rows that don't match `/^\d{2}\.\d{2}$/`.
   - `td:nth-child(2) a` → `title` (link text) and `landingUrl` (resolve `href="/policy/0101"` → absolute).
   - `td:nth-child(3) .badge` text → `status`.
   - `td:nth-child(4) time[datetime]` → `firstAuthoredOrSorted` (NOT `lastUpdated` — see header note).
   - `td:last-child a.btn-download` href → `pdfUrl` (absolute). If absent, skip.
   - `slug` = number with dot removed.
4. Parse `select[name="volume"] option` and `select[name="section"] option` once to populate runtime `volumes`/`sections` lookup tables (id ↔ label). **Never hardcode IDs.**
5. **Sanity assertions:** `rowCount >= 100` (current corpus is ~218; 0 means selectors broke or WAF served us). `volumes.size >= 1`, `sections.size >= 1`. On assertion failure, log `error` to stderr and surface via `health_check.last_index_error`.
6. Cache 1 h per `{volumeId, sectionId}` key.

### Policy fetch (`scraper.fetchPolicy(numberOrSlug)`)
1. Look up entry in index → `pdfUrl`.
2. GET PDF as binary blob.
3. Run `pdf-parse` (inner-module import) → text. NFKC-normalize (smart quotes, ligatures), strip excessive whitespace, normalize line breaks.
4. **Sanity check:** if extracted text < 100 chars for a >2-page PDF, log warning and fall back to landing page (`/policy/{slug}`) extracted via cheerio. Track in `health_check`.
5. Pull metadata from the first ~50 lines via labelled patterns: `Policy Number:`, `Effective Date:`, `Reviewed:`, `Last Revised:`, `Responsible Office:`, `Approved By:`. Each field is best-effort: missing → `null` (not silently dropped). PDF text extraction order is *not* visual order, so prefer multi-line scans over strict regex anchoring.
6. Inherit `title`, `firstAuthoredOrSorted`, `landingUrl` from index entry. Add `retrievedAt: new Date().toISOString()`.
7. Cache 24 h per slug.

### Search (`search.score(query, entry)`)
- Lowercase + NFKC-normalize both query and corpus before tokenization.
- Token split on `/[\s\-_/.,;:()\[\]{}]+/`.
- Score: BM25-lite (term frequency × inverse document frequency), with **field weights** title × 3, number × 2, body × 1.
- Stem-light: lowercase only for v1; explicit "no stemmer" comment so the next person doesn't re-litigate it.
- Embeddings explicitly out of scope for v1; revisit if eval shows < 85% grounded-answer rate.

## MCP Wiring (`src/index.ts`)
- Create `Server` from `@modelcontextprotocol/sdk/server/index.js`.
- Register `ListToolsRequestSchema` returning the 5 tools; schemas derived from zod via `zod-to-json-schema`. Order is deterministic across calls (no `Math.random`).
- Register `CallToolRequestSchema` dispatching to tool modules; wrap each handler so thrown errors become structured `isError: true` returns per the error contract above.
- Connect `StdioServerTransport`. **Never `console.log`** — only `process.stderr.write` via `log.ts`.
- On startup: log version + git SHA + node version to stderr; do an opportunistic background `fetchIndex()` so the first user request is warm.

## PDF audit (one-time prerequisite, before writing tools)

A 1-hour task that has to happen before we trust `pdf-parse`:

1. Script `scripts/audit-pdfs.mjs` downloads all ~218 PDFs to `tmp/pdfs/`.
2. Runs each through the chosen `pdf-parse` import path.
3. Outputs `audit.csv` with: `number, bytes, page_count, extracted_chars, first_100_chars, has_smart_quotes, has_ligature_damage, parse_error?`.
4. **Pass criteria:** ≥ 95% of PDFs yield ≥ 500 extracted chars per page on average. < 5% with `parse_error`. If we fail this, switch to `pdfjs-dist` (heavier, but maintained).
5. Output is committed under `eval/audit-{date}.csv` so future regressions are visible.

## Eval set (also a v1 prerequisite)

`msstate-policies/eval/questions.jsonl` — 30 questions written by hand from the policy index, covering:
- 6 student-life questions (amnesty, withdrawal, parking, dorm pets, smoking, dining contracts)
- 6 academic questions (grade appeals, FERPA, academic integrity, course drops, transcripts, leave of absence)
- 6 HR questions (sick leave, travel reimbursement, conflict of interest, IT acceptable use, harassment reporting, telework)
- 6 conceptual questions where keyword overlap is weak ("can my RA write me up for a candle", "rules around firearms in dorms", etc.)
- 6 negative cases (questions that have no MSU policy answer; correct response is "no MSU policy covers this directly")

Format per line: `{ "q": "...", "expected_op_numbers": ["91.100"], "must_cite": true, "negative": false, "notes": "..." }`.

`scripts/run-eval.mjs` drives the MCP server via JSON-RPC, calls `chain_find_relevant_policies`, and scores: did the response cite at least one of the expected OP numbers? For negatives, did it correctly say no policy applies? Output: `eval-{date}.json` with per-question pass/fail + aggregate grounded-answer rate.

## Config Examples (in README + `examples/`)

**Path A — Claude Code (plugin):**
```bash
/plugin marketplace add mminsub11/msstate-mcp
/plugin install msstate-policies@msstate-mcp
```

**Path B — Claude Desktop / Cursor / Windsurf / Zed (plain MCP):**
```jsonc
{
  "mcpServers": {
    "msstate-policies": {
      "command": "npx",
      "args": ["-y", "msstate-policies-mcp"]
    }
  }
}
```

Also documented: pointing at a local checkout (`node /path/to/msstate-policies/dist/index.js`).

## README front-matter (must-have language)

The README opens with:

> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by Mississippi State University. It retrieves policy text from the public website at policies.msstate.edu for use by an LLM. Always verify against the official source before acting on the result.

Every `chain_find_relevant_policies` and `get_policy` response includes `retrievedAt` (ISO timestamp) and the canonical `landingUrl` so users can verify.

## Manifests

`.claude-plugin/marketplace.json` (repo root):
```json
{
  "name": "msstate-mcp",
  "owner": { "name": "mminsub11" },
  "plugins": [
    {
      "name": "msstate-policies",
      "source": "./msstate-policies",
      "description": "Mississippi State University Operating Policies via MCP."
    }
  ]
}
```

`msstate-policies/.claude-plugin/plugin.json` (version is written by `scripts/sync-version.mjs`):
```json
{
  "name": "msstate-policies",
  "version": "0.1.0",
  "description": "Mississippi State University Operating Policies via MCP.",
  "mcpServers": {
    "msstate-policies": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"]
    }
  }
}
```

## CI (`.github/workflows/ci.yml`)

On every push and PR:
1. `npm ci`
2. `npm run typecheck` — must be clean.
3. `npm run build` — produces `dist/index.js`.
4. `git diff --exit-code dist/` — fails CI if the committed bundle drifted from source. (This is the single most important hygiene check.)
5. `npm test` — runs `scraper.test.ts` (against fixture HTML) and `parse-fixture.test.ts` (imports `dist/index.js`, parses fixture PDF).
6. `tools/list` smoke test: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js | jq '.result.tools | length'` — assert exactly 5.

Eval (`npm run eval`) is not on every CI run because it makes live MSU requests; it runs nightly on schedule and on `release/*` branches.

## Critical files to create

- `package.json`, `tsconfig.json`, `.gitignore` — already scaffolded; will overwrite if needed.
- `LICENSE` — MIT, copyright `mminsub11`.
- `src/types.ts`, `src/cache.ts` — already scaffolded; both safe.
- `src/log.ts` — stderr-only structured logger.
- `src/http.ts` — fetch wrapper with UA, retry, WAF detection.
- `src/scraper.ts` — **isolate all selectors/regexes at the top** so it's a one-file fix when MSU changes layout. Runtime-discovered taxonomy maps only.
- `src/search.ts` — BM25-lite + NFKC + lowercase, no stemmer for v1.
- `src/tools/*.ts` — one per tool, each exports `{ name, description, inputSchema (zod), handler }`. JSON Schema derived via `zod-to-json-schema`.
- `src/index.ts` — MCP wiring, error wrapping, deterministic `tools/list`.
- `eval/questions.jsonl`, `scripts/run-eval.mjs`.
- `scripts/audit-pdfs.mjs`, `scripts/sync-version.mjs`.
- `tests/fixtures/current.html`, `tests/fixtures/91100.pdf`, `tests/scraper.test.ts`, `tests/parse-fixture.test.ts`.
- `README.md` — install, config, tool reference, "unofficial" disclaimer, "verifying selectors" troubleshooting section, kill-criteria note.

## Verification (manual; user will run, since sandbox can't reach MSU)

In `msstate-policies/`:
1. `npm install && npm run build` — produces `dist/index.js`. CI gate: `git diff --exit-code dist/` is clean after `npm run build`.
2. `npm run typecheck` — clean.
3. `npm test` — fixtures pass.
4. `tools/list` smoke: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js` — expect **5** tools listed.
5. `npm run audit:pdfs` — meets pass criteria (≥ 95% PDFs yield ≥ 500 chars/page).
6. `npm run eval` — grounded-answer rate ≥ 85% on the 30-question set.
7. Plugin path: `/plugin marketplace add ./` → `/plugin install msstate-policies` → ask "what's the policy on amnesty?" — Claude calls `chain_find_relevant_policies`, gets full policy text, answers citing OP number + URL + retrieval timestamp.
8. MCP path: drop the JSON snippet from `examples/claude_desktop_config.json` into Claude Desktop, restart, repeat.
9. Commit (including `dist/index.js`, `eval/audit-*.csv`, `eval/eval-*.json`) and push to `claude/msu-policies-mcp-UlB5L` (now merged into `claude/add-autoresearch-skill-BEzMA`).

## Open Risks

- **PDFs are mandatory.** Policy text only exists in PDFs. The audit step decides whether `pdf-parse` is good enough or we go to `pdfjs-dist`.
- **Selector / WAF fragility.** Mitigated by `health_check`, sanity assertions on row count + dropdown size, and explicit WAF detection. A scraper break surfaces as a structured error to the LLM, not as confidently-wrong "no such policy" answers.
- **Drupal taxonomy drift.** Hardcoded IDs are forbidden; runtime label↔id map only.
- **Committed `dist/`.** CI's `git diff --exit-code dist/` catches drift. Bundle banner self-identifies version + git SHA so you can tell at a glance whether a user is on stale code.
- **Bundle size.** cheerio + zod + MCP SDK + pdf-parse ≈ 2–3 MB unminified. Acceptable; documented.
- **Search quality.** BM25-lite + token field-weights is fine for 218 docs. Eval set tells us when to escalate to embeddings.
- **No undergrad surface in v1.** The 11pm JTBD genuinely needs a hosted web demo; explicit out-of-scope until eval data justifies the lift.
- **MSU brand / ToS.** "Unofficial" disclaimer in README + every tool response includes `landingUrl` for verification. No `robots.txt` violations: GET-only, concurrency 4, normal UA, honors `Retry-After`.
- **Windows path correctness.** `env-paths` instead of `~/.cache/`.
