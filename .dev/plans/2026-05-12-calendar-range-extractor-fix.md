# Calendar range extractor fix — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the registrar academic-calendar extractor so multi-day events (Fall Break, Spring Break, advising windows, graduation application windows) return their true `end` date instead of collapsing to a single day. Also covers `sfa_financial_aid` (same extractor).

**Architecture:** Read the second `<time datetime>` element inside the date column (`col-md-4`) when present, thread it through `RawRow.isoDateEnd`, and use it in `parseTermPage` as `end`. Add a corpus-rebuild guard so a future regression aborts the build instead of silently shipping single-day rows. Pure HTML-extraction fix; no changes to the text-based `parseDateRange`, the row schema, or the Worker.

**Tech Stack:** TypeScript + cheerio (HTML parsing), `node:test` + `tsx` (test runner), esbuild (bundler), bash (security checklist).

**Reference spec:** `.dev/specs/2026-05-12-calendar-range-extractor-fix-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `msstate-policies/src/calendars/parsers/term_pages.ts` | Modify | Add `isoDateEnd?: string` to `RawRow`; extract second `<time>` in `extractAcademicCalendarRows`; thread end-date through `parseTermPage`. |
| `msstate-policies/tests/parsers-term-pages-range.test.ts` | Create | Unit tests for multi-day, single-day, cross-month, and malformed-out-of-order cases. Also a smoke test against the unchanged exam-schedule path. |
| `scripts/build-worker-corpus.mjs` | Modify | After the calendar scrape merges into `out.academic_calendar.rows`, assert that at least one academic_calendar or sfa_financial_aid row has `start != end`. Abort with canonical `"refusing to ship..."` string otherwise. |
| `tools/security-checklist.sh` | Modify | Add CAL6 (+5 pts) that greps for the new abort string. Score 230 → 235. |
| `msstate-policies/dist/index.js` | Regenerate (build) | Rebuild output of esbuild. Not hand-edited; produced by `npm run build`. |
| `worker/corpus.json` | Regenerate (rescrape) | Rebuilt by `scripts/build-worker-corpus.mjs`. Not hand-edited. |

No new files in `src/` — the fix is contained to one parser file.

---

## Task 1: Add `isoDateEnd` to `RawRow` and extract it in `extractAcademicCalendarRows`

**Files:**
- Modify: `msstate-policies/src/calendars/parsers/term_pages.ts:111-117` (RawRow), `:126-157` (extractor)
- Test: `msstate-policies/tests/parsers-term-pages-range.test.ts` (new)

- [ ] **Step 1: Write the failing test (multi-day range)**

Create `msstate-policies/tests/parsers-term-pages-range.test.ts` with one test:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTermPage } from "../src/calendars/parsers/term_pages.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(here, "fixtures", "calendars", name), "utf8");

test("parseTermPage: academic_calendar Spring 2026 Spring Break has end=2026-03-13", () => {
  const rows = parseTermPage(
    fixture("registrar_academic_2026_spring.html"),
    "academic_calendar",
    {
      url: "https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring",
      year: 2026,
      term: "Spring",
    },
  );
  const springBreak = rows.find((r) => /spring break/i.test(r.event));
  assert.ok(springBreak, "expected a Spring Break row");
  assert.equal(springBreak!.start, "2026-03-09");
  assert.equal(springBreak!.end, "2026-03-13");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd msstate-policies && npx tsx --test tests/parsers-term-pages-range.test.ts`
Expected: FAIL — current code returns `end: "2026-03-09"` (same as `start`); assertion on `end` fails.

- [ ] **Step 3: Add `isoDateEnd?: string` to the `RawRow` interface**

Edit `msstate-policies/src/calendars/parsers/term_pages.ts:111-117`. Change:

```typescript
interface RawRow {
  event: string;
  /** ISO date string YYYY-MM-DD extracted from <time datetime>. */
  isoDate: string;
  /** Optional raw time string (e.g. "8:00 am to 11:00 am"). */
  time?: string;
}
```

to:

```typescript
interface RawRow {
  event: string;
  /** ISO date string YYYY-MM-DD extracted from <time datetime>. */
  isoDate: string;
  /** Optional end-date for multi-day ranges (second <time datetime>). */
  isoDateEnd?: string;
  /** Optional raw time string (e.g. "8:00 am to 11:00 am"). */
  time?: string;
}
```

- [ ] **Step 4: Extract the second `<time>` element in `extractAcademicCalendarRows`**

Add `import { log } from "../../log.js";` at the top of the file (after the existing cheerio + types imports near line 45). Then edit `extractAcademicCalendarRows` at `term_pages.ts:126-157`. Replace the function body with:

```typescript
function extractAcademicCalendarRows(html: string): RawRow[] {
  const $ = cheerioLoad(html);
  const out: RawRow[] = [];

  $("div.row.g-0").each((_i, el) => {
    const $row = $(el);
    if (!$row.hasClass("border-bottom")) return;

    const dateCol = $row.find("div[class*='col-md-4']").first();
    const timeEls = dateCol.find("time[datetime]").toArray();
    if (timeEls.length === 0) return;

    const firstDatetime = $(timeEls[0]).attr("datetime") ?? "";
    const firstMatch = firstDatetime.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!firstMatch) return;
    const isoDate = firstMatch[1];

    let isoDateEnd: string | undefined;
    if (timeEls.length >= 2) {
      const lastDatetime = $(timeEls[timeEls.length - 1]).attr("datetime") ?? "";
      const lastMatch = lastDatetime.match(/^(\d{4}-\d{2}-\d{2})/);
      if (lastMatch) {
        const candidate = lastMatch[1];
        if (candidate >= isoDate) {
          isoDateEnd = candidate;
        } else {
          log("warn", "academic_calendar end-date precedes start; dropping end", {
            isoDate,
            candidateEnd: candidate,
          });
        }
      }
    }

    const eventCol = $row.find("div[class*='col-md-8']").first();
    let event = eventCol.text().replace(/\s+/g, " ").trim();
    if (!event) {
      const dateText = $(timeEls[0]).text().trim();
      event = $row.text().replace(dateText, "").replace(/\s+/g, " ").trim();
    }
    if (!event) return;

    out.push({ event, isoDate, isoDateEnd });
  });

  return out;
}
```

- [ ] **Step 5: Use `isoDateEnd` as the row `end` in `parseTermPage`**

Edit `term_pages.ts:269-279`. Change the row push from:

```typescript
    rows.push({
      source,
      event,
      start: r.isoDate,
      end: r.isoDate,
      time: r.time,
      term: fullTerm,
      source_url: entry.url,
      retrieved_at: retrievedAt,
      citation: formatCitation(event, fullTerm, entry.url),
    });
```

to:

```typescript
    rows.push({
      source,
      event,
      start: r.isoDate,
      end: r.isoDateEnd ?? r.isoDate,
      time: r.time,
      term: fullTerm,
      source_url: entry.url,
      retrieved_at: retrievedAt,
      citation: formatCitation(event, fullTerm, entry.url),
    });
```

The dedupe key (`${event}|${r.isoDate}`) is unchanged — still keyed on start.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd msstate-policies && npx tsx --test tests/parsers-term-pages-range.test.ts`
Expected: PASS — Spring Break now has `start=2026-03-09`, `end=2026-03-13`.

- [ ] **Step 7: Run the full test suite to confirm no regression**

Run: `cd msstate-policies && npm test`
Expected: all existing tests pass (especially `parsers-term-pages.test.ts`, `calendar-scraper.test.ts`, `calendar-search.test.ts`). If anything fails, fix before continuing.

- [ ] **Step 8: Commit**

```bash
git add msstate-policies/src/calendars/parsers/term_pages.ts msstate-policies/tests/parsers-term-pages-range.test.ts
git commit -m "$(cat <<'EOF'
fix(calendars): extract end date from second <time> in registrar term pages

extractAcademicCalendarRows now reads both time[datetime] elements in
the col-md-4 date column. Multi-day events (Spring Break, Fall Break,
advising windows) keep their true end date instead of collapsing to
start. SFA financial-aid pages get the fix for free (shared extractor).

Out-of-order end dates fall back to single-day with a stderr warning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Single-day regression guard

**Files:**
- Test: `msstate-policies/tests/parsers-term-pages-range.test.ts`

- [ ] **Step 1: Write the regression test**

Append to `msstate-policies/tests/parsers-term-pages-range.test.ts`:

```typescript
test("parseTermPage: academic_calendar single-day events still have start == end", () => {
  const rows = parseTermPage(
    fixture("registrar_academic_2026_spring.html"),
    "academic_calendar",
    {
      url: "https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring",
      year: 2026,
      term: "Spring",
    },
  );
  const singleDay = rows.filter((r) => r.start === r.end);
  assert.ok(
    singleDay.length >= 3,
    `expected >= 3 genuine single-day rows in Spring 2026; got ${singleDay.length}`,
  );
  for (const r of singleDay) {
    assert.match(r.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(r.start, r.end);
  }
});
```

- [ ] **Step 2: Run the test**

Run: `cd msstate-policies && npx tsx --test tests/parsers-term-pages-range.test.ts`
Expected: PASS — single-day events such as "Classes begin" or "Holiday" still collapse correctly.

- [ ] **Step 3: Commit**

```bash
git add msstate-policies/tests/parsers-term-pages-range.test.ts
git commit -m "$(cat <<'EOF'
test(calendars): guard against over-eager range extraction on single-day events

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Cross-month range test

**Files:**
- Test: `msstate-policies/tests/parsers-term-pages-range.test.ts`

- [ ] **Step 1: Write the test**

Append to `msstate-policies/tests/parsers-term-pages-range.test.ts`. The Spring 2026 fixture has a "Jan 28 to Mar 27" graduation-application row (confirmed by `grep` during design).

```typescript
test("parseTermPage: academic_calendar handles cross-month ranges", () => {
  const rows = parseTermPage(
    fixture("registrar_academic_2026_spring.html"),
    "academic_calendar",
    {
      url: "https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring",
      year: 2026,
      term: "Spring",
    },
  );
  const gradApp = rows.find(
    (r) => /apply.*graduation|graduation.*apply|early bird/i.test(r.event) && r.start === "2026-01-28",
  );
  assert.ok(gradApp, "expected a Jan-28-start graduation-application window");
  assert.equal(gradApp!.end, "2026-03-27");
});
```

- [ ] **Step 2: Run the test**

Run: `cd msstate-policies && npx tsx --test tests/parsers-term-pages-range.test.ts`
Expected: PASS — Jan 28 row has `end=2026-03-27`.

- [ ] **Step 3: Commit**

```bash
git add msstate-policies/tests/parsers-term-pages-range.test.ts
git commit -m "$(cat <<'EOF'
test(calendars): verify cross-month range extraction

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Malformed-out-of-order test (synthetic fixture)

**Files:**
- Test: `msstate-policies/tests/parsers-term-pages-range.test.ts`

- [ ] **Step 1: Write the test with inline synthetic HTML**

Append:

```typescript
test("parseTermPage: out-of-order end date falls back to single-day", () => {
  // Synthetic HTML: end (2026-03-05) precedes start (2026-03-09). The extractor
  // must drop the bad end and keep start == end. This guards against silent
  // corruption if MSU's HTML ever ships a malformed range.
  const html = `<!doctype html><html><body>
    <div class="row g-0 border-bottom">
      <div class="col col-md-4">
        <div class="card-body py-4">
          <time datetime="2026-03-09T12:00:00Z">March 9</time>
 to</br><time datetime="2026-03-05T12:00:00Z">March 5</time>
        </div>
      </div>
      <div class="col col-md-8">
        <div class="card-body py-4">Broken Event</div>
      </div>
    </div>
  </body></html>`;

  const rows = parseTermPage(html, "academic_calendar", {
    url: "https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring",
    year: 2026,
    term: "Spring",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].start, "2026-03-09");
  assert.equal(rows[0].end, "2026-03-09", "out-of-order end must be dropped, not used");
});
```

- [ ] **Step 2: Run the test**

Run: `cd msstate-policies && npx tsx --test tests/parsers-term-pages-range.test.ts`
Expected: PASS — out-of-order end is dropped. A `level=warn` JSON line appears on stderr (verified by visual inspection of the test output; not asserted programmatically to avoid coupling tests to log format).

- [ ] **Step 3: Commit**

```bash
git add msstate-policies/tests/parsers-term-pages-range.test.ts
git commit -m "$(cat <<'EOF'
test(calendars): drop out-of-order end dates instead of corrupting rows

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Exam-schedule smoke test (unchanged-extractor regression guard)

**Files:**
- Test: `msstate-policies/tests/parsers-term-pages-range.test.ts`

- [ ] **Step 1: Write the test**

Append:

```typescript
test("parseTermPage: exam_schedule extractor unaffected by date-range change", () => {
  const rows = parseTermPage(
    fixture("registrar_exams_2026_spring.html"),
    "exam_schedule",
    {
      url: "https://www.registrar.msstate.edu/students/schedules/exam-schedule/2026/spring",
      year: 2026,
      term: "Spring",
    },
  );
  // Exam rows are always single-day; the time-range lives in the time field, not start/end.
  assert.ok(rows.length > 0, "expected at least one exam row");
  for (const r of rows) {
    assert.equal(r.start, r.end, `exam row should be single-day: ${r.event}`);
  }
});
```

- [ ] **Step 2: Run the test**

Run: `cd msstate-policies && npx tsx --test tests/parsers-term-pages-range.test.ts`
Expected: PASS — exam-schedule rows continue to be single-day with `start == end`.

- [ ] **Step 3: Commit**

```bash
git add msstate-policies/tests/parsers-term-pages-range.test.ts
git commit -m "$(cat <<'EOF'
test(calendars): smoke-test exam-schedule extractor stayed single-day

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Corpus-level guard in `build-worker-corpus.mjs`

**Files:**
- Modify: `scripts/build-worker-corpus.mjs:413-430` (after `out.academic_calendar = { ... }` assignment)

- [ ] **Step 1: Add the guard block**

After the `out.academic_calendar = { rows: calendarPayload.rows, ... }` assignment at `scripts/build-worker-corpus.mjs:413-419`, insert this block (before the courses scrape):

```javascript
  // Sanity guard: registrar term pages must yield at least one multi-day row.
  // If the extractor regresses to single-day-only, abort the build instead of
  // silently shipping a poisoned corpus. See .dev/specs/2026-05-12-...md.
  const multiDayCount = calendarPayload.rows.filter(
    (r) =>
      (r.source === "academic_calendar" || r.source === "sfa_financial_aid") &&
      r.start !== r.end,
  ).length;
  if (multiDayCount === 0) {
    throw new Error(
      "refusing to ship a calendar corpus with zero multi-day ranges",
    );
  }
  console.error(
    `[build-worker-corpus]   academic_calendar+sfa multi-day rows: ${multiDayCount}`,
  );
```

- [ ] **Step 2: Smoke-check the guard's negative path manually**

You don't need to actually rebuild the corpus yet (Task 8 does that). Just visually confirm the guard string appears with a `grep`:

```bash
grep -c "refusing to ship a calendar corpus with zero multi-day ranges" scripts/build-worker-corpus.mjs
```

Expected output: `1`

- [ ] **Step 3: Commit**

```bash
git add scripts/build-worker-corpus.mjs
git commit -m "$(cat <<'EOF'
build(calendars): abort corpus rebuild if zero multi-day rows survive scrape

Guards against a future regression in extractAcademicCalendarRows that
would silently collapse every multi-day registrar event to a single day.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: CAL6 security checklist entry

**Files:**
- Modify: `tools/security-checklist.sh:388-395` (insert new CAL6 after CAL5)
- Modify: `CLAUDE.md` (score references)

- [ ] **Step 1: Add CAL6 to the checklist**

In `tools/security-checklist.sh`, immediately after the CAL5 block ending around line 395 (and before the `# ---- v0.6.0: course catalog security checks ----------------------------------` divider), insert:

```bash
# CAL6: Build aborts if the calendar scrape produces zero multi-day rows.
# Guards against a registrar HTML regression that would collapse every
# range (Spring Break, Fall Break, advising windows) into a single day.
if grep -qF "refusing to ship a calendar corpus with zero multi-day ranges" scripts/build-worker-corpus.mjs; then
  score=$((score + 5))
  note "PASS" "CAL6 build aborts on zero multi-day calendar rows" 5
else
  note "FAIL" "CAL6 build aborts on zero multi-day calendar rows" 5
fi

```

- [ ] **Step 2: Run the checklist**

Run: `bash tools/security-checklist.sh | tail -3`
Expected: ends with the new pass line + a final score of `235`.

- [ ] **Step 3: Update CLAUDE.md score references**

Find every `230` in `CLAUDE.md` that refers to the current score:

```bash
grep -n "230" CLAUDE.md
```

Each location currently saying "still **230**" or "CI hard-gates on `>= 100`; below 230" or similar should become `235`. The historical line `(was 220 pre-v0.6.0, 192 pre-v0.5.0)` is history and **must not change**. Use `Edit` with unique surrounding context for each substitution.

After edits, verify:

```bash
grep -n "230\b" CLAUDE.md
```

Expected: 0 matches.

- [ ] **Step 4: Commit**

```bash
git add tools/security-checklist.sh CLAUDE.md
git commit -m "$(cat <<'EOF'
chore(security): add CAL6 (+5 pts) — score 230 → 235

CAL6 greps for the new build-time abort guard from the calendar
range-extractor fix.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Rebuild bundle, rescrape corpus, verify end-to-end

**Files:**
- Regenerate: `msstate-policies/dist/index.js`, `worker/corpus.json`, `msstate-policies/dist/calendar-synonyms.json` (sidecar)

- [ ] **Step 1: Rebuild the npm bundle**

```bash
cd msstate-policies && npm run build && cd ..
```

Expected: produces a banner line on stderr `// msstate-policies-mcp <ver> <sha> built <iso>` and a fresh `msstate-policies/dist/index.js`. No type errors.

- [ ] **Step 2: Rescrape the worker corpus**

```bash
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" node scripts/build-worker-corpus.mjs
```

Per `CLAUDE.md`, the build requires `ANTHROPIC_API_KEY` for the synonym step. If the key is not set in your environment, ask the user to set it before running this step — do not skip it (the build aborts without it).

Expected: prints per-source row counts, the new `academic_calendar+sfa multi-day rows: <N>` line (N > 0), then the synonym paraphrase progress, then writes `worker/corpus.json`. No throws.

- [ ] **Step 3: Spot-check the corpus**

```bash
grep -A1 '"event": "Fall Break' worker/corpus.json | head -6
grep -A1 '"event": "Spring Break' worker/corpus.json | head -6
```

Expected: each Fall Break row shows `start` and `end` two days apart (e.g. `2026-10-08`/`2026-10-09`). Each Spring Break row shows a 4–5-day span. If `start == end`, the build did not pick up Task 1's code — re-run `npm run build` first.

- [ ] **Step 4: Run the full test suite**

```bash
cd msstate-policies && npm test && cd ..
```

Expected: all tests pass, including the five new ones from Tasks 1–5.

- [ ] **Step 5: Re-run the security checklist**

```bash
bash tools/security-checklist.sh | tail -1
```

Expected: `235`.

- [ ] **Step 6: Commit the regenerated artifacts**

```bash
git add msstate-policies/dist/index.js msstate-policies/dist/calendar-synonyms.json worker/corpus.json
git commit -m "$(cat <<'EOF'
build(calendars): rebuild dist + worker corpus with end-date fix

Multi-day registrar events (Spring/Fall Break, advising windows,
graduation application windows) now ship with the correct end date.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

- Each task is independently committable and produces a meaningful, testable delta.
- All steps include actual code/commands, not placeholders.
- Type names used consistently: `RawRow.isoDateEnd` introduced in Task 1, consumed in Task 1 (parseTermPage). No drift across tasks.
- Task 7 step 3 updates `CLAUDE.md` for the new score — easy to forget; called out explicitly.
- Task 8 calls out the `ANTHROPIC_API_KEY` requirement up-front rather than letting the executor hit it as a runtime surprise.
- Spec coverage: every spec section maps to a task (Solution §1 → Task 1; Solution §2 tests #1–#5 → Tasks 1–5; Solution §3 corpus guard → Task 6; Solution §4 CAL6 → Task 7; Rollout → Task 8).
