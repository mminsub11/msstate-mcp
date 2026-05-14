import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { list_msu_dining_locations } from "../../src/tools/list_msu_dining_locations.js";
import { setDiningCorpus } from "../../src/dining/corpus.js";
import { DINING_DISCLAIMER, MAX_QUERY_CHARS } from "../../src/dining/types.js";
import type { DiningCorpus, DiningLocation } from "../../src/dining/types.js";

function loc(slug: string, name: string): DiningLocation {
  return {
    slug, name,
    url: `https://msstatedining.mydininghub.com/en/location/${slug}`,
    hours_by_day: [], hours_today: null, hours_raw_text: "",
    meal_periods_today: [], parse_warnings: [],
    retrieved_at: "x",
  };
}

function corpus(locations: DiningLocation[]): DiningCorpus {
  return {
    builtAt: "2026-05-14T09:00:00.000Z",
    source: "https://msstatedining.mydininghub.com/",
    locations,
  };
}

async function call(args: unknown) {
  const res = await list_msu_dining_locations.handler(args);
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("list_msu_dining_locations", () => {
  test("returns disclaimer + rows", async () => {
    setDiningCorpus(corpus([loc("perry-food-hall", "Perry Food Hall")]));
    const r = await call({});
    assert.equal(r.disclaimer, DINING_DISCLAIMER);
    assert.ok(r.matches.length >= 1);
    assert.equal(r.matches[0].slug, "perry-food-hall");
  });

  test("filter by name_substring", async () => {
    setDiningCorpus(corpus([
      loc("perry-food-hall", "Perry Food Hall"),
      loc("chick-fil-a", "Chick-fil-A"),
    ]));
    const r = await call({ name_substring: "perry" });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].slug, "perry-food-hall");
  });

  test("rejects out-of-range limit", async () => {
    setDiningCorpus(corpus([loc("a", "A")]));
    await assert.rejects(() => call({ limit: 500 }));
  });

  test("rejects name_substring longer than MAX_QUERY_CHARS", async () => {
    setDiningCorpus(corpus([loc("a", "A")]));
    const long = "x".repeat(MAX_QUERY_CHARS + 1);
    await assert.rejects(() => call({ name_substring: long }));
  });

  test("includes corpus_built_at", async () => {
    setDiningCorpus(corpus([loc("a", "A")]));
    const r = await call({});
    assert.equal(r.corpus_built_at, "2026-05-14T09:00:00.000Z");
  });
});
