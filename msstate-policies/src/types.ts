/**
 * Shared types for the msstate-policies MCP server.
 *
 * Field names are stable: tool output schemas and the eval harness reference
 * these names. Renaming anything here is a breaking change.
 */

export interface PolicyEntry {
  /** "01.01" or "91.100" — matches /^\d{2}\.(\d{2}|\d{3})$/ */
  number: string;
  /** Number with the dot stripped, e.g. "0101" or "91100". Used as cache key. */
  slug: string;
  /** Plain-text title of the policy, e.g. "Sports Wagering Activities". */
  title: string;
  /** Absolute URL to the /policy/{slug} landing page. */
  landingUrl: string;
  /**
   * Absolute URL to the policy PDF.
   *
   * IMPORTANT: read this verbatim from `<a class="btn-download">[href]`.
   * Path varies (`/sites/.../files/policies/<slug>.pdf`,
   * `/sites/.../files/YYYY-MM/<slug>.pdf`, with optional `_N` suffix).
   * Never construct it from the slug.
   */
  pdfUrl: string;
  /** "Current", "Rescinded", etc. Read from <span class="badge"> in the row. */
  status: string;
  /**
   * ISO-8601 timestamp from the `<time datetime>` attribute on the index row.
   * The plan calls this "Date Authored" — *not* a last-revised date.
   * True revision dates live inside the PDF metadata block.
   */
  firstAuthoredOrSorted: string | null;
  /** Volume label resolved through runtime taxonomy map, if requested. */
  volumeLabel?: string;
  /** Section label resolved through runtime taxonomy map, if requested. */
  sectionLabel?: string;
}

export interface PolicyDocument {
  number: string;
  slug: string;
  title: string;
  landingUrl: string;
  pdfUrl: string;
  /** Full extracted PDF text, NFKC-normalized. May be empty if extraction failed. */
  text: string;
  /** ISO-8601 timestamp of when this server fetched the PDF. */
  retrievedAt: string;
  /** Best-effort metadata extracted from PDF first ~50 lines. null = not found. */
  effectiveDate: string | null;
  reviewedDate: string | null;
  lastRevisedDate: string | null;
  responsibleOffice: string | null;
  approvedBy: string | null;
  /**
   * Set true when the PDF parser failed and we fell back to the landing page.
   * Surfaced via tool responses + health_check so the LLM can apologize coherently.
   */
  fallbackToLanding: boolean;
}

export interface TaxonomyEntry {
  id: string;
  label: string;
}

export interface PolicyIndex {
  /** Epoch ms of when this snapshot was fetched. */
  fetchedAt: number;
  /** Source URL (canonical /current page). */
  source: string;
  rows: PolicyEntry[];
  /** Runtime label↔id map for the volume dropdown. Never hardcoded. */
  volumes: TaxonomyEntry[];
  /** Runtime label↔id map for the section dropdown. Never hardcoded. */
  sections: TaxonomyEntry[];
}

export interface EmbeddingChunk {
  /** Slug of the parent policy. */
  slug: string;
  /** Index of the chunk within that policy. */
  chunkIndex: number;
  /** Raw chunk text — kept so we can show snippets without re-fetching. */
  text: string;
  /** Dense vector. Length must match the model used at build time. */
  vector: number[];
}

/**
 * Thrown when the index fetch returns a WAF / antibot challenge page.
 * Caller must not cache the result for 1h — bubble up so health_check can see it.
 */
export class WAFChallengeError extends Error {
  constructor(public readonly url: string) {
    super(`WAF / antibot challenge detected for ${url}`);
    this.name = "WAFChallengeError";
  }
}

export interface HealthState {
  index_row_count: number;
  last_index_fetch: string | null;
  last_index_error: string | null;
  volumes_discovered: number;
  sections_discovered: number;
  cache_hit_rate: number;
  pdf_parse_fallback_count: number;
  version: string;
  git_sha: string;
  calendars_row_count?: number;
  calendars_per_source?: Record<string, { row_count: number; error: string | null }>;
  calendars_last_error?: Record<string, string | null>;
}
