import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProgramHtml } from "../../src/online/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "..", "fixtures", "online", name), "utf8");
}
const MBA_URL = "https://www.online.msstate.edu/mba";
const BSEE_URL = "https://www.online.msstate.edu/bsee";

describe("parseProgramHtml — MBA structured fields", () => {
  test("extracts program name verbatim", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    assert.match(p.name, /business administration/i);
  });
  test("extracts at least one contact with an @msstate.edu or @business.msstate.edu email", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    const withEmail = p.contacts.find((c) => c.email && /@(business\.)?msstate\.edu$/.test(c.email));
    assert.ok(withEmail, `no contact with @msstate.edu email; got ${JSON.stringify(p.contacts)}`);
  });
  test("extracts MBA application deadline mentioning August", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    const fall = p.application_deadlines.find((d) => /august/i.test(d.date_text));
    assert.ok(fall, `no August deadline; got ${JSON.stringify(p.application_deadlines)}`);
  });
  test("tuition.per_credit_usd is positive", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    assert.ok((p.tuition.per_credit_usd ?? 0) > 0, `expected positive; got ${p.tuition.per_credit_usd}`);
  });
  test("admission_requirements section is non-empty", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    assert.ok(p.admission_requirements.length > 0);
  });
  test("raw_sections has at least 3 entries", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    assert.ok(Object.keys(p.raw_sections).length >= 3);
  });
  test("emits no parse_warnings when fully parsed", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    assert.deepEqual(p.parse_warnings, []);
  });
});

describe("parseProgramHtml — BSEE (bachelor)", () => {
  test("extracts contacts AND application deadlines", () => {
    const p = parseProgramHtml(fixture("program-bsee.html"), "bsee", "bachelor", BSEE_URL);
    assert.ok(p);
    assert.ok(p.contacts.length >= 1);
    assert.ok(p.application_deadlines.length >= 1);
  });
});

describe("parseProgramHtml — empty input fallback", () => {
  test("returns a record with parse_warnings when page is empty", () => {
    const p = parseProgramHtml(
      "<html><body><p>nothing useful</p></body></html>",
      "empty",
      "certificate",
      "https://www.online.msstate.edu/empty",
    );
    assert.ok(p);
    assert.ok(p.parse_warnings.includes("no_contacts_extracted"));
    assert.ok(p.parse_warnings.includes("no_deadlines_extracted"));
  });
});
