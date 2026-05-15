import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  getProgramBySlug,
  listAllPrograms,
  getOnlineCorpus,
} from "../online/corpus.js";
import { resolveProgram } from "../online/search.js";
import { ONLINE_DISCLAIMER, MAX_QUERY_CHARS } from "../online/types.js";

const Input = z
  .object({
    slug: z.string().min(1).max(MAX_QUERY_CHARS).optional(),
    name_query: z.string().min(1).max(MAX_QUERY_CHARS).optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.slug) !== Boolean(v.name_query),
    { message: "Exactly one of slug or name_query is required" },
  );

export const get_online_program = {
  name: "get_online_program",
  description:
    "Fetch one MSU Online program's full record from online.msstate.edu: name + degree_level + format + short_description + tuition (per-credit + fees) + contacts (advisors with name/email/phone) + application_deadlines + admission_requirements + entrance_exams + accreditation + forms + raw_sections catch-all. " +
    "Provide `slug` (e.g., 'mba', 'bsee', 'psychology') for direct lookup, OR `name_query` (e.g., 'online psychology bachelor') for fuzzy match. Exactly one is required. " +
    "name_query uses a substring pre-stage (slug or name) first, then falls back to BM25. The top-1 match is in `matched` and the next-2 best are in `did_you_mean` so the model can clarify if ambiguous. When the query strips to no signal (e.g., 'online program'), `matched` is null and `not_found_reason` explains why. Every response carries the online disclaimer.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const corpus = getOnlineCorpus();
    let matched = null;
    let did_you_mean: Array<{ slug: string; name: string }> = [];
    let not_found_reason: string | null = null;
    if (input.slug) {
      matched = getProgramBySlug(input.slug);
      if (!matched) not_found_reason = `No program with slug '${input.slug}' in the corpus. Try list_online_programs to see valid slugs.`;
    } else if (input.name_query) {
      const r = resolveProgram(listAllPrograms(), input.name_query);
      matched = r.matched;
      did_you_mean = r.did_you_mean;
      if (!matched) {
        not_found_reason = r.match_strategy === "no_signal"
          ? `Query '${input.name_query}' had no discriminating tokens after stripping common words (online, program, degree, msu, msstate). Add a program name or subject keyword.`
          : `No program matched '${input.name_query}'. Try list_online_programs(subject_keyword=…) to browse.`;
      }
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: ONLINE_DISCLAIMER,
            matched,
            did_you_mean,
            not_found_reason,
            corpus_built_at: corpus?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
