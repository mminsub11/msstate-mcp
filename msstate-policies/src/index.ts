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
import { health_check } from "./tools/health_check.js";

// Deterministic order — referenced in the README and CI smoke test.
const TOOLS = [
  search_policies,
  get_policy,
  chain_find_relevant_policies,
  cite_policy,
  health_check,
] as const;

type ToolDef = (typeof TOOLS)[number];

const TOOLS_BY_NAME = new Map<string, ToolDef>(
  TOOLS.map((t) => [t.name, t]),
);

declare const __VERSION__: string;
declare const __GIT_SHA__: string;

function getStringConst(name: "__VERSION__" | "__GIT_SHA__"): string {
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return typeof ${name} !== "undefined" ? ${name} : ""`)();
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const version = getStringConst("__VERSION__") || "unknown";
  const gitSha = getStringConst("__GIT_SHA__") || "unknown";

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
