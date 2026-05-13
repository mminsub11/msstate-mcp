import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { get_msu_course_graph } from "../../src/tools/get_msu_course_graph.js";
import { setCourseCorpus } from "../../src/courses/corpus.js";
import type { CourseCorpus } from "../../src/courses/types.js";

const CORPUS: CourseCorpus = {
  version: "test", scraped_at: "2026-05-12T00:00:00Z",
  records: {
    "CSE 1284": { code: "CSE 1284", title: "Intro", hours: 4, level: "undergraduate", description: "", semester_offered: null, prereqs: null, coreqs: null, cross_listed: [], source_url: "", prereq_summary: null },
    "CSE 1384": { code: "CSE 1384", title: "Inter", hours: 4, level: "undergraduate", description: "", semester_offered: null,
      prereqs: { required_courses: ["CSE 1284"], logic: null, min_grade: null, non_course: [], raw_prose: "(Prerequisites: CSE 1284)", parse_warnings: [] },
      coreqs: null, cross_listed: [], source_url: "", prereq_summary: null },
    "CSE 2383": { code: "CSE 2383", title: "DS", hours: 3, level: "undergraduate", description: "", semester_offered: null,
      prereqs: { required_courses: ["CSE 1384"], logic: null, min_grade: null, non_course: [], raw_prose: "(Prerequisites: CSE 1384)", parse_warnings: [] },
      coreqs: null, cross_listed: [], source_url: "", prereq_summary: null },
  },
  forward_dag: { "CSE 1384": ["CSE 1284"], "CSE 2383": ["CSE 1384"] },
  reverse_dag: { "CSE 1284": ["CSE 1384"], "CSE 1384": ["CSE 2383"] },
};

before(() => setCourseCorpus(CORPUS));

describe("get_msu_course_graph", () => {
  test("walks forward (prereqs)", async () => {
    const res = await get_msu_course_graph.handler({ code: "CSE 2383", direction: "prereqs" });
    const g = JSON.parse(res.content[0].text);
    assert.deepEqual(g.nodes.map((n: any) => n.code).sort(), ["CSE 1284", "CSE 1384", "CSE 2383"]);
  });

  test("walks reverse (unlocks)", async () => {
    const res = await get_msu_course_graph.handler({ code: "CSE 1284", direction: "unlocks" });
    const g = JSON.parse(res.content[0].text);
    assert.deepEqual(g.nodes.map((n: any) => n.code).sort(), ["CSE 1284", "CSE 1384", "CSE 2383"]);
  });

  test("respects depth bound", async () => {
    const res = await get_msu_course_graph.handler({ code: "CSE 2383", direction: "prereqs", depth: 1 });
    const g = JSON.parse(res.content[0].text);
    assert.equal(g.truncated, true);
  });

  test("rejects malformed code", async () => {
    await assert.rejects(
      get_msu_course_graph.handler({ code: "bad", direction: "prereqs" }),
    );
  });
});
