import { test } from "node:test";
import assert from "node:assert/strict";
import { gateRetrieval, FusedHit } from "../src/search.js";

const hit = (slug: string, score: number): FusedHit => ({
  slug,
  score,
  bm25Rank: 1,
  embedRank: 1,
  snippet: "",
});

test("gateRetrieval rejects empty/low-score sets and respects margin", () => {
  // Empty input -> reject with structured reason.
  const empty = gateRetrieval([], { minScore: 0.01, minMargin: 0 });
  assert.equal(empty.accept.length, 0);
  assert.equal(empty.rejected, true);
  assert.match(empty.reason ?? "", /no candidates|empty/i);

  // Confident top-1 above floor -> accept.
  const oneAbove = gateRetrieval([hit("0104", 0.025)], { minScore: 0.01, minMargin: 0 });
  assert.equal(oneAbove.accept.length, 1);
  assert.equal(oneAbove.rejected, false);
  assert.equal(oneAbove.accept[0].slug, "0104");

  // All hits below floor -> reject.
  const allBelow = gateRetrieval(
    [hit("0104", 0.005), hit("0309", 0.003)],
    { minScore: 0.01, minMargin: 0 },
  );
  assert.equal(allBelow.accept.length, 0);
  assert.equal(allBelow.rejected, true);
  assert.match(allBelow.reason ?? "", /below floor|insufficient/i);

  // Top-1 within margin of top-2 -> reject (cannot disambiguate).
  const tightMargin = gateRetrieval(
    [hit("0104", 0.025), hit("0309", 0.024)],
    { minScore: 0.01, minMargin: 0.005 },
  );
  assert.equal(tightMargin.rejected, true);
  assert.match(tightMargin.reason ?? "", /margin/i);

  // Same hits but with margin=0 -> accept (margin gate disabled).
  const noMargin = gateRetrieval(
    [hit("0104", 0.025), hit("0309", 0.024)],
    { minScore: 0.01, minMargin: 0 },
  );
  assert.equal(noMargin.rejected, false);
  assert.equal(noMargin.accept.length, 2);
});
