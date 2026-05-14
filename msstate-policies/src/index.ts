/**
 * msstate-policies MCP server entry point.
 *
 *  - Stdio transport. stdout is JSON-RPC framing; all logging goes to stderr.
 *  - Deterministic tools/list (5 tools, fixed order).
 *  - Errors thrown by handlers are caught and returned as { isError: true }
 *    so the LLM never sees a raw stack trace across the MCP boundary.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { log } from "./log.js";
import { fetchIndex } from "./scraper.js";
import { indexEntries } from "./search.js";

import { search_policies } from "./tools/search_policies.js";
import { get_policy } from "./tools/get_policy.js";
import { chain_find_relevant_policies } from "./tools/chain_find_relevant.js";
import { cite_policy } from "./tools/cite_policy.js";
import { find_msu_date } from "./tools/find_msu_date.js";
import { get_msu_calendar, indexCalendarRowsForGetter } from "./tools/get_msu_calendar.js";
import { loadAllCalendarRows, setCalendarWarmReady } from "./calendars/corpus.js";
import { indexCalendarRows } from "./calendars/search.js";
import { search_msu_courses } from "./tools/search_msu_courses.js";
import { get_msu_course } from "./tools/get_msu_course.js";
import { get_msu_course_graph } from "./tools/get_msu_course_graph.js";
import { setCourseCorpus } from "./courses/corpus.js";
import type { CourseCorpus } from "./courses/types.js";
import { get_msu_emergency_guideline } from "./tools/get_msu_emergency_guideline.js";
import { list_msu_emergency_types } from "./tools/list_msu_emergency_types.js";
import { find_msu_severe_weather_refuge } from "./tools/find_msu_severe_weather_refuge.js";
import { get_msu_emergency_contacts } from "./tools/get_msu_emergency_contacts.js";
import { setEmergencyCorpus } from "./emergency/corpus.js";
import type { EmergencyCorpus } from "./emergency/types.js";
import { get_msu_tuition_rate } from "./tools/get_msu_tuition_rate.js";
import { get_msu_enrollment_fees } from "./tools/get_msu_enrollment_fees.js";
import { find_msu_tuition_faq } from "./tools/find_msu_tuition_faq.js";
import { list_msu_tuition_campuses } from "./tools/list_msu_tuition_campuses.js";
import { setTuitionCorpus } from "./tuition/corpus.js";
import type { TuitionCorpus } from "./tuition/types.js";
import { list_online_programs } from "./tools/list_online_programs.js";
import { get_online_program } from "./tools/get_online_program.js";
import { get_online_admissions_process } from "./tools/get_online_admissions_process.js";
import { find_online_info } from "./tools/find_online_info.js";
import { setOnlineCorpus } from "./online/corpus.js";
import type { OnlineCorpus } from "./online/types.js";
import { health_check } from "./tools/health_check.js";

/**
 * Server-provided routing + anti-hallucination guidance, surfaced to the
 * model via MCP's InitializeResult.instructions field (spec-compliant
 * clients add it to the model's system context). KEEP IN SYNC with the
 * same constant in worker/src/index.ts — single source of truth lives
 * here in the README's INSTRUCTIONS snippet (extended for v0.7.0
 * emergency + v0.8.0 tuition).
 *
 * Why this exists: when ChatGPT's custom-connector flow accesses the
 * Worker, it has no way to inject a system prompt. Without server-side
 * instructions, GPT routes blind from tool descriptions alone and tends
 * to (a) pick a policy tool for date/calendar questions and (b) fall
 * back to training data when the wrong tool returns nothing useful.
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

// Deterministic order — referenced in the README and CI smoke test.
const TOOLS = [
  search_policies,
  get_policy,
  chain_find_relevant_policies,
  cite_policy,
  find_msu_date,
  get_msu_calendar,
  search_msu_courses,
  get_msu_course,
  get_msu_course_graph,
  get_msu_emergency_guideline,
  list_msu_emergency_types,
  find_msu_severe_weather_refuge,
  get_msu_emergency_contacts,
  get_msu_tuition_rate,
  get_msu_enrollment_fees,
  find_msu_tuition_faq,
  list_msu_tuition_campuses,
  list_online_programs,
  get_online_program,
  get_online_admissions_process,
  find_online_info,
  health_check,
] as const;

type ToolDef = (typeof TOOLS)[number];

const TOOLS_BY_NAME = new Map<string, ToolDef>(
  TOOLS.map((t) => [t.name, t]),
);

// N8: esbuild's `define` rewrites these literals at build time. When the
// bundler hasn't run (e.g. running src/ directly via tsx in tests), the
// declared names are still bound by tsc's `declare` shim. Reading them
// inside a typeof guard avoids ReferenceError without needing `new Function`.
declare const __VERSION__: string | undefined;
declare const __GIT_SHA__: string | undefined;
declare const __COURSE_CORPUS__: CourseCorpus | undefined;
declare const __EMERGENCY_CORPUS__: EmergencyCorpus | undefined;
declare const __TUITION_CORPUS__: TuitionCorpus | undefined;
declare const __ONLINE_CORPUS__: OnlineCorpus | undefined;

function safeVersion(): string {
  return typeof __VERSION__ !== "undefined" ? __VERSION__ : "";
}

function safeGitSha(): string {
  return typeof __GIT_SHA__ !== "undefined" ? __GIT_SHA__ : "";
}

function loadBakedCourseCorpus(): void {
  if (typeof __COURSE_CORPUS__ !== "undefined" && __COURSE_CORPUS__) {
    setCourseCorpus(__COURSE_CORPUS__);
    log("info", "course corpus loaded", {
      count: Object.keys(__COURSE_CORPUS__.records).length,
    });
  } else {
    log("warn", "no baked course corpus available; course tools will return empty results");
  }
}

function loadBakedEmergencyCorpus(): void {
  if (typeof __EMERGENCY_CORPUS__ !== "undefined" && __EMERGENCY_CORPUS__) {
    setEmergencyCorpus(__EMERGENCY_CORPUS__);
    log("info", "emergency corpus loaded", {
      guidelines: __EMERGENCY_CORPUS__.guidelines.length,
      refuge_areas: __EMERGENCY_CORPUS__.refuge_areas.length,
      contacts: __EMERGENCY_CORPUS__.contacts.length,
    });
  } else {
    log("warn", "no baked emergency corpus available; emergency tools will return empty results");
  }
}

function loadBakedTuitionCorpus(): void {
  if (typeof __TUITION_CORPUS__ !== "undefined" && __TUITION_CORPUS__) {
    setTuitionCorpus(__TUITION_CORPUS__);
    log("info", "tuition corpus loaded", {
      rate_rows: __TUITION_CORPUS__.rate_rows.length,
      fee_rows: __TUITION_CORPUS__.fee_rows.length,
      faq_rows: __TUITION_CORPUS__.faq_rows.length,
      campuses: __TUITION_CORPUS__.campuses.length,
    });
  } else {
    log("warn", "no baked tuition corpus available; tuition tools will return empty results");
  }
}

function loadBakedOnlineCorpus(): void {
  if (typeof __ONLINE_CORPUS__ !== "undefined" && __ONLINE_CORPUS__) {
    setOnlineCorpus(__ONLINE_CORPUS__);
    log("info", "online corpus loaded", {
      programs: __ONLINE_CORPUS__.programs.length,
      staff: __ONLINE_CORPUS__.staff.length,
      info_pages: __ONLINE_CORPUS__.info_pages.length,
    });
  } else {
    log("warn", "no baked online corpus available; online tools will return empty results");
  }
}

async function main(): Promise<void> {
  const version = safeVersion() || "unknown";
  const gitSha = safeGitSha() || "unknown";

  log("info", "msstate-policies-mcp starting", {
    version,
    gitSha,
    node: process.version,
    pid: process.pid,
  });

  const server = new Server(
    {
      name: "msstate-policies",
      version,
    },
    {
      capabilities: {
        tools: {},
      },
      // Server-provided routing + anti-hallucination guidance for the model.
      // Honored by spec-compliant MCP clients (Claude.ai, ChatGPT custom
      // connector, etc.) via InitializeResult.instructions. Keep IN SYNC
      // with the same constant in worker/src/index.ts.
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as object,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = TOOLS_BY_NAME.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }
    try {
      log("info", "tool/call", { name });
      return await tool.handler(args ?? {});
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      log("error", "tool handler threw", { name, err: message });
      return {
        isError: true,
        content: [{ type: "text", text: structuredErrorMessage(name, message) }],
      };
    }
  });

  // Background-warm: try to populate the index + BM25 doc list before
  // the first user request lands. Don't await — startup must be fast.
  fetchIndex()
    .then((idx) => {
      indexEntries(idx.rows);
      log("info", "background warm done", { rows: idx.rows.length });
    })
    .catch((err) => {
      log("warn", "background warm failed; will retry on first request", {
        err: err instanceof Error ? err.message : String(err),
      });
    });

  const calendarWarm = loadAllCalendarRows()
    .then((rows) => {
      indexCalendarRows(rows);
      indexCalendarRowsForGetter(rows);
      log("info", "calendar background warm done", { rows: rows.length });
    })
    .catch((err) => {
      log("warn", "calendar background warm failed; will retry on first request", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  setCalendarWarmReady(calendarWarm);

  loadBakedCourseCorpus();
  loadBakedEmergencyCorpus();
  loadBakedTuitionCorpus();
  loadBakedOnlineCorpus();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "msstate-policies-mcp ready");
}

function structuredErrorMessage(toolName: string, msg: string): string {
  const httpMatch = msg.match(/HTTP\s+(\d{3})/i);
  if (httpMatch) {
    return `MSU site returned ${httpMatch[1]}`;
  }
  if (/not found in index/i.test(msg)) {
    return msg;
  }
  if (/PDF/i.test(msg) && /(parse|extract)/i.test(msg)) {
    return msg;
  }
  if (/WAF/i.test(msg) || /antibot/i.test(msg)) {
    return "WAF challenge page detected — try again later";
  }
  if (/Index parse returned 0/.test(msg)) {
    return "Index parse returned 0 rows — selectors may be stale, see health_check";
  }
  return `${toolName} failed: ${msg}`;
}

main().catch((err) => {
  log("error", "fatal error in main", {
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
