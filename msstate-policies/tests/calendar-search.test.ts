import { test } from "node:test";
import assert from "node:assert/strict";
import {
  indexCalendarRows,
  searchCalendarRows,
} from "../src/calendars/search.js";
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
  {
    source: "housing",
    event: "Halls Close for Spring 2026",
    description: "Students must move out by 12:00 pm.",
    start: "2026-05-15",
    end: "2026-05-15",
    source_url: "https://www.housing.msstate.edu/events/",
    retrieved_at: "2026-05-11T00:00:00Z",
  },
];

test("searchCalendarRows ranks event-title match above description match", () => {
  indexCalendarRows(SAMPLE);
  const hits = searchCalendarRows("spring break");
  assert.ok(hits.length > 0);
  assert.match(hits[0].row.event, /Spring Break/);
});

test("searchCalendarRows: description-only keyword still matches (weight 1)", () => {
  indexCalendarRows(SAMPLE);
  const hits = searchCalendarRows("move out");
  assert.ok(hits.length > 0, "expected description token to surface a hit");
  assert.equal(hits[0].row.source, "housing");
});

test("searchCalendarRows: ambiguous query surfaces multiple year-versions", () => {
  indexCalendarRows(SAMPLE);
  // Query without a year should match BOTH Spring Break rows
  const hits = searchCalendarRows("spring break", 10);
  const breakHits = hits.filter((h) => /Spring Break/i.test(h.row.event));
  assert.ok(breakHits.length >= 2, `expected >= 2 Spring Break hits across years; got ${breakHits.length}`);
  const terms = new Set(breakHits.map((h) => h.row.term));
  assert.equal(terms.size, 2, `expected 2 distinct terms; got ${[...terms]}`);
});

test("searchCalendarRows returns empty for non-matching query", () => {
  indexCalendarRows(SAMPLE);
  const hits = searchCalendarRows("zebra giraffe");
  assert.equal(hits.length, 0);
});
