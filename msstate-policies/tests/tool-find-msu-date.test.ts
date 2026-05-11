import { test } from "node:test";
import assert from "node:assert/strict";
import { indexCalendarRows } from "../src/calendars/search.js";
import { find_msu_date } from "../src/tools/find_msu_date.js";
import type { CalendarRow } from "../src/calendars/types.js";

const SAMPLE: CalendarRow[] = [
  {
    source: "academic_calendar",
    event: "Spring Break",
    start: "2026-03-09",
    end: "2026-03-13",
    term: "Spring 2026",
    source_url: "https://www.registrar.msstate.edu/calendars/academic-calendar",
    retrieved_at: "2026-05-11T00:00:00Z",
  },
  {
    source: "academic_calendar",
    event: "Spring Break",
    start: "2027-03-08",
    end: "2027-03-12",
    term: "Spring 2027",
    source_url: "https://www.registrar.msstate.edu/calendars/academic-calendar",
    retrieved_at: "2026-05-11T00:00:00Z",
  },
  {
    source: "university_holidays",
    event: "Thanksgiving Break",
    start: "2026-11-25",
    end: "2026-11-27",
    source_url: "https://www.hrm.msstate.edu/benefits/holidays/",
    retrieved_at: "2026-05-11T00:00:00Z",
  },
];

test("find_msu_date returns shaped result on a hit", async () => {
  indexCalendarRows(SAMPLE);
  const res = await find_msu_date.handler({ q: "when is spring break" });
  const payload = JSON.parse(res.content[0].text);
  assert.ok(Array.isArray(payload.matches));
  assert.ok(payload.matches.length >= 1);
  assert.match(payload.matches[0].event, /Spring Break/);
  assert.match(payload.matches[0].start, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof payload.notes, "string");
});

test("find_msu_date surfaces ALL year-versions on ambiguous query (multi-year UX)", async () => {
  indexCalendarRows(SAMPLE);
  const res = await find_msu_date.handler({ q: "when is spring break" });
  const payload = JSON.parse(res.content[0].text);
  const breakMatches = payload.matches.filter((m: { event: string }) =>
    /Spring Break/i.test(m.event),
  );
  assert.ok(
    breakMatches.length >= 2,
    `expected >= 2 Spring Break matches across years; got ${breakMatches.length}`,
  );
  const terms = new Set(breakMatches.map((m: { term: string }) => m.term));
  assert.equal(terms.size, 2, `expected 2 distinct terms; got ${[...terms]}`);
});

test("find_msu_date returns empty matches with notes on no-hit", async () => {
  indexCalendarRows(SAMPLE);
  const res = await find_msu_date.handler({ q: "zebra giraffe rhinoceros" });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.matches.length, 0);
  assert.ok(payload.notes.length > 0);
});

test("find_msu_date rejects empty query via zod schema", async () => {
  await assert.rejects(() => find_msu_date.handler({ q: "" }));
});

test("find_msu_date rejects oversize query (>4096 chars)", async () => {
  const big = "x".repeat(5000);
  await assert.rejects(() => find_msu_date.handler({ q: big }));
});
