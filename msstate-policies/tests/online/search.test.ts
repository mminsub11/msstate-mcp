import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  indexInfoPages,
  bm25SearchInfo,
  filterPrograms,
  fuzzyResolveProgram,
} from "../../src/online/search.js";
import type {
  OnlineInfoPage,
  OnlineProgram,
  DegreeLevel,
  OnlineStaffEntry,
} from "../../src/online/types.js";

function info(slug: string, title: string, body: string): OnlineInfoPage {
  return { slug, title, url: `https://www.online.msstate.edu/${slug}`, body_markdown: body, retrieved_at: "x" };
}
function staff(name: string, email: string): OnlineStaffEntry {
  return { name, title: "X", email, phone: null, office: "O", url: "x", retrieved_at: "x" };
}
function prog(slug: string, name: string, level: DegreeLevel, shortDesc = ""): OnlineProgram {
  return {
    slug, name, degree_level: level, format: "Fully online", short_description: shortDesc,
    url: `x/${slug}`, tuition: { per_credit_usd: null, instructional_fee_per_credit_usd: null, application_fee_domestic_usd: null, application_fee_international_usd: null, raw_prose: "" },
    contacts: [], application_deadlines: [], admission_requirements: "",
    entrance_exams: null, accreditation: null, forms: [], raw_sections: {}, parse_warnings: [],
    retrieved_at: "x",
  };
}

describe("bm25SearchInfo", () => {
  test("ranks the page whose title matches the query first", () => {
    indexInfoPages(
      [
        info("state-authorization", "State Authorization", "MSU Online operates in many states but not all."),
        info("military-assistance", "Military Assistance", "MSU offers tuition assistance for service members."),
        info("orientation", "Orientation", "Welcome to MSU Online."),
      ],
      [],
    );
    const hits = bm25SearchInfo("state authorization", 3, "all");
    assert.equal(hits[0].row.slug, "state-authorization");
  });
  test("respects scope filter", () => {
    indexInfoPages(
      [
        info("orientation", "Orientation", "Orientation explains MSU Online basics."),
        info("faq", "FAQ", "FAQ on orientation and other topics."),
      ],
      [],
    );
    const hits = bm25SearchInfo("orientation", 5, "faq");
    assert.ok(hits.every((h) => h.row.slug === "faq"));
  });
  test("staff doc is searchable under scope=staff", () => {
    indexInfoPages(
      [info("orientation", "Orientation", "Orientation")],
      [staff("Jane Doe", "jdoe@msstate.edu")],
    );
    const hits = bm25SearchInfo("jane", 3, "staff");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].row.slug, "staff");
  });
  test("empty query returns []", () => {
    indexInfoPages([info("o", "Orientation", "x")], []);
    assert.deepEqual(bm25SearchInfo("", 3, "all"), []);
  });
});

describe("filterPrograms", () => {
  const PROGS = [
    prog("mba", "Master of Business Administration", "master", "MBA online"),
    prog("bsee", "Bachelor in Electrical Engineering", "bachelor", "ECE"),
    prog("psychology", "Bachelor in Psychology", "bachelor", "psych"),
    prog("phcse", "Doctor of Philosophy in Computer Science", "doctoral", "PhD CS"),
  ];
  test("filter by level only", () => {
    const r = filterPrograms(PROGS, { level: "bachelor", limit: 50, offset: 0 });
    assert.equal(r.matches.length, 2);
    for (const m of r.matches) assert.equal(m.degree_level, "bachelor");
  });
  test("filter by subject_keyword", () => {
    const r = filterPrograms(PROGS, { subject_keyword: "engineering", limit: 50, offset: 0 });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].slug, "bsee");
  });
  test("filter by both level + keyword", () => {
    const r = filterPrograms(PROGS, { level: "doctoral", subject_keyword: "computer", limit: 50, offset: 0 });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].slug, "phcse");
  });
  test("pagination works", () => {
    const r1 = filterPrograms(PROGS, { limit: 2, offset: 0 });
    const r2 = filterPrograms(PROGS, { limit: 2, offset: 2 });
    assert.equal(r1.matches.length, 2);
    assert.equal(r2.matches.length, 2);
    assert.notEqual(r1.matches[0].slug, r2.matches[0].slug);
  });
  test("filtered_total reflects pre-paging count", () => {
    const r = filterPrograms(PROGS, { level: "bachelor", limit: 1, offset: 0 });
    assert.equal(r.matches.length, 1);
    assert.equal(r.filtered_total, 2);
    assert.equal(r.total, 4);
  });
});

describe("fuzzyResolveProgram", () => {
  const PROGS = [
    prog("mba", "Master of Business Administration", "master", "MBA online"),
    prog("psychology", "Bachelor in Psychology", "bachelor", "Online psychology degree"),
    prog("apba", "Bachelor of Science in Applied Behavior Analysis", "bachelor", "ABA"),
  ];
  test("top match for 'online MBA'", () => {
    const r = fuzzyResolveProgram(PROGS, "online MBA");
    assert.equal(r.matched?.slug, "mba");
  });
  test("did_you_mean populated when query is generic", () => {
    const r = fuzzyResolveProgram(PROGS, "bachelor");
    assert.ok(r.matched);
    assert.ok(r.did_you_mean.length >= 1);
  });
  test("returns null match for unrecognizable query", () => {
    const r = fuzzyResolveProgram(PROGS, "definitely-not-a-real-program-zzz");
    assert.equal(r.matched, null);
  });
});
