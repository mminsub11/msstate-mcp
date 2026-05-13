import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { searchCourses } from "../courses/search.js";
import { getCourse, isCourseCodeValid, isCourseCorpusLoaded } from "../courses/corpus.js";
import { MAX_QUERY_CHARS } from "../courses/types.js";

const Input = z
  .object({ code: z.string().min(1).max(MAX_QUERY_CHARS) })
  .strict();

export const get_msu_course = {
  name: "get_msu_course",
  description:
    "Fetch one course's full record from the MSU catalog: title, hours, level, description, semester offered, prereqs (with structured course-codes + raw prose), coreqs, cross-listed equivalents, source URL. `code` is normalized to uppercase with single space (e.g. 'cse 4153' → 'CSE 4153'). Returns `{found:false, suggestions}` if unknown. Prereq fields `required_courses` and `raw_prose` are authoritative; `logic`, `min_grade`, `non_course` are best-effort parses of MSU's prose.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    if (!isCourseCorpusLoaded()) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "course corpus not loaded — server starting up or build skipped course bake" }],
      };
    }
    const input = Input.parse(rawInput);
    const normalized = isCourseCodeValid(input.code);
    if (!normalized) {
      throw new Error(`invalid_course_code`);
    }
    const course = getCourse(normalized);
    if (course) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ found: true, course }, null, 2) },
        ],
      };
    }
    const suggestions = searchCourses(normalized, 3).map((h) => ({
      code: h.course.code,
      title: h.course.title,
    }));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ found: false, code: normalized, suggestions }, null, 2),
        },
      ],
    };
  },
};
