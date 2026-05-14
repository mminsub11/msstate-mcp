import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getAdmissionsProcess, getOnlineCorpus } from "../online/corpus.js";
import { ONLINE_DISCLAIMER } from "../online/types.js";

const Input = z
  .object({
    student_type: z.enum(["undergraduate", "graduate", "transfer", "readmit", "international"]).optional(),
  })
  .strict();

export const get_online_admissions_process = {
  name: "get_online_admissions_process",
  description:
    "Return MSU Online's published admissions process from /admissions-process. Sectioned by student type (undergraduate / graduate / transfer / readmit / international). " +
    "Pass `student_type` to get just one section; omit to get ALL five. " +
    "Either way, the response ALWAYS includes the shared prelude, the central front-desk contact (ask@online.msstate.edu), application fee tiers, and external apply URLs (apply.msstate.edu for undergrad, grad.msstate.edu/apply for graduate). " +
    "Every response carries the online disclaimer about info changing.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const ap = getAdmissionsProcess();
    if (!ap) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              disclaimer: ONLINE_DISCLAIMER,
              shared_prelude: "",
              sections: {},
              central_contact: { name: "", title: "", email: null, phone: null },
              application_fee_tiers: [],
              external_apply_urls: [],
              source_url: "https://www.online.msstate.edu/admissions-process",
              not_found_reason: "Online admissions process is not loaded in the corpus.",
              corpus_built_at: getOnlineCorpus()?.builtAt ?? null,
            }, null, 2),
          },
        ],
      };
    }
    const sections = input.student_type
      ? { [input.student_type]: ap.sections[input.student_type] }
      : ap.sections;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: ONLINE_DISCLAIMER,
            shared_prelude: ap.shared_prelude,
            sections,
            central_contact: ap.central_contact,
            application_fee_tiers: ap.application_fee_tiers,
            external_apply_urls: ap.external_apply_urls,
            source_url: ap.url,
            corpus_built_at: getOnlineCorpus()?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
