import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFaqHtml } from "../../src/tuition/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(here, "..", "fixtures", "tuition", "faq.html"),
  "utf8",
);
const FAQ_URL = "https://www.controller.msstate.edu/accountservices/tuition/frequently-asked-questions";

describe("parseFaqHtml", () => {
  test("extracts exactly 14 Q&A pairs from the fixture", () => {
    const rows = parseFaqHtml(FIXTURE, FAQ_URL);
    assert.equal(rows.length, 14, `got ${rows.length}`);
  });
  test("each row has non-empty question and answer", () => {
    const rows = parseFaqHtml(FIXTURE, FAQ_URL);
    for (const r of rows) {
      assert.ok(r.question.length > 0);
      assert.ok(r.answer.length > 0);
    }
  });
  test("each row's source_url starts with the page URL", () => {
    const rows = parseFaqHtml(FIXTURE, FAQ_URL);
    for (const r of rows) {
      assert.ok(r.source_url.startsWith(FAQ_URL));
    }
  });
  test("includes the campus question", () => {
    const rows = parseFaqHtml(FIXTURE, FAQ_URL);
    const found = rows.find((r) => /campus/i.test(r.question));
    assert.ok(found, "expected a question mentioning 'campus'");
  });
  test("returns empty array on input with no FAQ structure", () => {
    const rows = parseFaqHtml("<html><body><p>nothing</p></body></html>", FAQ_URL);
    assert.deepEqual(rows, []);
  });
});
