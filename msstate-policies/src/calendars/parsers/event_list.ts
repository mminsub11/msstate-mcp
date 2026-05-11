/**
 * Shape C parser: paginated Drupal events list (housing).
 *
 * The housing page (https://www.housing.msstate.edu/events/) renders events
 * as Bootstrap card components. Each card has:
 *   - div.news-card  — outer wrapper (one per event)
 *   - h2.news-card-title — event title
 *   - <time>          — contains an h3 (date) and optionally a p (time-of-day)
 *
 * Date formats observed in the fixture:
 *   "May 15, 2026"                  — single day
 *   "May 18, 2026  to May 29, 2026" — date range (uses "to" separator)
 *   "June 5, 2026  2:00 pm"         — single day with time-of-day
 *
 * We parse page 1 only; pagination is deferred to a future round.
 */
import { load as cheerioLoad } from "cheerio";
import { CALENDAR_URLS, type CalendarRow } from "../types.js";
import { parseDateRange } from "./date_table.js";

export function parseHousingEvents(html: string): CalendarRow[] {
  const $ = cheerioLoad(html);
  const retrievedAt = new Date().toISOString();
  const rows: CalendarRow[] = [];

  $("div.news-card").each((_i, el) => {
    // Title
    const title = $(el).find("h2.news-card-title, h3.news-card-title").first().text().trim();
    if (!title) return;

    // Date + time-of-day live inside the <time> element
    const timeEl = $(el).find("time").first();
    if (!timeEl.length) return;

    // h3 = start date line, p = either time-of-day OR the end of a date range.
    // Two structural variants:
    //   Single day:  h3="May 15, 2026"   p="12:00 pm"
    //   Date range:  h3="May 18, 2026"   p=" to May 29, 2026"
    const dateText = timeEl.find("h3").first().text().trim();
    const pText = timeEl.find("p").first().text().replace(/\s+/g, " ").trim();

    // Detect range: the <p> starts with "to" followed by a month name
    const isRangePart = /^to\s+[A-Za-z]/i.test(pText);
    const timeOfDay = isRangePart ? undefined : (pText || undefined);

    // Build raw date: combine h3 + range suffix when applicable
    const rawDate = isRangePart
      ? `${dateText} ${pText}` // e.g. "May 18, 2026 to May 29, 2026"
      : dateText || timeEl.text().replace(/\s+/g, " ").trim();
    if (!rawDate) return;

    const range = parseHousingDate(rawDate);
    if (!range) return;

    // Description from the card paragraph (not the time-of-day paragraph)
    const description = $(el)
      .find("p")
      .filter((_j, p) => {
        const cls = $(p).attr("class") || "";
        // Exclude the time-of-day paragraph (fw-light) and label spans
        return !cls.includes("fw-light") && !cls.includes("news-card-topic-label-text");
      })
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);

    rows.push({
      source: "housing",
      event: title.slice(0, 200),
      start: range[0],
      end: range[1],
      time: timeOfDay && timeOfDay.length > 0 ? timeOfDay : undefined,
      description: description.length > 0 ? description : undefined,
      source_url: CALENDAR_URLS.housing,
      retrieved_at: retrievedAt,
    });
  });

  return rows;
}

/**
 * Parse a date string extracted from a housing event card.
 *
 * Handles the housing-specific "to" range separator in addition to the
 * formats supported by parseDateRange (-, through, etc.).
 *
 * Examples:
 *   "May 15, 2026"                  → ["2026-05-15", "2026-05-15"]
 *   "May 18, 2026 to May 29, 2026"  → ["2026-05-18", "2026-05-29"]
 */
function parseHousingDate(raw: string): [string, string] | null {
  // Normalize whitespace
  const clean = raw.replace(/\s+/g, " ").trim();

  // Housing-specific: "Month D, YYYY to Month D, YYYY"
  const toRange = clean.match(
    /([A-Za-z]+\s+\d{1,2},?\s*\d{4})\s+to\s+([A-Za-z]+\s+\d{1,2},?\s*\d{4})/i,
  );
  if (toRange) {
    const start = parseDateRange(toRange[1]);
    const end = parseDateRange(toRange[2]);
    if (start && end) return [start[0], end[1]];
  }

  // Fall back to the shared parseDateRange for all other formats
  return parseDateRange(clean);
}
