/**
 * Shared types for the MSU course catalog tools.
 *
 * Field names are stable: tool output schemas, the eval harness, and the
 * baked corpus.json all reference them. Renaming is a breaking change.
 *
 * Corpus rule: every value in a `Course` record must come from
 * `catalog.msstate.edu` — no training data, no third-party sources.
 */

/** Frozen allowlist of catalog URL roots. The scraper must only ever fetch
 *  URLs whose path starts with one of these. Per-course URLs are extracted
 *  from index/dept HTML, never constructed from external input. */
export const CATALOG_ROOTS: readonly string[] = Object.freeze([
  "https://catalog.msstate.edu/azindex/",
  "https://catalog.msstate.edu/undergraduate/",
  "https://catalog.msstate.edu/graduate/",
  "https://catalog.msstate.edu/search/",
]);

/** Maximum input string length accepted by any course tool. Mirrors the
 *  policy/calendar tool cap. Worker enforces this BEFORE parsing. */
export const MAX_QUERY_CHARS = 4096;

/** Inclusive bounds for `get_msu_course_graph`'s `depth` argument. */
export const MIN_GRAPH_DEPTH = 1;
export const MAX_GRAPH_DEPTH = 10;
export const DEFAULT_GRAPH_DEPTH = 5;

/** Canonical course-code shape, e.g. "CSE 4153" or "BIO 1134".
 *  Must be uppercased and trimmed before matching. */
export const COURSE_CODE_RE = /^[A-Z]{2,4}\s\d{4}$/;

/** Prereq prose decomposed via the two-pass parser (see parser.ts).
 *
 *  Authoritative fields (lossless against MSU prose):
 *    - required_courses
 *    - raw_prose
 *
 *  Best-effort fields (parser may flag "mixed"/null when prose is ambiguous):
 *    - logic, min_grade, non_course
 *
 *  Tool descriptions document this split so the LLM client knows which
 *  fields to trust unconditionally. */
export interface Prereq {
  required_courses: string[];
  logic: "or" | "and" | "mixed" | null;
  min_grade: "A" | "B" | "C" | "D" | null;
  non_course: string[];
  raw_prose: string;
}

export interface Course {
  code: string;
  title: string;
  /** Number when catalog gives a single integer ("3"). String when it gives
   *  a range or pair ("3-4", "0,4"). */
  hours: number | string;
  level: "undergraduate" | "graduate";
  description: string;
  /** "F", "Sp", "Su", "F, Sp", etc. — `null` when not published. */
  semester_offered: string | null;
  prereqs: Prereq | null;
  coreqs: Prereq | null;
  /** Course codes that MSU notes as cross-listed equivalents. */
  cross_listed: string[];
  /** Canonical catalog URL for this course. */
  source_url: string;
}

/** Adjacency list keyed by course code. */
export type DagAdjacency = Record<string, string[]>;

/** Whole baked block written to worker/corpus.json under `courses`. */
export interface CourseCorpus {
  version: string;
  /** ISO-8601 UTC timestamp of the scrape. */
  scraped_at: string;
  records: Record<string, Course>;
  forward_dag: DagAdjacency;
  reverse_dag: DagAdjacency;
}

export interface GraphNode {
  code: string;
  title: string;
  depth: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  logic: "or" | "and" | "mixed" | null;
  min_grade: "A" | "B" | "C" | "D" | null;
}

export interface GraphResult {
  root: string;
  direction: "prereqs" | "unlocks";
  depth_requested: number;
  depth_used: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  notes: string[];
}

export class CatalogWafError extends Error {
  constructor(public readonly url: string) {
    super(`WAF challenge detected at ${url}`);
    this.name = "CatalogWafError";
  }
}
