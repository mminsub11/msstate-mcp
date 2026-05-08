import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fetchIndex } from "../scraper.js";
import { getPolicy } from "../corpus.js";

const GetInput = z
  .object({
    number: z.string().regex(/^\d{2}\.(\d{2}|\d{3})$/).optional(),
    url: z.string().url().optional(),
  })
  .refine((o) => o.number || o.url, {
    message: "Provide either `number` (NN.NN or NN.NNN) or `url`.",
  });

export const get_policy = {
  name: "get_policy",
  description:
    "Fetch the full text of one MSU Operating Policy by number (e.g. '91.100') or URL. Returns policy text from the official PDF, plus effective/revised dates and responsible office. Use after `search_policies` to read a specific policy in full.",
  inputSchema: zodToJsonSchema(GetInput, { target: "openApi3" }),
  zodSchema: GetInput,
  async handler(rawInput: unknown) {
    const input = GetInput.parse(rawInput);
    let lookup = input.number ?? "";
    if (!lookup && input.url) {
      const idx = await fetchIndex();
      const match = idx.rows.find(
        (r) => r.landingUrl === input.url || r.pdfUrl === input.url,
      );
      if (!match) {
        return {
          isError: true as const,
          content: [
            {
              type: "text",
              text: `Policy URL not found in index: ${input.url}`,
            },
          ],
        };
      }
      lookup = match.number;
    }

    const doc = await getPolicy(lookup);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              number: doc.number,
              title: doc.title,
              url: doc.landingUrl,
              pdfUrl: doc.pdfUrl,
              effectiveDate: doc.effectiveDate,
              reviewedDate: doc.reviewedDate,
              lastRevisedDate: doc.lastRevisedDate,
              responsibleOffice: doc.responsibleOffice,
              approvedBy: doc.approvedBy,
              fallbackToLanding: doc.fallbackToLanding,
              retrievedAt: doc.retrievedAt,
              text: doc.text,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
