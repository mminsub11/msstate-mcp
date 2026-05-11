import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHousingEvents } from "../src/calendars/parsers/event_list.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", "calendars", name), "utf8");
}

test("parseHousingEvents returns >= 3 events with ISO dates", () => {
  const rows = parseHousingEvents(fixture("housing_events.html"));
  assert.ok(rows.length >= 3, `expected >= 3 events; got ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.source, "housing");
    assert.match(r.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.end, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.event.length > 0);
    assert.equal(r.source_url.startsWith("https://www.housing.msstate.edu"), true);
  }
});

test("parseHousingEvents captures a recognizable housing-shaped event", () => {
  const rows = parseHousingEvents(fixture("housing_events.html"));
  const text = rows.map((r) => r.event.toLowerCase()).join(" | ");
  const hit = ["move-in", "move in", "halls close", "halls open", "holiday", "selection", "move out", "move-out"].some(
    (k) => text.includes(k),
  );
  assert.ok(hit, `expected a housing-shaped event in: ${text.slice(0, 300)}`);
});

test("parseHousingEvents handles date ranges (start !== end) when present", () => {
  const rows = parseHousingEvents(fixture("housing_events.html"));
  const ranged = rows.find((r) => r.start !== r.end);
  if (!ranged) {
    console.warn("parsers-event-list: no date-range row in fixture; skipping range-shape check");
    return;
  }
  assert.ok(ranged.start <= ranged.end, "range must be chronologically ordered");
});

test("parseHousingEvents: deduplicates identical event-date rows", () => {
  const rows = parseHousingEvents(fixture("housing_events.html"));
  const keys = rows.map((r) => `${r.event}|${r.start}`);
  const unique = new Set(keys);
  assert.equal(keys.length, unique.size, "expected no duplicates");
});

test("parseHousingEvents: every row has a non-empty citation", () => {
  const rows = parseHousingEvents(fixture("housing_events.html"));
  for (const r of rows) {
    assert.ok(r.citation.length > 0);
    assert.match(r.citation, /^\[.+\]\(https:\/\/www\.housing\.msstate\.edu.+\)$/);
  }
});
