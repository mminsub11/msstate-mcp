import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedEmergencyUrl,
  detectEmergencyWaf,
  scrapeAllEmergency,
} from "../../src/emergency/scraper.js";
import { EXPECTED_GUIDELINE_SLUGS } from "../../src/emergency/types.js";

describe("isAllowedEmergencyUrl", () => {
  test("accepts canonical hosts under emergency.msstate.edu", () => {
    assert.equal(isAllowedEmergencyUrl("https://www.emergency.msstate.edu/guidelines/earthquake"), true);
    assert.equal(isAllowedEmergencyUrl("https://www.emergency.msstate.edu/refuge"), true);
  });
  test("rejects non-msstate hosts", () => {
    assert.equal(isAllowedEmergencyUrl("https://evil.example.com/refuge"), false);
    assert.equal(isAllowedEmergencyUrl("https://emergency.msstate.edu.attacker.com/refuge"), false);
  });
  test("rejects http://", () => {
    assert.equal(isAllowedEmergencyUrl("http://www.emergency.msstate.edu/refuge"), false);
  });
});

describe("detectEmergencyWaf", () => {
  test("flags Cloudflare challenge markers", () => {
    assert.equal(detectEmergencyWaf("Just a moment..."), true);
    assert.equal(detectEmergencyWaf("<div id=cf-chl-bypass>"), true);
  });
  test("passes normal HTML", () => {
    assert.equal(detectEmergencyWaf("<main><h1>Tornado</h1></main>"), false);
  });
});

describe("scrapeAllEmergency", () => {
  test("happy path: 12 guidelines + refuge rows + contacts, no errors", async () => {
    const guidelineHtml = (slug: string) => `<main><h1 class="page-title">${slug}</h1><p>Body for ${slug} with enough text to clear the 200-character body floor. Adding more text to make sure body_markdown is longer than 200 chars. Lorem ipsum dolor sit amet consectetur adipiscing elit.</p></main>`;
    const refuge = `<main>
      <p>Buildings marked with * are available during normal operations only.</p>
      <h3>Important Contacts</h3>
      <ul><li><a href="tel:911">EMERGENCY: 911</a> <strong>911</strong></li></ul>
      <h4>Campus Contacts (non-emergency)</h4>
      <ul><li><a href="tel:(662) 325-2121">MSU Police</a> <strong>(662) 325-2121</strong></li></ul>
      <h4>Off Campus Contacts (non-emergency)</h4>
      <ul><li><a href="tel:(662) 323-4134">Starkville PD</a> <strong>(662) 323-4134</strong></li></ul>
      <table class="table"><tbody>
        <tr><td>Colvard Student Union*</td><td>Room 123</td></tr>
        <tr><td>Lee Hall</td><td>Basement areas</td></tr>
        <tr><td>Allen Hall</td><td>First-floor rooms</td></tr>
        <tr><td>McCool Hall</td><td>First-floor rooms</td></tr>
        <tr><td>Mitchell Library</td><td>First-floor rooms</td></tr>
      </tbody></table>
    </main>`;
    const fakeFetch = async (url: string) => {
      if (url.endsWith("/refuge")) return refuge;
      const slug = url.split("/").pop()!;
      return guidelineHtml(slug);
    };
    const r = await scrapeAllEmergency({ fetchUrl: fakeFetch });
    assert.equal(r.guidelines.length, 12);
    assert.equal(new Set(r.guidelines.map((g) => g.slug)).size, 12);
    for (const slug of EXPECTED_GUIDELINE_SLUGS) {
      assert.ok(r.guidelines.find((g) => g.slug === slug), `missing slug: ${slug}`);
    }
    assert.ok(r.refuge_areas.length >= 5);
    assert.ok(r.contacts.find((c) => c.phone === "911"));
    assert.equal(r.anyError, false);
  });
  test("aliases are reverse-indexed onto guidelines", async () => {
    const guidelineHtml = (slug: string) => `<main><h1 class="page-title">${slug}</h1><p>Body for ${slug} with enough text to clear the 200-character body floor. Adding more text to make sure body_markdown is longer than 200 chars. Lorem ipsum dolor sit amet consectetur adipiscing elit.</p></main>`;
    const refuge = `<main><h3>Important Contacts</h3><ul><li><a>EMERGENCY: 911</a><strong>911</strong></li></ul><table><tbody><tr><td>A</td><td>a</td></tr><tr><td>B</td><td>b</td></tr><tr><td>C</td><td>c</td></tr><tr><td>D</td><td>d</td></tr><tr><td>E</td><td>e</td></tr></tbody></table></main>`;
    const r = await scrapeAllEmergency({
      fetchUrl: async (u) => (u.endsWith("/refuge") ? refuge : guidelineHtml(u.split("/").pop()!)),
    });
    const tornado = r.guidelines.find((g) => g.slug === "severe-weather-tornado")!;
    assert.ok(tornado.aliases.includes("tornado"));
    assert.ok(tornado.aliases.includes("severe weather"));
  });
  test("rejects WAF-challenged HTML", async () => {
    await assert.rejects(
      () =>
        scrapeAllEmergency({
          fetchUrl: async () => "Just a moment...",
        }),
      /WAF/,
    );
  });
});
