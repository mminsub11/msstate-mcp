/**
 * BM25 search over calendar rows.
 *
 * Fields indexed (weighted):
 *   event       — weight 3 (most semantic)
 *   synonyms    — weight 2 (LLM-generated paraphrases of event title)
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
  synonymsTokens: string[];
  descriptionTokens: string[];
  termTokens: string[];
  eventTf: Map<string, number>;
  synonymsTf: Map<string, number>;
  descriptionTf: Map<string, number>;
  termTf: Map<string, number>;
  dl: number;
}

const FIELD_WEIGHTS = { event: 3, synonyms: 2, term: 1, description: 1 } as const;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

let docs: IndexedDoc[] = [];
let df = new Map<string, number>();
let avgLen = 0;

function tfMap(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export function indexCalendarRows(rows: CalendarRow[]): void {
  docs = rows.map((r) => {
    const eventTokens = tokenize(r.event);
    const synonymsText = (r.synonyms ?? []).join(" ");
    const synonymsTokens = tokenize(synonymsText);
    const descriptionTokens = tokenize(r.description ?? "");
    const termTokens = tokenize(r.term ?? "");
    return {
      row: r,
      eventTokens,
      synonymsTokens,
      descriptionTokens,
      termTokens,
      eventTf: tfMap(eventTokens),
      synonymsTf: tfMap(synonymsTokens),
      descriptionTf: tfMap(descriptionTokens),
      termTf: tfMap(termTokens),
      dl: eventTokens.length + synonymsTokens.length + descriptionTokens.length + termTokens.length,
    };
  });
  df = new Map();
  let total = 0;
  for (const d of docs) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.eventTokens, ...d.synonymsTokens, ...d.descriptionTokens, ...d.termTokens]) {
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
      s += FIELD_WEIGHTS.event * bm25Term(d.eventTf.get(q) ?? 0, d.dl, idfQ);
      s += FIELD_WEIGHTS.synonyms * bm25Term(d.synonymsTf.get(q) ?? 0, d.dl, idfQ);
      s += FIELD_WEIGHTS.description * bm25Term(d.descriptionTf.get(q) ?? 0, d.dl, idfQ);
      s += FIELD_WEIGHTS.term * bm25Term(d.termTf.get(q) ?? 0, d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** Returns the currently-indexed corpus rows. Used by the find_msu_date
 *  fallback path to look up academic_calendar rows by term without
 *  re-running BM25 across the whole corpus. */
export function getAllCalendarRows(): readonly CalendarRow[] {
  return docs.map((d) => d.row);
}
