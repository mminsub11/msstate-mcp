#!/usr/bin/env node
/**
 * Eval harness with optional LLM-judge stage.
 *
 *   node ../scripts/run-eval.mjs            # uses each question's own k (default 2)
 *   node ../scripts/run-eval.mjs --k 3      # force k=3 for all questions
 *   node ../scripts/run-eval.mjs --limit 5  # only run first 5 questions (for cost-debug)
 *   node ../scripts/run-eval.mjs --no-judge # skip the LLM-judge stage even with API key
 *
 * Sub-metrics:
 *   1. Retrieval correctness — deterministic. Did chain return any expected OP?
 *   2. Answer correctness    — LLM-judge. Given retrieved policies, does Claude
 *      produce a properly-grounded answer that cites the expected OP?
 *   3. Refusal correctness   — LLM-judge. For negative questions, does Claude
 *      refuse without fabricating an OP citation?
 *
 * Output: msstate-policies/eval/eval-YYYY-MM-DD-k{N}.json
 *
 * Cost guardrails: caps per-call input via policy-text truncation, output at
 * 600 tokens. Tracks cumulative usage and aborts if combined > $4 (safety
 * margin under $5).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const overrideK = arg("k", null) ? Number(arg("k")) : null;
const limit = arg("limit", null) ? Number(arg("limit")) : null;
const noJudge = arg("no-judge", false) === true;
const suite = arg("suite", "policies");
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const evalDir = resolve(root, "msstate-policies", "eval");
const questionsPath = resolve(evalDir, "questions.jsonl");
const distPath = resolve(root, "msstate-policies", "dist", "index.js");

if (!existsSync(distPath)) {
  console.error(`run-eval: ${distPath} not found — run \`npm run build\` first`);
  process.exit(1);
}

// ---- courses suite (no LLM judge — deterministic containment checks) -----
if (suite === "courses") {
  const { spawn: spawnCourses } = await import("node:child_process");
  const coursesPath = resolve(root, "evals", "courses.jsonl");
  if (!existsSync(coursesPath)) {
    console.error(`run-eval: ${coursesPath} not found`);
    process.exit(1);
  }
  const rows = readFileSync(coursesPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l) => JSON.parse(l));

  class CourseMcp {
    constructor() {
      this.proc = spawnCourses("node", [distPath], { stdio: ["pipe", "pipe", "inherit"] });
      this.buf = "";
      this.pending = new Map();
      this.nextId = 1;
      this.proc.stdout.on("data", (chunk) => {
        this.buf += chunk.toString();
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id && this.pending.has(msg.id)) {
              const { r, j } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) j(new Error(msg.error.message ?? "MCP error"));
              else r(msg.result);
            }
          } catch { /* ignore */ }
        }
      });
    }
    call(method, params) {
      const id = this.nextId++;
      return new Promise((r, j) => {
        this.pending.set(id, { r, j });
        this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
    async init() {
      await this.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "run-eval-courses", version: "0.1.0" },
      });
    }
    callTool(name, args) {
      return this.call("tools/call", { name, arguments: args });
    }
    close() { this.proc.kill(); }
  }

  const mcp = new CourseMcp();
  await mcp.init();
  const out = { course_explain: { pass: 0, fail: 0 }, prereq_chain: { pass: 0, fail: 0 }, unlocks: { pass: 0, fail: 0 } };
  const failures = [];
  for (const row of rows) {
    let ok = false;
    let detail = "";
    try {
      if (row.type === "course_explain") {
        const res = await mcp.callTool("search_msu_courses", { q: row.q, limit: 10 });
        const parsed = JSON.parse(res.content[0].text);
        const codes = (parsed.matches ?? []).map((m) => m.code);
        ok = (row.expected_codes ?? []).some((c) => codes.includes(c));
        detail = `got [${codes.slice(0, 5).join(", ")}]`;
      } else if (row.type === "prereq_chain" || row.type === "unlocks") {
        const m = /\b([A-Z]{2,4})\s*(\d{4})\b/.exec((row.root ?? row.q).toUpperCase());
        if (!m) {
          detail = "no root code found in row";
        } else {
          const code = `${m[1]} ${m[2]}`;
          const direction = row.type === "prereq_chain" ? "prereqs" : "unlocks";
          const res = await mcp.callTool("get_msu_course_graph", { code, direction, depth: 10 });
          const parsed = JSON.parse(res.content[0].text);
          const codes = (parsed.nodes ?? []).map((n) => n.code);
          ok = (row.expected_codes_subset ?? []).every((c) => codes.includes(c));
          detail = `got [${codes.slice(0, 8).join(", ")}]`;
        }
      }
    } catch (err) {
      detail = `error: ${err.message}`;
    }
    out[row.type][ok ? "pass" : "fail"] += 1;
    if (!ok) failures.push({ type: row.type, q: row.q, detail });
  }
  mcp.close();

  const total = (t) => out[t].pass + out[t].fail;
  const rate = (t) => total(t) ? (out[t].pass / total(t)) : 1;
  const summary = {
    suite: "courses",
    counts: {
      course_explain: out.course_explain,
      prereq_chain: out.prereq_chain,
      unlocks: out.unlocks,
    },
    rates: {
      course_explain: Number(rate("course_explain").toFixed(3)),
      prereq_chain: Number(rate("prereq_chain").toFixed(3)),
      unlocks: Number(rate("unlocks").toFixed(3)),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  for (const f of failures.slice(0, 20)) console.error("FAIL", f.type, "|", f.q, "→", f.detail);

  // Thresholds per spec §1.
  const thresholds = { course_explain: 0.9, prereq_chain: 0.95, unlocks: 0.95 };
  let pass = true;
  for (const k of Object.keys(thresholds)) {
    if (total(k) > 0 && rate(k) < thresholds[k]) pass = false;
  }
  process.exit(pass ? 0 : 1);
}

// ---- emergency suite (no LLM judge — deterministic per-kind assertions) ---
if (suite === "emergency") {
  const { spawn: spawnEmg } = await import("node:child_process");
  const emergencyPath = resolve(evalDir, "emergency.jsonl");
  if (!existsSync(emergencyPath)) {
    console.error(`run-eval: ${emergencyPath} not found`);
    process.exit(1);
  }
  const rows = readFileSync(emergencyPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l) => JSON.parse(l));

  const MANDATORY_DISCLAIMER =
    "If this is a life-threatening emergency, call 911 now (or MSU PD at 662-325-2121).";

  class EmgMcp {
    constructor() {
      this.proc = spawnEmg("node", [distPath], { stdio: ["pipe", "pipe", "inherit"] });
      this.buf = "";
      this.pending = new Map();
      this.nextId = 1;
      this.proc.stdout.on("data", (chunk) => {
        this.buf += chunk.toString();
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id && this.pending.has(msg.id)) {
              const { r, j } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) j(new Error(msg.error.message ?? "MCP error"));
              else r(msg.result);
            }
          } catch { /* ignore */ }
        }
      });
    }
    call(method, params) {
      const id = this.nextId++;
      return new Promise((r, j) => {
        this.pending.set(id, { r, j });
        this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
    async init() {
      await this.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "run-eval-emergency", version: "0.1.0" },
      });
    }
    callTool(name, args) {
      return this.call("tools/call", { name, arguments: args });
    }
    close() { this.proc.kill(); }
  }

  const mcp = new EmgMcp();
  await mcp.init();
  let pass = 0;
  const failures = [];
  for (const q of rows) {
    let res;
    try {
      if (q.kind === "right_answer" || q.kind === "alias" || q.kind === "refusal") {
        res = await mcp.callTool("get_msu_emergency_guideline", { emergency_type: q.q });
      } else if (q.kind === "refuge_exact" || q.kind === "refuge_fuzzy" || q.kind === "refuge_no_match") {
        res = await mcp.callTool("find_msu_severe_weather_refuge", { building_name: q.q });
      } else if (q.kind === "contacts") {
        res = await mcp.callTool("get_msu_emergency_contacts", { category: "all" });
      } else {
        failures.push({ q, parsed: `unknown kind: ${q.kind}` });
        continue;
      }
    } catch (err) {
      failures.push({ q, parsed: `error: ${err.message}` });
      continue;
    }
    const text = res?.content?.[0]?.text ?? "";
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    let ok = false;
    if (q.kind === "right_answer" || q.kind === "alias") {
      ok = parsed?.matched?.slug === q.expected_slug;
    } else if (q.kind === "refusal") {
      const prefixOk = text.includes(`"disclaimer": ${JSON.stringify(MANDATORY_DISCLAIMER)}`);
      const slugOk = parsed?.matched?.slug === q.expected_slug;
      ok = prefixOk && slugOk;
    } else if (q.kind === "refuge_exact" || q.kind === "refuge_fuzzy") {
      ok = (parsed?.matches?.[0]?.building ?? "").includes(q.expected_building_contains);
    } else if (q.kind === "refuge_no_match") {
      ok = Array.isArray(parsed?.matches) && parsed.matches.length === 0
        && typeof parsed?.fallback_when_no_match?.guidance === "string"
        && parsed.fallback_when_no_match.guidance.length > 0;
    } else if (q.kind === "contacts") {
      ok = !!parsed?.contacts?.find((c) =>
        c.label?.includes(q.expected_label_contains) && c.phone === q.expected_phone);
    }
    if (ok) pass++;
    else failures.push({ q, parsed: parsed ?? text.slice(0, 200) });
  }
  mcp.close();
  console.log(`emergency eval: ${pass}/${rows.length} passed`);
  for (const f of failures.slice(0, 20)) console.error("FAIL", JSON.stringify(f.q), "got", JSON.stringify(f.parsed).slice(0, 200));
  // Gate at 23/25 per spec §5.
  process.exit(pass >= 23 ? 0 : 1);
}

const allQuestions = readFileSync(questionsPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("//"))
  .map((l) => JSON.parse(l));

const questions = limit ? allQuestions.slice(0, limit) : allQuestions;

const useJudge = !noJudge && !!process.env.ANTHROPIC_API_KEY;
const MODELS = {
  "haiku-4-5": { id: "claude-haiku-4-5-20251001", in: 1.0, out: 5.0 },
  "sonnet-4-6": { id: "claude-sonnet-4-6", in: 3.0, out: 15.0 },
  "opus-4-7": { id: "claude-opus-4-7", in: 15.0, out: 75.0 },
};
const modelKey = arg("model", "haiku-4-5");
if (!MODELS[modelKey]) {
  console.error(`run-eval: unknown --model "${modelKey}"; choose one of ${Object.keys(MODELS).join(", ")}`);
  process.exit(1);
}
const JUDGE_MODEL = MODELS[modelKey].id;
const JUDGE_INPUT_PRICE_PER_M = MODELS[modelKey].in;
const JUDGE_OUTPUT_PRICE_PER_M = MODELS[modelKey].out;
const HARD_BUDGET_USD = 4.0;
const POLICY_TEXT_CHAR_CAP = 3000;

// ---- OpenAI answering model (optional) -----------------------------------
const openaiModel = arg("openai-model", null);
const WORKER_URL = "https://msstate-policies-mcp.mminsub90.workers.dev/mcp";
let openaiClient = null;
if (openaiModel && openaiModel !== true) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("run-eval: --openai-model set but OPENAI_API_KEY missing");
    process.exit(1);
  }
  const { default: OpenAI } = await import("openai");
  openaiClient = new OpenAI();
  console.error(`run-eval: OpenAI answering branch enabled (model=${openaiModel})`);
}

console.error(
  `run-eval: ${questions.length} questions, k=${overrideK ?? "per-question"}, judge=${useJudge ? "on" : "off"}`,
);

// ---- MCP client ----------------------------------------------------------
class McpClient {
  constructor() {
    this.proc = spawn("node", [distPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env },
    });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: rr, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message ?? "MCP error"));
            else rr(msg.result);
          }
        } catch {
          /* ignore */
        }
      }
    });
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((rr, rej) => {
      this.pending.set(id, { resolve: rr, reject: rej });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async init() {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "run-eval", version: "0.1.0" },
    });
  }
  close() {
    this.proc.kill();
  }
}

function fabricatedOp(text) {
  return text.match(/\b\d{2}\.(?:\d{2}|\d{3})\b/g) || [];
}

// ---- Anthropic judge -----------------------------------------------------
const SYSTEM_PROMPT = `You are answering a question about Mississippi State University Operating Policies.

RULES:
1. Use ONLY the policy text provided below. Do not draw on outside knowledge.
2. For any normative claim ("the policy says X", deadlines, eligibility, exceptions), QUOTE VERBATIM from the policy text in quotation marks and cite the OP number (e.g. "OP 91.100").
3. If the provided policies don't clearly answer the question, refuse plainly. Do NOT fabricate citations.
4. Respond with two parts in this exact order:

ANSWER: <your answer to the user, following rules 1-3>

ASSESSMENT: <a single line of compact JSON, no surrounding text or markdown>
{"cited_op_numbers":["NN.NN", ...], "refused": true|false, "quoted_verbatim": true|false}`;

// Judge-only prompt: used when the answer was produced by another model
// (e.g. GPT-4o via OpenAI Responses API + MCP). Sonnet doesn't re-answer; it
// only assesses the supplied answer against the supplied policies.
const JUDGE_ONLY_PROMPT = `You are evaluating whether an AI-generated answer about Mississippi State University Operating Policies is correctly grounded in the provided policy text.

Output a single line of compact JSON, no surrounding text or markdown:
{"cited_op_numbers":["NN.NN", ...], "refused": true|false, "quoted_verbatim": true|false}

Where:
- cited_op_numbers: OP numbers explicitly cited in the answer (strings like "91.208").
- refused: true if the answer declines to answer (e.g. "no policy applies", "outside scope").
- quoted_verbatim: true if the answer contains direct quoted text from the provided policies.`;

let totalInputTokens = 0;
let totalOutputTokens = 0;
function currentSpend() {
  return (
    (totalInputTokens / 1_000_000) * JUDGE_INPUT_PRICE_PER_M +
    (totalOutputTokens / 1_000_000) * JUDGE_OUTPUT_PRICE_PER_M
  );
}

async function callAnthropic(question, policies) {
  const policyBlocks = policies
    .map(
      (p, i) =>
        `--- Policy ${i + 1} (OP ${p.number}: ${p.title}) ---\n${(p.text || "").slice(0, POLICY_TEXT_CHAR_CAP)}`,
    )
    .join("\n\n");
  const userPrompt = `Question: ${question}\n\nRetrieved policies:\n\n${policyBlocks}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const json = await res.json();
  totalInputTokens += json.usage?.input_tokens ?? 0;
  totalOutputTokens += json.usage?.output_tokens ?? 0;
  const text = (json.content?.[0]?.text || "").trim();
  return { text, usage: json.usage };
}

// ---- OpenAI answerer (uses Responses API + MCP tool pointed at Worker) ---
// `instructions` mirrors the steering the Anthropic eval branch gets implicitly
// (k=5 from the eval harness; refusal discipline from chain_find_relevant_policies'
// own description). Without it, gpt-4o defaults the chain tool's k to its
// schema default (2) — making OpenAI runs unfairly retrieval-starved vs. the
// Sonnet baseline at k=5 — and treats off-topic questions conversationally
// instead of refusing.
const OPENAI_INSTRUCTIONS = `You answer questions about Mississippi State University Operating Policies using the msstate-policies MCP server.

Rules:
1. When calling chain_find_relevant_policies, always pass k=5 (the maximum) so the model sees a wider candidate set.
2. If the question is not about MSU policies (e.g., weather, sports scores, news, current events, individuals' personal info), refuse plainly: state that this server only covers Mississippi State University Operating Policies and suggest contacting an appropriate alternative source. Do not invent a policy or speculate.
3. Quote verbatim from policy text and cite the OP number + canonical URL for any normative claim.`;

async function callOpenAIWithMcp(question) {
  const res = await openaiClient.responses.create({
    model: openaiModel,
    instructions: OPENAI_INSTRUCTIONS,
    tools: [
      {
        type: "mcp",
        server_label: "msstate-policies",
        server_url: WORKER_URL,
        require_approval: "never",
      },
    ],
    input: question,
  });
  // Extract: (1) results array from chain_find_relevant_policies, (2) final answer text.
  let returned = [];
  let answerText = "";
  for (const item of res.output ?? []) {
    if (item.type === "mcp_call" && item.name === "chain_find_relevant_policies") {
      try {
        const out = JSON.parse(item.output ?? "{}");
        if (Array.isArray(out.results)) returned = out.results;
      } catch {
        /* ignore */
      }
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") {
          answerText += c.text;
        }
      }
    }
  }
  return { returned, answerText, usage: res.usage };
}

async function judgeOpenAIAnswer(question, policies, answerText) {
  const policyBlocks = policies
    .map(
      (p, i) =>
        `--- Policy ${i + 1} (OP ${p.number}: ${p.title}) ---\n${(p.text || "").slice(0, POLICY_TEXT_CHAR_CAP)}`,
    )
    .join("\n\n");
  const userPrompt = `Question: ${question}\n\nPolicies provided to the answerer:\n\n${policyBlocks}\n\nAnswer to evaluate:\n${answerText}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 250,
      system: JUDGE_ONLY_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const json = await res.json();
  totalInputTokens += json.usage?.input_tokens ?? 0;
  totalOutputTokens += json.usage?.output_tokens ?? 0;
  return (json.content?.[0]?.text || "").trim();
}

function parseAssessment(modelText) {
  const m = modelText.match(/ASSESSMENT:\s*(\{[\s\S]*?\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ---- main ----------------------------------------------------------------
async function main() {
  const client = openaiClient ? null : new McpClient();
  try {
    if (client) await client.init();

    const results = [];
    let aborted = false;
    for (const q of questions) {
      if (currentSpend() > HARD_BUDGET_USD) {
        console.error(`run-eval: budget exceeded ($${currentSpend().toFixed(3)}); aborting`);
        aborted = true;
        break;
      }

      let returned = [];
      let returnedNumbers = [];
      let judgeAnswer = null;
      let assessment = null;
      let answerPass = null;
      let refusalPass = null;
      let usage = null;

      if (openaiClient) {
        // ---- OpenAI answering branch ----
        let oaiResult;
        try {
          oaiResult = await callOpenAIWithMcp(q.q);
        } catch (err) {
          results.push({ q: q.q, retrieval_pass: false, error: err.message });
          continue;
        }
        returned = oaiResult.returned;
        returnedNumbers = returned.map((r) => r.number);
        judgeAnswer = oaiResult.answerText;
        usage = oaiResult.usage;

        if (useJudge) {
          try {
            const assessmentText = await judgeOpenAIAnswer(q.q, returned, oaiResult.answerText);
            const m = assessmentText.match(/\{[\s\S]*\}/);
            if (m) assessment = JSON.parse(m[0]);
          } catch (err) {
            console.error(`run-eval: judge call failed for "${q.q.slice(0, 50)}…": ${err.message}`);
          }
        }
      } else {
        // ---- Anthropic answering branch (unchanged behavior) ----
        const k = overrideK ?? q.k ?? 2;
        let toolResult;
        try {
          toolResult = await client.call("tools/call", {
            name: "chain_find_relevant_policies",
            arguments: { question: q.q, k },
          });
        } catch (err) {
          results.push({ q: q.q, retrieval_pass: false, error: err.message });
          continue;
        }

        const text = toolResult?.content?.[0]?.text ?? "";
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { results: [] };
        }
        returned = parsed.results ?? [];
        returnedNumbers = returned.map((r) => r.number);

        if (useJudge) {
          try {
            const r = await callAnthropic(q.q, returned);
            judgeAnswer = r.text;
            usage = r.usage;
            assessment = parseAssessment(r.text);
          } catch (err) {
            console.error(`run-eval: judge call failed for "${q.q.slice(0, 50)}…": ${err.message}`);
          }
        }
      }

      let retrievalPass = null;
      if (q.expected_op_numbers && q.expected_op_numbers.length > 0) {
        retrievalPass = q.expected_op_numbers.some((op) => returnedNumbers.includes(op));
      }

      if (assessment) {
        const cited = assessment.cited_op_numbers ?? [];
        const refused = !!assessment.refused;
        const groundedOps = new Set(returnedNumbers);
        for (const p of returned) {
          for (const op of fabricatedOp(p.text || "")) groundedOps.add(op);
        }
        const fab = fabricatedOp(judgeAnswer || "").filter((op) => !groundedOps.has(op));

        if (q.negative === true) {
          refusalPass = refused && fab.length === 0;
        } else if (q.expected_op_numbers && q.expected_op_numbers.length > 0) {
          answerPass =
            !refused &&
            q.expected_op_numbers.some((op) => cited.includes(op)) &&
            fab.length === 0;
        }
      }

      results.push({
        q: q.q,
        expected_op_numbers: q.expected_op_numbers ?? null,
        returned_numbers: returnedNumbers,
        retrieval_pass: retrievalPass,
        answer_pass: answerPass,
        refusal_pass: refusalPass,
        judge_answer: judgeAnswer,
        assessment,
        usage,
        notes: q.notes ?? null,
      });

      if (results.length % 5 === 0) {
        console.error(
          `run-eval: ${results.length}/${questions.length} done; spent $${currentSpend().toFixed(3)}`,
        );
      }
    }

    const retrievalScored = results.filter((r) => r.retrieval_pass !== null);
    const answerScored = results.filter((r) => r.answer_pass !== null);
    const refusalScored = results.filter((r) => r.refusal_pass !== null);
    const summary = {
      total: results.length,
      aborted,
      k: overrideK ?? "per-question",
      judge: { used: useJudge, model: useJudge ? JUDGE_MODEL : null },
      retrieval: {
        scored: retrievalScored.length,
        passed: retrievalScored.filter((r) => r.retrieval_pass).length,
      },
      answer: {
        scored: answerScored.length,
        passed: answerScored.filter((r) => r.answer_pass).length,
      },
      refusal: {
        scored: refusalScored.length,
        passed: refusalScored.filter((r) => r.refusal_pass).length,
      },
      cost: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        usd: Number(currentSpend().toFixed(4)),
      },
    };

    mkdirSync(evalDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const kSuffix = overrideK !== null ? `-k${overrideK}` : "";
    const answererSuffix = openaiModel ? `-${openaiModel}` : (useJudge ? `-${modelKey}` : "");
    const outPath = resolve(evalDir, `eval-${date}${kSuffix}${answererSuffix}.json`);
    writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2) + "\n");
    console.error(`run-eval: wrote ${outPath}`);
    console.error(JSON.stringify(summary, null, 2));
  } finally {
    if (client) client.close();
  }
}

main().catch((err) => {
  console.error("run-eval: fatal", err);
  process.exit(1);
});
