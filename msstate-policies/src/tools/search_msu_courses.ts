import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { searchCourses } from "../courses/search.js";
import { MAX_QUERY_CHARS } from "../courses/types.js";

const Input = z
  .object({
    q: z.string().min(1).max(MAX_QUERY_CHARS),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const search_msu_courses = {
  name: "search_msu_courses",
  description:
    "Fuzzy-search the MSU course catalog by code, title, or description (BM25). Returns a ranked list of `{ code, title, hours, dept, level, score }`. Use this when the student doesn't know the exact course code (e.g., 'what's MSU's networking class?'). All content sourced from catalog.msstate.edu.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const limit = input.limit ?? 10;
    const hits = searchCourses(input.q, limit);
    const matches = hits.map((h) => ({
      code: h.course.code,
      title: h.course.title,
      hours: h.course.hours,
      dept: h.course.code.split(/\s+/)[0],
      level: h.course.level,
      score: h.score,
    }));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ matches, notes: [] as string[] }, null, 2),
        },
      ],
    };
  },
};
