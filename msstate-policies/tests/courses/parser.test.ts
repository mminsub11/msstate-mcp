import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePrereqProse, parseCourseHtml } from "../../src/courses/parser.js";

function fixture(name: string): string {
  return readFileSync(
    resolve(__dirname, "..", "fixtures", "courses", name),
    "utf8",
  );
}

describe("parsePrereqProse — Pass 1 (lossless course codes)", () => {
  test("returns null for empty input", () => {
    assert.equal(parsePrereqProse(""), null);
    assert.equal(parsePrereqProse(null as unknown as string), null);
  });

  test("extracts a single course code", () => {
    const r = parsePrereqProse("(Prerequisites: CSE 3724)")!;
    assert.deepEqual(r.required_courses, ["CSE 3724"]);
    assert.equal(r.raw_prose, "(Prerequisites: CSE 3724)");
  });

  test("extracts two OR'd codes (with grade)", () => {
    const r = parsePrereqProse(
      "(Prerequisites: Grade of C or better in CSE 3724 or ECE 3724)",
    )!;
    assert.deepEqual(r.required_courses, ["CSE 3724", "ECE 3724"]);
    assert.equal(r.logic, "or");
    assert.equal(r.min_grade, "C");
  });

  test("extracts AND'd codes", () => {
    const r = parsePrereqProse("(Prerequisites: CSE 1284 and MA 1713)")!;
    assert.deepEqual(r.required_courses, ["CSE 1284", "MA 1713"]);
    assert.equal(r.logic, "and");
  });

  test("flags mixed logic when both AND and OR present", () => {
    const r = parsePrereqProse(
      "(Prerequisites: CSE 1284 and (MA 1713 or MA 1723))",
    )!;
    assert.deepEqual(r.required_courses, ["CSE 1284", "MA 1713", "MA 1723"]);
    assert.equal(r.logic, "mixed");
  });

  test("captures non-course conditions", () => {
    const r = parsePrereqProse(
      "(Prerequisites: junior standing or consent of instructor)",
    )!;
    assert.deepEqual(r.required_courses, []);
    for (const e of ["junior standing", "consent of instructor"]) {
      assert.ok(
        (r.non_course ?? []).includes(e),
        `expected ${JSON.stringify(r.non_course)} to contain ${e}`,
      );
    }
  });

  test("handles 4-letter dept codes (e.g., MGMT)", () => {
    const r = parsePrereqProse("(Prerequisites: MGMT 3823)")!;
    assert.deepEqual(r.required_courses, ["MGMT 3823"]);
  });

  test("ignores course-like patterns outside the prereq paren", () => {
    // Course descriptions sometimes mention other courses outside the prereq
    // sentence; the parser must only operate inside the parenthesized clause.
    const onlyDescription = "Three hours lecture. Covers ENG 1103 themes.";
    assert.equal(parsePrereqProse(onlyDescription), null);
  });

  test("preserves raw_prose verbatim including punctuation", () => {
    const input =
      "(Prerequisites: Grade of B or better in MA 1713; junior standing)";
    const r = parsePrereqProse(input)!;
    assert.equal(r.raw_prose, input);
    assert.equal(r.min_grade, "B");
  });

  test("returns null when no parenthesized prereq clause is present", () => {
    assert.equal(parsePrereqProse("Three hours lecture."), null);
  });

  test("recognizes coreq clause as a separate parse target", () => {
    // The coreq parser is exported separately; this test guards that the
    // prereq parser does NOT pick up coreq paren content.
    assert.equal(
      parsePrereqProse("(Corequisites: CSE 1284). Three hours."),
      null,
    );
  });
});

describe("parseCourseHtml", () => {
  test("extracts code/title/hours from CSE 4153 fixture", () => {
    const c = parseCourseHtml(fixture("cse-4153.html"), "CSE 4153")!;
    assert.equal(c.code, "CSE 4153");
    assert.match(c.title, /Data Communications|Computer Networks/i);
    assert.equal(c.hours, 3);
    assert.equal(c.level, "undergraduate");
    assert.equal(c.source_url, "https://catalog.msstate.edu/search/?P=CSE%204153");
  });

  test("extracts prereqs for CSE 4153", () => {
    const c = parseCourseHtml(fixture("cse-4153.html"), "CSE 4153")!;
    assert.notEqual(c.prereqs, null);
    for (const e of ["CSE 3724", "ECE 3724"]) {
      assert.ok(
        c.prereqs!.required_courses.includes(e),
        `expected ${JSON.stringify(c.prereqs!.required_courses)} to contain ${e}`,
      );
    }
    assert.match(c.prereqs!.raw_prose, /Prerequisites/);
  });

  test("returns null for an unknown course (HTML 200 but no result card)", () => {
    // Use any HTML that does NOT contain a searchresult article.
    const empty = "<html><body><p>nothing here</p></body></html>";
    assert.equal(parseCourseHtml(empty, "ZZ 9999"), null);
  });

  test("CSE 1284 has no prereqs (or only a non-course condition)", () => {
    const c = parseCourseHtml(fixture("cse-1284.html"), "CSE 1284")!;
    // Either null prereqs, or required_courses === [] with non_course populated.
    if (c.prereqs) {
      assert.deepEqual(c.prereqs.required_courses, []);
    }
  });

  test("hours field handles range strings like '0,4' as a string", () => {
    // Synthetic minimal fixture covering ranged-hours markup — none of the
    // current live fixtures (CSE 1284/4153/4733) publish a ranged value.
    const syntheticRanged = `<article class="searchresult search-pageresult">
      <h2 class="hours">0,4 Hours.</h2>
      <h2 class="title">EX 9999. <span class="title">Example Ranged.</span></h2>
      <div class="courseblockdesc"><p>(Prerequisites: EX 1000). Description.</p></div>
    </article>`;
    const c = parseCourseHtml(syntheticRanged, "EX 9999")!;
    assert.equal(typeof c.hours === "string" ? c.hours : String(c.hours), "0,4");
  });
});

describe("extractNonCourse — Section 1 (admission status)", () => {
  test("extracts 'Admission to Teacher Education'", () => {
    const p = parsePrereqProse("(Prerequisites: Admission to Teacher Education)");
    assert.ok(p);
    assert.ok(p.non_course.some((s) => /Admission to Teacher Education/i.test(s)));
  });
  test("extracts mixed admission + standing", () => {
    const p = parsePrereqProse("(Prerequisites: Admission to Teacher Education and senior standing)");
    assert.ok(p);
    assert.ok(p.non_course.some((s) => /Admission to Teacher Education/i.test(s)));
    assert.ok(p.non_course.some((s) => /senior standing/i.test(s)));
  });
});

describe("extractNonCourse — Section 1 (hours-of-X)", () => {
  test("extracts 'Seven hours of biological science'", () => {
    const p = parsePrereqProse("(Prerequisites: Seven hours of biological science)");
    assert.ok(p);
    assert.ok(p.non_course.some((s) => /Seven hours of biological science/i.test(s)));
  });
  test("extracts hours phrasing with 'and'-joined clauses", () => {
    const p = parsePrereqProse("(Prerequisites: Ten hours of biological science and organic chemistry)");
    assert.ok(p);
    assert.ok(p.non_course.length >= 1);
  });
});

describe("extractNonCourse — Section 1 (completion of X)", () => {
  test("extracts 'Completion of any 1000-level history course'", () => {
    const p = parsePrereqProse("(Prerequisites: Completion of any 1000-level history course)");
    assert.ok(p);
    assert.ok(p.non_course.some((s) => /Completion of any 1000-level history course/i.test(s)));
  });
  test("extracts MPH core completion phrasing", () => {
    const p = parsePrereqProse("(Prerequisites: Completion of all core Master of Public Health courses AND permission of primary advisor)");
    assert.ok(p);
    assert.ok(p.non_course.some((s) => /Completion of all core Master of Public Health courses/i.test(s)));
    assert.ok(p.non_course.some((s) => /permission of primary advisor/i.test(s)));
  });
});

describe("extractNonCourse — Section 1 (proficiency)", () => {
  test("extracts 'Proficiency with spreadsheet software'", () => {
    const p = parsePrereqProse("(Prerequisites: Proficiency with spreadsheet software)");
    assert.ok(p);
    assert.ok(p.non_course.some((s) => /Proficiency with spreadsheet software/i.test(s)));
  });
});

describe("extractNonCourse — Section 1 (broader permission phrasing)", () => {
  test("extracts 'permission of practicum director'", () => {
    const p = parsePrereqProse("(Prerequisites: Master of Public Health core courses and permission of practicum director)");
    assert.ok(p);
    assert.ok(p.non_course.some((s) => /permission of practicum director/i.test(s)));
  });
  test("extracts 'consent of the practicum director' (with definite article)", () => {
    const p = parsePrereqProse("(Prerequisites: consent of the practicum director)");
    assert.ok(p);
    assert.ok(p.non_course.some((s) => /consent of (the )?practicum director/i.test(s)));
  });
});

describe("extractNonCourse — preserves existing patterns (regression guard)", () => {
  test("still extracts 'consent of instructor'", () => {
    const p = parsePrereqProse("(Prerequisites: consent of instructor)");
    assert.ok(p);
    assert.ok(p.non_course.some((s) => /consent of instructor/i.test(s)));
  });
  test("still extracts 'senior standing'", () => {
    const p = parsePrereqProse("(Prerequisites: senior standing)");
    assert.ok(p);
    assert.ok(p.non_course.some((s) => /senior standing/i.test(s)));
  });
});

describe("inferMinGrade — Section 2 (broader phrasings)", () => {
  test("'C or better in CSE 3183' (existing format) → 'C'", () => {
    const p = parsePrereqProse("(Prerequisites: C or better in CSE 3183)");
    assert.equal(p?.min_grade, "C");
  });
  test("'a C or better' → 'C'", () => {
    const p = parsePrereqProse("(Prerequisites: a C or better in CSE 3183)");
    assert.equal(p?.min_grade, "C");
  });
  test("'grade of C or better' → 'C'", () => {
    const p = parsePrereqProse("(Prerequisites: grade of C or better in CSE 3183)");
    assert.equal(p?.min_grade, "C");
  });
  test("'minimum grade of C' → 'C'", () => {
    const p = parsePrereqProse("(Prerequisites: minimum grade of C in CSE 3183)");
    assert.equal(p?.min_grade, "C");
  });
  test("'earning a C' → 'C'", () => {
    const p = parsePrereqProse("(Prerequisites: CSE 3183 with earning a C)");
    assert.equal(p?.min_grade, "C");
  });
  test("'with a C or better' → 'C'", () => {
    const p = parsePrereqProse("(Prerequisites: CSE 3183 with a C or better)");
    assert.equal(p?.min_grade, "C");
  });
  test("'minimum B grade' → 'B'", () => {
    const p = parsePrereqProse("(Prerequisites: minimum B grade in CSE 3183)");
    assert.equal(p?.min_grade, "B");
  });

  // False-positive guards
  test("'in CSE 3183 and ECE 3714' (no grade phrase) → null", () => {
    const p = parsePrereqProse("(Prerequisites: in CSE 3183 and ECE 3714)");
    assert.equal(p?.min_grade, null);
  });
  test("'A score of 70%' (A is not a grade here) → null", () => {
    const p = parsePrereqProse("(Prerequisites: A score of 70% on the placement exam)");
    assert.equal(p?.min_grade, null);
  });
  test("'with a B' (no 'or better', genuinely ambiguous) → null", () => {
    const p = parsePrereqProse("(Prerequisites: CSE 3183 with a B)");
    assert.equal(p?.min_grade, null);
  });
});

describe("parse_warnings — Section 3a (warning emission)", () => {
  test("non_course_unparsed when raw_prose has content but extractors found nothing", () => {
    // A phrase NO non_course pattern catches.
    const p = parsePrereqProse("(Prerequisites: a vibe check from the department chair)");
    assert.ok(p);
    assert.ok(p.parse_warnings.includes("non_course_unparsed"),
      `expected non_course_unparsed in ${JSON.stringify(p.parse_warnings)}`);
  });
  test("no warning when fully parsed (clean course-codes case)", () => {
    const p = parsePrereqProse("(Prerequisites: CSE 1384)");
    assert.ok(p);
    assert.deepEqual(p.parse_warnings, []);
  });
  test("no warning when non_course extraction succeeded", () => {
    const p = parsePrereqProse("(Prerequisites: senior standing)");
    assert.ok(p);
    assert.deepEqual(p.parse_warnings, []);
  });
  test("grade_signal_present_but_unparsed when prose mentions 'grade' but inferMinGrade returns null", () => {
    // "with a B grade" — "grade" trigger word present, but no pattern matches a letter+grade combo.
    const p = parsePrereqProse("(Prerequisites: CSE 1384 with a B grade)");
    assert.ok(p);
    // The "minimum B grade" pattern requires "minimum"; "with a B grade" doesn't match.
    // But the trigger word "grade" IS present, so we emit the warning.
    assert.ok(p.parse_warnings.includes("grade_signal_present_but_unparsed"),
      `expected grade_signal_present_but_unparsed in ${JSON.stringify(p.parse_warnings)}`);
  });
  test("no grade warning when 'grade' word absent", () => {
    const p = parsePrereqProse("(Prerequisites: CSE 1384)");
    assert.ok(p);
    assert.ok(!p.parse_warnings.includes("grade_signal_present_but_unparsed"));
  });
  test("logic_ambiguous emitted when 'mixed' AND/OR composition detected", () => {
    const p = parsePrereqProse("(Prerequisites: CSE 1284 and (MA 1713 or MA 1723))");
    assert.ok(p);
    assert.equal(p.logic, "mixed");
    assert.ok(p.parse_warnings.includes("logic_ambiguous"));
  });
  test("'none' in raw_prose emits no warning (treated as null-equivalent)", () => {
    const p = parsePrereqProse("(Prerequisites: none)");
    assert.ok(p);
    assert.deepEqual(p.parse_warnings, []);
  });
});
