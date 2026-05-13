import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { get_msu_enrollment_fees } from "../../src/tools/get_msu_enrollment_fees.js";
import { setTuitionCorpus } from "../../src/tuition/corpus.js";
import { TUITION_DISCLAIMER, MAX_QUERY_CHARS } from "../../src/tuition/types.js";
import type { FeeRow, TuitionCorpus } from "../../src/tuition/types.js";

const FEE_ROWS: FeeRow[] = [
  { kind: "college", label: "College of Engineering", per_credit_usd: 50, full_time_cap_usd: 500, flat_amount_usd: null, applicability_note: "", source_url: "x", retrieved_at: "x" },
  { kind: "college", label: "College of Arts and Sciences", per_credit_usd: 25, full_time_cap_usd: 250, flat_amount_usd: null, applicability_note: "", source_url: "x", retrieved_at: "x" },
  { kind: "program", label: "Honors College", per_credit_usd: null, full_time_cap_usd: null, flat_amount_usd: 75, applicability_note: "", source_url: "x", retrieved_at: "x" },
];

function corpus(): TuitionCorpus {
  return { builtAt: "x", source: "https://www.controller.msstate.edu/accountservices/tuition", rate_rows: [], fee_rows: FEE_ROWS, faq_rows: [], campuses: [] };
}

async function call(args: unknown) {
  const res = await get_msu_enrollment_fees.handler(args);
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("get_msu_enrollment_fees", () => {
  test("kind=college returns all college rows", async () => {
    setTuitionCorpus(corpus());
    const r = await call({ kind: "college" });
    assert.equal(r.matches.length, 2);
    assert.equal(r.disclaimer, TUITION_DISCLAIMER);
  });
  test("filter='engineering' narrows the result", async () => {
    setTuitionCorpus(corpus());
    const r = await call({ kind: "college", filter: "engineering" });
    assert.equal(r.matches.length, 1);
    assert.match(r.matches[0].label, /Engineering/);
  });
  test("rejects filter longer than MAX_QUERY_CHARS", async () => {
    setTuitionCorpus(corpus());
    const long = "a".repeat(MAX_QUERY_CHARS + 1);
    await assert.rejects(() => call({ kind: "college", filter: long }));
  });
});
