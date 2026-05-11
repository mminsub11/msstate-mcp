import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTermIndex,
  parseTermPage,
  TERM_INDEX_CONFIG,
} from "../src/calendars/parsers/term_pages.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", "calendars", name), "utf8");
}

// ---- parseTermIndex tests --------------------------------------------------

test("parseTermIndex: academic_calendar index returns >= 8 term entries spanning >= 1 year", () => {
  const entries = parseTermIndex(
    fixture("registrar_academic_index.html"),
    TERM_INDEX_CONFIG.academic_calendar,
  );
  assert.ok(entries.length >= 8, `expected >= 8 academic term entries; got ${entries.length}`);
  for (const e of entries) {
    assert.match(
      e.url,
      /^https:\/\/www\.registrar\.msstate\.edu\/calendars\/academic-calendar\/\d{4}\/[\w-]+$/,
      `URL must match academic term pattern: ${e.url}`,
    );
    assert.match(String(e.year), /^\d{4}$/);
    assert.ok(e.term.length > 0, "term must be non-empty");
  }
  const years = new Set(entries.map((e) => e.year));
  assert.ok(years.size >= 1, "expected >= 1 distinct year");
});

test("parseTermIndex: exam_schedule index returns >= 4 term entries", () => {
  const entries = parseTermIndex(
    fixture("registrar_exams_index.html"),
    TERM_INDEX_CONFIG.exam_schedule,
  );
  assert.ok(entries.length >= 4, `expected >= 4 exam term entries; got ${entries.length}`);
  for (const e of entries) {
    assert.match(
      e.url,
      /^https:\/\/www\.registrar\.msstate\.edu\/students\/schedules\/exam-schedule\/\d{4}\/[\w-]+$/,
      `URL must match exam term pattern: ${e.url}`,
    );
  }
});

// ---- parseTermPage tests ---------------------------------------------------

test("parseTermPage: academic_calendar Spring 2026 sub-page returns >= 5 dated rows", () => {
  const rows = parseTermPage(
    fixture("registrar_academic_2026_spring.html"),
    "academic_calendar",
    {
      url: "https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring",
      year: 2026,
      term: "Spring",
    },
  );
  assert.ok(rows.length >= 5, `expected >= 5 rows for academic Spring 2026; got ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.source, "academic_calendar");
    assert.match(r.start, /^\d{4}-\d{2}-\d{2}$/, `start not ISO: ${r.start}`);
    assert.equal(r.term, "Spring 2026");
    assert.ok(r.event.length > 0);
  }
});

test("parseTermPage: academic_calendar Spring 2026 includes a recognizable break/event", () => {
  const rows = parseTermPage(
    fixture("registrar_academic_2026_spring.html"),
    "academic_calendar",
    {
      url: "https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring",
      year: 2026,
      term: "Spring",
    },
  );
  const text = rows.map((r) => r.event.toLowerCase()).join(" | ");
  const recognizable = ["spring break", "classes", "final", "drop", "withdraw"].some((k) =>
    text.includes(k),
  );
  assert.ok(recognizable, `expected a recognizable academic event in: ${text.slice(0, 300)}`);
});

test("parseTermPage: exam_schedule Spring 2026 sub-page returns >= 3 dated rows", () => {
  const rows = parseTermPage(
    fixture("registrar_exams_2026_spring.html"),
    "exam_schedule",
    {
      url: "https://www.registrar.msstate.edu/students/schedules/exam-schedule/2026/spring",
      year: 2026,
      term: "Spring",
    },
  );
  assert.ok(rows.length >= 3, `expected >= 3 exam rows; got ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.source, "exam_schedule");
    assert.match(r.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(r.term, "Spring 2026");
  }
});

// ---- SFA financial aid tests -----------------------------------------------

test("parseTermIndex: sfa_financial_aid index returns >= 10 term entries", () => {
  const entries = parseTermIndex(
    fixture("sfa_index.html"),
    TERM_INDEX_CONFIG.sfa_financial_aid,
  );
  assert.ok(entries.length >= 10, `expected >= 10 SFA term entries; got ${entries.length}`);
  for (const e of entries) {
    assert.match(
      e.url,
      /^https:\/\/www\.sfa\.msstate\.edu\//,
      `SFA URL must be on sfa.msstate.edu: ${e.url}`,
    );
    assert.match(String(e.year), /^\d{4}$/);
  }
});

test("parseTermPage: sfa_financial_aid Fall 2026 returns >= 3 dated rows", () => {
  const rows = parseTermPage(
    fixture("sfa_term_2026_fall.html"),
    "sfa_financial_aid",
    {
      url: "https://www.sfa.msstate.edu/calendars/academic-calendar/2026/fall",
      year: 2026,
      term: "Fall",
    },
  );
  assert.ok(rows.length >= 3, `expected >= 3 SFA rows; got ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.source, "sfa_financial_aid");
    assert.match(r.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(r.term, "Fall 2026");
  }
});

test("parseTermPage: deduplicates within a single sub-page parse", () => {
  const rows = parseTermPage(
    fixture("registrar_academic_2026_spring.html"),
    "academic_calendar",
    {
      url: "https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring",
      year: 2026,
      term: "Spring",
    },
  );
  const keys = rows.map((r) => `${r.event}|${r.start}`);
  const unique = new Set(keys);
  assert.equal(
    keys.length,
    unique.size,
    `expected no duplicates within a sub-page; found ${keys.length - unique.size}`,
  );
});

test("parseTermPage: every row has a non-empty citation", () => {
  const rows = parseTermPage(
    fixture("registrar_exams_2026_spring.html"),
    "exam_schedule",
    {
      url: "https://www.registrar.msstate.edu/students/schedules/exam-schedule/2026/spring",
      year: 2026,
      term: "Spring",
    },
  );
  for (const r of rows) {
    assert.ok(r.citation.length > 0, `empty citation on row: ${r.event}`);
    assert.match(r.citation, /^\[.+\]\(https:\/\/.+\.msstate\.edu.+\)$/);
    assert.ok(r.citation.includes(r.source_url));
  }
});
