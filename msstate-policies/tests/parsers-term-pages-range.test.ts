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
