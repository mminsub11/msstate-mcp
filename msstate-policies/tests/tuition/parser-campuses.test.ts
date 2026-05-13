import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCampusList } from "../../src/tuition/parser.js";
import type { TuitionRateRow } from "../../src/tuition/types.js";

function rate(campus: TuitionRateRow["campus"], level: TuitionRateRow["level"]): TuitionRateRow {
  return {
    campus, level, residency: "resident", term: "fall_spring",
    rate_basis: "per_credit_hour", credit_hour_bucket: "1-11",
    amount_usd: 1, line_items: [], effective_term: "x",
    source_url: "https://www.controller.msstate.edu/accountservices/tuition",
    retrieved_at: "1970-01-01T00:00:00.000Z",
  };
}

describe("buildCampusList", () => {
  test("returns 5 entries when all campuses have at least one row", () => {
    const list = buildCampusList([
      rate("starkville", "undergrad"), rate("starkville", "grad"),
      rate("meridian", "undergrad"),   rate("meridian", "grad"),
      rate("mgccc", "undergrad"),
      rate("online", "undergrad"),     rate("online", "grad"),
      { ...rate("vetmed", "dvm"), rate_basis: "annual_flat", credit_hour_bucket: null },
    ]);
    assert.equal(list.length, 5);
  });
  test("MGCCC entry has levels_offered=['undergrad'] only", () => {
    const list = buildCampusList([rate("mgccc", "undergrad")]);
    const mgccc = list.find((c) => c.slug === "mgccc");
    assert.ok(mgccc);
    assert.deepEqual(mgccc.levels_offered, ["undergrad"]);
  });
  test("vetmed entry has rate_basis=annual_flat", () => {
    const list = buildCampusList([
      { ...rate("vetmed", "dvm"), rate_basis: "annual_flat", credit_hour_bucket: null },
    ]);
    const vet = list.find((c) => c.slug === "vetmed");
    assert.ok(vet);
    assert.equal(vet.rate_basis, "annual_flat");
  });
});
