/**
 * Emergency-site scraper. Build-time only — never invoked at MCP request time.
 *
 * Fetches the 12 guideline pages + /refuge, parses each, attaches aliases
 * (reverse-indexed from EMERGENCY_ALIASES), and emits an EmergencyCorpus-
 * shaped object (minus builtAt, which the build script sets).
 *
 * Mirrors courses/scraper.ts patterns: URL allowlist + WAF detector +
 * retry-with-backoff + concurrency-capped pool.
 */
import {
  EMERGENCY_ALIASES,
  EMERGENCY_ROOTS,
  EXPECTED_GUIDELINE_SLUGS,
  EmergencyWafError,
  type ContactRow,
  type GuidelineRow,
  type RefugeRow,
} from "./types.js";
import {
  parseContactsHtml,
  parseGuidelineHtml,
  parseRefugeHtml,
} from "./parser.js";

const EMERGENCY_HOST = "https://www.emergency.msstate.edu";

/** Defense-in-depth: a URL must (a) parse, (b) be HTTPS,
 *  (c) target www.emergency.msstate.edu exactly,
 *  (d) start with one of EMERGENCY_ROOTS. */
export function isAllowedEmergencyUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.host !== "www.emergency.msstate.edu") return false;
  return EMERGENCY_ROOTS.some((root) => url.startsWith(root));
}

export function detectEmergencyWaf(body: string): boolean {
  if (body.includes("Just a moment...")) return true;
  if (body.includes("cf-chl-bypass")) return true;
  if (/<meta\s+http-equiv=["']refresh["'][^>]+url=[^>]*token=/i.test(body)) return true;
  return false;
}

const UA = "msstate-policies-mcp/0.7.0 (build-worker-corpus)";
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
    if (detectEmergencyWaf(text)) throw new EmergencyWafError(url);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      lastErr = err;
      if (err instanceof EmergencyWafError) throw err;
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

/** Reverse-index EMERGENCY_ALIASES so we can write aliases onto each row. */
function buildAliasReverseIndex(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [alias, slug] of Object.entries(EMERGENCY_ALIASES)) {
    (out[slug] ??= []).push(alias);
  }
  return out;
}

export interface ScrapeAllOptions {
  fetchUrl?: (url: string) => Promise<string>;
}

export interface ScrapeAllResult {
  guidelines: GuidelineRow[];
  refuge_areas: RefugeRow[];
  contacts: ContactRow[];
  per_source: Record<string, { ok: boolean; error: string | null }>;
  anyError: boolean;
}

export async function scrapeAllEmergency(opts: ScrapeAllOptions = {}): Promise<ScrapeAllResult> {
  // Wrap the raw fetcher so WAF detection always runs, regardless of injection.
  const rawFetcher = opts.fetchUrl ?? fetchWithRetry;
  const fetcher = async (url: string): Promise<string> => {
    const html = await rawFetcher(url);
    if (detectEmergencyWaf(html)) throw new EmergencyWafError(url);
    return html;
  };

  const retrieved_at = new Date().toISOString();
  const aliasReverse = buildAliasReverseIndex();
  const per_source: Record<string, { ok: boolean; error: string | null }> = {};
  let anyError = false;

  const slugs = [...EXPECTED_GUIDELINE_SLUGS];
  const fetched = await pool(slugs, CONCURRENCY, async (slug) => {
    const url = `${EMERGENCY_HOST}/guidelines/${slug}`;
    if (!isAllowedEmergencyUrl(url)) {
      return { slug, row: null as GuidelineRow | null, error: `URL not in allowlist: ${url}` };
    }
    try {
      const html = await fetcher(url);
      const parsed = parseGuidelineHtml(html, slug);
      if (!parsed) return { slug, row: null as GuidelineRow | null, error: "parse returned null" };
      const row: GuidelineRow = {
        slug,
        title: parsed.title,
        url: parsed.url,
        body_markdown: parsed.body_markdown,
        aliases: aliasReverse[slug] ?? [],
        retrieved_at,
      };
      return { slug, row, error: null as string | null };
    } catch (e) {
      if (e instanceof EmergencyWafError) throw e;
      return { slug, row: null as GuidelineRow | null, error: e instanceof Error ? e.message : String(e) };
    }
  });

  const guidelines: GuidelineRow[] = [];
  for (const r of fetched) {
    per_source[`guidelines/${r.slug}`] = { ok: r.row !== null, error: r.error };
    if (r.error) anyError = true;
    if (r.row) guidelines.push(r.row);
  }

  // /refuge — single fetch
  const refugeUrl = `${EMERGENCY_HOST}/refuge`;
  let refuge_areas: RefugeRow[] = [];
  let contacts: ContactRow[] = [];
  try {
    if (!isAllowedEmergencyUrl(refugeUrl)) throw new Error("refuge URL not in allowlist");
    const html = await fetcher(refugeUrl);
    const rawRefuge = parseRefugeHtml(html);
    refuge_areas = rawRefuge.map((r) => ({ ...r, source_url: refugeUrl, retrieved_at }));
    const rawContacts = parseContactsHtml(html);
    contacts = rawContacts.map((c) => ({ ...c, source_url: refugeUrl, retrieved_at }));
    per_source["refuge"] = { ok: true, error: null };
  } catch (e) {
    if (e instanceof EmergencyWafError) throw e;
    per_source["refuge"] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    anyError = true;
  }

  return { guidelines, refuge_areas, contacts, per_source, anyError };
}
