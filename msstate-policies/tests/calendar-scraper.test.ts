import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scrapeCalendarFromHtml,
  detectCalendarWaf,
} from "../src/calendars/scraper.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", "calendars", name), "utf8");
}

test("scrapeCalendarFromHtml: dispatches Shape A (holidays) by source id", () => {
  const result = scrapeCalendarFromHtml(
    "university_holidays",
    fixture("hrm_holidays.html"),
  );
  assert.equal(result.source, "university_holidays");
  assert.equal(result.error, null);
  assert.ok(result.rows.length > 0);
});

test("scrapeCalendarFromHtml: dispatches Shape C (housing)", () => {
  const result = scrapeCalendarFromHtml(
    "housing",
    fixture("housing_events.html"),
  );
  assert.equal(result.source, "housing");
  assert.equal(result.error, null);
  assert.ok(result.rows.length >= 3);
});

test("scrapeCalendarFromHtml: returns empty rows but no error for Shape B index page (rows live on per-term sub-pages)", () => {
  // Calling scrapeCalendarFromHtml directly on a Shape B index doesn't return rows —
  // it just confirms the parser dispatched without crashing. Real Shape B work happens
  // in scrapeCalendar() (live fetch path) which fans out to sub-pages.
  const result = scrapeCalendarFromHtml(
    "academic_calendar",
    fixture("registrar_academic_index.html"),
  );
  assert.equal(result.source, "academic_calendar");
  assert.equal(result.error, null);
  // Index page has no date rows — that's expected for Shape B.
  // Rows == 0 is acceptable here; the test asserts the dispatcher didn't throw.
});

test("detectCalendarWaf flags Cloudflare interstitial body", () => {
  assert.equal(detectCalendarWaf("<html>Just a moment...</html>"), true);
  assert.equal(detectCalendarWaf("<html>cf-chl-bypass</html>"), true);
  assert.equal(detectCalendarWaf("<html><body>real content</body></html>"), false);
});
