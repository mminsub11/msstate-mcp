import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getAllCalendarRows, searchCalendarRows } from "../calendars/search.js";
import type { CalendarRow } from "../calendars/types.js";

const FindMsuDateInput = z
  .object({
    q: z
      .string()
      .min(1, "q is required")
      .max(4096, "q too long (max 4096 chars)")
      .describe("Natural-language MSU date question, e.g. 'when does spring break start?'"),
  })
  .strict();

const TERM_RX = /\b(Spring|Fall|Summer|Winter|Maymester)\s+(\d{4})\b/i;

function matchTerm(q: string): string | null {
  const m = q.match(TERM_RX);
  if (!m) return null;
  const season = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${season} ${m[2]}`;
}

const FALLBACK_PRIORITY: RegExp[] = [
  /classes\s+begin/i,
  /last\s+day\s+of\s+classes?/i,
  /final\s+exam/i,
  /spring\s+break|thanksgiving|fall\s+break|winter\s+break/i,
  /commencement|graduation/i,
  /classes?\s+end/i,
];

function sortByEventPriority(rows: CalendarRow[]): CalendarRow[] {
  return [...rows].sort((a, b) => {
    const aIdx = FALLBACK_PRIORITY.findIndex((rx) => rx.test(a.event));
    const bIdx = FALLBACK_PRIORITY.findIndex((rx) => rx.test(b.event));
    const aRank = aIdx === -1 ? FALLBACK_PRIORITY.length : aIdx;
    const bRank = bIdx === -1 ? FALLBACK_PRIORITY.length : bIdx;
    if (aRank !== bRank) return aRank - bRank;
    return a.start.localeCompare(b.start);
  });
}

export const find_msu_date = {
  name: "find_msu_date",
  description:
    "Answer natural-language questions about Mississippi State University academic dates, financial-aid deadlines, university holidays, residence-life milestones, and graduate-school deadlines. Returns up to 10 matching calendar rows ranked by relevance, plus up to 3 academic-calendar fallback rows when a term is mentioned and the primary source has limited coverage.\n\nEach row has:\n- `start`, `end` — ISO dates (YYYY-MM-DD).\n- `event`, `term`, `description` — what happened and when.\n- `source`, `source_url` — which calendar and the canonical msstate.edu URL.\n- `citation` — a pre-formatted markdown link. You MUST include this verbatim in your final answer for every row you reference. Do not paraphrase or omit it. Format: `[Event, Term](url)`.\n- `fallback` (optional) — if true, this row came from the academic-calendar fallback because the user's primary source didn't have data for the mentioned term. Surface this explicitly: \"Your primary source doesn't list this date for that term, but the academic calendar shows…\"\n\nRULES:\n1. Use ONLY the returned rows. Do not invent dates or draw on outside knowledge.\n2. Quote the date verbatim. Always include the `citation` field as a clickable link.\n3. If the user's question does NOT specify a year/term and multiple year-versions of an event exist (e.g., Spring Break 2026 and Spring Break 2027), present ALL of them year-by-year with each one's citation.\n4. If matches is empty or no row clearly answers the question, say so plainly; do not extrapolate.\n5. Surface the row's `retrieved_at` and `corpus_built_at` when accuracy is at stake.",
  inputSchema: zodToJsonSchema(FindMsuDateInput, { target: "openApi3" }),
  zodSchema: FindMsuDateInput,
  async handler(rawInput: unknown) {
    const input = FindMsuDateInput.parse(rawInput);
    const hits = searchCalendarRows(input.q, 10);
    const matches: Array<CalendarRow & { score?: number }> = hits.map((h) => ({
      ...h.row,
      score: Number(h.score.toFixed(6)),
    }));

    // Smart fallback: when a term is mentioned AND the BM25 results include
    // no rows for that term from a non-academic source (suggesting the
    // primary source lacks data for that term) but DO include non-academic
    // rows from other terms, supplement with up to 3 academic_calendar rows
    // for that term tagged fallback: true.
    const term = matchTerm(input.q);
    let fallbackTriggered = false;
    if (term) {
      const nonAcademicForTerm = matches.filter(
        (m) => m.source !== "academic_calendar" && m.term === term,
      ).length;
      const hasNonAcademicResults = matches.some(
        (m) => m.source !== "academic_calendar",
      );
      if (nonAcademicForTerm === 0 && hasNonAcademicResults) {
        // Primary source returned results but none for this term.
        // Tag existing academic rows for this term as fallback.
        const academicForTerm = matches.filter(
          (m) => m.source === "academic_calendar" && m.term === term,
        );
        for (const m of academicForTerm) {
          m.fallback = true;
          fallbackTriggered = true;
        }
        // Append additional academic_calendar rows not already in matches.
        const matchedUrls = new Set(academicForTerm.map((m) => m.source_url));
        const all = getAllCalendarRows();
        const extras = all.filter(
          (r) => r.source === "academic_calendar"
            && r.term === term
            && !matchedUrls.has(r.source_url),
        );
        const sorted = sortByEventPriority(extras as CalendarRow[]).slice(
          0,
          Math.max(0, 3 - academicForTerm.length),
        );
        for (const e of sorted) {
          matches.push({ ...e, fallback: true });
          fallbackTriggered = true;
        }
      }
    }

    const notes = buildNotes(matches, fallbackTriggered, term);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { q: input.q, matches, notes, corpus_built_at: null },
            null,
            2,
          ),
        },
      ],
    };
  },
};

function buildNotes(
  matches: Array<{ event: string; term?: string }>,
  fallbackTriggered: boolean,
  term: string | null,
): string {
  if (matches.length === 0) {
    return "No MSU calendar row matched this query. If the question is about an MSU date or deadline, try a more specific phrasing or check the source calendar directly.";
  }
  if (fallbackTriggered && term) {
    return `Surfaced academic_calendar rows for ${term} as fallback — if your primary source didn't have this term, the academic calendar is authoritative for term-boundary dates.`;
  }
  // Detect multi-year coverage: same event-stem appearing across distinct terms
  const byStem = new Map<string, Set<string>>();
  for (const m of matches) {
    const firstWord = m.event.split(/\s+/).filter((w) => !/^(the|a|an|of|for|to|in|on|at)$/i.test(w))[0] ?? m.event;
    const stem = firstWord.toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, new Set());
    if (m.term) byStem.get(stem)!.add(m.term);
  }
  const multiYearStems = [...byStem.entries()].filter(([, terms]) => terms.size >= 2);
  if (multiYearStems.length > 0) {
    const [stem, terms] = multiYearStems[0];
    return `Multi-year matches: '${stem}' appears in ${terms.size} distinct terms (${[...terms].join(", ")}). Present each year-version separately.`;
  }
  return "";
}

