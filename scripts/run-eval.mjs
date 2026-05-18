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
  // Support both --name value and --name=value forms.
  const eqPrefx = `--${name}=`;
  const eqEntry = argv.find((a) => a.startsWith(eqPrefx));
  if (eqEntry) return eqEntry.slice(eqPrefx.length);
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
  const out = { course_explain: { pass: 0, fail: 0 }, prereq_chain: { pass: 0, fail: 0 }, unlocks: { pass: 0, fail: 0 }, prereq_non_course: { pass: 0, fail: 0 }, prereq_min_grade: { pass: 0, fail: 0 }, prereq_senior_standing: { pass: 0, fail: 0 } };
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
      } else if (row.type === "prereq_non_course") {
        const res = await mcp.callTool("get_msu_course", { code: row.code });
        const parsed = JSON.parse(res.content[0].text);
        const nonCourse = (parsed.course?.prereqs?.non_course ?? []);
        ok = nonCourse.some((s) => s.includes(row.expected_non_course_contains));
        detail = `non_course=[${nonCourse.join(", ")}]`;
      } else if (row.type === "prereq_min_grade") {
        const res = await mcp.callTool("get_msu_course", { code: row.code });
        const parsed = JSON.parse(res.content[0].text);
        const minGrade = parsed.course?.prereqs?.min_grade ?? null;
        ok = minGrade === row.expected_min_grade;
        detail = `min_grade=${minGrade}`;
      } else if (row.type === "prereq_senior_standing") {
        const res = await mcp.callTool("get_msu_course", { code: row.code });
        const parsed = JSON.parse(res.content[0].text);
        const nonCourse = (parsed.course?.prereqs?.non_course ?? []);
        ok = nonCourse.some((s) => s.toLowerCase().includes("senior standing"));
        detail = `non_course=[${nonCourse.join(", ")}]`;
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
      prereq_non_course: out.prereq_non_course,
      prereq_min_grade: out.prereq_min_grade,
      prereq_senior_standing: out.prereq_senior_standing,
    },
    rates: {
      course_explain: Number(rate("course_explain").toFixed(3)),
      prereq_chain: Number(rate("prereq_chain").toFixed(3)),
      unlocks: Number(rate("unlocks").toFixed(3)),
      prereq_non_course: Number(rate("prereq_non_course").toFixed(3)),
      prereq_min_grade: Number(rate("prereq_min_grade").toFixed(3)),
      prereq_senior_standing: Number(rate("prereq_senior_standing").toFixed(3)),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  for (const f of failures.slice(0, 20)) console.error("FAIL", f.type, "|", f.q, "→", f.detail);

  // Thresholds per spec §1.
  const thresholds = { course_explain: 0.9, prereq_chain: 0.95, unlocks: 0.95, prereq_non_course: 1.0, prereq_min_grade: 1.0, prereq_senior_standing: 1.0 };
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

// ---- tuition suite (no LLM judge — deterministic per-kind assertions) ------
if (suite === "tuition") {
  const { spawn: spawnTui } = await import("node:child_process");
  const tuitionPath = resolve(evalDir, "tuition.jsonl");
  if (!existsSync(tuitionPath)) {
    console.error(`run-eval: ${tuitionPath} not found`);
    process.exit(1);
  }
  const rows = readFileSync(tuitionPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l) => JSON.parse(l));

  class TuiMcp {
    constructor() {
      this.proc = spawnTui("node", [distPath], { stdio: ["pipe", "pipe", "inherit"] });
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
        clientInfo: { name: "run-eval-tuition", version: "0.1.0" },
      });
    }
    callTool(name, args) {
      return this.call("tools/call", { name, arguments: args });
    }
    close() { this.proc.kill(); }
  }

  const mcp = new TuiMcp();
  await mcp.init();
  let pass = 0;
  const failures = [];
  for (const q of rows) {
    let res;
    try {
      if (q.kind === "rate_lookup" || q.kind === "rate_not_found") {
        res = await mcp.callTool("get_msu_tuition_rate", q.args);
      } else if (q.kind === "fee_lookup") {
        res = await mcp.callTool("get_msu_enrollment_fees", q.args);
      } else if (q.kind === "faq_top_match") {
        res = await mcp.callTool("find_msu_tuition_faq", q.args);
      } else if (q.kind === "list_campuses") {
        res = await mcp.callTool("list_msu_tuition_campuses", q.args);
      } else if (q.kind === "adversarial_empty") {
        res = await mcp.callTool(q.tool, q.args);
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
    if (q.kind === "rate_lookup") {
      const m = parsed?.matches?.[0];
      ok = m && Math.abs(m.amount_usd - q.expected_amount) < 0.5;
    } else if (q.kind === "rate_not_found") {
      ok = parsed?.matches?.length === 0 &&
        (parsed?.not_found_reason ?? "").toLowerCase().includes((q.expected_reason_contains ?? "").toLowerCase());
    } else if (q.kind === "fee_lookup") {
      const m = parsed?.matches?.find?.((r) =>
        (r.label ?? "").toLowerCase().includes((q.expected_label_contains ?? "").toLowerCase()));
      const field = q.expected_field ?? "per_credit_usd";
      ok = m && Math.abs((m[field] ?? Number.NaN) - q.expected_amount) < 0.5;
    } else if (q.kind === "faq_top_match") {
      const matches = parsed?.matches ?? [];
      const needle = (q.expected_question_contains ?? "").toLowerCase();
      ok = matches.some((m) => (m.question ?? "").toLowerCase().includes(needle));
    } else if (q.kind === "list_campuses") {
      const slugs = (parsed?.campuses ?? []).map((c) => c.slug);
      ok = slugs.length === 5 &&
        ["starkville", "meridian", "mgccc", "online", "vetmed"].every((s) => slugs.includes(s));
    } else if (q.kind === "adversarial_empty") {
      ok = Array.isArray(parsed?.matches) && parsed.matches.length === 0;
    }
    if (ok) pass++;
    else failures.push({ q, parsed: parsed ?? text.slice(0, 200) });
  }
  mcp.close();
  console.log(`tuition eval: ${pass}/${rows.length} passed`);
  for (const f of failures.slice(0, 20)) console.error("FAIL", JSON.stringify(f.q), "got", JSON.stringify(f.parsed).slice(0, 200));
  const threshold = Math.ceil(rows.length * 0.9);
  process.exit(pass >= threshold ? 0 : 1);
}

if (suite === "online") {
  const { spawn: spawnOnl } = await import("node:child_process");
  const onlinePath = resolve(evalDir, "online.jsonl");
  if (!existsSync(onlinePath)) {
    console.error(`run-eval: ${onlinePath} not found`);
    process.exit(1);
  }
  const rows = readFileSync(onlinePath, "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).map((l) => JSON.parse(l));

  class OnlMcp {
    constructor() {
      this.proc = spawnOnl("node", [distPath], { stdio: ["pipe", "pipe", "inherit"] });
      this.buf = ""; this.pending = new Map(); this.nextId = 1;
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
      await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "run-eval-online", version: "0.1.0" } });
    }
    callTool(args) { return this.call("tools/call", args); }
    close() { this.proc.kill(); }
  }

  const mcp = new OnlMcp();
  await mcp.init();
  let pass = 0;
  const failures = [];
  for (const q of rows) {
    let res;
    try {
      res = await mcp.callTool(q.args);
    } catch (err) {
      failures.push({ q, got: `error: ${err.message}` });
      continue;
    }
    const text = res?.content?.[0]?.text ?? "";
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
    let ok = false;
    const e = q.expect ?? {};
    if (q.kind.startsWith("program_") || q.kind === "adversarial_program") {
      const m = parsed?.matched;
      if (e.matched_null) ok = m === null || m === undefined;
      else if (e.matched_slug) ok = m?.slug === e.matched_slug;
      else if (e.matched_degree_level) ok = m?.degree_level === e.matched_degree_level;
      else if (e.matched_name_contains) ok = typeof m?.name === "string" && m.name.toLowerCase().includes(e.matched_name_contains.toLowerCase());
      else if (e.matched_contacts_min !== undefined) ok = Array.isArray(m?.contacts) && m.contacts.length >= e.matched_contacts_min;
      else if (e.matched_contacts_msstate_email) ok = Array.isArray(m?.contacts) && m.contacts.some((c) => c.email && /@(\w+\.)?msstate\.edu$/.test(c.email));
      else if (e.deadlines_contain_term_date) ok = Array.isArray(m?.application_deadlines) && m.application_deadlines.some((d) => d.term === e.deadlines_contain_term_date[0] && new RegExp(e.deadlines_contain_term_date[1], "i").test(d.date_text));
      else if (e.not_found_reason_nonempty) ok = typeof parsed?.not_found_reason === "string" && parsed.not_found_reason.length > 0;
    } else if (q.kind.startsWith("list_") || q.kind === "adversarial_keyword") {
      const matches = parsed?.matches ?? [];
      const t = parsed?.total ?? 0; const ft = parsed?.filtered_total ?? 0;
      if (e.filtered_total_min !== undefined) ok = ft >= e.filtered_total_min;
      else if (e.total_min !== undefined) ok = t >= e.total_min;
      else if (e.matches_min !== undefined) ok = matches.length >= e.matches_min;
      else if (e.matches_max !== undefined) ok = matches.length <= e.matches_max;
      else if (e.matches_eq !== undefined) ok = matches.length === e.matches_eq;
    } else if (q.kind.startsWith("admissions_")) {
      const sec = parsed?.sections ?? {};
      if (e.section_undergraduate_contains_any) {
        const body = (sec.undergraduate ?? "").toLowerCase();
        ok = e.section_undergraduate_contains_any.some((s) => body.includes(s.toLowerCase()));
      } else if (e.section_international_contains_any) {
        const body = (sec.international ?? "").toLowerCase();
        ok = e.section_international_contains_any.some((s) => body.includes(s.toLowerCase()));
      } else if (e.all_5_sections_present) {
        ok = ["undergraduate","graduate","transfer","readmit","international"].every((st) => typeof sec[st] === "string" && sec[st].length > 0);
      } else if (e.central_email_eq) {
        ok = parsed?.central_contact?.email === e.central_email_eq;
      } else if (e.external_apply_contains_substrs) {
        const urls = (parsed?.external_apply_urls ?? []).map((u) => u.url ?? "");
        ok = e.external_apply_contains_substrs.every((s) => urls.some((u) => u.includes(s)));
      }
    } else if (q.kind.startsWith("info_") || q.kind === "adversarial_off_topic") {
      const matches = parsed?.matches ?? [];
      if (e.top_slug) ok = matches[0]?.slug === e.top_slug;
      else if (e.any_slug) ok = matches.some((m) => m.slug === e.any_slug);
      else if (e.any_full_body_contains) ok = matches.some((m) => (m.full_body ?? "").includes(e.any_full_body_contains));
      else if (e.matches_eq !== undefined) ok = matches.length === e.matches_eq;
    }
    if (ok) pass++;
    else failures.push({ q, got: parsed ?? text.slice(0, 200) });
  }
  mcp.close();
  console.log(`online eval: ${pass}/${rows.length} passed`);
  for (const f of failures.slice(0, 20)) console.error("FAIL", JSON.stringify(f.q.desc ?? f.q.kind), "got", JSON.stringify(f.got).slice(0, 300));
  const threshold = Math.ceil(rows.length * 0.9);
  process.exit(pass >= threshold ? 0 : 1);
}

if (suite === "dining") {
  const { spawn: spawnDin } = await import("node:child_process");
  const diningPath = resolve(evalDir, "dining.jsonl");
  if (!existsSync(diningPath)) {
    console.error(`run-eval: ${diningPath} not found`);
    process.exit(1);
  }
  const rows = readFileSync(diningPath, "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).map((l) => JSON.parse(l));

  class DinMcp {
    constructor() {
      this.proc = spawnDin("node", [distPath], { stdio: ["pipe", "pipe", "inherit"] });
      this.buf = ""; this.pending = new Map(); this.nextId = 1;
      this.proc.stdout.on("data", (chunk) => {
        this.buf += chunk.toString();
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (!line.trim() || !line.trim().startsWith("{")) continue;
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
      await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "run-eval-dining", version: "0.1.0" } });
    }
    callTool(args) { return this.call("tools/call", args); }
    close() { this.proc.kill(); }
  }

  const mcp = new DinMcp();
  await mcp.init();
  let pass = 0;
  const failures = [];
  for (const q of rows) {
    let res;
    try {
      res = await mcp.callTool(q.args);
    } catch (err) {
      if (q.expect?.throws) { pass++; continue; }
      failures.push({ q, got: `error: ${err.message}` });
      continue;
    }
    if (q.expect?.throws) { failures.push({ q, got: "expected throw, got success" }); continue; }
    const text = res?.content?.[0]?.text ?? "";
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
    let ok = false;
    const e = q.expect ?? {};
    if (q.kind === "location_slug_lookup" || q.kind === "location_name_query") {
      const m = parsed?.matched;
      if (e.matched_slug) ok = m?.slug === e.matched_slug;
      else if (e.matched_slug_prefix) ok = typeof m?.slug === "string" && m.slug.startsWith(e.matched_slug_prefix);
    } else if (q.kind === "list_filter") {
      const t = parsed?.total ?? 0;
      const matches = parsed?.matches ?? [];
      if (e.total_min !== undefined) ok = t >= e.total_min;
      else if (e.matches_min !== undefined) ok = matches.length >= e.matches_min;
      else if (e.matches_max !== undefined) ok = matches.length <= e.matches_max;
    } else if (q.kind === "open_status_check") {
      const s = parsed?.status_now;
      const sKey = typeof s === "object" && s ? s.status : s;
      ok = Array.isArray(e.status_one_of) && e.status_one_of.includes(sKey);
    } else if (q.kind === "adversarial") {
      if (e.matched_null && e.not_found_reason_nonempty) {
        ok = parsed?.matched === null && typeof parsed?.not_found_reason === "string" && parsed.not_found_reason.length > 0;
      } else if (e.matches_eq !== undefined) {
        ok = (parsed?.matches?.length ?? -1) === e.matches_eq;
      }
    }
    if (ok) pass++;
    else failures.push({ q, got: parsed ?? text.slice(0, 200) });
  }
  mcp.close();
  console.log(`dining eval: ${pass}/${rows.length} passed`);
  for (const f of failures.slice(0, 20)) console.error("FAIL", JSON.stringify(f.q.desc ?? f.q.kind), "got", JSON.stringify(f.got).slice(0, 300));
  const threshold = Math.ceil(rows.length * 0.9);
  process.exit(pass >= threshold ? 0 : 1);
}

// ---- dates suite (deterministic — no LLM judge) --------------------------
// Asserts that find_msu_date returns rows with the exact ISO start/end the
// upstream calendar publishes. The synonyms eval at evals/calendar-synonyms-eval.ts
// covers recall ("did we retrieve the right event?"); this suite covers
// correctness ("did the date returned match?"). Re-seed expected values from
// the live corpus after any calendar rebuild — do not trust memory.
if (suite === "dates") {
  const { spawn: spawnDates } = await import("node:child_process");
  const datesPath = resolve(evalDir, "dates.jsonl");
  if (!existsSync(datesPath)) {
    console.error(`run-eval: ${datesPath} not found`);
    process.exit(1);
  }
  const rows = readFileSync(datesPath, "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).map((l) => JSON.parse(l));

  class DatesMcp {
    constructor() {
      this.proc = spawnDates("node", [distPath], { stdio: ["pipe", "pipe", "inherit"] });
      this.buf = ""; this.pending = new Map(); this.nextId = 1;
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
      await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "run-eval-dates", version: "0.1.0" } });
    }
    callTool(name, args) { return this.call("tools/call", { name, arguments: args }); }
    close() { this.proc.kill(); }
  }

  const mcp = new DatesMcp();
  await mcp.init();
  // Warm-up: discard the first response so subsequent assertions see the
  // fully-loaded calendar corpus. Without this, cold CI runners can race
  // the background calendar scrape.
  try { await mcp.callTool("find_msu_date", { q: "warmup" }); } catch { /* ignore */ }
  let pass = 0;
  const failures = [];
  for (const q of rows) {
    let res;
    try {
      res = await mcp.callTool("find_msu_date", { q: q.q });
    } catch (err) {
      failures.push({ q, got: `error: ${err.message}` });
      continue;
    }
    const text = res?.content?.[0]?.text ?? "";
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
    let ok = false;
    if (q.kind === "date_match") {
      const e = q.expect ?? {};
      const matches = parsed?.matches ?? [];
      ok = matches.some((r) =>
        (e.term === undefined || r.term === e.term) &&
        (e.event_contains === undefined || (r.event ?? "").includes(e.event_contains)) &&
        (e.start === undefined || r.start === e.start) &&
        (e.end === undefined || r.end === e.end));
    }
    if (ok) pass++;
    else failures.push({ q, got: (parsed?.matches ?? []).slice(0, 3).map((r) => ({ event: r.event, term: r.term, start: r.start, end: r.end })) });
  }
  mcp.close();
  console.log(`dates eval: ${pass}/${rows.length} passed`);
  for (const f of failures.slice(0, 20)) console.error("FAIL", JSON.stringify(f.q.desc ?? f.q.q), "got", JSON.stringify(f.got).slice(0, 400));
  const threshold = Math.ceil(rows.length * 0.9);
  process.exit(pass >= threshold ? 0 : 1);
}

// ---- adversarial suite (deterministic — no LLM judge) --------------------
// Cross-cutting moat-defense fixtures. Each case exercises a specific
// footnote / line item / structured field that page-summarizing LLMs are
// known to drop. Threshold is 100%: one regression should fail the suite.
if (suite === "adversarial") {
  const { spawn: spawnAdv } = await import("node:child_process");
  const advPath = resolve(evalDir, "adversarial.jsonl");
  if (!existsSync(advPath)) {
    console.error(`run-eval: ${advPath} not found`);
    process.exit(1);
  }
  const rows = readFileSync(advPath, "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).map((l) => JSON.parse(l));

  class AdvMcp {
    constructor() {
      this.proc = spawnAdv("node", [distPath], { stdio: ["pipe", "pipe", "inherit"] });
      this.buf = ""; this.pending = new Map(); this.nextId = 1;
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
      await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "run-eval-adversarial", version: "0.1.0" } });
    }
    callTool(name, args) { return this.call("tools/call", { name, arguments: args }); }
    close() { this.proc.kill(); }
  }

  function getPath(obj, path) {
    let v = obj;
    for (const k of path ?? []) {
      if (v == null) return undefined;
      v = v[k];
    }
    return v;
  }

  const mcp = new AdvMcp();
  await mcp.init();
  // Warm-up: force the calendar background scrape to complete before any
  // assertion fires. The bundle starts corpora warm on stdio startup but
  // serves partial responses until each adapter finishes. Without this,
  // find_msu_date can race the calendar warm on cold CI runners.
  try { await mcp.callTool("find_msu_date", { q: "warmup" }); } catch { /* ignore */ }
  let pass = 0;
  const failures = [];
  for (const q of rows) {
    let res;
    try {
      res = await mcp.callTool(q.tool, q.args ?? {});
    } catch (err) {
      failures.push({ q, got: `error: ${err.message}` });
      continue;
    }
    const text = res?.content?.[0]?.text ?? "";
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
    let ok = false;

    if (q.kind === "raw_section_contains") {
      const section = parsed?.matched?.raw_sections?.[q.section];
      ok = typeof section === "string" && section.includes(q.substring);
    } else if (q.kind === "field_contains") {
      const v = getPath(parsed, q.path);
      ok = typeof v === "string" && v.includes(q.substring);
    } else if (q.kind === "field_contains_all") {
      const v = getPath(parsed, q.path);
      ok = typeof v === "string" && q.substrings.every((s) => v.includes(s));
    } else if (q.kind === "field_equals") {
      ok = getPath(parsed, q.path) === q.value;
    } else if (q.kind === "field_approx") {
      const v = getPath(parsed, q.path);
      ok = typeof v === "number" && Math.abs(v - q.value) <= (q.tolerance ?? 0.5);
    } else if (q.kind === "tuition_line_item") {
      const items = parsed?.matches?.[0]?.line_items;
      ok = Array.isArray(items) && items.some((li) => li.label === q.label && Math.abs((li.amount_usd ?? Number.NaN) - q.amount_usd) < 0.5);
    } else if (q.kind === "graph_edge") {
      const edges = parsed?.edges;
      ok = Array.isArray(edges) && edges.some((e) => e.from === q.from && e.to === q.to && (q.min_grade === undefined || e.min_grade === q.min_grade));
    } else if (q.kind === "graph_node_present") {
      const nodes = parsed?.nodes;
      ok = Array.isArray(nodes) && nodes.some((n) => n.code === q.code);
    } else if (q.kind === "policy_in_results") {
      const results = parsed?.results;
      ok = Array.isArray(results) && results.some((p) => p.number === q.op_number);
    } else if (q.kind === "date_row_present") {
      const matches = parsed?.matches;
      ok = Array.isArray(matches) && matches.some((r) =>
        (q.term === undefined || r.term === q.term) &&
        (q.event_contains === undefined || (r.event ?? "").includes(q.event_contains)) &&
        (q.start === undefined || r.start === q.start) &&
        (q.end === undefined || r.end === q.end));
    } else if (q.kind === "deadline_term_text") {
      const dls = parsed?.matched?.application_deadlines;
      ok = Array.isArray(dls) && dls.some((d) => d.term === q.term && (d.date_text ?? "").includes(q.text_contains));
    } else {
      failures.push({ q, got: `unknown kind: ${q.kind}` });
      continue;
    }

    if (ok) pass++;
    else failures.push({ q, got: parsed ? JSON.stringify(parsed).slice(0, 400) : text.slice(0, 200) });
  }
  mcp.close();
  console.log(`adversarial eval: ${pass}/${rows.length} passed`);
  for (const f of failures.slice(0, 20)) console.error("FAIL", JSON.stringify(f.q.desc ?? f.q.kind), "got", JSON.stringify(f.got).slice(0, 400));
  // Moat defense — every case must pass.
  process.exit(pass === rows.length ? 0 : 1);
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
