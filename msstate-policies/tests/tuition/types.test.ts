import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  TUITION_ROOTS,
  TUITION_DISCLAIMER,
  MAX_QUERY_CHARS,
  EXPECTED_CAMPUS_SLUGS,
  TuitionWafError,
} from "../../src/tuition/types.js";

describe("tuition/types", () => {
  test("TUITION_ROOTS is frozen and msstate.edu-only", () => {
    assert.ok(Object.isFrozen(TUITION_ROOTS));
    for (const u of TUITION_ROOTS) {
      assert.match(u, /^https:\/\/www\.(controller|vetmed)\.msstate\.edu\//);
    }
  });
  test("TUITION_ROOTS contains exactly 9 URLs", () => {
    assert.equal(TUITION_ROOTS.length, 9);
  });
  test("TUITION_ROOTS includes vetmed tuition URL", () => {
    assert.ok(TUITION_ROOTS.includes("https://www.vetmed.msstate.edu/tuition"));
  });
  test("EXPECTED_CAMPUS_SLUGS has exactly 5 entries", () => {
    assert.equal(EXPECTED_CAMPUS_SLUGS.length, 5);
    for (const s of ["starkville", "meridian", "mgccc", "online", "vetmed"]) {
      assert.ok(EXPECTED_CAMPUS_SLUGS.includes(s as never), `missing: ${s}`);
    }
  });
  test("TUITION_DISCLAIMER mentions controller.msstate.edu", () => {
    assert.match(TUITION_DISCLAIMER, /controller\.msstate\.edu/);
    assert.match(TUITION_DISCLAIMER, /subject to change/i);
  });
  test("MAX_QUERY_CHARS is 4096 (project-wide cap)", () => {
    assert.equal(MAX_QUERY_CHARS, 4096);
  });
  test("TuitionWafError carries the offending URL", () => {
    const e = new TuitionWafError("https://www.controller.msstate.edu/foo");
    assert.equal(e.name, "TuitionWafError");
    assert.match(e.message, /WAF/);
    assert.equal(e.url, "https://www.controller.msstate.edu/foo");
  });
});
