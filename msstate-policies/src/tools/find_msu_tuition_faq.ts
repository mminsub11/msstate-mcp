import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getTuitionCorpus } from "../tuition/corpus.js";
import { bm25SearchFaq } from "../tuition/search.js";
import { TUITION_DISCLAIMER, MAX_QUERY_CHARS } from "../tuition/types.js";

const Input = z
  .object({
    q: z.string().min(1).max(MAX_QUERY_CHARS),
    k: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const find_msu_tuition_faq = {
  name: "find_msu_tuition_faq",
  description:
    "Search MSU's tuition FAQ (controller.msstate.edu/accountservices/tuition/frequently-asked-questions) for a question. " +
    "Returns the top-k matching Q&A pairs verbatim with their source anchor URL. " +
    "`q`: free-text question (e.g. 'why are college fees different?', 'how do I find my campus?'). " +
    "`k`: 1-10, default 3. Every response carries the tuition disclaimer. BM25 over question×2 + answer×1.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const k = input.k ?? 3;
    const hits = bm25SearchFaq(input.q, k);
    const corpus = getTuitionCorpus();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: TUITION_DISCLAIMER,
            matches: hits.map((h) => ({
              question: h.row.question,
              answer: h.row.answer,
              source_url: h.row.source_url,
              bm25_score: h.score,
              retrieved_at: h.row.retrieved_at,
            })),
            corpus_built_at: corpus?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
