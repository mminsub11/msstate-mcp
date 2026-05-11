/**
 * Calendar corpus loader.
 *
 * Local-install: live-scrapes via scraper.ts with a TTL cache.
 * 6h TTL for housing (high volatility); 24h for the other 5 (months-stable).
 *
 * Worker mode: doesn't run this — Worker imports rows from corpus.json.
 */
import { log } from "../log.js";
import {
  CALENDAR_SOURCES,
  type CalendarRow,
  type CalendarSource,
  type ScrapeResult,
} from "./types.js";
import { scrapeCalendar } from "./scraper.js";

interface CacheEntry {
  rows: CalendarRow[];
  expiresAt: number;
  error: string | null;
}

const cache = new Map<CalendarSource, CacheEntry>();

function ttlMsFor(source: CalendarSource): number {
  return source === "housing" ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

export async function loadAllCalendarRows(): Promise<CalendarRow[]> {
  const all: CalendarRow[] = [];
  for (const source of CALENDAR_SOURCES) {
    const result = await loadCalendarSource(source);
    all.push(...result.rows);
  }
  return all;
}

export async function loadCalendarSource(source: CalendarSource): Promise<ScrapeResult> {
  const now = Date.now();
  const hit = cache.get(source);
  if (hit && hit.expiresAt > now) {
    return { source, rows: hit.rows, error: hit.error };
  }
  const result = await scrapeCalendar(source);
  cache.set(source, {
    rows: result.rows,
    error: result.error,
    expiresAt: now + ttlMsFor(source),
  });
  if (result.error) {
    log("warn", "calendar source scrape error", { source, error: result.error });
  }
  return result;
}

export function getCalendarsCorpusHealth(): {
  per_source: Record<string, { row_count: number; error: string | null }>;
} {
  const per_source: Record<string, { row_count: number; error: string | null }> = {};
  for (const source of CALENDAR_SOURCES) {
    const entry = cache.get(source);
    per_source[source] = {
      row_count: entry?.rows.length ?? 0,
      error: entry?.error ?? null,
    };
  }
  return { per_source };
}
