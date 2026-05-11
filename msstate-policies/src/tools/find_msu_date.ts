import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { searchCalendarRows } from "../calendars/search.js";

const FindMsuDateInput = z
  .object({
    q: z
      .string()
      .min(1, "q is required")
      .max(4096, "q too long (max 4096 chars)")
      .describe("Natural-language MSU date question, e.g. 'when does spring break start?'"),
  })
  .strict();

export const find_msu_date = {
  name: "find_msu_date",
  description:
    "Answer natural-language questions about Mississippi State University academic dates, financial-aid deadlines, university holidays, residence-life milestones, and graduate-school deadlines. Returns up to 10 matching calendar rows ranked by relevance, each with start/end dates, the source calendar, and the canonical msstate.edu URL. RULES for answering: (1) Use ONLY the returned rows — do not draw on outside knowledge. (2) Quote the date verbatim and cite the `source_url`. (3) If `matches` is empty or no row clearly answers the question, say so plainly and recommend the source URL or contacting the responsible MSU office. (4) Surface the row's `retrieved_at` (and `corpus_built_at` when present) so users can verify freshness. (5) IMPORTANT MULTI-YEAR HANDLING: if the user's question does NOT specify a year/term and multiple year-versions of an event exist (e.g., Spring Break 2026 and Spring Break 2027), present ALL of them year-by-year — do not pick one arbitrarily. Example response: 'Spring Break 2026 begins March 9 and ends March 13. Spring Break 2027 begins March 8 and ends March 12.'",
  inputSchema: zodToJsonSchema(FindMsuDateInput, { target: "openApi3" }),
  zodSchema: FindMsuDateInput,
  async handler(rawInput: unknown) {
    const input = FindMsuDateInput.parse(rawInput);
    const hits = searchCalendarRows(input.q, 10);
    const matches = hits.map((h) => ({
      source: h.row.source,
      event: h.row.event,
      start: h.row.start,
      end: h.row.end,
      time: h.row.time,
      term: h.row.term,
      description: h.row.description,
      source_url: h.row.source_url,
      retrieved_at: h.row.retrieved_at,
      score: Number(h.score.toFixed(6)),
    }));
    const notes = buildNotes(matches);
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
): string {
  if (matches.length === 0) {
    return "No MSU calendar row matched this query. If the question is about an MSU date or deadline, try a more specific phrasing or check the source calendar directly.";
  }
  // Detect multi-year coverage: same event-stem appearing across distinct terms
  const byStem = new Map<string, Set<string>>();
  for (const m of matches) {
    const stem = firstSignificantWord(m.event).toLowerCase();
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

function firstSignificantWord(s: string): string {
  const words = s.split(/\s+/).filter((w) => !/^(the|a|an|of|for|to|in|on|at)$/i.test(w));
  return words[0] ?? s;
}
