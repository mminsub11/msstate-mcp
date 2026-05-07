# MSU Policies MCP Server — Plan (v4)

> **What changed from v3:** no privileged persona — the audience is the **MSU community broadly** (students, staff, faculty). The accuracy north star is **99.99%**, decomposed into measurable sub-metrics (retrieval correctness, answer correctness, refusal correctness) because no single eval can measure 99.99% directly. Tool descriptions now enforce "quote verbatim when stakes are high, refuse if uncertain" — the only realistic path to that bar with an LLM in the loop.

> **What changed from v2:** v1 ships three install paths (Claude Code plugin, plain MCP via `npx`, and copy-pasteable claude.ai MCP-connector instructions), plus a "Claude Project starter" zip for free claude.ai users with no install. Grounded-answer target raised from 85% → 99.99% (north star), kill criterion from 70% → 95%, eval set grown 30 → 50 questions, **hybrid retrieval (BM25 + pre-computed embeddings) is now v1**, not deferred.

> **What changed from v1:** scope cut from 8 tools to 5, eval set is now a v1 prerequisite, hardcoded Drupal taxonomy IDs removed, MCP gotchas (stderr logging, zod→JSON Schema, `isError`) made explicit, success metrics + kill criteria added, license picked (MIT), CI specified, `dist/` drift defended with a CI check.

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

## Users & Problem

**Audience: the MSU community broadly** — students, staff, faculty, RAs, advisors, conduct officers, anyone who asks a question that has an answer in an MSU Operating Policy. The JTBD is unchanged: *"ask Claude a policy question, get an answer grounded in official MSU policy text."* No privileged persona; we don't optimize the build around any one segment.

What we *do* optimize for is **friction-matched install paths** so anyone in that audience can reach the same MCP server through whatever client they already use:

| Surface | Who it serves | Friction |
|---|---|---|
| **Claude Code plugin** (`/plugin install msstate-policies@msstate-mcp`) | Anyone using Claude Code | 2 commands, no JSON |
| **Plain MCP via `npx`** for Claude Desktop / Cursor / Windsurf / Zed | Power users on any MCP-capable client | Paste a JSON snippet |
| **claude.ai MCP-connector** (documented copy-paste path) | Paid claude.ai users | UI install, no JSON edit |
| **Claude Project starter zip** (curated PDF bundle + system prompt template) | Free claude.ai users, anyone who wants no install | Drag-and-drop into a Project |

The "Claude Project starter" path is a 1-script artifact (`scripts/build-project-bundle.mjs`): downloads ~30 high-traffic policies (amnesty, withdrawal, FERPA, parking, dorms, conduct, grade appeals, Title IX, financial aid, leave-of-absence, sick leave, travel reimbursement, IT acceptable use, IP, conflict of interest, etc.) and zips them with a system-prompt template that says "answer only from these PDFs, quote verbatim for normative claims, cite the OP number, refuse if not covered." Released as a GitHub release asset. Not as good as the live MCP — partial corpus, no daily refresh — but works for users who can't or won't install MCP.

A **hosted web demo** stays on the v0.2 list (see "Out of scope for v1"). We ship v1 first, watch the metrics, then justify hosting cost with eval + usage data.

Adjacent audiences noted but not built for: accreditors (SACSCOC reaffirmation cycles), MSU's own legal/comms team, other SEC universities who'd want the same shape of tool for their policy site (the actual TAM story).

## Success metrics & kill criteria

### Accuracy: 99.99% as the north star, decomposed into measurable sub-metrics

A wrong answer about amnesty, Title IX, FERPA, or grade appeals isn't a search miss — it can affect a real decision. The aspiration is **99.99% answer correctness** ("never wrong"). Honestly: no eval of any practical size measures 99.99% directly — a 50-question eval can only confirm "0 errors observed at this sample size." So we decompose accuracy into three sub-metrics that ARE measurable, and we hold each to a high bar:

| Metric | What it measures | Target | How |
|---|---|---|---|
| **Retrieval correctness** | For each eval question with a known canonical OP, did the chain tool's top-k include it? | **≥ 99%** on the 50-question eval | Deterministic check — does `chain_find_relevant_policies(question).map(p => p.number)` contain `expected_op_numbers[0]`? Independent of the LLM. |
| **Answer correctness** | Given correct retrieval, is the model's prose answer consistent with the cited policy text? No hallucinated "except"/"unless" clauses, no fabricated procedures, no wrong dates. | **0 errors observed** on the 50-question eval (≈ 99% lower-bound at this sample size) | LLM-judge: a separate Claude API call grades each answer against the retrieved policy text. Plus 100% manual review of all eval runs before each release. |
| **Refusal correctness** | When no MSU policy applies (negative cases), did the model refuse plainly without fabricating a citation? | **100%** on the 12 negative cases in the eval | Deterministic — answer must contain a refusal phrase ("no MSU policy directly covers", "the available policies do not address", etc.) and must NOT contain a fabricated OP number. |

The 99.99% bar lives in three places in the design, not just in the eval:
1. **Retrieval is hybrid (BM25 + pre-computed embeddings)** so conceptual queries don't get dropped on the floor.
2. **`chain_find_relevant_policies` returns full policy text**, and its tool description aggressively pushes the LLM to **quote verbatim** for normative claims and **refuse if uncertain** rather than paraphrase.
3. **`health_check` exposes parse-failure state** so the LLM can apologize coherently rather than confidently saying "MSU has no policy on amnesty" when the scraper is just broken.

We do not claim 99.99% to users. The README quotes the eval-measured numbers honestly.

### Other v1 metrics

1. **Activation:** % of installs that issue ≥1 successful `tools/call` within 24h. Target ≥ 60%.
2. **Time-to-answer:** p50 wall-clock from `chain_find_relevant_policies` invocation → return. Target < 6s warm, < 12s cold.
3. **Stale-content incidents:** count of cases where cache served text from a revision superseded by a newer one in the live index. Target = 0; log-level `error` if > 0.
4. **Weekly active questions:** opt-in anonymous counter (off by default), or npm download trend + Claude Project zip download count + GitHub stars/issues as proxy.

### Kill criteria

If 60 days post-launch:
- Retrieval correctness < 95% on the eval, OR
- Any answer-correctness errors persist across two consecutive eval runs that aren't a stale-content fluke, OR
- < 25 weekly install-and-use signals,

then sunset the project or pivot to the hosted web surface.

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

- **Hosted web demo** for the undergrad JTBD. Lowest-friction surface for free users; deferred until eval + install signals justify hosting cost. The Claude Project starter zip is the v1 stopgap.
- **Historical / superseded policies** beyond what the PDF metadata block exposes.
- **Telemetry server** beyond opt-in local counters.
- **5 of the original 8 tools** (`find_by_topic`, `get_recent_changes`, `get_policy_history`, `list_by_volume`, `list_by_section`) — see "Tools" section.

> Embeddings-based retrieval was on the v2 deferred list. It's now **in v1** (see "Search" below) because BM25 alone won't hit the 95% bar on conceptual queries.

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
    │   ├── questions.jsonl               # 50 grounded-answer eval questions
    │   └── run-eval.mjs                  # MCP-driven scoring harness (3 sub-metrics)
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
| **`chain_find_relevant_policies`** *(chain)* | `{ question: string, k?: number = 2 }` | Runs hybrid retrieval (BM25 + pre-computed embeddings), picks top-`k` (**default 2 to keep response under ~16k tokens**), fetches each full body, returns array of `PolicyDocument`. Description: *"One-call workflow for natural-language MSU policy questions ('what are the rules on amnesty?', 'what's the policy on withdrawal?'). Returns the full text of the top-k most relevant MSU Operating Policies. RULES for answering: (1) Use ONLY the returned text — do not draw on outside knowledge. (2) For any normative claim ('the policy says X', 'you must Y', deadlines, eligibility criteria, dollar amounts, exceptions), QUOTE VERBATIM from the policy text in quotation marks and cite the OP number + URL. Do not paraphrase load-bearing language. (3) If the returned policies don't clearly answer the question, say so plainly and recommend contacting the responsible office; do NOT extrapolate. (4) Always include the `retrievedAt` timestamp and the canonical landing URL so the user can verify."* |
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

### Search — hybrid retrieval (BM25 + embeddings)

The 99.99% accuracy bar requires that retrieval almost never misses the canonical policy. BM25 alone gets the literal hits; embeddings catch conceptual ones ("can my RA write me up for a candle" → fire safety / dorm policy). v1 ships both, fused at query time.

**Lexical (BM25-lite):**
- Lowercase + NFKC-normalize both query and corpus before tokenization.
- Token split on `/[\s\-_/.,;:()\[\]{}]+/`.
- Score: BM25 (term frequency × inverse document frequency) with **field weights** title × 3, number × 2, body × 1.
- No stemmer for v1 (explicit "no stemmer" comment in `search.ts` so the next person doesn't re-litigate it).

**Semantic (embeddings):**
- **Pre-computed at build time**, NOT at runtime. `scripts/build-embeddings.mjs` chunks each policy (~1k-token chunks with 200-token overlap), embeds with `text-embedding-3-small` (cost: ~$0.02 for the whole 218-policy corpus), and writes `dist/embeddings.json` (≈ 5 MB). Committed alongside `dist/index.js`.
- Runtime: load `embeddings.json` once at startup. For a query, embed it via the same model (this is the one runtime API call — see "API key handling" below) and rank all chunks by cosine similarity.
- **API key handling:** if no `OPENAI_API_KEY` is set, semantic retrieval is silently skipped and we fall back to BM25-only with a stderr warning. The Claude Code plugin path documents this; the npm path takes the env var. Tools never throw on missing key — they degrade.
- Alternative considered: a tiny ONNX-runtime model bundled in `dist/` (e.g., `all-MiniLM-L6-v2`) so no API key is needed. **Deferred to v0.2** — adds 25 MB to the bundle and complicates esbuild config. Worth doing once we know the v1 surface lands.

**Fusion (Reciprocal Rank Fusion):**
- Take top-20 from BM25 + top-20 from embeddings.
- For each candidate, score = `1/(60 + bm25_rank) + 1/(60 + embed_rank)`.
- Return top-`k` by fused score.
- Eval-driven: if RRF underperforms either method on its own, fall back to whichever wins on the eval set. The eval gates the choice.

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

## Eval set (v1 prerequisite)

`msstate-policies/eval/questions.jsonl` — **50** questions written by hand from the policy index, covering:
- 10 student-life questions (amnesty, withdrawal, parking, dorm pets, smoking, dining contracts, residence-hall visitation, candles, financial aid appeals, missed-class)
- 10 academic questions (grade appeals, FERPA, academic integrity, course drops, transcripts, leave of absence, incomplete grades, repeat-course policy, dean's list, Title IX in classroom)
- 10 HR / faculty / staff questions (sick leave, travel reimbursement, conflict of interest, IT acceptable use, harassment reporting, telework, IP ownership, outside employment, parental leave, grievance procedure)
- 8 conceptual questions where keyword overlap is weak — these stress hybrid retrieval ("can my RA write me up for a candle", "rules around firearms in dorms", "what happens if I'm caught vaping in my room", etc.)
- 12 negative cases (questions that have no MSU OP answer — e.g., "what's MSU's policy on alien encounters?", "what's the dress code for football games?"; correct response is a plain refusal with no fabricated OP cite)

Format per line:
```json
{ "q": "...", "expected_op_numbers": ["91.100"], "must_cite": true, "negative": false, "must_quote_verbatim": true, "notes": "..." }
```

`scripts/run-eval.mjs` drives the MCP server via JSON-RPC and scores three sub-metrics independently (per the metrics table above):
1. **Retrieval correctness** — deterministic check: was `expected_op_numbers[0]` in `chain_find_relevant_policies(q).results`?
2. **Answer correctness** — Claude API judge call: graded against the retrieved policy text. Prompt enforces "flag any normative claim not supported by quoted text."
3. **Refusal correctness** — for `negative: true` questions, response must contain a refusal phrase AND must NOT contain a fabricated OP number pattern (`/^\d{2}\.\d{2}$/`).

Output: `eval-{date}.json` with per-question pass/fail per sub-metric + aggregate scores. CI publishes the latest eval as a release-asset summary.

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
- `src/search.ts` — hybrid retrieval (BM25 + embeddings via cosine similarity), Reciprocal Rank Fusion. Loads `dist/embeddings.json` at startup; degrades to BM25-only if no `OPENAI_API_KEY`.
- `src/embed.ts` — runtime query-embedding via `text-embedding-3-small`, with graceful fallback when no API key is present.
- `scripts/build-embeddings.mjs` — chunk + embed all 218 policies at build time, write `dist/embeddings.json`. Re-runs on every release.
- `scripts/build-project-bundle.mjs` — builds the "Claude Project starter" zip (curated PDFs + system prompt template) for the GitHub release.
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
- **Search quality.** Hybrid retrieval (BM25 + pre-computed embeddings, RRF-fused) is in v1. Without an `OPENAI_API_KEY` the runtime gracefully degrades to BM25-only — eval will tell us how much that hurts. v0.2 likely swaps the runtime embedding call for a bundled ONNX model so we have zero API dependencies.
- **LLM hallucination above retrieval.** Even with perfect retrieval, the LLM can paraphrase incorrectly. The `chain_find_relevant_policies` tool description aggressively pushes verbatim quoting + refusal-on-uncertainty as the only path toward 99.99% answer correctness. Eval's "answer correctness" sub-metric is the gate.
- **No undergrad surface in v1.** The 11pm JTBD genuinely needs a hosted web demo; explicit out-of-scope until eval data justifies the lift.
- **MSU brand / ToS.** "Unofficial" disclaimer in README + every tool response includes `landingUrl` for verification. No `robots.txt` violations: GET-only, concurrency 4, normal UA, honors `Retry-After`.
- **Windows path correctness.** `env-paths` instead of `~/.cache/`.
