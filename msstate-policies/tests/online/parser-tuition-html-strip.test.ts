import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseProgramHtml } from "../../src/online/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(__dirname, "..", "fixtures", "online", "tuition-with-gtm-iframe.html"),
  "utf8",
);

test("tuition.raw_prose strips chrome element text content", () => {
  const program = parseProgramHtml(
    FIXTURE,
    "test-tuition-clean",
    "master",
    "https://www.online.msstate.edu/program/test-tuition-clean",
    "Test program for tuition HTML cleanup.",
  );
  const prose = program.tuition.raw_prose;
  assert.ok(prose.length > 0, "raw_prose should be non-empty");

  // Sanity: real tuition text survived
  assert.match(prose, /tuition per credit hour/i, "expected tuition text to survive strip");
  assert.match(prose, /\$525/, "expected tuition value to survive strip");

  // Chrome text content that must NOT leak (from inside <main>, descendants of cowbell.parent()):
  const forbidden = [
    "googletagmanager",        // from inside <noscript> <iframe src=...>
    "GTM noscript fallback",   // text node inside <noscript>
    "About Contact Apply",     // <nav> text content
    "MSU Online Header",       // <header> text content
    "Copyright MSU Online",    // <footer> text content
    "analytics tracking",      // <script> text content
    "chrome { display",        // <style> text content
  ];
  for (const needle of forbidden) {
    assert.equal(
      prose.toLowerCase().includes(needle.toLowerCase()),
      false,
      `raw_prose leaked chrome text "${needle}": ${prose.slice(0, 400)}`,
    );
  }
});
