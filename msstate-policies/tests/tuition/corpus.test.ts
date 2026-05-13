import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  setTuitionCorpus,
  getTuitionCorpus,
  getRateRows,
  getFeeRows,
  getFaqRows,
  getCampuses,
  tuitionCorpusHealth,
} from "../../src/tuition/corpus.js";
import type { TuitionCorpus } from "../../src/tuition/types.js";

const SAMPLE: TuitionCorpus = {
  builtAt: "2026-05-13T00:00:00.000Z",
  source: "https://www.controller.msstate.edu/accountservices/tuition",
  rate_rows: [{
    campus: "starkville", level: "undergrad", residency: "resident", term: "fall_spring",
    rate_basis: "per_credit_hour", credit_hour_bucket: "12-16", amount_usd: 5000,
    line_items: [{ label: "Tuition", amount_usd: 5000 }],
    effective_term: "Fall 2026", source_url: "x", retrieved_at: "2026-05-13T00:00:00.000Z",
  }],
  fee_rows: [{
    kind: "college", label: "College of Engineering",
    per_credit_usd: 50, full_time_cap_usd: 500, flat_amount_usd: null,
    applicability_note: "Sophomore+", source_url: "x", retrieved_at: "2026-05-13T00:00:00.000Z",
  }],
  faq_rows: [{
    question: "Why do I need to know my campus?", answer: "Rates differ.",
    source_url: "x", retrieved_at: "2026-05-13T00:00:00.000Z",
  }],
  campuses: [{
    slug: "starkville", display_name: "Starkville Campus",
    levels_offered: ["undergrad"], rate_basis: "per_credit_hour",
    source_url: "https://www.controller.msstate.edu/accountservices/tuition/starkville-campus",
  }],
};

describe("tuition/corpus", () => {
  test("setTuitionCorpus + getters round-trip", () => {
    setTuitionCorpus(SAMPLE);
    assert.equal(getTuitionCorpus()?.builtAt, SAMPLE.builtAt);
    assert.equal(getRateRows().length, 1);
    assert.equal(getFeeRows().length, 1);
    assert.equal(getFaqRows().length, 1);
    assert.equal(getCampuses().length, 1);
  });
  test("health reports loaded + counts", () => {
    setTuitionCorpus(SAMPLE);
    const h = tuitionCorpusHealth();
    assert.equal(h.loaded, true);
    assert.equal(h.rate_count, 1);
    assert.equal(h.fee_count, 1);
    assert.equal(h.faq_count, 1);
    assert.equal(h.campus_count, 1);
    assert.equal(h.builtAt, SAMPLE.builtAt);
  });
  test("getters return [] when corpus has empty arrays", () => {
    setTuitionCorpus({ ...SAMPLE, rate_rows: [], fee_rows: [], faq_rows: [], campuses: [] });
    assert.deepEqual(getRateRows(), []);
    assert.deepEqual(getFeeRows(), []);
    assert.deepEqual(getFaqRows(), []);
    assert.deepEqual(getCampuses(), []);
  });
});
