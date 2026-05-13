/**
 * Shared types for MSU calendar tools.
 *
 * Field names are stable: tool output schemas and the eval harness reference
 * them. Renaming anything here is a breaking change.
 */

export type CalendarSource =
  | "academic_calendar"
  | "exam_schedule"
  | "university_holidays"
  | "grad_school_calendar"
  | "sfa_financial_aid"
  | "housing";

export const CALENDAR_SOURCES: readonly CalendarSource[] = [
  "academic_calendar",
  "exam_schedule",
  "university_holidays",
  "grad_school_calendar",
  "sfa_financial_aid",
  "housing",
] as const;

/** Canonical landing URL for each source — used as `source_url` on every row. */
export const CALENDAR_URLS: Record<CalendarSource, string> = {
  academic_calendar: "https://www.registrar.msstate.edu/calendars/academic-calendar",
  exam_schedule: "https://www.registrar.msstate.edu/students/schedules/exam-schedule",
  university_holidays: "https://www.hrm.msstate.edu/benefits/holidays/",
  grad_school_calendar: "https://www.grad.msstate.edu/students/graduate-school-calendar",
  sfa_financial_aid: "https://www.sfa.msstate.edu/calendars/",
  housing: "https://www.housing.msstate.edu/events/",
};

/** Term-boundary inheritance: per-audience calendars inherit term definitions
 *  from the registrar's academic calendar. Holidays are orthogonal (no parent).
 *  Used by find_msu_date's smart-fallback path. */
export const CALENDAR_PARENT: Record<CalendarSource, CalendarSource | null> = {
  academic_calendar:    null,
  university_holidays:  null,
  exam_schedule:        "academic_calendar",
  grad_school_calendar: "academic_calendar",
  sfa_financial_aid:    "academic_calendar",
  housing:              "academic_calendar",
};

export interface CalendarRow {
  source: CalendarSource;
  /** Event/deadline name, e.g. "Spring Break", "Halls Close for Spring 2026". */
  event: string;
  /** ISO date, YYYY-MM-DD. */
  start: string;
  /** ISO date; equals `start` for single-day events. */
  end: string;
  /** Raw time string from source, e.g. "12:00 PM CST". Optional. */
  time?: string;
  /** Normalized, e.g. "Spring 2026". Omitted when not applicable (e.g. holidays). */
  term?: string;
  /** Free text from source, truncated to 500 chars. Optional. */
  description?: string;
  /** Canonical msstate.edu URL the row came from. */
  source_url: string;
  /** ISO-8601 UTC timestamp when the row was extracted. */
  retrieved_at: string;
  /** Pre-formatted markdown link for the LLM to include verbatim in its answer.
   *  Format: `[Event, Term](url)` or `[Event](url)` when term is absent.
   *  Computed at scrape time; serialized into worker/corpus.json. */
  citation: string;
  /** Set to true by `find_msu_date` when this row was appended via the smart-fallback
   *  path. Never set at parse/scrape time; never serialized into worker/corpus.json. */
  fallback?: boolean;
  /** SHA-256 hex of `${event}|${term??""}|${description??""}`. Computed at
   *  build time (build-worker-corpus.mjs) or live-scrape time (corpus.ts)
   *  and used to look up the row's embedding vector. Stripped from
   *  find_msu_date JSON-RPC responses to keep the wire shape stable. */
  contentHash?: string;
  /** ~5 LLM-generated paraphrases of the event title. Baked at build time
   *  via Anthropic Haiku for keyword-based semantic expansion. Empty array
   *  for rows that haven't been paraphrased yet (e.g., live-scraped rows
   *  on the stdio plugin whose hash isn't in the sidecar). Stripped from
   *  find_msu_date JSON-RPC responses — see SYN6 security check. */
  synonyms?: string[];
}

/** Result of scraping a single source. */
export interface ScrapeResult {
  source: CalendarSource;
  rows: CalendarRow[];
  /** Set when scrape failed and rows is empty. Logged into health_check. */
  error: string | null;
  /** Per-entry failure messages when some sub-pages/PDFs failed but others succeeded. */
  warnings?: string[];
}

export class CalendarWafError extends Error {
  constructor(public readonly source: CalendarSource, public readonly url: string) {
    super(`WAF challenge detected for ${source} at ${url}`);
    this.name = "CalendarWafError";
  }
}

/** Build the pre-formatted markdown citation link for a CalendarRow.
 *  Label is `Event, Term` (or just `Event` when term is absent),
 *  truncated to 80 chars with an ellipsis if longer. */
export function formatCitation(
  event: string,
  term: string | undefined,
  source_url: string,
): string {
  const label = term ? `${event}, ${term}` : event;
  const safe = label.length > 80 ? `${label.slice(0, 77)}…` : label;
  return `[${safe}](${source_url})`;
}
