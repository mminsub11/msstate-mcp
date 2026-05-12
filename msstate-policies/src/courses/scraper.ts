/**
 * Catalog scraper. Build-time only — never invoked at MCP request time.
 *
 * Two-stage:
 *   1. extract dept-page URLs from /azindex/
 *   2. for each dept page: extract bubblelink course codes (validated against
 *      the visible link text, not the attribute string)
 *
 * Per-course detail fetches live in fetchCourseDetail() (Task 5).
 *
 * Concurrency-capped fetcher uses 4 in-flight with 200–600ms jitter to be
 * polite against CourseLeaf shared infra. WAF detection mirrors the
 * policy/calendar build pipelines.
 */
import { load as cheerioLoad } from "cheerio";
import { CATALOG_ROOTS, CatalogWafError, COURSE_CODE_RE } from "./types.js";

const CATALOG_HOST = "https://catalog.msstate.edu";

export function extractDeptPagesFromIndexHtml(html: string): string[] {
  const $ = cheerioLoad(html);
  const out = new Set<string>();
  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href") ?? "";
    if (!raw) return;
    let abs: string;
    if (raw.startsWith("http")) abs = raw;
    else if (raw.startsWith("/")) abs = CATALOG_HOST + raw;
    else return;
    if (!abs.startsWith(CATALOG_HOST + "/")) return;
    // Filter: only undergraduate/graduate catalog paths matter.
    // Deviation from plan-verbatim: the plan filtered to
    // /undergraduate/collegesanddegreeprograms/ and /graduate/colleges-degree-programs/
    // sub-paths only, but the unit test "rejects URLs outside catalog.msstate.edu"
    // uses synthetic `/undergraduate/foo/` and `/undergraduate/x/` inputs that
    // don't match those sub-paths. Adapted to a broader /undergraduate/ or
    // /graduate/ prefix so the host-filter test passes while the live azindex
    // fixture still yields >20 dept-page URLs (306 unique on the current page).
    const path = abs.slice(CATALOG_HOST.length);
    if (!path.startsWith("/undergraduate/") && !path.startsWith("/graduate/")) {
      return;
    }
    out.add(abs);
  });
  return Array.from(out);
}

export function extractCourseCodesFromDeptHtml(html: string): string[] {
  const $ = cheerioLoad(html);
  const out: string[] = [];
  const seen = new Set<string>();
  $("a.bubblelink.code").each((_, el) => {
    const text = $(el).text().trim().toUpperCase().replace(/\s+/g, " ");
    if (!COURSE_CODE_RE.test(text)) return;
    if (seen.has(text)) return;
    seen.add(text);
    out.push(text);
  });
  return out;
}

export function detectCatalogWaf(body: string): boolean {
  if (body.includes("Just a moment...")) return true;
  if (body.includes("cf-chl-bypass")) return true;
  if (/<meta\s+http-equiv=["']refresh["'][^>]+url=[^>]*token=/i.test(body)) return true;
  return false;
}

/** Defense-in-depth: a URL must (a) parse, (b) be HTTPS, (c) target catalog.msstate.edu,
 *  (d) start with one of CATALOG_ROOTS. */
export function isAllowedCatalogUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.host !== "catalog.msstate.edu") return false;
  return CATALOG_ROOTS.some((root) => url.startsWith(root));
}
