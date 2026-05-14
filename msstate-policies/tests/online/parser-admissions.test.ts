import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdmissionsProcessHtml } from "../../src/online/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(here, "..", "fixtures", "online", "admissions-process.html"),
  "utf8",
);
const PAGE_URL = "https://www.online.msstate.edu/admissions-process";

describe("parseAdmissionsProcessHtml", () => {
  test("all 5 student-type sections present and non-empty", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    for (const st of ["undergraduate", "graduate", "transfer", "readmit", "international"]) {
      assert.ok(p.sections[st as keyof typeof p.sections], `missing section: ${st}`);
      assert.ok(p.sections[st as keyof typeof p.sections].length > 0, `empty section: ${st}`);
    }
  });
  test("central_contact email is ask@online.msstate.edu", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    assert.equal(p.central_contact.email, "ask@online.msstate.edu");
  });
  test("central_contact phone matches (662) 325-3473", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    assert.ok((p.central_contact.phone ?? "").replace(/\D/g, "").endsWith("6623253473"));
  });
  test("shared_prelude is non-empty", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    assert.ok(p.shared_prelude.length > 0);
  });
  test("application_fee_tiers has at least 2 entries", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    assert.ok(p.application_fee_tiers.length >= 2);
    for (const t of p.application_fee_tiers) {
      assert.ok(t.kind.length > 0);
      assert.ok(t.usd > 0);
    }
  });
  test("external_apply_urls includes apply.msstate.edu and grad.msstate.edu", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    const urls = p.external_apply_urls.map((u) => u.url);
    assert.ok(urls.some((u) => /apply\.msstate\.edu/.test(u)));
    assert.ok(urls.some((u) => /grad\.msstate\.edu/.test(u)));
  });
});
