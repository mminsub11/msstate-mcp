# Privacy

**Last updated:** 2026-05-18 (v1.2.0+)

msstate-mcp is operated as an unofficial, open-source utility. This document describes exactly what data the project collects, why, where it's stored, and how to opt out. If any item below is more invasive than you're comfortable with, the npm/plugin install records nothing — see §3.

---

## 1. What we collect (and what we don't)

The Cloudflare Worker at `https://msstate-policies-mcp.mminsub90.workers.dev/mcp` records **anonymous aggregate** telemetry into Cloudflare Workers Analytics Engine. **One event per tool call**, recorded after the dispatch returns:

**Recorded:**

| Field | Example | Why |
|---|---|---|
| date | `2026-05-18` (UTC, day granularity only) | Daily request counts |
| tool name | `find_msu_date` | Which tools matter (allowlisted to the 25 known names; anything else is recorded as `[unknown]`) |
| outcome | `1` (success) or `0` (error) | Detect breakage |
| country bucket | `US`, `NA-other`, `EU`, `Other`, `??` | Rough geographic signal — **bucketed, never raw country code**. Raw country at small volumes is a quasi-identifier. |

**Explicitly NOT recorded:**

- The query string or question content
- Response bodies or response sizes
- IP addresses (Cloudflare's edge derives the country code from the IP before the Worker runs; the IP itself never reaches our code)
- User agents
- Session, cookie, or fingerprint data
- Sub-day timestamps
- Anything that could identify a person or a single user across requests

**Caveats on the country signal:**

- The country code from `request.cf.country` is best-effort, derived by Cloudflare from the request IP at the edge. VPN / proxy / mobile-carrier routing can make the signal inaccurate. We treat it as a rough geographic narrowing tool, not authoritative.
- The `EU` bucket includes `GB` (post-Brexit) as a deliberate privacy-bucketing choice — collapsing UK into EU prevents `GB` from becoming its own small-volume bucket that could quasi-identify single users. This is a categorization decision, not a factual claim about EU membership.

**k-anonymity in query output:**

When the maintainer queries the dataset via `scripts/telemetry-summary.mjs`, the query enforces `HAVING calls >= 5` — cells with fewer than 5 events in the window are suppressed entirely. Combined with the bucketed country and the limited blob fields, this prevents any aggregate output from pinpointing a single user.

No personal data is ever stored or transmitted to third parties beyond Cloudflare itself.

---

## 2. Why we collect it

We need to know whether anyone is using the Worker. Without aggregate counts, every product decision (which tool to build next, whether to keep maintaining the project, whether to invest in distribution) is speculation. The minimum signal that answers "is this useful to anyone?" is the daily request count by tool — and that's exactly what we record.

We do NOT use telemetry for:

- Advertising or marketing
- Selling data to anyone
- Personalization or A/B testing
- User profiles
- Any user-tied analysis (it's impossible — we don't have user IDs)

---

## 3. Surfaces and what each one records

| Surface | What it records | How to use without telemetry |
|---|---|---|
| **Cloudflare Worker** (claude.ai / ChatGPT connectors, custom MCP clients pointed at our URL) | Anonymous aggregate only (see §1) | Use a different surface (npm or plugin) |
| **npm `msstate-policies-mcp`** (`npx msstate-policies-mcp`, Claude Code plugin) | **Nothing.** The bundle runs entirely on your machine; no outbound calls to us. | Already private. |

If you use the Worker, you generate one aggregate event per tool call. If you use the npm bundle, you generate zero. The choice is yours.

---

## 4. Data retention

Cloudflare Workers Analytics Engine retains events per Cloudflare's plan policy — currently up to 90 days on free and paid tiers as of 2026-05. We do not export or back up event data; when Cloudflare rotates it out, it's gone.

If Cloudflare changes its retention policy, we will update this section and the "Last updated" date above. The change history is in version control.

---

## 5. Who can see the data

Only the project maintainer (currently @mminsub90 on GitHub) — via the Cloudflare dashboard or the `scripts/telemetry-summary.mjs` helper. The data is not shared with:

- Mississippi State University
- Any third party beyond Cloudflare itself
- The public (no public dashboard, no API endpoint)
- Other contributors (the maintainer holds the Cloudflare account credentials)

If you'd like to see a snapshot of aggregate counts, file an issue at https://github.com/3uLLd0gs/msstate-mcp/issues and we can publish a redacted summary that respects k-anonymity (N≥5 in every cell).

---

## 6. Opt-out

**Per-request opt-out is not technically possible** for anonymous aggregate server-side counts. There is no header or flag a client can send to prevent the Worker from incrementing a counter, because the increment happens server-side before any client-supplied preferences are read.

If telemetry of any kind is unacceptable to you, **use the npm install or the Claude Code plugin instead**. Those record nothing — your tool calls happen entirely on your machine and the only network calls are to msstate.edu sources at build time (not at request time).

**For maintainers of forks:** the Worker honors a server-side environment variable `TELEMETRY_DISABLED=1`. Set it via `wrangler` or the Cloudflare dashboard to disable recording entirely on your deployment. The code path:

```
if (env.TELEMETRY_DISABLED === "1") return;  // first executable line in recordEvent()
```

This is documented in `worker/wrangler.toml` and verifiable in `worker/src/index.ts`.

---

## 7. What changes trigger a privacy-policy update

We commit to revising this document and bumping its "Last updated" date whenever any of these change:

- The set of recorded fields
- The data retention period (including changes to Cloudflare's policy that our doc cites)
- The list of people with access
- The list of third parties involved
- The opt-out story
- The country-bucket scheme (e.g., adding new buckets or returning to raw country codes — both would be policy-update events)
- The k-anonymity threshold in our query helper

The full revision history is at https://github.com/3uLLd0gs/msstate-mcp/commits/main/PRIVACY.md.

---

## 8. Out of scope

Two things this policy explicitly does NOT cover:

- **Your MCP client's behavior.** claude.ai, ChatGPT, Cursor, Windsurf, Zed, Claude Code, etc. each have their own privacy policies. They may log your prompts, your tool calls, your model outputs. That's between you and them.
- **MSU's own privacy practices.** When you ask a question that triggers a tool call, we serve a cached snapshot of msstate.edu content. We do not contact MSU at request time. MSU's own privacy practices apply to anything you do directly with their sites.

---

## 9. Contact

Privacy questions: open a public issue at https://github.com/3uLLd0gs/msstate-mcp/issues.

For anything sensitive, use the GitHub Security Advisory flow described in [SECURITY.md](SECURITY.md).
