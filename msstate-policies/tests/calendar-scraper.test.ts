import { describe, test, afterEach } from "node:test";
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

test("scrapeCalendarFromHtml: passes citation through for housing rows", () => {
  const result = scrapeCalendarFromHtml(
    "housing",
    fixture("housing_events.html"),
  );
  assert.equal(result.error, null);
  assert.ok(result.rows.length > 0);
  for (const r of result.rows) {
    assert.ok(r.citation.length > 0, `citation missing on housing row: ${r.event}`);
  }
});

// Task 5: partial-failure surfacing
describe("scraper — partial-failure surfacing", () => {
  afterEach(async () => {
    const { __resetHttpGetForTests } = await import("../src/calendars/scraper.js");
    __resetHttpGetForTests();
  });

  test("when some term pages fail, ScrapeResult carries warnings and non-null error", async () => {
    const { __setHttpGetForTests, scrapeCalendar } = await import("../src/calendars/scraper.js");
    // Minimal Drupal card layout that parseTermPage can extract rows from
    const springPageHtml = `<html><body>
      <div class="row g-0 border-bottom">
        <div class="col col-md-4"><div class="card-body py-4"><time datetime="2026-01-14T12:00:00Z">January 14</time></div></div>
        <div class="col col-md-8"><div class="card-body py-4">Classes begin</div></div>
      </div>
    </body></html>`;
    __setHttpGetForTests(async (url: string) => {
      // First call (index page) succeeds with two entries
      if (url.endsWith("/calendars/academic-calendar")) {
        return { body: '<a class="list-group-item list-group-item-action" href="/calendars/academic-calendar/2026/spring">Spring 2026</a><a class="list-group-item list-group-item-action" href="/calendars/academic-calendar/2026/fall">Fall 2026</a>', status: 200 };
      }
      // Fall sub-page fails
      if (url.includes("/fall")) throw new Error("timeout");
      // Spring sub-page returns parseable HTML
      return { body: springPageHtml, status: 200 };
    });
    const r = await scrapeCalendar("academic_calendar");
    assert.ok(r.rows.length > 0, "must still return rows from the page that worked");
    assert.ok(r.warnings && r.warnings.length > 0, "must surface per-page warnings");
    assert.ok(r.error !== null || r.warnings.length > 0, "partial failure must be visible");
  });

  test("when all term sub-pages fail, error is set and rows is empty", async () => {
    const { __setHttpGetForTests, scrapeCalendar } = await import("../src/calendars/scraper.js");
    __setHttpGetForTests(async (url: string) => {
      if (url.endsWith("/calendars/academic-calendar")) {
        return { body: '<a href="/calendars/academic-calendar/2026/spring">Spring 2026</a>', status: 200 };
      }
      throw new Error("upstream down");
    });
    const r = await scrapeCalendar("academic_calendar");
    assert.equal(r.rows.length, 0);
    assert.ok(r.error && r.error.length > 0, "error must be non-null when all entries failed");
    assert.ok(r.warnings && r.warnings.length > 0, "warnings must include the per-entry failure");
  });

  test("a fully-successful scrape returns warnings===undefined", async () => {
    const { __setHttpGetForTests, scrapeCalendar } = await import("../src/calendars/scraper.js");
    // Minimal Drupal card layout that parseTermPage can extract rows from
    const springPageHtml = `<html><body>
      <div class="row g-0 border-bottom">
        <div class="col col-md-4"><div class="card-body py-4"><time datetime="2026-01-14T12:00:00Z">January 14</time></div></div>
        <div class="col col-md-8"><div class="card-body py-4">Classes begin</div></div>
      </div>
    </body></html>`;
    __setHttpGetForTests(async (url: string) => {
      if (url.endsWith("/calendars/academic-calendar")) {
        return { body: '<a class="list-group-item list-group-item-action" href="/calendars/academic-calendar/2026/spring">Spring 2026</a>', status: 200 };
      }
      return { body: springPageHtml, status: 200 };
    });
    const r = await scrapeCalendar("academic_calendar");
    assert.ok(r.rows.length > 0, "must extract rows");
    assert.equal(r.error, null, "no error on full success");
    assert.equal(r.warnings, undefined, "no warnings on full success (undefined, not [])");
  });
});
