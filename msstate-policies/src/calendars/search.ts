/**
 * BM25 search over calendar rows.
 *
 * Fields indexed (weighted):
 *   event       — weight 3 (most semantic)
 *   description — weight 1
 *   term        — weight 1
 *
 * Returns up to `limit` hits, sorted by score desc.
 */
import type { CalendarRow } from "./types.js";

const TOKEN_SPLIT = /[\s\-_/.,;:()\[\]{}!?"'`<>|@#$%^&*=+]+/;

function tokenize(input: string): string[] {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0);
}

interface IndexedDoc {
  row: CalendarRow;
  eventTokens: string[];
  descriptionTokens: string[];
  termTokens: string[];
  dl: number;
}

const FIELD_WEIGHTS = { event: 3, description: 1, term: 1 } as const;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

let docs: IndexedDoc[] = [];
let df = new Map<string, number>();
let avgLen = 0;

export function indexCalendarRows(rows: CalendarRow[]): void {
  docs = rows.map((r) => {
    const eventTokens = tokenize(r.event);
    const descriptionTokens = tokenize(r.description ?? "");
    const termTokens = tokenize(r.term ?? "");
    return {
      row: r,
      eventTokens,
      descriptionTokens,
      termTokens,
      dl: eventTokens.length + descriptionTokens.length + termTokens.length,
    };
  });
  df = new Map();
  let total = 0;
  for (const d of docs) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.eventTokens, ...d.descriptionTokens, ...d.termTokens]) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  avgLen = docs.length > 0 ? total / docs.length : 0;
}

function idf(token: string): number {
  const n = docs.length;
  const dfi = df.get(token) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}

function countOf(token: string, arr: string[]): number {
  let c = 0;
  for (const t of arr) if (t === token) c++;
  return c;
}

function bm25Term(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (avgLen || 1));
  return idfV * ((tf * (BM25_K1 + 1)) / denom);
}

export interface CalendarHit {
  row: CalendarRow;
  score: number;
}

export function searchCalendarRows(query: string, limit = 10): CalendarHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const out: CalendarHit[] = [];
  for (const d of docs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = idf(q);
      if (idfQ === 0) continue;
      s += FIELD_WEIGHTS.event * bm25Term(countOf(q, d.eventTokens), d.dl, idfQ);
      s += FIELD_WEIGHTS.description * bm25Term(countOf(q, d.descriptionTokens), d.dl, idfQ);
      s += FIELD_WEIGHTS.term * bm25Term(countOf(q, d.termTokens), d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
