/**
 * Tuition corpus loader and shared in-memory state.
 *
 * Stdio (npx plugin): bake the `tuition` block into dist/index.js via
 * esbuild's `define`. Server startup reads __TUITION_CORPUS__ and calls
 * setTuitionCorpus(...).
 *
 * Worker: corpus.json is imported and the Worker mirrors the search/route
 * logic inline (see worker/src/index.ts).
 */
import { indexFaqRows } from "./search.js";
import type {
  CampusEntry,
  FaqRow,
  FeeRow,
  TuitionCorpus,
  TuitionRateRow,
} from "./types.js";

let CORPUS: TuitionCorpus | null = null;

export function setTuitionCorpus(c: TuitionCorpus): void {
  CORPUS = c;
  indexFaqRows(c.faq_rows);
}

export function getTuitionCorpus(): TuitionCorpus | null {
  return CORPUS;
}

export function getRateRows(): TuitionRateRow[] {
  return CORPUS?.rate_rows ?? [];
}
export function getFeeRows(): FeeRow[] {
  return CORPUS?.fee_rows ?? [];
}
export function getFaqRows(): FaqRow[] {
  return CORPUS?.faq_rows ?? [];
}
export function getCampuses(): CampusEntry[] {
  return CORPUS?.campuses ?? [];
}

export function tuitionCorpusHealth(): {
  loaded: boolean;
  rate_count: number;
  fee_count: number;
  faq_count: number;
  campus_count: number;
  builtAt: string | null;
} {
  if (!CORPUS) {
    return { loaded: false, rate_count: 0, fee_count: 0, faq_count: 0, campus_count: 0, builtAt: null };
  }
  return {
    loaded: true,
    rate_count: CORPUS.rate_rows.length,
    fee_count: CORPUS.fee_rows.length,
    faq_count: CORPUS.faq_rows.length,
    campus_count: CORPUS.campuses.length,
    builtAt: CORPUS.builtAt,
  };
}
