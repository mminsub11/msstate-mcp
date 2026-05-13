import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { search_msu_courses } from "../../src/tools/search_msu_courses.js";
import { setCourseCorpus, __resetCourseCorpusForTests } from "../../src/courses/corpus.js";
import type { CourseCorpus } from "../../src/courses/types.js";

const CORPUS: CourseCorpus = {
  version: "test",
  scraped_at: "2026-05-12T00:00:00Z",
  records: {
    "CSE 4153": {
      code: "CSE 4153", title: "Data Communications and Computer Networks",
      hours: 3, level: "undergraduate",
      description: "Networking concepts.", semester_offered: null,
      prereqs: null, coreqs: null, cross_listed: [],
      source_url: "https://catalog.msstate.edu/search/?P=CSE%204153",
      prereq_summary: null,
    },
    "CSE 4733": {
      code: "CSE 4733", title: "Operating Systems I",
      hours: 3, level: "undergraduate",
      description: "OS concepts.", semester_offered: null,
      prereqs: null, coreqs: null, cross_listed: [],
      source_url: "https://catalog.msstate.edu/search/?P=CSE%204733",
      prereq_summary: null,
    },
  },
  forward_dag: {}, reverse_dag: {},
};

before(() => setCourseCorpus(CORPUS));

describe("search_msu_courses", () => {
  test("returns a ranked list", async () => {
    const res = await search_msu_courses.handler({ q: "networks" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.matches[0].code, "CSE 4153");
  });

  test("rejects empty q", async () => {
    await assert.rejects(search_msu_courses.handler({ q: "" }));
  });

  test("rejects oversized q (> MAX_QUERY_CHARS)", async () => {
    await assert.rejects(
      search_msu_courses.handler({ q: "a".repeat(5000) }),
    );
  });

  test("respects limit", async () => {
    const res = await search_msu_courses.handler({ q: "course", limit: 1 });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.matches.length <= 1);
  });
});

describe("search_msu_courses — corpus unloaded", () => {
  test("returns a structured error when the course corpus is not loaded", async () => {
    __resetCourseCorpusForTests();
    const res = await search_msu_courses.handler({ q: "calculus" });
    assert.equal(res.isError, true);
    const text = res.content[0].text;
    assert.match(text, /course corpus not loaded/i);
  });
});
