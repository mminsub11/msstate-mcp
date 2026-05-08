/**
 * Scraper for https://www.policies.msstate.edu/current.
 *
 * All site-specific selectors and regexes live at the top of this file so
 * a layout change at MSU is a one-file fix.
 *
 * Design constraints from PLAN.md:
 *  - Drupal taxonomy IDs (volume / section dropdown values) are NEVER hardcoded.
 *    They renumber on re-imports. We parse the dropdowns at runtime instead.
 *  - PDF URLs are read verbatim from `<a class="btn-download">[href]`. Some live
 *    under /sites/.../files/policies/<slug>.pdf, others under /sites/.../files/
 *    YYYY-MM/<slug>.pdf with optional _N suffix. Never reconstruct from the slug.
 *  - "Date Authored" on the index is *not* a last-revised date. True revision
 *    dates live in the PDF metadata block.
 *  - 99.99% accuracy bar: refuse rather than guess. Tools surface assertion
 *    failures via health_check so the LLM can apologize coherently.
 */

import { load as cheerioLoad } from "cheerio";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { TTLCache } from "./cache.js";
import { httpGet } from "./http.js";
import { log } from "./log.js";
import {
  PolicyDocument,
  PolicyEntry,
  PolicyIndex,
  TaxonomyEntry,
  WAFChallengeError,
} from "./types.js";

// ---- Site-specific constants (one-file fix surface) -------------------------

const BASE_URL = "https://www.policies.msstate.edu";
const INDEX_URL = `${BASE_URL}/current`;

const SEL = {
  table: "#datatable",
  rows: "#datatable tbody tr",
  cellNumber: "td:nth-child(1)",
  cellTitle: "td:nth-child(2) a",
  cellStatus: "td:nth-child(3) .badge",
  cellTime: "td:nth-child(4) time",
  cellDownload: "td:last-child a.btn-download",
  selectVolume: 'select[name="volume"] option',
  selectSection: 'select[name="section"] option',
} as const;

/** Matches both NN.NN (e.g. 01.01) and NN.NNN (e.g. 91.100) — verified 2026-05-07. */
const POLICY_NUMBER_RE = /^\d{2}\.(\d{2}|\d{3})$/;

const PDF_METADATA_PATTERNS: Array<{ key: keyof PolicyDocument; rx: RegExp }> = [
  { key: "effectiveDate", rx: /effective\s+date\s*[:\-]\s*(.+)/i },
  { key: "reviewedDate", rx: /reviewed(?:\s+date)?\s*[:\-]\s*(.+)/i },
  { key: "lastRevisedDate", rx: /(?:last\s+)?revised(?:\s+date)?\s*[:\-]\s*(.+)/i },
  { key: "responsibleOffice", rx: /responsible\s+office\s*[:\-]\s*(.+)/i },
  { key: "approvedBy", rx: /approved\s+by\s*[:\-]\s*(.+)/i },
];

const INDEX_TTL_MS = 60 * 60 * 1000; // 1h
const POLICY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Sanity assertion floor. Live count was 218 on 2026-05-07; corpus may shrink
// modestly but a count below 100 almost certainly means selectors broke or WAF.
const MIN_INDEX_ROWS = 100;

// Sanity floor for "did we actually extract policy text?" — anything below this
// is treated as a fetch/parse failure and NOT cached, so a transient outage
// cannot poison the policy cache for 24h. See codex_review.md F3.
const MIN_USABLE_POLICY_TEXT_CHARS = 200;

export function isPolicyTextUsable(text: string): boolean {
  return typeof text === "string" && text.trim().length >= MIN_USABLE_POLICY_TEXT_CHARS;
}

// ---- Module state -----------------------------------------------------------

const indexCache = new TTLCache<PolicyIndex>(INDEX_TTL_MS);

// Per PLAN.md: in-memory by default; opt in to disk persistence for the 24h
// policy-body cache via env var so PDFs survive process restarts. Index cache
// stays in-memory (its value type contains cheerio-derived Maps that don't
// JSON round-trip cleanly, and a cold rescrape is cheap anyway).
const policyCache =
  process.env.MSSTATE_POLICIES_CACHE === "disk"
    ? new TTLCache<PolicyDocument>({
        ttlMs: POLICY_TTL_MS,
        persistKey: "policy-bodies",
      })
    : new TTLCache<PolicyDocument>(POLICY_TTL_MS);

interface ScraperHealth {
  lastIndexFetch: string | null;
  lastIndexError: string | null;
  pdfFallbackCount: number;
  cacheHits: number;
  cacheMisses: number;
}

const health: ScraperHealth = {
  lastIndexFetch: null,
  lastIndexError: null,
  pdfFallbackCount: 0,
  cacheHits: 0,
  cacheMisses: 0,
};

export function getScraperHealth(): ScraperHealth {
  return { ...health };
}

// ---- Index parsing (pure function, exported for testing) --------------------

export interface ParsedIndex {
  rows: PolicyEntry[];
  volumes: TaxonomyEntry[];
  sections: TaxonomyEntry[];
}

export function parseIndexHtml(html: string, baseUrl: string = BASE_URL): ParsedIndex {
  const $ = cheerioLoad(html);

  if ($(SEL.table).length === 0) {
    throw new Error(`Index parse: ${SEL.table} not present in HTML`);
  }

  const rows: PolicyEntry[] = [];
  $(SEL.rows).each((_i, tr) => {
    const $tr = $(tr);
    const number = $tr.find(SEL.cellNumber).text().trim();
    if (!POLICY_NUMBER_RE.test(number)) return;

    const titleAnchor = $tr.find(SEL.cellTitle).first();
    const title = titleAnchor.text().trim();
    const landingHref = titleAnchor.attr("href") ?? "";
    const downloadAnchor = $tr.find(SEL.cellDownload).first();
    const pdfHref = downloadAnchor.attr("href") ?? "";
    if (!title || !landingHref || !pdfHref) return;

    const status = $tr.find(SEL.cellStatus).text().trim() || "";
    const dt = $tr.find(SEL.cellTime).attr("datetime") ?? null;
    const slug = number.replace(/\./g, "");

    rows.push({
      number,
      slug,
      title,
      landingUrl: absolutize(landingHref, baseUrl),
      pdfUrl: absolutize(pdfHref, baseUrl),
      status,
      firstAuthoredOrSorted: dt,
    });
  });

  const volumes = parseTaxonomy($, SEL.selectVolume);
  const sections = parseTaxonomy($, SEL.selectSection);

  return { rows, volumes, sections };
}

function parseTaxonomy(
  $: ReturnType<typeof cheerioLoad>,
  selector: string,
): TaxonomyEntry[] {
  const entries: TaxonomyEntry[] = [];
  $(selector).each((_i, opt) => {
    const $opt = $(opt);
    const id = ($opt.attr("value") ?? "").trim();
    const label = $opt.text().trim();
    // Skip the "All" / "- Any -" sentinel and any blank rows
    if (!id || id.toLowerCase() === "all") return;
    if (!label) return;
    entries.push({ id, label });
  });
  return entries;
}

function absolutize(href: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${baseUrl}${href}`;
  return `${baseUrl}/${href}`;
}

// ---- Index fetch ------------------------------------------------------------

export interface FetchIndexOptions {
  /** Volume taxonomy id, e.g. "36" — resolved at runtime, not hardcoded. */
  volumeId?: string;
  /** Section taxonomy id, e.g. "1" — resolved at runtime, not hardcoded. */
  sectionId?: string;
  /** Force a fresh fetch even if a cached snapshot is still valid. */
  bypassCache?: boolean;
}

export async function fetchIndex(opts: FetchIndexOptions = {}): Promise<PolicyIndex> {
  const cacheKey = `idx:${opts.volumeId ?? ""}:${opts.sectionId ?? ""}`;
  if (!opts.bypassCache) {
    const hit = indexCache.get(cacheKey);
    if (hit) {
      health.cacheHits++;
      return hit;
    }
    health.cacheMisses++;
  }

  const url = buildIndexUrl(opts);
  let html: string;
  try {
    const res = await httpGet(url, { detectWaf: true, responseType: "text" });
    html = res.body as string;
  } catch (err) {
    health.lastIndexError =
      err instanceof Error ? err.message : String(err);
    if (err instanceof WAFChallengeError) {
      log("error", "index fetch hit WAF", { url });
    } else {
      log("error", "index fetch failed", { url, err: health.lastIndexError });
    }
    throw err;
  }

  const parsed = parseIndexHtml(html, BASE_URL);

  // Sanity assertions — a 0-row response usually means selectors broke or WAF.
  if (parsed.rows.length < MIN_INDEX_ROWS) {
    health.lastIndexError = `Index parse returned ${parsed.rows.length} rows (< ${MIN_INDEX_ROWS}); selectors may be stale or WAF served a shell`;
    log("error", "index sanity assertion failed", { rows: parsed.rows.length });
    throw new Error(health.lastIndexError);
  }
  if (parsed.volumes.length < 1 || parsed.sections.length < 1) {
    health.lastIndexError = `Taxonomy dropdowns empty (volumes=${parsed.volumes.length}, sections=${parsed.sections.length})`;
    log("error", "taxonomy assertion failed", {
      volumes: parsed.volumes.length,
      sections: parsed.sections.length,
    });
    throw new Error(health.lastIndexError);
  }

  const index: PolicyIndex = {
    fetchedAt: Date.now(),
    source: url,
    rows: parsed.rows,
    volumes: parsed.volumes,
    sections: parsed.sections,
  };
  indexCache.set(cacheKey, index);
  health.lastIndexFetch = new Date().toISOString();
  health.lastIndexError = null;
  log("info", "index fetched", {
    url,
    rows: index.rows.length,
    volumes: index.volumes.length,
    sections: index.sections.length,
  });
  return index;
}

function buildIndexUrl(opts: FetchIndexOptions): string {
  const params = new URLSearchParams();
  if (opts.volumeId) params.set("volume", opts.volumeId);
  if (opts.sectionId) params.set("section", opts.sectionId);
  const qs = params.toString();
  return qs ? `${INDEX_URL}?${qs}` : INDEX_URL;
}

// ---- Policy fetch -----------------------------------------------------------

export async function fetchPolicy(numberOrSlug: string): Promise<PolicyDocument> {
  const slug = normalizeToSlug(numberOrSlug);
  const cached = policyCache.get(slug);
  if (cached) {
    health.cacheHits++;
    return cached;
  }
  health.cacheMisses++;

  const idx = await fetchIndex();
  const entry = idx.rows.find((r) => r.slug === slug || r.number === numberOrSlug);
  if (!entry) {
    throw new Error(`Policy ${numberOrSlug} not found in index`);
  }

  const doc = await fetchPolicyBody(entry);
  if (!isPolicyTextUsable(doc.text)) {
    // F3 (codex_review.md): when PDF + landing fallback both produce empty or
    // garbage text, throw rather than caching a poisoned doc for 24h. Caller
    // sees a structured error and can refuse instead of answering from nothing.
    log("error", "fetchPolicy: refusing to cache policy with unusable text", {
      slug,
      chars: doc.text.length,
      fallbackToLanding: doc.fallbackToLanding,
    });
    throw new Error(
      `Policy ${entry.number}: PDF + landing fallback both produced unusable text (${doc.text.length} chars; need >= ${MIN_USABLE_POLICY_TEXT_CHARS}). Refusing to cache empty/garbage as authoritative.`,
    );
  }
  policyCache.set(slug, doc);
  return doc;
}

function normalizeToSlug(input: string): string {
  const trimmed = input.trim();
  if (POLICY_NUMBER_RE.test(trimmed)) return trimmed.replace(/\./g, "");
  if (/^\d{4,5}$/.test(trimmed)) return trimmed;
  // Fall back to whatever the caller gave us; index lookup will reject if invalid.
  return trimmed;
}

export async function fetchPolicyBody(entry: PolicyEntry): Promise<PolicyDocument> {
  let text = "";
  let pageCount = 0;
  let fallback = false;
  try {
    const res = await httpGet(entry.pdfUrl, {
      responseType: "buffer",
      detectWaf: false,
      timeoutMs: 60_000,
    });
    const parsed = await pdfParse(res.body as Buffer);
    pageCount = parsed.numpages || 0;
    text = normalizeText(parsed.text || "");
  } catch (err) {
    log("warn", "pdf fetch/parse failed; will fall back to landing page", {
      slug: entry.slug,
      err: err instanceof Error ? err.message : String(err),
    });
    fallback = true;
  }

  // Sanity check on extracted text. Plan threshold: <100 chars on a >2 page PDF.
  if (!fallback && pageCount > 2 && text.length < 100) {
    log("warn", "pdf text suspiciously short; falling back", {
      slug: entry.slug,
      chars: text.length,
      pages: pageCount,
    });
    fallback = true;
  }

  if (fallback) {
    health.pdfFallbackCount++;
    text = await fetchLandingFallback(entry).catch((err) => {
      log("error", "landing page fallback also failed", {
        slug: entry.slug,
        err: err instanceof Error ? err.message : String(err),
      });
      return "";
    });
  }

  const meta = extractMetadata(text);

  return {
    number: entry.number,
    slug: entry.slug,
    title: entry.title,
    landingUrl: entry.landingUrl,
    pdfUrl: entry.pdfUrl,
    text,
    retrievedAt: new Date().toISOString(),
    effectiveDate: meta.effectiveDate,
    reviewedDate: meta.reviewedDate,
    lastRevisedDate: meta.lastRevisedDate,
    responsibleOffice: meta.responsibleOffice,
    approvedBy: meta.approvedBy,
    fallbackToLanding: fallback,
  };
}

function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[  -​  　﻿]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface ExtractedMetadata {
  effectiveDate: string | null;
  reviewedDate: string | null;
  lastRevisedDate: string | null;
  responsibleOffice: string | null;
  approvedBy: string | null;
}

function extractMetadata(text: string): ExtractedMetadata {
  const head = text.split("\n").slice(0, 60).join("\n");
  const out: ExtractedMetadata = {
    effectiveDate: null,
    reviewedDate: null,
    lastRevisedDate: null,
    responsibleOffice: null,
    approvedBy: null,
  };
  for (const { key, rx } of PDF_METADATA_PATTERNS) {
    const m = head.match(rx);
    if (m) {
      const value = m[1].trim().replace(/\s{2,}/g, " ");
      if (
        key === "effectiveDate" ||
        key === "reviewedDate" ||
        key === "lastRevisedDate" ||
        key === "responsibleOffice" ||
        key === "approvedBy"
      ) {
        out[key] = value;
      }
    }
  }
  return out;
}

async function fetchLandingFallback(entry: PolicyEntry): Promise<string> {
  const res = await httpGet(entry.landingUrl, { detectWaf: true });
  const $ = cheerioLoad(res.body as string);
  $("nav, header, footer, script, style, .quick-menu, #msu-header, #msu-footer").remove();
  const main = $("main, [role=main], .region-content").first();
  const body = main.length ? main.text() : $("body").text();
  return normalizeText(body);
}

// ---- Test helpers (exported for tests/scraper.test.ts) ----------------------

export const __test__ = {
  POLICY_NUMBER_RE,
  parseIndexHtml,
  normalizeText,
  extractMetadata,
  looksLikeDataTable: (html: string) => /id=["']datatable["']/.test(html),
};
