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
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const evalDir = resolve(root, "msstate-policies", "eval");
const questionsPath = resolve(evalDir, "questions.jsonl");
const distPath = resolve(root, "msstate-policies", "dist", "index.js");

if (!existsSync(distPath)) {
  console.error(`run-eval: ${distPath} not found — run \`npm run build\` first`);
  process.exit(1);
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
  const client = new McpClient();
  try {
    await client.init();

    const results = [];
    let aborted = false;
    for (const q of questions) {
      if (currentSpend() > HARD_BUDGET_USD) {
        console.error(`run-eval: budget exceeded ($${currentSpend().toFixed(3)}); aborting`);
        aborted = true;
        break;
      }
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
      const returned = parsed.results ?? [];
      const returnedNumbers = returned.map((r) => r.number);

      let retrievalPass = null;
      if (q.expected_op_numbers && q.expected_op_numbers.length > 0) {
        retrievalPass = q.expected_op_numbers.some((op) => returnedNumbers.includes(op));
      }

      let judgeAnswer = null;
      let assessment = null;
      let answerPass = null;
      let refusalPass = null;
      let usage = null;

      if (useJudge) {
        try {
          const r = await callAnthropic(q.q, returned);
          judgeAnswer = r.text;
          usage = r.usage;
          assessment = parseAssessment(r.text);

          if (assessment) {
            const cited = assessment.cited_op_numbers ?? [];
            const refused = !!assessment.refused;
            // Cross-references inside a retrieved policy's body (e.g. OP 12.37
            // saying "see OP 03.03") are legitimate verbatim citations, not
            // fabrications. Allow any OP that appears in the retrieved IDs OR
            // anywhere in the retrieved bodies.
            const groundedOps = new Set(returnedNumbers);
            for (const p of returned) {
              for (const op of fabricatedOp(p.text || "")) groundedOps.add(op);
            }
            const fab = fabricatedOp(r.text).filter((op) => !groundedOps.has(op));

            if (q.negative === true) {
              refusalPass = refused && fab.length === 0;
            } else if (q.expected_op_numbers && q.expected_op_numbers.length > 0) {
              answerPass =
                !refused &&
                q.expected_op_numbers.some((op) => cited.includes(op)) &&
                fab.length === 0;
            }
          }
        } catch (err) {
          console.error(`run-eval: judge call failed for "${q.q.slice(0, 50)}…": ${err.message}`);
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
    const modelSuffix = useJudge ? `-${modelKey}` : "";
    const outPath = resolve(evalDir, `eval-${date}${kSuffix}${modelSuffix}.json`);
    writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2) + "\n");
    console.error(`run-eval: wrote ${outPath}`);
    console.error(JSON.stringify(summary, null, 2));
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("run-eval: fatal", err);
  process.exit(1);
});
