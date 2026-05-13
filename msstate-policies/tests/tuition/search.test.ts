import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  indexFaqRows,
  bm25SearchFaq,
  routeRateRequest,
  filterFeeRows,
} from "../../src/tuition/search.js";
import type {
  FaqRow,
  FeeRow,
  TuitionRateRow,
  CampusSlug,
  Level,
  Residency,
  Term,
} from "../../src/tuition/types.js";

function faq(question: string, answer: string): FaqRow {
  return {
    question, answer,
    source_url: "https://www.controller.msstate.edu/accountservices/tuition/frequently-asked-questions",
    retrieved_at: "1970-01-01T00:00:00.000Z",
  };
}
function rate(
  campus: CampusSlug, level: Level, residency: Residency, term: Term, bucket: TuitionRateRow["credit_hour_bucket"],
): TuitionRateRow {
  return {
    campus, level, residency, term,
    rate_basis: campus === "vetmed" ? "annual_flat" : "per_credit_hour",
    credit_hour_bucket: bucket,
    amount_usd: 1, line_items: [], effective_term: "x",
    source_url: "x", retrieved_at: "1970-01-01T00:00:00.000Z",
  };
}

describe("bm25SearchFaq", () => {
  test("ranks the exact question first", () => {
    indexFaqRows([
      faq("Why do I need to know my campus?", "Because rates differ."),
      faq("What is the College Fee?", "A per-credit-hour fee."),
      faq("Do freshmen pay a College Fee?", "Yes."),
    ]);
    const hits = bm25SearchFaq("Why do I need to know my campus?", 3);
    assert.equal(hits[0].row.question, "Why do I need to know my campus?");
  });
  test("returns empty array for empty query", () => {
    indexFaqRows([faq("Q1", "A1")]);
    assert.deepEqual(bm25SearchFaq("", 3), []);
  });
  test("k caps result count", () => {
    indexFaqRows([
      faq("College Fee?", "A1"), faq("Program Fee?", "A2"), faq("Online Fee?", "A3"),
    ]);
    const hits = bm25SearchFaq("fee", 2);
    assert.ok(hits.length <= 2);
  });
});

describe("routeRateRequest — rejects", () => {
  test("vetmed campus with non-dvm level → reject_reason", () => {
    const r = routeRateRequest([], { campus: "vetmed", level: "undergrad", residency: "resident" });
    assert.equal(r.matches.length, 0);
    assert.match(r.not_found_reason ?? "", /DVM program only/i);
  });
  test("dvm level with non-vetmed campus → reject_reason", () => {
    const r = routeRateRequest([], { campus: "starkville", level: "dvm", residency: "resident" });
    assert.equal(r.matches.length, 0);
    assert.match(r.not_found_reason ?? "", /College of Veterinary Medicine/i);
  });
  test("mgccc + grad → reject_reason", () => {
    const r = routeRateRequest([], { campus: "mgccc", level: "grad", residency: "resident" });
    assert.equal(r.matches.length, 0);
    assert.match(r.not_found_reason ?? "", /undergraduate/i);
  });
});

describe("routeRateRequest — hits", () => {
  const corpus: TuitionRateRow[] = [
    rate("starkville", "undergrad", "resident",     "fall_spring", "1-11"),
    rate("starkville", "undergrad", "resident",     "fall_spring", "12-16"),
    rate("starkville", "undergrad", "non_resident", "fall_spring", "12-16"),
    rate("starkville", "grad",      "resident",     "fall_spring", "9+"),
    rate("vetmed",     "dvm",       "resident",     "annual",      null),
  ];
  test("credit_hours=15 picks the 12-16 bucket", () => {
    const r = routeRateRequest(corpus, {
      campus: "starkville", level: "undergrad", residency: "resident", credit_hours: 15,
    });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].credit_hour_bucket, "12-16");
  });
  test("credit_hours=8 (undergrad) picks the 1-11 bucket", () => {
    const r = routeRateRequest(corpus, {
      campus: "starkville", level: "undergrad", residency: "resident", credit_hours: 8,
    });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].credit_hour_bucket, "1-11");
  });
  test("credit_hours=20 (undergrad) caps to 12-16 bucket", () => {
    const r = routeRateRequest(corpus, {
      campus: "starkville", level: "undergrad", residency: "resident", credit_hours: 20,
    });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].credit_hour_bucket, "12-16");
  });
  test("credit_hours=9 (grad) picks 9+ bucket", () => {
    const r = routeRateRequest(corpus, {
      campus: "starkville", level: "grad", residency: "resident", credit_hours: 9,
    });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].credit_hour_bucket, "9+");
  });
  test("omitting credit_hours returns all bucket variants", () => {
    const r = routeRateRequest(corpus, {
      campus: "starkville", level: "undergrad", residency: "resident",
    });
    assert.equal(r.matches.length, 2);
  });
  test("vetmed dvm ignores credit_hours, returns the flat row", () => {
    const r = routeRateRequest(corpus, {
      campus: "vetmed", level: "dvm", residency: "resident", credit_hours: 7,
    });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].rate_basis, "annual_flat");
  });
});

describe("filterFeeRows", () => {
  const rows: FeeRow[] = [
    { kind: "college", label: "College of Engineering", per_credit_usd: 50, full_time_cap_usd: 500, flat_amount_usd: null, applicability_note: "", source_url: "x", retrieved_at: "x" },
    { kind: "college", label: "College of Arts and Sciences", per_credit_usd: 25, full_time_cap_usd: 250, flat_amount_usd: null, applicability_note: "", source_url: "x", retrieved_at: "x" },
    { kind: "program", label: "Honors College", per_credit_usd: null, full_time_cap_usd: null, flat_amount_usd: 75, applicability_note: "", source_url: "x", retrieved_at: "x" },
  ];
  test("kind filter returns matching rows only", () => {
    const r = filterFeeRows(rows, "college", undefined);
    assert.equal(r.length, 2);
    for (const x of r) assert.equal(x.kind, "college");
  });
  test("filter substring is case-insensitive", () => {
    const r = filterFeeRows(rows, "college", "engineering");
    assert.equal(r.length, 1);
    assert.match(r[0].label, /Engineering/);
  });
  test("empty filter returns all rows of the kind", () => {
    const r = filterFeeRows(rows, "program", "");
    assert.equal(r.length, 1);
  });
});
