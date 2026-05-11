# ChatGPT Connector support — design

**Date:** 2026-05-08
**Status:** Design (awaiting user empirical verification)
**Scope:** Verify the existing MCP Worker is consumable from ChatGPT Plus/Pro as a custom Connector, then document the add-Connector flow.

## Goal

Make `msstate-mcp` reachable from ChatGPT's web chat and mobile app via the **custom Connector** flow (Settings → Connectors → Add custom connector). Same Worker URL, same 5 tools, no new code, no auth changes. Audience is **paid-plan ChatGPT users only** (Plus and Pro).

## Non-goals

This is *prove + document*, not *build*. The following are out of scope:

- A new server, REST shim, OpenAPI spec, or auth surface.
- OAuth 2.1 + DCR — deferred to its own future spec if Connector flow demands it.
- Custom GPTs via OpenAPI Actions — different audience (free-user reach), explicitly ruled out by user.
- ChatGPT Apps SDK / app-store distribution — separate scope, different protocol.
- Free-tier ChatGPT users — they don't have Connector access; not addressable on this path.
- Worker behavior changes (still anonymous public HTTP, still 5 tools, still 217 policies).
- Version bump — explicitly skipped per maintainer call. Stays at 0.3.0.

## Why this can be small

The Worker already exposes a working MCP-over-HTTP endpoint at `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`. Tier 1 verification during the OpenAI API project (commit `91e2117`) proved OpenAI's stack can talk to it. ChatGPT Connectors use the same MCP protocol. If the Connector flow accepts unauthenticated MCP servers, this project is docs-only. If it doesn't, we halt with a documented finding rather than expanding scope mid-flight.

## Audience

Paid ChatGPT users on Plus or Pro. Free-tier users were considered and explicitly ruled out — they cannot add custom Connectors regardless of server-side work, and reaching them would require building a Custom GPT (separate scope).

## Verification methodology

Maintainer-driven, three-branch outcome:

### Branch A — Works (no OAuth)

The maintainer upgrades to ChatGPT Plus, opens Settings → Connectors → Add custom connector, enters:
- **Name:** `MSU Policies` (anything)
- **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`

Saves. The connector lists **5 tools**. They open a new chat, enable the connector, ask *"What is MSU's hazing policy?"*, and ChatGPT returns a grounded answer that quotes OP 91.208 with a `policies.msstate.edu` URL.

If this is what they observe, project proceeds to "Documentation deliverables" below.

### Branch B — Plus doesn't have Connectors

If ChatGPT Plus turns out not to have custom Connector support (OpenAI has moved this in/out of Plus over time), **halt**. The maintainer explicitly ruled out upgrading further to Pro ($200/mo) just to verify. Project ships a small README footnote: *"Custom MCP Connectors require ChatGPT Pro/Business as of 2026-05-08; Plus access not verified."*

### Branch C — OAuth required

If ChatGPT's Connector setup rejects the Worker URL because it requires OAuth 2.1 + DCR, **halt**. Project files a follow-up spec for OAuth implementation (separate brainstorm covering auth model, key issuance, abuse posture). README gets a one-line note that ChatGPT Connector support is pending OAuth work.

## Documentation deliverables (Branch A only)

### D1. New README section: `## ChatGPT (Plus / Pro)`

Inserted parallel to the existing `## claude.ai web + Claude mobile` section. Contents:

- One-paragraph framing: ChatGPT Plus and Pro support custom MCP Connectors. Free-tier users can't add Connectors; for free-ChatGPT use cases, see the [OpenAI API](#openai-api) path.
- Numbered step-by-step add-Connector flow, parallel to the existing claude.ai instructions:
  1. Sign in to <https://chat.openai.com>
  2. Open Settings → Connectors → Add custom connector
  3. Fill in name + Worker URL
  4. Save; verify 5 tools appear
  5. Open a new chat, enable the connector, ask a policy question
- Mobile note: same connector works in the ChatGPT iOS / Android apps under the same account, no separate setup (parallel to the claude.ai section).
- Freshness note: identical to the claude.ai section's note (snapshot-based, refreshed periodically).

The exact wording and any quirks (e.g., "you may see an unverified-publisher warning, click trust") will be filled in based on the maintainer's empirical observations.

### D2. README "Pick your client" table — add one row

Inserted before the existing OpenAI API row (so paid options group together):

```markdown
| **ChatGPT** (Plus / Pro) | [Add a connector with a URL](#chatgpt-plus--pro) | 30 sec |
```

### D3. README "Privacy" section — add a fourth bullet

```markdown
- **ChatGPT (Plus / Pro) via the connector**: your query goes to OpenAI's models and to the hosted Cloudflare Worker. No traffic to Anthropic in this mode. The Worker still only fetches from MSU and stores no logs of your queries beyond Cloudflare's standard request metadata.
```

### D4. No new examples file

The Connector flow is UI-only — no code sample needed. Existing `examples/openai_api_sample.py` covers the API path.

## Out of scope

- OAuth (Branch C trigger)
- Custom GPTs / OpenAPI Actions
- Apps SDK
- ChatGPT Enterprise SSO
- Worker code changes
- Version bump (0.3.0 stays)
- New eval JSON — protocol layer is already validated by Tier 1 + the existing 10-question gpt-4o eval; ChatGPT Connectors use the same MCP protocol path.

## Risks

**R1. Plus doesn't have Connectors.**
Likelihood: medium. OpenAI has moved this in/out. Branch B handles it cleanly — small documented finding, no engineering wasted.

**R2. OAuth required.**
Likelihood: medium-high. OpenAI has been pushing toward OAuth on connectors for verified publishing. Branch C handles it — halt, future spec.

**R3. Connector accepts URL but tools/list fails.**
Likelihood: low. The Worker passes Tier 1 against OpenAI's Responses API + MCP tool, so the protocol layer is verified.

**R4. Maintainer unavailable to verify.**
This project blocks on the maintainer upgrading + testing. No workaround. Project sits in "design-approved, awaiting verification" state until they act.

## Acceptance criteria

This spec is "done" when ONE of:

1. **Branch A success:** README has a `## ChatGPT (Plus / Pro)` section, a new client-table row, and a 4th privacy bullet. Maintainer confirms the Connector works end-to-end with a real policy question.
2. **Branch B halt:** README has a one-line footnote noting the Plus-vs-Pro ambiguity. No further work.
3. **Branch C halt:** A new spec exists at `.dev/specs/<date>-chatgpt-oauth-design.md` capturing the OAuth scope. README has a one-line footnote. No further work in this spec.

## Implementation plan

Created via `superpowers:writing-plans` after user approval, saved to `.dev/plans/2026-05-08-chatgpt-connector.md`. Plan will be tiny — a 3-4 task structure that essentially says: *"wait for user to verify, then write README updates"*.
