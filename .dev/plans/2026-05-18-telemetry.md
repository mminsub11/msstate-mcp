# Worker Telemetry + Privacy Policy — Plan

**Date:** 2026-05-18
**Goal:** Add anonymous aggregate usage telemetry to the Cloudflare Worker so we can answer "is anyone using this?" without compromising the zero-PII contract. Ship the corresponding privacy policy.

**Why now:** Four versions shipped, zero usage signal. Per the multi-perspective evaluation, this is the highest-leverage missing piece before any next-tool decision.

---

## 0. Design decisions (defaults set — override if needed)

| # | Decision | Default | Rationale |
|---|---|---|---|
| D1 | Telemetry backend | **Cloudflare Workers Analytics Engine** (AE) | Free up to 25 events/sec/script and ~10M events/month. Designed for exactly this. SQL queryable. No external dependency. |
| D2 | What to record per request | `(date, tool_name, ok, country)` | Minimum signal that answers "any users?" + "which tools matter?" + rough geography (US-only would be a finding). No IPs, no payloads, no user identifiers, no timestamps below day granularity. |
| D3 | How we view the data | Cloudflare dashboard SQL queries + a `scripts/telemetry-summary.mjs` helper | Private viewer. No public dashboard. Optional later: a maintainer-only monthly summary committed to the repo (e.g., `.dev/telemetry/2026-06.md`). |
| D4 | Privacy doc shape | **New `PRIVACY.md` at repo root + cross-reference from `SECURITY.md` and `README.md`** | Telemetry adds a real data-collection surface; deserves its own document, not buried in security. |
| D5 | Opt-out mechanism | **Server-side flag `TELEMETRY_DISABLED=1`** environment var; per-request opt-out is impossible because the recording happens server-side. Document this clearly. | The MCP protocol has no client opt-out hook for anonymous server-side aggregate counts. The recording IS the product's analytics. Honest framing: "if you use the Worker, anonymous aggregate counts are recorded; if that's not acceptable, use the npm/plugin install which records nothing." |
| D6 | When to record | **Before request execution + after.** Two events per call: `request_received` (with tool_name) and `request_completed` (with ok). Lets us measure error rates AND see incoming traffic even when tools throw. | Both events are still aggregate-only. |

---

## 1. Architecture

```
                                        ┌──────────────────────────┐
   POST /mcp tools/call get_msu_date   │  Cloudflare Worker /mcp  │
   ──────────────────────────────────►│  src/index.ts            │
                                        │                          │
                                        │  ┌────────────────────┐  │
                                        │  │ recordEvent(...)   │  │
                                        │  │ writeDataPoint     │  │
                                        │  │   blobs: [tool]    │  │
                                        │  │   doubles: [ok]    │  │
                                        │  │   indexes: [dateKey]│ │
                                        │  └─────────┬──────────┘  │
                                        │            │             │
                                        │  ┌─────────▼──────────┐  │
                                        │  │ existing dispatch  │  │
                                        │  └────────────────────┘  │
                                        └──────────────────────────┘
                                                     │
                                                     ▼
                                       ┌────────────────────────────┐
                                       │ Cloudflare Analytics Engine│
                                       │ dataset: msstate_mcp_events│
                                       │                            │
                                       │ Query via SQL API:         │
                                       │   SELECT date, tool, count │
                                       │   FROM dataset GROUP BY ...│
                                       └────────────────────────────┘
```

Key invariants:
- `request.cf.country` is read but only the country code is written (already aggregated at the CF edge — no IP at the Worker).
- No payload bytes are recorded.
- No timestamps below day granularity (`date` = `YYYY-MM-DD` UTC).
- No user-agent / session / cookies.

---

## 2. Implementation tasks

### Task 1 — wrangler.toml + AE binding

**Files:**
- Modify: `worker/wrangler.toml`

Add:

```toml
[[analytics_engine_datasets]]
binding = "TELEMETRY"
dataset = "msstate_mcp_events"
```

This makes `env.TELEMETRY` available in the Worker handler.

### Task 2 — Worker recording helper

**Files:**
- Modify: `worker/src/index.ts`

Add a single helper near the top (after the existing constant declarations):

```typescript
interface TelemetryEnv {
  TELEMETRY?: {
    writeDataPoint: (data: {
      blobs?: string[];
      doubles?: number[];
      indexes?: string[];
    }) => void;
  };
  TELEMETRY_DISABLED?: string;
}

function recordEvent(
  env: TelemetryEnv,
  request: Request,
  phase: "received" | "completed",
  toolName: string,
  ok: boolean,
): void {
  if (env.TELEMETRY_DISABLED === "1") return;
  if (!env.TELEMETRY) return;
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? "??";
  try {
    env.TELEMETRY.writeDataPoint({
      blobs: [phase, toolName, country],
      doubles: [ok ? 1 : 0],
      indexes: [date],
    });
  } catch {
    // Telemetry failure is never propagated — recording is best-effort.
  }
}
```

Then thread `env` through the request handler (Workers signature change) and call:
- `recordEvent(env, request, "received", toolName, true)` immediately after parsing the tools/call request, before dispatch.
- `recordEvent(env, request, "completed", toolName, ok)` after dispatch returns, with `ok = !response.error`.

### Task 3 — Helper script for maintainer queries

**Files:**
- Create: `scripts/telemetry-summary.mjs`

```javascript
#!/usr/bin/env node
/**
 * Query the Worker telemetry Analytics Engine dataset and print a daily summary.
 *
 * Requires CLOUDFLARE_API_TOKEN with "Analytics Engine: Read" + account ID.
 * Set CF_ACCOUNT_ID in .env.
 *
 * Usage:
 *   node scripts/telemetry-summary.mjs              # last 7 days
 *   node scripts/telemetry-summary.mjs --days 30    # last 30 days
 *   node scripts/telemetry-summary.mjs --by-tool    # per-tool histogram
 */
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
if (!TOKEN || !ACCOUNT) {
  console.error("Set CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID");
  process.exit(1);
}

const days = parseInt(process.argv.includes("--days") ? process.argv[process.argv.indexOf("--days") + 1] : "7", 10);
const byTool = process.argv.includes("--by-tool");

const sql = byTool
  ? `SELECT blob2 AS tool, count() AS calls
     FROM msstate_mcp_events
     WHERE blob1 = 'completed' AND timestamp >= NOW() - INTERVAL '${days}' DAY
     GROUP BY tool ORDER BY calls DESC FORMAT JSON`
  : `SELECT toDate(timestamp) AS day, count() AS calls
     FROM msstate_mcp_events
     WHERE blob1 = 'completed' AND timestamp >= NOW() - INTERVAL '${days}' DAY
     GROUP BY day ORDER BY day FORMAT JSON`;

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/sql" },
    body: sql,
  },
);
const data = await res.json();
console.log(JSON.stringify(data.data ?? data, null, 2));
```

### Task 4 — `PRIVACY.md` at repo root

**Files:**
- Create: `PRIVACY.md`

Full draft below in §5.

### Task 5 — Cross-references

**Files:**
- Modify: `README.md` — add a "Privacy" link near the top
- Modify: `SECURITY.md` — add a one-line pointer to `PRIVACY.md` in the in-scope/out-of-scope section
- Modify: `CLAUDE.md` — add a one-line note in the security section that telemetry is anonymous-aggregate only

### Task 6 — Deploy + verify

```bash
cd worker && npx --no-install wrangler deploy
curl -sS -X POST "https://msstate-policies-mcp.mminsub90.workers.dev/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' > /dev/null
sleep 60  # AE has a short ingest delay
node scripts/telemetry-summary.mjs --days 1
```

Expected: see at least 1 event in the dataset.

### Task 7 — Version bump + release

`1.1.2 → 1.1.3` patch. Same release flow as v1.1.2:
- `sed` 4 sites
- `npm run build`
- Commit
- Push, PR, CI, merge
- npm publish, wrangler deploy, tag

---

## 3. Privacy invariants (load-bearing — security-checklist enforces)

For the static checklist, add `TEL1`–`TEL3`:

| Check | Pts | Asserts |
|---|---|---|
| TEL1 | 2 | `recordEvent` exists in worker source AND never references `request.headers.get` (no header capture) |
| TEL2 | 2 | `wrangler.toml` declares the analytics_engine_datasets binding |
| TEL3 | 2 | `PRIVACY.md` exists at repo root |

These cement the privacy contract mechanically. +6 pts; new security baseline **290**.

---

## 4. Failure modes + edge cases

| Failure | Handling |
|---|---|
| AE write fails | Wrapped in try/catch; never propagates |
| User sends garbage to /mcp | Tool name is "unknown"; phase is "received" only |
| Cloudflare quota exceeded | We'd see this in CF dashboard before users do; AE silently drops events past the limit (free tier 10M/month is ~330k/day — well above our worst-case) |
| Country header missing | Falls back to "??" |
| Worker error before recording starts | No telemetry; we see request count = 0 for that period even if users hit the endpoint. Acceptable. |

---

## 5. PRIVACY.md draft

```markdown
# Privacy

**Last updated:** 2026-05-18 (v1.1.3+)

msstate-mcp is operated as an unofficial, open-source utility. This document
describes exactly what data the project collects, why, where it's stored, and
how to opt out. If any item below is more invasive than you're comfortable
with, the npm/plugin install records nothing — see §3.

---

## 1. What we collect (and what we don't)

The Cloudflare Worker at `https://msstate-policies-mcp.mminsub90.workers.dev/mcp`
records **anonymous aggregate** telemetry. Every tool call writes one or two
data points to Cloudflare Workers Analytics Engine:

**Recorded per request:**
| Field | Example | Why |
|---|---|---|
| date | `2026-05-18` (UTC, day granularity only) | To compute daily request counts |
| tool name | `find_msu_date` | To see which tools matter |
| outcome | `1` (success) or `0` (error) | To detect breakage |
| country | `US`, `CA`, `??` | To detect if anyone outside the US uses it |
| phase | `received` or `completed` | To distinguish "did request arrive" from "did it succeed" |

**Explicitly NOT recorded:**
- The query string / question content
- IP addresses (the country is derived at the Cloudflare edge before the
  Worker sees it; the IP itself never reaches our code)
- User agents
- Session or cookie data
- Sub-day timestamps
- Response bodies
- Anything that could identify a person or a single user across requests

No personal data is ever stored or transmitted to third parties beyond
Cloudflare itself.

## 2. Why we collect it

We need to know whether anyone is using the Worker. Without aggregate
counts, every product decision (which tool to build next, whether to keep
maintaining the project, whether to invest in distribution) is speculation.
The minimum signal that answers "is this useful to anyone?" is the daily
request count by tool — and that's exactly what we record.

We do NOT use telemetry for:
- Advertising or marketing
- Selling data to anyone
- Personalization
- A/B testing
- User profiles

## 3. Surfaces and what each one records

| Surface | What it records | How to use without telemetry |
|---|---|---|
| **Cloudflare Worker** (claude.ai / ChatGPT connectors) | Anonymous aggregate only (above) | Use a different surface (npm or plugin) |
| **npm `msstate-policies-mcp`** (npx, Claude Code plugin) | **Nothing.** The bundle runs entirely on your machine; no outbound calls to us. | Already private. |

If you use the Worker, you generate one or two aggregate events. If you use
the npm bundle, you generate zero. The choice is yours.

## 4. Data retention

Cloudflare Workers Analytics Engine retains events for the duration of the
plan's retention policy (currently 90 days for the free tier; up to 90 days
on paid). We do not export or back up event data; when CF rotates it out,
it's gone.

## 5. Who can see the data

Only the project maintainer (currently mminsub90) — via the Cloudflare
dashboard or the `scripts/telemetry-summary.mjs` helper. The data is not
shared with MSU, third parties, or the public. If you'd like to see a
snapshot of aggregate counts, file an issue and we can publish a redacted
summary.

## 6. Opt-out

Per-request opt-out is not technically possible for anonymous aggregate
server-side counts — there is no header or flag a client can send to
prevent the Worker from incrementing a counter, because the increment
happens server-side before the client's preferences are read.

If telemetry of any kind is unacceptable to you, **use the npm install or
the Claude Code plugin**. Those record nothing.

## 7. What changes trigger a privacy-policy update

We commit to revising this document and bumping its "Last updated" date
whenever any of the following changes:
- The set of recorded fields
- The data retention period
- The list of people with access
- The list of third parties involved
- The opt-out story

The document is in version control. The full history is at
`https://github.com/3uLLd0gs/msstate-mcp/commits/main/PRIVACY.md`.

## 8. Out of scope

Two things this policy explicitly does NOT cover:

- **Your MCP client's behavior.** Claude.ai, ChatGPT, Cursor, Windsurf, Zed,
  Claude Code, etc. each have their own privacy policies. They may log your
  prompts. That's between you and them.
- **MSU's own privacy practices.** When you ask a question that triggers a
  tool call, we serve a cached snapshot of msstate.edu content. We do not
  contact MSU at request time. MSU's own privacy practices apply to anything
  you do directly with their sites.

## 9. Contact

Privacy questions: open a public issue at
`https://github.com/3uLLd0gs/msstate-mcp/issues`. For anything sensitive,
use the GitHub Security Advisory flow described in `SECURITY.md`.
```

---

## 6. Self-review

**Spec coverage:**
- Telemetry backend: D1 + Task 1 + Task 2 ✓
- What's recorded: D2 + Task 2 + PRIVACY.md §1 ✓
- How to view it: D3 + Task 3 ✓
- Privacy doc: D4 + Task 4 + PRIVACY.md draft ✓
- Opt-out: D5 + PRIVACY.md §6 ✓
- Phase: D6 + Task 2 ✓

**Placeholder scan:** no TBD / TODO / fill in details.

**Type consistency:** `recordEvent` signature matches in all three references (Task 2, TEL1 check, draft).

**Scope check:** single module, single Worker change, two new files, four MD edits. Right-sized for v1.1.3 patch.

---

## 7. Open questions before I start

| Q | Default |
|---|---|
| Cloudflare account ID — do you have one already, or new free account? | Existing (we deploy the Worker already; same account) |
| Is the "country = US-only finding" worth recording? Could omit for stricter privacy. | Record it. Geographic narrowing is one of the strategic-decision signals. |
| Should `scripts/telemetry-summary.mjs` be a private one-off or tracked in repo? | Tracked. No secrets in the script itself; access requires CF_ACCOUNT_ID + token in .env. |
| Should we commit monthly aggregate snapshots back to the repo (e.g., `.dev/telemetry/2026-06.md`)? | Optional. Decide after we see a month of data. |

---

If the defaults look right, I'll execute the 7 tasks straight through.
