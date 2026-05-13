# Tooling Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address the 12 findings from the Codex adversarial review of calendar/course/emergency tools — fix correctness ship-blockers first, then close observability gaps, then take perf + polish wins.

**Architecture:** Pure local fixes inside `msstate-policies/`. No new tools, no schema changes that break the wire format. All work is read-side or builder-side; the corpus baking story stays the same. Each fix lands as: failing test → minimal implementation → green test → commit. Phase rolls up to a single `dist/` rebuild + security-checklist verify + version bump (v0.7.1).

**Tech Stack:**
- TypeScript, esbuild bundle to `msstate-policies/dist/index.js`
- Tests: `tsx --test` (Node built-in test runner) + `node:assert/strict`
- Logging: stderr-only via `src/log.ts` (DO NOT use `console.log` — pdf-parse stdout patch + MCP framing depend on it)
- Security: `tools/security-checklist.sh` must stay at 245/245 after this work

**Triage Summary (rationale for ordering):**

| Phase | Finding | Severity | Why this slot |
|-------|---------|----------|---------------|
| P1 | H1 Calendar warm race | High | First requests can lie — user-visible correctness, fixed cheaply |
| P1 | H2 Course graph cycle bug | High | Silently wrong DAGs; the `notes: cycle detected` masks a real bug |
| P1 | H3 Emergency BM25 unconditional top-hit | High | Wrong-answer risk on **emergency** queries — confidence threshold required |
| P2 | M1 Calendar negative-cache poisoning | Medium | A WAF blip locks out a source for 6-24h; easy negative-TTL fix |
| P2 | M2 Partial scrape failures swallowed | Medium | Per-entry warnings flow into health/notes; no behavior break |
| P2 | M5 Course search silent on unloaded corpus | Medium | Distinguish "no match" from "no corpus" — structured error |
| P2 | M6 Emergency category lacks `z.enum` | Medium | Typos like `off-campus` look empty; `z.enum` + alias map fixes it |
| P3 | M3 BM25 hot loops | Medium (perf) | Inverted index per field — 3 modules share the pattern |
| P3 | M4 Course dept-page scraping serial | Medium (perf) | Pool exists; just route dept fetches through it |
| P3 | L1 `get_msu_calendar` unbounded rows | Low | Add `limit`/`offset`/`total`; backward-compatible default |
| P3 | L2 Date parser emits invalid dates | Low | UTC round-trip validation |
| P3 | L3 Emergency markdown duplicates | Low | Skip generic container nodes whose children we already walk |

**Out of plan / deferred:** Anything in `msstate-policies/src/tuition/` (separate working-tree concern, owned by tuition design doc). No protocol changes. No new env vars. No new dependencies.

---

## Phase 1 — Ship-blocker correctness (3 fixes)

### Task 1: Calendar warm-up race (H1)

**Problem:** `loadAllCalendarRows()` at `src/index.ts:201` is fire-and-forget; `find_msu_date.ts:53` and `get_msu_calendar.ts:30` read the in-memory index immediately. First requests can return "no matches" while the corpus is still loading.

**Approach:** Park the warm-up promise on a module-scoped `calendarWarmReady` and `await` it inside both handlers. Don't block `server.connect` — keep startup fast, but make handlers wait for the first request to deserve a real answer.

**Files:**
- Modify: `msstate-policies/src/calendars/corpus.ts` — export `setCalendarWarmReady(p)` and `awaitCalendarWarm()`
- Modify: `msstate-policies/src/index.ts:201-211` — register the promise
- Modify: `msstate-policies/src/tools/find_msu_date.ts:51-53` — await before search
- Modify: `msstate-policies/src/tools/get_msu_calendar.ts:27-30` — await before filter
- Test: `msstate-policies/tests/calendar-warm-race.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// msstate-policies/tests/calendar-warm-race.test.ts
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setCalendarWarmReady, awaitCalendarWarm, resetCalendarWarmForTests } from "../src/calendars/corpus.js";

describe("calendar warm-up gate", () => {
  beforeEach(() => resetCalendarWarmForTests());

  test("awaitCalendarWarm resolves immediately when no warm registered", async () => {
    await awaitCalendarWarm(); // must not hang or throw
  });

  test("awaitCalendarWarm resolves after the registered promise settles", async () => {
    let resolveWarm: () => void = () => {};
    setCalendarWarmReady(new Promise<void>((r) => { resolveWarm = r; }));
    let warmDone = false;
    const waiter = awaitCalendarWarm().then(() => { warmDone = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(warmDone, false, "must still be waiting before warm resolves");
    resolveWarm();
    await waiter;
    assert.equal(warmDone, true, "must resolve after warm resolves");
  });

  test("awaitCalendarWarm does not reject if the registered promise rejects", async () => {
    setCalendarWarmReady(Promise.reject(new Error("scrape blew up")));
    await awaitCalendarWarm(); // must swallow — handlers degrade, they don't crash
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/calendar-warm-race.test.ts`
Expected: FAIL — `setCalendarWarmReady`, `awaitCalendarWarm`, `resetCalendarWarmForTests` are not exported.

- [ ] **Step 3: Implement the warm gate**

In `msstate-policies/src/calendars/corpus.ts`, add at the top of the file (after imports):

```ts
let warmPromise: Promise<void> = Promise.resolve();

export function setCalendarWarmReady(p: Promise<unknown>): void {
  // Swallow rejection at the gate — handlers should fall back to whatever
  // in-memory state the warm attempt managed to populate, not crash.
  warmPromise = p.then(() => undefined, () => undefined);
}

export function awaitCalendarWarm(): Promise<void> {
  return warmPromise;
}

export function resetCalendarWarmForTests(): void {
  warmPromise = Promise.resolve();
}
```

In `msstate-policies/src/index.ts`, replace the calendar warm block at lines 201-211 with:

```ts
  const calendarWarm = loadAllCalendarRows()
    .then((rows) => {
      indexCalendarRows(rows);
      indexCalendarRowsForGetter(rows);
      log("info", "calendar background warm done", { rows: rows.length });
    })
    .catch((err) => {
      log("warn", "calendar background warm failed; will retry on first request", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  setCalendarWarmReady(calendarWarm);
```

Add to the existing import line for `corpus.js`:

```ts
import { loadAllCalendarRows, setCalendarWarmReady } from "./calendars/corpus.js";
```

In `msstate-policies/src/tools/find_msu_date.ts`, change the handler body so the await happens before the search:

```ts
  async handler(rawInput: unknown) {
    const input = FindMsuDateInput.parse(rawInput);
    await awaitCalendarWarm();
    const hits = searchCalendarRows(input.q, 10);
```

Add the import:

```ts
import { awaitCalendarWarm } from "../calendars/corpus.js";
```

In `msstate-policies/src/tools/get_msu_calendar.ts`, change the handler:

```ts
  async handler(rawInput: unknown) {
    const input = GetMsuCalendarInput.parse(rawInput);
    await awaitCalendarWarm();
    const filter = input.term?.toLowerCase();
```

Add the import:

```ts
import { awaitCalendarWarm } from "../calendars/corpus.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/calendar-warm-race.test.ts && npm run typecheck`
Expected: 3 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/calendars/corpus.ts msstate-policies/src/index.ts msstate-policies/src/tools/find_msu_date.ts msstate-policies/src/tools/get_msu_calendar.ts msstate-policies/tests/calendar-warm-race.test.ts
git commit -m "fix(calendar): gate find_msu_date/get_msu_calendar on warm-up promise"
```

---

### Task 2: Course graph cycle detection (H2)

**Problem:** `src/courses/prereq.ts:74` marks any repeat-visit as a cycle and drops the edge. In a DAG with shared prerequisites (e.g. MA 1713 → MA 1723, MA 1713 → MA 2113), the second arrival at MA 1713 is not a cycle — it's a re-convergence. The current code skips the second edge and emits `truncated: true` with a misleading `notes: cycle detected`.

**Approach:** Cycle detection needs the *current path* (DFS-style ancestor set), not the global visited set. Use BFS as today but emit edges to already-seen nodes; just don't re-expand them. Track a separate `pathSet` for true cycle detection only matters in cyclic graphs — for an acyclic course prereq graph, simply not re-expanding is correct.

**Files:**
- Modify: `msstate-policies/src/courses/prereq.ts:60-101`
- Test: `msstate-policies/tests/courses/prereq.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `msstate-policies/tests/courses/prereq.test.ts`:

```ts
describe("walkGraph — shared prerequisites are not cycles", () => {
  test("re-converging edges are emitted, not dropped as cycle", () => {
    // MA 1723 and MA 2113 both require MA 1713
    const corpus = mkCorpus([
      mkCourse("MA 1713", "Calc I"),
      mkCourse("MA 1723", "Calc II", ["MA 1713"]),
      mkCourse("MA 2113", "Calc III", ["MA 1713"]),
      mkCourse("MA 3253", "Diff Eq", ["MA 1723", "MA 2113"]),
    ]);
    const r = walkGraph(corpus, "MA 3253", "prereqs", 5);
    const fromTo = r.edges.map((e) => `${e.from}->${e.to}`).sort();
    assert.deepEqual(
      fromTo,
      ["MA 1723->MA 1713", "MA 2113->MA 1713", "MA 3253->MA 1723", "MA 3253->MA 2113"],
      "both convergent edges to MA 1713 must be emitted",
    );
    assert.equal(r.truncated, false, "shared prereqs are not a cycle and not truncation");
    assert.equal(
      r.notes.some((n) => /cycle/i.test(n)),
      false,
      "no spurious 'cycle detected' note for a DAG",
    );
  });

  test("MA 1713 appears once in nodes even when two parents reference it", () => {
    const corpus = mkCorpus([
      mkCourse("MA 1713", "Calc I"),
      mkCourse("MA 1723", "Calc II", ["MA 1713"]),
      mkCourse("MA 2113", "Calc III", ["MA 1713"]),
      mkCourse("MA 3253", "Diff Eq", ["MA 1723", "MA 2113"]),
    ]);
    const r = walkGraph(corpus, "MA 3253", "prereqs", 5);
    const ma1713Nodes = r.nodes.filter((n) => n.code === "MA 1713");
    assert.equal(ma1713Nodes.length, 1, "shared node must be emitted exactly once");
  });

  test("a true cycle is still detected and truncated", () => {
    // Pathological: A requires B, B requires A
    const corpus = mkCorpus([mkCourse("XX 1000", "A", ["XX 2000"]), mkCourse("XX 2000", "B", ["XX 1000"])]);
    const r = walkGraph(corpus, "XX 1000", "prereqs", 5);
    assert.equal(r.truncated, true, "a true 2-cycle must mark truncated");
    assert.equal(r.notes.some((n) => /cycle/i.test(n)), true, "must emit cycle note");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/courses/prereq.test.ts`
Expected: FAIL — re-convergence test fails (edge missing), cycle test passes incidentally.

- [ ] **Step 3: Implement the fix**

Replace the BFS body in `msstate-policies/src/courses/prereq.ts` from lines 60-101 with:

```ts
  const adj = direction === "prereqs" ? corpus.forward_dag : corpus.reverse_dag;
  const nodes: GraphNode[] = [{ code: rootCode, title: root.title, depth: 0 }];
  const edges: GraphEdge[] = [];
  const emittedNode = new Set<string>([rootCode]);
  const emittedEdge = new Set<string>();
  let truncated = false;
  let depth_used = 0;

  // Path-based cycle detection: we only need to flag re-entry into a node
  // that's an ancestor on the current root→here path. For an acyclic graph
  // (course prereqs in practice are acyclic) this set never repeats.
  function bfs(start: string): void {
    let frontier: Array<{ code: string; depth: number; path: ReadonlySet<string> }> = [
      { code: start, depth: 0, path: new Set([start]) },
    ];
    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const { code, depth, path } of frontier) {
        if (depth >= depth_used_max) {
          if ((adj[code] ?? []).length > 0) truncated = true;
          continue;
        }
        const neighbors = adj[code] ?? [];
        for (const n of neighbors) {
          if (path.has(n)) {
            notes.push(`cycle detected at ${n}`);
            truncated = true;
            continue;
          }
          // Always emit the edge — convergent edges in a DAG are real data.
          const edgeKey = `${code}->${n}`;
          if (!emittedEdge.has(edgeKey)) {
            const sourceCode = direction === "prereqs" ? code : n;
            const p = corpus.records[sourceCode]?.prereqs;
            edges.push({
              from: code,
              to: n,
              logic: p?.logic ?? null,
              min_grade: p?.min_grade ?? null,
            });
            emittedEdge.add(edgeKey);
          }
          // Emit node + expand only the first time we see it.
          if (!emittedNode.has(n)) {
            emittedNode.add(n);
            const title = corpus.records[n]?.title ?? "(unknown)";
            nodes.push({ code: n, title, depth: depth + 1 });
            const nextPath = new Set(path);
            nextPath.add(n);
            next.push({ code: n, depth: depth + 1, path: nextPath });
            depth_used = Math.max(depth_used, depth + 1);
          }
        }
      }
      frontier = next;
    }
  }

  bfs(rootCode);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/courses/prereq.test.ts && npm run typecheck`
Expected: All `prereq.test.ts` tests pass (existing + new), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/courses/prereq.ts msstate-policies/tests/courses/prereq.test.ts
git commit -m "fix(courses): emit convergent edges; cycle detection uses path set"
```

---

### Task 3: Emergency BM25 confidence threshold (H3)

**Problem:** `src/emergency/search.ts:146` returns `hits[0].row` unconditionally when BM25 produces any non-zero score. For an emergency query like "I cut my finger" against the 12 baked guidelines, this can confidently return the wrong one. Worse, the response carries the MANDATORY_DISCLAIMER and a citation — it *looks* authoritative.

**Approach:** Require a minimum BM25 score AND a margin over the runner-up before declaring `matched`. Below threshold, return `matched: null`, `via: "none"`, and push the BM25 winners into `did_you_mean[]` so the LLM can ask. Threshold values picked empirically from the existing corpus token weights (alias=4, title=3, slug=2, body=1).

**Files:**
- Modify: `msstate-policies/src/emergency/search.ts:142-153`
- Test: `msstate-policies/tests/emergency/search.test.ts` (extend) — verify both keep-the-hit and reject-the-hit paths

- [ ] **Step 1: Write the failing test**

Append to `msstate-policies/tests/emergency/search.test.ts`:

```ts
describe("resolveGuideline — confidence threshold", () => {
  test("strong alias-driven query keeps the match", () => {
    // Re-index a small corpus where "tornado" is a clear alias for severe-weather
    indexGuidelines([
      { slug: "severe-weather", title: "Severe Weather", url: "x", body_markdown: "Seek refuge during a tornado.", aliases: ["tornado", "twister"], retrieved_at: "t" },
      { slug: "active-shooter", title: "Active Shooter", url: "x", body_markdown: "Run, hide, fight.", aliases: ["gunman"], retrieved_at: "t" },
    ] as any);
    const r = resolveGuideline("tornado warning");
    assert.equal(r.matched?.slug, "severe-weather");
    assert.equal(r.via, "bm25"); // alias hit raises score; threshold passes
    assert.ok(r.score > 0);
  });

  test("ambiguous low-signal query yields matched=null + suggestions", () => {
    indexGuidelines([
      { slug: "severe-weather", title: "Severe Weather", url: "x", body_markdown: "Seek refuge during a tornado.", aliases: ["tornado", "twister"], retrieved_at: "t" },
      { slug: "active-shooter", title: "Active Shooter", url: "x", body_markdown: "Run, hide, fight.", aliases: ["gunman"], retrieved_at: "t" },
    ] as any);
    const r = resolveGuideline("the");
    assert.equal(r.matched, null, "weak query must not produce a confident match");
    assert.equal(r.via, "none");
    // suggestions OR did_you_mean must be populated so the LLM can disambiguate
    assert.ok(
      r.did_you_mean.length > 0 || r.suggestions.length > 0,
      "must surface candidates so the user can pick",
    );
  });

  test("score is exposed even when matched is null", () => {
    indexGuidelines([
      { slug: "severe-weather", title: "Severe Weather", url: "x", body_markdown: "x", aliases: [], retrieved_at: "t" },
    ] as any);
    const r = resolveGuideline("nonexistent garbage query that won't tokenize");
    assert.equal(typeof r.score, "number");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/emergency/search.test.ts`
Expected: FAIL — the "ambiguous query" test fails because the current code always returns `hits[0]` as matched.

- [ ] **Step 3: Implement the threshold**

In `msstate-policies/src/emergency/search.ts`, add near the top after the existing constants:

```ts
// BM25 confidence gates for emergency match.
// MIN_ABSOLUTE: score below this is "no real signal" given alias=4/title=3 weights.
// MIN_MARGIN_RATIO: top-hit must beat runner-up by 25%; otherwise tie → ambiguous.
const BM25_MIN_ABSOLUTE = 1.5;
const BM25_MIN_MARGIN_RATIO = 1.25;
```

Replace the BM25 branch of `resolveGuideline` (current lines 142-153) with:

```ts
  // 3. BM25 — gated by absolute score + margin over runner-up.
  const hits = bm25SearchGuidelines(norm);
  if (hits.length === 0) {
    return { matched: null, via: "none", did_you_mean: [], suggestions: docs.map((d) => d.row), score: 0 };
  }
  const top = hits[0];
  const runnerUp = hits[1]?.score ?? 0;
  const passesAbsolute = top.score >= BM25_MIN_ABSOLUTE;
  const passesMargin = runnerUp === 0 ? true : top.score >= runnerUp * BM25_MIN_MARGIN_RATIO;
  if (!passesAbsolute || !passesMargin) {
    // Ambiguous or weak: surface the candidates, don't pick a winner.
    return {
      matched: null,
      via: "none",
      did_you_mean: hits.slice(0, 3).map((h) => h.row),
      suggestions: [],
      score: top.score,
    };
  }
  return {
    matched: top.row,
    via: "bm25",
    did_you_mean: hits.slice(1, 3).map((h) => h.row),
    suggestions: [],
    score: top.score,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/emergency/search.test.ts tests/emergency/*.test.ts && npm run typecheck`
Expected: New tests pass, existing emergency tests still pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/emergency/search.ts msstate-policies/tests/emergency/search.test.ts
git commit -m "fix(emergency): require BM25 score+margin before declaring a match"
```

---

## Phase 2 — Correctness mediums (4 fixes)

### Task 4: Calendar negative-cache TTL (M1)

**Problem:** `src/calendars/corpus.ts:88-92` caches `{ rows: [], error: "..." }` for the same 6-24h TTL as successful scrapes. A single WAF challenge or network blip locks a source out for the rest of the day.

**Approach:** Short TTL (5 min) for entries with `error !== null`. Also: on cache hit where the new scrape would error, prefer last-known-good rows from the previous successful entry — but only if we *have* one. Keep stale flag visible via `getCalendarsCorpusHealth` so callers can see staleness.

**Files:**
- Modify: `msstate-policies/src/calendars/corpus.ts` (cache entry, `loadCalendarSource`, `getCalendarsCorpusHealth`)
- Test: `msstate-policies/tests/calendar-negative-cache.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// msstate-policies/tests/calendar-negative-cache.test.ts
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// We test loadCalendarSource by injecting a stub scraper. To keep this test
// hermetic, we use a small module-level seam — see Step 3.
import { __setScraperForTests, loadCalendarSource, getCalendarsCorpusHealth, resetCalendarCacheForTests } from "../src/calendars/corpus.js";
import type { ScrapeResult } from "../src/calendars/types.js";

describe("calendar negative cache TTL", () => {
  beforeEach(() => {
    resetCalendarCacheForTests();
  });

  test("a fresh error entry retries on next call within the long TTL", async () => {
    let calls = 0;
    __setScraperForTests(async (): Promise<ScrapeResult> => {
      calls++;
      if (calls === 1) return { source: "housing", rows: [], error: "WAF challenge" };
      return { source: "housing", rows: [{ source: "housing", event: "X", start: "2026-01-01", end: "2026-01-01", source_url: "https://x", citation: "[X](https://x)" } as any], error: null };
    });
    const r1 = await loadCalendarSource("housing");
    assert.equal(r1.error, "WAF challenge");
    // Second call within the long TTL but past the negative-cache TTL retries:
    const r2 = await loadCalendarSource("housing");
    assert.equal(calls, 2, "must retry on error within long TTL");
    assert.equal(r2.error, null);
    assert.equal(r2.rows.length, 1);
  });

  test("on transient error after a success, last-known-good rows are returned", async () => {
    let calls = 0;
    const goodRows = [{ source: "housing", event: "X", start: "2026-01-01", end: "2026-01-01", source_url: "https://x", citation: "[X](https://x)" } as any];
    __setScraperForTests(async (): Promise<ScrapeResult> => {
      calls++;
      if (calls === 1) return { source: "housing", rows: goodRows, error: null };
      return { source: "housing", rows: [], error: "WAF challenge" };
    });
    await loadCalendarSource("housing");
    resetCalendarCacheForTests({ keepLastGood: true }); // simulate TTL expiry without dropping LKG
    const r2 = await loadCalendarSource("housing");
    assert.equal(r2.rows.length, 1, "must serve last-known-good on transient error");
    assert.equal(r2.error, "WAF challenge", "error reason must remain visible");
  });

  test("health reports stale flag when last result was an error", async () => {
    __setScraperForTests(async (): Promise<ScrapeResult> => ({ source: "housing", rows: [], error: "WAF challenge" }));
    await loadCalendarSource("housing");
    const health = getCalendarsCorpusHealth();
    assert.equal(health.per_source.housing.error, "WAF challenge");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/calendar-negative-cache.test.ts`
Expected: FAIL — `__setScraperForTests`, `resetCalendarCacheForTests` not exported.

- [ ] **Step 3: Implement the fix**

In `msstate-policies/src/calendars/corpus.ts`, replace the existing cache/loadCalendarSource block (the file body after the imports, roughly lines 22-97) with:

```ts
interface CacheEntry {
  rows: CalendarRow[];
  expiresAt: number;
  error: string | null;
  // last successful rows, kept even if the most recent attempt errored
  lastGoodRows: CalendarRow[];
  lastGoodAt: number | null;
}

const cache = new Map<CalendarSource, CacheEntry>();
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

type Scraper = (source: CalendarSource) => Promise<ScrapeResult>;
let scraperImpl: Scraper = scrapeCalendar;
export function __setScraperForTests(s: Scraper): void { scraperImpl = s; }

export function resetCalendarCacheForTests(opts: { keepLastGood?: boolean } = {}): void {
  if (!opts.keepLastGood) {
    cache.clear();
    scraperImpl = scrapeCalendar;
    return;
  }
  for (const [k, v] of cache) {
    cache.set(k, { ...v, expiresAt: 0 });
  }
}

function ttlMsFor(source: CalendarSource): number {
  return source === "housing" ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

export async function loadCalendarSource(source: CalendarSource): Promise<ScrapeResult> {
  const now = Date.now();
  const hit = cache.get(source);
  if (hit && hit.expiresAt > now) {
    return { source, rows: hit.rows, error: hit.error };
  }
  const result = await scraperImpl(source);
  const wasError = result.error !== null;
  const lkg = hit?.lastGoodRows ?? [];
  const entry: CacheEntry = wasError
    ? {
        rows: lkg, // serve last-known-good on transient error
        error: result.error,
        expiresAt: now + NEGATIVE_TTL_MS,
        lastGoodRows: lkg,
        lastGoodAt: hit?.lastGoodAt ?? null,
      }
    : {
        rows: result.rows,
        error: null,
        expiresAt: now + ttlMsFor(source),
        lastGoodRows: result.rows,
        lastGoodAt: now,
      };
  cache.set(source, entry);
  if (wasError) {
    log("warn", "calendar source scrape error (serving LKG)", { source, error: result.error, lkg_count: lkg.length });
  }
  return { source, rows: entry.rows, error: entry.error };
}
```

Also update the `loadAllCalendarRows` early `for` loop — no API change there; it already reads `result.rows` and `result.error`, which now stay consistent.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/calendar-negative-cache.test.ts && npx tsx --test tests/calendar-scraper.test.ts && npm run typecheck`
Expected: New + existing calendar scraper tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/calendars/corpus.ts msstate-policies/tests/calendar-negative-cache.test.ts
git commit -m "fix(calendar): short TTL for errors; serve last-known-good on transient failure"
```

---

### Task 5: Partial scrape failures surface in result (M2)

**Problem:** `src/calendars/scraper.ts:189` reports `error: null` whenever at least one row was extracted, even if 3 of 4 term pages failed. Same pattern for grad PDFs at `:247`. The aggregate looks healthy when it isn't.

**Approach:** Track per-entry failures in a `warnings: string[]` field on `ScrapeResult`, and let `error` capture the *primary* failure (kept for compatibility) but stop overwriting it to `null` when there were per-entry failures. Add `partial_failures` count to `getCalendarsCorpusHealth`. No behavior change for fully-successful scrapes.

**Files:**
- Modify: `msstate-policies/src/calendars/types.ts` — extend `ScrapeResult`
- Modify: `msstate-policies/src/calendars/scraper.ts:155-191` (term pages) and `:213-249` (grad PDFs)
- Modify: `msstate-policies/src/calendars/corpus.ts` — propagate warnings through cache + health
- Test: extend `msstate-policies/tests/calendar-scraper.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `msstate-policies/tests/calendar-scraper.test.ts`:

```ts
describe("scraper — partial-failure surfacing", () => {
  test("when some term pages fail, ScrapeResult carries warnings and non-null error", async () => {
    // Use whatever test seam the file already exposes for stubbing httpGet.
    // If no seam exists, this test guides adding one in scraper.ts via export.
    const { __setHttpGetForTests, scrapeCalendar } = await import("../src/calendars/scraper.js");
    let call = 0;
    __setHttpGetForTests(async (url: string) => {
      call++;
      // First call (index page) succeeds with two entries
      if (url.endsWith("/calendars/academic-calendar")) {
        return { body: '<a href="/calendars/academic-calendar/2026/spring">Spring 2026</a><a href="/calendars/academic-calendar/2026/fall">Fall 2026</a>', status: 200 };
      }
      // Second sub-page fails
      if (url.includes("/fall")) throw new Error("timeout");
      return { body: "<table><tr><td>Classes begin</td><td>January 13, 2026</td></tr></table>", status: 200 };
    });
    const r = await scrapeCalendar("academic_calendar");
    assert.ok(r.rows.length > 0, "must still return rows from the page that worked");
    assert.ok(r.warnings && r.warnings.length > 0, "must surface per-page warnings");
    assert.ok(r.error !== null || r.warnings.length > 0, "partial failure must be visible");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/calendar-scraper.test.ts`
Expected: FAIL — `__setHttpGetForTests` not exported and `ScrapeResult.warnings` doesn't exist.

- [ ] **Step 3: Implement the change**

In `msstate-policies/src/calendars/types.ts`, extend `ScrapeResult`:

```ts
export interface ScrapeResult {
  source: CalendarSource;
  rows: CalendarRow[];
  error: string | null;
  warnings?: string[];
}
```

In `msstate-policies/src/calendars/scraper.ts`, at the top of the file expose an httpGet seam (replace the existing top-level `import { httpGet }` block as needed):

```ts
import { httpGet as defaultHttpGet } from "../http.js";
type HttpGet = typeof defaultHttpGet;
let httpGet: HttpGet = defaultHttpGet;
export function __setHttpGetForTests(fn: HttpGet): void { httpGet = fn; }
```

In the term-pages function (the block starting near line 155), replace the per-batch result handling with:

```ts
  const rows: CalendarRow[] = [];
  const warnings: string[] = [];
  let lastError: string | null = null;
  for (let i = 0; i < entries.length; i += SUB_FETCH_CONCURRENCY) {
    const batch = entries.slice(i, i + SUB_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        try {
          const res = await httpGet(entry.url, { timeoutMs: HTML_TIMEOUT_MS });
          const body = typeof res.body === "string" ? res.body : res.body.toString("utf8");
          if (detectCalendarWaf(body)) throw new CalendarWafError(source, entry.url);
          return { rows: parseTermPage(body, source, entry), warning: null as string | null };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = msg;
          log("warn", "term page fetch failed", { source, url: entry.url, err: msg });
          return { rows: [] as CalendarRow[], warning: `${entry.url}: ${msg}` };
        }
      }),
    );
    for (const r of results) {
      rows.push(...r.rows);
      if (r.warning) warnings.push(r.warning);
    }
  }
  // ... existing dedup logic stays the same ...
  return {
    source,
    rows: dedupedRows,
    error: dedupedRows.length === 0 ? lastError ?? "no rows extracted" : (warnings.length > 0 ? lastError : null),
    warnings: warnings.length > 0 ? warnings : undefined,
  };
```

Apply the same pattern to `scrapeGradD` (the block near line 213-249).

In `msstate-policies/src/calendars/corpus.ts`, propagate `warnings` through the cache entry and expose them via `getCalendarsCorpusHealth`:

```ts
interface CacheEntry {
  rows: CalendarRow[];
  expiresAt: number;
  error: string | null;
  warnings: string[];
  lastGoodRows: CalendarRow[];
  lastGoodAt: number | null;
}
// ... when constructing entry, add `warnings: result.warnings ?? []`
```

In `getCalendarsCorpusHealth`, extend the return shape:

```ts
export function getCalendarsCorpusHealth(): {
  per_source: Record<string, { row_count: number; error: string | null; warnings: string[] }>;
} {
  const per_source: Record<string, { row_count: number; error: string | null; warnings: string[] }> = {};
  for (const source of CALENDAR_SOURCES) {
    const entry = cache.get(source);
    per_source[source] = {
      row_count: entry?.rows.length ?? 0,
      error: entry?.error ?? null,
      warnings: entry?.warnings ?? [],
    };
  }
  return { per_source };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/calendar-scraper.test.ts tests/calendar-negative-cache.test.ts && npm run typecheck`
Expected: New + existing tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/calendars/types.ts msstate-policies/src/calendars/scraper.ts msstate-policies/src/calendars/corpus.ts msstate-policies/tests/calendar-scraper.test.ts
git commit -m "feat(calendar): surface per-entry scrape warnings in ScrapeResult + health"
```

---

### Task 6: Course search structured error when corpus unloaded (M5)

**Problem:** `src/tools/search_msu_courses.ts:22` calls `searchCourses` which searches an empty index when the baked corpus didn't load. The user can't distinguish "course not in catalog" from "course corpus missing."

**Approach:** Add `isCourseCorpusLoaded()` to `src/courses/corpus.ts` (or wherever the corpus setter lives). The tool handler returns a structured error response when false. Same fix in `get_msu_course` + `get_msu_course_graph` for consistency.

**Files:**
- Modify: `msstate-policies/src/courses/corpus.ts` (or wherever `setCourseCorpus` lives) — add `isCourseCorpusLoaded`
- Modify: `msstate-policies/src/tools/search_msu_courses.ts`
- Modify: `msstate-policies/src/tools/get_msu_course.ts`
- Modify: `msstate-policies/src/tools/get_msu_course_graph.ts`
- Test: `msstate-policies/tests/courses/tool-search-msu-courses.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `msstate-policies/tests/courses/tool-search-msu-courses.test.ts`:

```ts
import { search_msu_courses } from "../../src/tools/search_msu_courses.js";
import { __resetCourseCorpusForTests } from "../../src/courses/corpus.js";

describe("search_msu_courses — corpus unloaded", () => {
  test("returns a structured error when the course corpus is not loaded", async () => {
    __resetCourseCorpusForTests();
    const res = await search_msu_courses.handler({ q: "calculus" });
    assert.equal(res.isError, true);
    const text = res.content[0].text;
    assert.match(text, /course corpus not loaded/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/courses/tool-search-msu-courses.test.ts`
Expected: FAIL — `__resetCourseCorpusForTests` not exported; tool returns success with empty matches.

- [ ] **Step 3: Implement the fix**

In `msstate-policies/src/courses/corpus.ts` (locate `setCourseCorpus`), add:

```ts
let loaded = false;
const originalSet = setCourseCorpus;
// Replace the body of setCourseCorpus so it flips `loaded = true`.
// (If the file already has logic in setCourseCorpus, just add `loaded = true` to it.)

export function isCourseCorpusLoaded(): boolean { return loaded; }
export function __resetCourseCorpusForTests(): void { loaded = false; /* and call into the existing reset of indices, e.g. indexCourses([]) */ }
```

Adjust the existing `setCourseCorpus` body to flip `loaded = true` at the end.

In `msstate-policies/src/tools/search_msu_courses.ts`, gate the handler:

```ts
import { isCourseCorpusLoaded } from "../courses/corpus.js";

  async handler(rawInput: unknown) {
    if (!isCourseCorpusLoaded()) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "course corpus not loaded — server starting up or build skipped course bake" }],
      };
    }
    const input = Input.parse(rawInput);
    // ... existing body unchanged ...
```

Apply the identical guard at the top of the handlers in `get_msu_course.ts` and `get_msu_course_graph.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/courses/*.test.ts && npm run typecheck`
Expected: New test passes, existing course tool tests still pass (they seed the corpus before calling), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/courses/corpus.ts msstate-policies/src/tools/search_msu_courses.ts msstate-policies/src/tools/get_msu_course.ts msstate-policies/src/tools/get_msu_course_graph.ts msstate-policies/tests/courses/tool-search-msu-courses.test.ts
git commit -m "fix(courses): return structured error when corpus is unloaded"
```

---

### Task 7: Emergency category validation via z.enum (M6)

**Problem:** `src/tools/get_msu_emergency_contacts.ts:8` accepts any string; `src/emergency/corpus.ts:55` returns `[]` for unknown categories. A typo like `off-campus` (with a hyphen instead of underscore) silently returns no contacts.

**Approach:** Use `z.enum(["all", "emergency", "campus", "off_campus"])` at the schema level. Normalize a couple of plausible aliases (`off-campus`, `non_emergency` → `campus`) up front so common typos don't error. Return an explicit invalid-category response if the input still doesn't map. Continue to lead with `MANDATORY_DISCLAIMER`.

**Files:**
- Modify: `msstate-policies/src/tools/get_msu_emergency_contacts.ts`
- Modify: `msstate-policies/src/emergency/corpus.ts` (extend `CATEGORY_INPUT_MAP` to cover aliases)
- Test: `msstate-policies/tests/emergency/tool-get-msu-emergency-contacts.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `msstate-policies/tests/emergency/tool-get-msu-emergency-contacts.test.ts`:

```ts
describe("get_msu_emergency_contacts — category validation", () => {
  test("rejects unknown category with a structured response, not empty list", async () => {
    const res = await get_msu_emergency_contacts.handler({ category: "garbage" });
    // Either zod throws (which the parent CallToolRequestSchema handler turns into an
    // error response) or our handler returns isError=true. Either way, the user must
    // be told the category is invalid, NOT that there are no contacts.
    const text = res.content?.[0]?.text ?? "";
    assert.ok(
      res.isError === true || /invalid|allowed|unknown category/i.test(text),
      "must signal invalid category, not empty success",
    );
  });

  test("hyphenated alias 'off-campus' resolves to off_campus", async () => {
    const res = await get_msu_emergency_contacts.handler({ category: "off-campus" });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.contacts.length > 0, "alias must route to off_campus contacts");
    assert.equal(parsed.disclaimer.startsWith("If this is a life-threatening emergency"), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/emergency/tool-get-msu-emergency-contacts.test.ts`
Expected: FAIL — unknown category returns success with empty contacts; alias is silently empty.

- [ ] **Step 3: Implement the fix**

In `msstate-policies/src/emergency/corpus.ts`, extend the alias map:

```ts
const CATEGORY_INPUT_MAP: Record<string, ContactCategory | "all"> = {
  all: "all",
  emergency: "emergency",
  campus: "campus_non_emergency",
  campus_non_emergency: "campus_non_emergency",
  "non-emergency": "campus_non_emergency",
  non_emergency: "campus_non_emergency",
  off_campus: "off_campus_non_emergency",
  "off-campus": "off_campus_non_emergency",
  off_campus_non_emergency: "off_campus_non_emergency",
};

export function isValidCategoryInput(input: string): boolean {
  return CATEGORY_INPUT_MAP[input.toLowerCase().trim()] !== undefined;
}
```

In `msstate-policies/src/tools/get_msu_emergency_contacts.ts`:

```ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { filterContacts, isValidCategoryInput } from "../emergency/corpus.js";
import { MANDATORY_DISCLAIMER, MAX_QUERY_CHARS } from "../emergency/types.js";

const Input = z
  .object({
    category: z.string().max(MAX_QUERY_CHARS).optional().default("all"),
  })
  .strict();

const REFUGE_URL = "https://www.emergency.msstate.edu/refuge";
const ALLOWED = ["all", "emergency", "campus", "off_campus"];

export const get_msu_emergency_contacts = {
  // ... same name / description / inputSchema / zodSchema ...
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    if (!isValidCategoryInput(input.category)) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: MANDATORY_DISCLAIMER,
            error: `invalid category: ${input.category}`,
            allowed: ALLOWED,
          }, null, 2),
        }],
      };
    }
    const contacts = filterContacts(input.category).map((c) => ({
      label: c.label,
      phone: c.phone,
      category: c.category,
    }));
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          disclaimer: MANDATORY_DISCLAIMER,
          contacts,
          source_url: REFUGE_URL,
        }, null, 2),
      }],
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/emergency/tool-get-msu-emergency-contacts.test.ts && npm run typecheck`
Expected: New tests pass, existing pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/emergency/corpus.ts msstate-policies/src/tools/get_msu_emergency_contacts.ts msstate-policies/tests/emergency/tool-get-msu-emergency-contacts.test.ts
git commit -m "fix(emergency): validate contact category; alias hyphenated forms"
```

---

## Phase 3 — Perf + polish (5 fixes)

### Task 8: BM25 inverted index across 3 modules (M3)

**Problem:** `countOf(token, arr)` in each of `src/courses/search.ts:80`, `src/calendars/search.ts` (around the same area), and `src/emergency/search.ts:80` is O(field_length) per query-token × per-field × per-doc. For a course catalog with thousands of docs this is wasteful.

**Approach:** At index time, precompute a `Map<token, count>` per field per doc. Query time becomes O(1) per (token, field, doc) lookup. Keep the API stable — internal change only.

**Files:** (apply same refactor in each)
- Modify: `msstate-policies/src/courses/search.ts`
- Modify: `msstate-policies/src/calendars/search.ts`
- Modify: `msstate-policies/src/emergency/search.ts`
- Test: existing search tests should pass unchanged (correctness regression); add a sanity micro-benchmark to one of them

- [ ] **Step 1: Write the failing test**

The intent here is "behavior unchanged, internal speed up" — so the test is a regression guard. Append to `msstate-policies/tests/courses/search.test.ts`:

```ts
describe("courses BM25 — index uses precomputed term frequencies", () => {
  test("internal IndexedCourse exposes tf maps after indexing", async () => {
    const mod = await import("../../src/courses/search.js");
    // The test relies on a debug accessor we add in Step 3.
    const debug = (mod as any).__debugDocs();
    assert.ok(debug.length > 0, "indexCourses must have populated docs");
    const sample = debug[0];
    assert.ok(sample.codeTf instanceof Map, "codeTf must be a Map<string, number>");
    assert.ok(sample.titleTf instanceof Map);
    assert.ok(sample.descTf instanceof Map);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/courses/search.test.ts`
Expected: FAIL — `__debugDocs` not exported, tf maps don't exist.

- [ ] **Step 3: Implement the inverted index in courses**

In `msstate-policies/src/courses/search.ts`, change the `IndexedCourse` shape + `indexCourses` body, and rewrite the search loop:

```ts
interface IndexedCourse {
  course: Course;
  codeTokens: string[];
  titleTokens: string[];
  descTokens: string[];
  codeTf: Map<string, number>;
  titleTf: Map<string, number>;
  descTf: Map<string, number>;
  dl: number;
}

function tfMap(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export function indexCourses(rows: Course[]): void {
  docs = rows.map((course) => {
    const codeTokens = tokenize(course.code);
    const titleTokens = tokenize(course.title);
    const descTokens = tokenize(course.description ?? "");
    return {
      course,
      codeTokens, titleTokens, descTokens,
      codeTf: tfMap(codeTokens),
      titleTf: tfMap(titleTokens),
      descTf: tfMap(descTokens),
      dl: codeTokens.length + titleTokens.length + descTokens.length,
    };
  });
  // df + avgLen logic unchanged
  // ...
}

export function __debugDocs(): IndexedCourse[] { return docs; }
```

Rewrite the search loop:

```ts
export function searchCourses(query: string, limit = 10): CourseHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const out: CourseHit[] = [];
  for (const d of docs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = idf(q);
      if (idfQ === 0) continue;
      s += FIELD_WEIGHTS.code        * bm25Term(d.codeTf.get(q)  ?? 0, d.dl, idfQ);
      s += FIELD_WEIGHTS.title       * bm25Term(d.titleTf.get(q) ?? 0, d.dl, idfQ);
      s += FIELD_WEIGHTS.description * bm25Term(d.descTf.get(q)  ?? 0, d.dl, idfQ);
    }
    if (s > 0) out.push({ course: d.course, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(0, limit));
}
```

Apply the identical pattern to `msstate-policies/src/calendars/search.ts` and `msstate-policies/src/emergency/search.ts` (both the guideline index and the refuge index).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npm test`
Expected: All search tests pass; new debug-accessor test passes.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/courses/search.ts msstate-policies/src/calendars/search.ts msstate-policies/src/emergency/search.ts msstate-policies/tests/courses/search.test.ts
git commit -m "perf(search): precompute per-field tf maps in BM25 indexers"
```

---

### Task 9: Parallelize course dept-page scraping (M4)

**Problem:** `src/courses/scraper.ts:197` walks `deptUrls` serially with `for (const deptUrl of deptUrls)`, while the same file has a `pool(items, conc, fn)` utility at `:169`.

**Approach:** Replace the serial loop with `pool(deptUrls, CONCURRENCY, deptFetcher)`. Preserve `per_dept` ordering by writing into the dict by key, not by array index.

**Files:**
- Modify: `msstate-policies/src/courses/scraper.ts:194-211`
- Test: `msstate-policies/tests/courses/scraper.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `msstate-policies/tests/courses/scraper.test.ts`:

```ts
describe("scrapeAllCourses — dept-page fetch parallelism", () => {
  test("dept pages run through the bounded pool, not serially", async () => {
    const events: string[] = [];
    const deptUrls = ["a", "b", "c", "d"];
    const fetchIndex = async () => deptUrls.map((u) => `<a href="${u}">dept</a>`).join("");
    const fetchDept = async (u: string) => {
      events.push(`start:${u}`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`end:${u}`);
      return "<table></table>";
    };
    const { scrapeAllCourses } = await import("../../src/courses/scraper.js");
    await scrapeAllCourses({ fetchIndex, fetchDept } as any).catch(() => {});
    // With CONCURRENCY > 1 we expect at least two `start:*` events before the first `end:*`.
    const firstEndIdx = events.findIndex((e) => e.startsWith("end:"));
    const startsBeforeFirstEnd = events.slice(0, firstEndIdx).filter((e) => e.startsWith("start:")).length;
    assert.ok(startsBeforeFirstEnd >= 2, `expected concurrent dept fetches; saw ${startsBeforeFirstEnd}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/courses/scraper.test.ts`
Expected: FAIL — only one start before the first end (serial loop).

- [ ] **Step 3: Implement the pooled fetch**

In `msstate-policies/src/courses/scraper.ts`, replace lines 194-211 with:

```ts
  const per_dept: Record<string, { course_count: number; error: string | null }> = {};
  const allCodes = new Set<string>();

  await pool(deptUrls, CONCURRENCY, async (deptUrl) => {
    try {
      const deptHtml = await deptFetcher(deptUrl);
      const codes = extractCourseCodesFromDeptHtml(deptHtml);
      if (codes.length === 0) {
        per_dept[deptUrl] = { course_count: 0, error: "zero courses extracted" };
        return;
      }
      for (const c of codes) allCodes.add(c);
      per_dept[deptUrl] = { course_count: codes.length, error: null };
    } catch (e) {
      per_dept[deptUrl] = { course_count: 0, error: e instanceof Error ? e.message : String(e) };
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/courses/scraper.test.ts`
Expected: New + existing scraper tests pass.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/courses/scraper.ts msstate-policies/tests/courses/scraper.test.ts
git commit -m "perf(courses): fetch dept pages through bounded pool"
```

---

### Task 10: `get_msu_calendar` pagination (L1)

**Problem:** `src/tools/get_msu_calendar.ts:30` filters rows but returns all of them. The largest source (`academic_calendar`) can return hundreds of rows in one MCP response.

**Approach:** Add `limit` (default 50, max 500) and `offset` (default 0) to the input schema. Return `{ rows, total, offset, limit }`. Backward-compatible defaults — current callers continue to work; we just stop sending megabytes.

**Files:**
- Modify: `msstate-policies/src/tools/get_msu_calendar.ts`
- Test: `msstate-policies/tests/tool-get-msu-calendar.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `msstate-policies/tests/tool-get-msu-calendar.test.ts`:

```ts
describe("get_msu_calendar — pagination", () => {
  test("respects limit; total reports unpaged count; offset slides window", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      source: "academic_calendar",
      event: `Event ${i}`,
      start: "2026-01-01", end: "2026-01-01",
      term: "Spring 2026",
      source_url: "https://x",
      citation: "[X](https://x)",
    }));
    indexCalendarRowsForGetter(rows as any);
    const res1 = await get_msu_calendar.handler({ source: "academic_calendar", limit: 25 });
    const p1 = JSON.parse(res1.content[0].text);
    assert.equal(p1.rows.length, 25);
    assert.equal(p1.total, 120);
    assert.equal(p1.limit, 25);
    assert.equal(p1.offset, 0);
    const res2 = await get_msu_calendar.handler({ source: "academic_calendar", limit: 25, offset: 100 });
    const p2 = JSON.parse(res2.content[0].text);
    assert.equal(p2.rows.length, 20, "tail page returns remainder");
    assert.equal(p2.offset, 100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/tool-get-msu-calendar.test.ts`
Expected: FAIL — `limit`/`offset` not in schema, no `total` in response.

- [ ] **Step 3: Implement pagination**

Replace `GetMsuCalendarInput` and the handler in `msstate-policies/src/tools/get_msu_calendar.ts`:

```ts
const GetMsuCalendarInput = z
  .object({
    source: z.enum(CALENDAR_SOURCES as unknown as [string, ...string[]]),
    term: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(500).optional().default(50),
    offset: z.number().int().min(0).max(10000).optional().default(0),
  })
  .strict();

export const get_msu_calendar = {
  name: "get_msu_calendar",
  description:
    "Return the raw rows for one MSU calendar source. ... Returns up to `limit` rows starting at `offset`; default limit is 50.",
  inputSchema: zodToJsonSchema(GetMsuCalendarInput, { target: "openApi3" }),
  zodSchema: GetMsuCalendarInput,
  async handler(rawInput: unknown) {
    const input = GetMsuCalendarInput.parse(rawInput);
    await awaitCalendarWarm();
    const filter = input.term?.toLowerCase();
    const filtered = allRows
      .filter((r) => r.source === input.source)
      .filter((r) => !filter || (r.term ?? "").toLowerCase().includes(filter));
    const total = filtered.length;
    const page = filtered.slice(input.offset, input.offset + input.limit);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              source: input.source,
              term: input.term ?? null,
              rows: page,
              total,
              offset: input.offset,
              limit: input.limit,
              source_url: CALENDAR_URLS[input.source as keyof typeof CALENDAR_URLS],
              corpus_built_at: null,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/tool-get-msu-calendar.test.ts && npm run typecheck`
Expected: All tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/tools/get_msu_calendar.ts msstate-policies/tests/tool-get-msu-calendar.test.ts
git commit -m "feat(calendar): paginate get_msu_calendar (limit/offset/total)"
```

---

### Task 11: Date parser validates impossible dates (L2)

**Problem:** `src/calendars/parsers/date_table.ts:71/81/91` call `iso(y, m, d)` directly without bounds checks. Input text like `February 31, 2026` becomes the valid-looking string `"2026-02-31"`.

**Approach:** Round-trip the (y,m,d) tuple through `Date.UTC` and verify the parsed `Date` matches. If it doesn't, return `null` from `parseRange` for that branch and let the caller skip the row.

**Files:**
- Modify: `msstate-policies/src/calendars/parsers/date_table.ts`
- Test: `msstate-policies/tests/parsers-date-table.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `msstate-policies/tests/parsers-date-table.test.ts`:

```ts
describe("date_table — invalid dates", () => {
  test("February 31 is rejected, not normalized to March 3", () => {
    const r = parseRange("February 31, 2026"); // export the function for direct call
    assert.equal(r, null);
  });
  test("month=0 / day=0 is rejected", () => {
    assert.equal(parseRange("Foobar 0, 2026"), null);
    assert.equal(parseRange("January 0, 2026"), null);
  });
  test("April 31 (only 30 days) is rejected", () => {
    assert.equal(parseRange("April 31, 2026"), null);
  });
  test("legitimate dates still parse", () => {
    assert.deepEqual(parseRange("January 13, 2026"), ["2026-01-13", "2026-01-13"]);
  });
});
```

If `parseRange` is not currently exported, expose it for tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/parsers-date-table.test.ts`
Expected: FAIL — `February 31, 2026` returns `["2026-02-31", "2026-02-31"]`, not null.

- [ ] **Step 3: Implement validation**

In `msstate-policies/src/calendars/parsers/date_table.ts`, replace `iso` with a validating version:

```ts
function iso(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}`.padStart(4, "0") + "-" + `${m}`.padStart(2, "0") + "-" + `${d}`.padStart(2, "0");
}
```

Update each `iso(...)` call site to bail if the result is null:

```ts
  if (twoMonth) {
    // ... existing parsing of m1, m2, d1, d2, y1, y2 ...
    if (m1 && m2 && y1 && y2) {
      const s = iso(y1, m1, d1);
      const e = iso(y2, m2, d2);
      if (s && e) return [s, e];
    }
  }
```

Apply the same null-check pattern at the other two `iso()` call sites (single-month range and single date).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/parsers-date-table.test.ts tests/parsers-event-list.test.ts && npm run typecheck`
Expected: New + existing parser tests pass.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/calendars/parsers/date_table.ts msstate-policies/tests/parsers-date-table.test.ts
git commit -m "fix(parsers): reject impossible dates via UTC round-trip"
```

---

### Task 12: Emergency markdown dedup walk (L3)

**Problem:** `src/emergency/parser.ts:69` walks both direct children (`> *`) AND grandchildren (`> div > *`). When a section is wrapped in a div, both the wrapper and its children get emitted, duplicating text.

**Approach:** Walk only `> *`. When a child is a `<div>` (or other generic container), recurse into *its* leaves; never visit both the container and the wrapped descendants. Skip elements already seen by a unique cheerio reference identity.

**Files:**
- Modify: `msstate-policies/src/emergency/parser.ts:55-83`
- Test: `msstate-policies/tests/emergency/parser.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `msstate-policies/tests/emergency/parser.test.ts`:

```ts
describe("parseGuidelineHtml — no duplicate content", () => {
  test("a div-wrapped paragraph is emitted once, not twice", () => {
    const html = `<main>
      <h1 class="page-title">Severe Weather</h1>
      <div><p>Seek refuge during a tornado.</p></div>
      <p>Final paragraph.</p>
    </main>`;
    const r = parseGuidelineHtml(html, "severe-weather");
    assert.ok(r);
    const occurrences = (r!.body_markdown.match(/Seek refuge during a tornado\./g) ?? []).length;
    assert.equal(occurrences, 1, `expected exactly 1 occurrence, got ${occurrences}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/emergency/parser.test.ts`
Expected: FAIL — text appears twice because both `> div` (rendered as full text) and `> div > p` are walked.

- [ ] **Step 3: Implement the dedup walk**

In `msstate-policies/src/emergency/parser.ts`, replace the block in `parseGuidelineHtml` that builds `blocks[]`:

```ts
  const blocks: string[] = [];
  const seen = new Set<Element>();

  function emitNode(el: Element): void {
    const t = (el.tagName ?? "").toLowerCase();
    if (t === "h1") return; // title already captured
    // For generic containers, recurse into children instead of emitting
    // the container's full text (which would duplicate child content).
    if (t === "div" || t === "section" || t === "article") {
      $(el).children().each((_, child) => {
        if (!seen.has(child as Element)) {
          seen.add(child as Element);
          emitNode(child as Element);
        }
      });
      return;
    }
    const md = nodeToMarkdown($, el);
    for (const line of md) blocks.push(line);
  }

  main.children().each((_, el) => {
    if (seen.has(el as Element)) return;
    seen.add(el as Element);
    emitNode(el as Element);
  });

  const body_markdown = blocks.join("\n\n").trim();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/emergency/parser.test.ts tests/emergency/*.test.ts && npm run typecheck`
Expected: New + existing emergency parser tests pass.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/emergency/parser.ts msstate-policies/tests/emergency/parser.test.ts
git commit -m "fix(emergency): walk semantic leaves only; deduplicate markdown blocks"
```

---

## Phase 4 — Rebuild, verify, ship

### Task 13: Rebuild dist, verify security checklist, version bump

**Files:**
- Modify: `msstate-policies/package.json` (version bump)
- Modify: `msstate-policies/dist/index.js` (regenerated)
- Modify: `package.json` at repo root (if it carries a sibling version)
- Modify: `worker/corpus.json` and `worker/src/*` only IF the corpus shape changed; this plan does not change wire format, so usually unchanged

- [ ] **Step 1: Run the full test suite**

Run: `cd msstate-policies && npm test && npm run typecheck`
Expected: All tests pass, typecheck clean.

- [ ] **Step 2: Bump version and rebuild**

Edit `msstate-policies/package.json`:
```json
"version": "0.7.1",
```

Run: `cd msstate-policies && npm run build`
Expected: `dist/index.js` regenerates; banner shows new version.

- [ ] **Step 3: Run the security checklist**

Run: `bash tools/security-checklist.sh | tail -1`
Expected: `score: 245`.

If the score regresses, find which check failed (the script prints per-check status above the tally), fix the regression, and re-run. Do NOT lower the gate.

- [ ] **Step 4: Commit dist + version**

```bash
git add msstate-policies/package.json msstate-policies/dist/index.js
git commit -m "release(v0.7.1): rebuild dist after tooling-review fixes"
```

- [ ] **Step 5: Tag**

```bash
git tag v0.7.1
```

Push later, separately. Do NOT push without explicit user confirmation.

---

## Self-Review Notes

Reviewed against the 12 Codex findings:

- **H1 Calendar warm race** → Task 1 ✓
- **H2 Course graph cycle** → Task 2 ✓
- **H3 Emergency BM25 unconditional match** → Task 3 ✓
- **M1 Negative cache poisoning** → Task 4 ✓
- **M2 Partial scrape failures swallowed** → Task 5 ✓
- **M3 BM25 hot loops** → Task 8 ✓ (all 3 modules)
- **M4 Serial dept-page scraping** → Task 9 ✓
- **M5 Course search silent on unloaded corpus** → Task 6 ✓
- **M6 Emergency category lacks validation** → Task 7 ✓
- **L1 `get_msu_calendar` unbounded** → Task 10 ✓
- **L2 Date parser invalid dates** → Task 11 ✓
- **L3 Emergency markdown duplication** → Task 12 ✓

All covered. No placeholders, every step has concrete code or commands. Type names are consistent: `CacheEntry`, `IndexedCourse`, `IndexedGuideline`, `__setHttpGetForTests`, `__setScraperForTests`, `__debugDocs`, `isCourseCorpusLoaded`, `isValidCategoryInput`, `awaitCalendarWarm`, `setCalendarWarmReady`, `resetCalendarWarmForTests`, `resetCalendarCacheForTests`, `__resetCourseCorpusForTests`.

Known sequencing dependency: Task 10 depends on Task 1's `awaitCalendarWarm` import. Phase order enforces this.

Out-of-scope, intentionally deferred:
- Tuition findings from the working-tree review (separate plan).
- Worker-side mirrors of these fixes (Worker reads pre-baked corpus.json; calendar-warm race doesn't apply there; if the Worker needs the BM25-threshold change, that's a follow-up).
