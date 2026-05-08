import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIndexHtml, __test__ } from "../src/scraper.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "current.html");

test("policy number regex accepts NN.NN and NN.NNN", () => {
  const re = __test__.POLICY_NUMBER_RE;
  assert.ok(re.test("01.01"));
  assert.ok(re.test("91.100"));
  assert.ok(re.test("60.321"));
  assert.ok(!re.test("1.01"));
  assert.ok(!re.test("01.0"));
  assert.ok(!re.test("policy"));
});

test("parseIndexHtml extracts the expected shape from the fixture", () => {
  if (!existsSync(fixturePath)) {
    console.warn(`scraper.test: ${fixturePath} missing; skipping`);
    return;
  }
  const html = readFileSync(fixturePath, "utf8");
  const parsed = parseIndexHtml(html);

  assert.ok(parsed.rows.length >= 100, `expected >= 100 rows, got ${parsed.rows.length}`);
  assert.ok(parsed.volumes.length >= 1, "expected at least one volume entry");
  assert.ok(parsed.sections.length >= 1, "expected at least one section entry");

  const numbers = new Set(parsed.rows.map((r) => r.number));
  assert.ok(numbers.has("01.01"), "expected 01.01 in fixture");
  assert.ok(numbers.has("91.100"), "expected 91.100 (NN.NNN) in fixture");

  const first = parsed.rows.find((r) => r.number === "01.01");
  assert.ok(first, "01.01 row missing");
  assert.equal(first!.slug, "0101");
  assert.match(first!.landingUrl, /\/policy\/0101$/);
  assert.match(first!.pdfUrl, /\/files\/policies\/0101\.pdf$/);
  assert.equal(first!.status, "Current");
  assert.match(first!.firstAuthoredOrSorted ?? "", /^\d{4}-\d{2}-\d{2}T/);

  // Taxonomy: the "All" sentinel must NOT be in the parsed taxonomy.
  for (const v of parsed.volumes) {
    assert.notEqual(v.id.toLowerCase(), "all");
  }
});

test("only valid NN.NN/NN.NNN numbers are emitted", () => {
  if (!existsSync(fixturePath)) return;
  const html = readFileSync(fixturePath, "utf8");
  const parsed = parseIndexHtml(html);
  for (const r of parsed.rows) {
    assert.match(r.number, /^\d{2}\.(\d{2}|\d{3})$/, `bad number passed through: ${r.number}`);
  }
});

test("normalizeText collapses double spaces and normalizes form", () => {
  const input = "Section 1 — “smart quotes”  and\nfire safety";
  const out = __test__.normalizeText(input);
  assert.ok(out.length > 0);
  assert.ok(!out.includes("  "), "double spaces should collapse");
  assert.ok(out.toLowerCase().includes("fire"));
});

test("looksLikeDataTable detects the table marker", () => {
  if (!existsSync(fixturePath)) return;
  const html = readFileSync(fixturePath, "utf8");
  assert.ok(__test__.looksLikeDataTable(html));
  assert.ok(!__test__.looksLikeDataTable("<html><body>nothing here</body></html>"));
});
