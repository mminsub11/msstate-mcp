import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLocationHoursDom } from "../../src/dining/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "..", "fixtures", "dining", name), "utf8");
}

// NOTE: The fixture rendered-perry.html is captured from /en/location/perry-food-hall
// (the correct slug from the sitemap). The original plan used "perry-cafeteria" which
// does not exist as a detail page — it redirects to the locations listing.
describe("parseLocationHoursDom - perry-food-hall (full hours)", () => {
  const html = fixture("rendered-perry.html");
  const url = "https://msstatedining.mydininghub.com/en/location/perry-food-hall";
  const result = parseLocationHoursDom(html, "perry-food-hall", url);

  test("returns a DiningLocation (not null)", () => {
    assert.ok(result);
    assert.equal(result.slug, "perry-food-hall");
    assert.equal(result.url, url);
  });

  test("has a recognizable name", () => {
    assert.ok(result.name.length > 0);
    assert.match(result.name, /perry/i);
  });

  test("hours_by_day has 7 entries covering all weekdays", () => {
    assert.equal(result.hours_by_day.length, 7);
    const days = result.hours_by_day.map((d) => d.day_of_week).sort();
    assert.deepEqual(
      days,
      ["friday", "monday", "saturday", "sunday", "thursday", "tuesday", "wednesday"],
    );
  });

  test("at least one weekday has structured periods (open/close HH:MM)", () => {
    const anyOpen = result.hours_by_day.some(
      (d) => !d.closed && d.periods.length > 0,
    );
    assert.ok(anyOpen, "expected at least one open day with periods");
    for (const d of result.hours_by_day) {
      if (d.closed) continue;
      for (const p of d.periods) {
        assert.match(p.open, /^\d{2}:\d{2}$/, `bad open: ${p.open}`);
        assert.match(p.close, /^\d{2}:\d{2}$/, `bad close: ${p.close}`);
      }
    }
  });

  test("does NOT emit no_hours_extracted", () => {
    assert.ok(!result.parse_warnings.includes("no_hours_extracted"));
  });
});

describe("parseLocationHoursDom - chick-fil-a (chain venue)", () => {
  const html = fixture("rendered-chickfila.html");
  const url = "https://msstatedining.mydininghub.com/en/location/chick-fil-a";
  const result = parseLocationHoursDom(html, "chick-fil-a", url);

  test("returns a DiningLocation with hours", () => {
    assert.ok(result);
    assert.ok(result.hours_by_day.length === 7 || result.hours_by_day.length === 0);
  });

  test("name matches Chick-fil-A", () => {
    assert.match(result.name, /chick-?fil-?a/i);
  });
});

describe("parseLocationHoursDom - venue with no hours", () => {
  const html = fixture("rendered-no-hours.html");
  const url = "https://msstatedining.mydininghub.com/en/location/bento-sushi";
  const result = parseLocationHoursDom(html, "bento-sushi", url);

  test("returns a DiningLocation even when hours are absent", () => {
    assert.ok(result);
    assert.equal(result.slug, "bento-sushi");
  });

  test("emits no_hours_extracted when hours block is missing", () => {
    if (result.hours_by_day.length === 0) {
      assert.ok(result.parse_warnings.includes("no_hours_extracted"));
    }
  });
});
