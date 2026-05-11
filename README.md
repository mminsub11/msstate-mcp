# msstate-mcp

**Ask Claude about Mississippi State University Operating Policies — get answers grounded in the official policy PDFs, with citations.**

> ⚠️ **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by Mississippi State University. It retrieves policy text from the public website at <https://www.policies.msstate.edu/current> for use by an LLM. **Always verify against the official source before acting on the result.**

## What this does

Ask a natural-language question like *"What is MSU's hazing policy?"*. The MCP server fetches the official policy PDF, hands the full text to Claude, and Claude answers using **only** that text — quoting verbatim and citing the OP number, the canonical URL on `policies.msstate.edu`, and a retrieval timestamp.

If no MSU policy applies (*"what's the weather forecast?"*, *"the latest football score"*), Claude refuses cleanly instead of fabricating an answer.

You can ask things like:

- *"What is MSU's hazing policy?"*
- *"How does the grade appeal process work?"*
- *"What sanctions apply to alcohol and drug offenses for MSU students?"*
- *"What is MSU's policy on student education records (FERPA)?"*
- *"What's the rule on smoking on campus?"*
- *"What's MSU's travel reimbursement policy?"*
- *"What's MSU's faculty grievance procedure?"*

## Quick Start

The fastest way to use this — add the MCP server as a custom **connector on claude.ai** (works in your browser and the Claude mobile app).

**Prerequisites:**

- A paid [claude.ai](https://claude.ai) plan (Pro, Team, or Enterprise — free-tier accounts can't add custom connectors). For other paths that work without a paid plan, see [Pick your client](#pick-your-client) below.
- Any modern browser.

**Three steps:**

1. Sign in to <https://claude.ai>, then open **Settings → Connectors** (or click the connector button in the chat composer) and choose **Add custom connector**.
2. Fill in:
   - **Name:** `MSU Policies` (anything is fine)
   - **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`

   Save. The connector should now show **5 tools** available.
3. Open a new chat, enable the connector, and ask: *"What is MSU's hazing policy?"* — Claude will return a grounded answer that quotes the policy verbatim and cites OP 91.208 with a `policies.msstate.edu` URL.

That's the full setup. The same connector works on Claude mobile under the same account, no separate steps.

For other clients (Claude Code, Cursor, Windsurf, Zed, Claude Desktop, ChatGPT Plus/Pro, OpenAI API for free-ChatGPT users, or the no-install starter zip for free claude.ai), keep reading.

## Pick your client

| If you use… | Easiest install | Time |
|---|---|---|
| **claude.ai** in a browser, or **Claude mobile** on iOS/Android | [Add a connector with a URL](#claudeai-web--claude-mobile) | 30 sec |
| **Claude Code** (CLI) | [Two slash commands](#claude-code) | 30 sec |
| **Claude Desktop**, **Cursor**, **Windsurf**, **Zed** | [Paste a JSON snippet](#claude-desktop-cursor-windsurf-zed) | 1 min |
| **ChatGPT** (Plus / Pro) | [Add a connector with a URL](#chatgpt-plus--pro) | 30 sec |
| **OpenAI API** (any ChatGPT plan, including free) | [Python sample](#openai-api) | 1 min |
| **Free claude.ai** (no MCP support) | [Drag-and-drop a Project starter zip](#free-claudeai-no-install) | 1 min |

---

## claude.ai web + Claude mobile

The fastest path. Works in your browser at <https://claude.ai> and the Claude iOS / Android apps. **Requires a paid claude.ai plan** to add custom connectors.

1. Sign in to <https://claude.ai>.
2. Open **Settings → Connectors** (or the connector button in the chat composer).
3. Click **Add custom connector**.
4. Fill in:
   - **Name:** `MSU Policies` (anything is fine)
   - **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
5. Save. The connector should now show **5 tools** available.
6. Open a new chat, enable the connector, and ask a policy question.

Once added on web, the same connector is usable from the Claude mobile app under the same account — no separate setup.

> **Note on freshness:** This hosted version reads from a snapshot of MSU's policies refreshed periodically (the response includes a `corpus_built_at` timestamp). For *always-fresh* data — i.e., a live scrape of MSU per request — install one of the local paths below.

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

**4. Verify.** Look for the tools indicator (small icon near the chat input). You should see `msstate-policies` with **5 tools**. Then try *"What is MSU's hazing policy?"* — Claude will call the chain tool and return a grounded answer with a citation.

The first call takes ~5 seconds (the server fetches MSU's index and the relevant PDF). Later calls reuse cached data and are faster.

A reference snippet is at [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json).

## ChatGPT (Plus / Pro)

ChatGPT Plus and Pro support custom MCP Connectors. **Requires a paid ChatGPT plan** — free-tier users can't add Connectors; if you're on free ChatGPT, see the [OpenAI API](#openai-api) path below instead.

1. Sign in to <https://chatgpt.com>.
2. Open **Settings → Connectors → Add custom connector**.
3. Fill in:
   - **Name:** `MSU Policies` (anything is fine)
   - **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
4. Save. The connector should now show **5 tools** available.
5. Open a new chat, enable the connector, and ask a policy question.

The same connector is usable from the ChatGPT iOS / Android apps under the same account — no separate setup.

> **Note on freshness:** Same as the claude.ai path — this hosted version reads from a snapshot of MSU's policies refreshed periodically (the response includes a `corpus_built_at` timestamp). For *always-fresh* data, install one of the local paths above.

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

INSTRUCTIONS = """You answer questions about Mississippi State University Operating Policies using the msstate-policies MCP server.

Rules:
1. When calling chain_find_relevant_policies, always pass k=5 (the maximum) so the model sees a wider candidate set.
2. If the question is not about MSU policies (e.g., weather, sports scores, news, current events, individuals' personal info), refuse plainly: state that this server only covers Mississippi State University Operating Policies and suggest contacting an appropriate alternative source. Do not invent a policy or speculate.
3. Quote verbatim from policy text and cite the OP number + canonical URL for any normative claim."""

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

A runnable version is at [`examples/openai_api_sample.py`](examples/openai_api_sample.py). Pass a custom question as the first argument:

```bash
python examples/openai_api_sample.py "What's MSU's policy on academic amnesty?"
```

**What to expect:** GPT-4o produces grounded answers with the same citation discipline as Claude — verbatim quotes, OP numbers, canonical URLs, retrieval timestamps. Cross-model quality is validated against a 10-question eval ([`eval-2026-05-08-k5-gpt-4o.json`](msstate-policies/eval/eval-2026-05-08-k5-gpt-4o.json)).

## Free claude.ai (no install)

If you can't install MCP servers (e.g. you're on a free claude.ai plan), there's still a path: a curated **starter zip** with 22 high-traffic policy PDFs and a system-prompt template that pushes Claude toward verbatim quoting.

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

Every response includes:

- The **OP number** for citation (e.g. `91.208`)
- The **canonical URL** on `policies.msstate.edu` — click through to verify
- An ISO **`retrievedAt`** timestamp
- Direct quotes for binding language; no paraphrasing of normative text
- Refusal + redirect when no MSU policy applies

## Tips for getting good answers

- **Ask plainly.** *"Can my RA write me up for lighting a candle in my dorm?"* works as well as *"What is the Code of Student Conduct?"*. The retrieval handles weak-keyword conceptual phrasing.
- **Multi-part questions are fine.** Claude can cite multiple OPs in one answer (e.g., *"my professor cancelled three weeks of class — am I supposed to keep showing up?"* will surface both attendance and instructor-responsibility policies).
- **Ask Claude to quote.** If you want to be sure the wording is verbatim from the policy, ask: *"Quote the actual policy language for the hazing definition."* The tool design encourages verbatim quoting, but a direct prompt makes it explicit.
- **Verify the citation.** Click through the canonical URL in any answer — that's the official MSU PDF.
- **If an answer feels off,** ask Claude to call `health_check`. If the corpus is broken or stale, that tool surfaces the failure mode honestly instead of fabricating.

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

The current release is validated against a 50-question hand-written eval set:

| | |
|---|---:|
| Retrieval correctness (expected OP in returned set) | 37 / 38 |
| Answer correctness (judge: prose answer matches policy text) | 37 / 38 |
| Refusal correctness (out-of-scope questions correctly refused) | 12 / 12 |

Judge: Claude Sonnet 4.6, k=5, BM25-only retrieval. The single missing case is *"tornado warning during my class"* — the relevant OP points at MSU's external Campus Emergency Management Plan, which is outside this server's corpus. Treat 86/88 as the realistic ceiling for the OP-only corpus.

Full eval JSON: [`msstate-policies/eval/eval-2026-05-08-k5-sonnet-4-6.json`](msstate-policies/eval/eval-2026-05-08-k5-sonnet-4-6.json).

## License

MIT. See [LICENSE](LICENSE).

---

*Maintainers: see [`docs/BUILD.md`](docs/BUILD.md) for architecture, decision history, and contribution notes.*
