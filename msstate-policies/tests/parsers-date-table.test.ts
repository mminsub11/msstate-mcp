import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDateTable, parseDateRange } from "../src/calendars/parsers/date_table.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", "calendars", name), "utf8");
}

test("parseDateTable: university_holidays returns >= 5 rows with ISO dates", () => {
  const rows = parseDateTable(
    fixture("hrm_holidays.html"),
    "university_holidays",
  );
  assert.ok(rows.length >= 5, `expected >= 5 holiday rows; got ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.source, "university_holidays");
    assert.match(r.start, /^\d{4}-\d{2}-\d{2}$/, `start not ISO: ${r.start}`);
    assert.match(r.end, /^\d{4}-\d{2}-\d{2}$/, `end not ISO: ${r.end}`);
    assert.ok(r.event.length > 0, "event must be non-empty");
    assert.equal(r.source_url, "https://www.hrm.msstate.edu/benefits/holidays/");
  }
});

test("parseDateTable: at least one row mentions a recognizable holiday", () => {
  const rows = parseDateTable(
    fixture("hrm_holidays.html"),
    "university_holidays",
  );
  const text = rows.map((r) => r.event.toLowerCase()).join(" | ");
  const recognizable = ["christmas", "thanksgiving", "independence", "memorial", "labor"];
  const found = recognizable.some((h) => text.includes(h));
  assert.ok(found, `none of ${recognizable.join(",")} appeared in ${text}`);
});

test("parseDateTable: university_holidays correctly parses multi-day Christmas/Winter holiday range", () => {
  const rows = parseDateTable(
    fixture("hrm_holidays.html"),
    "university_holidays",
  );
  // The MSU fixture contains at least one multi-day Christmas/New Year/Winter block.
  // It must parse as a date range (start !== end) — earlier versions of the regex
  // misparsed "December 23, YYYY, through January D, YYYY+1" as a single-day event.
  const winterBlock = rows.find(
    (r) => /christmas|winter|new\s*year/i.test(r.event) && r.start !== r.end,
  );
  assert.ok(
    winterBlock,
    "expected a multi-day Christmas/Winter/New Year holiday block with start !== end",
  );
  // Sanity: end must be chronologically >= start.
  if (winterBlock) {
    assert.ok(
      winterBlock.start <= winterBlock.end,
      `range out of order: ${winterBlock.start}..${winterBlock.end}`,
    );
  }
});

test("parseDateTable: deduplicates identical event-date rows from the same source", () => {
  const rows = parseDateTable(
    fixture("hrm_holidays.html"),
    "university_holidays",
  );
  const keys = rows.map((r) => `${r.event}|${r.start}`);
  const unique = new Set(keys);
  assert.equal(
    keys.length,
    unique.size,
    `expected no duplicate event-date pairs; found ${keys.length - unique.size} duplicates`,
  );
});

test("parseDateTable: every row has a non-empty citation field", () => {
  const rows = parseDateTable(
    fixture("hrm_holidays.html"),
    "university_holidays",
  );
  for (const r of rows) {
    assert.ok(r.citation.length > 0, `empty citation on row: ${r.event}`);
    assert.match(
      r.citation,
      /^\[.+\]\(https:\/\/.+\.msstate\.edu.+\)$/,
      `malformed citation: ${r.citation}`,
    );
    assert.ok(
      r.citation.includes(r.source_url),
      `citation must contain source_url: ${r.citation}`,
    );
  }
});

describe("date_table — invalid dates", () => {
  test("February 31 is rejected, not normalized to March 3", () => {
    const r = parseDateRange("February 31, 2026");
    assert.equal(r, null);
  });
  test("month=0 / day=0 is rejected", () => {
    assert.equal(parseDateRange("Foobar 0, 2026"), null);
    assert.equal(parseDateRange("January 0, 2026"), null);
  });
  test("April 31 (only 30 days) is rejected", () => {
    assert.equal(parseDateRange("April 31, 2026"), null);
  });
  test("legitimate dates still parse", () => {
    assert.deepEqual(parseDateRange("January 13, 2026"), ["2026-01-13", "2026-01-13"]);
  });
});
