/**
 * Regression test for the v1.0.0/v1.0.1 stdio-bundle calendar bug.
 *
 * msstate-policies/src/calendars/corpus.ts had used
 * `dirname(fileURLToPath(import.meta.url))` to locate the synonyms sidecar.
 * esbuild's CJS output shims `import.meta` to `{}`, so `import.meta.url`
 * was undefined, `fileURLToPath` threw, and `loadAllCalendarRows()` aborted
 * before populating the in-memory index. `find_msu_date` and
 * `get_msu_calendar` silently returned empty results for every npm/plugin
 * user. v1.0.2 switched to `__dirname` (already the convention in
 * src/search.ts) and this test exists to catch the same class of bug.
 *
 * The check exercises the real ship surface: it spawns the built
 * `dist/index.js`, calls `find_msu_date` via JSON-RPC over stdio, and
 * asserts that calendar rows are actually returned.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "..", "dist", "index.js");

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content?: Array<{ text?: string }> };
  error?: { code: number; message: string };
}

function callBundle(payloads: object[], waitForId: number, timeoutMs = 20_000): Promise<JsonRpcResponse[]> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn("node", [DIST], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let stderr = "";
    const responses: JsonRpcResponse[] = [];
    let resolved = false;

    function finish(err?: Error): void {
      if (resolved) return;
      resolved = true;
      proc.kill("SIGTERM");
      if (err) rejectP(err);
      else resolveP(responses);
    }

    proc.stdout.on("data", (b: Buffer) => {
      out += b.toString();
      // Each newline-delimited JSON-RPC frame may arrive across chunks.
      // Re-scan all accumulated full lines on every chunk.
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("{")) continue; // skip pdf-parse "Warning: TT..." stdout noise
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          responses.push(msg);
          if (msg.id === waitForId) finish();
        } catch {
          // ignore
        }
      }
    });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    proc.on("error", (err) => finish(err));

    for (const p of payloads) {
      proc.stdin.write(JSON.stringify(p) + "\n");
    }

    setTimeout(() => {
      finish(new Error(`timed out waiting for response id=${waitForId}.\nstderr_tail=${stderr.slice(-600)}`));
    }, timeoutMs);
  });
}

describe("stdio bundle — calendar tools work after corpus load", () => {
  test("dist/index.js exists and is non-empty", () => {
    assert.ok(existsSync(DIST), `dist/index.js missing at ${DIST} — run \`npm run build\``);
    assert.ok(statSync(DIST).size > 1_000_000, "dist/index.js suspiciously small (<1 MB)");
  });

  test("find_msu_date returns non-empty matches via stdio bundle", async () => {
    const responses = await callBundle(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "regression", version: "0.0.0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_msu_date", arguments: { q: "fall semester" } } },
      ],
      2,
      25_000,
    );
    const call = responses.find((r) => r.id === 2);
    assert.ok(call, "no response to tools/call id=2");
    assert.equal(call.error, undefined, `tool errored: ${JSON.stringify(call.error)}`);
    const text = call.result?.content?.[0]?.text;
    assert.ok(typeof text === "string", "no text content in response");
    const parsed = JSON.parse(text) as { matches?: unknown[] };
    assert.ok(Array.isArray(parsed.matches), "matches missing or not array");
    assert.ok(
      parsed.matches.length > 0,
      "calendar index appears empty in the built bundle (synonyms-path or load-time regression?)",
    );
  });
});
