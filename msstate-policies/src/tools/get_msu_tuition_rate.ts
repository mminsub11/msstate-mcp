import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getRateRows, getTuitionCorpus } from "../tuition/corpus.js";
import { routeRateRequest } from "../tuition/search.js";
import { TUITION_DISCLAIMER } from "../tuition/types.js";

const Input = z
  .object({
    campus: z.enum(["starkville", "meridian", "mgccc", "online", "vetmed"]),
    level: z.enum(["undergrad", "grad", "dvm"]),
    residency: z.enum(["resident", "non_resident"]),
    term: z.enum(["fall_spring", "winter", "summer", "annual"]).optional(),
    credit_hours: z.number().int().min(1).max(30).optional(),
  })
  .strict();

export const get_msu_tuition_rate = {
  name: "get_msu_tuition_rate",
  description:
    "Look up MSU tuition for a specific campus + level + residency + (optional) term + (optional) credit_hours. " +
    "Returns matching rate rows verbatim with effective_term and a breakdown of line_items. Every response includes the disclaimer 'Tuition rates are subject to change without notice. Always verify the current rate at controller.msstate.edu/accountservices/tuition before paying.' " +
    "Rules: campus=vetmed requires level=dvm (DVM-only flat annual rate); level=dvm requires campus=vetmed; campus=mgccc has no graduate program. " +
    "Undergrad credit_hours buckets: 1-11 (per-hour) and 12-16 (flat full-time). Grad credit_hours buckets: 1-8 and 9+. Hours >16 are capped to the 12-16 bucket. " +
    "Omit term to receive every term variant for that triple. Source: controller.msstate.edu (4 campuses) + vetmed.msstate.edu/tuition.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const rows = getRateRows();
    const result = routeRateRequest(rows, input);
    const corpus = getTuitionCorpus();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: TUITION_DISCLAIMER,
            matches: result.matches,
            ...(result.not_found_reason ? { not_found_reason: result.not_found_reason } : {}),
            corpus_built_at: corpus?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
