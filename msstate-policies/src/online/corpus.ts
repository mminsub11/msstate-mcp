/**
 * Online corpus loader and shared in-memory state.
 *
 * Stdio (npx plugin): bake the `online_education` block into dist/index.js
 * via esbuild's `define`. Server startup reads __ONLINE_CORPUS__ and calls
 * setOnlineCorpus(...).
 *
 * Worker: corpus.json is imported and the Worker mirrors the search/route
 * logic inline (see worker/src/index.ts).
 */
import { indexInfoPages } from "./search.js";
import type {
  OnlineCorpus,
  OnlineProgram,
  OnlineAdmissionsProcess,
  OnlineStaffEntry,
  OnlineInfoPage,
  StaffToProgramsIndex,
} from "./types.js";

let CORPUS: OnlineCorpus | null = null;

export function setOnlineCorpus(c: OnlineCorpus): void {
  // Backfill for older corpus snapshots that lack staff_to_programs.
  // New builds always include it; this guards against load-time crashes
  // when a stale dist is paired with new code.
  if (!Array.isArray((c as { staff_to_programs?: unknown }).staff_to_programs)) {
    (c as { staff_to_programs: StaffToProgramsIndex }).staff_to_programs = [];
  }
  CORPUS = c;
  indexInfoPages(c.info_pages, c.staff);
}

export function getOnlineCorpus(): OnlineCorpus | null {
  return CORPUS;
}

export function listAllPrograms(): OnlineProgram[] {
  return CORPUS?.programs ?? [];
}

export function getProgramBySlug(slug: string): OnlineProgram | null {
  if (!CORPUS) return null;
  return CORPUS.programs.find((p) => p.slug === slug) ?? null;
}

export function getAdmissionsProcess(): OnlineAdmissionsProcess | null {
  return CORPUS?.admissions_process ?? null;
}

export function getAllStaff(): OnlineStaffEntry[] {
  return CORPUS?.staff ?? [];
}

export function getAllInfoPages(): OnlineInfoPage[] {
  return CORPUS?.info_pages ?? [];
}

export function getStaffToProgramsIndex(): StaffToProgramsIndex {
  return CORPUS?.staff_to_programs ?? [];
}

export interface OnlineCorpusHealth {
  loaded: boolean;
  program_count: number;
  staff_count: number;
  info_page_count: number;
  staff_to_programs_count: number;
  builtAt: string | null;
}

export function onlineCorpusHealth(): OnlineCorpusHealth {
  if (!CORPUS) {
    return {
      loaded: false,
      program_count: 0,
      staff_count: 0,
      info_page_count: 0,
      staff_to_programs_count: 0,
      builtAt: null,
    };
  }
  return {
    loaded: true,
    program_count: CORPUS.programs.length,
    staff_count: CORPUS.staff.length,
    info_page_count: CORPUS.info_pages.length,
    staff_to_programs_count: CORPUS.staff_to_programs.length,
    builtAt: CORPUS.builtAt,
  };
}
