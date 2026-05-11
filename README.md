# msstate-mcp

**Ask Claude about Mississippi State University — Operating Policies *and* academic dates. Answers are grounded in the official MSU pages and PDFs, with citations.**

> ⚠️ **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by Mississippi State University. It retrieves content from public MSU pages — <https://www.policies.msstate.edu/current> plus six named calendar sources on `*.msstate.edu` subdomains — for use by an LLM. **Always verify against the official source before acting on the result.**

## What this does

Ask a natural-language question and get a grounded answer that quotes verbatim from the official MSU source and cites the canonical URL. Two coverage areas, one connector:

- **Policies** — *"What is MSU's hazing policy?"* The server fetches the official policy PDF and Claude answers using only that text, citing the OP number and canonical `policies.msstate.edu` URL.
- **Dates & deadlines** — *"When does spring break start in spring 2026?"* The server scrapes six MSU calendar sources (registrar academic + exam calendars, university holidays, graduate school, financial aid, housing) and Claude answers with the verbatim date plus the source page URL. When a question is ambiguous about year (e.g., *"when does spring break start?"*), the server returns all year-versions so Claude can present each one — *"Spring Break 2026 begins March 9. Spring Break 2027 begins March 8."*

If neither a policy nor a calendar entry applies (*"what's the weather forecast?"*, *"the latest football score"*), Claude refuses cleanly instead of fabricating an answer.

You can ask things like:

- *"What is MSU's hazing policy?"*
- *"How does the grade appeal process work?"*
- *"What sanctions apply to alcohol and drug offenses for MSU students?"*
- *"What is MSU's policy on student education records (FERPA)?"*
- *"What's the rule on smoking on campus?"*
- *"What's MSU's travel reimbursement policy?"*
- *"What's MSU's faculty grievance procedure?"*
- *"When does spring break start in spring 2026?"*
- *"When is fall move-in?"*

## Tools

The hosted MCP server exposes **7 tools** that any MCP-capable client can call:

| Tool | What it does |
|---|---|
| `search_policies` | Keyword search across MSU Operating Policies; returns OP numbers + titles + snippets ranked by relevance. |
| `get_policy` | Fetch the full text + metadata of one policy by OP number or URL. |
| `chain_find_relevant_policies` | One-call natural-language workflow: take a question, find top-k relevant policies, return their full text for the LLM to ground its answer. |
| `cite_policy` | Format a clean citation for an OP by number (`"OP 91.208 (Hazing)"` short, or full APA-style). |
| `find_msu_date` *(v0.4.0+)* | One-call natural-language date lookup across six MSU calendars. Returns matching events with `start`/`end` ISO dates, the source calendar, and the canonical URL. When the question is ambiguous about year, returns **all** year-versions so the LLM can answer multi-year. |
| `get_msu_calendar` *(v0.4.0+)* | Raw dump of one calendar source (`academic_calendar`, `exam_schedule`, `university_holidays`, `grad_school_calendar`, `sfa_financial_aid`, `housing`) with optional term filter. |
| `health_check` | Diagnostic: per-source row counts, last build timestamp, last errors. Useful when answers feel stale or empty. |

## Quick Start (Claude or ChatGPT, ~30 seconds)

**The same hosted MCP endpoint works for both Claude.ai and ChatGPT Plus/Pro custom connectors.** Pick one — these are parallel flows.

| | **Claude.ai** | **ChatGPT** |
|---|---|---|
| **You need** | A paid Claude plan (Pro, Team, Enterprise) | A paid ChatGPT plan (Plus or Pro) |
| **1.** | Sign in at <https://claude.ai> | Sign in at <https://chatgpt.com> |
| **2.** | Open **Settings → Connectors → Add custom connector** | Open **Settings → Connectors → Add custom connector** |
| **3.** | **Name:** `MSU` (anything) <br> **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp` | **Name:** `MSU` (anything) <br> **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp` |
| **4.** | Save. Connector should show **7 tools** | Save. Connector should show **7 tools** |
| **5.** | New chat, enable the connector, ask a question | New chat, enable the connector, ask a question |

Try one of these to verify:
- *"What is MSU's hazing policy?"* → quoted answer citing OP 91.208 with the `policies.msstate.edu` URL.
- *"When does spring break start?"* → multi-year answer covering both 2026 and 2027 (the server returns all year-versions so the LLM doesn't have to guess which you meant).

Mobile apps (Claude iOS/Android, ChatGPT iOS/Android) use the same connector under the same account — set it up once on web, mobile sees it automatically.

For local installs (Claude Code, Claude Desktop, Cursor, Windsurf, Zed) and code-based access (OpenAI API for free-ChatGPT users, no-install starter zip for free claude.ai), keep reading.

## Pick your client

| If you use… | Easiest install | Time |
|---|---|---|
| **claude.ai** in a browser, or **Claude mobile** on iOS/Android | [Add a connector with a URL](#claudeai-web--claude-mobile) | 30 sec |
| **ChatGPT Plus / Pro** in a browser, or **ChatGPT mobile** on iOS/Android | [Add a connector with a URL](#chatgpt-plus--pro) | 30 sec |
| **Claude Code** (CLI) | [Two slash commands](#claude-code) | 30 sec |
| **Claude Desktop**, **Cursor**, **Windsurf**, **Zed** | [Paste a JSON snippet](#claude-desktop-cursor-windsurf-zed) | 1 min |
| **OpenAI API** (any ChatGPT plan, including free) | [Python sample](#openai-api) | 1 min |
| **Free claude.ai** (no MCP support) | [Drag-and-drop a Project starter zip](#free-claudeai-no-install) | 1 min |

---

## claude.ai web + Claude mobile

The fastest path. Works in your browser at <https://claude.ai> and the Claude iOS / Android apps. **Requires a paid claude.ai plan** (Pro, Team, or Enterprise) to add custom connectors.

1. Sign in to <https://claude.ai>.
2. Open **Settings → Connectors** (or the connector button in the chat composer).
3. Click **Add custom connector**.
4. Fill in:
   - **Name:** `MSU` (anything is fine; this is just the label that appears in the connector list)
   - **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
5. Save. The connector should now show **7 tools** available.
6. Open a new chat, enable the connector, and ask either a policy question (*"What is MSU's hazing policy?"*) or a date question (*"When does fall semester start?"*).

Once added on web, the same connector is usable from the Claude mobile app under the same account — no separate setup.

> **Note on freshness:** This hosted version reads from a periodic snapshot of MSU's policies + six calendar sources (response includes `corpus_built_at` and per-row `retrieved_at` timestamps). For *always-fresh* data — i.e., a live scrape of MSU per request — install one of the local paths below.

## Claude Code

```bash
/plugin marketplace add mminsub11/msstate-mcp
/plugin install msstate-policies@msstate-mcp
```

Two commands, no JSON editing. Restart Claude Code if it doesn't pick the tools up automatically.

## Claude Desktop, Cursor, Windsurf, Zed

You'll need [Node.js 18+](https://nodejs.org) installed (the `npx` command comes with it). Then:

**1. Find your client's MCP config file:**

| Client | Path |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | Settings → MCP → Add server |
| Windsurf | Settings → MCP servers |
| Zed | `~/.config/zed/settings.json` under `context_servers` |

In Claude Desktop you can also click **Settings → Developer → Edit Config** to open the file in your editor.

**2. Add this entry.** If the config is empty or missing, paste the whole snippet. If `"mcpServers"` already has other servers, just add `msstate-policies` inside it:

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

**3. Save and fully quit the client** — don't just close the window. On macOS use Cmd+Q; on Windows right-click the tray icon and pick Quit. Reopen.

**4. Verify.** Look for the tools indicator (small icon near the chat input). You should see `msstate-policies` with **7 tools**. Try *"What is MSU's hazing policy?"* or *"When does spring break start?"* — Claude will call the right chain tool and return a grounded answer with a citation.

The first call takes ~5 seconds (the server fetches MSU's index and the relevant PDF). Later calls reuse cached data and are faster.

A reference snippet is at [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json).

## ChatGPT (Plus / Pro)

ChatGPT Plus and Pro support custom MCP Connectors. **Requires a paid ChatGPT plan** — free-tier users can't add Connectors; if you're on free ChatGPT, see the [OpenAI API](#openai-api) path below instead.

1. Sign in to <https://chatgpt.com>.
2. Open **Settings → Connectors → Add custom connector**.
3. Fill in:
   - **Name:** `MSU` (anything is fine; this is just the label that appears in the connector list)
   - **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
4. Save. The connector should now show **7 tools** available.
5. Open a new chat, enable the connector, and ask either a policy question (*"What is MSU's amnesty policy?"*) or a date question (*"When is move-in for fall 2026?"*).

The same connector is usable from the ChatGPT iOS / Android apps under the same account — no separate setup.

> **Note on freshness:** Same as the claude.ai path — this hosted version reads from a periodic snapshot of MSU's policies + six calendar sources. The response includes `corpus_built_at` and per-row `retrieved_at` timestamps so the model can surface staleness. For *always-fresh* data, install one of the local paths above.

## OpenAI API

ChatGPT Connectors require a paid ChatGPT plan (Plus, Pro, Business, or Enterprise). If you're on **free ChatGPT** — or you just prefer code — you can use this MCP server directly via OpenAI's Responses API and an OpenAI API key. The API is independent of your ChatGPT subscription tier; sign up at <https://platform.openai.com> and add a few dollars of credit (queries are typically a few cents each).

**Setup:**

```bash
pip install openai
export OPENAI_API_KEY=sk-...
```

**Minimum example:**

```python
from openai import OpenAI

INSTRUCTIONS = """You answer questions about Mississippi State University using the msstate-policies MCP server, which covers:
  - MSU Operating Policies (via chain_find_relevant_policies / search_policies / get_policy / cite_policy)
  - MSU academic dates from six calendars: academic, exam, holidays, grad school, financial aid, housing (via find_msu_date / get_msu_calendar)

Rules:
1. For policy questions, call chain_find_relevant_policies with k=5 (the maximum) so the model sees a wider candidate set.
2. For date / deadline / event questions, call find_msu_date. If the user does NOT specify a year, present ALL year-versions returned (e.g., 'Spring Break 2026 begins March 9; Spring Break 2027 begins March 8').
3. If the question is not about MSU policies or dates (e.g., weather, sports scores, news, current events, individuals' personal info), refuse plainly and suggest contacting an appropriate alternative source. Do not invent a policy or date.
4. Quote dates verbatim and cite the `source_url`. Quote policy text verbatim and cite the OP number + canonical URL."""

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
    input="What is MSU's hazing policy?",  # or: "When does spring break start in spring 2026?"
)

for item in resp.output:
    if getattr(item, "type", None) == "message":
        for c in item.content:
            if getattr(c, "type", None) == "output_text":
                print(c.text)
```

A runnable version is at [`examples/openai_api_sample.py`](examples/openai_api_sample.py). Pass a custom question as the first argument:

```bash
python examples/openai_api_sample.py "What's MSU's policy on academic amnesty?"
```

**What to expect:** GPT-4o produces grounded answers with the same citation discipline as Claude — verbatim quotes, OP numbers, canonical URLs, retrieval timestamps. Cross-model quality is validated against a 10-question eval ([`eval-2026-05-08-k5-gpt-4o.json`](msstate-policies/eval/eval-2026-05-08-k5-gpt-4o.json)).

## Free claude.ai (no install)

If you can't install MCP servers (e.g. you're on a free claude.ai plan), there's still a path: a curated **starter zip** with 22 high-traffic policy PDFs and a system-prompt template that pushes Claude toward verbatim quoting. (Policies only — calendar coverage requires the live MCP/connector path because dates change too often for a static drop.)

1. Download `msstate-policies-starter.zip` from the [latest GitHub release](https://github.com/mminsub11/msstate-mcp/releases/latest).
2. Sign in to <https://claude.ai>.
3. Create a new **Project** (or open an existing one).
4. Unzip the file and drag the PDFs + `SYSTEM_PROMPT.txt` into the Project's knowledge area.
5. Ask policy questions inside that Project's chats.

Smaller corpus than the live MCP (22 of 218 policies), but works on **free** claude.ai plans and on the mobile app once the Project is set up.

---

## What a response looks like

Ask Claude *"What is MSU's hazing policy?"* and you'll see something like:

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

For a date question like *"When does spring break start?"*, you'll see something like:

> MSU has a few terms with a spring break on file:
>
> - **Spring 2026 — Spring Break** runs **2026-03-09** through **2026-03-13**.
> - **Spring 2027 — Spring Break** runs **2027-03-08** through **2027-03-12**.
>
> **Source:** Academic Calendar at <https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring> (snapshot built 2026-05-11).

Every calendar response includes:

- The **event name** and **start/end** ISO dates (YYYY-MM-DD)
- A **term** label when applicable (e.g. "Spring 2026")
- The **source calendar** id (`academic_calendar`, `exam_schedule`, `university_holidays`, `grad_school_calendar`, `sfa_financial_aid`, `housing`)
- The **canonical URL** of the specific MSU page or PDF
- A **`retrieved_at`** timestamp + a **`corpus_built_at`** stamp on the hosted (connector) path so you can detect staleness
- All matching year-versions when the question doesn't pin a specific year
- A pre-formatted **`citation`** markdown link (e.g., `[Spring Break, Spring 2026](url)`) — the LLM is instructed to include it verbatim so you always have a one-click verification path.

## Tips for getting good answers

- **Ask plainly.** *"Can my RA write me up for lighting a candle in my dorm?"* works as well as *"What is the Code of Student Conduct?"*. The retrieval handles weak-keyword conceptual phrasing.
- **Multi-part questions are fine.** Claude can cite multiple OPs in one answer (e.g., *"my professor cancelled three weeks of class — am I supposed to keep showing up?"* will surface both attendance and instructor-responsibility policies).
- **Ask Claude to quote.** If you want to be sure the wording is verbatim from the policy, ask: *"Quote the actual policy language for the hazing definition."* The tool design encourages verbatim quoting, but a direct prompt makes it explicit.
- **Verify the citation.** Click through the canonical URL in any answer — that's the official MSU PDF or calendar page.
- **For dates, name the year if you know it.** *"Spring break in spring 2026"* gets a direct answer; *"spring break"* alone gets all available year-versions so you can compare.
- **If an answer feels off,** ask Claude to call `health_check`. If the corpus is broken or stale, that tool surfaces the failure mode honestly (per-source row counts + last errors) instead of fabricating.

## Privacy

In default mode, your queries never leave your machine. The only outbound traffic is to `policies.msstate.edu` to fetch policy PDFs. No analytics, no telemetry, no third-party APIs.

- **Claude Code / Desktop / Cursor / Windsurf / Zed** (local install): truly local. The MCP server runs on your machine.
- **claude.ai web / mobile via the connector**: your query goes to Anthropic (as it always does on claude.ai) and to the hosted Cloudflare Worker, which only fetches from the snapshot — never sends your query elsewhere.
- **OpenAI API**: your query goes to OpenAI's models and to the hosted Cloudflare Worker. No traffic to Anthropic in this mode. The Worker still only fetches from MSU and stores no logs of your queries beyond Cloudflare's standard request metadata.
- **ChatGPT (Plus / Pro) via the connector**: your query goes to OpenAI's models and to the hosted Cloudflare Worker. No traffic to Anthropic in this mode. The Worker still only fetches from MSU and stores no logs of your queries beyond Cloudflare's standard request metadata.
- **Sensitive topics** (Title IX, harassment, FERPA): the local install is the most private option. The connector is fine for general policy questions; for sensitive ones, the local path keeps everything on your machine.

If you opt in to semantic retrieval (set `MSSTATE_POLICIES_RETRIEVAL=embed` or `=hybrid`), your natural-language query is sent to OpenAI for embedding. **The default `bm25` mode does not require this and is recommended for most users.**

## Configuration (optional)

Most users don't need to set anything. If you want to tune the local install:

| Environment variable | Default | What it does |
|---|---|---|
| `MSSTATE_POLICIES_RETRIEVAL` | `bm25` | Set to `embed` or `hybrid` to use OpenAI embeddings. Default ties or beats those on the eval. |
| `OPENAI_API_KEY` | unset | Only needed if you change the retrieval mode above. |
| `MSSTATE_POLICIES_CACHE` | unset | Set to `disk` to cache policy PDFs across process restarts (cross-platform via `env-paths`). Default in-memory only. |

## Troubleshooting

- **"All policies have empty text" / suspiciously empty answers** — Ask Claude to call `health_check`. If `index_row_count` is 0 or `last_index_error` is populated, MSU likely changed their site layout. File an issue on GitHub.
- **`tools/list` returns 0 tools** — In a local install, the bundle is stale. Run `cd msstate-policies && npm run build` from a checkout, or reinstall the plugin / re-run `npx`. For the connector, refresh the connector entry on claude.ai.
- **Embed/hybrid retrieval seems off** — Confirm `MSSTATE_POLICIES_RETRIEVAL` is set to `embed` or `hybrid` (default is `bm25`) and that `OPENAI_API_KEY` is set in your client's MCP env.
- **Connector won't connect** — Sanity check the URL is exactly `https://msstate-policies-mcp.mminsub90.workers.dev/mcp` (note the `/mcp` at the end). Hit the bare URL in your browser; you should see a JSON info page.

## Eval

**Policies** are validated against a 50-question hand-written eval set:

| | |
|---|---:|
| Retrieval correctness (expected OP in returned set) | 37 / 38 |
| Answer correctness (judge: prose answer matches policy text) | 37 / 38 |
| Refusal correctness (out-of-scope questions correctly refused) | 12 / 12 |

Judge: Claude Sonnet 4.6, k=5, BM25-only retrieval. The single missing case is *"tornado warning during my class"* — the relevant OP points at MSU's external Campus Emergency Management Plan, which is outside this server's corpus. Treat 86/88 as the realistic ceiling for the OP-only corpus.

Full policies eval JSON: [`msstate-policies/eval/eval-2026-05-08-k5-sonnet-4-6.json`](msstate-policies/eval/eval-2026-05-08-k5-sonnet-4-6.json).

**Calendars** are validated against a 16-question hand-written eval set spanning all 6 sources (registrar academic + exam, university holidays, graduate school PDFs, financial aid, housing) plus one refusal case. Two questions are tagged `corpus-miss` because MSU has not yet published the relevant Fall 2026 sub-pages at the time of corpus build — these document the expected refusal behavior rather than a defect.

Full calendars eval JSON: [`msstate-policies/eval/eval-calendars-2026-05-11.json`](msstate-policies/eval/eval-calendars-2026-05-11.json).

## License

MIT. See [LICENSE](LICENSE).

---

*Maintainers: see [`docs/BUILD.md`](docs/BUILD.md) for architecture, decision history, and contribution notes.*
