/**
 * Course corpus loader and shared in-memory state.
 *
 * Stdio (npx plugin): the build process bakes the `courses` block into
 * dist/index.js via esbuild's `define`. At startup, src/index.ts reads
 * the bundled JSON and calls setCourseCorpus(...) to seed this module.
 *
 * Worker: doesn't use this loader directly — corpus.json is imported and
 * the Worker re-implements walkGraph / searchCourses / getCourse via its
 * own mirror module (Task 14).
 */
import { indexCourses } from "./search.js";
import {
  COURSE_CODE_RE,
  type Course,
  type CourseCorpus,
} from "./types.js";

let CORPUS: CourseCorpus | null = null;
let loaded = false;

export function setCourseCorpus(c: CourseCorpus): void {
  CORPUS = c;
  indexCourses(Object.values(c.records));
  loaded = true;
}

export function isCourseCorpusLoaded(): boolean {
  return loaded;
}

export function __resetCourseCorpusForTests(): void {
  CORPUS = null;
  loaded = false;
  indexCourses([]);
}

export function getCourseCorpus(): CourseCorpus | null {
  return CORPUS;
}

export function isCourseCodeValid(raw: string): string | null {
  const norm = (raw ?? "").toUpperCase().trim().replace(/\s+/g, " ");
  return COURSE_CODE_RE.test(norm) ? norm : null;
}

export function getCourse(code: string): Course | null {
  if (!CORPUS) return null;
  return CORPUS.records[code] ?? null;
}

export function courseCorpusHealth(): {
  loaded: boolean;
  course_count: number;
  forward_edge_count: number;
  reverse_edge_count: number;
  scraped_at: string | null;
} {
  if (!CORPUS) return { loaded: false, course_count: 0, forward_edge_count: 0, reverse_edge_count: 0, scraped_at: null };
  let fwd = 0, rev = 0;
  for (const v of Object.values(CORPUS.forward_dag)) fwd += v.length;
  for (const v of Object.values(CORPUS.reverse_dag)) rev += v.length;
  return {
    loaded: true,
    course_count: Object.keys(CORPUS.records).length,
    forward_edge_count: fwd,
    reverse_edge_count: rev,
    scraped_at: CORPUS.scraped_at,
  };
}
