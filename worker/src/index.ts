/**
 * Cloudflare Worker variant of the msstate-policies MCP server.
 *
 * Serves the same 5 tools as the stdio server but over HTTP/JSON-RPC,
 * so claude.ai's web connector + Claude mobile can use it. Reads policy
 * text from a pre-built corpus.json (run scripts/build-worker-corpus.mjs
 * to refresh) — the Worker can't run pdf-parse at request time.
 *
 * MCP protocol: POST /mcp with JSON-RPC 2.0. Stateless. No sessions.
 *
 * Deployment:
 *   cd worker && wrangler login && wrangler deploy
 *
 * The Worker's URL becomes the connector endpoint:
 *   https://msstate-policies-mcp.<account>.workers.dev/mcp
 */
import corpusData from "../corpus.json";

// ---- Corpus types -----------------------------------------------------------

interface Policy {
  number: string;
  slug: string;
  title: string;
  landingUrl: string;
  pdfUrl: string;
  status: string;
  firstAuthoredOrSorted: string | null;
  text: string;
  effectiveDate: string | null;
  reviewedDate: string | null;
  lastRevisedDate: string | null;
  responsibleOffice: string | null;
  approvedBy: string | null;
}

interface CalendarRow {
  source: string;
  event: string;
  start: string;
  end: string;
  time?: string;
  term?: string;
  description?: string;
  source_url: string;
  retrieved_at: string;
  citation: string;
  fallback?: boolean;
  // v0.5.0:
  contentHash?: string;
  synonyms?: string[];
}

interface CalendarBlock {
  rows: CalendarRow[];
  per_source: Record<string, { row_count: number; error: string | null }>;
  built_at: string;
}

interface Prereq {
  required_courses: string[];
  logic: "or" | "and" | "mixed" | null;
  min_grade: "A" | "B" | "C" | "D" | null;
  non_course: string[];
  raw_prose: string;
  parse_warnings?: string[];
}

interface Course {
  code: string;
  title: string;
  hours: number | string;
  level: "undergraduate" | "graduate";
  description: string;
  semester_offered: string | null;
  prereqs: Prereq | null;
  coreqs: Prereq | null;
  cross_listed: string[];
  source_url: string;
  prereq_summary?: string | null;
}

interface CourseCorpus {
  version: string;
  scraped_at: string;
  records: Record<string, Course>;
  forward_dag: Record<string, string[]>;
  reverse_dag: Record<string, string[]>;
}

interface Corpus {
  builtAt: string;
  source: string;
  indexRowCount: number;
  policies: Policy[];
  academic_calendar?: CalendarBlock;
  courses?: CourseCorpus;
}

const corpus = corpusData as unknown as Corpus;
const POLICIES: Policy[] = corpus.policies;

const CAL_ROWS: CalendarRow[] = corpus.academic_calendar?.rows ?? [];
const CAL_BUILT_AT = corpus.academic_calendar?.built_at ?? corpus.builtAt;
const CAL_PER_SOURCE = corpus.academic_calendar?.per_source ?? {};

const COURSES: CourseCorpus | null = corpus.courses ?? null;

const CAL_SOURCES = [
  "academic_calendar",
  "exam_schedule",
  "university_holidays",
  "grad_school_calendar",
  "sfa_financial_aid",
  "housing",
] as const;

// ---- BM25 tokenization + scoring (mirrors msstate-policies/src/search.ts) ---

const TOKEN_SPLIT = /[\s\-_/.,;:()\[\]{}!?"'`<>|@#$%^&*=+]+/;

function tokenize(input: string): string[] {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0);
}

const FIELD_WEIGHTS = { title: 3, number: 2, body: 1 } as const;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

interface FieldDoc {
  policy: Policy;
  titleTokens: string[];
  numberTokens: string[];
  bodyTokens: string[];
  dl: number;
}

const fieldDocs: FieldDoc[] = POLICIES.map((p) => {
  const titleTokens = tokenize(p.title);
  const numberTokens = tokenize(p.number);
  const bodyTokens = tokenize(p.text);
  return {
    policy: p,
    titleTokens,
    numberTokens,
    bodyTokens,
    dl: titleTokens.length + numberTokens.length + bodyTokens.length,
  };
});

const N = fieldDocs.length;
const df = new Map<string, number>();
let totalLen = 0;
for (const d of fieldDocs) {
  totalLen += d.dl;
  const seen = new Set<string>();
  for (const t of [...d.titleTokens, ...d.numberTokens, ...d.bodyTokens]) {
    if (!seen.has(t)) {
      df.set(t, (df.get(t) ?? 0) + 1);
      seen.add(t);
    }
  }
}
const avgLen = N > 0 ? totalLen / N : 0;

function idf(token: string): number {
  const docFreq = df.get(token) ?? 0;
  if (docFreq === 0 || N === 0) return 0;
  return Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
}

function bm25TermScore(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (avgLen || 1));
  return idfV * ((tf * (BM25_K1 + 1)) / denom);
}

function countOf(token: string, arr: string[]): number {
  let c = 0;
  for (const t of arr) if (t === token) c++;
  return c;
}

interface ScoredHit {
  policy: Policy;
  score: number;
}

function bm25Search(query: string, limit = 10): ScoredHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const scored: ScoredHit[] = [];
  for (const d of fieldDocs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = idf(q);
      if (idfQ === 0) continue;
      s += FIELD_WEIGHTS.title * bm25TermScore(countOf(q, d.titleTokens), d.dl, idfQ);
      s += FIELD_WEIGHTS.number * bm25TermScore(countOf(q, d.numberTokens), d.dl, idfQ);
      s += FIELD_WEIGHTS.body * bm25TermScore(countOf(q, d.bodyTokens), d.dl, idfQ);
    }
    if (s > 0) scored.push({ policy: d.policy, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---- Calendar BM25 (mirrors msstate-policies/src/calendars/search.ts) ------

interface CalDoc {
  row: CalendarRow;
  eventTokens: string[];
  synonymsTokens: string[];
  descriptionTokens: string[];
  termTokens: string[];
  dl: number;
}

const calDocs: CalDoc[] = CAL_ROWS.map((r) => {
  const eventTokens = tokenize(r.event);
  const synonymsTokens = tokenize((r.synonyms ?? []).join(" "));
  const descriptionTokens = tokenize(r.description ?? "");
  const termTokens = tokenize(r.term ?? "");
  return {
    row: r,
    eventTokens,
    synonymsTokens,
    descriptionTokens,
    termTokens,
    dl:
      eventTokens.length +
      synonymsTokens.length +
      descriptionTokens.length +
      termTokens.length,
  };
});
const calDf = new Map<string, number>();
let calTotalLen = 0;
for (const d of calDocs) {
  calTotalLen += d.dl;
  const seen = new Set<string>();
  for (const t of [...d.eventTokens, ...d.synonymsTokens, ...d.descriptionTokens, ...d.termTokens]) {
    if (seen.has(t)) continue;
    seen.add(t);
    calDf.set(t, (calDf.get(t) ?? 0) + 1);
  }
}
const calAvgLen = calDocs.length > 0 ? calTotalLen / calDocs.length : 0;

function calIdf(token: string): number {
  const n = calDocs.length;
  const dfi = calDf.get(token) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}

const CAL_FIELD_WEIGHTS = { event: 3, synonyms: 2, description: 1, term: 1 } as const;

function bm25TermScoreCal(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (calAvgLen || 1));
  return idfV * ((tf * (BM25_K1 + 1)) / denom);
}

function bm25SearchCalendars(query: string, limit = 10): { row: CalendarRow; score: number }[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const out: { row: CalendarRow; score: number }[] = [];
  for (const d of calDocs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = calIdf(q);
      if (idfQ === 0) continue;
      const tfE = countOf(q, d.eventTokens);
      const tfS = countOf(q, d.synonymsTokens);
      const tfD = countOf(q, d.descriptionTokens);
      const tfT = countOf(q, d.termTokens);
      s += CAL_FIELD_WEIGHTS.event * bm25TermScoreCal(tfE, d.dl, idfQ);
      s += CAL_FIELD_WEIGHTS.synonyms * bm25TermScoreCal(tfS, d.dl, idfQ);
      s += CAL_FIELD_WEIGHTS.description * bm25TermScoreCal(tfD, d.dl, idfQ);
      s += CAL_FIELD_WEIGHTS.term * bm25TermScoreCal(tfT, d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

const TERM_RX = /\b(Spring|Fall|Summer|Winter|Maymester)\s+(\d{4})\b/i;

function matchTerm(q: string): string | null {
  const m = q.match(TERM_RX);
  if (!m) return null;
  const season = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${season} ${m[2]}`;
}

const FALLBACK_PRIORITY: RegExp[] = [
  /classes\s+begin/i,
  /last\s+day\s+of\s+classes?/i,
  /final\s+exam/i,
  /spring\s+break|thanksgiving|fall\s+break|winter\s+break/i,
  /commencement|graduation/i,
  /classes?\s+end/i,
];

function sortByEventPriority(rows: CalendarRow[]): CalendarRow[] {
  return [...rows].sort((a, b) => {
    const aIdx = FALLBACK_PRIORITY.findIndex((rx) => rx.test(a.event));
    const bIdx = FALLBACK_PRIORITY.findIndex((rx) => rx.test(b.event));
    const aRank = aIdx === -1 ? FALLBACK_PRIORITY.length : aIdx;
    const bRank = bIdx === -1 ? FALLBACK_PRIORITY.length : bIdx;
    if (aRank !== bRank) return aRank - bRank;
    return a.start.localeCompare(b.start);
  });
}

// ---- Course BM25 + DAG walker (mirrors msstate-policies/src/courses/*) ------

const COURSE_CODE_RE = /^[A-Z]{2,4}\s\d{4}$/;
const COURSE_MIN_DEPTH = 1;
const COURSE_MAX_DEPTH = 10;
const COURSE_DEFAULT_DEPTH = 5;
const COURSE_FIELD_WEIGHTS = { code: 4, title: 3, description: 1 } as const;

interface CourseDoc {
  course: Course;
  codeTokens: string[];
  titleTokens: string[];
  descTokens: string[];
  dl: number;
}

const courseDocs: CourseDoc[] = COURSES
  ? Object.values(COURSES.records).map((c) => {
      const codeTokens = tokenize(c.code);
      const titleTokens = tokenize(c.title);
      const descTokens = tokenize(c.description);
      return {
        course: c,
        codeTokens,
        titleTokens,
        descTokens,
        dl: codeTokens.length + titleTokens.length + descTokens.length,
      };
    })
  : [];

const courseDf = new Map<string, number>();
let courseTotalLen = 0;
for (const d of courseDocs) {
  courseTotalLen += d.dl;
  const seen = new Set<string>();
  for (const t of [...d.codeTokens, ...d.titleTokens, ...d.descTokens]) {
    if (seen.has(t)) continue;
    seen.add(t);
    courseDf.set(t, (courseDf.get(t) ?? 0) + 1);
  }
}
const courseAvgLen = courseDocs.length > 0 ? courseTotalLen / courseDocs.length : 0;

function courseIdf(token: string): number {
  const n = courseDocs.length;
  const dfi = courseDf.get(token) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}

function bm25TermCourse(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (courseAvgLen || 1));
  return idfV * ((tf * (BM25_K1 + 1)) / denom);
}

interface CourseHit {
  course: Course;
  score: number;
}

function searchCourses(query: string, limit = 10): CourseHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const out: CourseHit[] = [];
  for (const d of courseDocs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = courseIdf(q);
      if (idfQ === 0) continue;
      s += COURSE_FIELD_WEIGHTS.code * bm25TermCourse(countOf(q, d.codeTokens), d.dl, idfQ);
      s += COURSE_FIELD_WEIGHTS.title * bm25TermCourse(countOf(q, d.titleTokens), d.dl, idfQ);
      s += COURSE_FIELD_WEIGHTS.description * bm25TermCourse(countOf(q, d.descTokens), d.dl, idfQ);
    }
    if (s > 0) out.push({ course: d.course, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(0, limit));
}

function isCourseCodeValid(raw: string): string | null {
  const norm = (raw ?? "").toUpperCase().trim().replace(/\s+/g, " ");
  return COURSE_CODE_RE.test(norm) ? norm : null;
}

function getCourse(code: string): Course | null {
  if (!COURSES) return null;
  return COURSES.records[code] ?? null;
}

interface GraphNode {
  code: string;
  title: string;
  depth: number;
}

interface GraphEdge {
  from: string;
  to: string;
  logic: "or" | "and" | "mixed" | null;
  min_grade: "A" | "B" | "C" | "D" | null;
}

interface GraphResult {
  root: string;
  direction: "prereqs" | "unlocks";
  depth_requested: number;
  depth_used: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  notes: string[];
}

function clampCourseDepth(d: number | undefined): { value: number; clamped: boolean } {
  const want = typeof d === "number" && Number.isFinite(d) ? Math.floor(d) : COURSE_DEFAULT_DEPTH;
  const value = Math.min(COURSE_MAX_DEPTH, Math.max(COURSE_MIN_DEPTH, want));
  return { value, clamped: value !== want };
}

function walkGraph(
  rootCode: string,
  direction: "prereqs" | "unlocks",
  depthRequested?: number,
): GraphResult {
  const { value: depth_used_max, clamped } = clampCourseDepth(depthRequested);
  const notes: string[] = [];
  if (clamped) notes.push(`depth clamped from ${depthRequested} to ${depth_used_max}`);

  if (!COURSES) {
    return {
      root: rootCode,
      direction,
      depth_requested: depthRequested ?? COURSE_DEFAULT_DEPTH,
      depth_used: 0,
      nodes: [],
      edges: [],
      truncated: false,
      notes: notes.concat(["course corpus not loaded"]),
    };
  }

  const root = COURSES.records[rootCode];
  if (!root) {
    return {
      root: rootCode,
      direction,
      depth_requested: depthRequested ?? COURSE_DEFAULT_DEPTH,
      depth_used: 0,
      nodes: [],
      edges: [],
      truncated: false,
      notes: notes.concat([`course not in corpus: ${rootCode}`]),
    };
  }

  const adj = direction === "prereqs" ? COURSES.forward_dag : COURSES.reverse_dag;
  const nodes: GraphNode[] = [{ code: rootCode, title: root.title, depth: 0 }];
  const edges: GraphEdge[] = [];
  const visited = new Set<string>([rootCode]);
  let truncated = false;
  let depth_used = 0;

  let frontier: Array<{ code: string; depth: number }> = [{ code: rootCode, depth: 0 }];
  while (frontier.length > 0) {
    const next: Array<{ code: string; depth: number }> = [];
    for (const { code, depth } of frontier) {
      if (depth >= depth_used_max) {
        if ((adj[code] ?? []).length > 0) truncated = true;
        continue;
      }
      const neighbors = adj[code] ?? [];
      for (const n of neighbors) {
        if (visited.has(n)) {
          notes.push(`cycle detected at ${n}`);
          truncated = true;
          continue;
        }
        visited.add(n);
        const c = COURSES.records[n];
        const title = c?.title ?? "(unknown)";
        nodes.push({ code: n, title, depth: depth + 1 });
        const sourceCode = direction === "prereqs" ? code : n;
        const sc = COURSES.records[sourceCode];
        const p = sc?.prereqs;
        edges.push({
          from: code,
          to: n,
          logic: p?.logic ?? null,
          min_grade: p?.min_grade ?? null,
        });
        next.push({ code: n, depth: depth + 1 });
        depth_used = Math.max(depth_used, depth + 1);
      }
    }
    frontier = next;
  }

  return {
    root: rootCode,
    direction,
    depth_requested: depthRequested ?? COURSE_DEFAULT_DEPTH,
    depth_used,
    nodes,
    edges,
    truncated,
    notes,
  };
}

// ---- emergency block --------------------------------------------------------

interface GuidelineRow {
  slug: string;
  title: string;
  url: string;
  body_markdown: string;
  aliases: string[];
  retrieved_at: string;
}
interface RefugeRow {
  building: string;
  area: string;
  note: string | null;
  source_url: string;
  retrieved_at: string;
}
type ContactCategory = "emergency" | "campus_non_emergency" | "off_campus_non_emergency";
interface ContactRow {
  label: string;
  phone: string;
  category: ContactCategory;
  source_url: string;
  retrieved_at: string;
}
interface EmergencyCorpus {
  builtAt: string;
  source: string;
  guidelines: GuidelineRow[];
  refuge_areas: RefugeRow[];
  contacts: ContactRow[];
}

const EMERGENCY: EmergencyCorpus | null =
  (corpus as { emergency?: EmergencyCorpus }).emergency ?? null;

const MANDATORY_DISCLAIMER =
  "If this is a life-threatening emergency, call 911 now (or MSU PD at 662-325-2121).";

const EMERGENCY_ALIASES: Record<string, string> = {
  "tornado": "severe-weather-tornado",
  "severe weather": "severe-weather-tornado",
  "thunderstorm": "severe-weather-tornado",
  "shooter": "violence-threats-of-violence",
  "active shooter": "violence-threats-of-violence",
  "violence": "violence-threats-of-violence",
  "fire": "smoke-fire",
  "smoke": "smoke-fire",
  "evacuate": "building-evacuations",
  "evacuation": "building-evacuations",
  "shelter": "sheltering-in-place",
  "shelter in place": "sheltering-in-place",
  "lockdown": "sheltering-in-place",
  "earthquake": "earthquake",
  "covid": "infectious-disease",
  "pandemic": "infectious-disease",
  "flu": "infectious-disease",
  "ice storm": "winter-weather",
  "snow": "winter-weather",
  "winter": "winter-weather",
  "bomb": "suspicious-devices-substances",
  "suspicious package": "suspicious-devices-substances",
  "prepare": "preparedness",
  "preparation": "preparedness",
};

const EMG_FIELD_WEIGHTS = { title: 3, slug: 2, body: 1, alias: 4 } as const;
const EMG_BM25_K1 = 1.2;
const EMG_BM25_B = 0.75;

interface EmgDoc {
  row: GuidelineRow;
  titleTokens: string[];
  slugTokens: string[];
  bodyTokens: string[];
  aliasTokens: string[];
  dl: number;
}

const EMG_DOCS: EmgDoc[] = (EMERGENCY?.guidelines ?? []).map((row) => {
  const titleTokens = tokenize(row.title);
  const slugTokens = tokenize(row.slug);
  const bodyTokens = tokenize(row.body_markdown.slice(0, 200));
  const aliasTokens = tokenize(row.aliases.join(" "));
  return {
    row, titleTokens, slugTokens, bodyTokens, aliasTokens,
    dl: titleTokens.length + slugTokens.length + bodyTokens.length + aliasTokens.length,
  };
});

const EMG_DF = new Map<string, number>();
let EMG_AVG_LEN = 0;
{
  let total = 0;
  for (const d of EMG_DOCS) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.titleTokens, ...d.slugTokens, ...d.bodyTokens, ...d.aliasTokens]) {
      if (seen.has(t)) continue;
      seen.add(t);
      EMG_DF.set(t, (EMG_DF.get(t) ?? 0) + 1);
    }
  }
  EMG_AVG_LEN = EMG_DOCS.length > 0 ? total / EMG_DOCS.length : 0;
}

function emgIdf(token: string): number {
  const n = EMG_DOCS.length;
  const dfi = EMG_DF.get(token) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}

function emgBm25(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + EMG_BM25_K1 * (1 - EMG_BM25_B + (EMG_BM25_B * dl) / (EMG_AVG_LEN || 1));
  return idfV * ((tf * (EMG_BM25_K1 + 1)) / denom);
}

function emgBm25Search(query: string): { row: GuidelineRow; score: number }[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const out: { row: GuidelineRow; score: number }[] = [];
  for (const d of EMG_DOCS) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = emgIdf(q);
      if (idfQ === 0) continue;
      s += EMG_FIELD_WEIGHTS.title * emgBm25(countOf(q, d.titleTokens), d.dl, idfQ);
      s += EMG_FIELD_WEIGHTS.slug  * emgBm25(countOf(q, d.slugTokens),  d.dl, idfQ);
      s += EMG_FIELD_WEIGHTS.body  * emgBm25(countOf(q, d.bodyTokens),  d.dl, idfQ);
      s += EMG_FIELD_WEIGHTS.alias * emgBm25(countOf(q, d.aliasTokens), d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

interface EmgResolveResult {
  matched: GuidelineRow | null;
  via: "exact_slug" | "alias" | "bm25" | "none";
  did_you_mean: GuidelineRow[];
  suggestions: GuidelineRow[];
}

function resolveEmergencyGuideline(input: string): EmgResolveResult {
  const norm = (input ?? "").toLowerCase().trim();
  const all = EMERGENCY?.guidelines ?? [];
  if (!norm || all.length === 0) {
    return { matched: null, via: "none", did_you_mean: [], suggestions: all };
  }
  const exact = all.find((g) => g.slug === norm);
  if (exact) return { matched: exact, via: "exact_slug", did_you_mean: [], suggestions: [] };
  const aliasSlug = EMERGENCY_ALIASES[norm];
  if (aliasSlug) {
    const row = all.find((g) => g.slug === aliasSlug);
    if (row) return { matched: row, via: "alias", did_you_mean: [], suggestions: [] };
  }
  const hits = emgBm25Search(norm);
  if (hits.length === 0) return { matched: null, via: "none", did_you_mean: [], suggestions: all };
  return { matched: hits[0].row, via: "bm25", did_you_mean: hits.slice(1, 3).map((h) => h.row), suggestions: [] };
}

function findEmergencyRefuge(input: string): RefugeRow[] {
  const rows = EMERGENCY?.refuge_areas ?? [];
  const norm = (input ?? "").toLowerCase().trim();
  if (!norm || rows.length === 0) return [];
  const sub = rows.filter((r) => r.building.toLowerCase().includes(norm));
  if (sub.length > 0) return sub;
  const qTokens = tokenize(norm);
  if (qTokens.length === 0) return [];
  const docs = rows.map((r) => ({ row: r, tokens: tokenize(r.building) }));
  const df = new Map<string, number>();
  let total = 0;
  for (const d of docs) {
    total += d.tokens.length;
    const seen = new Set<string>();
    for (const t of d.tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const avg = docs.length > 0 ? total / docs.length : 0;
  function idfR(t: string): number {
    const n = docs.length;
    const dfi = df.get(t) ?? 0;
    if (dfi === 0 || n === 0) return 0;
    return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
  }
  const scored: { row: RefugeRow; score: number }[] = [];
  for (const d of docs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = idfR(q);
      if (idfQ === 0) continue;
      const tf = countOf(q, d.tokens);
      if (tf <= 0) continue;
      const denom = tf + EMG_BM25_K1 * (1 - EMG_BM25_B + (EMG_BM25_B * d.tokens.length) / (avg || 1));
      s += idfQ * ((tf * (EMG_BM25_K1 + 1)) / denom);
    }
    if (s > 0) scored.push({ row: d.row, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.row);
}

function filterEmergencyContacts(categoryInput: string): ContactRow[] {
  const rows = EMERGENCY?.contacts ?? [];
  const map: Record<string, ContactCategory | "all"> = {
    all: "all",
    emergency: "emergency",
    campus: "campus_non_emergency",
    off_campus: "off_campus_non_emergency",
  };
  const want = map[(categoryInput ?? "all").toLowerCase().trim()];
  if (!want) return [];
  if (want === "all") return rows.slice();
  return rows.filter((c) => c.category === want);
}

// ---- tuition block ---------------------------------------------------------

interface TuitionLineItem { label: string; amount_usd: number; }
type CampusSlug = "starkville" | "meridian" | "mgccc" | "online" | "vetmed";
type Level = "undergrad" | "grad" | "dvm";
type Residency = "resident" | "non_resident";
type TermT = "fall_spring" | "winter" | "summer" | "annual";
type RateBasis = "per_credit_hour" | "per_semester_flat" | "annual_flat";
type CreditHourBucket = "1-11" | "12-16" | "1-8" | "9+";

interface TuitionRateRow {
  campus: CampusSlug; level: Level; residency: Residency; term: TermT;
  rate_basis: RateBasis; credit_hour_bucket: CreditHourBucket | null;
  amount_usd: number; line_items: TuitionLineItem[];
  effective_term: string; source_url: string; retrieved_at: string;
}
interface FeeRow {
  kind: "college" | "program" | "course_distance";
  label: string; per_credit_usd: number | null;
  full_time_cap_usd: number | null; flat_amount_usd: number | null;
  applicability_note: string; source_url: string; retrieved_at: string;
}
interface FaqRow {
  question: string; answer: string; source_url: string; retrieved_at: string;
}
interface CampusEntry {
  slug: CampusSlug; display_name: string; levels_offered: Level[];
  rate_basis: "per_credit_hour" | "annual_flat"; source_url: string;
}
interface TuitionCorpus {
  builtAt: string; source: string;
  rate_rows: TuitionRateRow[]; fee_rows: FeeRow[];
  faq_rows: FaqRow[]; campuses: CampusEntry[];
}

const TUITION: TuitionCorpus | null =
  (corpus as { tuition?: TuitionCorpus }).tuition ?? null;

const TUITION_DISCLAIMER =
  "Tuition rates are subject to change without notice. Always verify the current rate at https://www.controller.msstate.edu/accountservices/tuition before paying.";

// BM25 over the FAQ rows (question×2, answer×1; k1=1.2, b=0.75)
const TUI_FIELD_WEIGHTS = { question: 2, answer: 1 } as const;
const TUI_BM25_K1 = 1.2;
const TUI_BM25_B = 0.75;

interface TuiFaqDoc {
  row: FaqRow; qTokens: string[]; aTokens: string[]; dl: number;
}
const TUI_FAQ_DOCS: TuiFaqDoc[] = (TUITION?.faq_rows ?? []).map((row) => {
  const qTokens = tokenize(row.question);
  const aTokens = tokenize(row.answer);
  return { row, qTokens, aTokens, dl: qTokens.length + aTokens.length };
});
const TUI_FAQ_DF = new Map<string, number>();
let TUI_FAQ_AVGLEN = 0;
{
  let total = 0;
  for (const d of TUI_FAQ_DOCS) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.qTokens, ...d.aTokens]) {
      if (seen.has(t)) continue;
      seen.add(t);
      TUI_FAQ_DF.set(t, (TUI_FAQ_DF.get(t) ?? 0) + 1);
    }
  }
  TUI_FAQ_AVGLEN = TUI_FAQ_DOCS.length > 0 ? total / TUI_FAQ_DOCS.length : 0;
}
function tuiFaqIdf(t: string): number {
  const n = TUI_FAQ_DOCS.length;
  const dfi = TUI_FAQ_DF.get(t) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}
function tuiBm25(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + TUI_BM25_K1 * (1 - TUI_BM25_B + (TUI_BM25_B * dl) / (TUI_FAQ_AVGLEN || 1));
  return idfV * ((tf * (TUI_BM25_K1 + 1)) / denom);
}
function tuiSearchFaq(query: string, k: number): { row: FaqRow; score: number }[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const out: { row: FaqRow; score: number }[] = [];
  for (const d of TUI_FAQ_DOCS) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = tuiFaqIdf(q);
      if (idfQ === 0) continue;
      s += TUI_FIELD_WEIGHTS.question * tuiBm25(countOf(q, d.qTokens), d.dl, idfQ);
      s += TUI_FIELD_WEIGHTS.answer   * tuiBm25(countOf(q, d.aTokens), d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, Math.min(k, out.length)));
}

// Rate routing (mirrors src/tuition/search.ts)
function tuiPickBucket(level: Level, hours: number): CreditHourBucket | null {
  if (level === "undergrad") return hours <= 11 ? "1-11" : "12-16";
  if (level === "grad")      return hours <= 8 ? "1-8"  : "9+";
  return null;
}
interface TuiRateReq {
  campus: CampusSlug; level: Level; residency: Residency;
  term?: TermT; credit_hours?: number;
}
function tuiRouteRate(req: TuiRateReq): { matches: TuitionRateRow[]; not_found_reason?: string } {
  if (req.campus === "vetmed" && req.level !== "dvm") {
    return { matches: [], not_found_reason: "Vetmed publishes tuition for the DVM program only. For graduate-level MS/PhD vet med programs, see Starkville graduate rates." };
  }
  if (req.level === "dvm" && req.campus !== "vetmed") {
    return { matches: [], not_found_reason: "DVM tuition is published only by the College of Veterinary Medicine. See campus=vetmed." };
  }
  if (req.campus === "mgccc" && req.level === "grad") {
    return { matches: [], not_found_reason: "MGCCC partnership covers undergraduate engineering only — graduate students enroll on the Starkville campus." };
  }
  let rows = (TUITION?.rate_rows ?? []).filter(
    (r) => r.campus === req.campus && r.level === req.level && r.residency === req.residency,
  );
  if (req.term) rows = rows.filter((r) => r.term === req.term);
  if (req.campus === "vetmed") return { matches: rows };
  if (typeof req.credit_hours === "number") {
    const b = tuiPickBucket(req.level, req.credit_hours);
    if (b) rows = rows.filter((r) => r.credit_hour_bucket === b || r.credit_hour_bucket === null);
  }
  return { matches: rows };
}

// ---- online block ----------------------------------------------------------

type DegreeLevel = "bachelor" | "master" | "specialist" | "doctoral" | "certificate" | "endorsement";
type StudentType = "undergraduate" | "graduate" | "transfer" | "readmit" | "international";

interface OnlineContact {
  name: string;
  title: string;
  email: string | null;
  phone: string | null;
}
interface OnlineApplicationDeadline { term: string; date_text: string; }
interface OnlineEntranceExams { required: string[]; not_required: string[]; notes: string; }
interface OnlineProgramTuition {
  per_credit_usd: number | null;
  instructional_fee_per_credit_usd: number | null;
  application_fee_domestic_usd: number | null;
  application_fee_international_usd: number | null;
  raw_prose: string;
}
interface OnlineProgram {
  slug: string; name: string; degree_level: DegreeLevel; format: string;
  short_description: string; url: string;
  tuition: OnlineProgramTuition;
  contacts: OnlineContact[];
  application_deadlines: OnlineApplicationDeadline[];
  admission_requirements: string;
  entrance_exams: OnlineEntranceExams | null;
  accreditation: string | null;
  forms: { label: string; url: string }[];
  raw_sections: Record<string, string>;
  parse_warnings?: string[];
  retrieved_at: string;
}
interface OnlineAdmissionsProcess {
  url: string;
  central_contact: OnlineContact;
  shared_prelude: string;
  sections: Record<StudentType, string>;
  application_fee_tiers: { kind: string; usd: number }[];
  external_apply_urls: { kind: string; url: string }[];
  retrieved_at: string;
}
interface OnlineStaffEntry {
  name: string; title: string; email: string | null; phone: string | null;
  office: string; url: string; retrieved_at: string;
}
interface OnlineInfoPage {
  slug: string; title: string; url: string; body_markdown: string; retrieved_at: string;
}
interface OnlineCorpus {
  builtAt: string;
  source: string;
  programs: OnlineProgram[];
  admissions_process: OnlineAdmissionsProcess;
  staff: OnlineStaffEntry[];
  info_pages: OnlineInfoPage[];
}

const ONLINE: OnlineCorpus | null =
  (corpus as { online_education?: OnlineCorpus }).online_education ?? null;

const ONLINE_DISCLAIMER =
  "Contact info, application deadlines, tuition, and program details on online.msstate.edu can change between releases. Verify against the source URL before applying.";

const ONL_FIELD_WEIGHTS = { title: 3, body: 1 } as const;
const ONL_BM25_K1 = 1.2;
const ONL_BM25_B = 0.75;

interface OnlInfoDoc {
  row: OnlineInfoPage;
  titleTokens: string[];
  bodyTokens: string[];
  dl: number;
}

function flattenStaffAsDocWorker(staff: OnlineStaffEntry[]): OnlineInfoPage {
  const lines = staff.map((s) => `${s.name} — ${s.title}. ${s.email ?? ""} ${s.phone ?? ""} ${s.office}`);
  return {
    slug: "staff",
    title: "MSU Online Staff",
    url: "https://www.online.msstate.edu/staff",
    body_markdown: lines.join("\n"),
    retrieved_at: staff[0]?.retrieved_at ?? "1970-01-01T00:00:00.000Z",
  };
}

const ONL_INFO_DOCS: OnlInfoDoc[] = (() => {
  if (!ONLINE) return [];
  const docs: OnlineInfoPage[] = [...ONLINE.info_pages];
  if (ONLINE.staff.length > 0) docs.push(flattenStaffAsDocWorker(ONLINE.staff));
  return docs.map((row) => ({
    row,
    titleTokens: tokenize(row.title),
    bodyTokens: tokenize(row.body_markdown),
    dl: tokenize(row.title).length + tokenize(row.body_markdown).length,
  }));
})();

const ONL_INFO_DF = new Map<string, number>();
let ONL_INFO_AVGLEN = 0;
{
  let total = 0;
  for (const d of ONL_INFO_DOCS) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.titleTokens, ...d.bodyTokens]) {
      if (seen.has(t)) continue;
      seen.add(t);
      ONL_INFO_DF.set(t, (ONL_INFO_DF.get(t) ?? 0) + 1);
    }
  }
  ONL_INFO_AVGLEN = ONL_INFO_DOCS.length > 0 ? total / ONL_INFO_DOCS.length : 0;
}

function onlInfoIdf(t: string): number {
  const n = ONL_INFO_DOCS.length;
  const dfi = ONL_INFO_DF.get(t) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}

function onlInfoBm25(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + ONL_BM25_K1 * (1 - ONL_BM25_B + (ONL_BM25_B * dl) / (ONL_INFO_AVGLEN || 1));
  return idfV * ((tf * (ONL_BM25_K1 + 1)) / denom);
}

type OnlineScope =
  | "all" | "state-authorization" | "military-assistance" | "orientation" | "faq" | "financial-matters" | "staff";

function onlSearchInfo(query: string, k: number, scope: OnlineScope): { row: OnlineInfoPage; score: number }[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const docs = scope === "all" ? ONL_INFO_DOCS : ONL_INFO_DOCS.filter((d) => d.row.slug === scope);
  const out: { row: OnlineInfoPage; score: number }[] = [];
  for (const d of docs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = onlInfoIdf(q);
      if (idfQ === 0) continue;
      s += ONL_FIELD_WEIGHTS.title * onlInfoBm25(countOf(q, d.titleTokens), d.dl, idfQ);
      s += ONL_FIELD_WEIGHTS.body  * onlInfoBm25(countOf(q, d.bodyTokens),  d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, Math.min(k, out.length)));
}

function onlFilterPrograms(req: { level?: DegreeLevel; subject_keyword?: string; limit?: number; offset?: number }) {
  const programs = ONLINE?.programs ?? [];
  let filtered = programs;
  if (req.level) filtered = filtered.filter((p) => p.degree_level === req.level);
  if (req.subject_keyword && req.subject_keyword.trim().length > 0) {
    const k = req.subject_keyword.trim().toLowerCase();
    filtered = filtered.filter((p) =>
      p.name.toLowerCase().includes(k) || p.short_description.toLowerCase().includes(k));
  }
  const limit = Math.max(1, Math.min(req.limit ?? 50, 200));
  const offset = Math.max(0, req.offset ?? 0);
  return {
    matches: filtered.slice(offset, offset + limit).map((p) => ({
      slug: p.slug, name: p.name, degree_level: p.degree_level,
      short_description: p.short_description, url: p.url,
    })),
    total: programs.length,
    filtered_total: filtered.length,
  };
}

function onlFuzzyResolveProgram(query: string): { matched: OnlineProgram | null; did_you_mean: Array<{ slug: string; name: string }> } {
  const programs = ONLINE?.programs ?? [];
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return { matched: null, did_you_mean: [] };
  const scored = programs.map((p) => {
    const slugT = tokenize(p.slug);
    const nameT = tokenize(p.name);
    const shortT = tokenize(p.short_description);
    let score = 0;
    for (const q of qTokens) {
      score += 4 * countOf(q, slugT);
      score += 3 * countOf(q, nameT);
      score += 1 * countOf(q, shortT);
    }
    return { p, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { matched: null, did_you_mean: [] };
  return {
    matched: scored[0].p,
    did_you_mean: scored.slice(1, 3).map((x) => ({ slug: x.p.slug, name: x.p.name })),
  };
}

// ---- Helpers ----------------------------------------------------------------

function findPolicy(numberOrSlug?: string, url?: string): Policy | undefined {
  if (numberOrSlug) {
    const slug = numberOrSlug.replace(/\./g, "");
    return POLICIES.find((p) => p.number === numberOrSlug || p.slug === slug);
  }
  if (url) {
    return POLICIES.find((p) => p.landingUrl === url || p.pdfUrl === url);
  }
  return undefined;
}

function snippetFor(text: string, query: string, windowChars = 240): string {
  if (!text) return "";
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return text.slice(0, windowChars);
  const lower = text.toLowerCase();
  for (const q of qTokens) {
    const idx = lower.indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + windowChars - 60);
      const prefix = start > 0 ? "…" : "";
      const suffix = end < text.length ? "…" : "";
      return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
    }
  }
  return text.slice(0, windowChars).replace(/\s+/g, " ").trim() + (text.length > windowChars ? "…" : "");
}

// ---- MCP tool definitions ---------------------------------------------------

const TOOLS = [
  {
    name: "search_policies",
    description:
      "Search Mississippi State University Operating Policies by keyword. Returns policy numbers + titles + URLs + match snippets, ranked by relevance. Use this when the user asks about a topic and you need to find which policies apply. For one-shot natural-language questions ('what's the rule on X?'), prefer `chain_find_relevant_policies` instead, which fetches full bodies in one call.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "integer", description: "Maximum results (default 10).", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_policy",
    description:
      "Fetch the full text of one MSU Operating Policy by number (e.g. '91.100') or URL. Returns policy text from the official PDF, plus effective/revised dates and responsible office. Use after `search_policies` to read a specific policy in full.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "string", description: "Policy number, e.g. '91.100'." },
        url: { type: "string", description: "Policy URL (alternative to number)." },
      },
    },
  },
  {
    name: "chain_find_relevant_policies",
    description:
      "One-call workflow for natural-language MSU policy questions ('what are the rules on amnesty?', 'what's the policy on withdrawal?'). Returns the full text of the top-k most relevant MSU Operating Policies. RULES for answering: (1) Use ONLY the returned text — do not draw on outside knowledge. (2) For any normative claim ('the policy says X', 'you must Y', deadlines, eligibility criteria, dollar amounts, exceptions), QUOTE VERBATIM from the policy text in quotation marks and cite the OP number + URL. Do not paraphrase load-bearing language. (3) If the returned policies don't clearly answer the question, say so plainly and recommend contacting the responsible office; do NOT extrapolate. (4) Always include the `retrievedAt` timestamp and the canonical landing URL so the user can verify.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Natural-language MSU policy question.",
        },
        k: {
          type: "integer",
          description: "How many top policies to fetch in full. Default 2 keeps response under ~16k tokens.",
          default: 2,
          minimum: 1,
          maximum: 5,
        },
      },
      required: ["question"],
    },
  },
  {
    name: "cite_policy",
    description:
      "Format a citation string for an MSU Operating Policy by number. Use when you need a clean reference for an answer.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "string", description: "Policy number, e.g. '91.100'." },
        style: {
          type: "string",
          enum: ["short", "full"],
          default: "short",
          description: "'short' = OP NN.NN (Title); 'full' = full citation with date + URL.",
        },
      },
      required: ["number"],
    },
  },
  {
    name: "find_msu_date",
    description:
      "Answer natural-language questions about Mississippi State University academic dates, financial-aid deadlines, university holidays, residence-life milestones, and graduate-school deadlines. Returns up to 10 matching calendar rows ranked by relevance, plus up to 3 academic-calendar fallback rows when a term is mentioned and the primary source has limited coverage.\n\nEach row has:\n- `start`, `end` — ISO dates (YYYY-MM-DD).\n- `event`, `term`, `description` — what happened and when.\n- `source`, `source_url` — which calendar and the canonical msstate.edu URL.\n- `citation` — a pre-formatted markdown link. You MUST include this verbatim in your final answer for every row you reference. Do not paraphrase or omit it. Format: `[Event, Term](url)`.\n- `fallback` (optional) — if true, this row came from the academic-calendar fallback because the user's primary source didn't have data for the mentioned term. Surface this explicitly: \"Your primary source doesn't list this date for that term, but the academic calendar shows…\"\n\nRULES:\n1. Use ONLY the returned rows. Do not invent dates or draw on outside knowledge.\n2. Quote the date verbatim. Always include the `citation` field as a clickable link.\n3. If the user's question does NOT specify a year/term and multiple year-versions of an event exist (e.g., Spring Break 2026 and Spring Break 2027), present ALL of them year-by-year with each one's citation.\n4. If matches is empty or no row clearly answers the question, say so plainly; do not extrapolate.\n5. Surface the row's `retrieved_at` and `corpus_built_at` when accuracy is at stake.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Natural-language MSU date question." },
      },
      required: ["q"],
    },
  },
  {
    name: "get_msu_calendar",
    description:
      "Return the raw rows for one MSU calendar source. `source` is one of: academic_calendar, exam_schedule, university_holidays, grad_school_calendar, sfa_financial_aid, housing. Optional `term` filter matches via case-insensitive substring (e.g. 'Fall 2026', '2026', 'fall'). Each row has a pre-formatted `citation` markdown link — include it verbatim when surfacing any specific date to the user.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: [
            "academic_calendar",
            "exam_schedule",
            "university_holidays",
            "grad_school_calendar",
            "sfa_financial_aid",
            "housing",
          ],
        },
        term: { type: "string", description: "Optional term filter." },
      },
      required: ["source"],
    },
  },
  {
    name: "search_msu_courses",
    description:
      "Fuzzy-search the MSU course catalog by code, title, or description (BM25). Returns a ranked list of `{ code, title, hours, dept, level, score }`. Use this when the student doesn't know the exact course code (e.g., 'what's MSU's networking class?'). All content sourced from catalog.msstate.edu.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Natural-language query." },
        limit: { type: "integer", description: "Maximum results (default 10).", default: 10 },
      },
      required: ["q"],
    },
  },
  {
    name: "get_msu_course",
    description:
      "Fetch one course's full record from the MSU catalog: title, hours, level, description, semester offered, prereqs (with structured course-codes + raw prose), coreqs, cross-listed equivalents, source URL. `code` is normalized to uppercase with single space (e.g. 'cse 4153' → 'CSE 4153'). Returns `{found:false, suggestions}` if unknown. Prereq fields `required_courses` and `raw_prose` are authoritative; `logic`, `min_grade`, `non_course` are best-effort parses of MSU's prose.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Course code, e.g. 'CSE 4153'." },
      },
      required: ["code"],
    },
  },
  {
    name: "get_msu_course_graph",
    description:
      "Walk the MSU course prereq DAG forward (`prereqs` — 'what do I need before X?') or reverse (`unlocks` — 'what does X unlock?'). Returns nodes + edges with depth, plus `truncated:true` if the walk hit the depth cap (default 5, max 10) or a cycle. Edge `logic`/`min_grade` come from the source course's prereq parse and are best-effort; `required_courses` (in the upstream nodes' raw records) is authoritative.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Root course code, e.g. 'CSE 4733'." },
        direction: {
          type: "string",
          enum: ["prereqs", "unlocks"],
          description: "'prereqs' walks forward (what's needed); 'unlocks' walks reverse (what this enables).",
        },
        depth: {
          type: "integer",
          description: "How many hops to traverse. Default 5; clamped to [1, 10].",
          minimum: 1,
          maximum: 10,
          default: 5,
        },
      },
      required: ["code", "direction"],
    },
  },
  {
    name: "get_msu_emergency_guideline",
    description:
      "Look up MSU's published emergency guideline for a situation (tornado, fire, active shooter, etc.). Returns the guideline verbatim plus a 911 reminder. Every response leads with the disclaimer 'If this is a life-threatening emergency, call 911 now...'. `emergency_type` accepts a slug, an alias ('tornado', 'fire', 'shooter'), or free text — the resolver tries exact slug, then the curated alias map, then BM25. All content sourced from www.emergency.msstate.edu/guidelines.",
    inputSchema: {
      type: "object",
      properties: {
        emergency_type: { type: "string", description: "Emergency type — slug, alias, or free text." },
      },
      required: ["emergency_type"],
    },
  },
  {
    name: "list_msu_emergency_types",
    description:
      "List MSU's published emergency-guideline types (12 entries). Returns `{ slug, title, url }` for each. Every response leads with the 911 disclaimer. All content from www.emergency.msstate.edu/guidelines.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_msu_severe_weather_refuge",
    description:
      "Look up the published severe-weather refuge area for an MSU building. Returns `{ building, area, note }` rows from www.emergency.msstate.edu/refuge. SEVERE WEATHER ONLY — for fires use `get_msu_emergency_guideline(\"smoke-fire\")`; for active threats use `get_msu_emergency_guideline(\"violence\")`. Every response leads with the 911 disclaimer.",
    inputSchema: {
      type: "object",
      properties: {
        building_name: { type: "string", description: "Building name, fuzzy match." },
      },
      required: ["building_name"],
    },
  },
  {
    name: "get_msu_emergency_contacts",
    description:
      "Return MSU emergency-related phone contacts. `category` accepts: 'all' (default), 'emergency', 'campus', 'off_campus'. Every response leads with the 911 disclaimer. All numbers sourced from www.emergency.msstate.edu/refuge.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "all | emergency | campus | off_campus",
          default: "all",
        },
      },
    },
  },
  {
    name: "get_msu_tuition_rate",
    description: "Look up MSU tuition for a specific campus + level + residency + (optional) term + (optional) credit_hours. Returns matching rate rows verbatim with effective_term and a breakdown of line_items. Every response includes the disclaimer that rates are subject to change. Rules: campus=vetmed requires level=dvm; level=dvm requires campus=vetmed; campus=mgccc has no graduate program. Undergrad credit_hours buckets: 1-11 / 12-16. Grad: 1-8 / 9+. Hours >16 cap to 12-16. Source: controller.msstate.edu (4 campuses) + vetmed.msstate.edu/tuition.",
    inputSchema: {
      type: "object",
      properties: {
        campus: { type: "string", enum: ["starkville", "meridian", "mgccc", "online", "vetmed"] },
        level: { type: "string", enum: ["undergrad", "grad", "dvm"] },
        residency: { type: "string", enum: ["resident", "non_resident"] },
        term: { type: "string", enum: ["fall_spring", "winter", "summer", "annual"] },
        credit_hours: { type: "integer", minimum: 1, maximum: 30 },
      },
      required: ["campus", "level", "residency"],
    },
  },
  {
    name: "get_msu_enrollment_fees",
    description: "List MSU's per-college, per-program, and per-course/distance enrollment fees. `kind`: 'college' | 'program' | 'course_distance'. `filter` (optional): case-insensitive substring on the label. Every response carries the tuition disclaimer. Source: controller.msstate.edu/accountservices/tuition/other-enrollment-costs.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["college", "program", "course_distance"] },
        filter: { type: "string", description: "Substring filter, max 4096 chars" },
      },
      required: ["kind"],
    },
  },
  {
    name: "find_msu_tuition_faq",
    description: "Search MSU's tuition FAQ (controller.msstate.edu/accountservices/tuition/frequently-asked-questions) for a question. Returns top-k matching Q&A pairs verbatim. `q`: free-text. `k`: 1-10, default 3. Every response carries the tuition disclaimer. BM25.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Question text, max 4096 chars" },
        k: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["q"],
    },
  },
  {
    name: "list_msu_tuition_campuses",
    description: "List MSU's 5 published tuition campuses (starkville, meridian, mgccc, online, vetmed) with display name, levels_offered, rate_basis, and source URL. Use this to discover valid `campus` values before calling get_msu_tuition_rate.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_online_programs",
    description: "Browse / filter MSU's online programs from online.msstate.edu. Returns lightweight rows {slug, name, degree_level, short_description, url}; for full details follow up with get_online_program. `level` filters by degree level. `subject_keyword` is case-insensitive substring on name + short_description. `limit` (default 50, max 200) + `offset` paginate. Every response carries the online disclaimer.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["bachelor","master","specialist","doctoral","certificate","endorsement"] },
        subject_keyword: { type: "string", description: "Substring match, max 4096 chars" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "get_online_program",
    description: "Fetch one online program's full record. Provide `slug` (e.g. 'mba', 'bsee') for direct lookup, OR `name_query` (e.g. 'online psychology bachelor') for fuzzy match. Exactly one required. When name_query routes via BM25, top-1 is in matched and next-2 in did_you_mean. Every response carries the online disclaimer.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "URL-tail slug, max 4096 chars" },
        name_query: { type: "string", description: "Fuzzy name query, max 4096 chars" },
      },
    },
  },
  {
    name: "get_online_admissions_process",
    description: "Return MSU Online's admissions process sectioned by student type (undergraduate / graduate / transfer / readmit / international). Pass `student_type` for one section; omit for all five. Always returns shared_prelude + central_contact + application_fee_tiers + external_apply_urls. Carries the online disclaimer.",
    inputSchema: {
      type: "object",
      properties: {
        student_type: { type: "string", enum: ["undergraduate","graduate","transfer","readmit","international"] },
      },
    },
  },
  {
    name: "find_online_info",
    description: "BM25 search over MSU Online's support pages (state-authorization, military-assistance, orientation, faq, financial-matters) + the central staff directory. Use when the question isn't about a specific program or the general admissions process. `scope` pre-filters to one slug. Top-k matches with verbatim excerpt + full_body + source_url. Carries the online disclaimer.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Free-text query, max 4096 chars" },
        k: { type: "integer", minimum: 1, maximum: 10 },
        scope: { type: "string", enum: ["all","state-authorization","military-assistance","orientation","faq","financial-matters","staff"] },
      },
      required: ["q"],
    },
  },
  {
    name: "health_check",
    description:
      "Inspect the Worker's corpus state. Returns counts, build timestamp, and runtime info. Visible to the LLM so it can apologize coherently if the corpus is stale or empty.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

// ---- Tool handlers ----------------------------------------------------------

interface McpContent {
  type: "text";
  text: string;
}

interface McpToolResponse {
  content: McpContent[];
  isError?: boolean;
}

function jsonContent(obj: unknown): McpToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function errorContent(message: string): McpToolResponse {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Cap user-provided query/question strings before tokenize() runs over them.
// Rejecting at the boundary prevents a malicious caller from forcing the
// Worker to allocate hundreds of MB of token arrays from a megabyte-sized
// payload, which would push us past free-tier memory limits.
const MAX_QUERY_CHARS = 4096;

function tooLong(name: string, value: string): McpToolResponse {
  return errorContent(
    `${name} too long: ${value.length} chars (max ${MAX_QUERY_CHARS}). Refine the query.`,
  );
}

function buildCalendarNotes(
  matches: Array<{ event: string; term?: string }>,
  fallbackTriggered: boolean,
  term: string | null,
): string {
  const modeNote = "BM25 with synonyms";
  if (matches.length === 0) {
    return `No MSU calendar row matched this query. ${modeNote}. Try a more specific phrasing or check the source calendar directly.`;
  }
  if (fallbackTriggered && term) {
    return `Surfaced academic_calendar rows for ${term} as fallback — if your primary source didn't have this term, the academic calendar is authoritative for term-boundary dates. ${modeNote}.`;
  }
  const byStem = new Map<string, Set<string>>();
  for (const m of matches) {
    const firstWord = m.event.split(/\s+/).filter((w) => !/^(the|a|an|of|for|to|in|on|at)$/i.test(w))[0] ?? m.event;
    const stem = firstWord.toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, new Set());
    if (m.term) byStem.get(stem)!.add(m.term);
  }
  const multiYearStems = [...byStem.entries()].filter(([, terms]) => terms.size >= 2);
  if (multiYearStems.length > 0) {
    const [stem, terms] = multiYearStems[0];
    return `Multi-year matches: '${stem}' appears in ${terms.size} distinct terms (${[...terms].join(", ")}). Present each year-version separately. ${modeNote}.`;
  }
  return modeNote;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResponse> {
  switch (name) {
    case "search_policies": {
      const query = String(args.query ?? "");
      if (query.length > MAX_QUERY_CHARS) return tooLong("query", query);
      const limit = Math.min(Math.max(1, Number(args.limit ?? 10)), 50);
      const hits = bm25Search(query, limit);
      const results = hits.map((h) => ({
        number: h.policy.number,
        title: h.policy.title,
        url: h.policy.landingUrl,
        snippet: snippetFor(h.policy.text, query),
        score: Number(h.score.toFixed(4)),
      }));
      return jsonContent({ query, results });
    }

    case "get_policy": {
      const number = args.number ? String(args.number) : undefined;
      const url = args.url ? String(args.url) : undefined;
      const p = findPolicy(number, url);
      if (!p) {
        return errorContent(`Policy ${number ?? url ?? "(no key)"} not found in corpus`);
      }
      return jsonContent({
        number: p.number,
        slug: p.slug,
        title: p.title,
        landingUrl: p.landingUrl,
        pdfUrl: p.pdfUrl,
        text: p.text,
        retrievedAt: corpus.builtAt,
        effectiveDate: p.effectiveDate,
        reviewedDate: p.reviewedDate,
        lastRevisedDate: p.lastRevisedDate,
        responsibleOffice: p.responsibleOffice,
        approvedBy: p.approvedBy,
      });
    }

    case "chain_find_relevant_policies": {
      const question = String(args.question ?? "");
      if (question.length > MAX_QUERY_CHARS) return tooLong("question", question);
      const k = Math.min(Math.max(1, Number(args.k ?? 2)), 5);
      const hits = bm25Search(question, k);
      if (hits.length === 0) {
        return jsonContent({
          question,
          results: [],
          note: "No policies matched this question. Recommend contacting the responsible MSU office.",
        });
      }
      const results = hits.map((h) => ({
        number: h.policy.number,
        title: h.policy.title,
        url: h.policy.landingUrl,
        pdfUrl: h.policy.pdfUrl,
        effectiveDate: h.policy.effectiveDate,
        lastRevisedDate: h.policy.lastRevisedDate,
        responsibleOffice: h.policy.responsibleOffice,
        retrievedAt: corpus.builtAt,
        text: h.policy.text,
      }));
      return jsonContent({ question, k, results });
    }

    case "cite_policy": {
      const number = String(args.number ?? "");
      const style = args.style === "full" ? "full" : "short";
      const p = findPolicy(number);
      if (!p) return errorContent(`Policy ${number} not found in corpus`);
      const today = new Date().toISOString().slice(0, 10);
      const cite =
        style === "full"
          ? `Mississippi State University Operating Policy ${p.number}, "${p.title}"${p.effectiveDate ? `, effective ${p.effectiveDate}` : ""}. Retrieved from ${p.landingUrl} on ${today}.`
          : `OP ${p.number} (${p.title})`;
      return { content: [{ type: "text", text: cite }] };
    }

    case "find_msu_date": {
      const q = String(args.q ?? "");
      if (q.length === 0) return errorContent("q is required.");
      if (q.length > MAX_QUERY_CHARS) return tooLong("q", q);
      const hits = bm25SearchCalendars(q, 10);
      const matches: Array<CalendarRow & { score?: number }> = hits.map((h) => ({
        ...h.row,
        score: Number(h.score.toFixed(6)),
      }));

      // Smart fallback path (parity with stdio server).
      const term = matchTerm(q);
      let fallbackTriggered = false;
      if (term) {
        const nonAcademicForTerm = matches.filter(
          (m) => m.source !== "academic_calendar" && m.term === term,
        ).length;
        const hasNonAcademicResults = matches.some(
          (m) => m.source !== "academic_calendar",
        );
        if (nonAcademicForTerm === 0 && hasNonAcademicResults) {
          // Tag existing academic rows for this term as fallback.
          const academicForTerm = matches.filter(
            (m) => m.source === "academic_calendar" && m.term === term,
          );
          for (const m of academicForTerm) {
            m.fallback = true;
            fallbackTriggered = true;
          }
          // Append additional academic_calendar rows not already in matches.
          const matchedUrls = new Set(academicForTerm.map((m) => m.source_url));
          const extras = CAL_ROWS.filter(
            (r) => r.source === "academic_calendar"
              && r.term === term
              && !matchedUrls.has(r.source_url),
          );
          const sorted = sortByEventPriority(extras as CalendarRow[]).slice(
            0,
            Math.max(0, 3 - academicForTerm.length),
          );
          for (const e of sorted) {
            matches.push({ ...e, fallback: true });
            fallbackTriggered = true;
          }
        }
      }

      // Strip contentHash from the wire response: it's a build-time
      // dedup/cache key, never useful to clients, and not worth the bytes.
      const wireMatches = matches.map(({ contentHash: _omit, ...rest }) => rest);

      return jsonContent({
        q,
        matches: wireMatches,
        notes: buildCalendarNotes(wireMatches, fallbackTriggered, term),
        corpus_built_at: CAL_BUILT_AT,
      });
    }

    case "get_msu_calendar": {
      const source = String(args.source ?? "");
      if (!CAL_SOURCES.includes(source as (typeof CAL_SOURCES)[number])) {
        return errorContent(
          `Unknown source: ${source}. Must be one of: ${CAL_SOURCES.join(", ")}.`,
        );
      }
      const term = args.term ? String(args.term).toLowerCase() : null;
      if (term && term.length > 64) return errorContent("term filter too long (max 64 chars).");
      const rows = CAL_ROWS.filter((r) => r.source === source).filter(
        (r) => !term || (r.term ?? "").toLowerCase().includes(term),
      );
      const sourceUrl = rows[0]?.source_url ?? "";
      return jsonContent({
        source,
        term: args.term ?? null,
        rows,
        source_url: sourceUrl,
        corpus_built_at: CAL_BUILT_AT,
      });
    }

    case "search_msu_courses": {
      const q = String(args.q ?? "");
      if (q.length === 0) return errorContent("q is required.");
      if (q.length > MAX_QUERY_CHARS) return tooLong("q", q);
      const limit = Math.min(Math.max(1, Number(args.limit ?? 10)), 50);
      const hits = searchCourses(q, limit);
      const matches = hits.map((h) => ({
        code: h.course.code,
        title: h.course.title,
        hours: h.course.hours,
        dept: h.course.code.split(/\s+/)[0],
        level: h.course.level,
        score: h.score,
      }));
      return jsonContent({ matches, notes: [] as string[] });
    }

    case "get_msu_course": {
      const raw = String(args.code ?? "");
      if (raw.length === 0) return errorContent("code is required.");
      if (raw.length > MAX_QUERY_CHARS) return tooLong("code", raw);
      const normalized = isCourseCodeValid(raw);
      if (!normalized) return errorContent("invalid_course_code");
      const course = getCourse(normalized);
      if (course) return jsonContent({ found: true, course });
      const suggestions = searchCourses(normalized, 3).map((h) => ({
        code: h.course.code,
        title: h.course.title,
      }));
      return jsonContent({ found: false, code: normalized, suggestions });
    }

    case "get_msu_course_graph": {
      const raw = String(args.code ?? "");
      if (raw.length === 0) return errorContent("code is required.");
      if (raw.length > MAX_QUERY_CHARS) return tooLong("code", raw);
      const normalized = isCourseCodeValid(raw);
      if (!normalized) return errorContent("invalid_course_code");
      const direction = args.direction === "unlocks" ? "unlocks" : "prereqs";
      const depthRaw = args.depth;
      const depth = depthRaw === undefined || depthRaw === null ? undefined : Number(depthRaw);
      if (!COURSES) return errorContent("course_corpus_not_loaded");
      const g = walkGraph(normalized, direction, depth);
      return jsonContent(g);
    }

    case "get_msu_emergency_guideline": {
      const raw = String(args.emergency_type ?? "");
      if (raw.length === 0) return errorContent("emergency_type is required.");
      if (raw.length > MAX_QUERY_CHARS) return tooLong("emergency_type", raw);
      const r = resolveEmergencyGuideline(raw);
      const contactsQuick: { label: string; phone: string }[] = [];
      const e911 = EMERGENCY?.contacts.find((c) => c.phone === "911");
      const pd = EMERGENCY?.contacts.find(
        (c) => /police/i.test(c.label) && c.category === "campus_non_emergency",
      );
      if (e911) contactsQuick.push({ label: e911.label, phone: e911.phone });
      if (pd) contactsQuick.push({ label: pd.label, phone: pd.phone });
      if (r.matched) {
        return jsonContent({
          disclaimer: MANDATORY_DISCLAIMER,
          matched: {
            slug: r.matched.slug,
            title: r.matched.title,
            url: r.matched.url,
            body_markdown: r.matched.body_markdown,
            retrieved_at: r.matched.retrieved_at,
          },
          did_you_mean: r.did_you_mean.map((g) => ({ slug: g.slug, title: g.title })),
          contacts_quick: contactsQuick,
        });
      }
      return jsonContent({
        disclaimer: MANDATORY_DISCLAIMER,
        matched: null,
        did_you_mean: [],
        suggestions: (EMERGENCY?.guidelines ?? []).map((g) => ({ slug: g.slug, title: g.title })),
        contacts_quick: contactsQuick,
      });
    }

    case "list_msu_emergency_types": {
      return jsonContent({
        disclaimer: MANDATORY_DISCLAIMER,
        types: (EMERGENCY?.guidelines ?? []).map((g) => ({ slug: g.slug, title: g.title, url: g.url })),
      });
    }

    case "find_msu_severe_weather_refuge": {
      const raw = String(args.building_name ?? "");
      if (raw.length === 0) return errorContent("building_name is required.");
      if (raw.length > MAX_QUERY_CHARS) return tooLong("building_name", raw);
      const SCOPE_NOTE =
        "Severe-weather refuge areas only. For fires, evacuate via the nearest exit (see `smoke-fire` / `building-evacuations`). For active threats, see `violence-threats-of-violence`.";
      const FALLBACK_GUIDANCE =
        "If your building isn't listed, the published guidance is: go to the lowest interior level, away from windows, in a small interior room or hallway.";
      const matches = findEmergencyRefuge(raw);
      if (matches.length > 0) {
        return jsonContent({
          disclaimer: MANDATORY_DISCLAIMER,
          scope_note: SCOPE_NOTE,
          matches,
        });
      }
      return jsonContent({
        disclaimer: MANDATORY_DISCLAIMER,
        scope_note: SCOPE_NOTE,
        matches: [],
        fallback_when_no_match: {
          guidance: FALLBACK_GUIDANCE,
          source_url: "https://www.emergency.msstate.edu/refuge",
        },
      });
    }

    case "get_msu_emergency_contacts": {
      const raw = String(args.category ?? "all");
      if (raw.length > MAX_QUERY_CHARS) return tooLong("category", raw);
      const contacts = filterEmergencyContacts(raw).map((c) => ({
        label: c.label,
        phone: c.phone,
        category: c.category,
      }));
      return jsonContent({
        disclaimer: MANDATORY_DISCLAIMER,
        contacts,
        source_url: "https://www.emergency.msstate.edu/refuge",
      });
    }

    case "get_msu_tuition_rate": {
      const a = args as Record<string, unknown>;
      const campus = String(a.campus ?? "") as CampusSlug;
      const level  = String(a.level ?? "")  as Level;
      const residency = String(a.residency ?? "") as Residency;
      const term = a.term ? (String(a.term) as TermT) : undefined;
      const credit_hours = typeof a.credit_hours === "number" ? a.credit_hours : undefined;
      const VALID_CAMPUS = ["starkville","meridian","mgccc","online","vetmed"];
      const VALID_LEVEL  = ["undergrad","grad","dvm"];
      const VALID_RES    = ["resident","non_resident"];
      if (!VALID_CAMPUS.includes(campus)) return errorContent("campus must be one of: " + VALID_CAMPUS.join(", "));
      if (!VALID_LEVEL.includes(level))   return errorContent("level must be one of: " + VALID_LEVEL.join(", "));
      if (!VALID_RES.includes(residency)) return errorContent("residency must be one of: " + VALID_RES.join(", "));
      if (typeof credit_hours === "number" && (credit_hours < 1 || credit_hours > 30 || !Number.isInteger(credit_hours))) {
        return errorContent("credit_hours must be an integer between 1 and 30.");
      }
      const r = tuiRouteRate({ campus, level, residency, term, credit_hours });
      return jsonContent({
        disclaimer: TUITION_DISCLAIMER,
        matches: r.matches,
        ...(r.not_found_reason ? { not_found_reason: r.not_found_reason } : {}),
        corpus_built_at: TUITION?.builtAt ?? null,
      });
    }
    case "get_msu_enrollment_fees": {
      const a = args as Record<string, unknown>;
      const kind = String(a.kind ?? "");
      const filter = typeof a.filter === "string" ? a.filter : undefined;
      if (filter !== undefined && filter.length > MAX_QUERY_CHARS) return tooLong("filter", filter);
      if (!["college", "program", "course_distance"].includes(kind)) {
        return errorContent("kind must be one of: college, program, course_distance");
      }
      let rows = (TUITION?.fee_rows ?? []).filter((r) => r.kind === kind);
      if (filter && filter.trim().length > 0) {
        const f = filter.trim().toLowerCase();
        rows = rows.filter((r) => r.label.toLowerCase().includes(f));
      }
      return jsonContent({
        disclaimer: TUITION_DISCLAIMER,
        matches: rows,
        corpus_built_at: TUITION?.builtAt ?? null,
      });
    }
    case "find_msu_tuition_faq": {
      const a = args as Record<string, unknown>;
      const q = String(a.q ?? "");
      if (q.length === 0) return errorContent("q is required.");
      if (q.length > MAX_QUERY_CHARS) return tooLong("q", q);
      const k = typeof a.k === "number" ? a.k : 3;
      if (!Number.isInteger(k) || k < 1 || k > 10) return errorContent("k must be an integer between 1 and 10.");
      const hits = tuiSearchFaq(q, k);
      return jsonContent({
        disclaimer: TUITION_DISCLAIMER,
        matches: hits.map((h) => ({
          question: h.row.question, answer: h.row.answer,
          source_url: h.row.source_url, bm25_score: h.score,
          retrieved_at: h.row.retrieved_at,
        })),
        corpus_built_at: TUITION?.builtAt ?? null,
      });
    }
    case "list_msu_tuition_campuses": {
      return jsonContent({
        disclaimer: TUITION_DISCLAIMER,
        campuses: TUITION?.campuses ?? [],
        corpus_built_at: TUITION?.builtAt ?? null,
      });
    }

    case "list_online_programs": {
      const a = args as Record<string, unknown>;
      const VALID_LEVELS = ["bachelor","master","specialist","doctoral","certificate","endorsement"];
      const level = a.level !== undefined ? String(a.level) : undefined;
      if (level !== undefined && !VALID_LEVELS.includes(level)) {
        return errorContent("level must be one of: " + VALID_LEVELS.join(", "));
      }
      const subject_keyword = typeof a.subject_keyword === "string" ? a.subject_keyword : undefined;
      if (subject_keyword !== undefined && subject_keyword.length > MAX_QUERY_CHARS) return tooLong("subject_keyword", subject_keyword);
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return errorContent("limit must be an integer 1-200.");
      const offset = typeof a.offset === "number" ? a.offset : undefined;
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) return errorContent("offset must be a non-negative integer.");
      const r = onlFilterPrograms({ level: level as DegreeLevel | undefined, subject_keyword, limit, offset });
      return jsonContent({
        disclaimer: ONLINE_DISCLAIMER,
        matches: r.matches,
        total: r.total,
        filtered_total: r.filtered_total,
        corpus_built_at: ONLINE?.builtAt ?? null,
      });
    }
    case "get_online_program": {
      const a = args as Record<string, unknown>;
      const slug = typeof a.slug === "string" ? a.slug : undefined;
      const name_query = typeof a.name_query === "string" ? a.name_query : undefined;
      if ((slug && name_query) || (!slug && !name_query)) {
        return errorContent("Exactly one of slug or name_query is required.");
      }
      if (slug && slug.length > MAX_QUERY_CHARS) return tooLong("slug", slug);
      if (name_query && name_query.length > MAX_QUERY_CHARS) return tooLong("name_query", name_query);
      let matched: OnlineProgram | null = null;
      let did_you_mean: Array<{ slug: string; name: string }> = [];
      let not_found_reason: string | null = null;
      if (slug) {
        matched = (ONLINE?.programs ?? []).find((p) => p.slug === slug) ?? null;
        if (!matched) not_found_reason = `No program with slug '${slug}'. Try list_online_programs to see valid slugs.`;
      } else if (name_query) {
        const r = onlFuzzyResolveProgram(name_query);
        matched = r.matched;
        did_you_mean = r.did_you_mean;
        if (!matched) not_found_reason = `No program matched '${name_query}'. Try list_online_programs(subject_keyword=…).`;
      }
      return jsonContent({
        disclaimer: ONLINE_DISCLAIMER,
        matched,
        did_you_mean,
        not_found_reason,
        corpus_built_at: ONLINE?.builtAt ?? null,
      });
    }
    case "get_online_admissions_process": {
      const a = args as Record<string, unknown>;
      const VALID_TYPES = ["undergraduate","graduate","transfer","readmit","international"];
      const student_type = a.student_type !== undefined ? String(a.student_type) : undefined;
      if (student_type !== undefined && !VALID_TYPES.includes(student_type)) {
        return errorContent("student_type must be one of: " + VALID_TYPES.join(", "));
      }
      const ap = ONLINE?.admissions_process;
      if (!ap) {
        return jsonContent({
          disclaimer: ONLINE_DISCLAIMER,
          shared_prelude: "",
          sections: {},
          central_contact: { name: "", title: "", email: null, phone: null },
          application_fee_tiers: [],
          external_apply_urls: [],
          source_url: "https://www.online.msstate.edu/admissions-process",
          not_found_reason: "Online admissions process is not loaded in the corpus.",
          corpus_built_at: ONLINE?.builtAt ?? null,
        });
      }
      const sections = student_type ? { [student_type]: ap.sections[student_type as StudentType] } : ap.sections;
      return jsonContent({
        disclaimer: ONLINE_DISCLAIMER,
        shared_prelude: ap.shared_prelude,
        sections,
        central_contact: ap.central_contact,
        application_fee_tiers: ap.application_fee_tiers,
        external_apply_urls: ap.external_apply_urls,
        source_url: ap.url,
        corpus_built_at: ONLINE?.builtAt ?? null,
      });
    }
    case "find_online_info": {
      const a = args as Record<string, unknown>;
      const q = String(a.q ?? "");
      if (q.length === 0) return errorContent("q is required.");
      if (q.length > MAX_QUERY_CHARS) return tooLong("q", q);
      const k = typeof a.k === "number" ? a.k : 3;
      if (!Number.isInteger(k) || k < 1 || k > 10) return errorContent("k must be an integer 1-10.");
      const VALID_SCOPES = ["all","state-authorization","military-assistance","orientation","faq","financial-matters","staff"];
      const scope = a.scope !== undefined ? String(a.scope) : "all";
      if (!VALID_SCOPES.includes(scope)) return errorContent("scope must be one of: " + VALID_SCOPES.join(", "));
      const hits = onlSearchInfo(q, k, scope as OnlineScope);
      const matches = hits.map((h) => ({
        slug: h.row.slug,
        title: h.row.title,
        excerpt: h.row.body_markdown.length <= 300 ? h.row.body_markdown : h.row.body_markdown.slice(0, 300) + "…",
        full_body: h.row.body_markdown,
        source_url: h.row.url,
        bm25_score: h.score,
      }));
      return jsonContent({
        disclaimer: ONLINE_DISCLAIMER,
        matches,
        corpus_built_at: ONLINE?.builtAt ?? null,
      });
    }

    case "health_check": {
      return jsonContent({
        runtime: "cloudflare-workers",
        version: "0.9.0",
        index_row_count: corpus.indexRowCount,
        policies_in_corpus: POLICIES.length,
        corpus_built_at: corpus.builtAt,
        corpus_source: corpus.source,
        bm25_corpus_stats: { N, avg_doc_length: Math.round(avgLen) },
        calendars_row_count: CAL_ROWS.length,
        calendars_built_at: CAL_BUILT_AT,
        calendars_per_source: CAL_PER_SOURCE,
        courses_in_corpus: COURSES ? Object.keys(COURSES.records).length : 0,
        courses_scraped_at: COURSES?.scraped_at ?? null,
        emergency_guideline_count: EMERGENCY?.guidelines.length ?? 0,
        emergency_refuge_count: EMERGENCY?.refuge_areas.length ?? 0,
        emergency_contact_count: EMERGENCY?.contacts.length ?? 0,
        emergency_built_at: EMERGENCY?.builtAt ?? null,
        tuition_rate_count: TUITION?.rate_rows.length ?? 0,
        tuition_fee_count: TUITION?.fee_rows.length ?? 0,
        tuition_faq_count: TUITION?.faq_rows.length ?? 0,
        tuition_campus_count: TUITION?.campuses.length ?? 0,
        online_program_count: ONLINE?.programs.length ?? 0,
        online_info_page_count: ONLINE?.info_pages.length ?? 0,
        online_staff_count: ONLINE?.staff.length ?? 0,
        courses_parse_quality: coursesParseQualityWorker(),
        note: "This is the Cloudflare Workers variant. Corpus is a pre-extracted snapshot; rebuild via scripts/build-worker-corpus.mjs to refresh.",
      });
    }

    default:
      return errorContent(`Unknown tool: ${name}`);
  }
}

// ---- JSON-RPC over HTTP -----------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Server-provided routing + anti-hallucination guidance, surfaced to the
 * model via MCP's InitializeResult.instructions field. KEEP IN SYNC with
 * the same constant in msstate-policies/src/index.ts (single source of
 * truth is documented there).
 */
const SERVER_INSTRUCTIONS = `You answer questions about Mississippi State University using the msstate-policies MCP server, which covers MSU Operating Policies, six academic-date calendars (registrar, exams, holidays, grad school, financial aid, housing), the course catalog, emergency guidance, and tuition.

Routing rules — pick the tool whose CATEGORY matches the question. If your first tool returns nothing useful, try the next-most-likely tool BEFORE giving up:

1. Policy / rule questions ("what's the policy on...", "is X allowed?", "what's the rule for...") → chain_find_relevant_policies with k=5.
2. Date / deadline / holiday / closure / break / exam-schedule questions ("when is...", "what days off", "spring break", "staff holidays", "fall 2026 exams") → find_msu_date. Use get_msu_calendar with source="university_holidays" for the full holiday list. If the user does NOT specify a year, present ALL year-versions returned.
3. Course questions ("what's the prereq for...", "what does X unlock?", "find a class about Y") → search_msu_courses, get_msu_course, get_msu_course_graph.
4. Emergency / safety questions (tornado, fire, active shooter, refuge area, MSU PD) → get_msu_emergency_guideline, find_msu_severe_weather_refuge, get_msu_emergency_contacts. For life-threatening situations, ALWAYS lead with "Call 911 now."
5. Tuition / fee / cost questions ("how much is tuition", "college fees", "DVM cost") → get_msu_tuition_rate (structured: campus + level + residency), get_msu_enrollment_fees, find_msu_tuition_faq, list_msu_tuition_campuses.
6. Online-program / online-admissions / online-student-services questions ("does MSU have an online MBA?", "how do I apply to MSU online?", "who's the advisor for the online psychology program?", "what's the application deadline for the online MS in Cybersecurity?", "does MSU online operate in my state?", "military assistance for MSU online") → list_online_programs / get_online_program / get_online_admissions_process / find_online_info, picked by question shape. Distinction from policies/courses/tuition: the online module covers MSU's ONLINE program offerings via online.msstate.edu — distinct from the broader policy/course/tuition corpus. Online-specific tuition rates from controller.msstate.edu stay under get_msu_tuition_rate.

Anti-hallucination rules — load-bearing:
- Use ONLY data returned by the tools. Never substitute training-data knowledge of "what universities usually have" for actual tool results.
- Quote dates, policy text, fee amounts, and emergency guidance VERBATIM from the tool result. Always include the source URL or pre-formatted citation field returned by the tool.
- If the question is not about MSU, or no tool returns a useful result after a reasonable attempt, say so plainly. Do NOT invent dates, dollar amounts, holiday lists, or policy text.
- If your first tool guess returns an empty/unhelpful result, try the next-most-likely tool before falling back to general knowledge.`;

function coursesParseQualityWorker(): {
  total_records: number;
  with_prose: number;
  fully_parsed: number;
  with_warnings: number;
  warning_breakdown: Record<string, number>;
} {
  const records = (corpusData as {
    courses?: {
      records?: Record<
        string,
        { prereqs?: { raw_prose: string | null; parse_warnings?: string[] } | null }
      >;
    };
  }).courses?.records ?? {};
  let withProse = 0, fullyParsed = 0, withWarnings = 0;
  const breakdown: Record<string, number> = {
    non_course_unparsed: 0,
    grade_signal_present_but_unparsed: 0,
    grade_signal_ambiguous: 0,
    logic_ambiguous: 0,
  };
  for (const rec of Object.values(records)) {
    if (rec.prereqs?.raw_prose) {
      withProse++;
      const ws = rec.prereqs.parse_warnings ?? [];
      if (ws.length === 0) {
        fullyParsed++;
      } else {
        withWarnings++;
        for (const w of ws) if (w in breakdown) breakdown[w]++;
      }
    }
  }
  return {
    total_records: Object.keys(records).length,
    with_prose: withProse,
    fully_parsed: fullyParsed,
    with_warnings: withWarnings,
    warning_breakdown: breakdown,
  };
}

async function handleRpc(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: "msstate-policies", version: "0.9.0" },
          capabilities: { tools: { listChanged: false } },
          instructions: SERVER_INSTRUCTIONS,
        },
      };

    case "notifications/initialized":
    case "notifications/cancelled":
      // Notifications get no response.
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const params = req.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(name, args);
      return { jsonrpc: "2.0", id, result };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // N10: no auth surface exists, so don't advertise Authorization in the
  // allow-list. Re-add only when real auth lands; until then it's a
  // confused-deputy hint to future maintainers.
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---- Worker entry -----------------------------------------------------------

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Friendly root page — useful when someone hits the URL in a browser.
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/info")) {
      return withCors(
        new Response(
          JSON.stringify(
            {
              name: "msstate-policies-mcp",
              version: "0.9.0",
              runtime: "cloudflare-workers",
              policies: POLICIES.length,
              builtAt: corpus.builtAt,
              source: corpus.source,
              endpoints: {
                mcp: "POST /mcp (JSON-RPC 2.0)",
                health: "GET /health",
              },
              repo: "https://github.com/3uLLd0gs/msstate-mcp",
              note: "Unofficial. Verify against the official source at policies.msstate.edu.",
            },
            null,
            2,
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(
        new Response(
          JSON.stringify(
            {
              status: "ok",
              policies: POLICIES.length,
              builtAt: corpus.builtAt,
            },
            null,
            2,
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // MCP JSON-RPC endpoint.
    if (request.method === "POST" && url.pathname === "/mcp") {
      // N4: reject oversize bodies BEFORE request.json() runs. MAX_QUERY_CHARS
      // (4096) only fires on tool args after parse; without this gate, a 50MB
      // JSON body whose query field is small still costs us full JSON-parse
      // CPU. 64 KB is more than 10x the largest legitimate JSON-RPC envelope
      // we ever produce.
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (contentLength > 64_000) {
        return withCors(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Request too large." },
            }),
            { status: 413, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      let body: JsonRpcRequest;
      try {
        body = (await request.json()) as JsonRpcRequest;
      } catch (err) {
        // Don't echo (err as Error).message to the client — a malformed body's
        // exception text could leak parser internals or mirror attacker input
        // back into a response. Log server-side via the platform's runtime
        // logs and return a generic JSON-RPC parse error.
        console.error("MCP parse error", { name: (err as Error)?.name });
        return withCors(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error. Body must be valid JSON-RPC 2.0." },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      try {
        const response = await handleRpc(body);
        if (response === null) {
          return withCors(new Response(null, { status: 202 }));
        }
        return withCors(
          new Response(JSON.stringify(response), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      } catch (err) {
        // Don't echo (err as Error).message to the client — could leak
        // internal paths, stack frames, or partially-evaluated state. Log
        // server-side via the platform's runtime logs and return a
        // generic message with the request id for correlation.
        //
        // N5: log only structured fields, not the bare `err` — passing the
        // Error object lets CF Workers Logs auto-serialize err.stack, which
        // leaks internal paths to anyone with dashboard access.
        console.error("MCP handler error", {
          method: body.method,
          name: (err as Error)?.name,
          message: (err as Error)?.message,
        });
        return withCors(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? null,
              error: {
                code: -32603,
                message: "Internal server error. The request id is in `id`.",
              },
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
    }

    return withCors(new Response("Not found. POST /mcp for the MCP endpoint.", { status: 404 }));
  },
};
