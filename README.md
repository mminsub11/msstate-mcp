# msstate-mcp — Mississippi State Operating Policies via MCP

> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by Mississippi State University. It retrieves policy text from the public website at <https://www.policies.msstate.edu/current> for use by an LLM. Always verify against the official source before acting on the result.

A Model Context Protocol server that exposes MSU's ~218 current Operating Policies (the entire `/current` index) to MCP-capable clients. Ask Claude (or Cursor, Windsurf, Zed, etc.) a natural-language policy question; the MCP fetches the relevant policies straight from MSU and Claude answers grounded in that text.

## Install

### Path A — Claude Code (plugin)

```bash
/plugin marketplace add mminsub11/msstate-mcp
/plugin install msstate-policies@msstate-mcp
```

Two commands, no JSON editing.

### Path B — Claude Desktop, Cursor, Windsurf, Zed (plain MCP)

Paste this into your client's MCP-server config:

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

A copy lives at [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json).

### Path C — claude.ai MCP-connector

Paid claude.ai users can install the same server through the connector UI. Same `npx -y msstate-policies-mcp` command.

### Path D — Free claude.ai users (Claude Project starter zip)

A curated bundle of high-traffic MSU policy PDFs plus a system-prompt template lives as a release asset (`msstate-policies-starter.zip`). Drag-and-drop into a Project — no install required. Built by `scripts/build-project-bundle.mjs`.

## Tools

The MCP exposes 5 tools, in deterministic order:

| Tool | Purpose |
|---|---|
| `search_policies` | Keyword search over the index. |
| `get_policy` | Fetch one policy in full by number (e.g. `91.100`) or URL. |
| `chain_find_relevant_policies` | One call: hybrid retrieval + fetch top-`k` bodies. The right tool for natural-language questions. |
| `cite_policy` | Format a citation string. |
| `health_check` | Inspect scraper state — useful when answers seem suspiciously empty. |

The chain tool's description tells Claude to **quote verbatim** for any normative claim and **refuse** rather than paraphrase load-bearing language. That, plus hybrid retrieval (BM25 + optional pre-computed embeddings), is the design's path toward the 99.99% answer-correctness north star.

## Optional: hybrid retrieval with embeddings

By default the server runs BM25-only. To enable semantic retrieval, run the build-time embedding step with an `OPENAI_API_KEY` set; this writes `dist/embeddings.json` (~5 MB) which is committed and shipped with the package. At runtime, query embedding also hits the OpenAI API; if no key is set we silently degrade to BM25-only.

```bash
cd msstate-policies
OPENAI_API_KEY=sk-... npm run embeddings
npm run build  # rebundle so dist/ contains the new embeddings.json
```

## Verification

The corpus contract is "everything we tell the LLM came from `policies.msstate.edu` in this session." Every `chain_find_relevant_policies` and `get_policy` response includes a `retrievedAt` ISO timestamp and the canonical `landingUrl` so users (and the LLM) can check.

When the scraper breaks, `health_check` will show `last_index_error` populated and `index_row_count: 0` — at which point we'd rather Claude apologize than confidently say "MSU has no such policy."

## Kill criteria

The only thing that kills this project is failing the accuracy bars (PLAN.md "Kill criteria" section). Adoption signals are watched but not gated. Low usage with passing eval = a working portfolio piece + reusable template, which is the deliverable.

## Troubleshooting

- **All policies suddenly have empty text** — `health_check` likely shows `last_index_error`. The scraper's selectors may be stale (MSU touched their Drupal layout); fix lives in `msstate-policies/src/scraper.ts` near the `SEL` const at the top of the file.
- **`tools/list` returns 0 tools** — `dist/index.js` is stale or mis-bundled. Re-run `npm run build` in `msstate-policies/`.
- **Hybrid retrieval seems off** — check `health_check.embeddings_loaded`. If `false`, either `dist/embeddings.json` wasn't bundled, or `OPENAI_API_KEY` is missing at runtime.

## License

MIT. See [LICENSE](LICENSE).

## Plan / design history

See [PLAN.md](PLAN.md) for the full design history (now at v7) and [CLAUDE.md](CLAUDE.md) for the corpus rule that future maintainers must follow.
