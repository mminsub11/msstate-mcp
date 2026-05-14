import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { listAllDiningLocations, getDiningCorpus } from "../dining/corpus.js";
import { filterLocations, computeOpenStatus } from "../dining/search.js";
import { DINING_DISCLAIMER, MAX_QUERY_CHARS } from "../dining/types.js";

const Input = z
  .object({
    open_now: z.boolean().optional(),
    name_substring: z.string().max(MAX_QUERY_CHARS).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export const list_msu_dining_locations = {
  name: "list_msu_dining_locations",
  description:
    "Browse / filter MSU's dining locations from msstatedining.mydininghub.com (the Touchpoint platform that dining.msstate.edu redirects to). " +
    "Returns lightweight rows ({slug, name, url, hours_today, status_now}); for full per-location detail follow up with get_msu_dining_hours. " +
    "`open_now=true` filters to venues currently open (uses America/Chicago). " +
    "`name_substring` is case-insensitive substring on name + slug. " +
    "`limit` (default 50, max 200) and `offset` for pagination. " +
    "Every response carries the dining disclaimer; stdio/plugin installs may carry a corpus that's days-months old.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const all = listAllDiningLocations();
    const filterResult = filterLocations(all, {
      name_substring: input.name_substring,
      limit: input.limit,
      offset: input.offset,
    });

    const now = new Date();
    const rows = filterResult.matches.map((m) => {
      const full = all.find((l) => l.slug === m.slug)!;
      return {
        slug: m.slug,
        name: m.name,
        url: m.url,
        hours_today: m.hours_today,
        status_now: computeOpenStatus(full, now),
      };
    });

    const matches = input.open_now
      ? rows.filter((r) => r.status_now === "open" || (typeof r.status_now === "object" && r.status_now.status === "closes_at"))
      : rows;

    const corpus = getDiningCorpus();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: DINING_DISCLAIMER,
            matches,
            total: filterResult.total,
            filtered_total: filterResult.filtered_total,
            corpus_built_at: corpus?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
