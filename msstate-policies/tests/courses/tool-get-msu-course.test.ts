import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { get_msu_course } from "../../src/tools/get_msu_course.js";
import { setCourseCorpus } from "../../src/courses/corpus.js";
import type { CourseCorpus } from "../../src/courses/types.js";

const CORPUS: CourseCorpus = {
  version: "test", scraped_at: "2026-05-12T00:00:00Z",
  records: {
    "CSE 4153": {
      code: "CSE 4153", title: "Data Communications", hours: 3, level: "undergraduate",
      description: "(Prerequisites: CSE 3724). Networks.",
      semester_offered: null,
      prereqs: { required_courses: ["CSE 3724"], logic: null, min_grade: null, non_course: [], raw_prose: "(Prerequisites: CSE 3724)", parse_warnings: [] },
      coreqs: null, cross_listed: [],
      source_url: "https://catalog.msstate.edu/search/?P=CSE%204153",
      prereq_summary: null,
    },
  },
  forward_dag: { "CSE 4153": ["CSE 3724"] }, reverse_dag: { "CSE 3724": ["CSE 4153"] },
};

before(() => setCourseCorpus(CORPUS));

describe("get_msu_course", () => {
  test("returns found:true for an existing course", async () => {
    const res = await get_msu_course.handler({ code: "CSE 4153" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.found, true);
    assert.equal(parsed.course.code, "CSE 4153");
    assert.deepEqual(parsed.course.prereqs.required_courses, ["CSE 3724"]);
  });

  test("normalizes case + whitespace", async () => {
    const res = await get_msu_course.handler({ code: "cse  4153" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.found, true);
  });

  test("returns found:false with suggestions for an unknown course", async () => {
    const res = await get_msu_course.handler({ code: "ZZ 9999" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.found, false);
    assert.ok(Array.isArray(parsed.suggestions));
  });

  test("rejects malformed codes", async () => {
    await assert.rejects(get_msu_course.handler({ code: "not a code" }));
  });
});
