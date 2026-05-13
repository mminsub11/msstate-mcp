/**
 * BM25 over emergency guidelines + alias-first resolver, plus refuge match.
 *
 * BM25 params match courses/calendars (k1=1.2, b=0.75). Indexed fields:
 *   title           — 3
 *   slug            — 2
 *   body (first 200 chars only — keeps BM25 focused on the lede)
 *                   — 1
 *   aliases (joined)— 4 (highest, so a guideline whose aliases match wins
 *                        even when title/body don't)
 *
 * Refuge match: lowercased substring on `building` first; if empty, BM25
 * over building tokens.
 */
import {
  EMERGENCY_ALIASES,
  type GuidelineRow,
  type RefugeRow,
} from "./types.js";

const TOKEN_SPLIT = /[\s\-_/.,;:()\[\]{}!?"'`<>|@#$%^&*=+]+/;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function tokenize(input: string): string[] {
  return input.normalize("NFKC").toLowerCase().split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

interface IndexedGuideline {
  row: GuidelineRow;
  titleTokens: string[];
  slugTokens: string[];
  bodyTokens: string[];
  aliasTokens: string[];
  dl: number;
}

const FIELD_WEIGHTS = { title: 3, slug: 2, body: 1, alias: 4 } as const;

let docs: IndexedGuideline[] = [];
let df = new Map<string, number>();
let avgLen = 0;

export function indexGuidelines(rows: GuidelineRow[]): void {
  docs = rows.map((row) => {
    const titleTokens = tokenize(row.title);
    const slugTokens = tokenize(row.slug);
    const bodyTokens = tokenize(row.body_markdown.slice(0, 200));
    const aliasTokens = tokenize(row.aliases.join(" "));
    return {
      row,
      titleTokens,
      slugTokens,
      bodyTokens,
      aliasTokens,
      dl: titleTokens.length + slugTokens.length + bodyTokens.length + aliasTokens.length,
    };
  });
  df = new Map();
  let total = 0;
  for (const d of docs) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.titleTokens, ...d.slugTokens, ...d.bodyTokens, ...d.aliasTokens]) {
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

interface BM25Hit {
  row: GuidelineRow;
  score: number;
}

function bm25SearchGuidelines(query: string): BM25Hit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const out: BM25Hit[] = [];
  for (const d of docs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = idf(q);
      if (idfQ === 0) continue;
      s += FIELD_WEIGHTS.title * bm25Term(countOf(q, d.titleTokens), d.dl, idfQ);
      s += FIELD_WEIGHTS.slug  * bm25Term(countOf(q, d.slugTokens),  d.dl, idfQ);
      s += FIELD_WEIGHTS.body  * bm25Term(countOf(q, d.bodyTokens),  d.dl, idfQ);
      s += FIELD_WEIGHTS.alias * bm25Term(countOf(q, d.aliasTokens), d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export interface ResolveResult {
  matched: GuidelineRow | null;
  via: "exact_slug" | "alias" | "bm25" | "none";
  did_you_mean: GuidelineRow[];
  suggestions: GuidelineRow[];
  score: number;
}

export function resolveGuideline(input: string): ResolveResult {
  const norm = (input ?? "").toLowerCase().trim();
  if (!norm) {
    return { matched: null, via: "none", did_you_mean: [], suggestions: docs.map((d) => d.row), score: 0 };
  }
  // 1. exact slug
  const exact = docs.find((d) => d.row.slug === norm);
  if (exact) {
    return { matched: exact.row, via: "exact_slug", did_you_mean: [], suggestions: [], score: 1 };
  }
  // 2. alias
  const aliasSlug = EMERGENCY_ALIASES[norm];
  if (aliasSlug) {
    const row = docs.find((d) => d.row.slug === aliasSlug)?.row ?? null;
    if (row) return { matched: row, via: "alias", did_you_mean: [], suggestions: [], score: 1 };
  }
  // 3. BM25
  const hits = bm25SearchGuidelines(norm);
  if (hits.length === 0) {
    return { matched: null, via: "none", did_you_mean: [], suggestions: docs.map((d) => d.row), score: 0 };
  }
  return {
    matched: hits[0].row,
    via: "bm25",
    did_you_mean: hits.slice(1, 3).map((h) => h.row),
    suggestions: [],
    score: hits[0].score,
  };
}

// ---- Refuge --------------------------------------------------------------

interface IndexedRefuge {
  row: RefugeRow;
  buildingTokens: string[];
  dl: number;
}

let refugeDocs: IndexedRefuge[] = [];
let refugeDf = new Map<string, number>();
let refugeAvgLen = 0;

export function indexRefugeAreas(rows: RefugeRow[]): void {
  refugeDocs = rows.map((row) => {
    const buildingTokens = tokenize(row.building);
    return { row, buildingTokens, dl: buildingTokens.length };
  });
  refugeDf = new Map();
  let total = 0;
  for (const d of refugeDocs) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of d.buildingTokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      refugeDf.set(t, (refugeDf.get(t) ?? 0) + 1);
    }
  }
  refugeAvgLen = refugeDocs.length > 0 ? total / refugeDocs.length : 0;
}

function refugeIdf(token: string): number {
  const n = refugeDocs.length;
  const dfi = refugeDf.get(token) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}

function refugeBm25(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (refugeAvgLen || 1));
  return idfV * ((tf * (BM25_K1 + 1)) / denom);
}

export function findRefugeArea(query: string): RefugeRow[] {
  const norm = (query ?? "").toLowerCase().trim();
  if (!norm) return [];
  // 1. substring match
  const sub = refugeDocs
    .filter((d) => d.row.building.toLowerCase().includes(norm))
    .map((d) => d.row);
  if (sub.length > 0) return sub;
  // 2. BM25 fallback
  const qTokens = tokenize(norm);
  if (qTokens.length === 0) return [];
  const scored: { row: RefugeRow; score: number }[] = [];
  for (const d of refugeDocs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = refugeIdf(q);
      if (idfQ === 0) continue;
      s += refugeBm25(countOf(q, d.buildingTokens), d.dl, idfQ);
    }
    if (s > 0) scored.push({ row: d.row, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.row);
}
