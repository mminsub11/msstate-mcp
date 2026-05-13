import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getCampuses, getTuitionCorpus } from "../tuition/corpus.js";
import { TUITION_DISCLAIMER } from "../tuition/types.js";

const Input = z.object({}).strict();

export const list_msu_tuition_campuses = {
  name: "list_msu_tuition_campuses",
  description:
    "List MSU's 5 published tuition campuses: starkville, meridian, mgccc (Engineering on the Coast — undergrad only), online, vetmed (DVM only, annual_flat). " +
    "Returns each entry's slug, display_name, levels_offered, rate_basis ('per_credit_hour' or 'annual_flat'), and source_url. " +
    "Use this to discover valid `campus` values before calling get_msu_tuition_rate. Every response carries the tuition disclaimer.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    Input.parse(rawInput);
    const corpus = getTuitionCorpus();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: TUITION_DISCLAIMER,
            campuses: getCampuses(),
            corpus_built_at: corpus?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
