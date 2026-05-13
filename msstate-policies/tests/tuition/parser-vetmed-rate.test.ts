import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVetmedRateHtml } from "../../src/tuition/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(here, "..", "fixtures", "tuition", "vetmed.html"), "utf8",
);
const VETMED_URL = "https://www.vetmed.msstate.edu/tuition";

describe("parseVetmedRateHtml", () => {
  test("returns at least two rate rows (resident + non-resident)", () => {
    const rows = parseVetmedRateHtml(FIXTURE, VETMED_URL);
    assert.ok(rows.length >= 2);
  });
  test("every row has level=dvm and campus=vetmed", () => {
    const rows = parseVetmedRateHtml(FIXTURE, VETMED_URL);
    for (const r of rows) {
      assert.equal(r.level, "dvm");
      assert.equal(r.campus, "vetmed");
    }
  });
  test("rate_basis is annual_flat or per_semester_flat", () => {
    const rows = parseVetmedRateHtml(FIXTURE, VETMED_URL);
    for (const r of rows) {
      assert.ok(r.rate_basis === "annual_flat" || r.rate_basis === "per_semester_flat");
    }
  });
  test("credit_hour_bucket is null for every vetmed row", () => {
    const rows = parseVetmedRateHtml(FIXTURE, VETMED_URL);
    for (const r of rows) assert.equal(r.credit_hour_bucket, null);
  });
  test("has both resident and non_resident rows", () => {
    const rows = parseVetmedRateHtml(FIXTURE, VETMED_URL);
    assert.ok(rows.some((r) => r.residency === "resident"));
    assert.ok(rows.some((r) => r.residency === "non_resident"));
  });
  test("effective_term mentions Fall 2025", () => {
    const rows = parseVetmedRateHtml(FIXTURE, VETMED_URL);
    assert.ok(rows.every((r) => /fall.*2025/i.test(r.effective_term)));
  });
});
