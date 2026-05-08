import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fetchIndex } from "../scraper.js";
import { hybridSearch, indexEntries, gateRetrieval } from "../search.js";
import { getPolicies } from "../corpus.js";

const ChainInput = z.object({
  question: z.string().min(1).describe("Natural-language MSU policy question."),
  k: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(2)
    .describe(
      "How many top policies to fetch in full. Default 2 keeps response under ~16k tokens.",
    ),
});

export const chain_find_relevant_policies = {
  name: "chain_find_relevant_policies",
  description:
    "One-call workflow for natural-language MSU policy questions ('what are the rules on amnesty?', 'what's the policy on withdrawal?'). Returns the full text of the top-k most relevant MSU Operating Policies. RULES for answering: (1) Use ONLY the returned text — do not draw on outside knowledge. (2) For any normative claim ('the policy says X', 'you must Y', deadlines, eligibility criteria, dollar amounts, exceptions), QUOTE VERBATIM from the policy text in quotation marks and cite the OP number + URL. Do not paraphrase load-bearing language. (3) If the returned policies don't clearly answer the question, say so plainly and recommend contacting the responsible office; do NOT extrapolate. (4) Always include the `retrievedAt` timestamp and the canonical landing URL so the user can verify.",
  inputSchema: zodToJsonSchema(ChainInput, { target: "openApi3" }),
  zodSchema: ChainInput,
  async handler(rawInput: unknown) {
    const input = ChainInput.parse(rawInput);
    const idx = await fetchIndex();
    indexEntries(idx.rows);

    const fused = await hybridSearch(input.question, { topK: input.k });

    // F2 (codex_review.md): gate on confidence at the MCP layer instead of
    // pushing every refusal decision to the LLM. Permissive defaults keep the
    // existing eval set passing; tighter thresholds can be calibrated later.
    const gate = gateRetrieval(fused);
    if (gate.rejected) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                question: input.question,
                results: [],
                note: `No policies met the confidence threshold. Recommend asking the responsible office directly. (gate: ${gate.reason})`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const docs = await getPolicies(gate.accept.map((h) => h.slug));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              question: input.question,
              k: input.k,
              results: docs.map((d) => ({
                number: d.number,
                title: d.title,
                url: d.landingUrl,
                pdfUrl: d.pdfUrl,
                effectiveDate: d.effectiveDate,
                lastRevisedDate: d.lastRevisedDate,
                responsibleOffice: d.responsibleOffice,
                fallbackToLanding: d.fallbackToLanding,
                retrievedAt: d.retrievedAt,
                text: d.text,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
