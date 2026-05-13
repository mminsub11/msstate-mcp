import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseGuidelineHtml } from "../../src/emergency/parser.js";
import { parseRefugeHtml } from "../../src/emergency/parser.js";
import { parseContactsHtml } from "../../src/emergency/parser.js";

const SAMPLE_HTML = `<!doctype html><html><body>
  <main>
    <h1 class="page-title">Severe Weather &amp; Tornado</h1>
    <h2>Before</h2>
    <p>Sign up for MaroonAlert.</p>
    <ul><li>Identify the lowest interior room.</li><li>Practice the route.</li></ul>
    <h2>During</h2>
    <p>Go to the nearest Severe Weather Refuge Area.</p>
    <p>Stay away from windows.</p>
  </main>
</body></html>`;

describe("parseGuidelineHtml", () => {
  test("extracts title from h1.page-title", () => {
    const r = parseGuidelineHtml(SAMPLE_HTML, "severe-weather-tornado");
    assert.equal(r?.title, "Severe Weather & Tornado");
  });
  test("body_markdown preserves headings and list bullets", () => {
    const r = parseGuidelineHtml(SAMPLE_HTML, "severe-weather-tornado");
    assert.ok(r);
    assert.match(r.body_markdown, /^## Before$/m);
    assert.match(r.body_markdown, /^- Identify the lowest interior room\.$/m);
    assert.match(r.body_markdown, /Stay away from windows\./);
  });
  test("body_markdown strips HTML tags", () => {
    const r = parseGuidelineHtml(SAMPLE_HTML, "severe-weather-tornado");
    assert.ok(r);
    assert.doesNotMatch(r.body_markdown, /<[a-z]/i);
  });
  test("returns null when <main> is missing", () => {
    const r = parseGuidelineHtml("<html><body><p>no main</p></body></html>", "x");
    assert.equal(r, null);
  });
  test("slug + url populated by the function", () => {
    const r = parseGuidelineHtml(SAMPLE_HTML, "severe-weather-tornado");
    assert.equal(r?.slug, "severe-weather-tornado");
    assert.equal(r?.url, "https://www.emergency.msstate.edu/guidelines/severe-weather-tornado");
  });
  test("falls back to plain h1 when h1.page-title is absent", () => {
    const html = `<!doctype html><html><body>
    <main>
      <h1>Plain Heading Only</h1>
      <p>Body text that is long enough to qualify.</p>
    </main>
  </body></html>`;
    const r = parseGuidelineHtml(html, "test-slug");
    assert.equal(r?.title, "Plain Heading Only");
  });
});

const REFUGE_HTML = `<!doctype html><html><body><main>
  <h1>Severe Weather Refuge Areas</h1>
  <p>Buildings marked with * are available during normal operations only.</p>
  <table class="table">
    <thead><tr><th>Building</th><th>Area Description</th></tr></thead>
    <tbody>
      <tr><td>Colvard Student Union*</td><td>Room 123, first floor.</td></tr>
      <tr><td>Lee Hall</td><td>Basement hallway areas 0010, 0011.</td></tr>
    </tbody>
  </table>
</main></body></html>`;

describe("parseRefugeHtml", () => {
  test("extracts rows from the refuge table", () => {
    const rows = parseRefugeHtml(REFUGE_HTML);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].building, "Lee Hall");
    assert.match(rows[1].area, /Basement hallway/);
    assert.equal(rows[1].note, null);
  });
  test("strips the * glyph from building name and resolves footnote to note", () => {
    const rows = parseRefugeHtml(REFUGE_HTML);
    assert.equal(rows[0].building, "Colvard Student Union");
    assert.match(rows[0].note ?? "", /normal operations only/i);
  });
  test("returns empty array when no table is found", () => {
    assert.deepEqual(parseRefugeHtml("<main><p>nothing</p></main>"), []);
  });
});

const CONTACTS_HTML = `<!doctype html><html><body><main>
  <h3>Important Contacts</h3>
  <ul>
    <li><a href="tel:911">EMERGENCY: 911</a> <strong>911</strong></li>
  </ul>
  <h4>Campus Contacts (non-emergency)</h4>
  <ul>
    <li><a href="tel:(662) 325-2121">Mississippi State University Police</a> <strong>(662) 325-2121</strong></li>
    <li><a href="tel:(662) 325-2091">Student Counseling Services</a> <strong>(662) 325-2091</strong></li>
  </ul>
  <h4>Off Campus Contacts (non-emergency)</h4>
  <ul>
    <li><a href="tel:(662) 323-4134">Starkville Police Department</a> <strong>(662) 323-4134</strong></li>
  </ul>
</main></body></html>`;

describe("parseContactsHtml", () => {
  test("classifies 911 as emergency category", () => {
    const rows = parseContactsHtml(CONTACTS_HTML);
    const e = rows.find((r) => r.phone === "911");
    assert.ok(e, "expected 911 row");
    assert.equal(e!.category, "emergency");
    assert.match(e!.label, /EMERGENCY/i);
  });
  test("classifies MSU PD as campus_non_emergency", () => {
    const rows = parseContactsHtml(CONTACTS_HTML);
    const r = rows.find((r) => /Mississippi State University Police/i.test(r.label));
    assert.equal(r?.category, "campus_non_emergency");
    assert.equal(r?.phone, "(662) 325-2121");
  });
  test("classifies Starkville PD as off_campus_non_emergency", () => {
    const rows = parseContactsHtml(CONTACTS_HTML);
    const r = rows.find((r) => /Starkville Police/i.test(r.label));
    assert.equal(r?.category, "off_campus_non_emergency");
  });
  test("returns empty array when 'Important Contacts' is absent", () => {
    assert.deepEqual(parseContactsHtml("<main><p>nothing</p></main>"), []);
  });
});

describe("parseGuidelineHtml — no duplicate content", () => {
  test("a div-wrapped paragraph is emitted once, not twice", () => {
    const html = `<main>
      <h1 class="page-title">Severe Weather</h1>
      <div><p>Seek refuge during a tornado.</p></div>
      <p>Final paragraph.</p>
    </main>`;
    const r = parseGuidelineHtml(html, "severe-weather");
    assert.ok(r);
    const occurrences = (r!.body_markdown.match(/Seek refuge during a tornado\./g) ?? []).length;
    assert.equal(occurrences, 1, `expected exactly 1 occurrence, got ${occurrences}`);
  });
});
