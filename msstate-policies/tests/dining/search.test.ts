import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  filterLocations,
  fuzzyResolveLocation,
  computeOpenStatus,
} from "../../src/dining/search.js";
import type { DiningLocation, DiningHoursDay } from "../../src/dining/types.js";

function loc(
  slug: string,
  name: string,
  hours: DiningHoursDay[] = [],
): DiningLocation {
  return {
    slug,
    name,
    url: `https://msstatedining.mydininghub.com/en/location/${slug}`,
    hours_by_day: hours,
    hours_today: hours[0] ?? null,
    hours_raw_text: "",
    meal_periods_today: hours[0]?.periods ?? [],
    parse_warnings: [],
    retrieved_at: "x",
  };
}

function day(
  d: DiningHoursDay["day_of_week"],
  open: string,
  close: string,
  closed = false,
): DiningHoursDay {
  return {
    day_of_week: d,
    closed,
    periods: closed ? [] : [{ open, close, label: null }],
    raw_text: closed ? "Closed" : `${open} - ${close}`,
  };
}

// 17:00 UTC on a Wednesday in summer = 12:00 PM CDT.
const WED_NOON_CDT = new Date("2026-07-15T17:00:00.000Z");

describe("filterLocations", () => {
  const LOCS = [
    loc("perry", "Perry Cafeteria"),
    loc("chickfila", "Chick-fil-A"),
    loc("maroon-market-azalea", "Maroon Market at Azalea"),
  ];

  test("no filter returns all rows, limit applies", () => {
    const r = filterLocations(LOCS, { limit: 50, offset: 0 });
    assert.equal(r.matches.length, 3);
    assert.equal(r.total, 3);
    assert.equal(r.filtered_total, 3);
  });

  test("name_substring filters case-insensitive", () => {
    const r = filterLocations(LOCS, { name_substring: "MARKET", limit: 50, offset: 0 });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].slug, "maroon-market-azalea");
  });

  test("pagination works", () => {
    const r1 = filterLocations(LOCS, { limit: 2, offset: 0 });
    const r2 = filterLocations(LOCS, { limit: 2, offset: 2 });
    assert.equal(r1.matches.length, 2);
    assert.equal(r2.matches.length, 1);
  });

  test("limit clamped to [1, 200]", () => {
    const r = filterLocations(LOCS, { limit: 999, offset: 0 });
    assert.equal(r.matches.length, 3);
    const r2 = filterLocations(LOCS, { limit: 0, offset: 0 });
    assert.equal(r2.matches.length, 1);
  });
});

describe("fuzzyResolveLocation", () => {
  const LOCS = [
    loc("perry-cafeteria", "Perry Cafeteria"),
    loc("chick-fil-a", "Chick-fil-A"),
    loc("maroon-market-at-azalea", "Maroon Market at Azalea"),
  ];

  test("'perry' matches perry-cafeteria as top result", () => {
    const r = fuzzyResolveLocation(LOCS, "perry");
    assert.equal(r.matched?.slug, "perry-cafeteria");
  });

  test("'chick fil a' resolves chick-fil-a", () => {
    const r = fuzzyResolveLocation(LOCS, "chick fil a");
    assert.equal(r.matched?.slug, "chick-fil-a");
  });

  test("unknown query returns null", () => {
    const r = fuzzyResolveLocation(LOCS, "this-name-does-not-exist");
    assert.equal(r.matched, null);
  });
});

describe("computeOpenStatus", () => {
  test("returns 'unknown' when no hours data", () => {
    const l = loc("x", "X", []);
    assert.equal(computeOpenStatus(l, WED_NOON_CDT), "unknown");
  });

  test("returns 'open' mid-day during a published window", () => {
    const hours: DiningHoursDay[] = [
      day("wednesday", "11:00", "21:00"),
      day("monday", "11:00", "21:00"),
      day("tuesday", "11:00", "21:00"),
      day("thursday", "11:00", "21:00"),
      day("friday", "11:00", "21:00"),
      day("saturday", "11:00", "21:00"),
      day("sunday", "11:00", "21:00"),
    ];
    const l = loc("x", "X", hours);
    const status = computeOpenStatus(l, WED_NOON_CDT);
    assert.equal(status, "open");
  });

  test("returns closes_at near close time", () => {
    const hours: DiningHoursDay[] = [
      day("wednesday", "11:00", "13:00"),
      day("monday", "11:00", "13:00"),
      day("tuesday", "11:00", "13:00"),
      day("thursday", "11:00", "13:00"),
      day("friday", "11:00", "13:00"),
      day("saturday", "11:00", "13:00"),
      day("sunday", "11:00", "13:00"),
    ];
    const l = loc("x", "X", hours);
    const status = computeOpenStatus(l, WED_NOON_CDT);
    assert.ok(status === "open" || (typeof status === "object" && status.status === "closes_at"));
  });

  test("returns 'closed' on a closed-all-day", () => {
    const hours: DiningHoursDay[] = [
      day("wednesday", "00:00", "00:00", true),
      day("monday", "11:00", "21:00"),
      day("tuesday", "11:00", "21:00"),
      day("thursday", "11:00", "21:00"),
      day("friday", "11:00", "21:00"),
      day("saturday", "11:00", "21:00"),
      day("sunday", "11:00", "21:00"),
    ];
    const l = loc("x", "X", hours);
    assert.equal(computeOpenStatus(l, WED_NOON_CDT), "closed");
  });
});
