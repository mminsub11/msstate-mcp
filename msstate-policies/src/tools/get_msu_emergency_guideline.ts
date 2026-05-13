import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { resolveGuideline } from "../emergency/search.js";
import { listGuidelines, getEmergencyCorpus } from "../emergency/corpus.js";
import { MANDATORY_DISCLAIMER, MAX_QUERY_CHARS } from "../emergency/types.js";

const Input = z
  .object({
    emergency_type: z.string().min(1).max(MAX_QUERY_CHARS),
  })
  .strict();

function contactsQuick() {
  const c = getEmergencyCorpus()?.contacts ?? [];
  const e911 = c.find((x) => x.phone === "911");
  const pd = c.find((x) => /police/i.test(x.label) && x.category === "campus_non_emergency");
  const out: { label: string; phone: string }[] = [];
  if (e911) out.push({ label: e911.label, phone: e911.phone });
  if (pd) out.push({ label: pd.label, phone: pd.phone });
  return out;
}

export const get_msu_emergency_guideline = {
  name: "get_msu_emergency_guideline",
  description:
    "Look up MSU's published emergency guideline for a situation (tornado, fire, active shooter, etc.). Returns the guideline verbatim plus a 911 reminder. Every response leads with the disclaimer 'If this is a life-threatening emergency, call 911 now...'. `emergency_type` accepts a slug, an alias ('tornado', 'fire', 'shooter'), or free text — the resolver tries exact slug, then the curated alias map, then BM25. All content sourced from www.emergency.msstate.edu/guidelines.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const r = resolveGuideline(input.emergency_type);
    if (r.matched) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              disclaimer: MANDATORY_DISCLAIMER,
              matched: {
                slug: r.matched.slug,
                title: r.matched.title,
                url: r.matched.url,
                body_markdown: r.matched.body_markdown,
                retrieved_at: r.matched.retrieved_at,
              },
              did_you_mean: r.did_you_mean.map((g) => ({ slug: g.slug, title: g.title })),
              contacts_quick: contactsQuick(),
            }, null, 2),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: MANDATORY_DISCLAIMER,
            matched: null,
            did_you_mean: [],
            suggestions: listGuidelines().map((g) => ({ slug: g.slug, title: g.title })),
            contacts_quick: contactsQuick(),
          }, null, 2),
        },
      ],
    };
  },
};
