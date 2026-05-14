/**
 * Calendar corpus loader.
 *
 * Local-install: live-scrapes via scraper.ts with a TTL cache.
 * 6h TTL for housing (high volatility); 24h for the other 5 (months-stable).
 *
 * Worker mode: doesn't run this — Worker imports rows from corpus.json.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import { contentHash } from "./hash.js";
import {
  CALENDAR_SOURCES,
  type CalendarRow,
  type CalendarSource,
  type ScrapeResult,
} from "./types.js";
import { scrapeCalendar } from "./scraper.js";

// Warm-up gate: handlers await this before searching so the first request
// gets a real answer even if the background warm is still in flight.
let warmPromise: Promise<void> = Promise.resolve();

export function setCalendarWarmReady(p: Promise<unknown>): void {
  // Swallow rejection at the gate — handlers should fall back to whatever
  // in-memory state the warm attempt managed to populate, not crash.
  warmPromise = p.then(() => undefined, () => undefined);
}

export function awaitCalendarWarm(): Promise<void> {
  return warmPromise;
}

export function resetCalendarWarmForTests(): void {
  warmPromise = Promise.resolve();
}

interface CacheEntry {
  rows: CalendarRow[];
  expiresAt: number;
  error: string | null;
  warnings: string[];
  // last successful rows, kept even if the most recent attempt errored
  lastGoodRows: CalendarRow[];
  lastGoodAt: number | null;
}

const cache = new Map<CalendarSource, CacheEntry>();
// Short TTL for error entries: debounces upstream during flaky conditions
// without locking a source out for the rest of the day (vs. the long success TTL).
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

type Scraper = (source: CalendarSource) => Promise<ScrapeResult>;
let scraperImpl: Scraper = scrapeCalendar;
export function __setScraperForTests(s: Scraper): void { scraperImpl = s; }

export function resetCalendarCacheForTests(opts: { keepLastGood?: boolean } = {}): void {
  if (!opts.keepLastGood) {
    cache.clear();
    scraperImpl = scrapeCalendar;
    return;
  }
  for (const [k, v] of cache) {
    cache.set(k, { ...v, expiresAt: 0 });
  }
}

function ttlMsFor(source: CalendarSource): number {
  return source === "housing" ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

export async function loadAllCalendarRows(): Promise<CalendarRow[]> {
  const all: CalendarRow[] = [];
  for (const source of CALENDAR_SOURCES) {
    const result = await loadCalendarSource(source);
    all.push(...result.rows);
  }
  const rows = all;

  // v0.5.0: attach contentHash + synonyms.
  for (const r of rows) r.contentHash = contentHash(r);

  // Path differs between source-mode (tests; from src/calendars/) and
  // bundled-mode (dist/index.js). Use __dirname — esbuild emits CJS so
  // __dirname is native there, and tsx (CJS-default in this repo) provides
  // it in source mode too. Mirrors the pattern already used in src/search.ts.
  // import.meta.url is unsafe here: esbuild's CJS shim makes it undefined,
  // which silently broke the calendar loader for every npm/plugin user in
  // v1.0.0–v1.0.1.
  const here = __dirname;
  const candidates = [
    join(here, "calendar-synonyms.json"),                          // bundled
    join(here, "..", "..", "dist", "calendar-synonyms.json"),      // source
  ];
  let synMap: Record<string, string[]> = {};
  for (const p of candidates) {
    try {
      const sidecar = JSON.parse(readFileSync(p, "utf8")) as {
        synonyms: Record<string, string[]>;
      };
      synMap = sidecar.synonyms;
      log("info", "loaded calendar synonyms sidecar", { path: p, entries: Object.keys(synMap).length });
      break;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && (err as { code: string }).code === "ENOENT")) {
        log("warn", "synonyms sidecar parse failed", {
          path: p,
          err_class: err instanceof Error ? err.constructor.name : "unknown",
        });
      }
    }
  }
  if (Object.keys(synMap).length === 0) {
    log("warn", "no calendar synonyms sidecar found; BM25 will run without synonyms field");
  }

  for (const r of rows) {
    r.synonyms = synMap[r.contentHash ?? ""] ?? [];
  }

  return rows;
}

export async function loadCalendarSource(source: CalendarSource): Promise<ScrapeResult> {
  const now = Date.now();
  const hit = cache.get(source);
  if (hit && hit.expiresAt > now) {
    return { source, rows: hit.rows, error: hit.error, warnings: hit.warnings.length > 0 ? hit.warnings : undefined };
  }
  const result = await scraperImpl(source);
  const wasError = result.error !== null;
  const lkg = hit?.lastGoodRows ?? [];
  const entry: CacheEntry = wasError
    ? {
        rows: lkg, // serve last-known-good on transient error
        error: result.error,
        warnings: result.warnings ?? [],
        expiresAt: now + NEGATIVE_TTL_MS,
        lastGoodRows: lkg,
        lastGoodAt: hit?.lastGoodAt ?? null,
      }
    : {
        rows: result.rows,
        error: null,
        warnings: result.warnings ?? [],
        expiresAt: now + ttlMsFor(source),
        lastGoodRows: result.rows,
        lastGoodAt: now,
      };
  cache.set(source, entry);
  if (wasError) {
    log("warn", "calendar source scrape error (serving LKG)", { source, error: result.error, lkg_count: lkg.length });
  }
  return { source, rows: entry.rows, error: entry.error, warnings: entry.warnings.length > 0 ? entry.warnings : undefined };
}

export function getCalendarsCorpusHealth(): {
  per_source: Record<string, { row_count: number; error: string | null; warnings: string[] }>;
} {
  const per_source: Record<string, { row_count: number; error: string | null; warnings: string[] }> = {};
  for (const source of CALENDAR_SOURCES) {
    const entry = cache.get(source);
    per_source[source] = {
      row_count: entry?.rows.length ?? 0,
      error: entry?.error ?? null,
      warnings: entry?.warnings ?? [],
    };
  }
  return { per_source };
}
