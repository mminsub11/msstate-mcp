# OpenAI API Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the existing msstate-policies MCP Worker is consumable from OpenAI's Responses API, ship Python sample + README docs, and commit a 10-question GPT-4o eval JSON proving cross-model quality. No new server, no new corpus, no auth changes.

**Architecture:** Reuse the deployed Cloudflare Worker (`https://msstate-policies-mcp.mminsub90.workers.dev/mcp`) as-is. Extend the existing `scripts/run-eval.mjs` to support OpenAI as the answering model — when `--openai-model` is set, the harness skips the local stdio MCP client and instead calls OpenAI's Responses API with the MCP tool pointing at the deployed Worker, then judges the resulting answer with Anthropic Sonnet (parity with the existing baseline). Add a Python sample script and a new README section. Bump version 0.2.0 → 0.3.0.

**Tech Stack:** Node.js 20+ (existing harness), OpenAI Node SDK (new dep for the harness), Python 3.9+ (sample script), `openai` PyPI package, the existing Worker (unchanged), Anthropic Sonnet 4.6 as judge.

**Spec reference:** `docs/superpowers/specs/2026-05-08-openai-api-support-design.md`

---

## Task 1: Pre-flight environment check

**Files:** none (verification only)

- [ ] **Step 1: Confirm Node + npm versions**

Run from repo root:
```bash
node --version && npm --version
```
Expected: Node ≥ 18 (20+ preferred), npm ≥ 10.

- [ ] **Step 2: Confirm Python + pip versions**

Run:
```bash
python3 --version && pip3 --version
```
Expected: Python ≥ 3.9.

- [ ] **Step 3: Confirm both API keys are set**

Run:
```bash
test -n "$OPENAI_API_KEY" && echo "OPENAI_API_KEY set" || echo "MISSING OPENAI_API_KEY"
test -n "$ANTHROPIC_API_KEY" && echo "ANTHROPIC_API_KEY set" || echo "MISSING ANTHROPIC_API_KEY"
```
Expected: both set. If `.env` has them, `source .env` first or export them in the shell. **Both** are required: OpenAI for answering, Anthropic for the judge.

- [ ] **Step 4: Confirm Worker is reachable**

Run:
```bash
curl -fsS https://msstate-policies-mcp.mminsub90.workers.dev/health | head -c 200
```
Expected: JSON with `status: "ok"`, `policies: <number>`, `builtAt: <iso>`. If this fails, halt — the Worker is the system under test.

---

## Task 2: Tier 1 protocol verification

A throwaway Python script that proves OpenAI's Responses API can talk to the Worker at all. If this fails, **halt and report** — the project pivots into a different brainstorm.

**Files:**
- Create (temporary, deleted at end of task): `/tmp/oa_tier1.py`

- [ ] **Step 1: Install openai SDK in a temp venv**

Run:
```bash
python3 -m venv /tmp/oa_venv && /tmp/oa_venv/bin/pip install --quiet openai
```
Expected: no errors.

- [ ] **Step 2: Write the Tier 1 verification script**

Create `/tmp/oa_tier1.py`:
```python
import os, sys, json
from openai import OpenAI

client = OpenAI()

WORKER_URL = "https://msstate-policies-mcp.mminsub90.workers.dev/mcp"
QUESTION = "What is MSU's hazing policy?"

resp = client.responses.create(
    model="gpt-4o",
    tools=[{
        "type": "mcp",
        "server_label": "msstate-policies",
        "server_url": WORKER_URL,
        "require_approval": "never",
    }],
    input=QUESTION,
)

# Pretty-print every output item so we can see tool_calls + final message
for i, item in enumerate(resp.output):
    print(f"--- item {i}: type={item.type} ---")
    print(json.dumps(item.model_dump(), indent=2)[:2000])

# Extract final answer text
final_text = ""
for item in resp.output:
    if getattr(item, "type", None) == "message":
        for c in getattr(item, "content", []) or []:
            if getattr(c, "type", None) == "output_text":
                final_text += c.text

print("\n=== FINAL ANSWER ===")
print(final_text)

# Pass criteria
ok_op = "91.208" in final_text
ok_url = "policies.msstate.edu" in final_text
print(f"\n=== TIER 1 CHECK ===")
print(f"contains OP 91.208: {ok_op}")
print(f"contains canonical URL host: {ok_url}")
sys.exit(0 if (ok_op and ok_url) else 1)
```

- [ ] **Step 3: Run it**

Run:
```bash
/tmp/oa_venv/bin/python /tmp/oa_tier1.py
```
Expected: `TIER 1 CHECK` shows both `True`, exit code 0. Script prints the OP 91.208 quote in the final answer.

**If exit code is non-zero:** read the dumped output items. Most likely failure modes from the spec:
- API rejects the MCP server URL → halt, document, escalate to OAuth brainstorm.
- A tool schema is rejected → identify which tool, see Task 3 audit, attempt local fix only if minor.
- Final answer doesn't include OP 91.208 / URL → not strictly a protocol failure; record as a quality issue and continue (Tier 2 will catch it).

- [ ] **Step 4: Clean up the temp script**

Run:
```bash
rm /tmp/oa_tier1.py
rm -rf /tmp/oa_venv
```

- [ ] **Step 5: No commit**

This task produces no committed artifacts. It is the gate that lets the rest of the plan proceed.

---

## Task 3: Tool description / schema audit

Read all 5 tool definitions and confirm they're OpenAI-compatible. The spec expects zero diff — this task documents that.

**Files:**
- Read only: `worker/src/index.ts` (the `TOOLS` array, lines 174-246)
- Read only: `msstate-policies/src/tools/*.ts`

- [ ] **Step 1: Visually audit Worker tools**

Run:
```bash
sed -n '174,246p' worker/src/index.ts
```
Check each of the 5 tools (`search_policies`, `get_policy`, `chain_find_relevant_policies`, `cite_policy`, `health_check`) for:

| Risk | Acceptable? |
|---|---|
| Mentions "Claude" / "Anthropic" by name in `description` | NO — must rename |
| `inputSchema` uses `oneOf` / `anyOf` / `allOf` | OK if simple, suspicious if nested |
| `inputSchema` has `additionalProperties: false` | Acceptable but not required |
| Property has `enum` of simple strings | OK |
| Property has `default` | OK (advisory) |
| Description references Claude-specific concepts | NO — should be model-neutral |

Expected outcome: zero risks found.

- [ ] **Step 2: Visually audit local-mode tools**

Run:
```bash
ls msstate-policies/src/tools/ && grep -l -E "(claude|anthropic)" msstate-policies/src/tools/*.ts | head -10
```
Expected: no matches in the source. (Tools are defined as zod schemas + descriptions; descriptions should be LLM-neutral.)

- [ ] **Step 3: Decide on action**

If audit found zero risks:
- No code changes. Proceed to Task 4. **No commit for this task.**

If audit found minor issues (typo, slight rephrase):
- Make the edits in place.
- `cd msstate-policies && npm run build` to regenerate `dist/`.
- Run `bash tools/security-checklist.sh | tail -1` — must still print 192.
- Commit:
```bash
git add worker/src/index.ts msstate-policies/src/ msstate-policies/dist/
git commit -m "chore: audit tool descriptions for OpenAI compatibility"
```

If audit found structural issues:
- Halt. Re-brainstorm. This is a different project than "verify + document."

---

## Task 4: Extend run-eval.mjs for OpenAI answering model

Add an `--openai-model` flag that, when set, replaces the local stdio MCP client + Anthropic answerer with the OpenAI Responses API + MCP tool. Keep the Anthropic judge stage but use a new judge-only prompt that evaluates GPT's answer rather than producing one.

**Files:**
- Modify: `scripts/run-eval.mjs` (add OpenAI branch + new judge prompt)
- Modify: `msstate-policies/package.json` (add `openai` dev-dep — used only by the eval script, never by the published bundle)

- [ ] **Step 1: Install the openai Node SDK as a devDep**

Run from repo root:
```bash
cd msstate-policies && npm install --save-dev openai && cd ..
```
Expected: `openai` appears in `msstate-policies/package.json` under `devDependencies`. `package-lock.json` updates.

**Why devDep, not dep:** the openai SDK is used only by `scripts/run-eval.mjs`, which is never bundled into `dist/index.js`. Keeping it out of `dependencies` keeps the npm-published bundle small and avoids confusing users of the MCP server.

- [ ] **Step 2: Add OpenAI configuration parsing at the top of run-eval.mjs**

Open `scripts/run-eval.mjs`. After the existing `arg()` helper definitions and `MODELS` block (around line 73, after `const HARD_BUDGET_USD = 4.0;`), add:

```javascript
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
```

- [ ] **Step 3: Add the OpenAI answering function**

After the existing `callAnthropic` function (around line 188), add:

```javascript
// ---- OpenAI answerer (uses Responses API + MCP tool pointed at Worker) ---
async function callOpenAIWithMcp(question) {
  const res = await openaiClient.responses.create({
    model: openaiModel,
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
```

- [ ] **Step 4: Add the judge-only prompt + judging function**

After the existing `SYSTEM_PROMPT` constant (around line 145) but before `callAnthropic`, add:

```javascript
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
```

Then after `callAnthropic`, add the judge-only call:

```javascript
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
```

- [ ] **Step 5: Branch the main loop on `openaiModel`**

In `main()`, locate the per-question block (the `for (const q of questions)` loop, starting around line 208). The current loop opens an MCP client, calls `chain_find_relevant_policies`, then calls Anthropic with the policies. Wrap the whole per-question body in a branch:

Replace the existing per-question body (everything inside the `for (const q of questions)` loop, from `if (currentSpend() > HARD_BUDGET_USD)` through the existing `results.push(...)`) with:

```javascript
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
```

- [ ] **Step 6: Skip stdio MCP client when in OpenAI mode**

In `main()`, at the very top (around line 202), the existing code is:
```javascript
async function main() {
  const client = new McpClient();
  try {
    await client.init();
```
Replace with:
```javascript
async function main() {
  const client = openaiClient ? null : new McpClient();
  try {
    if (client) await client.init();
```
And update the `finally` block at the bottom of `main()`:
```javascript
  } finally {
    if (client) client.close();
  }
```

- [ ] **Step 7: Update output filename to include the answering model**

In `main()`, the existing output filename uses the judge model suffix:
```javascript
const modelSuffix = useJudge ? `-${modelKey}` : "";
const outPath = resolve(evalDir, `eval-${date}${kSuffix}${modelSuffix}.json`);
```
Replace with:
```javascript
const answererSuffix = openaiModel ? `-${openaiModel}` : (useJudge ? `-${modelKey}` : "");
const outPath = resolve(evalDir, `eval-${date}${kSuffix}${answererSuffix}.json`);
```
This produces `eval-2026-05-08-k5-gpt-4o.json` when in OpenAI mode (matching the spec's filename convention).

- [ ] **Step 8: Smoke-test the new branch with a single question**

Run from repo root:
```bash
cd msstate-policies && node ../scripts/run-eval.mjs --limit 1 --openai-model gpt-4o --k 5 && cd ..
```
Expected:
- Console shows `run-eval: OpenAI answering branch enabled (model=gpt-4o)`.
- One question runs (the first in `questions.jsonl`).
- An eval JSON is written to `msstate-policies/eval/eval-<today>-k5-gpt-4o.json` (will be overwritten in Task 5 — keep it or delete, doesn't matter).
- Final summary prints `retrieval`, `answer`, `refusal` blocks, and `cost.usd` is non-zero.
- No errors.

If the smoke test fails, debug **before** running the full 10-question eval — costs money for nothing.

- [ ] **Step 9: Verify dist/ unchanged + security checklist still 192**

Run:
```bash
cd msstate-policies && git diff --exit-code dist/ && cd ..
bash tools/security-checklist.sh | tail -1
```
Expected: no diff in `dist/` (we didn't touch the bundled server). Score = 192.

- [ ] **Step 10: Commit**

Run:
```bash
git add scripts/run-eval.mjs msstate-policies/package.json msstate-policies/package-lock.json
git commit -m "$(cat <<'EOF'
feat(eval): add OpenAI answering-model branch to run-eval.mjs

Adds --openai-model flag that routes question answering through OpenAI's
Responses API with the MCP tool wired to the deployed Worker, then judges
the answer with the existing Anthropic Sonnet judge. Output filename
encodes the answerer model so cross-model evals don't collide.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Run 10-question OpenAI eval and commit JSON

**Files:**
- Create: `msstate-policies/eval/eval-2026-05-08-k5-gpt-4o.json` (output of run-eval)
- `msstate-policies/eval/questions.jsonl` is **read-only** — do not edit it for the subset; we temporarily swap the file and restore it after the run.

- [ ] **Step 1: Stage the subset workspace**

Run:
```bash
mkdir -p /tmp/eval-subset
grep -v '^//' msstate-policies/eval/questions.jsonl | grep -v '^$' > /tmp/eval-subset/all.jsonl
wc -l /tmp/eval-subset/all.jsonl
```
Expected: 50 lines.

- [ ] **Step 2: Pick 8 retrieval + 2 refusal questions covering diverse domains**

Run this exact selection (gives reproducible coverage of distinct OP prefixes for the 8 retrieval questions):

```bash
python3 <<'PY'
import json, pathlib
src = pathlib.Path("/tmp/eval-subset/all.jsonl").read_text().strip().splitlines()
qs = [json.loads(l) for l in src]
retrieval = [q for q in qs if q.get("expected_op_numbers")]
refusal = [q for q in qs if q.get("negative") is True]
seen_prefix = set()
picked_r = []
for q in retrieval:
    prefix = q["expected_op_numbers"][0].split(".")[0]
    if prefix not in seen_prefix:
        picked_r.append(q)
        seen_prefix.add(prefix)
    if len(picked_r) == 8:
        break
if len(picked_r) < 8:
    for q in retrieval:
        if q not in picked_r:
            picked_r.append(q)
            if len(picked_r) == 8:
                break
picked_n = refusal[:2]
out = picked_r + picked_n
pathlib.Path("/tmp/eval-subset/subset.jsonl").write_text(
    "\n".join(json.dumps(q) for q in out) + "\n"
)
print(f"selected {len(picked_r)} retrieval + {len(picked_n)} refusal = {len(out)} total")
for q in out:
    print(f"  - {q['q'][:70]} (expected={q.get('expected_op_numbers')}, negative={q.get('negative', False)})")
PY
```
Expected: 10 questions printed, 8 across distinct OP prefixes, 2 marked `negative=True`.

- [ ] **Step 3: Swap in the subset file**

The harness reads from `msstate-policies/eval/questions.jsonl` by hardcoded path. Temporarily replace it (we'll restore in Step 5):

```bash
cp msstate-policies/eval/questions.jsonl /tmp/eval-subset/questions.jsonl.backup
cp /tmp/eval-subset/subset.jsonl msstate-policies/eval/questions.jsonl
```

- [ ] **Step 4: Run the full eval against the subset**

Run from repo root:
```bash
cd msstate-policies && node ../scripts/run-eval.mjs --openai-model gpt-4o --k 5 && cd ..
```
Expected:
- 10 questions processed.
- Summary shows `answer.scored: 8` and `refusal.scored: 2`.
- `cost.usd` < 4.00 (budget guard).
- Output written to `msstate-policies/eval/eval-2026-05-08-k5-gpt-4o.json`.

**Pass threshold per spec:** the headline metric is `answer.passed + refusal.passed ≥ 9` (sum across the 10 graded outcomes — 8 answer-pass + 2 refusal-pass). `retrieval.passed` is a sub-metric, not an independent gate; a question can pass retrieval (chain returned the right OPs) but still fail answer (model didn't cite them correctly), and what we care about is whether the user got a correct grounded answer or a clean refusal.

Compute the headline number:
```bash
jq '[.summary.answer.passed, .summary.refusal.passed] | add' \
  msstate-policies/eval/eval-2026-05-08-k5-gpt-4o.json
```
Expected: ≥ 9. Allow 1 miss across the 10.

If <9/10:
- Read the failing entries' `judge_answer` and `assessment`. Common cause: GPT-4o's wording differs from Sonnet's, judge marks `quoted_verbatim: false` even though the answer is correct. Don't lower the threshold — investigate whether the judge is too strict and adjust the judge prompt. If a tool description tweak would clearly help, make it (back to Task 3 territory) and re-run.
- If retrieval itself missed OPs, the BM25 + corpus aren't at fault (identical across runs). The MCP tool returned the right policies; the answerer didn't cite them. That's a model-quality issue, not a server issue.

- [ ] **Step 5: Restore the original questions.jsonl**

Run:
```bash
cp /tmp/eval-subset/questions.jsonl.backup msstate-policies/eval/questions.jsonl
git diff --exit-code msstate-policies/eval/questions.jsonl
```
Expected: no diff.

- [ ] **Step 6: Confirm only the new eval JSON is unstaged**

Run:
```bash
git status --short msstate-policies/eval/
```
Expected: only `?? msstate-policies/eval/eval-2026-05-08-k5-gpt-4o.json`.

- [ ] **Step 7: Inspect the new eval JSON before commit**

Run:
```bash
jq '.summary' msstate-policies/eval/eval-2026-05-08-k5-gpt-4o.json
```
Confirm totals match expectations from Step 4.

- [ ] **Step 8: Commit**

Run:
```bash
git add msstate-policies/eval/eval-2026-05-08-k5-gpt-4o.json
git commit -m "$(cat <<'EOF'
eval: add 10-question gpt-4o eval (cross-model verification)

8 retrieval + 2 refusal questions covering diverse OP prefixes.
Sonnet 4.6 judge for parity with the existing baseline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Clean up the temp dir**

Run:
```bash
rm -rf /tmp/eval-subset
```

---

## Task 6: Create the standalone Python sample

**Files:**
- Create: `examples/openai_api_sample.py`

- [ ] **Step 1: Write the sample script**

Create `examples/openai_api_sample.py`:
```python
#!/usr/bin/env python3
"""Standalone sample: ask MSU policy questions via OpenAI's Responses API.

This calls the deployed msstate-policies-mcp Worker as an MCP tool from
GPT-4o. Works on any OpenAI plan (independent of ChatGPT subscription tier).

Setup:
    pip install openai
    export OPENAI_API_KEY=sk-...

Run:
    python examples/openai_api_sample.py "What is MSU's hazing policy?"

See README.md `## OpenAI API` for the full how-to.
"""
import os
import sys

try:
    from openai import OpenAI
except ImportError:
    sys.exit("Missing dependency. Install with: pip install openai")

WORKER_URL = "https://msstate-policies-mcp.mminsub90.workers.dev/mcp"
DEFAULT_QUESTION = "What is MSU's hazing policy?"


def main() -> int:
    if not os.environ.get("OPENAI_API_KEY"):
        sys.exit("OPENAI_API_KEY not set. Get a key at platform.openai.com.")

    question = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_QUESTION

    client = OpenAI()
    resp = client.responses.create(
        model="gpt-4o",
        tools=[{
            "type": "mcp",
            "server_label": "msstate-policies",
            "server_url": WORKER_URL,
            "require_approval": "never",
        }],
        input=question,
    )

    print(f"Q: {question}\n")
    for item in resp.output:
        if getattr(item, "type", None) == "message":
            for c in getattr(item, "content", []) or []:
                if getattr(c, "type", None) == "output_text":
                    print(c.text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Make it executable**

Run:
```bash
chmod +x examples/openai_api_sample.py
```

- [ ] **Step 3: Smoke-test it**

Run:
```bash
python3 examples/openai_api_sample.py "What is MSU's hazing policy?"
```
Expected: prints `Q: What is MSU's hazing policy?` followed by an answer that includes:
- Verbatim quoted policy text in quotes
- The OP number `91.208`
- A canonical `policies.msstate.edu` URL

If `openai` isn't installed in the active environment, run `pip install openai` first.

- [ ] **Step 4: Commit**

Run:
```bash
git add examples/openai_api_sample.py
git commit -m "$(cat <<'EOF'
examples: add openai_api_sample.py (Python Responses API sample)

Standalone runnable sample showing how to use the deployed Worker as
an MCP tool from OpenAI's Responses API. Works on any ChatGPT plan
(independent of subscription tier — uses an OpenAI API key).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: README updates — table row, new section, privacy bullet

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the OpenAI row to the "Pick your client" table**

Open `README.md`. Find the table row (around line 30):
```markdown
| **Free claude.ai** (no MCP support) | [Drag-and-drop a Project starter zip](#free-claudeai-no-install) | 1 min |
```

Insert this row immediately **before** the Free claude.ai row:
```markdown
| **OpenAI API** (any ChatGPT plan, including free) | [Python sample](#openai-api) | 1 min |
```

- [ ] **Step 2: Add the new "OpenAI API" section**

Find the line `## Free claude.ai (no install)` (around line 98). **Before** that section, insert this new section:

````markdown
## OpenAI API

ChatGPT Connectors are gated to Pro/Business/Enterprise plans. If you're on **free ChatGPT** — or you just prefer code — you can use this MCP server directly via OpenAI's Responses API and an OpenAI API key. The API is independent of your ChatGPT subscription tier; sign up at <https://platform.openai.com> and add a few dollars of credit (queries are typically a few cents each).

**Setup:**

```bash
pip install openai
export OPENAI_API_KEY=sk-...
```

**Minimum example:**

```python
from openai import OpenAI

client = OpenAI()
resp = client.responses.create(
    model="gpt-4o",
    tools=[{
        "type": "mcp",
        "server_label": "msstate-policies",
        "server_url": "https://msstate-policies-mcp.mminsub90.workers.dev/mcp",
        "require_approval": "never",
    }],
    input="What is MSU's hazing policy?",
)

for item in resp.output:
    if getattr(item, "type", None) == "message":
        for c in item.content:
            if getattr(c, "type", None) == "output_text":
                print(c.text)
```

A runnable version is at [`examples/openai_api_sample.py`](examples/openai_api_sample.py). Pass a custom question as the first argument:

```bash
python examples/openai_api_sample.py "What's MSU's policy on academic amnesty?"
```

**What to expect:** GPT-4o produces grounded answers with the same citation discipline as Claude — verbatim quotes, OP numbers, canonical URLs, retrieval timestamps. Cross-model quality is validated against a 10-question eval ([`eval-2026-05-08-k5-gpt-4o.json`](msstate-policies/eval/eval-2026-05-08-k5-gpt-4o.json)).

````

- [ ] **Step 3: Update the Privacy section**

Find the Privacy section (around line 141, starts with `## Privacy`). The existing two bullets are:
```markdown
- **Claude Code / Desktop / Cursor / Windsurf / Zed** (local install): truly local. The MCP server runs on your machine.
- **claude.ai web / mobile via the connector**: your query goes to Anthropic (as it always does on claude.ai) and to the hosted Cloudflare Worker, which only fetches from the snapshot — never sends your query elsewhere.
```

Add a third bullet immediately after the second:
```markdown
- **OpenAI API**: your query goes to OpenAI's models and to the hosted Cloudflare Worker. No traffic to Anthropic in this mode. The Worker still only fetches from MSU and stores no logs of your queries beyond Cloudflare's standard request metadata.
```

- [ ] **Step 4: Verify the section anchors match the table**

The table row's link is `#openai-api`. GitHub renders `## OpenAI API` to anchor `openai-api`. Confirm:

```bash
grep -n "## OpenAI API\|#openai-api" README.md
```
Expected: both appear, the table link points to a real anchor.

- [ ] **Step 5: Commit**

Run:
```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(README): add OpenAI API section, table row, privacy bullet

Documents the OpenAI Responses API path for users without paid ChatGPT
plans. Cross-references the runnable Python sample and the cross-model
eval JSON.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Version bump 0.2.0 → 0.3.0

**Files:**
- Modify: `msstate-policies/package.json` (`version` field)
- Modify: `worker/src/index.ts` (three version strings)
- Generated: `msstate-policies/dist/index.js` (rebuilt by `npm run build`)
- Generated: `msstate-policies/.claude-plugin/plugin.json` (synced by `sync-version.mjs`)

- [ ] **Step 1: Bump npm version**

Open `msstate-policies/package.json`. Change:
```json
  "version": "0.2.0",
```
to:
```json
  "version": "0.3.0",
```

- [ ] **Step 2: Bump Worker version strings**

Open `worker/src/index.ts`. Change every `0.2.0` to `0.3.0`. The locations:
1. `serverInfo: { name: "msstate-policies", version: "0.2.0" }` (in the `initialize` handler around line 404).
2. `version: "0.2.0",` in the `/info` GET handler (around line 475).
3. `version: "0.2.0",` in the `health_check` tool handler (around line 363).

Sanity check:
```bash
grep -n '0\.2\.0\|0\.3\.0' worker/src/index.ts
```
Expected: only `0.3.0` matches; no `0.2.0` left.

- [ ] **Step 3: Rebuild dist and sync plugin.json**

Run:
```bash
cd msstate-policies && npm run build && cd ..
```
Expected output includes:
- `sync-version: bumped plugin.json to 0.3.0` (or `already at 0.3.0`)
- esbuild bundles `dist/index.js`
- No errors

- [ ] **Step 4: Verify the bundle's banner reflects the new version**

Run:
```bash
head -1 msstate-policies/dist/index.js
```
Expected: starts with `// msstate-policies-mcp 0.3.0 <sha> built <iso>`.

- [ ] **Step 5: Stage and view changes**

Run:
```bash
git add msstate-policies/dist/ msstate-policies/.claude-plugin/plugin.json msstate-policies/package.json worker/src/index.ts
git status --short msstate-policies/ worker/
```
Expected:
- `M msstate-policies/dist/index.js` (bundle changed because of version + build timestamp).
- `M msstate-policies/.claude-plugin/plugin.json`
- `M msstate-policies/package.json`
- `M worker/src/index.ts`

- [ ] **Step 6: Run typecheck + tests + tools/list smoke**

Run:
```bash
cd msstate-policies && npm run typecheck && npm test
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js | head -1 | jq -r '.result.tools | length'
cd ..
```
Expected: typecheck passes, tests pass, tools/list returns `5`.

- [ ] **Step 7: Run security checklist**

Run:
```bash
bash tools/security-checklist.sh | tail -1
```
Expected: `192`.

- [ ] **Step 8: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
chore: bump 0.2.0 -> 0.3.0 (OpenAI verified support)

Semver-minor: no API surface changes, no schema changes, no removed
tools. Marks the moment we stopped being Claude-only verified and
became verified across two LLM ecosystems (Anthropic + OpenAI).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final verification + branch parity with CI

**Files:** none (verification only)

- [ ] **Step 1: Re-run the full local CI parity**

Run from repo root:
```bash
cd msstate-policies && npm ci && npm run typecheck && npm run build && git diff --exit-code dist/ && npm test && cd ..
```
Expected:
- `npm ci` succeeds (lockfile in sync after Task 4 added `openai`).
- typecheck passes.
- build succeeds.
- `git diff --exit-code dist/` exits 0 — bundle hasn't drifted from committed state.
- tests pass.

- [ ] **Step 2: Re-run npm audit gate**

Run:
```bash
cd msstate-policies && npm audit --audit-level=high && cd ..
cd worker && [ -f package-lock.json ] && npm audit --audit-level=high || echo "skipping worker audit"
cd ..
```
Expected: no high/critical advisories. (If `openai` introduces a transitive advisory, fix or pin before continuing — CI's audit gate would fail otherwise.)

- [ ] **Step 3: Re-run the security checklist gate**

Run:
```bash
bash tools/security-checklist.sh | tail -1
```
Expected: `192`. CI's security gate hard-fails below 100; below 192 means a check regressed during this work.

- [ ] **Step 4: Confirm tools/list smoke**

Run:
```bash
PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
COUNT=$(printf '%s\n' "$PAYLOAD" | node msstate-policies/dist/index.js | head -n1 | jq -r '.result.tools | length')
test "$COUNT" = "5" && echo "PASS: 5 tools" || echo "FAIL: got $COUNT"
```
Expected: `PASS: 5 tools`.

- [ ] **Step 5: Confirm no stray uncommitted changes**

Run:
```bash
git status --short
```
Expected: clean (or only the unrelated pre-existing modifications to `msstate-policies/src/scraper.ts`, `chain_find_relevant.ts`, `types.ts` that were already modified before this work started).

- [ ] **Step 6: Show the commit graph**

Run:
```bash
git log --oneline -10
```
Expected: 5–6 new commits on top of the design-spec commit:
1. (Task 3, optional, if any audit edits) `chore: audit tool descriptions for OpenAI compatibility`
2. (Task 4) `feat(eval): add OpenAI answering-model branch to run-eval.mjs`
3. (Task 5) `eval: add 10-question gpt-4o eval (cross-model verification)`
4. (Task 6) `examples: add openai_api_sample.py`
5. (Task 7) `docs(README): add OpenAI API section, table row, privacy bullet`
6. (Task 8) `chore: bump 0.2.0 -> 0.3.0 (OpenAI verified support)`

- [ ] **Step 7: No commit**

This task is verification only. Hand off to the user — they decide whether to push and open a PR.

---

## Acceptance criteria recap (from spec)

After all tasks complete, verify each spec acceptance criterion:

1. ✅ Tier 1 protocol verification passed in Task 2.
2. ✅ Tier 2 eval passed ≥9/10 in Task 5.
3. ✅ `eval-2026-05-08-k5-gpt-4o.json` committed in Task 5.
4. ✅ README has `## OpenAI API` section + updated client table + updated privacy section (Task 7).
5. ✅ `examples/openai_api_sample.py` exists and runs cleanly (Task 6).
6. ✅ Version bumped to 0.3.0 across npm / Worker / dist (Task 8).
7. ✅ `bash tools/security-checklist.sh | tail -1` prints `192` (Task 9).
8. ✅ CI green on the resulting PR — verified by user after `git push`.

---

## What this plan does NOT do (deferred per spec)

- OAuth 2.1 + DCR for the Worker (separate spec)
- ChatGPT Pro/Business Connectors verification (no maintainer access)
- Custom GPTs via OpenAPI Actions (separate scope)
- Other LLM ecosystems — Gemini, Ollama, LM Studio, agent frameworks
- MCP registry submissions (follow-up small PR after this ships)
- CI smoke test against OpenAI (key-management overhead not warranted)
- SECURITY.md / autoresearch_security.md updates (no new threat surface)

If any of these turn out to be required during execution, **halt and re-brainstorm** rather than expanding scope inside this plan.
