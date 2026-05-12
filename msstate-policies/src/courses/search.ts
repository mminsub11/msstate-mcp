/**
 * BM25 over the course corpus.
 *
 * Indexed fields (weighted):
 *   code        — 4 (high; exact matches dominate)
 *   title       — 3
 *   description — 1
 *
 * Same parameters as calendars/search.ts (k1=1.2, b=0.75).
 */
import type { Course } from "./types.js";

const TOKEN_SPLIT = /[\s\-_/.,;:()\[\]{}!?"'`<>|@#$%^&*=+]+/;

function tokenize(input: string): string[] {
  return input.normalize("NFKC").toLowerCase().split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

interface IndexedDoc {
  course: Course;
  codeTokens: string[];
  titleTokens: string[];
  descTokens: string[];
  dl: number;
}

const FIELD_WEIGHTS = { code: 4, title: 3, description: 1 } as const;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

let docs: IndexedDoc[] = [];
let df = new Map<string, number>();
let avgLen = 0;

export function indexCourses(courses: Course[]): void {
  docs = courses.map((c) => {
    const codeTokens = tokenize(c.code);
    const titleTokens = tokenize(c.title);
    const descTokens = tokenize(c.description);
    return {
      course: c,
      codeTokens,
      titleTokens,
      descTokens,
      dl: codeTokens.length + titleTokens.length + descTokens.length,
    };
  });
  df = new Map();
  let total = 0;
  for (const d of docs) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.codeTokens, ...d.titleTokens, ...d.descTokens]) {
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

export interface CourseHit {
  course: Course;
  score: number;
}

export function searchCourses(query: string, limit = 10): CourseHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const out: CourseHit[] = [];
  for (const d of docs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = idf(q);
      if (idfQ === 0) continue;
      s += FIELD_WEIGHTS.code * bm25Term(countOf(q, d.codeTokens), d.dl, idfQ);
      s += FIELD_WEIGHTS.title * bm25Term(countOf(q, d.titleTokens), d.dl, idfQ);
      s += FIELD_WEIGHTS.description * bm25Term(countOf(q, d.descTokens), d.dl, idfQ);
    }
    if (s > 0) out.push({ course: d.course, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(0, limit));
}
