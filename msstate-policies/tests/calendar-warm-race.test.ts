// msstate-policies/tests/calendar-warm-race.test.ts
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setCalendarWarmReady, awaitCalendarWarm, resetCalendarWarmForTests } from "../src/calendars/corpus.js";

describe("calendar warm-up gate", () => {
  beforeEach(() => resetCalendarWarmForTests());

  test("awaitCalendarWarm resolves immediately when no warm registered", async () => {
    await awaitCalendarWarm(); // must not hang or throw
  });

  test("awaitCalendarWarm resolves after the registered promise settles", async () => {
    let resolveWarm: () => void = () => {};
    setCalendarWarmReady(new Promise<void>((r) => { resolveWarm = r; }));
    let warmDone = false;
    const waiter = awaitCalendarWarm().then(() => { warmDone = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(warmDone, false, "must still be waiting before warm resolves");
    resolveWarm();
    await waiter;
    assert.equal(warmDone, true, "must resolve after warm resolves");
  });

  test("awaitCalendarWarm does not reject if the registered promise rejects", async () => {
    setCalendarWarmReady(Promise.reject(new Error("scrape blew up")));
    await awaitCalendarWarm(); // must swallow — handlers degrade, they don't crash
  });
});
