import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { get_msu_tuition_rate } from "../../src/tools/get_msu_tuition_rate.js";
import { setTuitionCorpus } from "../../src/tuition/corpus.js";
import { TUITION_DISCLAIMER } from "../../src/tuition/types.js";
import type { TuitionCorpus, TuitionRateRow } from "../../src/tuition/types.js";

function rate(over: Partial<TuitionRateRow>): TuitionRateRow {
  return {
    campus: "starkville", level: "undergrad", residency: "resident", term: "fall_spring",
    rate_basis: "per_credit_hour", credit_hour_bucket: "12-16", amount_usd: 5000,
    line_items: [{ label: "Tuition", amount_usd: 5000 }],
    effective_term: "Fall 2026 or Spring 2027",
    source_url: "https://www.controller.msstate.edu/accountservices/tuition/starkville-campus",
    retrieved_at: "2026-05-13T00:00:00.000Z",
    ...over,
  };
}

function corpus(rate_rows: TuitionRateRow[]): TuitionCorpus {
  return {
    builtAt: "2026-05-13T00:00:00.000Z",
    source: "https://www.controller.msstate.edu/accountservices/tuition",
    rate_rows, fee_rows: [], faq_rows: [], campuses: [],
  };
}

async function call(args: unknown) {
  const res = await get_msu_tuition_rate.handler(args);
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("get_msu_tuition_rate", () => {
  test("returns matching row + disclaimer on happy path", async () => {
    setTuitionCorpus(corpus([rate({})]));
    const r = await call({ campus: "starkville", level: "undergrad", residency: "resident", credit_hours: 15 });
    assert.equal(r.disclaimer, TUITION_DISCLAIMER);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].amount_usd, 5000);
  });
  test("returns empty matches + not_found_reason on mgccc+grad", async () => {
    setTuitionCorpus(corpus([rate({ campus: "mgccc" })]));
    const r = await call({ campus: "mgccc", level: "grad", residency: "resident" });
    assert.equal(r.matches.length, 0);
    assert.match(r.not_found_reason, /undergraduate/i);
    assert.equal(r.disclaimer, TUITION_DISCLAIMER);
  });
  test("rejects credit_hours out of range via zod", async () => {
    setTuitionCorpus(corpus([rate({})]));
    await assert.rejects(
      () => call({ campus: "starkville", level: "undergrad", residency: "resident", credit_hours: 99 }),
    );
  });
  test("rejects unknown campus via zod enum", async () => {
    setTuitionCorpus(corpus([rate({})]));
    await assert.rejects(
      () => call({ campus: "tupelo", level: "undergrad", residency: "resident" }),
    );
  });
});
