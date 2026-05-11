/**
 * Shape A parser: single-page date table.
 *
 * Used for: university_holidays, academic_calendar, exam_schedule,
 * grad_school_calendar. Each source has its own selector + row-normalization
 * function below; the public parseDateTable dispatches by source id.
 *
 * Page structure varies per source. Inspect each fixture (see tests/fixtures/
 * calendars/) before adjusting selectors.
 */
import { load as cheerioLoad } from "cheerio";
import { CALENDAR_URLS, type CalendarRow, type CalendarSource } from "../types.js";

export type DateTableSourceId = Extract<
  CalendarSource,
  "academic_calendar" | "exam_schedule" | "university_holidays" | "grad_school_calendar"
>;

interface RawRow {
  event: string;
  rawDate: string;
  time?: string;
  term?: string;
  description?: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * Parse a date or date range from MSU page text.
 * Returns [startIso, endIso] in YYYY-MM-DD form, or null if unparseable.
 *
 * Handles these formats (observed across MSU sites):
 *   "January 20, 2026"
 *   "January 20-24, 2026"
 *   "December 22, 2025 - January 2, 2026"
 *   "Nov 25-29, 2025"
 *   "Tuesday, November 25, 2025"
 *   "December 23, 2026, through January 1, 2027"
 */
export function parseDateRange(
  raw: string,
  fallbackYear?: number,
): [string, string] | null {
  const clean = raw.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

  // Two-month range: "Month D, YYYY - Month D, YYYY" or "Month D, YYYY, through Month D, YYYY"
  const twoMonth = clean.match(
    /([A-Za-z]+)\s+(\d{1,2})(?:,)?\s*(\d{4})?(?:,)?\s*(?:-|through)\s*([A-Za-z]+)\s+(\d{1,2})(?:,)?\s*(\d{4})?/,
  );
  if (twoMonth) {
    const m1 = MONTHS[twoMonth[1].toLowerCase()];
    const m2 = MONTHS[twoMonth[4].toLowerCase()];
    const d1 = Number(twoMonth[2]);
    const d2 = Number(twoMonth[5]);
    const y1 = twoMonth[3] ? Number(twoMonth[3]) : (twoMonth[6] ? Number(twoMonth[6]) : fallbackYear);
    const y2 = twoMonth[6] ? Number(twoMonth[6]) : (y1 ?? fallbackYear);
    if (m1 && m2 && y1 && y2) return [iso(y1, m1, d1), iso(y2, m2, d2)];
  }

  // Single-month range: "Month D-D, YYYY"
  const oneMonthRange = clean.match(/([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2})(?:,)?\s*(\d{4})?/);
  if (oneMonthRange) {
    const m = MONTHS[oneMonthRange[1].toLowerCase()];
    const d1 = Number(oneMonthRange[2]);
    const d2 = Number(oneMonthRange[3]);
    const y = oneMonthRange[4] ? Number(oneMonthRange[4]) : fallbackYear;
    if (m && y) return [iso(y, m, d1), iso(y, m, d2)];
  }

  // Single date: "Month D, YYYY" or "DayOfWeek, Month D, YYYY"
  const single = clean.match(/([A-Za-z]+)\s+(\d{1,2})(?:,)?\s*(\d{4})?/);
  if (single) {
    const m = MONTHS[single[1].toLowerCase()];
    const d = Number(single[2]);
    const y = single[3] ? Number(single[3]) : fallbackYear;
    if (m && y) {
      const v = iso(y, m, d);
      return [v, v];
    }
  }
  return null;
}

function iso(y: number, m: number, d: number): string {
  return `${y}`.padStart(4, "0") + "-" + `${m}`.padStart(2, "0") + "-" + `${d}`.padStart(2, "0");
}

// ---- Per-source extractors -------------------------------------------------

/**
 * Extractor for https://www.hrm.msstate.edu/benefits/holidays/
 *
 * The page has multiple calendar-year sections, each with a 4-column table:
 *   col[0] = event name  (e.g. "Memorial Day")
 *   col[1] = day-of-week (e.g. "Monday")  — ignored
 *   col[2] = day count   (e.g. "1")       — ignored
 *   col[3] = date string (e.g. "May 25, 2026" or "December 23, 2026, through January 1, 2027")
 *
 * Rows where col[0] is blank/whitespace-only (e.g. "Last Day Worked" rows,
 * "Total Calendar … Holidays" summary rows) are skipped because they don't
 * represent actual holiday events.
 */
function extractUniversityHolidays(html: string): RawRow[] {
  const $ = cheerioLoad(html);
  const out: RawRow[] = [];

  $("table.table tr").each((_i, el) => {
    const cells = $(el).find("td").map((_j, td) => $(td).text().replace(/ /g, " ").trim()).get();
    if (cells.length < 4) return;

    const event = cells[0];
    const rawDate = cells[3];

    // Skip blank event names (summary/annotation rows)
    if (!event) return;
    // Skip summary rows like "Total Calendar 2026 Holidays"
    if (/total\s+calendar/i.test(event)) return;

    out.push({ event, rawDate });
  });

  return out;
}

function extractGenericRegistrarTable(_html: string): RawRow[] {
  // Placeholder — real extractors land in Task 3 when the 3 remaining
  // fixtures are captured.
  return [];
}

const EXTRACTORS: Record<DateTableSourceId, (html: string) => RawRow[]> = {
  university_holidays: extractUniversityHolidays,
  academic_calendar: extractGenericRegistrarTable,
  exam_schedule: extractGenericRegistrarTable,
  grad_school_calendar: extractGenericRegistrarTable,
};

// ---- Public entry ----------------------------------------------------------

export function parseDateTable(html: string, source: DateTableSourceId): CalendarRow[] {
  const extractor = EXTRACTORS[source];
  const raw = extractor(html);
  const retrievedAt = new Date().toISOString();
  // Infer a fallback year from the first 4-digit year on the page (per-page,
  // not training-data).
  const yearGuess = (() => {
    const $ = cheerioLoad(html);
    const text = $("main, body").text();
    const m = text.match(/\b(20\d{2})\b/);
    return m ? Number(m[1]) : undefined;
  })();
  const rows: CalendarRow[] = [];
  for (const r of raw) {
    const range = parseDateRange(r.rawDate, yearGuess);
    if (!range) continue;
    rows.push({
      source,
      event: r.event.slice(0, 200),
      start: range[0],
      end: range[1],
      time: r.time,
      term: r.term,
      description: r.description?.slice(0, 500),
      source_url: CALENDAR_URLS[source],
      retrieved_at: retrievedAt,
    });
  }
  return rows;
}
