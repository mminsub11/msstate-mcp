import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseControllerRateHtml } from "../../src/tuition/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_STK = readFileSync(
  join(here, "..", "fixtures", "tuition", "starkville.html"), "utf8",
);
const URL_STK = "https://www.controller.msstate.edu/accountservices/tuition/starkville-campus";
const FIXTURE_MGCCC = readFileSync(
  join(here, "..", "fixtures", "tuition", "mgccc.html"), "utf8",
);
const URL_MGCCC = "https://www.controller.msstate.edu/accountservices/tuition/mgccc-campus-rates";
const FIXTURE_MERIDIAN = readFileSync(
  join(here, "..", "fixtures", "tuition", "meridian.html"), "utf8",
);
const URL_MERIDIAN = "https://www.controller.msstate.edu/accountservices/tuition/meridian-campus";

describe("parseControllerRateHtml — starkville (both levels)", () => {
  test("returns rows for both undergrad and grad", () => {
    const rows = parseControllerRateHtml(FIXTURE_STK, "starkville", URL_STK);
    assert.ok(rows.some((r) => r.level === "undergrad"));
    assert.ok(rows.some((r) => r.level === "grad"));
  });
  test("every row has rate_basis=per_credit_hour", () => {
    const rows = parseControllerRateHtml(FIXTURE_STK, "starkville", URL_STK);
    for (const r of rows) assert.equal(r.rate_basis, "per_credit_hour");
  });
  test("returns both residency variants for fall_spring undergrad 12-16", () => {
    const rows = parseControllerRateHtml(FIXTURE_STK, "starkville", URL_STK);
    const r12 = rows.filter(
      (r) => r.level === "undergrad" && r.term === "fall_spring" && r.credit_hour_bucket === "12-16",
    );
    assert.ok(r12.some((r) => r.residency === "resident"));
    assert.ok(r12.some((r) => r.residency === "non_resident"));
  });
  test("every row has positive amount_usd and at least one line_item", () => {
    const rows = parseControllerRateHtml(FIXTURE_STK, "starkville", URL_STK);
    for (const r of rows) {
      assert.ok(r.amount_usd > 0, `non-positive amount for ${JSON.stringify(r)}`);
      assert.ok(r.line_items.length > 0);
    }
  });
  test("effective_term is non-empty for every row", () => {
    const rows = parseControllerRateHtml(FIXTURE_STK, "starkville", URL_STK);
    for (const r of rows) assert.ok(r.effective_term.length > 0);
  });
});

describe("parseControllerRateHtml — mgccc (undergrad-only)", () => {
  test("returns no grad rows for MGCCC", () => {
    const rows = parseControllerRateHtml(FIXTURE_MGCCC, "mgccc", URL_MGCCC);
    assert.equal(rows.filter((r) => r.level === "grad").length, 0);
  });
  test("returns undergrad rows for MGCCC", () => {
    const rows = parseControllerRateHtml(FIXTURE_MGCCC, "mgccc", URL_MGCCC);
    assert.ok(rows.filter((r) => r.level === "undergrad").length >= 4);
  });
});

describe("parseControllerRateHtml — Starkville pinned amounts (regression guard)", () => {
  // 1-11 tables have ONE Total row labeled "Total Fee (Per Credit Hour)" —
  // it IS the headline. Prior versions of the parser incorrectly excluded
  // it and summed line_items + the Total row, producing a doubled value
  // ($916.50 instead of $458.25).
  test("undergrad resident fall_spring 1-11 amount_usd is ~$458.25 (not the doubled $916.50)", () => {
    const rows = parseControllerRateHtml(FIXTURE_STK, "starkville", URL_STK);
    const target = rows.find(
      (r) =>
        r.level === "undergrad" &&
        r.residency === "resident" &&
        r.term === "fall_spring" &&
        r.credit_hour_bucket === "1-11",
    );
    assert.ok(target, "starkville undergrad resident 1-11 row missing");
    assert.ok(
      Math.abs(target.amount_usd - 458.25) < 0.5,
      `expected ~$458.25, got $${target.amount_usd}`,
    );
  });
  // 12-16 tables have TWO Total rows. The headline is the per-semester one.
  test("undergrad resident fall_spring 12-16 amount_usd is ~$5,497.50 (per-semester headline)", () => {
    const rows = parseControllerRateHtml(FIXTURE_STK, "starkville", URL_STK);
    const target = rows.find(
      (r) =>
        r.level === "undergrad" &&
        r.residency === "resident" &&
        r.term === "fall_spring" &&
        r.credit_hour_bucket === "12-16",
    );
    assert.ok(target, "starkville undergrad resident 12-16 row missing");
    assert.ok(
      Math.abs(target.amount_usd - 5497.50) < 1,
      `expected ~$5,497.50, got $${target.amount_usd}`,
    );
  });
});

describe("parseControllerRateHtml — meridian source-typo reconciliation", () => {
  // MSU's Meridian non-resident 12-16 Total cell publishes "$14.968.00"
  // (period instead of comma as thousands separator). The parser reconciles
  // by falling back to the line-items sum when Total drifts >5% from it.
  // Line items: $5,422.50 + $9,495.50 + $50.00 + $0.00 = $14,968.00.
  test("non-resident 12-16 amount_usd reconciles to ~$14,968 (not the typoed $14.96)", () => {
    const rows = parseControllerRateHtml(FIXTURE_MERIDIAN, "meridian", URL_MERIDIAN);
    const target = rows.find(
      (r) =>
        r.level === "undergrad" &&
        r.residency === "non_resident" &&
        r.term === "fall_spring" &&
        r.credit_hour_bucket === "12-16",
    );
    assert.ok(target, "meridian non-resident 12-16 row missing");
    assert.ok(
      Math.abs(target.amount_usd - 14968) < 1,
      `expected ~$14,968, got $${target.amount_usd}`,
    );
  });
});
