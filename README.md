# msstate-mcp

**Ask Claude or ChatGPT about Mississippi State University — Operating Policies *and* academic dates. Answers are grounded in the official MSU pages and PDFs, with verbatim quotes and citations.**

> ⚠️ **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by Mississippi State University. It retrieves content from public MSU pages — <https://www.policies.msstate.edu/current> plus six named calendar sources on `*.msstate.edu` subdomains — for use by an LLM. **Always verify against the official source before acting on the result.**

---

## Table of contents

- [What it does](#what-it-does)
- [Quick start (30 seconds)](#quick-start-30-seconds)
- [Install paths by client](#install-paths-by-client)
  - [Claude.ai web / mobile](#claudeai-web--claude-mobile)
  - [ChatGPT Plus / Pro](#chatgpt-plus--pro)
  - [Claude Code](#claude-code)
  - [Claude Desktop, Cursor, Windsurf, Zed](#claude-desktop-cursor-windsurf-zed)
  - [OpenAI API (any plan)](#openai-api-any-plan)
  - [Free claude.ai — no install](#free-claudeai--no-install)
- [Tools](#tools)
- [What a response looks like](#what-a-response-looks-like)
- [v0.5.0 highlights — natural-language calendar queries, zero runtime cost](#v050-highlights--natural-language-calendar-queries-zero-runtime-cost)
- [Privacy](#privacy)
- [Configuration](#configuration)
- [Eval](#eval)
- [Troubleshooting](#troubleshooting)
- [Contributing & maintainers](#contributing--maintainers)
- [License](#license)

---

## What it does

You ask a plain-English question; the server returns a grounded answer from MSU's official site, with a verbatim quote and a clickable citation. Two coverage areas behind one connector:

- **Policies** — *"What is MSU's hazing policy?"* The server fetches the official policy PDF and Claude/GPT answers using only that text, citing the OP number and canonical `policies.msstate.edu` URL.
- **Dates & deadlines** — *"When does spring break start?"* The server scrapes six MSU calendars (registrar academic + exam, university holidays, graduate school PDFs, financial aid, housing) and returns the verbatim date plus the source page URL. v0.5.0 adds LLM-generated synonyms baked into the BM25 index so paraphrased queries like *"when does the semester start"* or *"turkey day"* find the right row — with **no runtime API cost**.

If neither a policy nor a calendar entry applies (*"what's the weather forecast?"*, *"what's the latest football score?"*), the model refuses cleanly rather than fabricating an answer.

Things to ask:

- *"What is MSU's hazing policy?"*
- *"How does the grade appeal process work?"*
- *"What's MSU's faculty grievance procedure?"*
- *"What sanctions apply to alcohol and drug offenses for MSU students?"*
- *"What is MSU's policy on student education records (FERPA)?"*
- *"When does spring break start in spring 2026?"*
- *"When is fall move-in?"*
- *"Memorial Day holiday closed?"* (v0.5.0 synonyms find this from `"Memorial Day Holiday – no classes scheduled"`)

---

## Quick start (30 seconds)

**The same hosted MCP endpoint works for both Claude.ai and ChatGPT Plus/Pro.** No code, no install, no API key. Just paste a URL into a settings panel.

| | **Claude.ai** | **ChatGPT** |
|---|---|---|
| **You need** | Paid Claude plan (Pro / Team / Enterprise) | Paid ChatGPT plan (Plus / Pro) |
| **1.** | Sign in at <https://claude.ai> | Sign in at <https://chatgpt.com> |
| **2.** | **Settings → Connectors → Add custom connector** | **Settings → Connectors → Add custom connector** |
| **3.** | **Name:** `MSU` &nbsp;&nbsp;**URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp` | **Name:** `MSU` &nbsp;&nbsp;**URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp` |
| **4.** | Save. Connector should show **7 tools** | Save. Connector should show **7 tools** |
| **5.** | New chat, enable the connector, ask a question | New chat, enable the connector, ask a question |

Verify with either:
- *"What is MSU's hazing policy?"* → verbatim quote citing OP 91.208 with the `policies.msstate.edu` URL.
- *"When does spring break start?"* → multi-year answer (both 2026 and 2027) so the LLM doesn't have to guess which you meant.

Mobile apps (Claude iOS/Android, ChatGPT iOS/Android) use the same connector under the same account — set it up once on web, mobile sees it automatically.

> **Freshness note:** the hosted Worker reads from a snapshot rebuilt periodically. The response includes a `corpus_built_at` field so the model surfaces staleness honestly. For *always-fresh* (live-scrape per call), use a local install below.

---

## Install paths by client

| If you use… | Easiest install | Time |
|---|---|---|
| **claude.ai** web / mobile | [Custom connector](#claudeai-web--claude-mobile) | 30 sec |
| **ChatGPT Plus / Pro** web / mobile | [Custom connector](#chatgpt-plus--pro) | 30 sec |
| **Claude Code** (CLI) | [Two slash commands](#claude-code) | 30 sec |
| **Claude Desktop**, **Cursor**, **Windsurf**, **Zed** | [Paste a JSON snippet](#claude-desktop-cursor-windsurf-zed) | 1 min |
| **OpenAI API** (free or paid ChatGPT) | [Python sample](#openai-api-any-plan) | 1 min |
| **Free claude.ai** (no MCP support) | [Drag-and-drop starter zip](#free-claudeai--no-install) | 1 min |

### claude.ai web + Claude mobile

The fastest path. Works in your browser at <https://claude.ai> and the Claude iOS / Android apps. **Requires a paid claude.ai plan** to add custom connectors.

1. Sign in to <https://claude.ai>.
2. Open **Settings → Connectors** (or the connector button in the chat composer).
3. Click **Add custom connector**.
4. Fill in:
   - **Name:** `MSU`
   - **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
5. Save. The connector should show **7 tools** available.
6. Open a new chat, enable the connector, ask a policy question (*"What is MSU's hazing policy?"*) or a date question (*"When does fall semester start?"*).

### ChatGPT Plus / Pro

ChatGPT Plus and Pro support custom MCP Connectors. Free-tier ChatGPT can't add Connectors — use the [OpenAI API](#openai-api-any-plan) path instead.

1. Sign in to <https://chatgpt.com>.
2. Open **Settings → Connectors → Add custom connector**.
3. Fill in:
   - **Name:** `MSU`
   - **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
4. Save. The connector should show **7 tools** available.
5. Open a new chat, enable the connector, ask a question.

### Claude Code

```bash
/plugin marketplace add mminsub11/msstate-mcp
/plugin install msstate-policies@msstate-mcp
```

Two commands, no JSON editing. Restart Claude Code if the tools don't show up automatically.

### Claude Desktop, Cursor, Windsurf, Zed

You need [Node.js 18+](https://nodejs.org) (`npx` comes with it).

**1. Locate your client's MCP config file:**

| Client | Path |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | Settings → MCP → Add server |
| Windsurf | Settings → MCP servers |
| Zed | `~/.config/zed/settings.json` under `context_servers` |

In Claude Desktop: **Settings → Developer → Edit Config** opens the file in your editor.

**2. Add this entry.** If `"mcpServers"` already has other servers, just add `msstate-policies` inside it:

```json
{
  "mcpServers": {
    "msstate-policies": {
      "command": "npx",
      "args": ["-y", "msstate-policies-mcp"]
    }
  }
}
```

**3. Fully quit the client** (Cmd+Q on macOS, right-click tray → Quit on Windows). Reopen.

**4. Verify.** Look for the tools indicator near the chat input — you should see `msstate-policies` with **7 tools**. Try *"What is MSU's hazing policy?"* — the first call takes ~5 seconds (server fetches MSU's index + the relevant PDF); later calls reuse cached data.

A ready-to-paste snippet is at [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json).

### OpenAI API (any plan)

ChatGPT Connectors require a paid ChatGPT plan. If you're on **free ChatGPT** — or you just prefer code — use the OpenAI API directly. The API is independent of your ChatGPT subscription tier; sign up at <https://platform.openai.com> and add a few dollars of credit (queries are typically a few cents each).

```bash
pip install openai
export OPENAI_API_KEY=sk-...
```

Minimum example:

```python
from openai import OpenAI

INSTRUCTIONS = """You answer questions about Mississippi State University using the msstate-policies MCP server, which covers:
  - MSU Operating Policies (via chain_find_relevant_policies / search_policies / get_policy / cite_policy)
  - MSU academic dates from six calendars (via find_msu_date / get_msu_calendar)

Rules:
1. For policy questions, call chain_find_relevant_policies with k=5.
2. For date questions, call find_msu_date. If the user does NOT specify a year, present ALL year-versions returned.
3. If the question isn't about MSU policies or dates, refuse plainly and suggest an alternative source. Do not invent.
4. Quote dates and policy text verbatim. Cite source_url for dates, OP number + canonical URL for policies."""

client = OpenAI()
resp = client.responses.create(
    model="gpt-4o",
    instructions=INSTRUCTIONS,
    tools=[{
        "type": "mcp",
        "server_label": "msstate-policies",
        "server_url": "https://msstate-policies-mcp.mminsub90.workers.dev/mcp",
        "require_approval": "never",
    }],
    input="What is MSU's hazing policy?",
)

for item in resp.output:
    if getattr(item, "type", None) == "message":
        for c in item.content:
            if getattr(c, "type", None) == "output_text":
                print(c.text)
```

A runnable version is at [`examples/openai_api_sample.py`](examples/openai_api_sample.py). Pass a custom question:

```bash
python examples/openai_api_sample.py "What's MSU's policy on academic amnesty?"
```

### Free claude.ai — no install

If you're on free claude.ai (which can't add MCP connectors), there's still a path: a curated **starter zip** with 22 high-traffic policy PDFs and a system-prompt template that pushes Claude toward verbatim quoting. (Policies only — calendar coverage requires MCP because dates move too often for a static drop.)

1. Download `msstate-policies-starter.zip` from the [latest GitHub release](https://github.com/mminsub11/msstate-mcp/releases/latest).
2. Sign in to <https://claude.ai>.
3. Create a new **Project** (or open an existing one).
4. Unzip the file and drag the PDFs + `SYSTEM_PROMPT.txt` into the Project's knowledge area.
5. Ask policy questions inside that Project's chats.

Smaller corpus than the live MCP (22 of ~218 policies), but works on **free** claude.ai plans and on mobile once the Project is set up.

---

## Tools

The hosted MCP server exposes **10 tools** any MCP-capable client can call:

| Tool | What it does |
|---|---|
| `search_policies` | Keyword search across MSU Operating Policies; returns OP numbers + titles + snippets ranked by relevance. |
| `get_policy` | Fetch the full text + metadata of one policy by OP number or URL. |
| `chain_find_relevant_policies` | One-call natural-language workflow: take a question, find top-k relevant policies, return their full text for the LLM to ground its answer. |
| `cite_policy` | Format a clean citation for an OP by number (`"OP 91.208 (Hazing)"` short, or full APA-style). |
| `find_msu_date` | One-call natural-language date lookup across six MSU calendars. **v0.5.0:** synonym-aware BM25 (4-field weighted) handles paraphrased queries without any runtime API. Returns up to 10 matches + ≤3 academic-calendar fallback rows when a term is named. Multi-year-aware. |
| `get_msu_calendar` | Raw dump of one calendar source (`academic_calendar`, `exam_schedule`, `university_holidays`, `grad_school_calendar`, `sfa_financial_aid`, `housing`) with optional term filter. |
| `search_msu_courses` | **v0.6.0:** Fuzzy-search the MSU course catalog by code, title, or description (BM25 with code=4/title=3/description=1 field weights). |
| `get_msu_course` | **v0.6.0:** Fetch one course's full record — title, hours, level, description, semester offered, prereqs (structured + raw prose), coreqs, cross-listed equivalents, source URL. |
| `get_msu_course_graph` | **v0.6.0:** Walk the prereq DAG forward (`prereqs` — "what do I need before X?") or reverse (`unlocks` — "what does X enable?"). Default depth 5, max 10, cycle detection, `truncated:true` when the walk hits the cap. |
| `health_check` | Diagnostic: per-source row counts, last build timestamp, last errors. Useful when answers feel stale or empty. |

**v0.6.0** adds course-catalog tools sourced from `catalog.msstate.edu`. Zero ongoing operational cost — same baked-corpus model as policies and calendars.

---

## What a response looks like

Ask *"What is MSU's hazing policy?"* and you'll see something like:

> MSU's hazing policy, in **OP 91.208**, prohibits hazing across all university-affiliated organizations:
>
> *"Hazing is prohibited. Any organization, student, or other person affiliated with the university found to have engaged in hazing as defined in this policy is subject to disciplinary action under the Student Code of Conduct and other applicable university policies."* (OP 91.208)
>
> The policy defines hazing as *"any intentional, knowing, or reckless act committed by a person…"* [definition continues, then reporting channels]
>
> **Source:** OP 91.208 at <https://www.policies.msstate.edu/policy/91208> (retrieved 2026-05-08).

Every policy response includes:

- The **OP number** for citation (e.g. `91.208`)
- The **canonical URL** on `policies.msstate.edu` — click through to verify
- An ISO **`retrievedAt`** timestamp
- Direct quotes for binding language; no paraphrasing of normative text
- Refusal + redirect when no MSU policy applies

For *"When does spring break start?"*:

> MSU has a few terms with a spring break on file:
>
> - **Spring 2026 — Spring Break** runs **2026-03-09** through **2026-03-13**.
> - **Spring 2027 — Spring Break** runs **2027-03-08** through **2027-03-12**.
>
> **Source:** Academic Calendar at <https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring> (snapshot built 2026-05-11).

Every calendar response includes:

- **Event name** and **start/end** ISO dates (YYYY-MM-DD)
- **Term** label when applicable
- **Source calendar** id and the **canonical URL** of the specific page/PDF
- **`retrieved_at`** + **`corpus_built_at`** timestamps so the model can surface staleness
- All matching year-versions when the question doesn't pin a year
- A pre-formatted **`citation`** markdown link the LLM includes verbatim
- A **`notes`** field describing the retrieval mode (e.g. `"BM25 with synonyms"`)

---

## v0.5.0 highlights — natural-language calendar queries, zero runtime cost

v0.5.0 closes the BM25 semantic gap on natural-language calendar queries without adding a runtime dependency:

- **Build-time synonyms.** `scripts/build-worker-corpus.mjs` generates 5 paraphrases per calendar row using Anthropic Claude Haiku (~$0.50 per full rebuild, cached by content hash so incrementals are pennies). Synonyms ship inside `worker/corpus.json` and a sidecar `msstate-policies/dist/calendar-synonyms.json`.
- **Query-time stays pure BM25.** 4-field weighted index: `event`×3 + `synonyms`×2 + `term`×1 + `description`×1. Plus the v0.4.1 smart-fallback layer. No `fetch`, no API key needed at runtime. **Zero ongoing operational cost.**
- **Eval gates met.** +13.3pp top-3 recall on the 15-query semantic-gap bucket, 0pp regression on the 10-query BM25-favorable bucket (ship-blockers: ≥+10pp, ≤5pp regression).
- **Security envelope.** Round-2 checklist 192 → **220**. SYN4 mechanically enforces *no* `api.anthropic.com` references anywhere in `msstate-policies/src/` or `worker/src/` — runtime egress to Anthropic is impossible by construction.

Self-hosters rebuilding the corpus need an `ANTHROPIC_API_KEY` for the build step. **Runtime users (Worker, npm consumers) need nothing extra.**

---

## Privacy

In default mode, your queries don't leave your machine. The only outbound traffic is to `policies.msstate.edu` to fetch policy PDFs. No analytics, no telemetry, no third-party APIs.

- **Claude Code / Desktop / Cursor / Windsurf / Zed** (local install): truly local. The MCP server runs on your machine.
- **claude.ai web/mobile via the connector**: your query goes to Anthropic (as on any claude.ai chat) and to the hosted Cloudflare Worker, which only fetches from the snapshot — never sends your query elsewhere.
- **OpenAI API**: your query goes to OpenAI and to the hosted Worker. No traffic to Anthropic in this mode. Worker only fetches from MSU; no logs beyond Cloudflare's standard request metadata.
- **ChatGPT (Plus/Pro) via the connector**: same as OpenAI API — query goes to OpenAI and the hosted Worker.
- **Sensitive topics** (Title IX, harassment, FERPA): the local install is the most private option. The connector is fine for general policy questions; for sensitive ones, the local path keeps everything on your machine.

If you opt in to semantic retrieval on the **policy** side (`MSSTATE_POLICIES_RETRIEVAL=embed` or `=hybrid`), your query is sent to OpenAI for embedding. The default `bm25` mode does not require this. **Calendar retrieval is always BM25-with-synonyms — no runtime API.**

---

## Configuration

Most users set nothing. For local installs you can tune:

| Environment variable | Default | What it does |
|---|---|---|
| `MSSTATE_POLICIES_RETRIEVAL` | `bm25` | Set to `embed` or `hybrid` to use OpenAI embeddings for **policy** search. Default ties or beats those on the eval. |
| `OPENAI_API_KEY` | unset | Only needed if you change the retrieval mode above. |
| `MSSTATE_POLICIES_CACHE` | unset | Set to `disk` to cache policy PDFs across process restarts (cross-platform via `env-paths`). Default: in-memory only. |

**Self-hosters / corpus rebuilders** additionally need:

| Variable | Required when | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | Running `node scripts/build-worker-corpus.mjs` | Used for v0.5.0 build-time synonym generation. **Never read at runtime.** |

---

## Eval

**Policies** are validated against a 50-question hand-written eval set:

| | |
|---|---:|
| Retrieval correctness (expected OP in returned set) | 37 / 38 |
| Answer correctness (judge: prose answer matches policy text) | 37 / 38 |
| Refusal correctness (out-of-scope questions correctly refused) | 12 / 12 |

Judge: Claude Sonnet 4.6, k=5, BM25-only retrieval. The single missing case is *"tornado warning during my class"* — the relevant OP points at MSU's external Campus Emergency Management Plan, outside this server's corpus. Treat 86/88 as the realistic ceiling for the OP-only corpus.

Full policies eval: [`msstate-policies/eval/eval-2026-05-08-k5-sonnet-4-6.json`](msstate-policies/eval/eval-2026-05-08-k5-sonnet-4-6.json).

**Calendars (hand-written, 16 questions)** span all 6 sources plus one refusal case. Full: [`msstate-policies/eval/eval-calendars-2026-05-11.json`](msstate-policies/eval/eval-calendars-2026-05-11.json).

**v0.5.0 synonym retrieval eval (30-query held-out):**

| Bucket | Baseline | v0.5.0 | Δ | Ship-blocker |
|---|---|---|---|---|
| semantic-gap (15 queries) | 4/15 | 6/15 | **+13.3pp** | ≥+10pp ✓ |
| BM25-favorable (10 queries) | 9/10 | 9/10 | 0.0pp | ≤5pp regression ✓ |
| smart-fallback (5 queries) | 1/5 | 1/5 | 0.0pp | preserved |

Run locally: `cd msstate-policies && npm run eval:synonyms` (zero API cost — pure BM25 against the local corpus).

---

## Troubleshooting

- **"All policies have empty text" / suspiciously empty answers** — ask Claude/GPT to call `health_check`. If `index_row_count` is 0 or `last_index_error` is populated, MSU likely changed their site layout. File an issue on GitHub.
- **`tools/list` returns 0 tools** — in a local install, the bundle is stale. Run `cd msstate-policies && npm run build` from a checkout, or reinstall the plugin / re-run `npx`. For the connector, refresh the entry on claude.ai or chatgpt.com.
- **Calendar queries miss obvious paraphrases** — confirm `dist/calendar-synonyms.json` exists. If you're running from a fresh git checkout without `npm run bundle`, the sidecar may be missing; the tool falls back to BM25 without synonyms and logs a one-time warning at startup.
- **Embed/hybrid policy retrieval seems off** — confirm `MSSTATE_POLICIES_RETRIEVAL` is set to `embed` or `hybrid` (default is `bm25`) and `OPENAI_API_KEY` is set in your client's MCP env.
- **Connector won't connect** — sanity-check the URL is exactly `https://msstate-policies-mcp.mminsub90.workers.dev/mcp` (note the `/mcp` suffix). Hit the bare URL in a browser; you should see a JSON info page.

---

## Contributing & maintainers

Architecture, decision history, threat model, eval methodology, and deferred-work backlog are in [`docs/BUILD.md`](docs/BUILD.md).

The `CLAUDE.md` at the repo root captures load-bearing rules (corpus rule, stderr-only logging, security-score contract) that any contributor — human or AI — must read before touching security-shaped code.

In-progress design specs and implementation plans live under `.dev/` (visible in the repo, de-emphasized via the leading-dot convention). See `.dev/README.md` for the convention.

---

## License

MIT. See [LICENSE](LICENSE).

---

*Unofficial. Always verify against the official MSU source before acting on any answer.*
