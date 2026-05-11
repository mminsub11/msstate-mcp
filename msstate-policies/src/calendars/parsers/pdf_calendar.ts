/**
 * Shape D parser: index page with <a href> links to per-term PDF files.
 *
 * Used for: grad_school_calendar. Each PDF contains a date-table-style
 * layout that pdf-parse converts to whitespace-delimited text. We extract
 * event + date pairs heuristically from the text.
 *
 * PDF fetching happens in scraper.ts; this module deals with the index
 * HTML and the already-extracted PDF text. That separation lets us test
 * without writing a binary fixture into the test harness, and keeps this
 * file CF-Worker-safe (the Worker uses snapshot rows from corpus.json
 * and never calls pdf-parse at request time).
 *
 * Observed PDF text structure (Spring 2026):
 *   "January 14 Classes Begin"
 *   "January 5 – 8 Graduate Teaching Assistant Workshop..."
 *   "January 28 – March 27 Apply online via MyState..."
 *   "March 9 – 13 Spring Break – No Classes Scheduled..."
 * Dates appear WITHOUT year in most entries; year comes from the entry metadata.
 * Continuation lines (wrapped event text) have no date prefix — they are skipped.
 */
import { load as cheerioLoad } from "cheerio";
import { CALENDAR_URLS, type CalendarRow } from "../types.js";
import { parseDateRange } from "./date_table.js";

const GRAD_PDF_HREF_RE =
  /\/sites\/www\.grad\.msstate\.edu\/files\/\d{4}-\d{2}\/[^"]+\.pdf$/i;

export interface GradPdfEntry {
  url: string;   // absolute URL
  year: number;  // 4-digit, extracted from link text or filename
  term: string;  // human-readable, e.g. "Spring", "Summer First Term"
}

/**
 * Parse the grad school calendar index HTML and return a list of per-term
 * PDF entries with their absolute URLs, year, and term label.
 */
export function parseGradIndex(html: string): GradPdfEntry[] {
  const $ = cheerioLoad(html);
  const out: GradPdfEntry[] = [];
  const seen = new Set<string>();

  $("a[href$='.pdf']").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (!GRAD_PDF_HREF_RE.test(href)) return;

    const visibleText = $(el).text().trim().replace(/\s+/g, " ");
    if (!visibleText) return;

    const abs = href.startsWith("http")
      ? href
      : `https://www.grad.msstate.edu${href}`;
    if (seen.has(abs)) return;
    seen.add(abs);

    // Parse year + term from visible link text, e.g.:
    //   "Spring 2026"             → term="Spring", year=2026
    //   "Summer First Term 2026"  → term="Summer First Term", year=2026
    //   "Maymester 2026"          → term="Maymester", year=2026
    const yearMatch = visibleText.match(/\b(20\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : NaN;
    if (Number.isNaN(year)) return;

    const term = visibleText.replace(/\b20\d{2}\b/, "").trim().replace(/\s+/g, " ");
    if (!term) return;

    out.push({ url: abs, year, term });
  });

  return out;
}

// Month name → used to detect date-leading lines.
const MONTH_NAMES = new Set([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/**
 * Return true if `line` starts with a date token (Month name at position 0).
 *
 * This is used to distinguish "new event" lines from continuation lines
 * (wrapped event text that has no date prefix).
 */
function lineStartsWithDate(line: string): boolean {
  const first = line.split(/[\s,]+/)[0].toLowerCase();
  return MONTH_NAMES.has(first);
}

/**
 * Extract calendar rows from PDF-parsed text.
 *
 * Strategy: scan line by line. A line starting with a month name begins a
 * new event; its date is in the prefix and the remainder is the event text.
 * Lines NOT starting with a month name are continuation lines (event wraps
 * across lines in the PDF) — we append them to the previous event.
 *
 * After accumulating all (datePrefix, eventText) pairs, we run parseDateRange
 * on each datePrefix using the caller-supplied fallbackYear.
 *
 * Returns rows annotated with the caller-provided source URL + term/year.
 */
export function parseGradPdfText(
  text: string,
  entry: GradPdfEntry,
): CalendarRow[] {
  const retrievedAt = new Date().toISOString();
  const termLabel = `${capitalizeTerm(entry.term)} ${entry.year}`;

  // ---- Normalise text -------------------------------------------------------
  // Replace en/em dashes with ASCII hyphen so date-range patterns work.
  const normalized = text
    .replace(/[–—]/g, "-")
    .replace(/\r?\n/g, "\n");

  const lines = normalized
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // ---- Accumulate (datePrefix, eventText) pairs ----------------------------
  interface Pending {
    datePrefix: string;  // e.g. "January 5 - 8"
    eventParts: string[];
  }

  const pending: Pending[] = [];
  let current: Pending | null = null;

  for (const line of lines) {
    if (lineStartsWithDate(line)) {
      // Save the previous pending entry before starting a new one.
      if (current) pending.push(current);

      // Split the line into the date portion and the event portion.
      // The date ends at the first word that is NOT a month/number/dash/hyphen.
      //
      // Patterns to match:
      //   "January 14 Classes Begin"
      //   "January 5 - 8 Graduate..."
      //   "January 28 - March 27 Apply..."
      //   "March 9 - 13 Spring Break..."
      const datePrefixMatch = line.match(
        // Month D[-D], YYYY?  or  Month D - Month D, YYYY?
        /^([A-Za-z]+\s+\d{1,2}(?:\s*-\s*(?:[A-Za-z]+\s+)?\d{1,2})?(?:,?\s*\d{4})?)\s+([\s\S]+)/,
      );

      if (datePrefixMatch) {
        current = {
          datePrefix: datePrefixMatch[1],
          eventParts: [datePrefixMatch[2].trim()],
        };
      } else {
        // The line starts with a month name but the rest doesn't parse as an
        // event (e.g. a header line "Date Description"). Discard it.
        current = null;
      }
    } else {
      // Continuation line: append to current event if one is active.
      // Skip obvious header/junk lines.
      if (current && !isJunkLine(line)) {
        current.eventParts.push(line);
      }
    }
  }
  if (current) pending.push(current);

  // ---- Convert to CalendarRow -----------------------------------------------
  const rows: CalendarRow[] = [];
  const seenKey = new Set<string>();

  for (const p of pending) {
    const range = parseDateRange(p.datePrefix, entry.year);
    if (!range) continue;

    // Join continuation lines with a space; trim trailing punctuation glitches.
    const eventRaw = p.eventParts.join(" ").replace(/\s+/g, " ").trim();
    if (!eventRaw || eventRaw.length < 2) continue;

    // Skip rows whose "event" text is really a header or page decoration.
    if (isJunkLine(eventRaw)) continue;

    const key = `${range[0]}|${range[1]}|${eventRaw.slice(0, 40)}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    rows.push({
      source: "grad_school_calendar",
      event: eventRaw.slice(0, 200),
      start: range[0],
      end: range[1],
      term: termLabel,
      source_url: entry.url,
      retrieved_at: retrievedAt,
    });
  }

  return rows;
}

/** Lines that should never become events (headers, footers, standalone notes). */
function isJunkLine(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return true;
  if (/^(date|description|event|day|page \d+)$/.test(t)) return true;
  if (/^graduate (school )?calendar/.test(t)) return true;
  if (/^all deadlines are at/.test(t)) return true;
  return false;
}

function capitalizeTerm(t: string): string {
  return t
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Canonical index URL for grad school. Used by the scraper when no per-row URL is available. */
export const GRAD_INDEX_URL = CALENDAR_URLS.grad_school_calendar;
