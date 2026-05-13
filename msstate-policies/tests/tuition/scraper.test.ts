import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeAllTuition, isAllowedTuitionUrl, detectTuitionWaf } from "../../src/tuition/scraper.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "..", "fixtures", "tuition", name), "utf8");
}

const STUB: Record<string, string> = {
  "https://www.controller.msstate.edu/accountservices/tuition": fixture("landing.html"),
  "https://www.controller.msstate.edu/accountservices/tuition/frequently-asked-questions": fixture("faq.html"),
  "https://www.controller.msstate.edu/accountservices/tuition/other-enrollment-costs": fixture("other-enrollment-costs.html"),
  "https://www.controller.msstate.edu/accountservices/tuition/select-your-campus": fixture("select-your-campus.html"),
  "https://www.controller.msstate.edu/accountservices/tuition/starkville-campus": fixture("starkville.html"),
  "https://www.controller.msstate.edu/accountservices/tuition/meridian-campus": fixture("meridian.html"),
  "https://www.controller.msstate.edu/accountservices/tuition/mgccc-campus-rates": fixture("mgccc.html"),
  "https://www.controller.msstate.edu/accountservices/tuition/online-education-rates": fixture("online.html"),
  "https://www.vetmed.msstate.edu/tuition": fixture("vetmed.html"),
};

async function stubFetch(url: string): Promise<string> {
  if (!(url in STUB)) throw new Error(`unexpected url: ${url}`);
  return STUB[url];
}

describe("scraper.isAllowedTuitionUrl", () => {
  test("accepts every URL in TUITION_ROOTS", () => {
    for (const u of Object.keys(STUB)) assert.ok(isAllowedTuitionUrl(u), u);
  });
  test("rejects non-msstate hosts", () => {
    assert.equal(isAllowedTuitionUrl("https://example.com/foo"), false);
  });
  test("rejects http (non-TLS)", () => {
    assert.equal(isAllowedTuitionUrl("http://www.controller.msstate.edu/accountservices/tuition"), false);
  });
});

describe("scraper.detectTuitionWaf", () => {
  test("flags Cloudflare challenge body", () => {
    assert.equal(detectTuitionWaf("<html>Just a moment...</html>"), true);
  });
  test("clean HTML returns false", () => {
    assert.equal(detectTuitionWaf("<html><body><h1>Tuition</h1></body></html>"), false);
  });
});

describe("scraper.scrapeAllTuition", () => {
  test("produces rate_rows, fee_rows, faq_rows, and 5 campuses", async () => {
    const r = await scrapeAllTuition({ fetchUrl: stubFetch });
    assert.ok(r.rate_rows.length >= 40, `got ${r.rate_rows.length} rate rows`);
    assert.ok(r.fee_rows.length >= 5, `got ${r.fee_rows.length} fee rows`);
    assert.ok(r.faq_rows.length >= 10, `got ${r.faq_rows.length} faq rows`);
    assert.equal(r.campuses.length, 5);
    assert.equal(r.anyError, false);
  });
  test("retrieved_at is set on every row", async () => {
    const r = await scrapeAllTuition({ fetchUrl: stubFetch });
    for (const row of [...r.rate_rows, ...r.fee_rows, ...r.faq_rows]) {
      assert.match(row.retrieved_at, /^\d{4}-\d{2}-\d{2}T/);
    }
  });
  test("flags anyError=true on per-source failure", async () => {
    const broken: typeof stubFetch = async (url) => {
      if (url.endsWith("/meridian-campus")) throw new Error("HTTP 500");
      return stubFetch(url);
    };
    const r = await scrapeAllTuition({ fetchUrl: broken });
    assert.equal(r.anyError, true);
    assert.match(r.per_source["meridian-campus"]?.error ?? "", /500/);
  });
});
