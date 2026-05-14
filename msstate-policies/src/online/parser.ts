/**
 * Online module — HTML parsers.
 *
 * Each function returns verbatim text from online.msstate.edu pages. The
 * scraper attaches `retrieved_at` and `url` after parsing.
 *
 * Selector strategy for parseAcademicProgramsIndex:
 *   The /academic-programs fixture is a flat Drupal Views grid — all programs
 *   are rendered as `.Prg-card` elements with no section headings separating
 *   degree levels. The slug comes from the `prg-card-top` anchor href, the
 *   name from `.Prg-card-title h2`, and the degree level is inferred from the
 *   name text itself using LEVEL_NAME_MAP. This differs from the plan's
 *   starter-code assumption of "h2/h3 headings + anchors in document order".
 *
 * Selector strategy for parseProgramHtml:
 *   Per-program pages use Drupal node templates. Key patterns:
 *   - Program name: h1.display-3 text (may contain a <p> child)
 *   - Contacts: div.card.card-directory with h2.directory--name,
 *     p.directory--department, a.directory--email, a.directory--phone
 *   - Tuition: div.tuitioncowbell followed by a table; first data row has
 *     "Tuition per credit hour" label, value in the sibling <td>
 *   - Deadlines: prose "Deadline for Fall Semester: August 1" OR a table
 *     with Start Term / Deadline columns
 *   - Sections: h2/h3 inside main, body text collected until next same-level
 *     or higher heading
 */
import { load as cheerioLoad } from "cheerio";
import type {
  DegreeLevel,
  OnlineContact,
  OnlineApplicationDeadline,
  OnlineEntranceExams,
  OnlineProgramTuition,
  OnlineProgram,
  OnlineParseWarning,
} from "./types.js";

/** Sentinel value replaced by the scraper with the actual fetch timestamp. */
export const RETRIEVED_AT_PLACEHOLDER = "__RETRIEVED_AT__";

/** Ordered rules: program name text → DegreeLevel. */
const LEVEL_NAME_MAP: Array<[RegExp, DegreeLevel]> = [
  [/\bDoctor\b/i, "doctoral"],
  [/\bEducational Specialist\b/i, "specialist"],
  [/\bMaster\b/i, "master"],
  [/\bBachelor\b/i, "bachelor"],
  [/\bEndorsement\b/i, "endorsement"],
  [/\bCertificate\b/i, "certificate"],
];

export interface ProgramIndexEntry {
  slug: string;
  name: string;
  degree_level: DegreeLevel;
}

/**
 * Parse /academic-programs into a list of { slug, name, degree_level } entries.
 *
 * The page renders all programs in a single flat Drupal Views grid. Each
 * program card (`div.Prg-card`) contains:
 *   - `div.prg-card-top > a[href]` — the canonical slug link, e.g. `/mba`
 *   - `div.Prg-card-title h2` — the full program name
 *
 * Degree level is inferred from the name text using LEVEL_NAME_MAP above;
 * cards whose names do not match any rule are skipped with no error.
 */
export function parseAcademicProgramsIndex(
  html: string,
  _pageUrl: string,
): ProgramIndexEntry[] {
  const $ = cheerioLoad(html);
  const out: ProgramIndexEntry[] = [];
  const seenSlugs = new Set<string>();

  $("div.Prg-card").each((_, card) => {
    const $card = $(card);

    // Slug: from the top anchor href — must be a simple /slug path
    const topHref = $card.find("div.prg-card-top a[href]").first().attr("href") ?? "";
    const slugMatch = topHref.match(/^\/([a-z][a-z0-9-]*)$/i);
    if (!slugMatch) return;
    const slug = slugMatch[1];
    if (seenSlugs.has(slug)) return;

    // Name: from the Prg-card-title h2, decode HTML entities via cheerio text()
    const name = $card.find("div.Prg-card-title h2").text().replace(/\s+/g, " ").trim();
    if (name.length === 0) return;

    // Degree level: inferred from the name
    let degree_level: DegreeLevel | null = null;
    for (const [re, level] of LEVEL_NAME_MAP) {
      if (re.test(name)) {
        degree_level = level;
        break;
      }
    }
    if (degree_level === null) return;

    seenSlugs.add(slug);
    out.push({ slug, name, degree_level });
  });

  return out;
}

// ---------------------------------------------------------------------------
// parseProgramHtml helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
const PHONE_RE = /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

function parseMoneyValue(s: string | undefined | null): number | null {
  if (!s) return null;
  const cleaned = s.replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Return the best "content" root selector for this Drupal page.
 * online.msstate.edu program pages render most content in Drupal Views blocks
 * inside div#page (not inside <main> or <article>). We pick the selector with
 * the most h2/h3 headings to ensure we capture all sections.
 */
function contentRoot($: ReturnType<typeof cheerioLoad>): string {
  const candidates = ["main", "div#page", "article", "body"];
  let bestSel = "body";
  let bestCount = 0;
  for (const sel of candidates) {
    const count = $(`${sel} h2`).length + $(`${sel} h3`).length;
    if (count > bestCount) {
      bestCount = count;
      bestSel = sel;
    }
  }
  return bestSel;
}

/**
 * Extract text sections keyed by heading text.
 * Walks h2/h3 inside the content root and accumulates sibling text until
 * the next heading of the same or higher level.
 */
function extractSections(
  $: ReturnType<typeof cheerioLoad>,
): Record<string, string> {
  const root = contentRoot($);
  const out: Record<string, string> = {};
  $(`${root} h2, ${root} h3`).each((_, h) => {
    const $h = $(h);
    const heading = $h.text().replace(/\s+/g, " ").trim();
    if (!heading) return;
    const tagName = h.type === "tag" ? h.name.toLowerCase() : "";
    const headingLevel = tagName === "h2" ? 2 : 3;
    let $cur = $h.next();
    const parts: string[] = [];
    while ($cur.length > 0) {
      const node = $cur.get(0);
      const t = node && node.type === "tag" ? node.name.toLowerCase() : "";
      if (/^h[1-3]$/.test(t)) {
        const curLevel = Number(t.slice(1));
        if (curLevel <= headingLevel) break;
      }
      const text = $cur.text().replace(/\s+/g, " ").trim();
      if (text.length > 0) parts.push(text);
      $cur = $cur.next();
    }
    const body = parts.join("\n").trim();
    if (body.length > 0) out[heading] = body;
  });
  return out;
}

/**
 * Extract contacts from Drupal card-directory cards.
 * Each contact card: div[aria-label*="Profile card"] > div.card-directory
 *   h2.directory--name  — contact name
 *   p.directory--department — title/department
 *   a.directory--email  — mailto link
 *   a.directory--phone  — tel link
 */
function extractContacts(
  $: ReturnType<typeof cheerioLoad>,
): OnlineContact[] {
  const out: OnlineContact[] = [];
  const seen = new Set<string>();

  $("div.card-directory").each((_, el) => {
    const $card = $(el);
    const name = $card.find("h2.directory--name").text().replace(/\s+/g, " ").trim();
    if (!name) return;
    const title =
      $card.find("p.directory--department").text().replace(/\s+/g, " ").trim() ||
      $card.find("ul.directory--titles li").first().text().replace(/\s+/g, " ").trim();
    const emailHref = $card.find("a.directory--email").attr("href") ?? "";
    const email = emailHref.startsWith("mailto:") ? emailHref.slice(7).trim() : null;
    if (!email) return; // skip cards without email (department cards)
    const phoneHref = $card.find("a.directory--phone").attr("href") ?? "";
    const phone = phoneHref.startsWith("tel:") ? phoneHref.slice(4).trim() : null;

    const key = `${name.toLowerCase()}|${email.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, title, email, phone });
  });

  return out;
}

/**
 * Extract application deadlines.
 * Handles two patterns found in fixtures:
 *  1. Prose: "Deadline for Fall Semester: August 1"
 *  2. Table with "Start Term" / "Deadline" columns
 */
function extractDeadlines(
  $: ReturnType<typeof cheerioLoad>,
): OnlineApplicationDeadline[] {
  const out: OnlineApplicationDeadline[] = [];
  const seen = new Set<string>();

  function addDeadline(term: string, dateText: string): void {
    const t = term.charAt(0).toUpperCase() + term.slice(1).toLowerCase();
    const d = dateText.trim();
    const key = `${t.toLowerCase()}|${d.toLowerCase()}`;
    if (seen.has(key) || !d) return;
    seen.add(key);
    out.push({ term: t, date_text: d });
  }

  const root = contentRoot($);

  // Pattern 1: tables with "Start Term" header and "Deadline" header
  $(`${root} table`).each((_, table) => {
    const $table = $(table);
    const headers = $table
      .find("thead th")
      .toArray()
      .map((th) => $(th).text().replace(/\s+/g, " ").trim().toLowerCase());
    const termIdx = headers.indexOf("start term");
    const deadlineIdx = headers.indexOf("deadline");
    if (termIdx === -1 || deadlineIdx === -1) return;
    $table.find("tbody tr").each((_, tr) => {
      const cells = $(tr)
        .find("td")
        .toArray()
        .map((td) => $(td).text().replace(/\s+/g, " ").trim());
      const term = cells[termIdx] ?? "";
      const dateText = cells[deadlineIdx] ?? "";
      if (/fall|spring|summer/i.test(term)) addDeadline(term, dateText);
    });
  });

  // Pattern 2: prose "Deadline for Fall Semester: August 1" or similar
  const proseRe =
    /Deadline\s+for\s+(Fall|Spring|Summer)\s+Semester\s*:\s*<[^>]*>([^<]+)<\/[^>]+>/gi;
  const rootHtml = $(root).html() ?? "";
  let m: RegExpExecArray | null;
  while ((m = proseRe.exec(rootHtml)) !== null) {
    addDeadline(m[1], m[2]);
  }

  // Fallback text pattern if no HTML tags around the date
  if (out.length === 0) {
    const rootText = $(root).text();
    const textRe =
      /(Fall|Spring|Summer)(?:\s+Semester)?[\s:—\-–]+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/gi;
    while ((m = textRe.exec(rootText)) !== null) {
      addDeadline(m[1], m[2]);
    }
  }

  return out;
}

/**
 * Extract tuition from the Drupal tuitioncowbell table.
 * The table has rows: "Tuition per credit hour | $NNN.NN"
 * Falls back to regex over full main text.
 */
function extractTuition(
  $: ReturnType<typeof cheerioLoad>,
): OnlineProgramTuition {
  let per_credit_usd: number | null = null;
  let instructional_fee_per_credit_usd: number | null = null;
  let application_fee_domestic_usd: number | null = null;
  let application_fee_international_usd: number | null = null;
  let raw_prose = "";

  // Primary: tuitioncowbell table
  const $cowbell = $("div.tuitioncowbell");
  if ($cowbell.length > 0) {
    const $table = $cowbell.next("div.table-responsive, table").find("table").addBack("table").first();
    // The table is a sibling of the tuitioncowbell div, inside a shared parent
    const $parent = $cowbell.parent();
    $parent.find("table tr").each((_, tr) => {
      const cells = $(tr)
        .find("td")
        .toArray()
        .map((td) => $(td).text().replace(/\s+/g, " ").trim());
      if (cells.length < 2) return;
      const label = cells[0].toLowerCase();
      const rawVal = cells[1].replace(/[$,\s]/g, "");
      if (/tuition per credit hour/i.test(label)) {
        per_credit_usd = parseMoneyValue(rawVal);
      } else if (/instructional support fee/i.test(label)) {
        instructional_fee_per_credit_usd = parseMoneyValue(rawVal);
      }
    });
    raw_prose = $parent.text().replace(/\s+/g, " ").trim();
  }

  // If not found via table, try regex over content root text
  const rootSel = contentRoot($);
  if (per_credit_usd === null) {
    const rootText = $(rootSel).text();
    const m = /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s+credit\s+hour)/i.exec(rootText);
    if (m) per_credit_usd = parseMoneyValue(m[1].replace(/,/g, ""));
    if (!raw_prose) raw_prose = rootText.slice(0, 500);
  }

  // Application fees — from content root text
  const allMainText = $(rootSel).text();
  const domFeeM =
    /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:application\s+fee\s*(?:\(?\s*(?:domestic|US)))/i.exec(allMainText);
  const intlFeeM =
    /application\s+fee\s*[^$]*\$\s*([\d,]+(?:\.\d{2})?)\s*(?:for\s+international|international)/i.exec(
      allMainText,
    );
  // Also handle "Application fee $60 or $80 for international"
  const appFeeM =
    /Application\s+fee\s+\$\s*([\d,]+)\s+or\s+\$\s*([\d,]+)\s+for\s+international/i.exec(allMainText);
  if (appFeeM) {
    application_fee_domestic_usd = parseMoneyValue(appFeeM[1]);
    application_fee_international_usd = parseMoneyValue(appFeeM[2]);
  } else {
    if (domFeeM) application_fee_domestic_usd = parseMoneyValue(domFeeM[1].replace(/,/g, ""));
    if (intlFeeM) application_fee_international_usd = parseMoneyValue(intlFeeM[1].replace(/,/g, ""));
  }

  return {
    per_credit_usd,
    instructional_fee_per_credit_usd,
    application_fee_domestic_usd,
    application_fee_international_usd,
    raw_prose,
  };
}

function extractForms(
  $: ReturnType<typeof cheerioLoad>,
): { label: string; url: string }[] {
  const root = contentRoot($);
  const out: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  $(`${root} a[href$='.pdf']`).each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href") ?? "";
    if (!href || seen.has(href)) return;
    seen.add(href);
    const label =
      $a.text().replace(/\s+/g, " ").trim() ||
      href.split("/").pop() ||
      href;
    const absUrl = href.startsWith("http")
      ? href
      : `https://www.online.msstate.edu${href.startsWith("/") ? "" : "/"}${href}`;
    out.push({ label, url: absUrl });
  });
  return out;
}

function findSectionByPattern(
  sections: Record<string, string>,
  patterns: RegExp[],
): string {
  for (const [heading, body] of Object.entries(sections)) {
    for (const p of patterns) {
      if (p.test(heading)) return body;
    }
  }
  return "";
}

/**
 * Parse a per-program page from online.msstate.edu into an OnlineProgram
 * record. Returns a record with parse_warnings for any fields that could not
 * be extracted; never returns null.
 */
export function parseProgramHtml(
  html: string,
  slug: string,
  degree_level: DegreeLevel,
  url: string,
): OnlineProgram {
  const $ = cheerioLoad(html);
  const root = contentRoot($);

  // Name: h1 text (may contain a <p> child in the Drupal template)
  const name =
    $("h1").first().text().replace(/\s+/g, " ").trim() ||
    $("title").text().replace(/\s+/g, " ").trim() ||
    slug;

  const sections = extractSections($);

  const short_description =
    $(`${root} h1`).first().nextAll("p").first().text().replace(/\s+/g, " ").trim();

  // Format: look for "fully online" or "100% online" or similar in the page
  const allText = $(root).text();
  const formatBody = findSectionByPattern(sections, [/format/i, /delivery/i]);
  let format = formatBody;
  if (!format) {
    if (/fully\s+online/i.test(allText) || /100%\s+online/i.test(allText)) {
      format = "Fully online";
    } else if (/online/i.test(allText)) {
      format = "Online";
    }
  }

  const tuition = extractTuition($);

  const admission_requirements = findSectionByPattern(sections, [
    /admissions?\s+process/i,
    /admissions?\s+require/i,
    /admission/i,
  ]);

  const contacts = extractContacts($);
  const application_deadlines = extractDeadlines($);

  // Entrance exams — use full body text for exam signals (they appear outside the admissions section)
  const fullBodyText = $("body").text();
  const examPool = `${admission_requirements}\n${fullBodyText}`;
  const required: string[] = [];
  const not_required: string[] = [];
  if (/TOEFL|IELTS/i.test(examPool)) {
    required.push("TOEFL or IELTS for international students");
  }
  if (/no\s+GMAT\s*\/?\s*GRE/i.test(examPool) || /No\s+GMAT\/GRE/i.test(examPool)) {
    not_required.push("GMAT");
    not_required.push("GRE");
  } else {
    if (/no\s+GMAT/i.test(examPool) || /GMAT\s+(?:is\s+)?not\s+required/i.test(examPool)) {
      not_required.push("GMAT");
    }
    if (/no\s+GRE/i.test(examPool) || /GRE\s+(?:is\s+)?not\s+required/i.test(examPool)) {
      not_required.push("GRE");
    }
  }
  const entrance_exams: OnlineEntranceExams | null =
    required.length > 0 || not_required.length > 0
      ? { required, not_required, notes: "" }
      : null;

  // Accreditation — check full body (AACSB logo alt text may appear outside article)
  let accreditation: string | null = null;
  const accMatch = /\b(AACSB|ABET|CCNE|CAEP|NCATE|SACS|CACREP)\b/.exec(fullBodyText);
  if (accMatch) accreditation = accMatch[1].toUpperCase();

  const forms = extractForms($);

  const parse_warnings: OnlineParseWarning[] = [];
  if (contacts.length === 0) parse_warnings.push("no_contacts_extracted");
  if (application_deadlines.length === 0) parse_warnings.push("no_deadlines_extracted");
  if (tuition.per_credit_usd === null) parse_warnings.push("tuition_unparsed");
  if (admission_requirements.length === 0) parse_warnings.push("admissions_section_missing");
  if (format.length === 0) parse_warnings.push("format_field_missing");

  return {
    slug,
    name,
    degree_level,
    format,
    short_description,
    url,
    tuition,
    contacts,
    application_deadlines,
    admission_requirements,
    entrance_exams,
    accreditation,
    forms,
    raw_sections: sections,
    parse_warnings,
    retrieved_at: RETRIEVED_AT_PLACEHOLDER,
  };
}
