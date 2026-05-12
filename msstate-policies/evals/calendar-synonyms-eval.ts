/**
 * Synonym eval — runs baseline (synonyms stripped) and synonyms (loaded normally)
 * against the live indexed corpus, reports top-3 recall per bucket.
 *
 * Run: npx tsx evals/calendar-synonyms-eval.ts
 *
 * Ground-truth event-title prefixes verified against worker/corpus.json at
 * authoring time. When the corpus is rebuilt, re-run Step 1 of Task 10.
 */
import { loadAllCalendarRows } from "../src/calendars/corpus.js";
import { indexCalendarRows, searchCalendarRows } from "../src/calendars/search.js";
import type { CalendarRow } from "../src/calendars/types.js";

interface EvalCase {
  q: string;
  expected_event_prefixes: string[];
}

const SEMANTIC_GAP: EvalCase[] = [
  { q: "when does the semester start", expected_event_prefixes: ["Classes begin"] },
  { q: "when does school start spring 2027", expected_event_prefixes: ["Classes begin"] },
  { q: "turkey day", expected_event_prefixes: ["Thanksgiving"] },
  { q: "deadline to pay tuition", expected_event_prefixes: ["Deadline for payment"] },
  { q: "spring break dates", expected_event_prefixes: ["Spring Break"] },
  { q: "labor day off", expected_event_prefixes: ["Labor Day"] },
  { q: "fall semester ends", expected_event_prefixes: ["Last day of classes", "Classes end"] },
  { q: "graduation ceremony", expected_event_prefixes: ["Commencement"] },
  { q: "Christmas break", expected_event_prefixes: ["Winter Break", "Christmas"] },
  { q: "memorial day closed", expected_event_prefixes: ["Memorial Day"] },
  { q: "july 4th holiday", expected_event_prefixes: ["Independence Day"] },
  { q: "drop deadline", expected_event_prefixes: ["Last day to drop"] },
  { q: "exam week", expected_event_prefixes: ["Final Examinations", "Final Exam"] },
  { q: "tuition due", expected_event_prefixes: ["Deadline for payment"] },
  { q: "back to school", expected_event_prefixes: ["Classes begin"] },
];

const BM25_FAVORABLE: EvalCase[] = [
  { q: "final examinations spring 2026", expected_event_prefixes: ["Final Examinations", "Final Exam"] },
  { q: "commencement december 2026", expected_event_prefixes: ["Commencement"] },
  { q: "thanksgiving holiday 2026", expected_event_prefixes: ["Thanksgiving"] },
  { q: "spring break spring 2026", expected_event_prefixes: ["Spring Break"] },
  { q: "labor day holiday", expected_event_prefixes: ["Labor Day"] },
  { q: "last day to drop spring 2026", expected_event_prefixes: ["Last day to drop"] },
  { q: "classes begin spring 2026", expected_event_prefixes: ["Classes begin"] },
  { q: "independence day holiday", expected_event_prefixes: ["Independence Day"] },
  { q: "memorial day holiday", expected_event_prefixes: ["Memorial Day"] },
  { q: "deadline for payment in full", expected_event_prefixes: ["Deadline for payment"] },
];

const SMART_FALLBACK: EvalCase[] = [
  { q: "grad student spring 2027 schedule", expected_event_prefixes: ["Classes begin"] },
  { q: "housing event spring 2026 academic dates", expected_event_prefixes: ["Classes begin", "Spring Break"] },
  { q: "financial aid fall 2026 important dates", expected_event_prefixes: ["Classes begin", "Last day"] },
  { q: "exam schedule spring 2027 graduate", expected_event_prefixes: ["Classes begin", "Final Exam"] },
  { q: "tuition deadline fall 2026 housing", expected_event_prefixes: ["Deadline for payment", "Classes begin"] },
];

function runOne(c: EvalCase): boolean {
  const hits = searchCalendarRows(c.q, 10);
  const top3 = hits.slice(0, 3).map((h) => h.row.event);
  return c.expected_event_prefixes.some((prefix) =>
    top3.some((event) => event.startsWith(prefix)),
  );
}

function evalBucket(cases: EvalCase[]): number {
  let hits = 0;
  for (const c of cases) if (runOne(c)) hits++;
  return hits;
}

async function main() {
  const rows = await loadAllCalendarRows();

  const buckets: Array<[string, EvalCase[]]> = [
    ["semantic_gap", SEMANTIC_GAP],
    ["bm25_favorable", BM25_FAVORABLE],
    ["smart_fallback", SMART_FALLBACK],
  ];

  const baselineRows: CalendarRow[] = rows.map((r) => ({ ...r, synonyms: [] }));
  indexCalendarRows(baselineRows);
  const baseline: Record<string, number> = {};
  for (const [name, cases] of buckets) baseline[name] = evalBucket(cases);

  indexCalendarRows(rows);
  const withSyn: Record<string, number> = {};
  for (const [name, cases] of buckets) withSyn[name] = evalBucket(cases);

  console.log("Bucket            Baseline    Synonyms    Δ");
  for (const [name, cases] of buckets) {
    const b = baseline[name];
    const s = withSyn[name];
    const dPct = ((s - b) / cases.length) * 100;
    const sign = dPct >= 0 ? "+" : "";
    console.log(
      `${name.padEnd(18)} ${b}/${cases.length}       ${s}/${cases.length}       ${sign}${dPct.toFixed(1)}pp`,
    );
  }

  const sgLift = ((withSyn.semantic_gap - baseline.semantic_gap) / SEMANTIC_GAP.length) * 100;
  const bfRegression = ((baseline.bm25_favorable - withSyn.bm25_favorable) / BM25_FAVORABLE.length) * 100;
  let exitCode = 0;
  if (sgLift < 10) {
    console.error(`\nFAIL: semantic_gap lift ${sgLift.toFixed(1)}pp < 10pp ship-blocker threshold`);
    exitCode = 1;
  }
  if (bfRegression > 5) {
    console.error(`\nFAIL: bm25_favorable regression ${bfRegression.toFixed(1)}pp > 5pp ship-blocker threshold`);
    exitCode = 1;
  }
  if (exitCode === 0) console.log("\nPASS: all bucket targets met");
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("eval crashed:", err);
  process.exit(2);
});
