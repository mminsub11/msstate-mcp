# msstate-policies-mcp

MCP server exposing Mississippi State University's current Operating Policies (<https://www.policies.msstate.edu/current>). Unofficial.

This is the publishable npm package and the Claude Code plugin source. See the [repository root README](../README.md) for install paths and the design overview.

## Install (plain MCP)

```bash
npx -y msstate-policies-mcp
```

…or from a local checkout:

```bash
node /path/to/msstate-mcp/msstate-policies/dist/index.js
```

## Tools

`search_policies`, `get_policy`, `chain_find_relevant_policies`, `cite_policy`, `health_check` — see the root README.

## Environment variables

| Variable | Effect |
|---|---|
| `OPENAI_API_KEY` | Enables semantic retrieval at runtime. Without it, server runs BM25-only. |
| `MSU_DISK_CACHE` | Set to `1` to enable on-disk policy cache (cross-platform via env-paths). Default: in-memory only. |
| `MSU_LOG_LEVEL` | `debug \| info \| warn \| error`. Default `info`. |

All logging goes to **stderr** only — stdout is reserved for MCP JSON-RPC framing.

## Scripts

```bash
npm run build         # bundle src/ → dist/index.js (CJS)
npm run typecheck     # tsc --noEmit
npm test              # tsx --test tests/*.test.ts
npm run audit:pdfs    # download + parse all current PDFs (live; writes eval/audit-*.csv)
npm run embeddings    # build dist/embeddings.json (needs OPENAI_API_KEY)
npm run eval          # run the eval harness against the live MCP
npm run bundle        # build the Claude Project starter zip
```

## License

MIT.
