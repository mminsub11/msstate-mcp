import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseGradIndex,
  parseGradPdfText,
} from "../src/calendars/parsers/pdf_calendar.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", "calendars", name), "utf8");
}
function fixtureBuf(name: string): Buffer {
  return readFileSync(join(here, "fixtures", "calendars", name));
}

test("parseGradIndex returns >= 3 PDF URLs from grad index", () => {
  const entries = parseGradIndex(fixture("grad_index.html"));
  assert.ok(entries.length >= 3, `expected >= 3 grad PDF entries; got ${entries.length}`);
  for (const e of entries) {
    assert.match(
      e.url,
      /^https:\/\/www\.grad\.msstate\.edu\/sites\/www\.grad\.msstate\.edu\/files\/.+\.pdf$/i,
      `URL must be a grad-school PDF: ${e.url}`,
    );
    assert.match(String(e.year), /^\d{4}$/);
    assert.ok(e.term.length > 0);
  }
});

test("parseGradPdfText extracts >= 5 dated rows from Spring 2026 PDF", async () => {
  const buf = fixtureBuf("grad_2026_spring.pdf");
  // Use the same library the parser uses to convert PDF → text.
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const parsed = await pdfParse(buf);
  const rows = parseGradPdfText(parsed.text, {
    url: "https://www.grad.msstate.edu/sites/www.grad.msstate.edu/files/2026-01/Spring%202026.pdf",
    year: 2026,
    term: "Spring",
  });
  assert.ok(rows.length >= 5, `expected >= 5 grad rows; got ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.source, "grad_school_calendar");
    assert.match(r.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.end, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(r.term, "Spring 2026");
  }
});

test("parseGradPdfText: at least one row mentions a grad-relevant deadline", async () => {
  const buf = fixtureBuf("grad_2026_spring.pdf");
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const parsed = await pdfParse(buf);
  const rows = parseGradPdfText(parsed.text, {
    url: "https://www.grad.msstate.edu/sites/www.grad.msstate.edu/files/2026-01/Spring%202026.pdf",
    year: 2026,
    term: "Spring",
  });
  const text = rows.map((r) => r.event.toLowerCase()).join(" | ");
  const recognizable = [
    "thesis",
    "dissertation",
    "graduation",
    "graduate",
    "comprehensive",
    "registration",
    "drop",
    "withdraw",
    "deadline",
    "classes",
    "exam",
    "final",
    "break",
    "commencement",
  ];
  const found = recognizable.some((k) => text.includes(k));
  assert.ok(found, `expected a grad-relevant keyword in: ${text.slice(0, 400)}`);
});

test("parseGradPdfText: deduplicates identical event-date rows within a single PDF", async () => {
  const buf = fixtureBuf("grad_2026_spring.pdf");
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const parsed = await pdfParse(buf);
  const rows = parseGradPdfText(parsed.text, {
    url: "https://www.grad.msstate.edu/sites/www.grad.msstate.edu/files/2026-01/Spring%202026.pdf",
    year: 2026,
    term: "Spring",
  });
  const keys = rows.map((r) => `${r.event}|${r.start}`);
  const unique = new Set(keys);
  assert.equal(keys.length, unique.size, "expected no duplicates within a single PDF");
});

test("parseGradPdfText: every row has a non-empty citation", async () => {
  const buf = fixtureBuf("grad_2026_spring.pdf");
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const parsed = await pdfParse(buf);
  const rows = parseGradPdfText(parsed.text, {
    url: "https://www.grad.msstate.edu/sites/www.grad.msstate.edu/files/2026-01/Spring%202026.pdf",
    year: 2026,
    term: "Spring",
  });
  for (const r of rows) {
    assert.ok(r.citation.length > 0, `empty citation on row: ${r.event}`);
    assert.match(r.citation, /^\[.+\]\(https:\/\/www\.grad\.msstate\.edu.+\.pdf\)$/);
  }
});
