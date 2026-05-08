/**
 * One-off analysis tool for empirical F2 threshold calibration.
 *
 * For each question in eval/questions.jsonl, runs hybridSearch directly and
 * records the top-10 fused scores plus where (if anywhere) the expected OP
 * appears in the ranking. Tabulates the distribution so we can pick a
 * DEFAULT_MIN_SCORE floor that preserves every currently-passing case.
 *
 * Run from the msstate-policies/ directory:
 *   cd msstate-policies && npx tsx ../scripts/calibrate-thresholds.mts
 *
 * Free: no Anthropic, no judge. Reads embeddings.json from dist/.
 * One network call to fetch the MSU policy index (cached in-process).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Dynamic imports — tsx's CJS->ESM static-export synthesis was dropping
// attachBodiesFromEmbeddings from the named-export shim, so we go through
// the runtime CJS interop bridge which sees the full module shape.
const scraperMod = (await import("../msstate-policies/src/scraper.ts")) as any;
const searchMod = (await import("../msstate-policies/src/search.ts")) as any;
const { fetchIndex } = scraperMod.default ?? scraperMod;
const { indexEntries, hybridSearch, attachBodiesFromEmbeddings } =
  searchMod.default ?? searchMod;

interface Question {
  q: string;
  expected_op_numbers?: string[];
  k?: number;
  notes?: string;
}

interface PerQuestion {
  q: string;
  expected: string[];
  top1Score: number | null;
  top1Slug: string | null;
  expectedRank: number; // -1 if expected not in top-10 (or no expected)
  expectedScore: number | null;
  topScores: number[];
}

const TOP_K = 10;

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const questionsPath = resolve(process.cwd(), "eval", "questions.jsonl");
const lines = readFileSync(questionsPath, "utf8")
  .trim()
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("//"));
const questions: Question[] = lines.map((l) => JSON.parse(l));

console.error(`loaded ${questions.length} questions from ${questionsPath}`);
console.error(`fetching MSU index...`);
const idx = await fetchIndex();
indexEntries(idx.rows);
const ef = attachBodiesFromEmbeddings();
console.error(`index ready: ${idx.rows.length} rows; embeddings: ${ef.attached} slugs / ${ef.chunks} chunks`);

const slugToNumber = new Map(idx.rows.map((r) => [r.slug, r.number]));

const results: PerQuestion[] = [];
for (const q of questions) {
  const hits = await hybridSearch(q.q, { topK: TOP_K });
  const topScores = hits.map((h) => h.score);
  let expectedRank = -1;
  let expectedScore: number | null = null;
  const expected = q.expected_op_numbers ?? [];
  if (expected.length > 0) {
    for (let i = 0; i < hits.length; i++) {
      const opNumber = slugToNumber.get(hits[i].slug);
      if (opNumber && expected.includes(opNumber)) {
        expectedRank = i;
        expectedScore = hits[i].score;
        break;
      }
    }
  }
  results.push({
    q: q.q,
    expected,
    top1Score: hits.length > 0 ? hits[0].score : null,
    top1Slug: hits.length > 0 ? hits[0].slug : null,
    expectedRank,
    expectedScore,
    topScores,
  });
}

// ---- Buckets ---------------------------------------------------------------

const positive = results.filter((r) => r.expected.length > 0); // retrieval-scored
const negative = results.filter((r) => r.expected.length === 0); // refusal-scored

const positivePassing = positive.filter((r) => r.expectedRank >= 0 && r.expectedRank < 5);
const positiveFailing = positive.filter((r) => r.expectedRank < 0 || r.expectedRank >= 5);

console.log("\n=== Question buckets ===");
console.log(`total                    ${results.length}`);
console.log(`positive (has expected)  ${positive.length}`);
console.log(`negative (no expected)   ${negative.length}`);
console.log(`positive passing (k=5)   ${positivePassing.length}`);
console.log(`positive failing (k=5)   ${positiveFailing.length}`);

// ---- Top-1 score distributions --------------------------------------------

function describe(label: string, xs: number[]): void {
  if (xs.length === 0) {
    console.log(`${label}: (empty)`);
    return;
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const med = median(sorted);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? min;
  const p25 = sorted[Math.floor(sorted.length * 0.25)] ?? min;
  console.log(
    `${label}: n=${xs.length}  min=${min.toFixed(4)}  p10=${p10.toFixed(4)}  p25=${p25.toFixed(4)}  median=${med.toFixed(4)}  max=${max.toFixed(4)}`,
  );
}

console.log("\n=== Top-1 fused-score distributions ===");
describe("ALL questions      ", results.map((r) => r.top1Score ?? 0));
describe("positive PASSING   ", positivePassing.map((r) => r.top1Score ?? 0));
describe("positive FAILING   ", positiveFailing.map((r) => r.top1Score ?? 0));
describe("negative (no exp.) ", negative.map((r) => r.top1Score ?? 0));

console.log("\n=== Expected-OP score (where expected was found) ===");
const foundExpectedScores = positive
  .filter((r) => r.expectedScore !== null)
  .map((r) => r.expectedScore as number);
describe("expected-rank score", foundExpectedScores);

// ---- Threshold sweep -------------------------------------------------------

console.log("\n=== Threshold sweep — what % of currently-passing cases survive each floor? ===");
const candidates = [0.005, 0.008, 0.01, 0.012, 0.014, 0.0143, 0.0154, 0.0164, 0.018, 0.02];
console.log("threshold  passing-survives  failing-rejected  negative-rejected");
for (const t of candidates) {
  const passingSurvives = positivePassing.filter((r) => (r.top1Score ?? 0) >= t).length;
  const failingRejected = positiveFailing.filter((r) => (r.top1Score ?? 0) < t).length;
  const negativeRejected = negative.filter((r) => (r.top1Score ?? 0) < t).length;
  console.log(
    `${t.toFixed(4)}     ${passingSurvives}/${positivePassing.length} survive       ${failingRejected}/${positiveFailing.length} reject        ${negativeRejected}/${negative.length} reject`,
  );
}

// ---- Lowest passing top-1 ---------------------------------------------------

console.log("\n=== Lowest-scoring PASSING cases (would be rejected by aggressive thresholds) ===");
const sortedPassing = [...positivePassing].sort(
  (a, b) => (a.top1Score ?? 0) - (b.top1Score ?? 0),
);
for (const r of sortedPassing.slice(0, 5)) {
  console.log(
    `  top1=${(r.top1Score ?? 0).toFixed(4)}  expectedRank=${r.expectedRank}  expectedScore=${(r.expectedScore ?? 0).toFixed(4)}  q="${r.q.slice(0, 80)}"`,
  );
}

console.log("\n=== Highest-scoring NEGATIVE cases (would NOT be rejected by loose thresholds) ===");
const sortedNeg = [...negative].sort((a, b) => (b.top1Score ?? 0) - (a.top1Score ?? 0));
for (const r of sortedNeg.slice(0, 5)) {
  console.log(`  top1=${(r.top1Score ?? 0).toFixed(4)}  q="${r.q.slice(0, 80)}"`);
}
