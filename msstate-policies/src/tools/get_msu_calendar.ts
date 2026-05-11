import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CALENDAR_SOURCES, CALENDAR_URLS, type CalendarRow } from "../calendars/types.js";

const GetMsuCalendarInput = z
  .object({
    source: z.enum(CALENDAR_SOURCES as unknown as [string, ...string[]]),
    term: z.string().min(1).max(64).optional(),
  })
  .strict();

let allRows: CalendarRow[] = [];

/** Test seam: the getter reads from a module-scoped row list. In production
 *  this list is populated by the server's startup wiring (Task 10). Tests
 *  call this to seed sample data. */
export function indexCalendarRowsForGetter(rows: CalendarRow[]): void {
  allRows = rows;
}

export const get_msu_calendar = {
  name: "get_msu_calendar",
  description:
    "Return the raw rows for one MSU calendar source. `source` is one of: academic_calendar, exam_schedule, university_holidays, grad_school_calendar, sfa_financial_aid, housing. Optional `term` filter matches via case-insensitive substring (e.g. 'Fall 2026', '2026', 'fall'). Each row has a pre-formatted `citation` markdown link — include it verbatim when surfacing any specific date to the user.",
  inputSchema: zodToJsonSchema(GetMsuCalendarInput, { target: "openApi3" }),
  zodSchema: GetMsuCalendarInput,
  async handler(rawInput: unknown) {
    const input = GetMsuCalendarInput.parse(rawInput);
    const filter = input.term?.toLowerCase();
    const rows = allRows
      .filter((r) => r.source === input.source)
      .filter((r) => !filter || (r.term ?? "").toLowerCase().includes(filter));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              source: input.source,
              term: input.term ?? null,
              rows,
              source_url: CALENDAR_URLS[input.source as keyof typeof CALENDAR_URLS],
              corpus_built_at: null,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
