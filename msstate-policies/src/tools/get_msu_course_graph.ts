import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { walkGraph } from "../courses/prereq.js";
import { getCourseCorpus, isCourseCodeValid, isCourseCorpusLoaded } from "../courses/corpus.js";
import { DEFAULT_GRAPH_DEPTH, MAX_GRAPH_DEPTH, MAX_QUERY_CHARS, MIN_GRAPH_DEPTH } from "../courses/types.js";

const Input = z
  .object({
    code: z.string().min(1).max(MAX_QUERY_CHARS),
    direction: z.enum(["prereqs", "unlocks"]),
    depth: z.number().int().min(MIN_GRAPH_DEPTH).max(MAX_GRAPH_DEPTH).optional(),
  })
  .strict();

export const get_msu_course_graph = {
  name: "get_msu_course_graph",
  description:
    "Walk the MSU course prereq DAG forward (`prereqs` — 'what do I need before X?') or reverse (`unlocks` — 'what does X unlock?'). Returns nodes + edges with depth, plus `truncated:true` if the walk hit the depth cap (default 5, max 10) or a cycle. Edge `logic`/`min_grade` come from the source course's prereq parse and are best-effort; `required_courses` (in the upstream nodes' raw records) is authoritative.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    if (!isCourseCorpusLoaded()) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "course corpus not loaded — server starting up or build skipped course bake" }],
      };
    }
    const input = Input.parse(rawInput);
    const normalized = isCourseCodeValid(input.code);
    if (!normalized) throw new Error("invalid_course_code");
    const corpus = getCourseCorpus();
    if (!corpus) throw new Error("course_corpus_not_loaded");
    const g = walkGraph(corpus, normalized, input.direction, input.depth ?? DEFAULT_GRAPH_DEPTH);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(g, null, 2) }],
    };
  },
};
