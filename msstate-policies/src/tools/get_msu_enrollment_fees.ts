import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getFeeRows, getTuitionCorpus } from "../tuition/corpus.js";
import { filterFeeRows } from "../tuition/search.js";
import { TUITION_DISCLAIMER, MAX_QUERY_CHARS } from "../tuition/types.js";

const Input = z
  .object({
    kind: z.enum(["college", "program", "course_distance"]),
    filter: z.string().max(MAX_QUERY_CHARS).optional(),
  })
  .strict();

export const get_msu_enrollment_fees = {
  name: "get_msu_enrollment_fees",
  description:
    "List MSU's per-college, per-program, and per-course/distance enrollment fees (the 'Other Enrollment Costs' section of controller.msstate.edu). " +
    "`kind`: 'college' (per-credit + full-time-cap by college), 'program' (per-major flat or per-credit), 'course_distance' (online instructional support, course-specific fees). " +
    "`filter` (optional): case-insensitive substring match against the label (e.g. 'engineering', 'honors', 'mba'). " +
    "Every response carries the disclaimer about rates being subject to change. Source: controller.msstate.edu/accountservices/tuition/other-enrollment-costs.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const rows = getFeeRows();
    const matches = filterFeeRows(rows, input.kind, input.filter);
    const corpus = getTuitionCorpus();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: TUITION_DISCLAIMER,
            matches,
            corpus_built_at: corpus?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
