import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { get_msu_emergency_contacts } from "../../src/tools/get_msu_emergency_contacts.js";
import { setEmergencyCorpus } from "../../src/emergency/corpus.js";
import { MANDATORY_DISCLAIMER, type EmergencyCorpus } from "../../src/emergency/types.js";

const CORPUS: EmergencyCorpus = {
  builtAt: "2026-05-13T00:00:00Z",
  source: "https://www.emergency.msstate.edu/",
  guidelines: [],
  refuge_areas: [],
  contacts: [
    {
      label: "EMERGENCY",
      phone: "911",
      category: "emergency",
      source_url: "https://www.emergency.msstate.edu/refuge",
      retrieved_at: "2026-05-13T00:00:00Z",
    },
    {
      label: "MSU Police",
      phone: "(662) 325-2121",
      category: "campus_non_emergency",
      source_url: "https://www.emergency.msstate.edu/refuge",
      retrieved_at: "2026-05-13T00:00:00Z",
    },
    {
      label: "Starkville Police",
      phone: "(662) 323-4134",
      category: "off_campus_non_emergency",
      source_url: "https://www.emergency.msstate.edu/refuge",
      retrieved_at: "2026-05-13T00:00:00Z",
    },
  ],
};

before(() => setEmergencyCorpus(CORPUS));

describe("get_msu_emergency_contacts", () => {
  test("category=all returns all rows", async () => {
    const res = await get_msu_emergency_contacts.handler({ category: "all" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.disclaimer, MANDATORY_DISCLAIMER);
    assert.equal(parsed.contacts.length, 3);
  });
  test("category=campus → campus_non_emergency only", async () => {
    const res = await get_msu_emergency_contacts.handler({ category: "campus" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.contacts.length, 1);
    assert.equal(parsed.contacts[0].category, "campus_non_emergency");
  });
  test("category=off_campus → off_campus_non_emergency only", async () => {
    const res = await get_msu_emergency_contacts.handler({ category: "off_campus" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.contacts.length, 1);
  });
  test("unknown category returns empty contacts (recoverable)", async () => {
    const res = await get_msu_emergency_contacts.handler({ category: "weather" });
    const parsed = JSON.parse(res.content[0].text);
    assert.deepEqual(parsed.contacts, []);
    assert.equal(parsed.disclaimer, MANDATORY_DISCLAIMER);
  });
  test("default (no category arg) treats as 'all'", async () => {
    const res = await get_msu_emergency_contacts.handler({});
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.contacts.length, 3);
  });
});
