/**
 * Tuition search/routing. Two responsibilities:
 *   1. BM25 over FAQ rows (question x2, answer x1; k1=1.2, b=0.75).
 *   2. Deterministic routing for rate + fee lookups (no scoring).
 */
import type {
  CampusSlug,
  CreditHourBucket,
  FaqRow,
  FeeKind,
  FeeRow,
  Level,
  Residency,
  Term,
  TuitionRateRow,
} from "./types.js";

const TOKEN_SPLIT = /[\s\-_/.,;:()\[\]{}!?"'`<>|@#$%^&*=+]+/;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const FIELD_WEIGHTS = { question: 2, answer: 1 } as const;

function tokenize(input: string): string[] {
  return input.normalize("NFKC").toLowerCase().split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

interface IndexedFaq {
  row: FaqRow;
  qTokens: string[];
  aTokens: string[];
  dl: number;
}

let faqDocs: IndexedFaq[] = [];
let faqDf = new Map<string, number>();
let faqAvgLen = 0;

export function indexFaqRows(rows: FaqRow[]): void {
  faqDocs = rows.map((row) => {
    const qTokens = tokenize(row.question);
    const aTokens = tokenize(row.answer);
    return { row, qTokens, aTokens, dl: qTokens.length + aTokens.length };
  });
  faqDf = new Map();
  let total = 0;
  for (const d of faqDocs) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.qTokens, ...d.aTokens]) {
      if (seen.has(t)) continue;
      seen.add(t);
      faqDf.set(t, (faqDf.get(t) ?? 0) + 1);
    }
  }
  faqAvgLen = faqDocs.length > 0 ? total / faqDocs.length : 0;
}

function idf(token: string): number {
  const n = faqDocs.length;
  const dfi = faqDf.get(token) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}

function bm25Term(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (faqAvgLen || 1));
  return idfV * ((tf * (BM25_K1 + 1)) / denom);
}

function countOf(token: string, arr: string[]): number {
  let c = 0;
  for (const t of arr) if (t === token) c++;
  return c;
}

export interface FaqHit { row: FaqRow; score: number; }

export function bm25SearchFaq(query: string, k: number): FaqHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const out: FaqHit[] = [];
  for (const d of faqDocs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = idf(q);
      if (idfQ === 0) continue;
      s += FIELD_WEIGHTS.question * bm25Term(countOf(q, d.qTokens), d.dl, idfQ);
      s += FIELD_WEIGHTS.answer   * bm25Term(countOf(q, d.aTokens), d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, Math.min(k, out.length)));
}

// ---- Rate routing -------------------------------------------------------

export interface RateRequest {
  campus: CampusSlug;
  level: Level;
  residency: Residency;
  term?: Term;
  credit_hours?: number;
}

export interface RateRouteResult {
  matches: TuitionRateRow[];
  not_found_reason?: string;
}

export function pickCreditHourBucket(level: Level, hours: number): CreditHourBucket | null {
  if (level === "undergrad") {
    if (hours >= 1 && hours <= 11) return "1-11";
    if (hours >= 12) return "12-16"; // cap >16 to the flat full-time bucket
    return null;
  }
  if (level === "grad") {
    if (hours >= 1 && hours <= 8) return "1-8";
    if (hours >= 9) return "9+";
    return null;
  }
  return null; // dvm: no bucket
}

export function routeRateRequest(rows: TuitionRateRow[], req: RateRequest): RateRouteResult {
  if (req.campus === "vetmed" && req.level !== "dvm") {
    return {
      matches: [],
      not_found_reason:
        "Vetmed publishes tuition for the DVM program only. For graduate-level MS/PhD vet med programs, see Starkville graduate rates.",
    };
  }
  if (req.level === "dvm" && req.campus !== "vetmed") {
    return {
      matches: [],
      not_found_reason:
        "DVM tuition is published only by the College of Veterinary Medicine. See campus=vetmed.",
    };
  }
  if (req.campus === "mgccc" && req.level === "grad") {
    return {
      matches: [],
      not_found_reason:
        "MGCCC partnership covers undergraduate engineering only — graduate students enroll on the Starkville campus.",
    };
  }
  let filtered = rows.filter(
    (r) => r.campus === req.campus && r.level === req.level && r.residency === req.residency,
  );
  if (req.term) filtered = filtered.filter((r) => r.term === req.term);
  if (req.campus === "vetmed") return { matches: filtered };

  if (typeof req.credit_hours === "number") {
    const bucket = pickCreditHourBucket(req.level, req.credit_hours);
    if (bucket) {
      filtered = filtered.filter((r) => r.credit_hour_bucket === bucket || r.credit_hour_bucket === null);
    }
  }
  return { matches: filtered };
}

// ---- Fee filter ---------------------------------------------------------

export function filterFeeRows(rows: FeeRow[], kind: FeeKind, filter: string | undefined): FeeRow[] {
  let out = rows.filter((r) => r.kind === kind);
  const f = (filter ?? "").trim().toLowerCase();
  if (f.length > 0) out = out.filter((r) => r.label.toLowerCase().includes(f));
  return out;
}
