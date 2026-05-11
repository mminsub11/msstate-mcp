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

test("find_msu_date: triggers fallback when term mentioned and <2 academic_calendar matches", async () => {
  // Sample corpus where grad has rows for Spring 2026 but NOT Spring 2027,
  // academic_calendar has rows for both.
  const sample: CalendarRow[] = [
    {
      source: "grad_school_calendar",
      event: "Comprehensive Exams",
      start: "2026-04-15",
      end: "2026-04-15",
      term: "Spring 2026",
      source_url: "https://www.grad.msstate.edu/sites/www.grad.msstate.edu/files/2026-01/Spring%202026.pdf",
      retrieved_at: "2026-05-11T00:00:00Z",
      citation: "[Comprehensive Exams, Spring 2026](https://www.grad.msstate.edu/sites/www.grad.msstate.edu/files/2026-01/Spring%202026.pdf)",
    },
    {
      source: "academic_calendar",
      event: "Classes begin",
      start: "2027-01-13",
      end: "2027-01-13",
      term: "Spring 2027",
      source_url: "https://www.registrar.msstate.edu/calendars/academic-calendar/2027/spring",
      retrieved_at: "2026-05-11T00:00:00Z",
      citation: "[Classes begin, Spring 2027](https://www.registrar.msstate.edu/calendars/academic-calendar/2027/spring)",
    },
    {
      source: "academic_calendar",
      event: "Spring Break",
      start: "2027-03-08",
      end: "2027-03-12",
      term: "Spring 2027",
      source_url: "https://www.registrar.msstate.edu/calendars/academic-calendar/2027/spring",
      retrieved_at: "2026-05-11T00:00:00Z",
      citation: "[Spring Break, Spring 2027](https://www.registrar.msstate.edu/calendars/academic-calendar/2027/spring)",
    },
  ];
  indexCalendarRows(sample);
  const res = await find_msu_date.handler({ q: "graduate spring 2027 schedule" });
  const payload = JSON.parse(res.content[0].text);
  const fallbackRows = payload.matches.filter((m: { fallback?: boolean }) => m.fallback);
  assert.ok(
    fallbackRows.length >= 1,
    `expected fallback rows; got ${fallbackRows.length} (notes: ${payload.notes})`,
  );
  for (const f of fallbackRows) {
    assert.equal(f.source, "academic_calendar");
    assert.equal(f.term, "Spring 2027");
  }
});

test("find_msu_date: skips fallback when query has no term reference", async () => {
  indexCalendarRows([
    {
      source: "grad_school_calendar",
      event: "Comprehensive Exams",
      start: "2026-04-15",
      end: "2026-04-15",
      term: "Spring 2026",
      source_url: "https://www.grad.msstate.edu/example.pdf",
      retrieved_at: "2026-05-11T00:00:00Z",
      citation: "[Comprehensive Exams, Spring 2026](https://www.grad.msstate.edu/example.pdf)",
    },
  ]);
  const res = await find_msu_date.handler({ q: "graduate exams" });
  const payload = JSON.parse(res.content[0].text);
  const fallbackRows = payload.matches.filter((m: { fallback?: boolean }) => m.fallback);
  assert.equal(fallbackRows.length, 0, "no fallback when no term in query");
});

test("find_msu_date: skips fallback when academic_calendar already dominates results", async () => {
  // Corpus has both a non-academic Spring 2026 row AND 3 academic Spring 2026 rows.
  // Fallback should skip because nonAcademicForTerm > 0 (the housing row covers Spring 2026).
  const acRows: CalendarRow[] = ["Classes begin", "Last day to drop", "Spring Break"].map((event, i) => ({
    source: "academic_calendar" as const,
    event,
    start: `2026-03-0${i + 1}`,
    end: `2026-03-0${i + 1}`,
    term: "Spring 2026",
    source_url: "https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring",
    retrieved_at: "2026-05-11T00:00:00Z",
    citation: `[${event}, Spring 2026](https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring)`,
  }));
  const housingRow: CalendarRow = {
    source: "housing",
    event: "Halls Close for Spring 2026",
    start: "2026-05-15",
    end: "2026-05-15",
    term: "Spring 2026",
    source_url: "https://www.housing.msstate.edu/events/",
    retrieved_at: "2026-05-11T00:00:00Z",
    citation: "[Halls Close for Spring 2026, Spring 2026](https://www.housing.msstate.edu/events/)",
  };
  indexCalendarRows([...acRows, housingRow]);
  const res = await find_msu_date.handler({ q: "spring 2026 academic dates" });
  const payload = JSON.parse(res.content[0].text);
  const fallbackRows = payload.matches.filter((m: { fallback?: boolean }) => m.fallback);
  assert.equal(fallbackRows.length, 0, "no fallback when non-academic source already covers the term");
});
