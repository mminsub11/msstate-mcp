# ChatGPT Connector Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the existing `msstate-policies` MCP Worker is consumable from ChatGPT Plus/Pro as a custom Connector, then write the README updates documenting how paid ChatGPT users add it. No Worker code changes, no auth surface, no version bump.

**Architecture:** The Worker is unchanged. The maintainer empirically tests the Connector flow on ChatGPT Plus, reports observations, and the plan branches into one of three terminal states: A) docs land in README; B) Plus-has-no-Connectors footnote; C) OAuth-required halt with a follow-up spec stub. **An agentic executor cannot run Tasks 2 and 3** — those require the human maintainer interacting with the ChatGPT UI in a real browser. The plan is structured so an agent can complete Task 1 + 4–12 once the maintainer has filed their observations.

**Tech Stack:** ChatGPT Plus subscription (maintainer, $20/mo), the deployed Cloudflare Worker (unchanged at `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`), Markdown for README updates.

**Spec reference:** `.dev/specs/2026-05-08-chatgpt-connector-design.md`

---

## Task 1: Pre-flight — branch staging + Worker reachability

**Files:** none (verification only)

- [ ] **Step 1: Confirm working tree is clean and on a fresh feature branch from main**

Run from `/workspaces/msstate-mcp`:
```bash
git status --short && git rev-parse --abbrev-ref HEAD
```
Expected: only the gitignored `node_modules` symlink listed (`?? node_modules`); current branch is `claude/chatgpt-connector` (already created during the brainstorm spec commit). If on `main`, run:
```bash
git checkout -b claude/chatgpt-connector
```

- [ ] **Step 2: Verify the deployed Worker is reachable**

Run:
```bash
curl -fsS https://msstate-policies-mcp.mminsub90.workers.dev/health
```
Expected: JSON with `status: "ok"`, `policies` ≥ 200, an ISO `builtAt` timestamp. If this fails, halt and report — the Worker is the system under verification.

- [ ] **Step 3: No commit**

Pre-flight is verification only.

---

## Task 2: Maintainer upgrades to ChatGPT Plus

**Files:** none (real-world action by the human maintainer; an agentic worker cannot complete this task)

- [ ] **Step 1: Sign in / sign up at <https://chat.openai.com>**

Use the same email as the maintainer's existing free-tier ChatGPT account (or create one if none exists).

- [ ] **Step 2: Upgrade to ChatGPT Plus ($20/mo)**

Click the upgrade prompt in the left sidebar or the profile menu. Complete payment. Confirm the account header shows "Plus" once the upgrade processes.

- [ ] **Step 3: No commit, no agent action**

This task blocks Tasks 3 onwards. An agentic executor running this plan must pause here and surface a NEEDS_CONTEXT report to the controller until the maintainer confirms Plus is active.

---

## Task 3: Maintainer attempts the Connector flow + reports observations

**Files:** none (maintainer empirical action; report findings to controller)

- [ ] **Step 1: Open Settings → Connectors**

In ChatGPT (web), click the profile picture (top right) → **Settings** → look for a **Connectors** entry in the left settings nav. (OpenAI sometimes labels this "Apps & Connectors" or "Custom connectors"; if neither appears, that's the **Branch B trigger** — record the absence and skip to Step 6.)

- [ ] **Step 2: Click "Add custom connector"**

(Wording varies: "Create custom connector", "+ New connector", or similar.) If this control isn't present *while still in Settings → Connectors*, record the absence and treat it as Branch B in Step 6.

- [ ] **Step 3: Fill in the connector form**

- **Name:** `MSU Policies`
- **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
- Leave any optional auth/OAuth fields empty.

- [ ] **Step 4: Save and observe what ChatGPT does**

Three possible outcomes:

- **(A)** ChatGPT accepts the URL, fetches it, and displays the connector with **5 tools** listed (`search_policies`, `get_policy`, `chain_find_relevant_policies`, `cite_policy`, `health_check`). Possibly also an "unverified publisher" warning that you click through.
- **(B)** No "Add custom connector" UI exists at all on this Plus account.
- **(C)** ChatGPT rejects the URL with an error mentioning OAuth, authorization, or "this server requires authentication".

Record exactly which one happens, with screenshots if possible.

- [ ] **Step 5: (Branch A only) Test the connector with a real question**

Open a new chat. Enable the `MSU Policies` connector for that conversation (a toggle in the chat composer / connector tray). Ask:

> What is MSU's hazing policy?

Wait for ChatGPT's response. Verify:
- The answer mentions **OP 91.208** by number.
- The answer includes a quoted policy text passage (verbatim phrase like "Hazing is prohibited" or the definition of hazing).
- The answer includes a `policies.msstate.edu` URL (canonical landing page or PDF link).

Record the response. Note any prompts ChatGPT gave you (e.g. "MSU Policies wants to use a tool — allow?").

- [ ] **Step 6: Report findings to the controller**

Surface a structured report with:
1. **Branch:** A / B / C
2. **What you saw:** brief description of UI flow and any error text
3. **(Branch A only) The model's answer to "What is MSU's hazing policy?"** — paste it verbatim
4. **Quirks worth documenting:** anything a future user would benefit from knowing (e.g. "you have to click 'Trust' on an unverified-publisher warning", "the connector toggle is only in the composer, not the sidebar")

The controller routes the rest of the plan based on this report.

---

## Task 4: Controller branch dispatch

**Files:** none (decision)

- [ ] **Step 1: Read the maintainer's Task 3 Step 6 report**

- [ ] **Step 2: Route to the correct branch**

| Maintainer's branch | Next tasks | Skip tasks |
|---|---|---|
| **A** (Connector works) | 5 → 6 → 7 → 8 → 9 (push + PR) | 10, 11, 12 |
| **B** (Plus has no Connectors) | 10 → 9 (push + PR) | 5, 6, 7, 8, 11, 12 |
| **C** (OAuth required) | 11 → 12 → 9 (push + PR) | 5, 6, 7, 8, 10 |

- [ ] **Step 3: No commit**

Dispatch only.

---

## Task 5 (Branch A): Add `## ChatGPT (Plus / Pro)` section to README

**Files:**
- Modify: `README.md` (insert new section after `## claude.ai web + Claude mobile` and before `## Claude Code`)

- [ ] **Step 1: Locate the insertion point**

Run:
```bash
grep -n "^## " README.md
```
Find the line `## Claude Code`. The new section is inserted **immediately before** that line so the order is `## claude.ai web + Claude mobile` → `## ChatGPT (Plus / Pro)` → `## Claude Code`.

- [ ] **Step 2: Insert the section**

Use the Edit tool. `old_string` = the existing closing line of the claude.ai section through the start of the Claude Code section. `new_string` = same anchor PLUS the new section in between.

`old_string`:
```markdown
> **Note on freshness:** This hosted version reads from a snapshot of MSU's policies refreshed periodically (the response includes a `corpus_built_at` timestamp). For *always-fresh* data — i.e., a live scrape of MSU per request — install one of the local paths below.

## Claude Code
```

`new_string`:
```markdown
> **Note on freshness:** This hosted version reads from a snapshot of MSU's policies refreshed periodically (the response includes a `corpus_built_at` timestamp). For *always-fresh* data — i.e., a live scrape of MSU per request — install one of the local paths below.

## ChatGPT (Plus / Pro)

ChatGPT **Plus** and **Pro** plans support adding custom MCP servers as Connectors. Free-tier accounts can't add Connectors — for free-ChatGPT use cases, see the [OpenAI API](#openai-api) section below.

1. Sign in to <https://chat.openai.com>.
2. Open **Settings → Connectors** (some plans show this as **Apps & Connectors** or under the profile menu).
3. Click **Add custom connector** (wording may vary: **Create custom connector**, **+ New connector**, etc.).
4. Fill in:
   - **Name:** `MSU Policies` (anything is fine)
   - **URL:** `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
5. Save. The connector should now show **5 tools** available. ChatGPT may display an "unverified publisher" notice — accept it to continue.
6. Open a new chat, enable the **MSU Policies** connector for that conversation, and ask a policy question.

The same connector works in the ChatGPT iOS / Android apps under the same account — no separate setup.

> **Note on freshness:** Same caveat as the claude.ai connector — this hosted version reads from a periodically-refreshed snapshot (the response includes a `corpus_built_at` timestamp). For *always-fresh* data, install one of the local paths below.

## Claude Code
```

**Replacement strategy note:** the wording above is what ships if the maintainer's Task 3 observations match the canonical happy path (ChatGPT accepts URL, lists 5 tools, allows enabling per-chat). If the maintainer reported quirks in Task 3 Step 6 (e.g., a different label for "Connectors", an extra confirmation dialog, a different per-chat enablement mechanism), update the corresponding numbered step before staging the edit. Do NOT ship docs that contradict what the maintainer actually saw.

- [ ] **Step 3: Verify the edit landed cleanly**

Run:
```bash
grep -n "## ChatGPT (Plus / Pro)" README.md
```
Expected: exactly one match, line number between the existing `## claude.ai web + Claude mobile` and `## Claude Code` headings.

- [ ] **Step 4: Verify the GitHub-style anchor renders correctly**

Run:
```bash
echo "ChatGPT (Plus / Pro)" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 _-]//g; s/ /-/g'
```
Expected output: `chatgpt-plus--pro` (note the double dash where the slash dropped). This is the anchor the table-row link in Task 6 will reference.

- [ ] **Step 5: No commit yet**

Tasks 6 and 7 add the table row and privacy bullet; we commit them together at the end of Task 8.

---

## Task 6 (Branch A): Add a row to the "Pick your client" table

**Files:**
- Modify: `README.md` (insert new row in the existing table between the Claude Desktop/Cursor/Windsurf/Zed row and the OpenAI API row)

- [ ] **Step 1: Insert the row using Edit**

`old_string`:
```markdown
| **Claude Desktop**, **Cursor**, **Windsurf**, **Zed** | [Paste a JSON snippet](#claude-desktop-cursor-windsurf-zed) | 1 min |
| **OpenAI API** (any ChatGPT plan, including free) | [Python sample](#openai-api) | 1 min |
```

`new_string`:
```markdown
| **Claude Desktop**, **Cursor**, **Windsurf**, **Zed** | [Paste a JSON snippet](#claude-desktop-cursor-windsurf-zed) | 1 min |
| **ChatGPT** (Plus / Pro) | [Add a connector with a URL](#chatgpt-plus--pro) | 30 sec |
| **OpenAI API** (any ChatGPT plan, including free) | [Python sample](#openai-api) | 1 min |
```

- [ ] **Step 2: Sanity-check the table**

Run:
```bash
sed -n '/^## Pick your client/,/^---$/p' README.md
```
Expected: 6 data rows in the table (claude.ai, Claude Code, Claude Desktop set, ChatGPT, OpenAI API, Free claude.ai), plus the header row.

- [ ] **Step 3: No commit yet**

---

## Task 7 (Branch A): Add a fourth bullet to the Privacy section

**Files:**
- Modify: `README.md` (insert new bullet between the existing claude.ai connector bullet and OpenAI API bullet)

- [ ] **Step 1: Insert the bullet using Edit**

`old_string`:
```markdown
- **claude.ai web / mobile via the connector**: your query goes to Anthropic (as it always does on claude.ai) and to the hosted Cloudflare Worker, which only fetches from the snapshot — never sends your query elsewhere.
- **OpenAI API**: your query goes to OpenAI's models and to the hosted Cloudflare Worker. No traffic to Anthropic in this mode. The Worker still only fetches from MSU and stores no logs of your queries beyond Cloudflare's standard request metadata.
```

`new_string`:
```markdown
- **claude.ai web / mobile via the connector**: your query goes to Anthropic (as it always does on claude.ai) and to the hosted Cloudflare Worker, which only fetches from the snapshot — never sends your query elsewhere.
- **ChatGPT (Plus / Pro) via the connector**: your query goes to OpenAI's models (as it always does on chat.openai.com) and to the hosted Cloudflare Worker. No traffic to Anthropic in this mode. The Worker still only fetches from MSU and stores no logs of your queries beyond Cloudflare's standard request metadata.
- **OpenAI API**: your query goes to OpenAI's models and to the hosted Cloudflare Worker. No traffic to Anthropic in this mode. The Worker still only fetches from MSU and stores no logs of your queries beyond Cloudflare's standard request metadata.
```

- [ ] **Step 2: Verify the Privacy section now has 4 mode bullets + the trailing "Sensitive topics" bullet**

Run:
```bash
sed -n '/^## Privacy/,/^## /p' README.md | grep -c "^- \*\*"
```
Expected: `5`.

- [ ] **Step 3: No commit yet — Task 8 commits all three Branch A edits together**

---

## Task 8 (Branch A): Final sanity checks + commit

**Files:** none (verification + commit)

- [ ] **Step 1: Verify all anchors line up**

Run:
```bash
grep -E "(#chatgpt-plus--pro|## ChatGPT \(Plus / Pro\))" README.md
```
Expected: at least 2 matches — one in the table row (`#chatgpt-plus--pro`) and one heading (`## ChatGPT (Plus / Pro)`).

- [ ] **Step 2: Confirm no source code or `dist/` was touched**

Run:
```bash
git status --short
```
Expected: only `M README.md`. If anything else shows up (especially `dist/`, `worker/`, or `msstate-policies/`), STOP and investigate — Branch A is docs-only.

- [ ] **Step 3: Run the security checklist as a sanity check**

Run:
```bash
bash tools/security-checklist.sh | tail -1
```
Expected: `192`. This change is docs-only so the score must not move.

- [ ] **Step 4: Stage and commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(README): add ChatGPT (Plus / Pro) connector section

Documents how paid ChatGPT users add the deployed MCP Worker as a
custom Connector via Settings → Connectors. Verified end-to-end by
the maintainer on a Plus account (no OAuth required). Mirrors the
shape of the existing claude.ai connector docs.

- New ## ChatGPT (Plus / Pro) section with 6-step add-connector flow
- New row in the "Pick your client" table (between Claude Desktop set
  and OpenAI API)
- New 4th bullet in the Privacy section explaining ChatGPT data flow

No code changes, no version bump. Worker is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Skip Tasks 10, 11, 12; jump to Task 9**

---

## Task 9: Push branch and open PR

**Files:** none (push + PR)

- [ ] **Step 1: Push the feature branch**

```bash
git push -u origin claude/chatgpt-connector
```
Expected: branch published, prints the GitHub URL for opening a PR.

- [ ] **Step 2: Open the PR with the body matching the active branch**

For **Branch A**:
```bash
gh pr create --base main --title "docs: ChatGPT (Plus / Pro) connector support" --body "$(cat <<'EOF'
## Summary

Documents the ChatGPT custom-Connector path for Plus and Pro users. Verified end-to-end by the maintainer (Plus account, no OAuth required, ChatGPT accepted the unauthenticated Worker URL and listed all 5 tools).

## What's added

- **README ## ChatGPT (Plus / Pro)** section with the 6-step add-Connector flow, parallel to the existing claude.ai connector docs.
- **"Pick your client" table** gets a row for ChatGPT, placed between Claude Desktop/Cursor/Windsurf/Zed and OpenAI API so paid-tier UI options group together.
- **Privacy section** gets a 4th bullet explaining ChatGPT data flow.

## What's NOT touched

- No code changes (Worker unchanged, no auth surface, no new tools).
- No version bump (stays at 0.3.0 per maintainer call).
- No OAuth implementation — not required for the Plus Connector flow.

## Test plan

- [x] Maintainer added the Worker URL as a custom connector on ChatGPT Plus and confirmed all 5 tools listed
- [x] Asked "What is MSU's hazing policy?" and got a grounded answer citing OP 91.208 with a `policies.msstate.edu` URL
- [x] `bash tools/security-checklist.sh | tail -1` → 192
- [x] No `dist/`, `worker/`, or `msstate-policies/src/` touched

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

For **Branch B**:
```bash
gh pr create --base main --title "docs: ChatGPT Connector access requires Pro/Business (Plus not verified)" --body "$(cat <<'EOF'
## Summary

Documents the finding from empirical testing on 2026-05-09: ChatGPT Plus does NOT expose a custom-Connector UI. Maintainer ruled out upgrading further to Pro ($200/mo) just to verify; the README now footnotes this so future visitors don't waste time looking for a Connector entry on Plus.

## What's added

A one-line footnote in the existing OpenAI API section pointing out the Plus-vs-Pro Connector situation.

## What's NOT done

- No `## ChatGPT (Plus / Pro)` section — would have been added if the Connector UI worked on Plus.
- No code changes, no version bump.

## Test plan

- [x] Maintainer confirmed Plus account does not have a custom-Connector UI (Settings has no "Connectors" / "Apps & Connectors" entry)
- [x] `bash tools/security-checklist.sh | tail -1` → 192

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

For **Branch C**:
```bash
gh pr create --base main --title "docs: ChatGPT Connector flow requires OAuth (deferred to follow-up spec)" --body "$(cat <<'EOF'
## Summary

Documents the finding from empirical testing on 2026-05-09: ChatGPT's custom-Connector setup requires OAuth 2.1 + DCR on the MCP server. The maintainer's Plus account rejected the Worker URL during the Add-Connector flow. OAuth implementation is a separate multi-week project (auth model, key issuance, abuse posture); this PR ships only the finding + a follow-up spec stub.

## What's added

- One-line footnote in README noting ChatGPT Connector support is pending OAuth work.
- New stub spec at `.dev/specs/2026-05-09-chatgpt-oauth-design.md` capturing scope for the future OAuth project.

## What's NOT done

- No OAuth implementation (deferred per maintainer call to "halt if OAuth required").
- No README ChatGPT-section, no version bump.

## Test plan

- [x] Maintainer confirmed Connector setup rejects the Worker URL with OAuth-related error
- [x] OAuth spec stub committed as a follow-up reference
- [x] `bash tools/security-checklist.sh | tail -1` → 192

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Pick the body matching whichever branch the maintainer's Task 3 report indicated.

- [ ] **Step 3: Print the PR URL for the maintainer**

The `gh pr create` command's last line prints the PR URL. Surface that URL in your final report.

- [ ] **Step 4: No additional commit**

Plan complete after this task.

---

## Task 10 (Branch B): One-line README footnote — Plus has no Connectors

**Files:**
- Modify: `README.md` (add footnote in the existing OpenAI API section)

- [ ] **Step 1: Insert footnote after the OpenAI API section's first paragraph**

`old_string`:
```markdown
ChatGPT Connectors are gated to Pro/Business/Enterprise plans. If you're on **free ChatGPT** — or you just prefer code — you can use this MCP server directly via OpenAI's Responses API and an OpenAI API key. The API is independent of your ChatGPT subscription tier; sign up at <https://platform.openai.com> and add a few dollars of credit (queries are typically a few cents each).
```

`new_string`:
```markdown
ChatGPT Connectors are gated to Pro/Business/Enterprise plans. If you're on **free ChatGPT** — or you just prefer code — you can use this MCP server directly via OpenAI's Responses API and an OpenAI API key. The API is independent of your ChatGPT subscription tier; sign up at <https://platform.openai.com> and add a few dollars of credit (queries are typically a few cents each).

> **Note (verified 2026-05-09):** ChatGPT **Plus** does NOT currently expose a custom-Connector UI either — the maintainer tested. Custom Connectors require **Pro / Business / Enterprise** as of this date. Plus users should use the Python sample below.
```

- [ ] **Step 2: Sanity check**

Run:
```bash
grep -n "verified 2026-05-09" README.md
```
Expected: exactly one match.

- [ ] **Step 3: Security checklist sanity**

```bash
bash tools/security-checklist.sh | tail -1
```
Expected: `192`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(README): note ChatGPT Plus has no Connector UI

Empirical finding from maintainer testing on 2026-05-09: ChatGPT
Plus does not expose a custom-Connector UI either. Custom Connectors
require Pro/Business/Enterprise. README now footnotes this so future
visitors on Plus don't go looking for a UI that isn't there.

Plus users are pointed at the Python (Responses API) path instead.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Skip Tasks 11, 12; jump to Task 9 (push + PR with Branch B body)**

---

## Task 11 (Branch C): One-line README footnote — OAuth required

**Files:**
- Modify: `README.md` (add footnote in the existing OpenAI API section)

- [ ] **Step 1: Insert footnote**

`old_string`:
```markdown
ChatGPT Connectors are gated to Pro/Business/Enterprise plans. If you're on **free ChatGPT** — or you just prefer code — you can use this MCP server directly via OpenAI's Responses API and an OpenAI API key. The API is independent of your ChatGPT subscription tier; sign up at <https://platform.openai.com> and add a few dollars of credit (queries are typically a few cents each).
```

`new_string`:
```markdown
ChatGPT Connectors are gated to Pro/Business/Enterprise plans. If you're on **free ChatGPT** — or you just prefer code — you can use this MCP server directly via OpenAI's Responses API and an OpenAI API key. The API is independent of your ChatGPT subscription tier; sign up at <https://platform.openai.com> and add a few dollars of credit (queries are typically a few cents each).

> **Note (2026-05-09):** ChatGPT's custom-Connector flow currently requires OAuth 2.1 on the MCP server, which this Worker does not implement. Connector support is deferred to a future release; until then, paid-plan ChatGPT users should use the Python (Responses API) path on this page.
```

- [ ] **Step 2: Sanity check**

```bash
grep -n "OAuth 2.1 on the MCP server" README.md
```
Expected: exactly one match.

- [ ] **Step 3: Commit (the README change only — the OAuth spec stub is a separate commit, Task 12)**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(README): note ChatGPT Connector requires OAuth (deferred)

Empirical finding from maintainer testing on 2026-05-09: ChatGPT's
custom-Connector setup rejected the Worker URL because it requires
OAuth 2.1 + DCR. README now footnotes this so paid-plan users know
to use the Responses API path until OAuth lands.

OAuth scope captured in a separate follow-up spec stub
(.dev/specs/2026-05-09-chatgpt-oauth-design.md).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Continue to Task 12**

---

## Task 12 (Branch C): Create OAuth follow-up spec stub

**Files:**
- Create: `.dev/specs/2026-05-09-chatgpt-oauth-design.md`

- [ ] **Step 1: Write the stub**

Use Write to create `.dev/specs/2026-05-09-chatgpt-oauth-design.md` with this exact content:

```markdown
# ChatGPT Connector OAuth — design (stub)

**Date:** 2026-05-09
**Status:** Stub (awaiting brainstorm)
**Trigger:** ChatGPT's custom-Connector setup requires OAuth 2.1 + DCR. Empirically verified by maintainer on 2026-05-09 against the deployed Worker.

## Problem

ChatGPT Plus/Pro users cannot add the deployed `msstate-policies` Worker as a custom Connector — the Connector flow rejects unauthenticated MCP server URLs. The Worker is currently anonymous public HTTP. Implementing OAuth would unlock the full ChatGPT-UI audience but is non-trivial.

## Open scope questions (for the future brainstorm)

- **Auth model:** OAuth 2.1 with Dynamic Client Registration (DCR), per the MCP spec (`2025-06-18` and later)? Or a simpler bearer-token model if ChatGPT accepts it?
- **Key issuance:** is this single-tenant (one shared key per user, manually issued) or multi-tenant (DCR creates per-client tokens)? Read-only public policy data argues for the simplest possible model.
- **Abuse posture:** the Worker is currently anonymous and rate-limited only by Cloudflare. Adding auth means reasoning about token rotation, revocation, and abuse beyond CF's defaults.
- **Backwards compatibility:** does adding OAuth to the Worker break the existing claude.ai connector flow or the existing OpenAI Responses API + MCP-tool path? (Probably not — both should be able to send a token — but worth confirming.)
- **Verified-publisher status:** does ChatGPT require a verified publisher in addition to OAuth? If yes, this turns into a much larger publishing project.
- **Rollout:** can we deploy a separate `*.workers.dev` URL with OAuth (e.g. `msstate-policies-mcp-auth.workers.dev/mcp`) so the existing anonymous URL keeps working for Anthropic/API clients, and only ChatGPT users hit the OAuth one? Or is one-server-with-optional-auth simpler?

## Why this is its own project

OAuth implementation has its own threat model, its own abuse surface, its own user-onboarding flow, and its own ongoing maintenance burden (token revocation, etc.). The OpenAI-API project (2026-05-08) explicitly deferred OAuth as "its own brainstorm." That call still stands.

## Next step

Run `superpowers:brainstorming` against this stub when ChatGPT-Connector-via-OAuth becomes a priority. The brainstorm should turn each "open scope question" above into a yes/no decision before writing a real spec.
```

- [ ] **Step 2: Commit the stub**

```bash
git add .dev/specs/2026-05-09-chatgpt-oauth-design.md
git commit -m "$(cat <<'EOF'
docs: add OAuth follow-up stub for future ChatGPT Connector work

Captures the scope of the OAuth project that will unlock ChatGPT
custom Connectors for paid users. Stub only — not a real spec yet.
The full brainstorm + spec will run when OAuth becomes a priority.

Created in response to the 2026-05-09 finding that ChatGPT's
Connector flow requires OAuth, which the Worker does not implement.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Continue to Task 9 (push + PR with Branch C body)**

---

## Acceptance criteria recap (from spec)

This plan is "done" when ONE of these is true:

1. **Branch A success:** A PR is open against `main` adding the `## ChatGPT (Plus / Pro)` README section, the new client-table row, and the 4th privacy bullet. Maintainer has confirmed end-to-end via a real policy question on Plus.
2. **Branch B halt:** A PR is open adding a single footnote to the README's OpenAI API section noting Plus has no Connector UI.
3. **Branch C halt:** A PR is open adding a single footnote to the README PLUS a new OAuth follow-up spec stub at `.dev/specs/2026-05-09-chatgpt-oauth-design.md`.

In all branches:
- `bash tools/security-checklist.sh | tail -1` still prints **192**.
- No source code, `dist/`, `worker/`, or `msstate-policies/src/` is touched.
- Version stays at **0.3.0**.

## What this plan does NOT do (deferred per spec)

- OAuth 2.1 + DCR (Branch C trigger, separate future spec)
- Custom GPTs / OpenAPI Actions
- ChatGPT Apps SDK research
- Free-tier ChatGPT user reach (architecturally impossible without Custom GPT)
- Worker code changes
- Eval JSON regeneration (protocol layer already verified by Tier 1 + the existing 10-question gpt-4o eval)

If any of these turn out to be required during execution, **halt and re-brainstorm** rather than expanding scope inside this plan.
