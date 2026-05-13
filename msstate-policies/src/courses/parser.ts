/**
 * Catalog HTML → Course parser, plus the prereq-prose decomposer.
 *
 * Two-pass prereq strategy (spec § 4.1):
 *
 *   Pass 1 (lossless): extract every course-code-shaped token from inside
 *   the parenthesized prereq clause. This is what graph-walking depends on.
 *
 *   Pass 2 (best-effort): infer logic / min_grade / non_course phrases.
 *   When uncertain, set logic="mixed" and rely on raw_prose verbatim.
 */
import { load as cheerioLoad } from "cheerio";
import { COURSE_CODE_RE, type Course, type Prereq } from "./types.js";

const COURSE_TOKEN_RE = /\b[A-Z]{2,4}\s\d{4}\b/g;
const NON_COURSE_PATTERNS: Array<{ rx: RegExp; label: (m: RegExpExecArray) => string }> = [
  { rx: /\bconsent of (?:the )?instructor\b/gi, label: () => "consent of instructor" },
  { rx: /\bpermission of (?:the )?(?:instructor|department head)\b/gi, label: (m) => m[0].toLowerCase() },
  { rx: /\b(junior|senior|graduate|sophomore|freshman) standing\b/gi, label: (m) => `${m[1].toLowerCase()} standing` },
  { rx: /\bACT\s+\d+\b/gi, label: (m) => m[0] },
  { rx: /\bSAT\s+\d+\b/gi, label: (m) => m[0] },
];

function extractParenthesized(label: "Prerequisites" | "Corequisites", input: string): string | null {
  // Allow ONE level of nested parens so clauses like
  //   "(Prerequisites: CSE 1284 and (MA 1713 or MA 1723))"
  // match as a single unit. Real catalog prose rarely nests deeper than one.
  const rx = new RegExp(`\\(\\s*${label}(?:[^()]|\\([^()]*\\))*\\)`, "i");
  const m = input.match(rx);
  return m ? m[0] : null;
}

function inferLogic(clause: string): "or" | "and" | "mixed" | null {
  const hasOr = /\bor\b/i.test(clause);
  const hasAnd = /\band\b/i.test(clause);
  if (hasOr && hasAnd) return "mixed";
  if (hasOr) return "or";
  if (hasAnd) return "and";
  return null;
}

function inferMinGrade(clause: string): Prereq["min_grade"] {
  const m = /Grade of ([ABCD])(?:\s+or\s+better)?/i.exec(clause);
  return m ? (m[1].toUpperCase() as Prereq["min_grade"]) : null;
}

function extractNonCourse(clause: string): string[] {
  const out = new Set<string>();
  for (const { rx, label } of NON_COURSE_PATTERNS) {
    let m: RegExpExecArray | null;
    rx.lastIndex = 0;
    while ((m = rx.exec(clause)) !== null) {
      out.add(label(m));
      if (m.index === rx.lastIndex) rx.lastIndex++; // zero-width safety
    }
  }
  return Array.from(out);
}

function uniqueCourseCodes(clause: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  COURSE_TOKEN_RE.lastIndex = 0;
  while ((m = COURSE_TOKEN_RE.exec(clause)) !== null) {
    const code = m[0];
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

function parseClause(label: "Prerequisites" | "Corequisites", input: string): Prereq | null {
  if (!input) return null;
  const clause = extractParenthesized(label, input);
  if (!clause) return null;
  const required_courses = uniqueCourseCodes(clause);
  const non_course = extractNonCourse(clause);
  if (required_courses.length === 0 && non_course.length === 0) {
    // Empty (no recognizable content); still report raw_prose so caller knows
    // there WAS a prereq clause we couldn't decompose.
    return {
      required_courses: [],
      logic: null,
      min_grade: null,
      non_course: [],
      raw_prose: clause,
      parse_warnings: [],  // Task 4.x will populate this when warranted
    };
  }
  return {
    required_courses,
    logic: inferLogic(clause),
    min_grade: inferMinGrade(clause),
    non_course,
    raw_prose: clause,
    parse_warnings: [],  // Task 4.x will populate this when warranted
  };
}

export function parsePrereqProse(input: string | null | undefined): Prereq | null {
  return parseClause("Prerequisites", input ?? "");
}

export function parseCoreqProse(input: string | null | undefined): Prereq | null {
  return parseClause("Corequisites", input ?? "");
}

const CROSS_LIST_RE = /\bcross[- ]listed\s+with\s+([A-Z]{2,4}\s\d{4}(?:\s*,\s*[A-Z]{2,4}\s\d{4})*)/i;
const SEMESTER_RE = /\b(?:Offered\s+in|Offered\s*[:\-])\s*([FSpSuW][\w,\s./]+?)(?:\.|\)|$)/i;

function deriveSourceUrl(code: string): string {
  const [dept, num] = code.split(/\s+/);
  return `https://catalog.msstate.edu/search/?P=${encodeURIComponent(dept)}%20${num}`;
}

function deriveLevel(code: string): "undergraduate" | "graduate" {
  // MSU convention: first digit of the 4-digit course number signals level.
  // 1xxx–4xxx = undergraduate; 5xxx+ = graduate.
  const num = parseInt(code.split(/\s+/)[1], 10);
  return num >= 5000 ? "graduate" : "undergraduate";
}

function parseHours(raw: string): number | string {
  const trimmed = raw.trim().replace(/Hours?\.?$/i, "").trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return trimmed; // "3-4", "0,4", "Var." → preserve as string
}

/**
 * Parse a `/search/?P=<code>` page into a Course record.
 *
 * Supports two CourseLeaf markup shapes seen on catalog.msstate.edu:
 *  - LIVE shape: `<article class="searchresult search-courseresult">` with
 *    a single `<h3>` containing "CODE  Title:  N hours." and a sibling
 *    `<p class="courseblockdesc">` with the description.
 *  - LEGACY/SYNTHETIC shape (kept for fixture-based unit tests): separate
 *    `<h2 class="hours">` and `<h2 class="title">` elements.
 *
 * Returns null when the input is not a recognizable result card. Callers
 * MUST treat null as "course not in catalog" (Course = 404).
 */
export function parseCourseHtml(html: string, expectedCode: string): Course | null {
  if (!COURSE_CODE_RE.test(expectedCode)) return null;
  const $ = cheerioLoad(html);

  // Prefer the real CourseLeaf course-result; fall back to the generic
  // searchresult article (covers synthetic test fixtures).
  let card = $("article.searchresult.search-courseresult").first();
  if (card.length === 0) {
    card = $("article.searchresult").first();
  }
  if (card.length === 0) return null;

  const descRaw = card.find("p.courseblockdesc, .courseblockdesc").first().text().trim();

  // Live markup combines code+title+hours in a single <h3>:
  //   "CSE 4153  Data Communications and Computer Networks:  3 hours."
  // Synthetic fixtures use separate h2.hours and h2.title.
  let title = "";
  let hoursRaw = "";

  const h3Header = card.find("h3").first().text().trim();
  const combinedRe = new RegExp(
    `^${expectedCode.replace(/\s+/g, "\\s+")}\\s+(.+?)\\s*:\\s*([\\d.,\\-\\sA-Za-z]+?Hours?\\.?)\\s*$`,
    "i",
  );
  const combinedMatch = h3Header.match(combinedRe);
  if (combinedMatch) {
    title = combinedMatch[1].trim();
    hoursRaw = combinedMatch[2].trim();
  } else {
    // Fall back to separate h2.hours / h2.title selectors (synthetic shape).
    hoursRaw = card.find("h2.hours, .hours").first().text().trim();
    const titleRaw = card.find("h2.title, .title").first().text().trim();
    const codePrefixRe = new RegExp(
      `^${expectedCode.replace(/\s+/g, "\\s+")}\\.?\\s*`,
      "i",
    );
    title = titleRaw.replace(codePrefixRe, "").replace(/\s+/g, " ").trim();
  }

  const prereqs = parsePrereqProse(descRaw);
  const coreqs = parseCoreqProse(descRaw);

  const crossMatch = descRaw.match(CROSS_LIST_RE);
  const cross_listed = crossMatch
    ? crossMatch[1]
        .split(/\s*,\s*/)
        .map((s) => s.trim())
        .filter((s) => COURSE_CODE_RE.test(s) && s !== expectedCode)
    : [];

  const semMatch = descRaw.match(SEMESTER_RE);
  const semester_offered = semMatch ? semMatch[1].trim() : null;

  return {
    code: expectedCode,
    title,
    hours: parseHours(hoursRaw),
    level: deriveLevel(expectedCode),
    description: descRaw,
    semester_offered,
    prereqs,
    coreqs,
    cross_listed,
    source_url: deriveSourceUrl(expectedCode),
    prereq_summary: null,  // Task 6.1 will build the real summary
  };
}
