/**
 * Dining HTML parsers.
 *
 * Two parsers:
 *   parseSitemapLocations - cheerio against /en/sitemap (server-rendered HTML)
 *   parseLocationHoursDom - cheerio against POST-Playwright DOM string (NOT raw shell)
 */
import { load as cheerioLoad } from "cheerio";
import {
  LOCATION_SLUG_RE,
  type DiningHoursDay,
  type DiningIndexEntry,
  type DiningLocation,
  type DiningMealPeriod,
  type DiningParseWarning,
} from "./types.js";

const LOCATION_HREF_RE = /^\/en\/location\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/i;

/**
 * Extract location index entries from the Touchpoint sitemap.
 *
 * The page renders a flat list of <a href="/en/location/<slug>"> elements.
 * We dedupe by slug and skip the "Locations & Menus" parent link.
 */
export function parseSitemapLocations(
  html: string,
  _pageUrl: string,
): DiningIndexEntry[] {
  const $ = cheerioLoad(html);
  const out: DiningIndexEntry[] = [];
  const seen = new Set<string>();

  $("a[href^='/en/location/']").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const m = href.match(LOCATION_HREF_RE);
    if (!m) return;
    const slug = m[1];
    if (!LOCATION_SLUG_RE.test(slug)) return;
    if (seen.has(slug)) return;

    const name = $(a).text().replace(/\s+/g, " ").trim();
    if (name.length === 0) return;

    seen.add(slug);
    out.push({
      slug,
      name,
      url: `https://msstatedining.mydininghub.com/en/location/${slug}`,
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// parseLocationHoursDom — Touchpoint location detail page
// ---------------------------------------------------------------------------
//
// DOM pattern (as of May 2026, Touchpoint / Elevate DXP):
//   <h1 class="mb-md mt-sm ...">Perry Food Hall</h1>
//
//   After clicking "This Week's Hours" button, a <dialog data-testid="modal">
//   is injected into the DOM. Inside it, day-group rows appear as:
//
//     <div class="gap-xs flex items-center justify-between">
//       <h3 class="text-heading-6 ...">Monday - Wednesday</h3>
//       [optional inline time text if no meal-period breakdown]
//     </div>
//     <dl data-testid="meal-periods-list">
//       <dt>Breakfast</dt><dd>7:00AM-10:30AM</dd>
//       <dt>Lunch</dt>    <dd>10:30AM-3:00PM</dd>
//       ...
//     </dl>
//
//   OR (simple venues with no per-meal breakdown):
//     <div class="gap-xs flex items-center justify-between">
//       <h3>Saturday</h3>11:00AM-8:00PM   ← inline in the div text node
//     </div>
//
//   OR (closed all day):
//     <div class="gap-xs flex items-center justify-between">
//       <h3>Saturday - Sunday (Commencement Hours)</h3>Closed
//     </div>
//
//   Day ranges like "Monday - Wednesday" are expanded into individual entries.
//
// Scraper responsibility: The scraper clicks the "This Week's Hours" button
// and waits for the dialog to open before calling page.content(). Without that
// click, the modal is absent and this parser emits no_hours_extracted.

const DAY_NAMES = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
] as const;
type DayName = (typeof DAY_NAMES)[number];

const DAY_LABEL_TO_ENUM: Record<string, DayName> = {
  monday: "monday",   mon: "monday",
  tuesday: "tuesday", tues: "tuesday", tue: "tuesday",
  wednesday: "wednesday", wed: "wednesday",
  thursday: "thursday", thurs: "thursday", thu: "thursday",
  friday: "friday",   fri: "friday",
  saturday: "saturday", sat: "saturday",
  sunday: "sunday",   sun: "sunday",
};

/** Parse a day label word (case-insensitive) to a canonical DayName, or null. */
function parseDayWord(word: string): DayName | null {
  return DAY_LABEL_TO_ENUM[word.toLowerCase()] ?? null;
}

/**
 * Expand a label like "Monday - Wednesday" or "Thursday - Friday (Summer Hours)"
 * into an array of canonical DayNames covering the range.
 * Falls back to a single-day match if no range separator is found.
 */
function expandDayRange(label: string): DayName[] {
  // Strip parenthesised qualifiers like "(Commencement Hours)"
  const clean = label.replace(/\s*\([^)]*\)/g, "").trim();

  // Split on " - " or "–" or "—" (en/em dash)
  const parts = clean.split(/\s*[-–—]\s*/);
  const startDay = parseDayWord(parts[0].trim());
  if (!startDay) return [];

  if (parts.length < 2) return [startDay];

  // Could be "Thursday - Friday" → range
  const endDay = parseDayWord(parts[parts.length - 1].trim());
  if (!endDay) return [startDay];

  if (startDay === endDay) return [startDay];

  const startIdx = DAY_NAMES.indexOf(startDay);
  const endIdx   = DAY_NAMES.indexOf(endDay);
  if (startIdx < 0 || endIdx < 0) return [startDay];

  // Handle wrap-around (e.g. Saturday - Sunday is fine; Monday - Sunday = all)
  const days: DayName[] = [];
  const len = DAY_NAMES.length;
  let i = startIdx;
  while (true) {
    days.push(DAY_NAMES[i % len]);
    if (i % len === endIdx) break;
    i++;
    if (i - startIdx > len) break; // safety: prevent infinite loop
  }
  return days;
}

/**
 * Convert a 12-hour time string to "HH:MM" 24-hour string, or null if unparseable.
 * Accepts: "7:00AM", "10:30AM", "5:00PM", "11AM", etc.
 */
function parse12Hour(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const period = m[3].toLowerCase();
  if (hh < 1 || hh > 12 || mm < 0 || mm > 59) return null;
  if (period === "am") hh = hh === 12 ? 0 : hh;
  else                 hh = hh === 12 ? 12 : hh + 12;
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}

/**
 * Parse a time-range string like "7:00AM-10:30AM" or "10:30AM-5:00PM".
 * The separator may be a hyphen, en-dash, em-dash, or the word "to".
 */
function parseTimeRange(raw: string): { open: string; close: string } | null {
  const normalized = raw.replace(/[‐\-–—]|(?<=\d)\s+to\s+(?=\d)/gi, "-");
  const m = normalized.match(
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*-\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
  );
  if (!m) return null;
  const open  = parse12Hour(m[1]);
  const close = parse12Hour(m[2]);
  if (!open || !close) return null;
  return { open, close };
}

/**
 * Extract the hours schedule from the Touchpoint location detail DOM.
 *
 * Looks for <dialog data-testid="modal"> which is present only when the
 * scraper has already clicked the "This Week's Hours" button.
 */
function extractHoursByDay(
  $: ReturnType<typeof cheerioLoad>,
): { byDay: DiningHoursDay[]; rawText: string } {
  const byDay: DiningHoursDay[] = [];
  const seenDays = new Set<DayName>();
  const rawLines: string[] = [];

  // The weekly-hours dialog
  const modal = $("dialog[data-testid='modal']");
  if (modal.length === 0) {
    return { byDay: [], rawText: "" };
  }

  // Each day-group row is a direct div child of the inner flex-col container.
  // We walk all children of the inner container; when we find a div that
  // contains an <h3> we treat it as a day header row.
  const innerContainer = modal.find("div.gap-sm.flex.flex-col").first();
  const children = innerContainer.children().toArray();

  for (let i = 0; i < children.length; i++) {
    const child = $(children[i]);
    const h3 = child.find("h3").first();
    if (h3.length === 0) continue; // <hr> separators and other non-day elements

    const dayLabel = h3.text().replace(/\s+/g, " ").trim();
    const days = expandDayRange(dayLabel);
    if (days.length === 0) continue;

    // Raw text for the entire row (heading + any sibling text / time nodes)
    const rowText = child.text().replace(/\s+/g, " ").trim();

    // Check for a following sibling <dl data-testid="meal-periods-list">
    let periods: DiningMealPeriod[] = [];
    let closedAllDay = false;

    // Look for a <dl> that is the NEXT sibling (or next non-hr sibling)
    let nextEl = children[i + 1] ? $(children[i + 1]) : null;
    // Skip <hr> separators
    while (nextEl && nextEl.is("hr")) {
      i++;
      nextEl = children[i + 1] ? $(children[i + 1]) : null;
    }

    const dlEl = nextEl && nextEl.is("dl[data-testid='meal-periods-list']")
      ? nextEl
      : child.next("dl[data-testid='meal-periods-list']");

    if (dlEl && dlEl.length > 0) {
      // Meal-period breakdown: each <dt>/<dd> pair
      const dts = dlEl.find("dt").toArray();
      const dds = dlEl.find("dd").toArray();
      for (let j = 0; j < dts.length; j++) {
        const label = $(dts[j]).text().replace(/\s+/g, " ").trim();
        const timeText = dds[j] ? $(dds[j]).text().replace(/\s+/g, " ").trim() : "";
        if (/closed/i.test(timeText)) continue; // skip closed individual periods
        const range = parseTimeRange(timeText);
        if (range) {
          periods.push({ open: range.open, close: range.close, label: label || null });
        }
      }
      // Advance i past the <dl>
      i++;
    } else {
      // No <dl> — look for inline text node inside the row div (after the h3)
      // e.g. <div><h3>Saturday</h3>11:00AM-8:00PM</div>
      // OR   <div><h3>Saturday - Sunday ...</h3>Closed</div>
      const divText = rowText.replace(dayLabel, "").trim();
      if (/closed/i.test(divText) && !parseTimeRange(divText)) {
        closedAllDay = true;
      } else {
        const range = parseTimeRange(divText);
        if (range) {
          periods.push({ open: range.open, close: range.close, label: null });
        }
        // If divText is empty and no dl, closed = false, periods = [] (unusual data)
      }
    }

    // Expand the day range
    for (const day of days) {
      if (seenDays.has(day)) continue;
      seenDays.add(day);
      byDay.push({
        day_of_week: day,
        closed: closedAllDay || (periods.length === 0 && /closed/i.test(rowText)),
        periods: closedAllDay ? [] : periods,
        raw_text: `${dayLabel}: ${rowText.replace(dayLabel, "").trim()}`,
      });
      rawLines.push(`${day}: ${rowText.replace(dayLabel, "").trim()}`);
    }
  }

  // Sort Monday-first
  byDay.sort((a, b) => DAY_NAMES.indexOf(a.day_of_week) - DAY_NAMES.indexOf(b.day_of_week));

  return { byDay, rawText: rawLines.join("\n") };
}

/**
 * Determine today's DiningHoursDay from a byDay array (UTC-based, server-agnostic).
 */
function pickToday(byDay: DiningHoursDay[]): DiningHoursDay | null {
  const utcDay = new Date().getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const mapIdx: DayName[] = [
    "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
  ];
  const want = mapIdx[utcDay];
  return byDay.find((d) => d.day_of_week === want) ?? null;
}

/**
 * Parse a Playwright-rendered Touchpoint location detail page.
 *
 * The page must have been captured AFTER the scraper clicked "This Week's Hours"
 * to expand the weekly schedule modal. Without that interaction, hours_by_day
 * will be empty and the warning "no_hours_extracted" is emitted.
 *
 * @param html  - Full page HTML string (from page.content() after modal open)
 * @param slug  - URL slug (e.g. "perry-food-hall")
 * @param url   - Canonical URL (e.g. "https://msstatedining.mydininghub.com/en/location/perry-food-hall")
 * @returns DiningLocation — never null
 */
export function parseLocationHoursDom(
  html: string,
  slug: string,
  url: string,
): DiningLocation {
  const $ = cheerioLoad(html);

  // Location name: first <h1> on the detail page
  const nameFromH1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  const titleRaw   = $("title").text().replace(/\s+/g, " ").trim();
  // Strip the site suffix: "Foo Bar - Mississippi State University"
  const titleCandidate = titleRaw.split(/\s+[-–—|]\s+/)[0]?.trim() ?? "";
  const name = (nameFromH1.length > 1 ? nameFromH1 : titleCandidate) || slug;

  const { byDay, rawText } = extractHoursByDay($);

  const parse_warnings: DiningParseWarning[] = [];
  if (byDay.length === 0) {
    parse_warnings.push("no_hours_extracted");
  } else if (byDay.every((d) => !d.closed && d.periods.length === 0)) {
    parse_warnings.push("hours_format_unrecognized");
  }

  const hours_today         = pickToday(byDay);
  const meal_periods_today  = hours_today?.periods ?? [];

  return {
    slug,
    name,
    url,
    hours_by_day:       byDay,
    hours_today,
    hours_raw_text:     rawText,
    meal_periods_today,
    parse_warnings,
    retrieved_at:       "1970-01-01T00:00:00.000Z",
  };
}
