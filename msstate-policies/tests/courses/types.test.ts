import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Prereq, Course, PrereqWarning } from "../../src/courses/types.js";

describe("courses/types — v0.9.0 extensions", () => {
  test("Prereq accepts parse_warnings array", () => {
    const p: Prereq = {
      required_courses: ["CSE 1384"],
      logic: "and",
      min_grade: "C",
      non_course: [],
      raw_prose: "(Prerequisites: C or better in CSE 1384)",
      parse_warnings: [],
    };
    assert.deepEqual(p.parse_warnings, []);
  });
  test("PrereqWarning is a string literal union of 4 values", () => {
    const all: PrereqWarning[] = [
      "non_course_unparsed",
      "grade_signal_present_but_unparsed",
      "grade_signal_ambiguous",
      "logic_ambiguous",
    ];
    assert.equal(all.length, 4);
  });
  test("Course accepts prereq_summary field", () => {
    const c: Course = {
      code: "CSE 4733",
      title: "Operating Systems I",
      hours: 3,
      level: "undergraduate",
      description: "",
      semester_offered: null,
      prereqs: null,
      coreqs: null,
      cross_listed: [],
      source_url: "https://catalog.msstate.edu/search/?P=CSE%204733",
      prereq_summary: "CSE 3183 (C or better), and (CSE 3724 or ECE 3714)",
    };
    assert.equal(typeof c.prereq_summary, "string");
  });
  test("prereq_summary may be null", () => {
    const c: Course = {
      code: "ART 1001",
      title: "Intro to Art",
      hours: 3,
      level: "undergraduate",
      description: "",
      semester_offered: null,
      prereqs: null,
      coreqs: null,
      cross_listed: [],
      source_url: "https://catalog.msstate.edu/search/?P=ART%201001",
      prereq_summary: null,
    };
    assert.equal(c.prereq_summary, null);
  });
});
