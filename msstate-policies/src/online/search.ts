/**
 * Online module — search and filter helpers.
 *
 * Three responsibilities:
 *   1. BM25 over OnlineInfoPage[] + a synthetic staff doc.
 *   2. Deterministic filter for list_online_programs (level + substring + pagination).
 *   3. Fuzzy program-name resolver for get_online_program(name_query).
 */
import type {
  OnlineInfoPage,
  OnlineProgram,
  OnlineStaffEntry,
  DegreeLevel,
} from "./types.js";

const TOKEN_SPLIT = /[\s\-_/.,;:()\[\]{}!?"'`<>|@#$%^&*=+]+/;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function tokenize(s: string): string[] {
  return s.normalize("NFKC").toLowerCase().split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

interface IndexedDoc {
  row: OnlineInfoPage;
  titleTokens: string[];
  bodyTokens: string[];
  dl: number;
}

const FIELD_WEIGHTS = { title: 3, body: 1 } as const;

let infoDocs: IndexedDoc[] = [];
let infoDf = new Map<string, number>();
let infoAvgLen = 0;

function flattenStaffAsDoc(staff: OnlineStaffEntry[]): OnlineInfoPage {
  const lines = staff.map((s) => `${s.name} — ${s.title}. ${s.email ?? ""} ${s.phone ?? ""} ${s.office}`);
  return {
    slug: "staff",
    title: "MSU Online Staff",
    url: "https://www.online.msstate.edu/staff",
    body_markdown: lines.join("\n"),
    retrieved_at: staff[0]?.retrieved_at ?? "1970-01-01T00:00:00.000Z",
  };
}

export function indexInfoPages(info_pages: OnlineInfoPage[], staff: OnlineStaffEntry[]): void {
  const docs: OnlineInfoPage[] = [...info_pages];
  if (staff.length > 0) docs.push(flattenStaffAsDoc(staff));
  infoDocs = docs.map((row) => {
    const titleTokens = tokenize(row.title);
    const bodyTokens = tokenize(row.body_markdown);
    return { row, titleTokens, bodyTokens, dl: titleTokens.length + bodyTokens.length };
  });
  infoDf = new Map();
  let total = 0;
  for (const d of infoDocs) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.titleTokens, ...d.bodyTokens]) {
      if (seen.has(t)) continue;
      seen.add(t);
      infoDf.set(t, (infoDf.get(t) ?? 0) + 1);
    }
  }
  infoAvgLen = infoDocs.length > 0 ? total / infoDocs.length : 0;
}

function idf(token: string): number {
  const n = infoDocs.length;
  const dfi = infoDf.get(token) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}

function bm25Term(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (infoAvgLen || 1));
  return idfV * ((tf * (BM25_K1 + 1)) / denom);
}

function countOf(token: string, arr: string[]): number {
  let c = 0;
  for (const t of arr) if (t === token) c++;
  return c;
}

export type InfoScope =
  | "all"
  | "state-authorization"
  | "military-assistance"
  | "orientation"
  | "faq"
  | "financial-matters"
  | "staff";

export interface InfoHit { row: OnlineInfoPage; score: number; }

export function bm25SearchInfo(query: string, k: number, scope: InfoScope): InfoHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const docs = scope === "all" ? infoDocs : infoDocs.filter((d) => d.row.slug === scope);
  const out: InfoHit[] = [];
  for (const d of docs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = idf(q);
      if (idfQ === 0) continue;
      s += FIELD_WEIGHTS.title * bm25Term(countOf(q, d.titleTokens), d.dl, idfQ);
      s += FIELD_WEIGHTS.body  * bm25Term(countOf(q, d.bodyTokens),  d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, Math.min(k, out.length)));
}

// ---- Filter for list_online_programs --------------------------------------

export interface ProgramFilterRequest {
  level?: DegreeLevel;
  subject_keyword?: string;
  limit?: number;
  offset?: number;
}

export interface ProgramFilterResult {
  matches: Array<{
    slug: string;
    name: string;
    degree_level: DegreeLevel;
    short_description: string;
    url: string;
  }>;
  total: number;
  filtered_total: number;
}

export function filterPrograms(programs: OnlineProgram[], req: ProgramFilterRequest): ProgramFilterResult {
  let filtered = programs;
  if (req.level) filtered = filtered.filter((p) => p.degree_level === req.level);
  if (req.subject_keyword && req.subject_keyword.trim().length > 0) {
    const k = req.subject_keyword.trim().toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.name.toLowerCase().includes(k) ||
        p.short_description.toLowerCase().includes(k),
    );
  }
  const limit = Math.max(1, Math.min(req.limit ?? 50, 200));
  const offset = Math.max(0, req.offset ?? 0);
  const matches = filtered.slice(offset, offset + limit).map((p) => ({
    slug: p.slug,
    name: p.name,
    degree_level: p.degree_level,
    short_description: p.short_description,
    url: p.url,
  }));
  return { matches, total: programs.length, filtered_total: filtered.length };
}

// ---- Fuzzy resolver for get_online_program(name_query) ---------------------

export interface FuzzyResolveResult {
  matched: OnlineProgram | null;
  did_you_mean: Array<{ slug: string; name: string }>;
}

export function fuzzyResolveProgram(programs: OnlineProgram[], query: string): FuzzyResolveResult {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return { matched: null, did_you_mean: [] };
  const scored = programs.map((p) => {
    const slugT = tokenize(p.slug);
    const nameT = tokenize(p.name);
    const shortT = tokenize(p.short_description);
    let score = 0;
    for (const q of qTokens) {
      score += 4 * countOf(q, slugT);
      score += 3 * countOf(q, nameT);
      score += 1 * countOf(q, shortT);
    }
    return { p, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { matched: null, did_you_mean: [] };
  return {
    matched: scored[0].p,
    did_you_mean: scored.slice(1, 3).map((x) => ({ slug: x.p.slug, name: x.p.name })),
  };
}
