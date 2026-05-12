import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractCourseCodesFromDeptHtml,
  extractDeptPagesFromIndexHtml,
} from "../../src/courses/scraper.js";

function fixture(name: string): string {
  return readFileSync(
    resolve(__dirname, "..", "fixtures", "courses", name),
    "utf8",
  );
}

describe("extractCourseCodesFromDeptHtml", () => {
  it("finds CSE codes on the CSE dept page", () => {
    const codes = extractCourseCodesFromDeptHtml(fixture("cse-dept.html"));
    // CSE 1011, 1284, 1384 are required intro classes — they must be present.
    expect(codes).toEqual(expect.arrayContaining(["CSE 1011", "CSE 1284", "CSE 1384"]));
  });

  it("dedupes courses that appear in multiple program tables", () => {
    const codes = extractCourseCodesFromDeptHtml(fixture("cse-dept.html"));
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it("rejects invalid course-code text content", () => {
    // Constructed page with one valid + one bogus bubblelink.
    const html = `
      <a class="bubblelink code" href="/search/?P=CSE%204153">CSE 4153</a>
      <a class="bubblelink code" href="/search/?P=FAKE">not a code</a>
      <a class="bubblelink code" href="/search/?P=DROP%20TABLE">DROP TABLE</a>`;
    const codes = extractCourseCodesFromDeptHtml(html);
    expect(codes).toEqual(["CSE 4153"]);
  });
});

describe("extractDeptPagesFromIndexHtml", () => {
  it("finds dept-page hrefs (undergrad + grad)", () => {
    const pages = extractDeptPagesFromIndexHtml(fixture("azindex.html"));
    expect(pages.length).toBeGreaterThan(20);
    for (const p of pages) {
      expect(p).toMatch(/^https:\/\/catalog\.msstate\.edu\//);
    }
  });

  it("rejects URLs outside catalog.msstate.edu", () => {
    const html = `
      <a href="/undergraduate/foo/">ok</a>
      <a href="https://evil.example.com/">no</a>
      <a href="https://catalog.msstate.edu/undergraduate/x/">also ok</a>`;
    const pages = extractDeptPagesFromIndexHtml(html);
    expect(pages).toEqual(
      expect.arrayContaining([
        "https://catalog.msstate.edu/undergraduate/foo/",
        "https://catalog.msstate.edu/undergraduate/x/",
      ]),
    );
    expect(pages.find((p) => p.includes("evil.example.com"))).toBeUndefined();
  });
});
