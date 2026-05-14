import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStaffDirectoryHtml } from "../../src/online/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(here, "..", "fixtures", "online", "staff.html"),
  "utf8",
);
const PAGE_URL = "https://www.online.msstate.edu/staff";

describe("parseStaffDirectoryHtml", () => {
  test("extracts at least 3 staff entries", () => {
    const entries = parseStaffDirectoryHtml(FIXTURE, PAGE_URL);
    assert.ok(entries.length >= 3, `got ${entries.length}`);
  });
  test("each entry has name and title", () => {
    const entries = parseStaffDirectoryHtml(FIXTURE, PAGE_URL);
    for (const e of entries) {
      assert.ok(e.name.length > 0);
      assert.ok(e.title.length > 0);
    }
  });
  test("at least one entry has @msstate.edu or @online.msstate.edu email", () => {
    const entries = parseStaffDirectoryHtml(FIXTURE, PAGE_URL);
    assert.ok(entries.some((e) => e.email && /@(online\.)?msstate\.edu$/.test(e.email)));
  });
  test("all entries reference the staff page URL", () => {
    const entries = parseStaffDirectoryHtml(FIXTURE, PAGE_URL);
    for (const e of entries) assert.ok(e.url.startsWith(PAGE_URL));
  });
});
