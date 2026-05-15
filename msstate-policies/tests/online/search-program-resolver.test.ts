import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveProgram } from "../../src/online/search.js";
import type { OnlineProgram } from "../../src/online/types.js";

// Minimal fixture programs — only the fields resolveProgram reads.
function p(slug: string, name: string, short = ""): OnlineProgram {
  return {
    slug,
    name,
    degree_level: "master",
    format: "online",
    short_description: short,
    url: `https://www.online.msstate.edu/program/${slug}`,
    tuition: {
      per_credit_usd: null,
      instructional_fee_per_credit_usd: null,
      application_fee_domestic_usd: null,
      application_fee_international_usd: null,
      raw_prose: "",
    },
    contacts: [],
    application_deadlines: [],
    admission_requirements: "",
    entrance_exams: null,
    accreditation: null,
    forms: [],
    raw_sections: {},
    parse_warnings: [],
    retrieved_at: "2026-05-15T00:00:00.000Z",
  };
}

const PROGRAMS: OnlineProgram[] = [
  p("mba", "Online Master of Business Administration",
    "MSU's online MBA program offers an accelerated, fully online MBA."),
  p("msw", "Online Master of Social Work",
    "Earn your MSW online from MSU's nationally recognized online program."),
  p("bas-business-office-technology", "Online B.A.S. in Business Office Technology",
    "Complete your online bachelor's degree in business office technology."),
  p("ms-computer-science", "Online M.S. in Computer Science",
    "Pursue an online M.S. in computer science."),
  p("ms-cyber-security", "Online M.S. in Cyber Security",
    "Cybersecurity master's program offered fully online."),
];

test("'online MBA' → MBA program (substring on slug)", () => {
  // Bug context: in production the BAS-BOT short_description mentions "online" ~5×,
  // which under BM25-only scoring outweighed MBA's slug match. This fixture doesn't
  // replicate the exact score ratios — it tests the new substring-pre-stage path
  // that makes "online MBA" deterministic regardless of short_description length.
  const r = resolveProgram(PROGRAMS, "online MBA");
  assert.equal(r.matched?.slug, "mba");
  assert.equal(r.match_strategy, "substring");
});

test("'online program' → no_signal (empty after stop-word strip)", () => {
  const r = resolveProgram(PROGRAMS, "online program");
  assert.equal(r.matched, null);
  assert.equal(r.match_strategy, "no_signal");
});

test("'online social work' → MSW (substring on name)", () => {
  const r = resolveProgram(PROGRAMS, "online social work");
  assert.equal(r.matched?.slug, "msw");
  assert.equal(r.match_strategy, "substring");
});

test("'online computer science' → CS (substring on name)", () => {
  const r = resolveProgram(PROGRAMS, "online computer science");
  assert.equal(r.matched?.slug, "ms-computer-science");
});

test("'cyber' (no 'online' prefix) → cyber-security via substring", () => {
  const r = resolveProgram(PROGRAMS, "cyber");
  assert.equal(r.matched?.slug, "ms-cyber-security");
});

test("ties broken by shortest name (exact-slug wins over substring-in-name)", () => {
  const ties = [
    p("aaa", "Online Master in Aviation"),
    p("aviation", "Online Master in Aviation Studies and Management"),
  ];
  const r = resolveProgram(ties, "aviation");
  assert.equal(r.matched?.slug, "aviation"); // exact slug match wins
});

test("ties at strength 2 broken by shortest name", () => {
  // Slugs intentionally chosen so neither slug-normalized form equals qNorm
  // ("data analytics") — otherwise the first would exact-match at strength 3
  // and short-circuit the name-length tiebreak we want to exercise.
  const ties = [
    p("ms-analytics-long", "Online MS in Data Analytics and Machine Learning"),
    p("ms-analytics-short", "Online MS Data Analytics"),
  ];
  // qTokens = ["data", "analytics"] → qNorm = "data analytics"
  // First: name lowercased = "online ms in data analytics and machine learning" — contains "data analytics" → strength 2, name length 49
  // Second: name lowercased = "online ms data analytics" — contains "data analytics" → strength 2, name length 24
  // Both strength 2; shorter name wins.
  const r = resolveProgram(ties, "data analytics");
  assert.equal(r.matched?.slug, "ms-analytics-short");
});

test("BM25 fallback when no substring hit", () => {
  // 'accelerated' appears in MBA short_description but not in any slug or name.
  // qTokens after stop-word strip: ["accelerated"].
  // Substring pre-stage: no slugNorm or nameNorm contains "accelerated".
  // Falls through to BM25 fallback, which scores via 4× slug + 3× name + 1× short_desc.
  // Only MBA's short_description contains "accelerated" → wins.
  const r = resolveProgram(PROGRAMS, "accelerated");
  assert.equal(r.matched?.slug, "mba");
  assert.equal(r.match_strategy, "bm25");
});
