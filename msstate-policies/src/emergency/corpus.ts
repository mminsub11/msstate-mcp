/**
 * Emergency corpus loader and shared in-memory state.
 *
 * Stdio (npx plugin): bake the `emergency` block into dist/index.js via
 * esbuild's `define`. Server startup reads __EMERGENCY_CORPUS__ and calls
 * setEmergencyCorpus(...).
 *
 * Worker: corpus.json is imported and the Worker mirrors the search/lookup
 * logic in its own module (Task 16).
 */
import { indexGuidelines, indexRefugeAreas } from "./search.js";
import type {
  ContactCategory,
  ContactRow,
  EmergencyCorpus,
  GuidelineRow,
  RefugeRow,
} from "./types.js";

let CORPUS: EmergencyCorpus | null = null;

export function setEmergencyCorpus(c: EmergencyCorpus): void {
  CORPUS = c;
  indexGuidelines(c.guidelines);
  indexRefugeAreas(c.refuge_areas);
}

export function getEmergencyCorpus(): EmergencyCorpus | null {
  return CORPUS;
}

export function listGuidelines(): GuidelineRow[] {
  return CORPUS?.guidelines ?? [];
}

export function getGuidelineBySlug(slug: string): GuidelineRow | null {
  if (!CORPUS) return null;
  return CORPUS.guidelines.find((g) => g.slug === slug) ?? null;
}

export function getRefugeAreas(): RefugeRow[] {
  return CORPUS?.refuge_areas ?? [];
}

const CATEGORY_INPUT_MAP: Record<string, ContactCategory | "all"> = {
  all: "all",
  emergency: "emergency",
  campus: "campus_non_emergency",
  campus_non_emergency: "campus_non_emergency",
  "non-emergency": "campus_non_emergency",
  non_emergency: "campus_non_emergency",
  off_campus: "off_campus_non_emergency",
  "off-campus": "off_campus_non_emergency",
  off_campus_non_emergency: "off_campus_non_emergency",
};

export function isValidCategoryInput(input: string): boolean {
  return CATEGORY_INPUT_MAP[input.toLowerCase().trim()] !== undefined;
}

export function filterContacts(categoryInput: string): ContactRow[] {
  if (!CORPUS) return [];
  const want = CATEGORY_INPUT_MAP[categoryInput.toLowerCase().trim()];
  if (!want) return []; // unknown — caller should have validated first
  if (want === "all") return CORPUS.contacts.slice();
  return CORPUS.contacts.filter((c) => c.category === want);
}

export function emergencyCorpusHealth(): {
  loaded: boolean;
  guideline_count: number;
  refuge_count: number;
  contact_count: number;
  builtAt: string | null;
} {
  if (!CORPUS) {
    return { loaded: false, guideline_count: 0, refuge_count: 0, contact_count: 0, builtAt: null };
  }
  return {
    loaded: true,
    guideline_count: CORPUS.guidelines.length,
    refuge_count: CORPUS.refuge_areas.length,
    contact_count: CORPUS.contacts.length,
    builtAt: CORPUS.builtAt,
  };
}
