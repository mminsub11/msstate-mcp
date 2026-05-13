import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { find_msu_severe_weather_refuge } from "../../src/tools/find_msu_severe_weather_refuge.js";
import { setEmergencyCorpus } from "../../src/emergency/corpus.js";
import { MANDATORY_DISCLAIMER, type EmergencyCorpus } from "../../src/emergency/types.js";

const CORPUS: EmergencyCorpus = {
  builtAt: "2026-05-13T00:00:00Z",
  source: "https://www.emergency.msstate.edu/",
  guidelines: [],
  refuge_areas: [
    {
      building: "Colvard Student Union",
      area: "Room 123",
      note: "Normal operations only.",
      source_url: "https://www.emergency.msstate.edu/refuge",
      retrieved_at: "2026-05-13T00:00:00Z",
    },
    {
      building: "Lee Hall",
      area: "Basement",
      note: null,
      source_url: "https://www.emergency.msstate.edu/refuge",
      retrieved_at: "2026-05-13T00:00:00Z",
    },
  ],
  contacts: [],
};

before(() => setEmergencyCorpus(CORPUS));

describe("find_msu_severe_weather_refuge", () => {
  test("fuzzy substring match returns the right row + disclaimer + scope_note", async () => {
    const res = await find_msu_severe_weather_refuge.handler({ building_name: "colvard" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.disclaimer, MANDATORY_DISCLAIMER);
    assert.match(parsed.scope_note, /Severe-weather/i);
    assert.equal(parsed.matches[0].building, "Colvard Student Union");
  });
  test("no match returns fallback_when_no_match with the interior-room guidance", async () => {
    const res = await find_msu_severe_weather_refuge.handler({ building_name: "Random Cottage" });
    const parsed = JSON.parse(res.content[0].text);
    assert.deepEqual(parsed.matches, []);
    assert.match(parsed.fallback_when_no_match.guidance, /lowest interior level/i);
  });
  test("rejects oversized input", async () => {
    await assert.rejects(
      find_msu_severe_weather_refuge.handler({ building_name: "x".repeat(5000) }),
    );
  });
});
