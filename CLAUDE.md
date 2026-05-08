# CLAUDE.md — Working notes for any future Claude session on this repo

This file is loaded automatically by Claude Code when it operates in this repo. Read it before doing anything else.

## What this repo is

`msstate-mcp` is a Model Context Protocol server that exposes **Mississippi State University Operating Policies** (the `/current` index at <https://www.policies.msstate.edu/current>) to MCP-capable clients (Claude Code, Claude Desktop, Cursor, Windsurf, Zed, claude.ai connector). The authoritative spec is `PLAN.md` in this directory — read it once before writing any code.

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

The whole grounding story of this MCP collapses if its inputs are contaminated by anything other than what MSU publishes. A wrong answer to "what's the policy on amnesty?" is the worst-case failure mode (PLAN.md targets 99.99% answer correctness). The simplest defense is the corpus rule above.

## Network access notes

- Codespace / dev sandbox: **has** network access to `policies.msstate.edu`.
- Some prior sessions ran in sandboxes that didn't — PLAN.md still contains a few "user will run this" notes from that era. Where you have network, you can run them yourself; where you don't, defer.

## Build / run notes

- TypeScript source under `msstate-policies/src/`, bundled by `msstate-policies/build.mjs` (esbuild → CJS, single file). Bundle is committed to `msstate-policies/dist/` and self-identifies via a banner: `// msstate-policies-mcp <ver> <sha> built <iso>`.
- `pdf-parse` is **pinned** (no caret) — internal layout drifts between minor versions and we use the inner-module import (`pdf-parse/lib/pdf-parse.js`).
- All runtime logging goes to **stderr only**. `stdout` is reserved for MCP JSON-RPC framing. One stray `console.log` corrupts the protocol. Use `src/log.ts`.
- Drupal taxonomy IDs are **never** hardcoded — parse them at runtime from the dropdown options.
