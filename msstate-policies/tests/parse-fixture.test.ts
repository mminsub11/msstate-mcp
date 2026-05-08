import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const pdfPath = join(here, "fixtures", "91100.pdf");

test("pdf-parse extracts text from the fixture PDF", async () => {
  if (!existsSync(pdfPath)) {
    console.warn(`parse-fixture.test: ${pdfPath} missing; skipping`);
    return;
  }
  const buf = readFileSync(pdfPath);
  const parsed = await pdfParse(buf);
  assert.ok(parsed.numpages > 0, "expected non-zero page count");
  assert.ok(parsed.text.length > 200, `expected reasonable text length; got ${parsed.text.length}`);
  // We don't assert on policy *content* here — that would couple the test to
  // MSU's wording, which can change. Shape only.
});
