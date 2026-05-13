import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFeesHtml } from "../../src/tuition/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(here, "..", "fixtures", "tuition", "other-enrollment-costs.html"),
  "utf8",
);
const FEES_URL = "https://www.controller.msstate.edu/accountservices/tuition/other-enrollment-costs";

describe("parseFeesHtml", () => {
  test("returns at least one college fee row", () => {
    const rows = parseFeesHtml(FIXTURE, FEES_URL);
    const college = rows.filter((r) => r.kind === "college");
    assert.ok(college.length >= 1, `got ${college.length} college rows`);
  });
  test("returns at least one program fee row", () => {
    const rows = parseFeesHtml(FIXTURE, FEES_URL);
    const program = rows.filter((r) => r.kind === "program");
    assert.ok(program.length >= 1, `got ${program.length} program rows`);
  });
  test("Engineering college fee has positive per_credit_usd", () => {
    const rows = parseFeesHtml(FIXTURE, FEES_URL);
    const eng = rows.find((r) => r.kind === "college" && /engineering/i.test(r.label));
    assert.ok(eng, "no Engineering college fee row");
    assert.ok(eng.per_credit_usd !== null && eng.per_credit_usd > 0, `per_credit_usd=${eng.per_credit_usd}`);
  });
  test("Honors College fee has flat_amount_usd of $75", () => {
    const rows = parseFeesHtml(FIXTURE, FEES_URL);
    const honors = rows.find((r) => /honors/i.test(r.label));
    assert.ok(honors, "no Honors College row");
    assert.equal(honors.flat_amount_usd, 75);
  });
  test("each row has source_url == page URL", () => {
    const rows = parseFeesHtml(FIXTURE, FEES_URL);
    for (const r of rows) assert.equal(r.source_url, FEES_URL);
  });
});
