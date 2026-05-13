import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { __setScraperForTests, loadCalendarSource, getCalendarsCorpusHealth, resetCalendarCacheForTests } from "../src/calendars/corpus.js";
import type { ScrapeResult } from "../src/calendars/types.js";

describe("calendar negative cache TTL", () => {
  beforeEach(() => {
    resetCalendarCacheForTests();
  });

  test("a fresh error entry retries after the negative TTL elapses", async () => {
    let calls = 0;
    __setScraperForTests(async (): Promise<ScrapeResult> => {
      calls++;
      if (calls === 1) return { source: "housing", rows: [], error: "WAF challenge" };
      return { source: "housing", rows: [{ source: "housing", event: "X", start: "2026-01-01", end: "2026-01-01", source_url: "https://x", citation: "[X](https://x)" } as any], error: null };
    });
    const r1 = await loadCalendarSource("housing");
    assert.equal(r1.error, "WAF challenge");
    // Within the 5-minute negative TTL, a second call must HIT the cache:
    const r2 = await loadCalendarSource("housing");
    assert.equal(calls, 1, "second call within negative TTL must hit cache, not retry");
    assert.equal(r2.error, "WAF challenge");
    // After expiring the entry, the next call retries and succeeds:
    resetCalendarCacheForTests({ keepLastGood: true });
    const r3 = await loadCalendarSource("housing");
    assert.equal(calls, 2, "after expiry, must retry the scraper");
    assert.equal(r3.error, null);
    assert.equal(r3.rows.length, 1);
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
    resetCalendarCacheForTests({ keepLastGood: true });
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
