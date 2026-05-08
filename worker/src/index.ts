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

interface Corpus {
  builtAt: string;
  source: string;
  indexRowCount: number;
  policies: Policy[];
}

const corpus = corpusData as Corpus;
const POLICIES: Policy[] = corpus.policies;

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

    case "health_check": {
      return jsonContent({
        runtime: "cloudflare-workers",
        version: "0.2.0",
        index_row_count: corpus.indexRowCount,
        policies_in_corpus: POLICIES.length,
        corpus_built_at: corpus.builtAt,
        corpus_source: corpus.source,
        bm25_corpus_stats: { N, avg_doc_length: Math.round(avgLen) },
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
          serverInfo: { name: "msstate-policies", version: "0.2.0" },
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
              version: "0.2.0",
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
