import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fetchIndex } from "../scraper.js";
import { hybridSearch, indexEntries, attachBody } from "../search.js";
import { getPolicy } from "../corpus.js";
import { PolicyEntry } from "../types.js";

const SearchInput = z.object({
  query: z.string().min(1).describe("Search query (free text)"),
  limit: z.number().int().min(1).max(50).optional().default(10),
  include_body: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, also match against full PDF body text (slower; fetches bodies for top hits).",
    ),
});

export const search_policies = {
  name: "search_policies",
  description:
    "Search Mississippi State University Operating Policies by keyword. Returns policy numbers + titles + URLs + match snippets, ranked by relevance. Use this when the user asks about a topic and you need to find which policies apply. For one-shot natural-language questions ('what's the rule on X?'), prefer `chain_find_relevant_policies` instead, which fetches full bodies in one call.",
  inputSchema: zodToJsonSchema(SearchInput, { target: "openApi3" }),
  zodSchema: SearchInput,
  async handler(rawInput: unknown) {
    const input = SearchInput.parse(rawInput);
    const idx = await fetchIndex();
    indexEntries(idx.rows);

    if (input.include_body) {
      const preTop = await hybridSearch(input.query, { topK: 10 });
      await Promise.all(
        preTop.slice(0, 5).map(async (h) => {
          try {
            const doc = await getPolicy(h.slug);
            attachBody(h.slug, doc.text);
          } catch {
            // ignore single-policy fetch failures; degrade silently.
          }
        }),
      );
    }

    const fused = await hybridSearch(input.query, { topK: input.limit });
    const bySlug = new Map<string, PolicyEntry>(idx.rows.map((r) => [r.slug, r]));
    const results = fused
      .map((h) => {
        const e = bySlug.get(h.slug);
        if (!e) return null;
        return {
          number: e.number,
          title: e.title,
          url: e.landingUrl,
          pdfUrl: e.pdfUrl,
          score: Number(h.score.toFixed(6)),
          bm25Rank: h.bm25Rank,
          embedRank: h.embedRank,
          snippet: h.snippet || e.title,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return {
      content: [
        { type: "text", text: JSON.stringify({ query: input.query, results }, null, 2) },
      ],
    };
  },
};
