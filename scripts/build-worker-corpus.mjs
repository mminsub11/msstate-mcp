#!/usr/bin/env node
/**
 * Build worker/corpus.json — pre-extracted policy text for the
 * Cloudflare Worker variant.
 *
 * Workers have no node:fs and a 10-25 MB compressed bundle limit,
 * so the Worker can't run pdf-parse at request time. Instead, this
 * script does the scrape + parse offline and ships a static JSON
 * snapshot of all 218 policies' text + metadata, which the Worker
 * imports and serves via BM25 search.
 *
 * Run periodically (weekly is plenty) to keep the Worker corpus
 * fresh against MSU policy updates. Re-deploy after each rebuild.
 *
 *   node scripts/build-worker-corpus.mjs
 *
 * No env vars required. Hits policies.msstate.edu directly.
 *
 * Corpus rule: text comes only from policies.msstate.edu PDFs.
 * Same constraint as build-embeddings.mjs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as cheerioLoad } from "cheerio";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { createHash } from "node:crypto";

// ---- v0.5.0: Anthropic Haiku synonym generation -------------------------
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const PARAPHRASE_CONCURRENCY = 2;
const PARAPHRASES_PER_ROW = 5;
const PARAPHRASE_MAX_CHARS = 80;
const MAX_RETRIES = 5;
const RETRY_AFTER_FALLBACK_MS = [1000, 3000, 10000, 20000, 40000];

const SYSTEM_PROMPT =
  "You generate 5 short paraphrases of MSU calendar event titles for keyword-based search. " +
  "Each paraphrase must preserve the semantic meaning, use 1-6 common English words, contain NO " +
  "dates/years/numbers, and be ≤80 characters. Output ONLY a JSON array of strings, no preamble, no explanation.";

/** SHA-256 hex of canonical event identity. Must match src/calendars/hash.ts. */
function contentHash(row) {
  const canon = `${row.event}|${row.term ?? ""}|${row.description ?? ""}`;
  return createHash("sha256").update(canon, "utf8").digest("hex");
}

/** Extract a JSON array substring from a chatty LLM response.
 *  Strips ```json ... ``` and ``` ... ``` fences and any preamble.
 *  Returns the first balanced [...] substring, or the raw input if no
 *  fence is found (lets JSON.parse fail naturally on truly malformed input). */
function extractJsonArray(text) {
  let s = String(text ?? "").trim();
  const fence = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return s;
  return s.slice(start, end + 1);
}

function validateParaphrases(arr) {
  if (!Array.isArray(arr)) return null;
  if (arr.length !== PARAPHRASES_PER_ROW) return null;
  const out = [];
  for (const item of arr) {
    if (typeof item !== "string") return null;
    const s = item.trim();
    if (!s) return null;
    if (s.length > PARAPHRASE_MAX_CHARS) return null;
    if (/\d/.test(s)) return null;
    out.push(s);
  }
  return out;
}

async function paraphraseOneRowWithRetry(row, apiKey, attempt = 1) {
  const userMsg = `Event: "${row.event}"${row.term ? ` (term: ${row.term})` : ""}. Return 5 paraphrases as a JSON array.`;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: userMsg },
          { role: "assistant", content: "[" },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      // On 429, prefer the server-provided retry-after over our exponential backoff.
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Math.max(1000, parseInt(retryAfterHeader, 10) * 1000) : 0;
      const err = new Error(`status=${res.status}`);
      // @ts-ignore - attach for the catch block
      err.retryAfterMs = retryAfterMs;
      throw err;
    }
    const json = await res.json();
    // Assistant prefill is "[" — prepend it so the full JSON array text starts with [.
    const text = "[" + (json.content?.[0]?.text ?? "");
    let parsed;
    try {
      parsed = JSON.parse(extractJsonArray(text));
    } catch {
      throw new Error(`not valid JSON: ${text.slice(0, 120).replace(/\n/g, "\\n")}`);
    }
    const validated = validateParaphrases(parsed);
    if (!validated) throw new Error("validation failed");
    return validated;
  } catch (err) {
    if (attempt >= MAX_RETRIES) {
      console.error(`[paraphrase] row "${row.event.slice(0, 40)}" failed permanently after ${attempt} attempts: ${err.message}`);
      return null;
    }
    // Use server-provided retry-after on 429, else exponential fallback.
    const retryAfter = err && typeof err.retryAfterMs === "number" && err.retryAfterMs > 0 ? err.retryAfterMs : 0;
    const backoff = retryAfter || (RETRY_AFTER_FALLBACK_MS[attempt - 1] ?? 40000);
    await new Promise((r) => setTimeout(r, backoff));
    return paraphraseOneRowWithRetry(row, apiKey, attempt + 1);
  }
}

async function paraphraseRows(rows, existingSynMap, apiKey) {
  for (const r of rows) r.contentHash = contentHash(r);
  const newRows = rows.filter((r) => !existingSynMap[r.contentHash]);
  console.error(`[paraphrase] ${rows.length} rows total; ${newRows.length} need fresh synonyms; ${rows.length - newRows.length} reuse existing`);

  const newSynMap = {};
  let failedCount = 0;
  for (let i = 0; i < newRows.length; i += PARAPHRASE_CONCURRENCY) {
    const chunk = newRows.slice(i, i + PARAPHRASE_CONCURRENCY);
    const results = await Promise.all(chunk.map((r) => paraphraseOneRowWithRetry(r, apiKey)));
    for (let j = 0; j < chunk.length; j++) {
      if (results[j] === null) {
        failedCount++;
      } else {
        newSynMap[chunk[j].contentHash] = results[j];
      }
    }
    console.error(`[paraphrase] progress ${Math.min(i + chunk.length, newRows.length)}/${newRows.length}`);
  }

  const failureRate = newRows.length > 0 ? failedCount / newRows.length : 0;
  if (failureRate > 0.1) {
    throw new Error(`refusing to ship a poisoned calendar corpus — paraphrase failure rate ${(failureRate * 100).toFixed(1)}% exceeds 10%`);
  }

  return { ...existingSynMap, ...newSynMap };
}

const BASE = "https://www.policies.msstate.edu";
const UA = "msstate-policies-mcp/0.2.0 (build-worker-corpus)";
const POLICY_NUMBER_RE = /^\d{2}\.(\d{2}|\d{3})$/;

// Same metadata patterns as src/scraper.ts so the Worker corpus matches
// what the stdio server would have returned.
const METADATA_PATTERNS = [
  ["effectiveDate", /effective\s+date\s*[:\-]\s*(.+)/i],
  ["reviewedDate", /reviewed(?:\s+date)?\s*[:\-]\s*(.+)/i],
  ["lastRevisedDate", /(?:last\s+)?revised(?:\s+date)?\s*[:\-]\s*(.+)/i],
  ["responsibleOffice", /responsible\s+office\s*[:\-]\s*(.+)/i],
  ["approvedBy", /approved\s+by\s*[:\-]\s*(.+)/i],
];

// N7: detect WAF / antibot challenge pages so a transient interstitial during
// build doesn't silently poison corpus.json. Mirrors the runtime scraper's
// looksLikeWafChallenge in msstate-policies/src/http.ts. Required before
// any future M6 (auto-rebuild) cron lands.
function looksLikeWafChallenge(body) {
  if (body.includes("Just a moment...")) return true; // Cloudflare interstitial
  if (body.includes("cf-chl-bypass")) return true;
  if (/<meta\s+http-equiv=["']refresh["'][^>]+url=[^>]*token=/i.test(body)) return true;
  // F5 antibot served a bare shell with no data table
  const isAntibotShell =
    /<form[^>]+class=["'][^"']*antibot/i.test(body) &&
    !/id=["']datatable["']/.test(body);
  return isAntibotShell;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  if (looksLikeWafChallenge(text)) {
    throw new Error(
      `WAF / antibot challenge detected for ${url} — refusing to ship a poisoned corpus`,
    );
  }
  return text;
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function extractMetadata(text) {
  const meta = {
    effectiveDate: null,
    reviewedDate: null,
    lastRevisedDate: null,
    responsibleOffice: null,
    approvedBy: null,
  };
  // Scan only the first ~60 lines — MSU policies put metadata near the top.
  const head = text.split("\n").slice(0, 60).join("\n");
  for (const [key, rx] of METADATA_PATTERNS) {
    const m = head.match(rx);
    if (m && m[1]) {
      meta[key] = m[1].trim().replace(/\s+/g, " ").slice(0, 200);
    }
  }
  return meta;
}

function absolutize(href) {
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return BASE + href;
  return `${BASE}/${href}`;
}

async function scrapeCatalogViaSubprocess() {
  const { execFileSync } = await import("node:child_process");
  console.error("[build-worker-corpus] scraping course catalog...");
  let raw;
  try {
    raw = execFileSync(
      "npx",
      ["--yes", "tsx", "scripts/_scrape-catalog.ts"],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (err) {
    throw new Error(
      `course scrape subprocess failed (${err.message ?? err}) — refusing to ship a poisoned course corpus`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(
      "course scrape subprocess produced unparseable JSON — refusing to ship a poisoned course corpus",
    );
  }
  if (!parsed || typeof parsed !== "object" || !parsed.records) {
    throw new Error(
      "course scrape subprocess returned malformed result — refusing to ship a poisoned course corpus",
    );
  }
  const recordCount = Object.keys(parsed.records).length;
  if (recordCount < 500) {
    throw new Error(
      `only ${recordCount} courses scraped (< 500) — refusing to ship a poisoned course corpus`,
    );
  }
  if (
    Object.keys(parsed.forward_dag).length > 0 &&
    Object.keys(parsed.reverse_dag).length === 0
  ) {
    throw new Error(
      "reverse_dag empty while forward_dag non-empty — refusing to ship a poisoned course corpus",
    );
  }
  console.error(
    `[build-worker-corpus]   total courses: ${recordCount}, forward roots: ${Object.keys(parsed.forward_dag).length}, reverse roots: ${Object.keys(parsed.reverse_dag).length}`,
  );
  return parsed;
}

async function scrapeCalendarsViaSubprocess() {
  const { execFileSync } = await import("node:child_process");
  console.error("[build-worker-corpus] scraping calendars (6 sources)...");
  const out = execFileSync(
    "npx",
    ["--yes", "tsx", "scripts/_scrape-calendars.ts"],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const payload = JSON.parse(out.toString("utf8"));
  if (!payload || !Array.isArray(payload.rows)) {
    throw new Error(
      "calendar scrape: malformed payload — refusing to ship a poisoned calendar corpus",
    );
  }
  if (payload.rows.length === 0) {
    throw new Error(
      "calendar scrape returned 0 rows — refusing to ship a poisoned calendar corpus",
    );
  }
  for (const [source, info] of Object.entries(payload.per_source)) {
    if (info.error) {
      throw new Error(
        `calendar scrape: ${source} failed with: ${info.error} — refusing to ship a poisoned calendar corpus`,
      );
    }
    if (info.row_count === 0) {
      throw new Error(
        `calendar scrape: ${source} returned 0 rows — refusing to ship a poisoned calendar corpus`,
      );
    }
  }
  console.error(
    `[build-worker-corpus]   total calendar rows: ${payload.rows.length}`,
  );
  for (const [source, info] of Object.entries(payload.per_source)) {
    console.error(`[build-worker-corpus]   ${source}: ${info.row_count}`);
  }
  return payload;
}

async function scrapeEmergencyViaSubprocess() {
  const { execFileSync } = await import("node:child_process");
  console.error("[build-worker-corpus] scraping emergency guidelines...");
  let raw;
  try {
    raw = execFileSync(
      "npx",
      ["--yes", "tsx", "scripts/_scrape-emergency.ts"],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch (err) {
    throw new Error(
      `emergency scrape subprocess failed (${err.message ?? err}) — refusing to ship a poisoned emergency corpus`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(
      "emergency scrape subprocess produced unparseable JSON — refusing to ship a poisoned emergency corpus",
    );
  }
  if (!parsed || !Array.isArray(parsed.guidelines)) {
    throw new Error(
      "emergency scrape: malformed payload — refusing to ship a poisoned emergency corpus",
    );
  }
  if (parsed.guidelines.length !== 12) {
    throw new Error(
      `emergency scrape: ${parsed.guidelines.length} guidelines (expected exactly 12) — refusing to ship a poisoned emergency corpus`,
    );
  }
  for (const g of parsed.guidelines) {
    if (typeof g.body_markdown !== "string" || g.body_markdown.length < 200) {
      throw new Error(
        `emergency scrape: guideline ${g.slug} body too short (${g.body_markdown?.length ?? 0} chars < 200) — refusing to ship a poisoned emergency corpus`,
      );
    }
  }
  if (!Array.isArray(parsed.refuge_areas) || parsed.refuge_areas.length < 5) {
    throw new Error(
      `emergency scrape: only ${parsed.refuge_areas?.length ?? 0} refuge rows (< 5) — refusing to ship a poisoned emergency corpus`,
    );
  }
  if (!Array.isArray(parsed.contacts) || parsed.contacts.length < 3) {
    throw new Error(
      `emergency scrape: only ${parsed.contacts?.length ?? 0} contacts (< 3) — refusing to ship a poisoned emergency corpus`,
    );
  }
  if (!parsed.contacts.find((c) => c.phone === "911")) {
    throw new Error(
      "emergency scrape: no 911 contact in result — refusing to ship a poisoned emergency corpus",
    );
  }
  console.error(
    `[build-worker-corpus]   emergency: ${parsed.guidelines.length} guidelines, ${parsed.refuge_areas.length} refuge rows, ${parsed.contacts.length} contacts`,
  );
  return parsed;
}

async function scrapeTuitionViaSubprocess() {
  const { execFileSync } = await import("node:child_process");
  console.error("[build-worker-corpus] scraping tuition pages...");
  let raw;
  try {
    raw = execFileSync(
      "npx",
      ["--yes", "tsx", "scripts/_scrape-tuition.ts"],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (err) {
    throw new Error(
      `tuition scrape subprocess failed (${err.message ?? err}) — refusing to ship a poisoned tuition corpus`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(
      "tuition scrape subprocess produced unparseable JSON — refusing to ship a poisoned tuition corpus",
    );
  }
  if (!parsed || !Array.isArray(parsed.rate_rows) || !Array.isArray(parsed.fee_rows)
      || !Array.isArray(parsed.faq_rows) || !Array.isArray(parsed.campuses)) {
    throw new Error(
      "tuition scrape: malformed payload — refusing to ship a poisoned tuition corpus",
    );
  }
  if (parsed.anyError) {
    const failed = Object.entries(parsed.per_source ?? {})
      .filter(([, info]) => !info.ok)
      .map(([k, info]) => `${k}: ${info.error}`).join("; ");
    throw new Error(
      `tuition scrape: per-source failure (${failed}) — refusing to ship a poisoned tuition corpus`,
    );
  }
  if (parsed.rate_rows.length < 40) {
    throw new Error(
      `tuition scrape: only ${parsed.rate_rows.length} rate rows (< 40) — refusing to ship a poisoned tuition corpus`,
    );
  }
  if (!parsed.rate_rows.some((r) => r.campus === "vetmed")) {
    throw new Error(
      "tuition scrape: no vetmed rate rows — refusing to ship a poisoned tuition corpus",
    );
  }
  for (const c of ["starkville", "meridian", "mgccc", "online"]) {
    if (!parsed.rate_rows.some((r) => r.campus === c)) {
      throw new Error(
        `tuition scrape: no rate rows for campus=${c} — refusing to ship a poisoned tuition corpus`,
      );
    }
  }
  if (parsed.faq_rows.length < 10) {
    throw new Error(
      `tuition scrape: only ${parsed.faq_rows.length} FAQ rows (< 10) — refusing to ship a poisoned tuition corpus`,
    );
  }
  const collegeFees = parsed.fee_rows.filter((r) => r.kind === "college").length;
  const programFees = parsed.fee_rows.filter((r) => r.kind === "program").length;
  if (collegeFees === 0) {
    throw new Error(
      "tuition scrape: 0 college fee rows — refusing to ship a poisoned tuition corpus",
    );
  }
  if (programFees === 0) {
    throw new Error(
      "tuition scrape: 0 program fee rows — refusing to ship a poisoned tuition corpus",
    );
  }
  for (const r of parsed.rate_rows) {
    if (typeof r.amount_usd !== "number" || r.amount_usd <= 0 || r.amount_usd > 100_000) {
      throw new Error(
        `tuition scrape: implausible amount_usd=${r.amount_usd} for ${r.campus}/${r.level}/${r.residency}/${r.term} — refusing to ship a poisoned tuition corpus`,
      );
    }
  }
  console.error(
    `[build-worker-corpus]   tuition: ${parsed.rate_rows.length} rates, ${parsed.fee_rows.length} fees, ${parsed.faq_rows.length} faqs, ${parsed.campuses.length} campuses`,
  );
  return parsed;
}

async function main() {
  const skipCatalog = process.argv.includes("--skip-catalog");
  const skipCalendars = process.argv.includes("--skip-calendars");
  console.error("build-worker-corpus: fetching index...");
  if (skipCatalog) console.error("build-worker-corpus: --skip-catalog enabled (reusing courses block)");
  if (skipCalendars) console.error("build-worker-corpus: --skip-calendars enabled (reusing calendar block from existing corpus)");
  const html = await fetchText(`${BASE}/current`);
  const $ = cheerioLoad(html);

  const rows = [];
  $("#datatable tbody tr").each((_i, tr) => {
    const $tr = $(tr);
    const number = $tr.find("td:nth-child(1)").text().trim();
    if (!POLICY_NUMBER_RE.test(number)) return;
    const slug = number.replace(/\./g, "");
    const titleAnchor = $tr.find("td:nth-child(2) a").first();
    const title = titleAnchor.text().trim();
    const landingHref = titleAnchor.attr("href") ?? "";
    const pdfHref = $tr.find("td:last-child a.btn-download").attr("href") ?? "";
    if (!title || !landingHref || !pdfHref) return;
    const status = $tr.find("td:nth-child(3) .badge").text().trim() || "";
    const dt = $tr.find("td:nth-child(4) time").attr("datetime") ?? null;

    rows.push({
      number,
      slug,
      title,
      landingUrl: absolutize(landingHref),
      pdfUrl: absolutize(pdfHref),
      status,
      firstAuthoredOrSorted: dt,
    });
  });

  console.error(`build-worker-corpus: ${rows.length} policies in index`);

  const policies = [];
  let i = 0;
  for (const row of rows) {
    i++;
    try {
      const buf = await fetchBuffer(row.pdfUrl);
      const parsed = await pdfParse(buf);
      const text = (parsed.text || "").normalize("NFKC").trim();
      if (text.length < 200) {
        console.error(
          `build-worker-corpus: skip ${row.number} (text too short: ${text.length} chars)`,
        );
        continue;
      }
      const meta = extractMetadata(text);
      policies.push({
        number: row.number,
        slug: row.slug,
        title: row.title,
        landingUrl: row.landingUrl,
        pdfUrl: row.pdfUrl,
        status: row.status,
        firstAuthoredOrSorted: row.firstAuthoredOrSorted,
        text,
        effectiveDate: meta.effectiveDate,
        reviewedDate: meta.reviewedDate,
        lastRevisedDate: meta.lastRevisedDate,
        responsibleOffice: meta.responsibleOffice,
        approvedBy: meta.approvedBy,
      });
      if (i % 25 === 0) {
        console.error(`build-worker-corpus: extracted ${i}/${rows.length}`);
      }
    } catch (err) {
      console.error(
        `build-worker-corpus: skip ${row.number}: ${err.message ?? err}`,
      );
    }
  }
  console.error(
    `build-worker-corpus: ${policies.length}/${rows.length} policies usable`,
  );

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "worker");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "corpus.json");
  const builtAt = new Date().toISOString();
  const out = {
    builtAt,
    source: `${BASE}/current`,
    indexRowCount: rows.length,
    policies,
  };

  // --skip-calendars is the escape hatch for MSU calendar 403/rate-limit
  // flakiness (recurring intermittent failures on registrar/sfa term pages).
  // Reuses the on-disk corpus's calendar block when set; fails loudly if
  // nothing usable on disk so we never silently ship without a calendar.
  // Symmetric to --skip-catalog. Use sparingly — calendar freshness should
  // be reasserted on a healthy day before any release.
  let calendarPayload;
  if (skipCalendars) {
    let existingCalendar;
    try {
      const prior = JSON.parse(readFileSync(outPath, "utf8"));
      existingCalendar = prior.academic_calendar;
    } catch (err) {
      throw new Error(
        `--skip-calendars requires an existing worker/corpus.json with a calendar block (read failed: ${err.message ?? err}) — refusing to ship a poisoned calendar corpus`,
      );
    }
    if (!existingCalendar || !Array.isArray(existingCalendar.rows) || existingCalendar.rows.length === 0) {
      throw new Error(
        "--skip-calendars: existing worker/corpus.json has no usable calendar block — refusing to ship a poisoned calendar corpus",
      );
    }
    console.error(
      `[build-worker-corpus]   reusing existing calendar block (${existingCalendar.rows.length} rows, built_at ${existingCalendar.built_at ?? "?"})`,
    );
    calendarPayload = {
      rows: existingCalendar.rows,
      per_source: existingCalendar.per_source ?? {},
    };
    out.academic_calendar = {
      rows: existingCalendar.rows,
      per_source: existingCalendar.per_source ?? {},
      built_at: existingCalendar.built_at ?? builtAt,
    };
  } else {
    calendarPayload = await scrapeCalendarsViaSubprocess();
    out.academic_calendar = {
      rows: calendarPayload.rows,
      per_source: calendarPayload.per_source,
      built_at: builtAt,
    };
  }

  // Sanity guard: registrar term pages must yield at least one multi-day row.
  // If the extractor regresses to single-day-only, abort the build instead of
  // silently shipping a poisoned corpus. See .dev/specs/2026-05-12-...md.
  const multiDayCount = calendarPayload.rows.filter(
    (r) =>
      (r.source === "academic_calendar" || r.source === "sfa_financial_aid") &&
      r.start !== r.end,
  ).length;
  if (multiDayCount === 0) {
    throw new Error(
      "refusing to ship a calendar corpus with zero multi-day ranges",
    );
  }
  console.error(
    `[build-worker-corpus]   academic_calendar+sfa multi-day rows: ${multiDayCount}`,
  );

  if (skipCatalog) {
    // Reuse the existing courses block from the on-disk corpus.
    // Fails loudly if there's nothing to reuse (no silent corpus drift).
    let existingCourses;
    try {
      const prior = JSON.parse(readFileSync(outPath, "utf8"));
      existingCourses = prior.courses;
    } catch (err) {
      throw new Error(
        `--skip-catalog requires an existing worker/corpus.json with a courses block (read failed: ${err.message})`,
      );
    }
    if (!existingCourses || !existingCourses.records) {
      throw new Error(
        "--skip-catalog: existing worker/corpus.json has no usable courses block",
      );
    }
    out.courses = existingCourses;
    console.error(
      `[build-worker-corpus]   reusing existing courses block (${Object.keys(existingCourses.records).length} records, scraped_at ${existingCourses.scraped_at})`,
    );
  } else {
    const coursesPayload = await scrapeCatalogViaSubprocess();
    out.courses = {
      version: coursesPayload.version,
      scraped_at: coursesPayload.scraped_at,
      records: coursesPayload.records,
      forward_dag: coursesPayload.forward_dag,
      reverse_dag: coursesPayload.reverse_dag,
    };
  }

  // v0.9.0 — per-category parse-quality ceilings. Counts come from
  // reparsing each record's raw_prose with the live parser so a corpus
  // scraped under any prior parser still gets audited under the current
  // rules. Each ceiling is ~10–15% above the current measured baseline,
  // giving headroom for MSU markup drift while catching real regressions.
  {
    const { execFileSync } = await import("node:child_process");
    const proseList = Object.values(out.courses.records)
      .map((rec) => rec.prereqs?.raw_prose ?? null)
      .filter(Boolean);
    // tsx -e runs in CJS mode; use require() with an absolute path so the
    // parser is resolved relative to process.cwd() regardless of where tsx
    // itself lives in node_modules.
    const inlineScript = `
const path = require("path");
const { parsePrereqProse } = require(path.join(process.cwd(), "msstate-policies/src/courses/parser.ts"));
const proses = JSON.parse(process.argv[1]);
const breakdown = {
  non_course_unparsed: 0,
  grade_signal_present_but_unparsed: 0,
  grade_signal_ambiguous: 0,
  logic_ambiguous: 0,
};
for (const prose of proses) {
  const reparsed = parsePrereqProse(prose);
  for (const w of (reparsed?.parse_warnings ?? [])) {
    if (w in breakdown) breakdown[w]++;
  }
}
process.stdout.write(JSON.stringify(breakdown));
`.trim();
    let breakdownRaw;
    try {
      breakdownRaw = execFileSync(
        "npx",
        ["--yes", "tsx", "-e", inlineScript, JSON.stringify(proseList)],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "inherit"],
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    } catch (err) {
      throw new Error(
        `courses: parse-quality audit subprocess failed (${err.message ?? err}) — refusing to ship a poisoned course corpus`,
      );
    }
    const breakdown = JSON.parse(breakdownRaw.toString("utf8"));
    console.error(
      `[build-worker-corpus]   courses_parse_quality: non_course_unparsed=${breakdown.non_course_unparsed} grade_unparsed=${breakdown.grade_signal_present_but_unparsed} logic_ambiguous=${breakdown.logic_ambiguous}`,
    );
    if (breakdown.non_course_unparsed > 35) {
      throw new Error(
        `courses: non_course_unparsed=${breakdown.non_course_unparsed} > 35 — refusing to ship a poisoned course corpus`,
      );
    }
    if (breakdown.grade_signal_present_but_unparsed > 20) {
      throw new Error(
        `courses: grade_signal_present_but_unparsed=${breakdown.grade_signal_present_but_unparsed} > 20 — refusing to ship a poisoned course corpus`,
      );
    }
    if (breakdown.logic_ambiguous > 200) {
      throw new Error(
        `courses: logic_ambiguous=${breakdown.logic_ambiguous} > 200 — refusing to ship a poisoned course corpus`,
      );
    }
  }

  const emergencyPayload = await scrapeEmergencyViaSubprocess();
  out.emergency = {
    builtAt,
    source: "https://www.emergency.msstate.edu/",
    guidelines: emergencyPayload.guidelines,
    refuge_areas: emergencyPayload.refuge_areas,
    contacts: emergencyPayload.contacts,
  };

  const tuitionPayload = await scrapeTuitionViaSubprocess();
  out.tuition = {
    builtAt,
    source: "https://www.controller.msstate.edu/accountservices/tuition",
    rate_rows: tuitionPayload.rate_rows,
    fee_rows: tuitionPayload.fee_rows,
    faq_rows: tuitionPayload.faq_rows,
    campuses: tuitionPayload.campuses,
  };

  // ---- v0.5.0: bake synonyms ---------------------------------------------
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the build step. Export it and re-run.");
  }

  let existingSynMap = {};
  try {
    const existing = JSON.parse(readFileSync(outPath, "utf8"));
    for (const r of existing.academic_calendar?.rows ?? []) {
      if (r.contentHash && Array.isArray(r.synonyms) && r.synonyms.length > 0) {
        existingSynMap[r.contentHash] = r.synonyms;
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[paraphrase] existing corpus unreadable: ${err.message}`);
  }

  const synMap = await paraphraseRows(calendarPayload.rows, existingSynMap, anthropicKey);

  for (const r of calendarPayload.rows) {
    r.synonyms = synMap[r.contentHash] ?? [];
  }

  const missing = calendarPayload.rows.filter((r) => !Array.isArray(r.synonyms));
  if (missing.length > 0) {
    throw new Error(`refusing to ship a poisoned calendar corpus — ${missing.length} rows missing synonyms field`);
  }

  const sidecarPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "msstate-policies",
    "dist",
    "calendar-synonyms.json",
  );
  const sidecar = {
    model: ANTHROPIC_MODEL,
    built_at: new Date().toISOString(),
    synonyms: synMap,
  };
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
  console.error(`[paraphrase] wrote ${sidecarPath} (${Object.keys(synMap).length} entries)`);

  writeFileSync(outPath, JSON.stringify(out));
  const bytes = JSON.stringify(out).length;
  console.error(
    `build-worker-corpus: wrote ${outPath} — ${policies.length} policies, ${(bytes / 1024 / 1024).toFixed(2)} MB raw`,
  );
}

main().catch((err) => {
  console.error("build-worker-corpus: fatal", err);
  process.exit(1);
});
