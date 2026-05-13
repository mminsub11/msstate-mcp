import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { get_msu_emergency_guideline } from "../../src/tools/get_msu_emergency_guideline.js";
import { setEmergencyCorpus } from "../../src/emergency/corpus.js";
import type { EmergencyCorpus } from "../../src/emergency/types.js";
import { MANDATORY_DISCLAIMER } from "../../src/emergency/types.js";

const CORPUS: EmergencyCorpus = {
  builtAt: "2026-05-13T00:00:00Z",
  source: "https://www.emergency.msstate.edu/",
  guidelines: [
    { slug: "severe-weather-tornado", title: "Severe Weather & Tornado", url: "https://www.emergency.msstate.edu/guidelines/severe-weather-tornado", body_markdown: "Take refuge.", aliases: ["tornado","severe weather"], retrieved_at: "2026-05-13T00:00:00Z" },
    { slug: "smoke-fire", title: "Smoke & Fire", url: "https://www.emergency.msstate.edu/guidelines/smoke-fire", body_markdown: "Evacuate.", aliases: ["fire","smoke"], retrieved_at: "2026-05-13T00:00:00Z" },
  ],
  refuge_areas: [],
  contacts: [
    { label: "EMERGENCY", phone: "911", category: "emergency", source_url: "https://www.emergency.msstate.edu/refuge", retrieved_at: "2026-05-13T00:00:00Z" },
    { label: "MSU Police", phone: "(662) 325-2121", category: "campus_non_emergency", source_url: "https://www.emergency.msstate.edu/refuge", retrieved_at: "2026-05-13T00:00:00Z" },
  ],
};

before(() => setEmergencyCorpus(CORPUS));

describe("get_msu_emergency_guideline", () => {
  test("alias resolves to matched guideline", async () => {
    const res = await get_msu_emergency_guideline.handler({ emergency_type: "tornado" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.disclaimer, MANDATORY_DISCLAIMER);
    assert.equal(parsed.matched.slug, "severe-weather-tornado");
    assert.ok(parsed.contacts_quick.find((c: { phone: string }) => c.phone === "911"));
  });
  test("exact slug match", async () => {
    const res = await get_msu_emergency_guideline.handler({ emergency_type: "smoke-fire" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.matched.slug, "smoke-fire");
  });
  test("unknown input returns matched=null with suggestions", async () => {
    const res = await get_msu_emergency_guideline.handler({ emergency_type: "xyzzy plugh" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.matched, null);
    assert.ok(Array.isArray(parsed.suggestions));
    assert.equal(parsed.disclaimer, MANDATORY_DISCLAIMER);
  });
  test("rejects oversized input", async () => {
    await assert.rejects(
      get_msu_emergency_guideline.handler({ emergency_type: "a".repeat(5000) }),
    );
  });
  test("rejects empty input", async () => {
    await assert.rejects(get_msu_emergency_guideline.handler({ emergency_type: "" }));
  });
});
