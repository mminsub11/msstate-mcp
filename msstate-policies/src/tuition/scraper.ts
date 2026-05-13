/**
 * Tuition scraper. Build-time only — never invoked at MCP request time.
 *
 * Pattern matches src/emergency/scraper.ts: URL allowlist + WAF detector +
 * retry-with-backoff + concurrency-capped pool.
 */
import {
  TUITION_ROOTS,
  TuitionWafError,
  type CampusEntry,
  type CampusSlug,
  type FaqRow,
  type FeeRow,
  type TuitionRateRow,
} from "./types.js";
import {
  buildCampusList,
  parseControllerRateHtml,
  parseFaqHtml,
  parseFeesHtml,
  parseVetmedRateHtml,
} from "./parser.js";

const ALLOWED_HOSTS = new Set(["www.controller.msstate.edu", "www.vetmed.msstate.edu"]);

export function isAllowedTuitionUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (!ALLOWED_HOSTS.has(u.host)) return false;
  return TUITION_ROOTS.some((root) => url === root || url.startsWith(`${root}/`));
}

export function detectTuitionWaf(body: string): boolean {
  if (body.includes("Just a moment...")) return true;
  if (body.includes("cf-chl-bypass")) return true;
  if (/<meta\s+http-equiv=["']refresh["'][^>]+url=[^>]*token=/i.test(body)) return true;
  return false;
}

const UA = "msstate-policies-mcp/0.8.0 (build-worker-corpus)";
const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 2;
const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 600;
const FETCH_RETRIES = 3;
const RETRY_BACKOFF_MS = [500, 1500, 4000];

async function fetchOnce(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    if (detectTuitionWaf(text)) throw new TuitionWafError(url);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try { return await fetchOnce(url); }
    catch (err) {
      lastErr = err;
      if (err instanceof TuitionWafError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP\s+4\d{2}/.test(msg)) throw err;
      if (attempt < FETCH_RETRIES) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function jitter(): Promise<void> {
  const ms = JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS));
  return new Promise((r) => setTimeout(r, ms));
}

async function pool<I, O>(items: I[], conc: number, fn: (i: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
      await jitter();
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return out;
}

const CAMPUS_URLS: Array<{ campus: CampusSlug; url: string }> = [
  { campus: "starkville", url: "https://www.controller.msstate.edu/accountservices/tuition/starkville-campus" },
  { campus: "meridian",   url: "https://www.controller.msstate.edu/accountservices/tuition/meridian-campus" },
  { campus: "mgccc",      url: "https://www.controller.msstate.edu/accountservices/tuition/mgccc-campus-rates" },
  { campus: "online",     url: "https://www.controller.msstate.edu/accountservices/tuition/online-education-rates" },
];
const VETMED_URL = "https://www.vetmed.msstate.edu/tuition";
const FAQ_URL = "https://www.controller.msstate.edu/accountservices/tuition/frequently-asked-questions";
const FEES_URL = "https://www.controller.msstate.edu/accountservices/tuition/other-enrollment-costs";

export interface ScrapeAllOptions {
  fetchUrl?: (url: string) => Promise<string>;
}

export interface ScrapeAllResult {
  rate_rows: TuitionRateRow[];
  fee_rows: FeeRow[];
  faq_rows: FaqRow[];
  campuses: CampusEntry[];
  per_source: Record<string, { ok: boolean; error: string | null }>;
  anyError: boolean;
}

export async function scrapeAllTuition(opts: ScrapeAllOptions = {}): Promise<ScrapeAllResult> {
  const raw = opts.fetchUrl ?? fetchWithRetry;
  // Defense-in-depth: WAF detection wraps the injected fetcher too.
  const fetcher = async (url: string): Promise<string> => {
    const html = await raw(url);
    if (detectTuitionWaf(html)) throw new TuitionWafError(url);
    return html;
  };
  const retrieved_at = new Date().toISOString();
  const per_source: Record<string, { ok: boolean; error: string | null }> = {};
  let anyError = false;

  // Controller campuses (concurrency-capped)
  const campusResults = await pool(CAMPUS_URLS, CONCURRENCY, async ({ campus, url }) => {
    if (!isAllowedTuitionUrl(url)) return { campus, rows: [] as TuitionRateRow[], error: `URL not in allowlist: ${url}` };
    try {
      const html = await fetcher(url);
      const rows = parseControllerRateHtml(html, campus, url).map((r) => ({ ...r, retrieved_at }));
      return { campus, rows, error: null as string | null };
    } catch (e) {
      if (e instanceof TuitionWafError) throw e;
      return { campus, rows: [] as TuitionRateRow[], error: e instanceof Error ? e.message : String(e) };
    }
  });

  let rate_rows: TuitionRateRow[] = [];
  for (const r of campusResults) {
    per_source[`${r.campus}-campus`] = { ok: r.error === null && r.rows.length > 0, error: r.error };
    if (r.error || r.rows.length === 0) anyError = true;
    rate_rows = rate_rows.concat(r.rows);
  }

  // Vetmed
  try {
    if (!isAllowedTuitionUrl(VETMED_URL)) throw new Error("vetmed URL not in allowlist");
    const html = await fetcher(VETMED_URL);
    const vetRows = parseVetmedRateHtml(html, VETMED_URL).map((r) => ({ ...r, retrieved_at }));
    rate_rows = rate_rows.concat(vetRows);
    per_source["vetmed"] = { ok: vetRows.length > 0, error: vetRows.length > 0 ? null : "no rows parsed" };
    if (vetRows.length === 0) anyError = true;
  } catch (e) {
    if (e instanceof TuitionWafError) throw e;
    per_source["vetmed"] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    anyError = true;
  }

  // FAQ
  let faq_rows: FaqRow[] = [];
  try {
    if (!isAllowedTuitionUrl(FAQ_URL)) throw new Error("faq URL not in allowlist");
    const html = await fetcher(FAQ_URL);
    faq_rows = parseFaqHtml(html, FAQ_URL).map((r) => ({ ...r, retrieved_at }));
    per_source["faq"] = { ok: faq_rows.length > 0, error: null };
  } catch (e) {
    if (e instanceof TuitionWafError) throw e;
    per_source["faq"] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    anyError = true;
  }

  // Fees
  let fee_rows: FeeRow[] = [];
  try {
    if (!isAllowedTuitionUrl(FEES_URL)) throw new Error("fees URL not in allowlist");
    const html = await fetcher(FEES_URL);
    fee_rows = parseFeesHtml(html, FEES_URL).map((r) => ({ ...r, retrieved_at }));
    per_source["fees"] = { ok: fee_rows.length > 0, error: null };
  } catch (e) {
    if (e instanceof TuitionWafError) throw e;
    per_source["fees"] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    anyError = true;
  }

  const campuses = buildCampusList(rate_rows);
  return { rate_rows, fee_rows, faq_rows, campuses, per_source, anyError };
}
