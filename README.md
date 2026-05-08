# msstate-mcp

**Ask Claude about Mississippi State University Operating Policies and get answers grounded in the actual policy text — with citations.**

> ⚠️ **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by Mississippi State University. It retrieves policy text from the public site at <https://www.policies.msstate.edu/current> for use by an LLM. Always verify against the official source before acting on the result.

## What you can ask

```
What is MSU's hazing policy?
What's the rule on smoking and tobacco use on campus?
How does the grade appeal process work?
What sanctions apply to alcohol and drug offenses for MSU students?
What is MSU's policy on student education records (FERPA)?
What's MSU's travel reimbursement policy?
What's MSU's faculty grievance procedure?
```

When you ask, Claude downloads the official MSU policy PDF, reads it, and answers using **only** that text — quoting verbatim for binding language and citing the OP number, the canonical URL on `policies.msstate.edu`, and the timestamp the policy was retrieved.

If no MSU policy applies (e.g. *"what's the weather forecast?"*), Claude refuses cleanly instead of fabricating an answer.

## Quick start (60 seconds)

### Easiest — Claude Code

```
/plugin marketplace add mminsub11/msstate-mcp
/plugin install msstate-policies@msstate-mcp
```

Done. Restart Claude Code if needed and ask a policy question.

### Claude Desktop (step-by-step)

You'll need [Node.js](https://nodejs.org) installed on your machine (any version 18 or newer). The `npx` command comes with Node.

**1. Find your config file.** It's a JSON file in a fixed location per OS:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

If the file doesn't exist yet, create it. From Claude Desktop you can also click **Settings → Developer → Edit Config** (it'll open the right file in your default editor).

**2. Add the MCP server entry.** If the file is empty, paste this whole snippet:

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

If the file already has content (other MCP servers configured), just add `"msstate-policies"` inside the existing `"mcpServers"` object — like this:

```json
{
  "mcpServers": {
    "some-other-server": { "...": "..." },
    "msstate-policies": {
      "command": "npx",
      "args": ["-y", "msstate-policies-mcp"]
    }
  }
}
```

**3. Save the file and fully quit Claude Desktop.** Don't just close the window — on macOS use Cmd+Q; on Windows right-click the system tray icon and pick Quit. Reopen Claude Desktop.

**4. Verify it loaded.** In a new chat, look for the tools indicator (usually a small icon near the chat input or in the bottom toolbar). You should see `msstate-policies` listed with 5 tools. If it's missing, see [Troubleshooting](#troubleshooting) below.

**5. Try a sample question.** Ask *"What is MSU's hazing policy?"* — Claude should call the `chain_find_relevant_policies` tool and return a grounded answer with a citation.

The first call takes a few seconds (the server fetches MSU's index and the relevant PDF). Later calls reuse cached data and are faster.

### Cursor / Windsurf / Zed

Same `npx -y msstate-policies-mcp` command, different paste location:

| Client | Where to paste |
|---|---|
| Cursor | Settings → MCP → Add server |
| Windsurf | Settings → MCP servers |
| Zed | `~/.config/zed/settings.json` under `context_servers` |

A reference snippet lives at [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json).

### Free claude.ai users — no install (works on web AND mobile)

The latest GitHub release ships a starter zip (`msstate-policies-starter.zip`) with 22 high-traffic policy PDFs and a system-prompt template that pushes Claude toward verbatim quoting.

1. Download `msstate-policies-starter.zip` from the [latest release](https://github.com/mminsub11/msstate-mcp/releases/latest).
2. On a computer, sign in to <https://claude.ai>.
3. Create a new **Project** (or open an existing one).
4. Unzip the file and drag the PDFs + the `SYSTEM_PROMPT.txt` into the Project's knowledge area.
5. Ask policy questions inside that Project's chats.

This works on the **Claude mobile app** too — once the Project is set up on web, your phone sees the same Project and you can ask questions from mobile. The starter zip is a smaller corpus than the live MCP (22 policies vs. 218), but it's the only path that works without installing anything.

### Why claude.ai web and mobile can't use the live MCP directly

Anthropic's claude.ai (web and mobile) supports MCP servers through the **Connectors** feature, which only accepts **remote HTTP/SSE servers**. This project is a **local stdio** server — it runs on your machine. For full corpus access on web/mobile, you'd need a remote variant deployed somewhere (Cloudflare Workers, fly.io, etc.); that's on the roadmap but not in this release. Workaround: use the Project starter zip above, or install Claude Desktop on a computer for full MCP support.

## What you get back

Ask Claude *"What is MSU's hazing policy?"* and you'll see something like:

> MSU's hazing policy, in **OP 91.208**, prohibits hazing across all university-affiliated organizations:
>
> *"Hazing is prohibited. Any organization, student, or other person affiliated with the university found to have engaged in hazing as defined in this policy is subject to disciplinary action under the Student Code of Conduct and other applicable university policies. Under certain circumstances, hazing may also be a violation of applicable laws, resulting in a criminal prosecution."* (OP 91.208)
>
> The policy defines hazing as *"any intentional, knowing, or reckless act committed by a person..."* [definition continues]
>
> **Source:** OP 91.208 at <https://www.policies.msstate.edu/policy/91208> (retrieved 2026-05-08).

Every response includes:

- The **OP number** for citation (e.g. `91.208`)
- The **canonical URL** on `policies.msstate.edu` — click through to verify
- An ISO **`retrievedAt`** timestamp showing when the policy text was fetched
- Direct quotes for binding language; no paraphrasing of normative text

## Tools the MCP exposes

| Tool | When you'd call it |
|---|---|
| `chain_find_relevant_policies` | The default for natural-language questions. Searches + fetches in one call. |
| `search_policies` | Just keyword search; returns OP numbers + titles + match snippets. |
| `get_policy` | Pull one specific policy in full by number (e.g. `91.100`) or URL. |
| `cite_policy` | Format a clean citation string. |
| `health_check` | If answers come back empty, this shows whether the scraper is broken. |

You don't normally need to know these — Claude picks the right one.

## Privacy

In default mode, your queries never leave your machine. The only outbound traffic is to `policies.msstate.edu` to fetch policy PDFs. No analytics, no telemetry, no third-party APIs.

If you opt in to semantic retrieval (see [Configuration](#configuration-optional) below), your natural-language query is sent to OpenAI for embedding. **For sensitive topics (Title IX, harassment, FERPA), keep the default — `bm25` mode — to avoid sending the query to a third party.**

## Configuration (optional)

Most users don't need to set anything. If you want to tune behavior:

| Environment variable | Default | What it does |
|---|---|---|
| `MSSTATE_POLICIES_RETRIEVAL` | `bm25` | Set to `embed` or `hybrid` to use OpenAI embeddings for retrieval. The default `bm25` ties or beats embed/hybrid on the eval; opt in only for experimentation. Requires `OPENAI_API_KEY` if changed. |
| `OPENAI_API_KEY` | unset | Only needed if you change the retrieval mode above. |
| `MSSTATE_POLICIES_CACHE` | unset | Set to `disk` to cache policy PDFs across process restarts (cross-platform via `env-paths`). Default is in-memory only. |

## Verifying answers

Don't trust the LLM. Trust the citation.

1. Every response includes the canonical URL — click through to read the official PDF.
2. The `retrievedAt` timestamp tells you when this server fetched the policy. If MSU has updated it since, the answer may be stale.
3. If a response looks suspiciously empty, ask Claude to call `health_check`. A `last_index_error` populated there means the scraper is broken — likely MSU changed their site layout.

## Troubleshooting

- **"All policies have empty text"** — Run `health_check`. If you see `last_index_error` and `index_row_count: 0`, MSU touched their site and the scraper needs updating. File an issue on GitHub.
- **`tools/list` returns 0 tools** — The bundle is stale. From a local checkout: `cd msstate-policies && npm run build`. From the plugin or `npx`, reinstall to get the latest published version.
- **Trying to use embed/hybrid retrieval and it's not working** — Check `health_check.embeddings_loaded`. If `false`, either `dist/embeddings.json` wasn't shipped (unlikely with the published package) or `OPENAI_API_KEY` is missing in your client's MCP env. Also confirm `MSSTATE_POLICIES_RETRIEVAL` is set — it defaults to `bm25`.
- **"Hazing policy" but I'm asking about something MSU obviously doesn't cover** — Claude is supposed to refuse. If you're getting a fabricated-looking citation, file an issue with the question text — that's exactly the failure mode we eval against.

## Eval

The current release is validated against a 50-question hand-written eval set (`msstate-policies/eval/questions.jsonl`):

| | |
|---|---:|
| Retrieval correctness (expected OP in returned set) | 37 / 38 |
| Answer correctness (judge: prose answer matches policy text) | 37 / 38 |
| Refusal correctness (out-of-scope questions correctly refused) | 12 / 12 |

Judge: Claude Sonnet 4.6, k=5, BM25-only retrieval. The single missing case is "tornado warning during my class" — OP 01.04 (Emergency Operations) points at MSU's external Campus Emergency Management Plan, which is outside this server's corpus. Treat 86/88 as the realistic ceiling for this corpus shape.

Full eval JSON: [`msstate-policies/eval/eval-2026-05-08-k5-sonnet-4-6.json`](msstate-policies/eval/eval-2026-05-08-k5-sonnet-4-6.json).

## License

MIT. See [LICENSE](LICENSE).

---

*Maintainers: see [`docs/BUILD.md`](docs/BUILD.md) for architecture, decision history, and contribution notes.*
