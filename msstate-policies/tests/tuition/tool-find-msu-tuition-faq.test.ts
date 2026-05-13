import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { find_msu_tuition_faq } from "../../src/tools/find_msu_tuition_faq.js";
import { setTuitionCorpus } from "../../src/tuition/corpus.js";
import { TUITION_DISCLAIMER, MAX_QUERY_CHARS } from "../../src/tuition/types.js";
import type { FaqRow, TuitionCorpus } from "../../src/tuition/types.js";

const FAQ: FaqRow[] = [
  { question: "Why do I need to know my campus?", answer: "Rates differ by campus.", source_url: "x", retrieved_at: "x" },
  { question: "What is the College Fee?", answer: "A per-credit-hour fee.", source_url: "x", retrieved_at: "x" },
  { question: "Do freshmen pay a College Fee?", answer: "No, only sophomores and above.", source_url: "x", retrieved_at: "x" },
];

function corpus(): TuitionCorpus {
  return { builtAt: "x", source: "https://www.controller.msstate.edu/accountservices/tuition", rate_rows: [], fee_rows: [], faq_rows: FAQ, campuses: [] };
}

async function call(args: unknown) {
  const res = await find_msu_tuition_faq.handler(args);
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("find_msu_tuition_faq", () => {
  test("returns top-k results with disclaimer", async () => {
    setTuitionCorpus(corpus());
    const r = await call({ q: "campus" });
    assert.equal(r.disclaimer, TUITION_DISCLAIMER);
    assert.ok(r.matches.length >= 1);
    assert.match(r.matches[0].question, /campus/i);
  });
  test("k=2 caps result count to 2", async () => {
    setTuitionCorpus(corpus());
    const r = await call({ q: "fee", k: 2 });
    assert.ok(r.matches.length <= 2);
  });
  test("rejects q longer than MAX_QUERY_CHARS", async () => {
    setTuitionCorpus(corpus());
    const long = "a".repeat(MAX_QUERY_CHARS + 1);
    await assert.rejects(() => call({ q: long }));
  });
  test("rejects k > 10 via zod", async () => {
    setTuitionCorpus(corpus());
    await assert.rejects(() => call({ q: "campus", k: 20 }));
  });
});
