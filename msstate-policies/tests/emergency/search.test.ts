import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { setEmergencyCorpus } from "../../src/emergency/corpus.js";
import { indexGuidelines, resolveGuideline, findRefugeArea } from "../../src/emergency/search.js";
import type { EmergencyCorpus } from "../../src/emergency/types.js";

const CORPUS: EmergencyCorpus = {
  builtAt: "2026-05-13T00:00:00Z",
  source: "https://www.emergency.msstate.edu/",
  guidelines: [
    {
      slug: "severe-weather-tornado",
      title: "Severe Weather & Tornado",
      url: "https://www.emergency.msstate.edu/guidelines/severe-weather-tornado",
      body_markdown: "Take refuge in a lowest interior room away from windows.",
      aliases: ["tornado", "severe weather", "thunderstorm"],
      retrieved_at: "2026-05-13T00:00:00Z",
    },
    {
      slug: "sheltering-in-place",
      title: "Sheltering in Place",
      url: "https://www.emergency.msstate.edu/guidelines/sheltering-in-place",
      body_markdown: "Lock doors. Shelter in a small interior room.",
      aliases: ["shelter", "shelter in place", "lockdown"],
      retrieved_at: "2026-05-13T00:00:00Z",
    },
    {
      slug: "smoke-fire",
      title: "Smoke & Fire",
      url: "https://www.emergency.msstate.edu/guidelines/smoke-fire",
      body_markdown: "Evacuate via the nearest exit. Do not use elevators.",
      aliases: ["fire", "smoke"],
      retrieved_at: "2026-05-13T00:00:00Z",
    },
  ],
  refuge_areas: [
    { building: "Colvard Student Union", area: "Room 123", note: "Normal operations only.", source_url: "https://www.emergency.msstate.edu/refuge", retrieved_at: "2026-05-13T00:00:00Z" },
    { building: "Mitchell Memorial Library", area: "First-floor rooms", note: null, source_url: "https://www.emergency.msstate.edu/refuge", retrieved_at: "2026-05-13T00:00:00Z" },
    { building: "Lee Hall", area: "Basement hallway", note: null, source_url: "https://www.emergency.msstate.edu/refuge", retrieved_at: "2026-05-13T00:00:00Z" },
  ],
  contacts: [],
};

before(() => setEmergencyCorpus(CORPUS));

describe("resolveGuideline", () => {
  test("exact slug match wins", () => {
    const r = resolveGuideline("severe-weather-tornado");
    assert.equal(r.matched?.slug, "severe-weather-tornado");
    assert.equal(r.via, "exact_slug");
  });
  test("alias match resolves through the map", () => {
    const r = resolveGuideline("tornado");
    assert.equal(r.matched?.slug, "severe-weather-tornado");
    assert.equal(r.via, "alias");
  });
  test("alias is case-insensitive and trims", () => {
    assert.equal(resolveGuideline("  TORNADO  ").matched?.slug, "severe-weather-tornado");
  });
  test("BM25 fallback when no slug or alias matches", () => {
    const r = resolveGuideline("there is a fire in the building");
    assert.equal(r.matched?.slug, "smoke-fire");
    assert.equal(r.via, "bm25");
    assert.ok(r.did_you_mean.length <= 2);
  });
  test("no plausible match returns null + suggestions", () => {
    const r = resolveGuideline("xyzzy plugh");
    assert.equal(r.matched, null);
    assert.ok(r.suggestions.length >= 1);
  });
});

describe("findRefugeArea", () => {
  test("substring match (case-insensitive)", () => {
    const r = findRefugeArea("colvard");
    assert.equal(r[0]?.building, "Colvard Student Union");
  });
  test("BM25 fallback when no substring matches", () => {
    const r = findRefugeArea("library");
    assert.equal(r[0]?.building, "Mitchell Memorial Library");
  });
  test("returns empty when nothing relevant", () => {
    assert.deepEqual(findRefugeArea("xyzzy plugh"), []);
  });
});

describe("resolveGuideline — confidence threshold", () => {
  test("strong alias-driven query keeps the match", () => {
    indexGuidelines([
      { slug: "severe-weather", title: "Severe Weather", url: "x", body_markdown: "Seek refuge during a tornado.", aliases: ["tornado", "twister"], retrieved_at: "t" },
      { slug: "active-shooter", title: "Active Shooter", url: "x", body_markdown: "Run, hide, fight.", aliases: ["gunman"], retrieved_at: "t" },
    ] as any);
    const r = resolveGuideline("tornado warning");
    assert.equal(r.matched?.slug, "severe-weather");
    assert.equal(r.via, "bm25");
    assert.ok(r.score > 0);
  });

  test("ambiguous low-signal query yields matched=null + suggestions", () => {
    indexGuidelines([
      { slug: "severe-weather", title: "Severe Weather", url: "x", body_markdown: "Seek refuge during a tornado.", aliases: ["tornado", "twister"], retrieved_at: "t" },
      { slug: "active-shooter", title: "Active Shooter", url: "x", body_markdown: "Run, hide, fight.", aliases: ["gunman"], retrieved_at: "t" },
    ] as any);
    const r = resolveGuideline("the");
    assert.equal(r.matched, null, "weak query must not produce a confident match");
    assert.equal(r.via, "none");
    assert.ok(
      r.did_you_mean.length > 0 || r.suggestions.length > 0,
      "must surface candidates so the user can pick",
    );
  });

  test("score is exposed even when matched is null", () => {
    indexGuidelines([
      { slug: "severe-weather", title: "Severe Weather", url: "x", body_markdown: "x", aliases: [], retrieved_at: "t" },
    ] as any);
    const r = resolveGuideline("nonexistent garbage query that won't tokenize");
    assert.equal(typeof r.score, "number");
  });
});
