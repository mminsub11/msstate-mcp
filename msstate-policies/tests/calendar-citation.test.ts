import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCitation } from "../src/calendars/types.js";

test("formatCitation: event + term + url produces well-formed markdown link", () => {
  const c = formatCitation(
    "Spring Break",
    "Spring 2026",
    "https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring",
  );
  assert.equal(
    c,
    "[Spring Break, Spring 2026](https://www.registrar.msstate.edu/calendars/academic-calendar/2026/spring)",
  );
});

test("formatCitation: omits term when undefined (holidays / housing)", () => {
  const c = formatCitation(
    "Independence Day Holiday",
    undefined,
    "https://www.hrm.msstate.edu/benefits/holidays/",
  );
  assert.equal(c, "[Independence Day Holiday](https://www.hrm.msstate.edu/benefits/holidays/)");
});

test("formatCitation: truncates label longer than 80 chars with ellipsis", () => {
  const long = "Classes begin Maymester classes meet: May 18, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29";
  const c = formatCitation(long, "Maymester 2027", "https://example.com");
  const labelPart = c.slice(1, c.indexOf("]"));
  assert.ok(labelPart.endsWith("…"), `label should end with ellipsis; got: ${labelPart}`);
  assert.equal(labelPart.length, 78); // 77 chars + "…"
});
