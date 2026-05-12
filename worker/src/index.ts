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

interface Corpus {
  builtAt: string;
  source: string;
  indexRowCount: number;
  policies: Policy[];
  academic_calendar?: CalendarBlock;
}

const corpus = corpusData as unknown as Corpus;
const POLICIES: Policy[] = corpus.policies;

const CAL_ROWS: CalendarRow[] = corpus.academic_calendar?.rows ?? [];
const CAL_BUILT_AT = corpus.academic_calendar?.built_at ?? corpus.builtAt;
const CAL_PER_SOURCE = corpus.academic_calendar?.per_source ?? {};

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

    case "health_check": {
      return jsonContent({
        runtime: "cloudflare-workers",
        version: "0.4.1",
        index_row_count: corpus.indexRowCount,
        policies_in_corpus: POLICIES.length,
        corpus_built_at: corpus.builtAt,
        corpus_source: corpus.source,
        bm25_corpus_stats: { N, avg_doc_length: Math.round(avgLen) },
        calendars_row_count: CAL_ROWS.length,
        calendars_built_at: CAL_BUILT_AT,
        calendars_per_source: CAL_PER_SOURCE,
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

async function handleRpc(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: "msstate-policies", version: "0.4.1" },
          capabilities: { tools: { listChanged: false } },
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
              version: "0.4.1",
              runtime: "cloudflare-workers",
              policies: POLICIES.length,
              builtAt: corpus.builtAt,
              source: corpus.source,
              endpoints: {
                mcp: "POST /mcp (JSON-RPC 2.0)",
                health: "GET /health",
              },
              repo: "https://github.com/mminsub11/msstate-mcp",
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
