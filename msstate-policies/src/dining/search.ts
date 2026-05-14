/**
 * Dining search helpers.
 *
 * Three responsibilities:
 *   filterLocations    - deterministic filter for list_msu_dining_locations.
 *   fuzzyResolveLocation - score-based resolver for get_msu_dining_hours.
 *   computeOpenStatus  - TZ-aware "is this venue open right now?".
 */
import type {
  DiningHoursDay,
  DiningLocation,
  DiningStatus,
} from "./types.js";

const TOKEN_SPLIT = /[\s\-_/.,;:()\[\]{}!?"'`<>|@#$%^&*=+]+/;

function tokenize(s: string): string[] {
  return s.normalize("NFKC").toLowerCase().split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

function countOf(token: string, arr: string[]): number {
  let c = 0;
  for (const t of arr) if (t === token) c++;
  return c;
}

// -------- filterLocations --------------------------------------------------

export interface LocationFilterRequest {
  open_now?: boolean;
  name_substring?: string;
  limit?: number;
  offset?: number;
}

export interface LocationFilterResult {
  matches: Array<{
    slug: string;
    name: string;
    url: string;
    hours_today: DiningHoursDay | null;
  }>;
  total: number;
  filtered_total: number;
}

export function filterLocations(
  locations: DiningLocation[],
  req: LocationFilterRequest,
): LocationFilterResult {
  let filtered = locations;

  if (req.name_substring && req.name_substring.trim().length > 0) {
    const k = req.name_substring.trim().toLowerCase();
    filtered = filtered.filter(
      (l) => l.name.toLowerCase().includes(k) || l.slug.toLowerCase().includes(k),
    );
  }

  const limit = Math.max(1, Math.min(req.limit ?? 50, 200));
  const offset = Math.max(0, req.offset ?? 0);

  const matches = filtered.slice(offset, offset + limit).map((l) => ({
    slug: l.slug,
    name: l.name,
    url: l.url,
    hours_today: l.hours_today,
  }));

  return { matches, total: locations.length, filtered_total: filtered.length };
}

// -------- fuzzyResolveLocation ---------------------------------------------

export interface FuzzyResolveResult {
  matched: DiningLocation | null;
  did_you_mean: Array<{ slug: string; name: string }>;
}

export function fuzzyResolveLocation(
  locations: DiningLocation[],
  query: string,
): FuzzyResolveResult {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return { matched: null, did_you_mean: [] };

  const scored = locations.map((l) => {
    const slugT = tokenize(l.slug);
    const nameT = tokenize(l.name);
    let score = 0;
    for (const q of qTokens) {
      score += 4 * countOf(q, slugT);
      score += 3 * countOf(q, nameT);
    }
    return { l, score };
  }).filter((x) => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { matched: null, did_you_mean: [] };

  return {
    matched: scored[0].l,
    did_you_mean: scored.slice(1, 3).map((x) => ({ slug: x.l.slug, name: x.l.name })),
  };
}

// -------- computeOpenStatus ------------------------------------------------

const DAY_NAMES = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
] as const;
type DayName = (typeof DAY_NAMES)[number];

function chicagoNowParts(now: Date): { day: DayName; hh: number; mm: number; totalMinutes: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = f.formatToParts(now);
  const weekday = (parts.find((p) => p.type === "weekday")?.value ?? "").toLowerCase() as DayName;
  const hh = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const mm = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { day: weekday, hh, mm, totalMinutes: hh * 60 + mm };
}

function hmToMinutes(hm: string): number | null {
  const m = hm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

export function computeOpenStatus(location: DiningLocation, now: Date): DiningStatus {
  if (location.hours_by_day.length === 0) return "unknown";

  const { day, totalMinutes } = chicagoNowParts(now);
  const today = location.hours_by_day.find((d) => d.day_of_week === day) ?? null;

  if (!today) return "unknown";
  if (today.closed || today.periods.length === 0) return "closed";

  for (const p of today.periods) {
    const openM = hmToMinutes(p.open);
    const closeM = hmToMinutes(p.close);
    if (openM === null || closeM === null) continue;
    if (totalMinutes >= openM && totalMinutes < closeM) {
      if (closeM - totalMinutes <= 30) return { status: "closes_at", at: p.close };
      return "open";
    }
    if (totalMinutes < openM) {
      return { status: "opens_at", at: p.open };
    }
  }

  return "closed";
}
