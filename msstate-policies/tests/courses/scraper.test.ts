import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractCourseCodesFromDeptHtml,
  extractDeptPagesFromIndexHtml,
  fetchCourseDetail,
  withFetchInjected,
} from "../../src/courses/scraper.js";
import type { Course } from "../../src/courses/types.js";

function fixture(name: string): string {
  return readFileSync(
    resolve(__dirname, "..", "fixtures", "courses", name),
    "utf8",
  );
}

describe("extractCourseCodesFromDeptHtml", () => {
  test("finds CSE codes on the CSE dept page", () => {
    const codes = extractCourseCodesFromDeptHtml(fixture("cse-dept.html"));
    // CSE 1011, 1284, 1384 are required intro classes — they must be present.
    for (const e of ["CSE 1011", "CSE 1284", "CSE 1384"]) {
      assert.ok(
        codes.includes(e),
        `expected ${JSON.stringify(codes)} to contain ${e}`,
      );
    }
  });

  test("dedupes courses that appear in multiple program tables", () => {
    const codes = extractCourseCodesFromDeptHtml(fixture("cse-dept.html"));
    const unique = new Set(codes);
    assert.equal(unique.size, codes.length);
  });

  test("rejects invalid course-code text content", () => {
    // Constructed page with one valid + one bogus bubblelink.
    const html = `
      <a class="bubblelink code" href="/search/?P=CSE%204153">CSE 4153</a>
      <a class="bubblelink code" href="/search/?P=FAKE">not a code</a>
      <a class="bubblelink code" href="/search/?P=DROP%20TABLE">DROP TABLE</a>`;
    const codes = extractCourseCodesFromDeptHtml(html);
    assert.deepEqual(codes, ["CSE 4153"]);
  });
});

describe("extractDeptPagesFromIndexHtml", () => {
  test("finds dept-page hrefs (undergrad + grad)", () => {
    const pages = extractDeptPagesFromIndexHtml(fixture("azindex.html"));
    assert.ok(pages.length > 20, `expected ${pages.length} > 20`);
    for (const p of pages) {
      assert.match(p, /^https:\/\/catalog\.msstate\.edu\//);
    }
  });

  test("rejects URLs outside catalog.msstate.edu", () => {
    const html = `
      <a href="/undergraduate/foo/">ok</a>
      <a href="https://evil.example.com/">no</a>
      <a href="https://catalog.msstate.edu/undergraduate/x/">also ok</a>`;
    const pages = extractDeptPagesFromIndexHtml(html);
    for (const e of [
      "https://catalog.msstate.edu/undergraduate/foo/",
      "https://catalog.msstate.edu/undergraduate/x/",
    ]) {
      assert.ok(
        pages.includes(e),
        `expected ${JSON.stringify(pages)} to contain ${e}`,
      );
    }
    assert.equal(pages.find((p) => p.includes("evil.example.com")), undefined);
  });
});

describe("fetchCourseDetail", () => {
  test("returns a parsed Course on 200", async () => {
    const html = fixture("cse-4153.html");
    const fake = async (url: string) => {
      assert.equal(url, "https://catalog.msstate.edu/search/?P=CSE%204153");
      return { ok: true, status: 200, text: async () => html };
    };
    const result = await withFetchInjected(fake as unknown as typeof fetch, () =>
      fetchCourseDetail("CSE 4153"),
    );
    assert.equal(result.code, "CSE 4153");
  });

  test("throws CatalogWafError on Cloudflare interstitial", async () => {
    const fake = async () => ({
      ok: true,
      status: 200,
      text: async () => "Just a moment...",
    });
    await assert.rejects(
      withFetchInjected(fake as unknown as typeof fetch, () =>
        fetchCourseDetail("CSE 4153"),
      ),
      /WAF/,
    );
  });

  test("rejects an invalid course code without making a request", async () => {
    let called = false;
    const fake = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "" };
    };
    await assert.rejects(
      withFetchInjected(fake as unknown as typeof fetch, () =>
        fetchCourseDetail("DROP TABLE"),
      ),
    );
    assert.equal(called, false);
  });
});

describe("scrapeAllCourses — dept-page fetch parallelism", () => {
  test("dept pages run through the bounded pool, not serially", async () => {
    const events: string[] = [];
    const deptUrls = [
      "https://catalog.msstate.edu/undergraduate/a/",
      "https://catalog.msstate.edu/undergraduate/b/",
      "https://catalog.msstate.edu/undergraduate/c/",
      "https://catalog.msstate.edu/undergraduate/d/",
    ];
    const fetchIndex = async () => deptUrls.map((u) => `<a href="${u}">dept</a>`).join("");
    const fetchDept = async (u: string) => {
      events.push(`start:${u}`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`end:${u}`);
      return "<table></table>";
    };
    const { scrapeAllCourses } = await import("../../src/courses/scraper.js");
    await scrapeAllCourses({ fetchIndex, fetchDept } as any).catch(() => {});
    const firstEndIdx = events.findIndex((e) => e.startsWith("end:"));
    const startsBeforeFirstEnd = events.slice(0, firstEndIdx).filter((e) => e.startsWith("start:")).length;
    assert.ok(startsBeforeFirstEnd >= 2, `expected concurrent dept fetches; saw ${startsBeforeFirstEnd}`);
  });
});
