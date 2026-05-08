import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getPolicy } from "../corpus.js";

const CiteInput = z.object({
  number: z
    .string()
    .regex(/^\d{2}\.(\d{2}|\d{3})$/)
    .describe("Policy number, e.g. 91.100"),
  style: z.enum(["short", "full"]).optional().default("full"),
});

export const cite_policy = {
  name: "cite_policy",
  description:
    "Format a citation string for one MSU Operating Policy. Use after `get_policy` or `chain_find_relevant_policies` when you need a cleanly formatted reference for an answer.",
  inputSchema: zodToJsonSchema(CiteInput, { target: "openApi3" }),
  zodSchema: CiteInput,
  async handler(rawInput: unknown) {
    const input = CiteInput.parse(rawInput);
    const doc = await getPolicy(input.number);
    const today = new Date().toISOString().slice(0, 10);
    const eff = doc.effectiveDate ? `, effective ${doc.effectiveDate}` : "";
    const citation =
      input.style === "short"
        ? `MSU OP ${doc.number} (${doc.title})`
        : `Mississippi State University Operating Policy ${doc.number}, "${doc.title}"${eff}. Retrieved from ${doc.landingUrl} on ${today}.`;
    return {
      content: [{ type: "text", text: citation }],
    };
  },
};
