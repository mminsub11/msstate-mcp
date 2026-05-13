import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { indexCourses, searchCourses, __debugDocs } from "../../src/courses/search.js";
import type { Course } from "../../src/courses/types.js";

const COURSES: Course[] = [
  {
    code: "CSE 4153",
    title: "Data Communications and Computer Networks",
    hours: 3,
    level: "undergraduate",
    description: "Concepts of data communications and networking.",
    semester_offered: null,
    prereqs: null,
    coreqs: null,
    cross_listed: [],
    source_url: "https://catalog.msstate.edu/search/?P=CSE%204153",
  },
  {
    code: "CSE 4733",
    title: "Operating Systems I",
    hours: 3,
    level: "undergraduate",
    description: "Operating system concepts: processes, memory, scheduling.",
    semester_offered: null,
    prereqs: null,
    coreqs: null,
    cross_listed: [],
    source_url: "https://catalog.msstate.edu/search/?P=CSE%204733",
  },
  {
    code: "MA 1713",
    title: "Calculus I",
    hours: 3,
    level: "undergraduate",
    description: "Limits, derivatives, integrals.",
    semester_offered: null,
    prereqs: null,
    coreqs: null,
    cross_listed: [],
    source_url: "https://catalog.msstate.edu/search/?P=MA%201713",
  },
];

describe("searchCourses — BM25 over course corpus", () => {
  before(() => indexCourses(COURSES));

  test("exact code wins top rank", () => {
    const hits = searchCourses("CSE 4153", 3);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].course.code, "CSE 4153");
  });

  test("title keyword matches", () => {
    const hits = searchCourses("networks", 3);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].course.code, "CSE 4153");
  });

  test("description keyword matches", () => {
    const hits = searchCourses("scheduling", 3);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].course.code, "CSE 4733");
  });

  test("returns empty for nonsense", () => {
    const hits = searchCourses("xyzzy-no-match", 3);
    assert.equal(hits.length, 0);
  });

  test("respects limit", () => {
    const hits = searchCourses("course", 1);
    assert.ok(hits.length <= 1);
  });
});

describe("courses BM25 — index uses precomputed term frequencies", () => {
  test("internal IndexedCourse exposes tf maps after indexing", () => {
    const debug = __debugDocs();
    assert.ok(debug.length > 0, "indexCourses must have populated docs");
    const sample = debug[0];
    assert.ok(sample.codeTf instanceof Map, "codeTf must be a Map<string, number>");
    assert.ok(sample.titleTf instanceof Map);
    assert.ok(sample.descTf instanceof Map);
  });
});
