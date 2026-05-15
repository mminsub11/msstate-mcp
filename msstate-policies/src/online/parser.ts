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
  StudentType,
  OnlineAdmissionsProcess,
  OnlineStaffEntry,
  OnlineInfoPage,
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
  short_description: string;
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

    const short_description = $card
      .find("div.Prg-card-description p")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    seenSlugs.add(slug);
    out.push({ slug, name, degree_level, short_description });
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
    // Strip page-chrome and analytics injectors before .text() — these leak
    // GTM noscript-iframe HTML and nav menu strings into raw_prose.
    $parent.find("script, style, noscript, iframe, nav, header, footer").remove();
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

/**
 * Find the first section whose heading matches a priority list of patterns.
 * Patterns are tried in order — the first pattern that matches ANY heading
 * wins, regardless of where that heading sits in the document. This avoids
 * a more-specific pattern losing to an earlier heading that happens to match
 * a broader fallback pattern.
 */
function findSectionByPattern(
  sections: Record<string, string>,
  patterns: RegExp[],
): string {
  for (const p of patterns) {
    for (const [heading, body] of Object.entries(sections)) {
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
  indexShortDescription?: string,
): OnlineProgram {
  const $ = cheerioLoad(html);
  const root = contentRoot($);

  // Name: h1 text (may contain a <p> child in the Drupal template)
  const name =
    $("h1").first().text().replace(/\s+/g, " ").trim() ||
    $("title").text().replace(/\s+/g, " ").trim() ||
    slug;

  const sections = extractSections($);

  // short_description priority:
  //   1. The Prg-card description from the /academic-programs index (MSU-curated, authoritative).
  //   2. The first substantive <p> in a `col-md-8` content column on the program page.
  //   3. The h1's next-sibling <p> (rare — Drupal hero h1 has no sibling on current pages).
  let short_description = (indexShortDescription ?? "").trim();
  if (short_description.length < 20) {
    $(`${root} div.col-md-8 > p`).each((_, p) => {
      if (short_description.length >= 20) return;
      const t = $(p).text().replace(/\s+/g, " ").trim();
      if (t.length >= 20 && !/^\s*program\s+highlights/i.test(t)) {
        short_description = t;
      }
    });
  }
  if (short_description.length === 0) {
    short_description = $(`${root} h1`)
      .first()
      .nextAll("p")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
  }

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

  // Prioritized patterns: try the specific phrases first; the fallback is
  // anchored at heading-start ("Admission..." / "Admissions...") so it does
  // NOT match unrelated headings like "Direct Admission" or "Conditional
  // Admission" which appear earlier in some degree-plan pages.
  const admission_requirements = findSectionByPattern(sections, [
    /admissions?\s+process/i,
    /admissions?\s+require/i,
    /how\s+to\s+apply/i,
    /^\s*admissions?\b/i,
  ]);

  let contacts = extractContacts($);
  let application_deadlines = extractDeadlines($);

  // Fallback A.1: advisingBlock contacts (BAS/PhD style)
  if (contacts.length === 0) {
    const seen = new Set<string>();
    $("[class*='advisingBlock']").each((_, el) => {
      const $card = $(el);
      // Find first non-empty h4 for the name
      let name = "";
      $card.find("h4").each((__, h4) => {
        const t = $(h4).text().trim();
        if (t.length > 0 && name.length === 0) name = t;
      });
      if (!name) return;
      // Title: first non-empty p.mb-2
      let titleP = "";
      $card.find("p.mb-2").each((__, p) => {
        const t = $(p).text().trim();
        if (t.length > 0 && titleP.length === 0) titleP = t;
      });
      // Department: h5 text (merge into title if title already set)
      const dept = $card.find("h5").first().text().trim();
      const title = titleP || dept || "";
      const email =
        $card.find('a[href^="mailto:"]').first().attr("href")?.replace(/^mailto:/, "") || null;
      const phone =
        $card.find('a[href^="tel:"]').first().attr("href")?.replace(/^tel:/, "") || null;
      const key = `${name.toLowerCase()}|${(email ?? "").toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      contacts.push({ name, title, email, phone });
    });
  }

  // Fallback A.2: quickInner tuition (BAS style)
  if (tuition.per_credit_usd === null) {
    const $credit = $("strong#credit_hours").first();
    if ($credit.length) {
      const m = $credit.text().match(/\$?([\d,]+(?:\.\d+)?)/);
      if (m) tuition.per_credit_usd = parseFloat(m[1].replace(/,/g, ""));
    }
    const $isFee = $("strong#isFee").first();
    if ($isFee.length) {
      const m = $isFee.text().match(/\$?([\d,]+(?:\.\d+)?)/);
      if (m) tuition.instructional_fee_per_credit_usd = parseFloat(m[1].replace(/,/g, ""));
    }
    if (!tuition.raw_prose) {
      const $block = $("strong#credit_hours").closest("div.quickInner");
      if ($block.length) {
        $block.find("script, style, noscript, iframe, nav, header, footer").remove();
        tuition.raw_prose = $block.text().trim().slice(0, 400);
      }
    }
  }

  // Fallback A.3: quickInner deadlines (BAS style)
  if (application_deadlines.length === 0) {
    const seen = new Set<string>();
    $("strong#deadline").each((_, el) => {
      const $strong = $(el);
      const dateText = $strong.text().trim();
      if (!dateText) return;
      const $block = $strong.closest("div.quickInner");
      const blockText = $block.text().replace(/\s+/g, " ").trim();
      const termMatch = blockText.match(/\b(Spring|Summer|Fall|Winter)\s+(?:Semester|Term|\d{4})?/i);
      const term = termMatch ? termMatch[0].trim() : "Next Application Deadline";
      const key = `${term.toLowerCase()}|${dateText.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      application_deadlines.push({ term, date_text: dateText });
    });
  }

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

// ---------------------------------------------------------------------------
// parseAdmissionsProcessHtml helpers
// ---------------------------------------------------------------------------

/**
 * Ordered rules for matching h3 headings to StudentType.
 * "international" MUST come before "graduate" to avoid mis-routing
 * "International Graduate Application Requirements" into the graduate bucket.
 */
const STUDENT_TYPE_HEADING_MAP: Array<[RegExp, StudentType]> = [
  [/international/i, "international"],
  [/undergraduate/i, "undergraduate"],
  [/graduate/i, "graduate"],
  [/transfer/i, "transfer"],
  [/readmission|readmit/i, "readmit"],
];

/**
 * Collect all text from a container element (including nested elements),
 * returning it as a single trimmed string.
 */
function containerText($: ReturnType<typeof cheerioLoad>, el: ReturnType<typeof $>): string {
  return el.text().replace(/\s+/g, " ").trim();
}

/**
 * Extract the central contact (ask@online.msstate.edu + phone) from the
 * page footer contact block. Falls back to the first matching email in the
 * page body if the block is not found.
 */
function extractCentralContact(
  $: ReturnType<typeof cheerioLoad>,
): OnlineContact {
  // The contact block is in the footer area with mailto: and tel: links
  const $emailLink = $("a[href^='mailto:ask@online.msstate.edu']").first();
  const $phoneLink = $("a[href^='tel:(662) 325-3473']").first();

  const email = $emailLink.length > 0
    ? ($emailLink.attr("href") ?? "").replace(/^mailto:/, "").trim()
    : null;

  const phone = $phoneLink.length > 0
    ? ($phoneLink.attr("href") ?? "").replace(/^tel:/, "").trim()
    : null;

  return {
    name: "Office of Online Education",
    title: "Front-desk contact",
    email,
    phone,
  };
}

/**
 * Extract application fee tiers from the fee breakdown block.
 * The fixture has: <p class="mb-0">$50 (Undergraduate)</p> etc.
 */
function extractApplicationFeeTiers(
  $: ReturnType<typeof cheerioLoad>,
): { kind: string; usd: number }[] {
  const out: { kind: string; usd: number }[] = [];
  const seen = new Set<string>();

  // Primary: the "See Fees" details block — <p class="mb-0">$50 (Undergraduate)</p>
  $("details.detsAdmisPageCostDropdown p, .detsAdmisPageCostDropdown p").each((_, p) => {
    const text = $(p).text().replace(/\s+/g, " ").trim();
    const m = /^\$(\d+)\s*\(([^)]+)\)/.exec(text);
    if (!m) return;
    const usd = Number(m[1]);
    const kind = m[2].trim();
    const key = `${usd}|${kind.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, usd });
  });

  // Fallback: scan all body text for "$50 (Undergraduate)" patterns
  if (out.length < 2) {
    $("body").find("p, li").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      const m = /^\$(\d+)\s*\(([^)]+)\)/.exec(text);
      if (!m) return;
      const usd = Number(m[1]);
      const kind = m[2].trim();
      if (usd < 10 || usd > 500) return;
      if (kind.length === 0 || kind.length > 60) return;
      const key = `${usd}|${kind.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind, usd });
    });
  }

  return out;
}

/**
 * Extract external apply URLs (apply.msstate.edu and grad.msstate.edu/apply).
 */
function extractExternalApplyUrls(
  $: ReturnType<typeof cheerioLoad>,
): { kind: string; url: string }[] {
  const out: { kind: string; url: string }[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    if (!/apply\.msstate\.edu|grad\.msstate\.edu\/apply/i.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);
    const label = $(a).text().replace(/\s+/g, " ").trim() || href;
    let kind = label;
    if (/grad\.msstate\.edu/i.test(href)) kind = "Graduate application";
    else if (/apply\.msstate\.edu/i.test(href)) kind = "Undergraduate application";
    out.push({ kind, url: href });
  });

  return out;
}

/**
 * Parse /admissions-process into an OnlineAdmissionsProcess record.
 *
 * Structure of this Drupal page:
 *   - h2 "Undergraduate Admissions" followed by <details> dropdowns, each
 *     containing an h3 that identifies the sub-type (freshman, transfer, readmit)
 *   - h2 "Graduate Admissions" followed by <details> dropdowns, each containing
 *     an h3 (graduate, international, readmit)
 *
 * We collect text at two granularities:
 *   1. h3-level (inside each <details> div.p-4) for transfer / readmit / international
 *   2. h2-level (all text under the "Undergraduate Admissions" h2) for undergraduate
 *      and (minus international) for graduate
 */
export function parseAdmissionsProcessHtml(
  html: string,
  pageUrl: string,
): OnlineAdmissionsProcess {
  const $ = cheerioLoad(html);

  // --- shared_prelude: text in the first h2 block ("Your Story Starts Here")
  // The admissions page is structured as:
  //   h2 "Your Story Starts Here" — intro/prelude text
  //   h2 "Undergraduate Admissions" — first student-type section
  //   h2 "Graduate Admissions" — second student-type section
  // The h1 lives in a separate Drupal region div, so $h1.next() walks within
  // that region, not the content area. Instead we collect all siblings between
  // the first h2 and the second h2 in the document.
  const $allH2 = $("h2");
  const preludeParts: string[] = [];
  if ($allH2.length >= 2) {
    const $firstH2 = $allH2.first();
    // Include the first h2 text itself as the prelude opener
    const firstH2Text = $firstH2.text().replace(/\s+/g, " ").trim();
    if (firstH2Text.length > 0) preludeParts.push(firstH2Text);
    let $cur = $firstH2.next();
    while ($cur.length > 0) {
      const node = $cur.get(0);
      const tag = node && node.type === "tag" ? node.name.toLowerCase() : "";
      if (tag === "h2") break;
      const t = $cur.text().replace(/\s+/g, " ").trim();
      if (t.length > 0) preludeParts.push(t);
      $cur = $cur.next();
    }
  } else {
    // Fallback: use h1 text
    preludeParts.push($("h1").first().text().replace(/\s+/g, " ").trim());
  }
  const shared_prelude = preludeParts.join("\n").trim();

  // --- section extraction ---
  // Strategy: each <details.colorful-dropdown-details> block corresponds to one
  // student-type sub-section. The h3 inside it identifies the type via
  // STUDENT_TYPE_HEADING_MAP. We collect all text from the <div.p-4> content div.
  const sections: Record<StudentType, string> = {
    undergraduate: "",
    graduate: "",
    transfer: "",
    readmit: "",
    international: "",
  };

  // Track which h2 section each <details> block belongs to by finding its
  // nearest preceding h2.
  $("details.colorful-dropdown-details").each((_, details) => {
    const $details = $(details);

    // Find the content div (div.p-4 inside the details)
    const $contentDiv = $details.find("div.p-4").first();
    if ($contentDiv.length === 0) return;

    // Get the h3 inside the content div to identify student type
    const $h3 = $contentDiv.find("h3").first();
    const h3Text = $h3.text().replace(/\s+/g, " ").trim();

    // Get the h4 in the summary (the button label) as fallback
    const $summaryH4 = $details.find("summary h4").first();
    const summaryText = $summaryH4.text().replace(/\s+/g, " ").trim();

    // Match student type: h3 text first, then summary h4 text
    let matched: StudentType | null = null;
    const textToMatch = h3Text || summaryText;
    for (const [re, type] of STUDENT_TYPE_HEADING_MAP) {
      if (re.test(textToMatch)) {
        matched = type;
        break;
      }
    }

    if (!matched) return;

    const body = containerText($, $contentDiv);
    if (body.length === 0) return;

    // Append to the matched section (readmit can appear under both undergrad and grad)
    sections[matched] = sections[matched]
      ? `${sections[matched]}\n\n${body}`
      : body;
  });

  // --- undergraduate: if still empty, collect all text under "Undergraduate Admissions" h2 ---
  // This handles the "New Admissions" / freshman block which doesn't have a clear
  // sub-type heading but belongs to undergraduate.
  if (sections.undergraduate.length === 0) {
    $("h2").each((_, h2) => {
      const text = $(h2).text().replace(/\s+/g, " ").trim();
      if (!/undergraduate/i.test(text)) return;
      let $n = $(h2).next();
      const parts: string[] = [];
      while ($n.length > 0) {
        const node = $n.get(0);
        const tag = node && node.type === "tag" ? node.name.toLowerCase() : "";
        if (tag === "h2") break;
        const t = $n.text().replace(/\s+/g, " ").trim();
        if (t.length > 0) parts.push(t);
        $n = $n.next();
      }
      sections.undergraduate = parts.join("\n").trim();
    });
  }

  // --- graduate: if still empty, collect from "Graduate Admissions" h2 ---
  if (sections.graduate.length === 0) {
    $("h2").each((_, h2) => {
      const text = $(h2).text().replace(/\s+/g, " ").trim();
      if (!/graduate/i.test(text) || /undergraduate/i.test(text)) return;
      let $n = $(h2).next();
      const parts: string[] = [];
      while ($n.length > 0) {
        const node = $n.get(0);
        const tag = node && node.type === "tag" ? node.name.toLowerCase() : "";
        if (tag === "h2") break;
        const t = $n.text().replace(/\s+/g, " ").trim();
        if (t.length > 0) parts.push(t);
        $n = $n.next();
      }
      sections.graduate = parts.join("\n").trim();
    });
  }

  // --- central contact ---
  const central_contact = extractCentralContact($);

  // --- fee tiers ---
  const application_fee_tiers = extractApplicationFeeTiers($);

  // --- external apply URLs ---
  const external_apply_urls = extractExternalApplyUrls($);

  return {
    url: pageUrl,
    central_contact,
    shared_prelude,
    sections,
    application_fee_tiers,
    external_apply_urls,
    retrieved_at: RETRIEVED_AT_PLACEHOLDER,
  };
}

// ---------------------------------------------------------------------------
// parseStaffDirectoryHtml
// ---------------------------------------------------------------------------

/**
 * Parse /staff into a list of OnlineStaffEntry records.
 *
 * The page renders staff using Drupal card-directory markup — the same pattern
 * used by per-program contact cards. Each staff card (`div.card-directory`)
 * contains:
 *   h2.directory--name        — staff member name
 *   p.directory--department   — department / office label
 *   ul.directory--titles li   — job title (first li)
 *   a.directory--email        — mailto: link
 *   a.directory--phone        — tel: link (may be absent)
 *
 * Selector strategy: `div.card-directory` matches cheerio's partial-class
 * selector, which fires on `class="card card-directory ..."` elements.
 */
export function parseStaffDirectoryHtml(
  html: string,
  pageUrl: string,
): OnlineStaffEntry[] {
  const $ = cheerioLoad(html);
  const out: OnlineStaffEntry[] = [];
  const seenEmails = new Set<string>();

  $("div.card-directory").each((_, el) => {
    const $card = $(el);

    const name = $card.find("h2.directory--name").text().replace(/\s+/g, " ").trim();
    if (name.length === 0) return;

    // Title: prefer ul.directory--titles first li (job title), fall back to department
    const titleFromList = $card
      .find("ul.directory--titles li")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const titleFromDept = $card
      .find("p.directory--department")
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const title = titleFromList || titleFromDept;

    // Department / office: p.directory--department
    const office = titleFromDept;

    const emailHref = $card.find("a.directory--email").attr("href") ?? "";
    const email = emailHref.startsWith("mailto:")
      ? emailHref.slice(7).trim()
      : null;

    // Deduplicate by email when present, by name when email absent
    const dedupeKey = email ? email.toLowerCase() : name.toLowerCase();
    if (seenEmails.has(dedupeKey)) return;
    seenEmails.add(dedupeKey);

    const phoneHref = $card.find("a.directory--phone").attr("href") ?? "";
    const phone = phoneHref.startsWith("tel:") ? phoneHref.slice(4).trim() : null;

    out.push({
      name,
      title,
      email,
      phone,
      office,
      url: pageUrl,
      retrieved_at: RETRIEVED_AT_PLACEHOLDER,
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// parseSupportPageHtml
// ---------------------------------------------------------------------------

/**
 * Parse a support info page (state-authorization, military-assistance,
 * orientation, faq, financial-matters) into an OnlineInfoPage record.
 *
 * This is a generic markdown converter that handles any Drupal page
 * with a standard structure. It extracts:
 *   - title: from h1 (or fallback to page title or slug)
 *   - body_markdown: markdown-formatted text from h1-h4, p, li elements
 *
 * Selector strategy:
 *   Extract all h1/h2/h3/h4/p/li text from the page. Convert headings
 *   to markdown (h1 → #, h2 → ##, etc.), list items to "- text", paragraphs
 *   to plain text. Collapse multiple newlines and trim.
 */
export function parseSupportPageHtml(
  html: string,
  slug: string,
  pageUrl: string,
): OnlineInfoPage {
  const $ = cheerioLoad(html);

  // Title: try h1 first, then h1 fallback, then page title, then slug
  const title =
    $("main h1").first().text().replace(/\s+/g, " ").trim() ||
    $("h1").first().text().replace(/\s+/g, " ").trim() ||
    $("title").text().replace(/\s+/g, " ").trim() ||
    slug;

  // Convert main body to markdown-ish:
  //  h1 → # ; h2 → ## ; h3 → ### ; h4 → #### ; <li> → "- text" ; <p> → text
  const lines: string[] = [];
  $("h1, h2, h3, h4, p, li").each((_, el) => {
    const $el = $(el);
    const tagName = el.type === "tag" ? el.name.toLowerCase() : "";
    const text = $el.text().replace(/\s+/g, " ").trim();
    if (text.length === 0) return;

    if (tagName === "h1") lines.push(`# ${text}`);
    else if (tagName === "h2") lines.push(`\n## ${text}`);
    else if (tagName === "h3") lines.push(`\n### ${text}`);
    else if (tagName === "h4") lines.push(`\n#### ${text}`);
    else if (tagName === "li") lines.push(`- ${text}`);
    else lines.push(text);
  });

  const body_markdown = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    slug,
    title,
    url: pageUrl,
    body_markdown,
    retrieved_at: RETRIEVED_AT_PLACEHOLDER,
  };
}
