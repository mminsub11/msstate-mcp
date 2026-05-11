/**
 * Calendar scraper dispatcher.
 *
 * Routes each CalendarSource to the correct parser based on its Shape:
 *   - Shape A: university_holidays (single-page date table)
 *   - Shape B: academic_calendar, exam_schedule, sfa_financial_aid
 *              (index page + per-term HTML sub-pages)
 *   - Shape C: housing (paginated Drupal event list)
 *   - Shape D: grad_school_calendar (index + per-term PDFs)
 *
 * Two entry points:
 *   - scrapeCalendarFromHtml(source, html, context?) — pure dispatcher, no network.
 *     Used by tests and by scrapeCalendar() after a fetch lands.
 *   - scrapeCalendar(source) — live-fetch entry, handles Shape B fan-out + Shape D PDF
 *     binary downloads + pdf-parse, returns the full row set for the source.
 */
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { httpGet } from "../http.js";
import { log } from "../log.js";
import {
  CALENDAR_URLS,
  CalendarWafError,
  type CalendarRow,
  type CalendarSource,
  type ScrapeResult,
} from "./types.js";
import { parseDateTable, type DateTableSourceId } from "./parsers/date_table.js";
import {
  parseTermIndex,
  parseTermPage,
  TERM_INDEX_CONFIG,
  type TermEntry,
  type TermPageSource,
} from "./parsers/term_pages.js";
import { parseHousingEvents } from "./parsers/event_list.js";
import {
  parseGradIndex,
  parseGradPdfText,
  type GradPdfEntry,
} from "./parsers/pdf_calendar.js";

const SUB_FETCH_CONCURRENCY = 4;
const HTML_TIMEOUT_MS = 15_000;
const PDF_TIMEOUT_MS = 30_000;

export function detectCalendarWaf(body: string): boolean {
  if (body.includes("Just a moment...")) return true;
  if (body.includes("cf-chl-bypass")) return true;
  if (/<meta\s+http-equiv=["']refresh["'][^>]+url=[^>]*token=/i.test(body)) return true;
  const antibot =
    /<form[^>]+class=["'][^"']*antibot/i.test(body) &&
    !/id=["']datatable["']/.test(body);
  return antibot;
}

/**
 * Pure dispatcher. No network. Used by tests and by scrapeCalendar() after
 * a fetch returns. For Shape B and Shape D this only parses the INDEX page;
 * sub-page fan-out happens in scrapeCalendar().
 */
export function scrapeCalendarFromHtml(
  source: CalendarSource,
  html: string,
  context?: { termEntry?: TermEntry; gradEntry?: GradPdfEntry; pdfText?: string },
): ScrapeResult {
  if (detectCalendarWaf(html)) {
    return { source, rows: [], error: `WAF challenge for ${source}` };
  }
  try {
    let rows: CalendarRow[];
    switch (source) {
      case "university_holidays":
        rows = parseDateTable(html, source as DateTableSourceId);
        break;
      case "academic_calendar":
      case "exam_schedule":
      case "sfa_financial_aid":
        // For Shape B, the html arg is either the index (returns no rows here)
        // or a per-term sub-page (caller provides context.termEntry).
        rows = context?.termEntry
          ? parseTermPage(html, source as TermPageSource, context.termEntry)
          : [];
        break;
      case "housing":
        rows = parseHousingEvents(html);
        break;
      case "grad_school_calendar":
        // For Shape D, html arg is the index; caller provides context.pdfText
        // + context.gradEntry when parsing a single PDF.
        if (context?.gradEntry && context?.pdfText) {
          rows = parseGradPdfText(context.pdfText, context.gradEntry);
        } else {
          rows = [];
        }
        break;
    }
    return { source, rows, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("warn", "calendar parser threw", { source, err: message });
    return { source, rows: [], error: message };
  }
}

/** Live-fetch entry. */
export async function scrapeCalendar(source: CalendarSource): Promise<ScrapeResult> {
  switch (source) {
    case "university_holidays":
    case "housing":
      return scrapeSinglePage(source);
    case "academic_calendar":
    case "exam_schedule":
    case "sfa_financial_aid":
      return scrapeTermB(source);
    case "grad_school_calendar":
      return scrapeGradD();
  }
}

async function scrapeSinglePage(
  source: Extract<CalendarSource, "university_holidays" | "housing">,
): Promise<ScrapeResult> {
  const url = CALENDAR_URLS[source];
  try {
    const res = await httpGet(url, { timeoutMs: HTML_TIMEOUT_MS });
    const body = typeof res.body === "string" ? res.body : res.body.toString("utf8");
    return scrapeCalendarFromHtml(source, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("warn", "calendar fetch failed", { source, err: message });
    return { source, rows: [], error: message };
  }
}

async function scrapeTermB(source: TermPageSource): Promise<ScrapeResult> {
  const indexUrl = CALENDAR_URLS[source];
  const config = TERM_INDEX_CONFIG[source];
  let indexBody: string;
  try {
    const res = await httpGet(indexUrl, { timeoutMs: HTML_TIMEOUT_MS });
    indexBody = typeof res.body === "string" ? res.body : res.body.toString("utf8");
  } catch (err) {
    return {
      source,
      rows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (detectCalendarWaf(indexBody)) {
    return { source, rows: [], error: `WAF challenge on ${source} index` };
  }
  const entries = parseTermIndex(indexBody, config);
  if (entries.length === 0) {
    return { source, rows: [], error: "no term entries found in index" };
  }
  const rows: CalendarRow[] = [];
  let lastError: string | null = null;
  for (let i = 0; i < entries.length; i += SUB_FETCH_CONCURRENCY) {
    const batch = entries.slice(i, i + SUB_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        try {
          const res = await httpGet(entry.url, { timeoutMs: HTML_TIMEOUT_MS });
          const body = typeof res.body === "string" ? res.body : res.body.toString("utf8");
          if (detectCalendarWaf(body)) throw new CalendarWafError(source, entry.url);
          return parseTermPage(body, source, entry);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          log("warn", "term page fetch failed", { source, url: entry.url, err: lastError });
          return [] as CalendarRow[];
        }
      }),
    );
    for (const r of results) rows.push(...r);
  }
  return {
    source,
    rows,
    error: rows.length === 0 ? lastError ?? "no rows extracted" : null,
  };
}

async function scrapeGradD(): Promise<ScrapeResult> {
  const indexUrl = CALENDAR_URLS.grad_school_calendar;
  let indexBody: string;
  try {
    const res = await httpGet(indexUrl, { timeoutMs: HTML_TIMEOUT_MS });
    indexBody = typeof res.body === "string" ? res.body : res.body.toString("utf8");
  } catch (err) {
    return {
      source: "grad_school_calendar",
      rows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (detectCalendarWaf(indexBody)) {
    return { source: "grad_school_calendar", rows: [], error: "WAF challenge on grad index" };
  }
  const entries = parseGradIndex(indexBody);
  if (entries.length === 0) {
    return { source: "grad_school_calendar", rows: [], error: "no PDF entries found in grad index" };
  }
  const rows: CalendarRow[] = [];
  let lastError: string | null = null;
  for (let i = 0; i < entries.length; i += SUB_FETCH_CONCURRENCY) {
    const batch = entries.slice(i, i + SUB_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        try {
          const res = await httpGet(entry.url, {
            timeoutMs: PDF_TIMEOUT_MS,
            responseType: "buffer",
            detectWaf: false,
          });
          const buf = res.body as Buffer;
          if (!buf || buf.length < 100 || buf.slice(0, 4).toString() !== "%PDF") {
            throw new Error(`not a valid PDF: ${entry.url}`);
          }
          const parsed = await pdfParse(buf);
          return parseGradPdfText(parsed.text, entry);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          log("warn", "grad PDF fetch/parse failed", { url: entry.url, err: lastError });
          return [] as CalendarRow[];
        }
      }),
    );
    for (const r of results) rows.push(...r);
  }
  return {
    source: "grad_school_calendar",
    rows,
    error: rows.length === 0 ? lastError ?? "no rows extracted" : null,
  };
}
