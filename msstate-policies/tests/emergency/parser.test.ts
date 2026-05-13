import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseGuidelineHtml } from "../../src/emergency/parser.js";

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
});
