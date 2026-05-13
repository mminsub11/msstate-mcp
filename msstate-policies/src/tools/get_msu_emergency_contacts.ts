import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { filterContacts, isValidCategoryInput } from "../emergency/corpus.js";
import { MANDATORY_DISCLAIMER, MAX_QUERY_CHARS } from "../emergency/types.js";

const Input = z
  .object({
    category: z.string().max(MAX_QUERY_CHARS).optional().default("all"),
  })
  .strict();

const REFUGE_URL = "https://www.emergency.msstate.edu/refuge";
const ALLOWED = ["all", "emergency", "campus", "off_campus"];

export const get_msu_emergency_contacts = {
  name: "get_msu_emergency_contacts",
  description:
    "Return MSU emergency-related phone contacts (911, MSU PD non-emergency, Dean of Students, Counseling, Health, Facilities, IT, plus off-campus: OCH Hospital, Starkville PD/FD, Sheriff's Office). `category` accepts: 'all' (default), 'emergency', 'campus', 'off_campus'. Every response leads with the 911 disclaimer. All numbers sourced from www.emergency.msstate.edu/refuge.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    if (!isValidCategoryInput(input.category)) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                disclaimer: MANDATORY_DISCLAIMER,
                error: `invalid category: ${input.category}`,
                allowed: ALLOWED,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    const contacts = filterContacts(input.category).map((c) => ({
      label: c.label,
      phone: c.phone,
      category: c.category,
    }));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              disclaimer: MANDATORY_DISCLAIMER,
              contacts,
              source_url: REFUGE_URL,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
