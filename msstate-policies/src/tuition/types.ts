/**
 * Tuition module — types, frozen allowlist, mandatory disclaimer.
 *
 * Corpus rule (CLAUDE.md): every value here comes from a live
 * *.msstate.edu page (controller or vetmed). No training-data fallback.
 */

export const TUITION_ROOTS: readonly string[] = Object.freeze([
  "https://www.controller.msstate.edu/accountservices/tuition",
  "https://www.controller.msstate.edu/accountservices/tuition/frequently-asked-questions",
  "https://www.controller.msstate.edu/accountservices/tuition/other-enrollment-costs",
  "https://www.controller.msstate.edu/accountservices/tuition/select-your-campus",
  "https://www.controller.msstate.edu/accountservices/tuition/starkville-campus",
  "https://www.controller.msstate.edu/accountservices/tuition/meridian-campus",
  "https://www.controller.msstate.edu/accountservices/tuition/mgccc-campus-rates",
  "https://www.controller.msstate.edu/accountservices/tuition/online-education-rates",
  "https://www.vetmed.msstate.edu/tuition",
]);

export type CampusSlug = "starkville" | "meridian" | "mgccc" | "online" | "vetmed";
export type Level = "undergrad" | "grad" | "dvm";
export type Residency = "resident" | "non_resident";
export type Term = "fall_spring" | "winter" | "summer" | "annual";
export type RateBasis = "per_credit_hour" | "per_semester_flat" | "annual_flat";
export type CreditHourBucket = "1-11" | "12-16" | "1-8" | "9+";

export const EXPECTED_CAMPUS_SLUGS: readonly CampusSlug[] = Object.freeze([
  "starkville",
  "meridian",
  "mgccc",
  "online",
  "vetmed",
]);

export const TUITION_DISCLAIMER =
  "Tuition rates are subject to change without notice. Always verify the current rate at https://www.controller.msstate.edu/accountservices/tuition before paying.";

export const MAX_QUERY_CHARS = 4096;

export interface LineItem {
  label: string;
  amount_usd: number;
}

export interface TuitionRateRow {
  campus: CampusSlug;
  level: Level;
  residency: Residency;
  term: Term;
  rate_basis: RateBasis;
  credit_hour_bucket: CreditHourBucket | null;
  amount_usd: number;
  line_items: LineItem[];
  effective_term: string;
  source_url: string;
  retrieved_at: string;
}

export type FeeKind = "college" | "program" | "course_distance";

export interface FeeRow {
  kind: FeeKind;
  label: string;
  per_credit_usd: number | null;
  full_time_cap_usd: number | null;
  flat_amount_usd: number | null;
  applicability_note: string;
  source_url: string;
  retrieved_at: string;
}

export interface FaqRow {
  question: string;
  answer: string;
  source_url: string;
  retrieved_at: string;
}

export interface CampusEntry {
  slug: CampusSlug;
  display_name: string;
  levels_offered: Level[];
  rate_basis: "per_credit_hour" | "annual_flat";
  source_url: string;
}

export interface TuitionCorpus {
  builtAt: string;
  source: "https://www.controller.msstate.edu/accountservices/tuition";
  rate_rows: TuitionRateRow[];
  fee_rows: FeeRow[];
  faq_rows: FaqRow[];
  campuses: CampusEntry[];
}

export class TuitionWafError extends Error {
  constructor(public readonly url: string) {
    super(`WAF challenge detected at ${url}`);
    this.name = "TuitionWafError";
  }
}
