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
import { health_check } from "./tools/health_check.js";

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
