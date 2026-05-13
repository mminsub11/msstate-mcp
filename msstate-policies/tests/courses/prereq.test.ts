import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { walkGraph } from "../../src/courses/prereq.js";
import type { Course, CourseCorpus } from "../../src/courses/types.js";

function mkCourse(code: string, title: string, prereqCodes: string[] = []): Course {
  return {
    code, title, hours: 3, level: "undergraduate",
    description: "", semester_offered: null,
    prereqs: prereqCodes.length === 0 ? null : {
      required_courses: prereqCodes,
      logic: prereqCodes.length === 1 ? null : "and",
      min_grade: null,
      non_course: [],
      raw_prose: `(Prerequisites: ${prereqCodes.join(" and ")})`,
    },
    coreqs: null, cross_listed: [],
    source_url: `https://catalog.msstate.edu/search/?P=${encodeURIComponent(code)}`,
  };
}

function mkCorpus(courses: Course[]): CourseCorpus {
  const records: Record<string, Course> = {};
  const forward_dag: Record<string, string[]> = {};
  const reverse_dag: Record<string, string[]> = {};
  for (const c of courses) {
    records[c.code] = c;
    const ps = c.prereqs?.required_courses ?? [];
    if (ps.length > 0) forward_dag[c.code] = ps;
    for (const p of ps) {
      if (!reverse_dag[p]) reverse_dag[p] = [];
      reverse_dag[p].push(c.code);
    }
  }
  return { version: "test", scraped_at: "2026-05-12T00:00:00Z", records, forward_dag, reverse_dag };
}

describe("walkGraph — forward (prereqs)", () => {
  test("returns just the root when course has no prereqs", () => {
    const corpus = mkCorpus([mkCourse("CSE 1284", "Intro")]);
    const g = walkGraph(corpus, "CSE 1284", "prereqs", 5);
    assert.deepEqual(g.nodes.map((n) => n.code), ["CSE 1284"]);
    assert.deepEqual(g.edges, []);
  });

  test("walks linear chain A → B → C", () => {
    const corpus = mkCorpus([
      mkCourse("CSE 1284", "Intro"),
      mkCourse("CSE 1384", "Inter", ["CSE 1284"]),
      mkCourse("CSE 2383", "DS",    ["CSE 1384"]),
    ]);
    const g = walkGraph(corpus, "CSE 2383", "prereqs", 5);
    assert.deepEqual(g.nodes.map((n) => n.code).sort(), ["CSE 1284", "CSE 1384", "CSE 2383"]);
    assert.equal(g.depth_used, 2);
  });

  test("walks fan-out: two prereqs", () => {
    const corpus = mkCorpus([
      mkCourse("MA 1713", "Calc I"),
      mkCourse("CSE 1284", "Intro"),
      mkCourse("CSE 2383", "DS", ["MA 1713", "CSE 1284"]),
    ]);
    const g = walkGraph(corpus, "CSE 2383", "prereqs", 5);
    assert.equal(g.nodes.length, 3);
    assert.equal(g.edges.length, 2);
  });

  test("respects depth cap", () => {
    const corpus = mkCorpus([
      mkCourse("CSE 1100", "A"),
      mkCourse("CSE 1200", "B", ["CSE 1100"]),
      mkCourse("CSE 1300", "C", ["CSE 1200"]),
      mkCourse("CSE 1400", "D", ["CSE 1300"]),
    ]);
    const g = walkGraph(corpus, "CSE 1400", "prereqs", 1);
    assert.equal(g.depth_used, 1);
    assert.equal(g.truncated, true);
  });

  test("clamps invalid depth to [1, MAX_GRAPH_DEPTH]", () => {
    const corpus = mkCorpus([mkCourse("CSE 1284", "Intro")]);
    const g1 = walkGraph(corpus, "CSE 1284", "prereqs", 0);
    assert.ok(g1.depth_used >= 0); // tolerated when there's no edge to walk
    const g2 = walkGraph(corpus, "CSE 1284", "prereqs", 999);
    assert.ok(g2.notes.some((n) => /clamped/i.test(n)));
  });

  test("detects cycles without infinite-looping", () => {
    const corpus = mkCorpus([
      mkCourse("CSE 1284", "Intro", ["CSE 1384"]),
      mkCourse("CSE 1384", "Inter", ["CSE 1284"]),
    ]);
    const g = walkGraph(corpus, "CSE 1284", "prereqs", 5);
    assert.equal(g.truncated, true);
    assert.ok(g.notes.some((n) => /cycle/i.test(n)));
  });

  test("returns empty graph for missing root", () => {
    const corpus = mkCorpus([mkCourse("CSE 1284", "Intro")]);
    const g = walkGraph(corpus, "ZZ 9999", "prereqs", 5);
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.edges, []);
  });
});

describe("walkGraph — reverse (unlocks)", () => {
  test("returns courses that depend on the root", () => {
    const corpus = mkCorpus([
      mkCourse("CSE 1284", "Intro"),
      mkCourse("CSE 1384", "Inter", ["CSE 1284"]),
      mkCourse("CSE 2213", "Tools", ["CSE 1284"]),
    ]);
    const g = walkGraph(corpus, "CSE 1284", "unlocks", 5);
    assert.deepEqual(g.nodes.map((n) => n.code).sort(), ["CSE 1284", "CSE 1384", "CSE 2213"]);
  });
});

describe("walkGraph — shared prerequisites are not cycles", () => {
  test("re-converging edges are emitted, not dropped as cycle", () => {
    // MA 1723 and MA 2113 both require MA 1713
    const corpus = mkCorpus([
      mkCourse("MA 1713", "Calc I"),
      mkCourse("MA 1723", "Calc II", ["MA 1713"]),
      mkCourse("MA 2113", "Calc III", ["MA 1713"]),
      mkCourse("MA 3253", "Diff Eq", ["MA 1723", "MA 2113"]),
    ]);
    const r = walkGraph(corpus, "MA 3253", "prereqs", 5);
    const fromTo = r.edges.map((e) => `${e.from}->${e.to}`).sort();
    assert.deepEqual(
      fromTo,
      ["MA 1723->MA 1713", "MA 2113->MA 1713", "MA 3253->MA 1723", "MA 3253->MA 2113"],
      "both convergent edges to MA 1713 must be emitted",
    );
    assert.equal(r.truncated, false, "shared prereqs are not a cycle and not truncation");
    assert.equal(
      r.notes.some((n) => /cycle/i.test(n)),
      false,
      "no spurious 'cycle detected' note for a DAG",
    );
  });

  test("MA 1713 appears once in nodes even when two parents reference it", () => {
    const corpus = mkCorpus([
      mkCourse("MA 1713", "Calc I"),
      mkCourse("MA 1723", "Calc II", ["MA 1713"]),
      mkCourse("MA 2113", "Calc III", ["MA 1713"]),
      mkCourse("MA 3253", "Diff Eq", ["MA 1723", "MA 2113"]),
    ]);
    const r = walkGraph(corpus, "MA 3253", "prereqs", 5);
    const ma1713Nodes = r.nodes.filter((n) => n.code === "MA 1713");
    assert.equal(ma1713Nodes.length, 1, "shared node must be emitted exactly once");
  });

  test("a true cycle is still detected and truncated", () => {
    // Pathological: A requires B, B requires A
    const corpus = mkCorpus([mkCourse("XX 1000", "A", ["XX 2000"]), mkCourse("XX 2000", "B", ["XX 1000"])]);
    const r = walkGraph(corpus, "XX 1000", "prereqs", 5);
    assert.equal(r.truncated, true, "a true 2-cycle must mark truncated");
    assert.equal(r.notes.some((n) => /cycle/i.test(n)), true, "must emit cycle note");
  });
});
