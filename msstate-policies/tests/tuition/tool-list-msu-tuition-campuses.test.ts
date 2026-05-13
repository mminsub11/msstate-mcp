import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { list_msu_tuition_campuses } from "../../src/tools/list_msu_tuition_campuses.js";
import { setTuitionCorpus } from "../../src/tuition/corpus.js";
import { TUITION_DISCLAIMER } from "../../src/tuition/types.js";
import type { CampusEntry, TuitionCorpus } from "../../src/tuition/types.js";

const CAMPUSES: CampusEntry[] = [
  { slug: "starkville", display_name: "Starkville Campus", levels_offered: ["undergrad", "grad"], rate_basis: "per_credit_hour", source_url: "x" },
  { slug: "meridian",   display_name: "Meridian Campus",   levels_offered: ["undergrad", "grad"], rate_basis: "per_credit_hour", source_url: "x" },
  { slug: "mgccc",      display_name: "MGCCC — Engineering on the Coast", levels_offered: ["undergrad"], rate_basis: "per_credit_hour", source_url: "x" },
  { slug: "online",     display_name: "MSU Online Education", levels_offered: ["undergrad", "grad"], rate_basis: "per_credit_hour", source_url: "x" },
  { slug: "vetmed",     display_name: "College of Veterinary Medicine (DVM)", levels_offered: ["dvm"], rate_basis: "annual_flat", source_url: "x" },
];

function corpus(): TuitionCorpus {
  return { builtAt: "x", source: "https://www.controller.msstate.edu/accountservices/tuition", rate_rows: [], fee_rows: [], faq_rows: [], campuses: CAMPUSES };
}

async function call() {
  const res = await list_msu_tuition_campuses.handler({});
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("list_msu_tuition_campuses", () => {
  test("returns 5 entries with disclaimer", async () => {
    setTuitionCorpus(corpus());
    const r = await call();
    assert.equal(r.disclaimer, TUITION_DISCLAIMER);
    assert.equal(r.campuses.length, 5);
  });
  test("mgccc entry has levels_offered=['undergrad']", async () => {
    setTuitionCorpus(corpus());
    const r = await call();
    const mgccc = r.campuses.find((c: CampusEntry) => c.slug === "mgccc");
    assert.deepEqual(mgccc.levels_offered, ["undergrad"]);
  });
  test("vetmed entry has rate_basis=annual_flat", async () => {
    setTuitionCorpus(corpus());
    const r = await call();
    const vet = r.campuses.find((c: CampusEntry) => c.slug === "vetmed");
    assert.equal(vet.rate_basis, "annual_flat");
  });
});
