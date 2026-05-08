/**
 * Hybrid retrieval: BM25-lite over (title+number+body) fused with optional
 * semantic retrieval over pre-computed embeddings, combined via Reciprocal
 * Rank Fusion (RRF).
 *
 *  - No stemmer (intentionally; revisit only if eval shows a gap).
 *  - Field weights at scoring time: title × 3, number × 2, body × 1.
 *  - Embeddings come from dist/embeddings.json (built offline). When absent or
 *    when OPENAI_API_KEY is missing at runtime, we silently degrade to BM25.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { embedQuery } from "./embed.js";
import { log } from "./log.js";
import { EmbeddingChunk, PolicyEntry } from "./types.js";

// ---- Tokenization -----------------------------------------------------------

const TOKEN_SPLIT = /[\s\-_/.,;:()\[\]{}!?"'`<>|@#$%^&*=+]+/;

export function tokenize(input: string): string[] {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0);
}

// ---- BM25-lite --------------------------------------------------------------

interface FieldDoc {
  slug: string;
  number: string;
  title: string;
  titleTokens: string[];
  numberTokens: string[];
  bodyTokens: string[];
}

interface CorpusStats {
  N: number;
  avgLen: number;
  df: Map<string, number>;
}

const FIELD_WEIGHTS = { title: 3, number: 2, body: 1 } as const;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

let fieldDocs: FieldDoc[] = [];
let stats: CorpusStats = { N: 0, avgLen: 0, df: new Map() };
let bodiesLoaded = false;

export function indexEntries(entries: PolicyEntry[]): void {
  fieldDocs = entries.map((e) => ({
    slug: e.slug,
    number: e.number,
    title: e.title,
    titleTokens: tokenize(e.title),
    numberTokens: tokenize(e.number),
    bodyTokens: [],
  }));
  recomputeStats();
}

export function attachBody(slug: string, bodyText: string): void {
  const fd = fieldDocs.find((d) => d.slug === slug);
  if (!fd) return;
  fd.bodyTokens = tokenize(bodyText);
  bodiesLoaded = true;
  recomputeStats();
}

function recomputeStats(): void {
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const d of fieldDocs) {
    const seen = new Set<string>();
    const all = [...d.titleTokens, ...d.numberTokens, ...d.bodyTokens];
    totalLen += all.length;
    for (const t of all) {
      if (!seen.has(t)) {
        df.set(t, (df.get(t) ?? 0) + 1);
        seen.add(t);
      }
    }
  }
  stats = {
    N: fieldDocs.length,
    avgLen: fieldDocs.length ? totalLen / fieldDocs.length : 0,
    df,
  };
}

function bm25TermScore(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (stats.avgLen || 1));
  return idfV * ((tf * (BM25_K1 + 1)) / denom);
}

function idf(token: string): number {
  const df = stats.df.get(token) ?? 0;
  if (df === 0 || stats.N === 0) return 0;
  return Math.log(1 + (stats.N - df + 0.5) / (df + 0.5));
}

interface BM25Score {
  slug: string;
  score: number;
}

export function bm25Search(query: string, limit = 50): BM25Score[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0 || fieldDocs.length === 0) return [];

  const scores: BM25Score[] = [];
  const dlTotal = (d: FieldDoc) =>
    d.titleTokens.length + d.numberTokens.length + d.bodyTokens.length;

  for (const d of fieldDocs) {
    const dl = dlTotal(d);
    let s = 0;
    for (const q of qTokens) {
      const idfQ = idf(q);
      if (idfQ === 0) continue;
      const tfTitle = countOf(q, d.titleTokens);
      const tfNumber = countOf(q, d.numberTokens);
      const tfBody = countOf(q, d.bodyTokens);
      s += FIELD_WEIGHTS.title * bm25TermScore(tfTitle, dl, idfQ);
      s += FIELD_WEIGHTS.number * bm25TermScore(tfNumber, dl, idfQ);
      s += FIELD_WEIGHTS.body * bm25TermScore(tfBody, dl, idfQ);
    }
    if (s > 0) scores.push({ slug: d.slug, score: s });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, limit);
}

function countOf(token: string, arr: string[]): number {
  let c = 0;
  for (const t of arr) if (t === token) c++;
  return c;
}

// ---- Embeddings (optional, loaded once at startup) --------------------------

interface EmbeddingsFile {
  model: string;
  dim: number;
  builtAt: string;
  chunks: EmbeddingChunk[];
}

let embeddings: EmbeddingsFile | null = null;
let embeddingsTriedLoad = false;

function tryLoadEmbeddings(): EmbeddingsFile | null {
  if (embeddingsTriedLoad) return embeddings;
  embeddingsTriedLoad = true;
  try {
    const candidates = [
      pathResolve(__dirname, "embeddings.json"),
      pathResolve(__dirname, "..", "dist", "embeddings.json"),
      pathResolve(process.cwd(), "dist", "embeddings.json"),
    ];
    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      log("info", "no embeddings.json found; semantic retrieval disabled");
      return null;
    }
    const raw = readFileSync(found, "utf8");
    const parsed = JSON.parse(raw) as EmbeddingsFile;
    if (!parsed.chunks?.length) {
      log("warn", "embeddings.json has no chunks; degrading to BM25-only");
      return null;
    }
    embeddings = parsed;
    log("info", "embeddings loaded", {
      path: found,
      chunks: parsed.chunks.length,
      model: parsed.model,
      dim: parsed.dim,
    });
    return embeddings;
  } catch (err) {
    log("warn", "failed to load embeddings.json; degrading to BM25-only", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  if (aMag === 0 || bMag === 0) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

interface EmbedRank {
  slug: string;
  score: number;
  snippet: string;
}

async function embedSearch(query: string, limit = 50): Promise<EmbedRank[]> {
  const ef = tryLoadEmbeddings();
  if (!ef) return [];
  const qVec = await embedQuery(query);
  if (!qVec) return [];

  const perSlug = new Map<string, { score: number; snippet: string }>();
  for (const ch of ef.chunks) {
    const s = cosine(qVec, ch.vector);
    const cur = perSlug.get(ch.slug);
    if (!cur || s > cur.score) {
      perSlug.set(ch.slug, { score: s, snippet: ch.text.slice(0, 280) });
    }
  }
  const ranked: EmbedRank[] = Array.from(perSlug.entries()).map(
    ([slug, { score, snippet }]) => ({ slug, score, snippet }),
  );
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

// ---- Reciprocal Rank Fusion -------------------------------------------------

const RRF_K = 60;

export interface FusedHit {
  slug: string;
  score: number;
  bm25Rank: number | null;
  embedRank: number | null;
  snippet: string;
}

export async function hybridSearch(
  query: string,
  options: { topK?: number } = {},
): Promise<FusedHit[]> {
  const topK = options.topK ?? 10;

  const bm25Hits = bm25Search(query, 20);
  const embedHits = await embedSearch(query, 20);

  const byBm25Rank = new Map<string, number>();
  bm25Hits.forEach((h, i) => byBm25Rank.set(h.slug, i + 1));
  const byEmbedRank = new Map<string, number>();
  const snippetByEmbed = new Map<string, string>();
  embedHits.forEach((h, i) => {
    byEmbedRank.set(h.slug, i + 1);
    snippetByEmbed.set(h.slug, h.snippet);
  });

  const allSlugs = new Set<string>([
    ...byBm25Rank.keys(),
    ...byEmbedRank.keys(),
  ]);

  const fused: FusedHit[] = [];
  for (const slug of allSlugs) {
    const bm = byBm25Rank.get(slug) ?? null;
    const em = byEmbedRank.get(slug) ?? null;
    let score = 0;
    if (bm) score += 1 / (RRF_K + bm);
    if (em) score += 1 / (RRF_K + em);
    fused.push({
      slug,
      score,
      bm25Rank: bm,
      embedRank: em,
      snippet: snippetByEmbed.get(slug) ?? "",
    });
  }
  fused.sort((a, b) => b.score - a.score);
  return fused.slice(0, topK);
}

export function getSearchHealth(): {
  indexedDocs: number;
  bodiesLoaded: boolean;
  embeddingsLoaded: boolean;
  embeddingChunks: number;
} {
  return {
    indexedDocs: fieldDocs.length,
    bodiesLoaded,
    embeddingsLoaded: embeddings !== null,
    embeddingChunks: embeddings?.chunks.length ?? 0,
  };
}

// ---- Matched-passage extraction (F4 in codex_review.md) ---------------------
//
// Returns substrings of `text` centered on hits of `queryTokens`. Lets callers
// surface "primary evidence" alongside the full body so the model isn't asked
// to ground a claim in a 5-page distractor.

export interface MatchedPassage {
  start: number;
  end: number;
  text: string;
  matchedTokens: string[];
}

const DEFAULT_PASSAGE_WINDOW = 200;
const DEFAULT_MAX_PASSAGES = 3;

const WORD_CHAR = /[a-z0-9]/;

export function extractMatchedPassages(
  text: string,
  queryTokens: string[],
  options: { window?: number; maxPassages?: number } = {},
): MatchedPassage[] {
  if (!text || queryTokens.length === 0) return [];

  const window = options.window ?? DEFAULT_PASSAGE_WINDOW;
  const maxPassages = options.maxPassages ?? DEFAULT_MAX_PASSAGES;

  const lowerText = text.toLowerCase();
  const lowerTokens = queryTokens
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
  if (lowerTokens.length === 0) return [];

  interface Hit {
    start: number;
    end: number;
    token: string;
  }
  const hits: Hit[] = [];
  for (const token of lowerTokens) {
    let scan = 0;
    while (scan <= lowerText.length - token.length) {
      const idx = lowerText.indexOf(token, scan);
      if (idx === -1) break;
      const prev = idx > 0 ? lowerText[idx - 1] : "";
      const next =
        idx + token.length < lowerText.length ? lowerText[idx + token.length] : "";
      const isWordBoundary = !WORD_CHAR.test(prev) && !WORD_CHAR.test(next);
      if (isWordBoundary) hits.push({ start: idx, end: idx + token.length, token });
      scan = idx + token.length;
    }
  }
  if (hits.length === 0) return [];

  hits.sort((a, b) => a.start - b.start);
  const passages: MatchedPassage[] = [];
  for (const hit of hits) {
    const start = Math.max(0, hit.start - window);
    const end = Math.min(text.length, hit.end + window);
    const last = passages[passages.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.text = text.slice(last.start, last.end);
      if (!last.matchedTokens.includes(hit.token)) last.matchedTokens.push(hit.token);
    } else {
      passages.push({
        start,
        end,
        text: text.slice(start, end),
        matchedTokens: [hit.token],
      });
    }
  }

  passages.sort(
    (a, b) =>
      b.matchedTokens.length - a.matchedTokens.length ||
      b.text.length - a.text.length,
  );
  return passages.slice(0, maxPassages);
}

// ---- Retrieval confidence gate (F2 in codex_review.md) ---------------------
//
// Returns a calibrated accept/reject decision instead of letting downstream
// code blindly trust hybridSearch's top-k. Lets the MCP layer say "no relevant
// policy found" itself rather than pushing all refusal logic to the LLM.

export interface GateThresholds {
  minScore?: number;
  minMargin?: number;
}

export interface GateResult {
  accept: FusedHit[];
  rejected: boolean;
  reason?: string;
}

const DEFAULT_MIN_SCORE = 0.005;
const DEFAULT_MIN_MARGIN = 0;

export function gateRetrieval(
  fused: FusedHit[],
  thresholds: GateThresholds = {},
): GateResult {
  const minScore = thresholds.minScore ?? DEFAULT_MIN_SCORE;
  const minMargin = thresholds.minMargin ?? DEFAULT_MIN_MARGIN;

  if (fused.length === 0) {
    return {
      accept: [],
      rejected: true,
      reason: "no candidates returned by hybrid search (empty result)",
    };
  }

  const sorted = [...fused].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (top.score < minScore) {
    return {
      accept: [],
      rejected: true,
      reason: `top-1 score ${top.score.toFixed(4)} below floor ${minScore.toFixed(4)} (insufficient confidence)`,
    };
  }

  if (sorted.length >= 2 && minMargin > 0) {
    const margin = top.score - sorted[1].score;
    if (margin < minMargin) {
      return {
        accept: [],
        rejected: true,
        reason: `top-1 margin ${margin.toFixed(4)} below required ${minMargin.toFixed(4)} (top candidates too close to disambiguate)`,
      };
    }
  }

  const accepted = sorted.filter((h) => h.score >= minScore);
  return { accept: accepted, rejected: false };
}

export const __test__ = { tokenize, bm25Search, cosine };
