# msstate-mcp

**Ask Claude or ChatGPT about Mississippi State University. Get answers grounded in MSU's own pages and PDFs — with verbatim quotes and clickable citations.**

> ⚠️ **Unofficial.** Not affiliated with, endorsed by, or sponsored by Mississippi State University. Always verify against the official source before acting on any answer.

Covers five domains, all sourced exclusively from `*.msstate.edu`:

| Domain | Coverage | Source |
|---|---|---|
| **Operating Policies** | 217 current OPs | `policies.msstate.edu/current` |
| **Academic dates & deadlines** | 907 rows × 6 calendars | `registrar` / `hrm` / `grad` / `sfa` / `housing` |
| **Course catalog** | 3,737 undergrad + grad courses with prereq DAG | `catalog.msstate.edu` |
| **Emergency guidance** | 12 guidelines + refuge areas + contacts | `emergency.msstate.edu` |
| **Tuition & fees** | 74 rate rows × 5 campuses + 23 fees + 14 FAQs | `controller.msstate.edu` + `vetmed.msstate.edu` |

**18 MCP tools.** Current version: **v0.9.0**. The hosted Worker ships server-side routing instructions over MCP — ChatGPT and Claude both pick the right tool without per-session prompting.

---

## What you can ask

**Tuition** (v0.8.0)
- *"How much is in-state undergrad tuition at Starkville for Fall 2026 with 15 credit hours?"*
- *"What's the College of Engineering fee?"*
- *"What's vetmed DVM tuition for a Mississippi resident?"*

**Policies**
- *"What is MSU's hazing policy?"*
- *"What sanctions apply to alcohol offenses for MSU students?"*
- *"What's the grade-appeal process?"*

**Dates & deadlines**
- *"What are the staff holidays for the rest of 2026?"*
- *"When does spring break start?"*
- *"When are finals in fall 2026?"*

**Courses**
- *"What's MSU's networking course?"* → finds CSE 4153
- *"What do I need to take before CSE 4733?"* → walks the prereq chain
- *"What does Calc I unlock?"* → reverse-walks the DAG

**Emergency** (v0.7.0)
- *"Severe weather refuge for McCool Hall?"*
- *"What do I do during a tornado on campus?"*
- *"What's the number for MSU PD?"*

The model **refuses** when no MSU source covers the question (*"What's the weather?"*, *"Football scores?"*) rather than guessing.

---

## Install

| Client | Path | Time |
|---|---|---|
| **claude.ai** (paid) | [Custom connector](#claudeai-web--mobile) | 30 sec |
| **ChatGPT** (Plus/Pro) | [Custom connector](#chatgpt-plus--pro) | 30 sec |
| **Claude Code** | [Plugin command](#claude-code) | 30 sec |
| **Claude Desktop, Cursor, Windsurf, Zed** | [JSON snippet](#claude-desktop-cursor-windsurf-zed) | 1 min |
| **OpenAI API** (any plan) | [Python sample](#openai-api) | 1 min |
| **Free claude.ai** | [Starter zip](#free-claudeai) | 1 min |

### claude.ai web + mobile

Fastest path. Works in the browser and the Claude iOS/Android apps. Requires a paid Claude plan to add custom connectors.

1. Sign in at <https://claude.ai>
2. **Settings → Connectors → Add custom connector**
3. **Name:** `MSU` &nbsp;&nbsp; **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
4. Save. You should see **18 tools** appear
5. New chat, enable the connector, ask a question

Mobile apps pick up the connector automatically once you set it up on web.

### ChatGPT Plus / Pro

Same flow as claude.ai. Free-tier ChatGPT can't add connectors — use the [OpenAI API path](#openai-api) instead.

1. Sign in at <https://chatgpt.com>
2. **Settings → Connectors → Add custom connector**
3. **Name:** `MSU` &nbsp;&nbsp; **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
4. Save → 18 tools available

ChatGPT routing used to be hit-or-miss before v0.8.0 because there was no way to inject a system prompt through the connector. The server now provides routing rules via MCP's `InitializeResult.instructions` field, so GPT picks the right tool out of the box.

### Claude Code

```bash
/plugin marketplace add 3uLLd0gs/msstate-mcp
/plugin install msstate-policies@msstate-mcp
```

Two commands, no JSON. Restart Claude Code if tools don't appear.

### Claude Desktop, Cursor, Windsurf, Zed

You need [Node.js 18+](https://nodejs.org).

**1. Find your client's MCP config:**

| Client | Path |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | Settings → MCP → Add server |
| Windsurf | Settings → MCP servers |
| Zed | `~/.config/zed/settings.json` under `context_servers` |

**2. Add this entry** (inside `"mcpServers"` if other servers already live there):

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

**3.** Fully quit the client (Cmd+Q / right-click tray → Quit) and reopen.

**4.** Verify the `msstate-policies` server shows **18 tools**. First call takes ~5 seconds (cold fetch); later calls reuse cached data.

Ready-to-paste snippet at [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json).

### OpenAI API

Independent of your ChatGPT subscription tier. Add credit at <https://platform.openai.com>; queries cost a few cents each.

```bash
pip install openai
export OPENAI_API_KEY=sk-...
```

```python
from openai import OpenAI

client = OpenAI()
resp = client.responses.create(
    model="gpt-4o",
    # No `instructions` parameter needed — the MCP server provides
    # routing rules via InitializeResult.instructions (since v0.8.0).
    tools=[{
        "type": "mcp",
        "server_label": "msstate-policies",
        "server_url": "https://msstate-policies-mcp.mminsub90.workers.dev/mcp",
        "require_approval": "never",
    }],
    input="What do I need to take before CSE 4733?",
)

for item in resp.output:
    if getattr(item, "type", None) == "message":
        for c in item.content:
            if getattr(c, "type", None) == "output_text":
                print(c.text)
```

If you want to override or extend the server's routing rules, pass your own `instructions=...` — the OpenAI Responses API concatenates yours with the server's. Runnable sample at [`examples/openai_api_sample.py`](examples/openai_api_sample.py).

### Free claude.ai

Free claude.ai can't add MCP connectors, so use a curated **starter zip** of 22 high-traffic policy PDFs with a system-prompt template. Policies only (calendars + courses + tuition change too often for a static drop).

1. Download `msstate-policies-starter.zip` from the [latest release](https://github.com/3uLLd0gs/msstate-mcp/releases/latest)
2. Sign in at <https://claude.ai>, create a **Project**
3. Unzip and drag the PDFs + `SYSTEM_PROMPT.txt` into the Project's knowledge area
4. Ask policy questions inside that Project

---

## The 18 tools

| Tool | Use it for |
|---|---|
| **Policies (4)** | |
| `chain_find_relevant_policies` | One-call workflow: question → top-k policies → grounded answer |
| `search_policies` | Keyword search, returns OP numbers + snippets |
| `get_policy` | Full text of one OP by number or URL |
| `cite_policy` | Format a short or full citation |
| **Calendars (2)** | |
| `find_msu_date` | Natural-language date lookup across 6 calendars (BM25 + LLM-paraphrased synonyms baked at build time — no runtime API) |
| `get_msu_calendar` | Raw dump of one calendar source with optional term filter |
| **Courses (3)** | |
| `search_msu_courses` | Fuzzy search by code, title, or description (BM25 with code×4 / title×3 / description×1) |
| `get_msu_course` | One course's full record — title, hours, prereqs (structured + `prereq_summary` one-liner + `parse_warnings` diagnostic array), cross-listings, source URL |
| `get_msu_course_graph` | Walk the prereq DAG forward (`prereqs`) or reverse (`unlocks`). Depth 1–10, cycle detection, partial results when truncated |
| **Emergency (4, v0.7.0)** | |
| `get_msu_emergency_guideline` | Emergency-guidance lookup (tornado, fire, active shooter, …). Slug / alias / free-text fuzzy. Body verbatim + 911 reminder + quick contacts |
| `list_msu_emergency_types` | Enumerate the 12 published emergency-guideline types |
| `find_msu_severe_weather_refuge` | Severe-weather-only refuge area by building name. Returns interior-room fallback guidance when the building isn't listed |
| `get_msu_emergency_contacts` | 911 / MSU PD / Counseling / off-campus contacts. Filter by `all` \| `emergency` \| `campus` \| `off_campus` |
| **Tuition (4, v0.8.0)** | |
| `get_msu_tuition_rate` | Structured rate lookup by campus + level + residency + (optional) term + credit_hours. Returns line-item breakdown, effective_term, mandatory "rates subject to change" disclaimer. Routing rules: vetmed=DVM-only; mgccc=undergrad-only |
| `get_msu_enrollment_fees` | Per-college / per-program / per-course fees with substring filter (e.g. "engineering", "honors", "business administration") |
| `find_msu_tuition_faq` | BM25 search across MSU's 14-question tuition FAQ. Top-k Q&A pairs verbatim with anchor URLs |
| `list_msu_tuition_campuses` | Enumerate the 5 published tuition campuses with levels_offered + rate_basis + source URL |
| **Diagnostic (1)** | |
| `health_check` | Per-source counts, last build timestamp, last errors |

---

## Sample responses

### Tuition question (v0.8.0)

*"How much is in-state undergrad tuition at Starkville for Fall 2026 with 15 credit hours?"*

> Starkville Campus, in-state (resident) undergraduate, Fall 2026 / Spring 2027, full-time (12–16 hours):
>
> **$5,497.50 per semester.** Breakdown:
> - Tuition & Required Fees: $5,422.50
> - Capital Improvement Fee: $50.00
> - Student Activities Fee: $25.00
>
> *Rates are subject to change without notice. Always verify the current rate at https://www.controller.msstate.edu/accountservices/tuition before paying.*
>
> **Source:** [Starkville Campus rates](https://www.controller.msstate.edu/accountservices/tuition/starkville-campus) (snapshot built 2026-05-13).

### Date question

*"What are the staff holidays for the rest of 2026?"*

> MSU university holidays for the rest of 2026 (from <https://www.hrm.msstate.edu/benefits/holidays/>):
>
> - **Memorial Day:** 2026-05-25
> - **Independence Day (observed):** 2026-07-03
> - **Labor Day:** 2026-09-07
> - **Thanksgiving:** 2026-11-26 to 2026-11-27
> - **Winter Break:** 2026-12-23 to 2027-01-02
>
> *Each date is quoted verbatim from the MSU HR holiday schedule (snapshot built 2026-05-13).*

### Policy question

*"What is MSU's hazing policy?"*

> MSU's hazing policy, **OP 91.208**, prohibits hazing across all university-affiliated organizations:
>
> *"Hazing is prohibited. Any organization, student, or other person affiliated with the university found to have engaged in hazing as defined in this policy is subject to disciplinary action under the Student Code of Conduct and other applicable university policies."* (OP 91.208)
>
> **Source:** OP 91.208 at <https://www.policies.msstate.edu/policy/91208> (retrieved 2026-05-12).

### Course question

*"What do I need to take before CSE 4733?"*

> CSE 4733 (Operating Systems I) requires (with a C or better):
>
> - CSE 3183 — Systems Programming
> - CSE 3724 — Computer Organization, **or** ECE 3714 — Digital Devices and Logic Design
>
> Walking back one more hop, CSE 3183 itself requires CSE 1384 (Intermediate Computer Programming). The full chain stops there.
>
> **Source:** [CSE 4733](https://catalog.msstate.edu/search/?P=CSE%204733) (catalog scraped 2026-05-13).

### Emergency question (v0.7.0)

*"What do I do if there's a tornado warning on campus?"*

> *If this is a life-threatening emergency, call 911 now (or MSU PD at 662-325-2121).*
>
> Per MSU's published severe-weather guideline:
>
> - Go to the nearest Severe Weather Refuge Area immediately when you hear MaroonAlert or a tornado siren.
> - If you can't reach a designated refuge, move to the lowest interior room with no windows.
> - Stay away from windows; protect your head and neck.
>
> **Source:** [Severe Weather / Tornado](https://www.emergency.msstate.edu/guidelines/severe-weather-tornado/) (snapshot built 2026-05-13).

---

## What this WON'T do (limitations)

**0. Substitute for emergency services.** This server returns MSU's *published* emergency guidance verbatim. It is not real-time alerts, not a dispatcher, not triage, not counseling. **If you are in a life-threatening emergency, stop reading and call 911 (or MSU PD at 662-325-2121).** Every emergency-tool response carries this same reminder.

**1. Snapshots, not live data.** The hosted Cloudflare Worker reads a pre-built corpus rebuilt on each release. Responses include a `corpus_built_at` field so the model can flag staleness. For *always-live* (fetch-on-request) policy text, use a local install — the npm/plugin path live-scrapes `policies.msstate.edu`.

**2. No coverage of:**
- Real-time enrollment / billing / registration / financial-aid award status (that's MSU's Banner system; out of scope)
- Specific course offerings (which semester, which professor, seats available)
- Archived catalog editions (current undergrad + grad only)
- Anything outside the 5 listed domains' canonical pages

**3. LLM behavior is the model's responsibility.** The tools return grounded data with citations. The server provides routing + anti-hallucination instructions via MCP, but final enforcement lives in the model. If you see a paraphrased policy or a fabricated citation, that's a model failure, not a corpus failure — report it as an issue with the transcript.

**4. The hosted Worker is unauthenticated.** Anyone on the internet can call it. There's no rate limit beyond Cloudflare's free-tier defaults, no per-user logging. If your use case needs auth, run a local install.

**5. Course prereqs: lossless codes, best-effort logic.** The prereq parser captures every course code in the prereq prose verbatim (`required_courses` is authoritative) and the full prose (`raw_prose` is authoritative). The `logic` field (and/or/mixed) and `min_grade` field are best-effort — the LLM is told to fall back to `raw_prose` when the structured field looks ambiguous.

**6. Tuition rates are time-sensitive.** Rates are baked at corpus-rebuild time. Vetmed publishes one academic year behind controller — `effective_term` is surfaced verbatim on every response so the model can flag staleness.

**7. Unofficial.** Always verify with the official MSU source before acting. Read [SECURITY.md § "Out of scope: client-side circumvention"](SECURITY.md) for the abuse classes this server explicitly does not defend against.

---

## Server-side routing (new in v0.8.0)

The MCP server returns a `InitializeResult.instructions` string on every `initialize` handshake. Spec-compliant clients (Claude.ai, ChatGPT custom connector, Cursor, Windsurf, Zed) prepend this to the model's system context. It includes:

- **Routing rules** — which tool to call for each question category (policies / dates / courses / emergency / tuition)
- **Anti-hallucination rules** — use only tool data, quote verbatim, refuse outside-corpus questions, try alternative tools before falling back to general knowledge

Before v0.8.0, ChatGPT's custom connector flow routed blind from tool descriptions alone — it would sometimes pick a policy tool for a date question and then fall back to training data when the wrong tool returned nothing useful. Adding server-side instructions fixed this without requiring users to inject their own system prompt.

You can inspect the live string with:

```bash
curl -s -X POST https://msstate-policies-mcp.mminsub90.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"inspect","version":"1.0"}}}' \
  | jq -r '.result.instructions'
```

---

## Privacy & data flow

- **Local install** (Claude Code / Desktop / Cursor / Windsurf / Zed via npx): truly local. The MCP server runs on your machine. Outbound traffic only to `*.msstate.edu` to fetch policy PDFs. No analytics, no telemetry, no third-party APIs.
- **Hosted Worker** (claude.ai + ChatGPT connectors): your query goes to Anthropic/OpenAI and to the Cloudflare Worker. The Worker reads its baked snapshot — never forwards your query elsewhere. No logs beyond Cloudflare's standard request metadata.
- **OpenAI API**: same as ChatGPT — query goes to OpenAI + Worker only.

If you opt in to semantic policy retrieval (`MSSTATE_POLICIES_RETRIEVAL=embed` or `=hybrid`), your query is sent to OpenAI for embedding. The default `bm25` mode does not require this. **Calendar, course, emergency, and tuition retrieval are always BM25 — no runtime API.**

---

## Configuration

Most users set nothing. Local installs can tune:

| Variable | Default | Effect |
|---|---|---|
| `MSSTATE_POLICIES_RETRIEVAL` | `bm25` | Set to `embed` or `hybrid` for OpenAI embeddings on **policy** search |
| `OPENAI_API_KEY` | unset | Only needed if you change the retrieval mode above |
| `MSSTATE_POLICIES_CACHE` | unset | Set to `disk` to cache policy PDFs across restarts |

Self-hosters rebuilding the corpus additionally need `ANTHROPIC_API_KEY` for the v0.5.0 build-time calendar-synonym step. **Never read at runtime.**

---

## Quality

| Domain | Eval | Pass rate |
|---|---|---|
| Policies | 50 hand-written questions, Claude Sonnet judge, k=5 | 86 / 88 composite |
| Calendar synonyms | 30 ground-truth queries (semantic-gap, BM25-favorable, smart-fallback buckets) | +13.3pp lift on semantic-gap, 0pp regression elsewhere |
| Courses | 70 catalog-grounded questions across 4 buckets (incl. parse_warnings + prereq_summary) | 100% / 100% / 100% / 100% |
| Emergency | 25 questions (guideline / alias / refuge / contacts / refusal) | 24 / 25 |
| Tuition | 32 questions (rate lookup / not-found routing / fees / FAQ / adversarial) | 32 / 32 |

Run locally:

```bash
cd msstate-policies && npm run eval                          # policies
npm run eval:synonyms                                         # calendar synonyms
node ../scripts/run-eval.mjs --suite=courses                  # courses
node ../scripts/run-eval.mjs --suite=emergency                # emergency
node ../scripts/run-eval.mjs --suite=tuition                  # tuition
```

Full eval artifacts in [`msstate-policies/eval/`](msstate-policies/eval/).

---

## Troubleshooting

- **Empty answers / "no policies found"** — ask the LLM to call `health_check`. If counts are 0 or `last_index_error` is populated, MSU likely changed their site. File a GitHub issue.
- **ChatGPT picked the wrong tool** — was the connector added before v0.8.0? Some clients cache the tool list; refresh the connector or start a new chat to pick up the server's routing instructions.
- **Course not found** — `get_msu_course` returns `{found: false, suggestions: [...]}` with the top 3 BM25 matches. The catalog scrape has ~95%+ parse success — a small minority of pages don't yield structured records.
- **Connector won't connect** — URL must be exactly `https://msstate-policies-mcp.mminsub90.workers.dev/mcp` (note the `/mcp`). Hit the bare URL in a browser; you should see a JSON info page.
- **Stale answers** — check `corpus_built_at` in the response. The hosted Worker rebuilds on each release. For always-live policy text, use the local npm/plugin path.

---

## Contributing & maintainers

- **Architecture, decision history, threat model, eval methodology** — [`docs/BUILD.md`](docs/BUILD.md)
- **Load-bearing rules for contributors** (corpus rule, stderr-only logging, security-score contract) — [`CLAUDE.md`](CLAUDE.md)
- **Security disclosure + out-of-scope abuse classes** — [`SECURITY.md`](SECURITY.md)
- **In-progress design specs and plans** live under `.dev/` (visible in the repo, de-emphasized via the leading-dot convention). See [`.dev/README.md`](.dev/README.md).

Issues and PRs welcome at <https://github.com/3uLLd0gs/msstate-mcp>.

---

## License

MIT. See [LICENSE](LICENSE).

---

*Unofficial. Always verify against the official MSU source before acting on any answer.*
