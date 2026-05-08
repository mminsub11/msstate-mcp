# CLAUDE.md — Working notes for any future Claude session on this repo

This file is loaded automatically by Claude Code when it operates in this repo. Read it before doing anything else.

## Reading order before non-trivial changes

For non-trivial work — and ALWAYS before touching anything security-shaped (Worker code, build chain, `dist/` regeneration, dependency bumps, CORS, error paths, logging, file modes, CI workflow, `tools/security-checklist.sh`) — read in this order:

1. **`CLAUDE.md`** (this file) — load-bearing rules: corpus rule, stderr-only logging, security-score contract. The `## Security notes (round-2 closure 2026-05-08)` section near the bottom lists specific patterns that must not regress.
2. **`SECURITY.md`** — what's in scope, what's NOT, and especially `## Out of scope: client-side circumvention`. That section defines the user-side abuse classes we explicitly *don't* defend against (local edits to the bundle, prompt-level circumvention, fork-the-corpus, LLM hallucination, indirect injection inside published PDFs). Treat anything matching those bullets as `wontfix` by design.
3. **`docs/BUILD.md`** — architecture, decision history, deferred items (M1/M2/M6), eval methodology, threat model. The **Round-2 audit closure (2026-05-08)** section captures the per-finding history (N1–N10 + DISC) that `tools/security-checklist.sh` now mechanically enforces.

After any change in scope, run `bash tools/security-checklist.sh | tail -1` and confirm the score is still **192**. CI hard-gates on `>= 100`; below 192 means a check regressed.

## What this repo is

`msstate-mcp` is a Model Context Protocol server that exposes **Mississippi State University Operating Policies** (the `/current` index at <https://www.policies.msstate.edu/current>) to MCP-capable clients (Claude Code, Claude Desktop, Cursor, Windsurf, Zed, claude.ai connector). For project overview, architecture, decision history, eval methodology, and open issues, see [`docs/BUILD.md`](./docs/BUILD.md). Read it once before non-trivial work.

The server ships in two surfaces from one bundle:
- **Claude Code plugin** (`/plugin install msstate-policies@msstate-mcp`)
- **plain MCP via `npx`** (`npx -y msstate-policies-mcp`)

Both run the same `msstate-policies/dist/index.js`, which is **committed** to the repo so the plugin path resolves with no `npm install` step.

## CORPUS RULE — No trained knowledge, no web searches

**The policy corpus, the eval set, and every fact this server returns must come exclusively from <https://www.policies.msstate.edu/current> and the PDFs it links to. Nothing else.**

This is non-negotiable and applies to every Claude session that touches this repo:

- Do not populate any policy text, OP number, citation, effective date, responsible office, or any other field from training data, intuition, or general knowledge of "what universities usually have."
- Do not use `WebSearch`, `WebFetch` against non-MSU domains, or any third-party documentation, news, archive, mirror, cache, or AI-generated summary as a source for policy content. The Wayback Machine, ChatGPT logs, secondary write-ups, accreditor docs — none of them.
- Do not author eval questions of the form `{ q: "what's the rule on X?", expected_op_numbers: ["91.100"] }` from memory or a guess. Either pull the OP number by scraping/searching the live index for the relevant title, or leave it blank with a `TODO` and let a human confirm.
- Do not include "examples" in tool descriptions, README copy, or comments that quote or paraphrase policy text unless that text was just retrieved from the live site in this same session.
- Do fetch `https://www.policies.msstate.edu/current`, parse it, and follow the `<a class="btn-download">` links to extract policy text from MSU's own PDFs.
- Do use `WebFetch` and `curl` for `policies.msstate.edu` and its `*.msstate.edu` subdomains only when needed to verify selectors, audit PDFs, or seed fixtures.
- Do label any string in the codebase that didn't come from the live site as "placeholder" or "example only" so a future maintainer doesn't mistake it for ground truth.

The whole grounding story of this MCP collapses if its inputs are contaminated by anything other than what MSU publishes. A wrong answer to "what's the policy on amnesty?" is the worst-case failure mode (the design targets 99.99% answer correctness as the north star). The simplest defense is the corpus rule above.

## Network access notes

- Codespace / dev sandbox: **has** network access to `policies.msstate.edu`.
- Some prior sessions ran in sandboxes that didn't — `docs/BUILD.md` still contains a few "user will run this" notes from that era. Where you have network, you can run them yourself; where you don't, defer.

## Build / run notes

- TypeScript source under `msstate-policies/src/`, bundled by `msstate-policies/build.mjs` (esbuild → CJS, single file). Bundle is committed to `msstate-policies/dist/` and self-identifies via a banner: `// msstate-policies-mcp <ver> <sha> built <iso>`.
- `pdf-parse` is **pinned** (no caret) — internal layout drifts between minor versions and we use the inner-module import (`pdf-parse/lib/pdf-parse.js`).
- All runtime logging goes to **stderr only**. `stdout` is reserved for MCP JSON-RPC framing. One stray `console.log` corrupts the protocol. Use `src/log.ts`.
- Drupal taxonomy IDs are **never** hardcoded — parse them at runtime from the dropdown options.

## Security notes (round-2 closure 2026-05-08)

The mechanical security checklist (`tools/security-checklist.sh`) was extended from 100 → 192 pts during the round-2 audit. CI now hard-gates pushes/PRs on `score >= 100`. Current head should score **192/192**; if you regress it, fix the failing check before merging — the round-2 closure note in [`docs/BUILD.md`](./docs/BUILD.md) covers what changed and why, and `git log --grep "N\\(1\\|2\\|3\\|4\\|5\\|6\\|7\\|8\\|9\\|10\\)"` finds the per-finding mitigation commits.

A few patterns to keep in mind so the round-2 score doesn't drift:
- Worker error paths: never echo `(err as Error).message` to clients; always log structured fields server-side, return generic messages with the JSON-RPC `id` for correlation.
- Worker request bodies: keep the `Content-Length > 64_000 → 413` cap before `request.json()`. Tool-arg length cap (`MAX_QUERY_CHARS = 4096`) lives downstream.
- Worker CORS: do NOT add `Authorization` back to `Access-Control-Allow-Headers` unless real auth lands. The check is grep-based and will fail loudly if you do.
- Build chain: `scripts/build-worker-corpus.mjs` aborts on a WAF challenge. If a future M6 cron lands, do not weaken that — it's the only thing standing between a transient MSU interstitial and a poisoned corpus.
- Disk cache: `mkdirSync({ mode: 0o700 })` + `writeFileSync({ mode: 0o600 })` are load-bearing on multi-user hosts.
- `SECURITY.md` `## Out of scope: client-side circumvention` captures the user-side abuse classes we explicitly disclaim. Treat that section as authoritative when triaging issue reports — anything matching those bullets is `wontfix` by design.
