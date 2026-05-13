import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { findRefugeArea } from "../emergency/search.js";
import { MANDATORY_DISCLAIMER, MAX_QUERY_CHARS } from "../emergency/types.js";

const Input = z
  .object({ building_name: z.string().min(1).max(MAX_QUERY_CHARS) })
  .strict();

const SCOPE_NOTE =
  "Severe-weather refuge areas only. For fires, evacuate via the nearest exit (see `smoke-fire` / `building-evacuations`). For active threats, see `violence-threats-of-violence`.";

const FALLBACK_GUIDANCE =
  "If your building isn't listed, the published guidance is: go to the lowest interior level, away from windows, in a small interior room or hallway.";

const REFUGE_URL = "https://www.emergency.msstate.edu/refuge";

export const find_msu_severe_weather_refuge = {
  name: "find_msu_severe_weather_refuge",
  description:
    "Look up the published severe-weather refuge area for an MSU building (e.g. 'Colvard', 'Lee Hall'). Returns `{ building, area, note }` rows from www.emergency.msstate.edu/refuge. This tool covers severe weather ONLY — for fires use `get_msu_emergency_guideline(\"smoke-fire\")`; for active threats use `get_msu_emergency_guideline(\"violence\")`. Every response leads with the 911 disclaimer. If the building isn't in the table, returns a `fallback_when_no_match` with the published interior-room guidance.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const matches = findRefugeArea(input.building_name);
    if (matches.length > 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                disclaimer: MANDATORY_DISCLAIMER,
                scope_note: SCOPE_NOTE,
                matches,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              disclaimer: MANDATORY_DISCLAIMER,
              scope_note: SCOPE_NOTE,
              matches: [],
              fallback_when_no_match: { guidance: FALLBACK_GUIDANCE, source_url: REFUGE_URL },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
