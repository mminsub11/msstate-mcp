/**
 * Shape B parser: index page with <a href> links to per-term HTML sub-pages.
 *
 * Used for: academic_calendar (registrar), exam_schedule (registrar),
 * sfa_financial_aid (SFA). All three share the same index-parsing pattern with
 * different URL prefixes; per-source config is in TERM_INDEX_CONFIG.
 *
 * Page layouts observed from live MSU fixtures (2026-05-11):
 *
 *   academic_calendar term pages:
 *     <div class="row g-0 border-bottom">
 *       <div class="col col-md-4">
 *         <div class="card-body py-4">
 *           <time datetime="2026-01-14T12:00:00Z">January 14</time>
 *         </div>
 *       </div>
 *       <div class="col col-md-8">
 *         <div class="card-body py-4">
 *           Classes begin
 *         </div>
 *       </div>
 *     </div>
 *
 *   exam_schedule term pages:
 *     <div class="border-bottom">
 *       <div class="row g-0 card-body p-3">
 *         <div class="col col-sm-2">8:00 AM</div>       <- class start time
 *         <div class="col col-sm-2">MWF</div>           <- days
 *         <div class="col col-sm-4">
 *           <time datetime="2026-05-11T12:00:00Z">Monday, May 11</time>
 *         </div>
 *         <div class="col col-sm-4">
 *           <time datetime="2026-05-11T13:00:00Z">8:00 am</time>
 *           to
 *           <time datetime="2026-05-11T16:00:00Z">11:00 am</time>
 *         </div>
 *       </div>
 *     </div>
 *
 * Public API:
 *   parseTermIndex(html, config): TermEntry[]
 *   parseTermPage(html, source, entry): CalendarRow[]
 *   TERM_INDEX_CONFIG: Record<TermPageSource, TermIndexConfig>
 */
import { load as cheerioLoad } from "cheerio";
import { formatCitation, type CalendarRow, type CalendarSource } from "../types.js";
import { log } from "../../log.js";

export type TermPageSource = Extract<
  CalendarSource,
  "academic_calendar" | "exam_schedule" | "sfa_financial_aid"
>;

export interface TermIndexConfig {
  /** Origin (scheme + host), used to absolutize relative index links. */
  origin: string;
  /** Regex matching the per-term path. Must have 2 capture groups: year, slug. */
  pathPattern: RegExp;
}

export const TERM_INDEX_CONFIG: Record<TermPageSource, TermIndexConfig> = {
  academic_calendar: {
    origin: "https://www.registrar.msstate.edu",
    pathPattern: /^\/calendars\/academic-calendar\/(\d{4})\/([\w-]+)$/,
  },
  exam_schedule: {
    origin: "https://www.registrar.msstate.edu",
    pathPattern: /^\/students\/schedules\/exam-schedule\/(\d{4})\/([\w-]+)$/,
  },
  sfa_financial_aid: {
    origin: "https://www.sfa.msstate.edu",
    // Confirmed 2026-05-11: SFA index uses /calendars/academic-calendar/<year>/<slug>.
    pathPattern: /^\/calendars\/academic-calendar\/(\d{4})\/([\w-]+)$/,
  },
};

export interface TermEntry {
  url: string;
  year: number;
  /** Visible text of the link, e.g. "Spring", "Fall Mini-Term One". */
  term: string;
}

/**
 * Parse an index page to find all per-term sub-page links.
 * Links are deduplicated; only hrefs matching config.pathPattern are included.
 */
export function parseTermIndex(html: string, config: TermIndexConfig): TermEntry[] {
  const $ = cheerioLoad(html);
  const out: TermEntry[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const m = href.match(config.pathPattern);
    if (!m) return;
    const year = Number(m[1]);
    const visibleText = $(el).text().trim().replace(/\s+/g, " ");
    if (!visibleText) return;
    const abs = `${config.origin}${href}`;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ url: abs, year, term: visibleText });
  });

  return out;
}

// ---- Per-source term-page extractors ----------------------------------------

interface RawRow {
  event: string;
  /** ISO date string YYYY-MM-DD extracted from <time datetime>. */
  isoDate: string;
  /** Optional end-date for multi-day ranges (second <time datetime>). */
  isoDateEnd?: string;
  /** Optional raw time string (e.g. "8:00 am to 11:00 am"). */
  time?: string;
}

/**
 * Extract rows from an academic_calendar (or sfa_financial_aid) term page.
 *
 * Structure: div.row.g-0.border-bottom (one per event)
 *   - col-md-4: one <time datetime="YYYY-MM-DDTHH:MM:SSZ"> for single-day
 *     events, OR two <time> elements (start + end, separated by " to") for
 *     multi-day ranges like Spring Break and advising windows.
 *   - col-md-8: plain text — the event description
 */
function extractAcademicCalendarRows(html: string): RawRow[] {
  const $ = cheerioLoad(html);
  const out: RawRow[] = [];

  $("div.row.g-0").each((_i, el) => {
    const $row = $(el);
    if (!$row.hasClass("border-bottom")) return;

    const dateCol = $row.find("div[class*='col-md-4']").first();
    const timeEls = dateCol.find("time[datetime]").toArray();
    if (timeEls.length === 0) return;

    const firstDatetime = $(timeEls[0]).attr("datetime") ?? "";
    const firstMatch = firstDatetime.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!firstMatch) return;
    const isoDate = firstMatch[1];

    let isoDateEnd: string | undefined;
    if (timeEls.length >= 2) {
      const lastDatetime = $(timeEls[timeEls.length - 1]).attr("datetime") ?? "";
      const lastMatch = lastDatetime.match(/^(\d{4}-\d{2}-\d{2})/);
      if (lastMatch) {
        const candidate = lastMatch[1];
        // Lexicographic ISO compare; allow equal so degenerate "<time>X</time> to <time>X</time>" is preserved.
        if (candidate >= isoDate) {
          isoDateEnd = candidate;
        } else {
          log("warn", "academic_calendar end-date precedes start; dropping end", {
            isoDate,
            candidateEnd: candidate,
          });
        }
      }
    }

    const eventCol = $row.find("div[class*='col-md-8']").first();
    let event = eventCol.text().replace(/\s+/g, " ").trim();
    if (!event) {
      const dateText = $(timeEls[0]).text().trim();
      event = $row.text().replace(dateText, "").replace(/\s+/g, " ").trim();
    }
    if (!event) return;

    out.push({ event, isoDate, isoDateEnd });
  });

  return out;
}

/**
 * Extract rows from an exam_schedule term page.
 *
 * Structure: div.border-bottom (one per exam slot)
 *   Contains div.row.g-0 with 4 child cols:
 *     [0] class start time  (text, e.g. "8:00 AM")
 *     [1] days              (text, e.g. "MWF")
 *     [2] exam date         (<time datetime="YYYY-MM-DDTHH:MM:SSZ">)
 *     [3] exam time range   (<time> to <time>)
 *
 * The event string is synthesized as "{class-time} {days} class" to allow the
 * LLM to answer queries like "when is the exam for my 8AM MWF class?".
 */
function extractExamScheduleRows(html: string): RawRow[] {
  const $ = cheerioLoad(html);
  const out: RawRow[] = [];

  // Data rows: any div with class containing 'border-bottom' that wraps a
  // div.row.g-0 (but is not itself the header row which has fw-bold children).
  $("div").filter((_i, el) => {
    const cls = $(el).attr("class") ?? "";
    return /\bborder-bottom\b/.test(cls);
  }).each((_i, el) => {
    const $wrapper = $(el);

    // Skip the header row (direct fw-bold children).
    if ($wrapper.find("> div.fw-bold, > div > .fw-bold").length > 0) return;

    const $innerRow = $wrapper.find("div.row.g-0").first();
    if (!$innerRow.length) return;

    // Skip if the inner row itself contains fw-bold (header).
    if ($innerRow.find(".fw-bold").length > 0) return;

    const cols = $innerRow.find("div[class*='col-sm']").toArray();
    if (cols.length < 3) return;

    const classTime = $(cols[0]).text().replace(/\s+/g, " ").trim();
    const days = cols.length > 1 ? $(cols[1]).text().replace(/\s+/g, " ").trim() : "";

    // Exam date: first <time> with a full-date datetime in col[2].
    const dateColIdx = Math.min(2, cols.length - 2);
    const dateEl = $(cols[dateColIdx])
      .find("time[datetime]")
      .filter((_j, t) => /^\d{4}-\d{2}-\d{2}/.test($(t).attr("datetime") ?? ""))
      .first();
    if (!dateEl.length) return;

    const datetime = dateEl.attr("datetime") ?? "";
    const isoMatch = datetime.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!isoMatch) return;
    const isoDate = isoMatch[1];

    // Exam time range from col[3].
    let timeStr: string | undefined;
    if (cols.length >= 4) {
      const timeTexts = $(cols[3])
        .find("time")
        .map((_j, t) => $(t).text().trim())
        .get();
      if (timeTexts.length >= 2) {
        timeStr = `${timeTexts[0]} to ${timeTexts[timeTexts.length - 1]}`;
      } else if (timeTexts.length === 1) {
        timeStr = timeTexts[0];
      }
    }

    // Build event string: "8:00 AM MWF class"
    const parts = [classTime, days].filter(Boolean);
    const event = parts.length > 0 ? `${parts.join(" ")} class` : "Exam";

    out.push({ event, isoDate, time: timeStr });
  });

  return out;
}

// ---- Source dispatch -------------------------------------------------------

type RowExtractor = (html: string) => RawRow[];

const EXTRACTORS: Record<TermPageSource, RowExtractor> = {
  academic_calendar: extractAcademicCalendarRows,
  exam_schedule: extractExamScheduleRows,
  // SFA shares the academic_calendar layout (Bootstrap grid rows with col-md-4/col-md-8).
  // Confirmed 2026-05-11: live SFA term pages use the same structure; no new extractor needed.
  sfa_financial_aid: extractAcademicCalendarRows,
};

// ---- Public entry ----------------------------------------------------------

export function parseTermPage(
  html: string,
  source: TermPageSource,
  entry: TermEntry,
): CalendarRow[] {
  const extractor = EXTRACTORS[source];
  const raw = extractor(html);
  const retrievedAt = new Date().toISOString();
  const fullTerm = `${capitalizeTerm(entry.term)} ${entry.year}`;

  const seenKey = new Set<string>();
  const rows: CalendarRow[] = [];
  for (const r of raw) {
    // isoDate is already YYYY-MM-DD from the <time datetime> attribute.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.isoDate)) continue;
    const event = r.event.slice(0, 200);
    const key = `${event}|${r.isoDate}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    rows.push({
      source,
      event,
      start: r.isoDate,
      end: r.isoDateEnd ?? r.isoDate,
      time: r.time,
      term: fullTerm,
      source_url: entry.url,
      retrieved_at: retrievedAt,
      citation: formatCitation(event, fullTerm, entry.url),
    });
  }
  return rows;
}

// Re-export parseDateRange so callers that need text-based date parsing
// alongside this module (e.g. Task 4 SFA if its layout differs) can import
// from a single location.
export { parseDateRange } from "./date_table.js";

// ---- Helpers ---------------------------------------------------------------

function capitalizeTerm(t: string): string {
  return t
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
