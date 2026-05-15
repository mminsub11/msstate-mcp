# v1.1.1 online module fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v1.1.1 of msstate-mcp: fix the broken fuzzy program resolver, add the `list_programs_by_staff` reverse-lookup tool, clean HTML/JS leakage from `tuition.raw_prose`, and bake the staff→programs inverted index into the corpus.

**Architecture:** All changes layer on top of the existing online module. New `resolveProgram` adds a `PROGRAM_STOP_WORDS` filter and substring pre-stage before BM25 fallback. New `resolveStaff` is a flat-array scan with email-primary / name-fallback resolution and trigram-similarity `did_you_mean`. Inverted index built at scrape time from existing `OnlineProgram.contacts[]`. HTML strip removes known-bad selectors before cheerio's `.text()`. Worker mirrors the same logic inline (per existing stdio/worker dual-source pattern).

**Tech Stack:** TypeScript, tsx, cheerio, esbuild, Cloudflare Workers, BM25 (existing), trigram similarity (~30 LOC inline). No new dependencies.

**Reference:** See [`.dev/specs/2026-05-15-online-fixes-design.md`](../specs/2026-05-15-online-fixes-design.md) for full design rationale.

---

## File structure (decomposition map)

```
msstate-policies/
├── src/
│   ├── online/
│   │   ├── types.ts            MODIFY  +ProgramRef, StaffEntry, StaffToProgramsIndex
│   │   ├── parser.ts           MODIFY  HTML-strip at 2 sites; +buildStaffToProgramsIndex
│   │   ├── search.ts           MODIFY  +PROGRAM_STOP_WORDS, resolveProgram (replaces fuzzyResolveProgram),
│   │   │                                trigramScore, resolveStaff
│   │   └── corpus.ts           MODIFY  +setStaffToPrograms accessor, OnlineCorpus has staff_to_programs
│   ├── tools/
│   │   └── list_programs_by_staff.ts   CREATE  tool handler
│   └── index.ts                MODIFY  register new tool
├── tests/online/
│   ├── search-program-resolver.test.ts CREATE  5+ scenarios
│   ├── search-staff-resolver.test.ts   CREATE  6+ scenarios incl. trigram
│   ├── parser-tuition-html-strip.test.ts CREATE  HTML-strip + fixture
│   ├── parser-staff-index.test.ts      CREATE  buildStaffToProgramsIndex
│   └── fixtures/online/
│       └── tuition-with-gtm-iframe.html CREATE  fixture HTML
├── eval/
│   └── online.jsonl            MODIFY  +15 rows (10 fuzzy regression + 5 staff lookup)
├── package.json                MODIFY  version 1.1.0 → 1.1.1
└── .claude-plugin/plugin.json  MODIFY  version 1.1.0 → 1.1.1

worker/
└── src/index.ts                MODIFY  mirror new tool, list_programs_by_staff dispatch,
                                         tool-count constant, version string

scripts/
├── _scrape-online.ts           MODIFY  emit staff_to_programs in stdout JSON
└── build-worker-corpus.mjs     MODIFY  +2 abort sites (canonical poisoned-corpus string)

tools/security-checklist.sh     MODIFY  ONL4 target ≥10 (was 8), ONL5 file count = 5

.github/workflows/ci.yml        MODIFY  tools/list smoke-test assertion 24 → 25

README.md                       MODIFY  tool count 24 → 25, new tool row
CLAUDE.md                       MODIFY  v1.1.1 addendum + intro tool count
docs/BUILD.md                   MODIFY  extend online module section
msstate-policies/README.md      MODIFY  tool count + new tool entry

worker/corpus.json              REBUILD  release ritual
msstate-policies/dist/index.js  REBUILD  release ritual
```

**21 tasks across 7 phases.** Single feature branch (`feat/online-fixes-v1.1.1`), single PR, single release tag (`v1.1.1`).

---

## Phase 1 — Foundation (Tasks 1-2)

### Task 1: HTML strip in parseTuition

**Files:**
- Create: `msstate-policies/tests/online/fixtures/tuition-with-gtm-iframe.html`
- Create: `msstate-policies/tests/online/parser-tuition-html-strip.test.ts`
- Modify: `msstate-policies/src/online/parser.ts:309-310` (cowbell site) and `msstate-policies/src/online/parser.ts:525-528` (BAS fallback)

- [ ] **Step 1: Create the fixture HTML**

Create `msstate-policies/tests/online/fixtures/tuition-with-gtm-iframe.html`:

```html
<!doctype html>
<html><head><title>Online Program — Tuition</title></head>
<body>
<noscript>
  <iframe src="https://www.googletagmanager.com/ns.html?id=GTM-XXXX"
          height="0" width="0" style="display:none;visibility:hidden"></iframe>
</noscript>
<nav><a href="/about">About</a> <a href="/contact">Contact</a></nav>
<header>MSU Online</header>
<main>
<div class="tuitioncowbell">Tuition info below.</div>
<div class="table-responsive">
<table>
  <tr><td>Tuition per credit hour</td><td>$525.00</td></tr>
  <tr><td>Instructional Support Fee</td><td>$25.00</td></tr>
</table>
</div>
<script>console.log("analytics")</script>
</main>
<footer>(c) 2026 Mississippi State University</footer>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `msstate-policies/tests/online/parser-tuition-html-strip.test.ts`:

```ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as cheerioLoad } from "cheerio";

// We import the parser internals via the same path the main entry uses.
// extractTuition is currently private; expose it for tests OR exercise it
// via parseProgram. We choose parseProgram so the public surface is tested.
import { parseProgram } from "../../src/online/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(__dirname, "fixtures", "tuition-with-gtm-iframe.html"),
  "utf8",
);

test("tuition.raw_prose contains no iframe/script/noscript/nav substrings", () => {
  const program = parseProgram({
    html: FIXTURE,
    url: "https://www.online.msstate.edu/program/test-tuition-clean",
    slug: "test-tuition-clean",
    name: "Online Test Program",
    degree_level: "master",
    indexShortDescription: "Test program for tuition HTML cleanup.",
  });
  const prose = program.tuition.raw_prose;
  assert.ok(prose.length > 0, "raw_prose should be non-empty");
  for (const needle of ["<iframe", "<script", "<noscript", "<nav", "<header", "<footer"]) {
    assert.equal(
      prose.toLowerCase().includes(needle),
      false,
      `raw_prose contained ${needle}: ${prose.slice(0, 200)}`,
    );
  }
  // Sanity: the actual tuition labels survived
  assert.match(prose, /tuition per credit hour/i, "expected real tuition text to survive strip");
});
```

- [ ] **Step 3: Run test, expect FAIL**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-tuition-html-strip.test.ts
```

Expected: failure on `raw_prose contained <iframe` OR `raw_prose contained <noscript` — current parser concatenates noscript text content via `.text()`.

- [ ] **Step 4: Add HTML strip at both call sites**

Edit `msstate-policies/src/online/parser.ts` at line ~309 (inside `extractTuition`, inside the `if ($cowbell.length > 0)` block, BEFORE the `$parent.find("table tr").each(...)` loop):

```ts
    // The table is a sibling of the tuitioncowbell div, inside a shared parent
    const $parent = $cowbell.parent();
    // Strip page-chrome and analytics injectors before .text() — these leak
    // GTM noscript-iframe HTML and nav menu strings into raw_prose.
    $parent.find("script, style, noscript, iframe, nav, header, footer").remove();
    $parent.find("table tr").each((_, tr) => {
```

Edit the same file at line ~525 (BAS-style `quickInner` fallback):

```ts
    if (!tuition.raw_prose) {
      const $block = $("strong#credit_hours").closest("div.quickInner");
      if ($block.length) {
        $block.find("script, style, noscript, iframe, nav, header, footer").remove();
        tuition.raw_prose = $block.text().trim().slice(0, 400);
      }
    }
```

- [ ] **Step 5: Run test, expect PASS**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-tuition-html-strip.test.ts
```

Expected: PASS, `raw_prose` contains `tuition per credit hour` but none of the chrome substrings.

- [ ] **Step 6: Commit**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git checkout -b feat/online-fixes-v1.1.1
git add msstate-policies/src/online/parser.ts \
        msstate-policies/tests/online/parser-tuition-html-strip.test.ts \
        msstate-policies/tests/online/fixtures/tuition-with-gtm-iframe.html
git commit -m "fix(online): strip script/style/noscript/iframe/nav/header/footer before tuition.raw_prose .text()"
```

---

### Task 2: New types for staff-to-programs index

**Files:**
- Modify: `msstate-policies/src/online/types.ts:128-135` (extend `OnlineCorpus`)
- Modify: `msstate-policies/src/online/types.ts:142` (after `OnlineWafError`)

- [ ] **Step 1: Add new type definitions**

Append to `msstate-policies/src/online/types.ts` BEFORE the `OnlineWafError` class (around line 137):

```ts
/**
 * Reference to a program from a staff member's perspective.
 * `role_in_program` is the contact-card role label from the program page
 * (e.g., "General Program Questions, Admissions Process & Requirements").
 */
export interface ProgramRef {
  slug: string;
  name: string;
  role_in_program: string;
}

/**
 * One staff member with their full program portfolio.
 * `display_name` is the canonical form (longest spelling wins on dedup).
 * `role` is the department title from the staff directory when known.
 */
export interface StaffEntry {
  display_name: string;
  email: string | null;
  role: string;
  programs: ProgramRef[];
}

/**
 * Flat array of staff with their programs. Built at scrape time from
 * OnlineProgram.contacts[]. Used by list_programs_by_staff.
 */
export type StaffToProgramsIndex = StaffEntry[];
```

Then modify `OnlineCorpus` (line 128-135) to add the new field:

```ts
export interface OnlineCorpus {
  builtAt: string;
  source: "https://www.online.msstate.edu/";
  programs: OnlineProgram[];
  admissions_process: OnlineAdmissionsProcess;
  staff: OnlineStaffEntry[];
  info_pages: OnlineInfoPage[];
  staff_to_programs: StaffToProgramsIndex;
}
```

- [ ] **Step 2: Verify it typechecks**

```bash
cd msstate-policies && npm run typecheck
```

Expected: PASS (existing code does not consume `staff_to_programs` yet, so no breakage. New types are additive.)

- [ ] **Step 3: Commit**

```bash
git add msstate-policies/src/online/types.ts
git commit -m "feat(online): types — ProgramRef, StaffEntry, StaffToProgramsIndex"
```

---

## Phase 2 — search.ts: fuzzy resolver overhaul (Tasks 3-5)

### Task 3: Replace fuzzyResolveProgram with resolveProgram (stop-words + substring pre-stage)

**Files:**
- Modify: `msstate-policies/src/online/search.ts:163-191` (replace `fuzzyResolveProgram`)
- Create: `msstate-policies/tests/online/search-program-resolver.test.ts`
- Modify: `msstate-policies/src/tools/get_online_program.ts:8,40` (rename import)
- Modify: `worker/src/index.ts` references (deferred to Phase 4 — Task 11)

- [ ] **Step 1: Write the failing test (5 scenarios)**

Create `msstate-policies/tests/online/search-program-resolver.test.ts`:

```ts
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

test("'online computer science' → CS (all-tokens-present)", () => {
  const r = resolveProgram(PROGRAMS, "online computer science");
  assert.equal(r.matched?.slug, "ms-computer-science");
});

test("'cyber' (no 'online' prefix) → cyber-security via BM25 fallback or substring", () => {
  const r = resolveProgram(PROGRAMS, "cyber");
  assert.equal(r.matched?.slug, "ms-cyber-security");
});

test("ties broken by shortest name", () => {
  const ties = [
    p("aaa", "Online Master in Aviation"),
    p("aviation", "Online Master in Aviation Studies and Management"),
  ];
  const r = resolveProgram(ties, "aviation");
  assert.equal(r.matched?.slug, "aviation"); // exact slug match wins
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
cd msstate-policies && npx tsx --test tests/online/search-program-resolver.test.ts
```

Expected: import failure (`resolveProgram` does not exist yet — only `fuzzyResolveProgram`).

- [ ] **Step 3: Implement resolveProgram in search.ts**

Replace the existing `fuzzyResolveProgram` function in `msstate-policies/src/online/search.ts:163-191` with:

```ts
// ---- Fuzzy resolver for get_online_program(name_query) ---------------------

/**
 * Tokens that appear in nearly every program's name or description and
 * carry zero discriminating signal. Stripped from query tokenization in
 * resolveProgram only (not in info-page search).
 */
const PROGRAM_STOP_WORDS = new Set([
  "online", "program", "degree", "msu", "msstate",
]);

export type ProgramMatchStrategy = "substring" | "bm25" | "no_signal" | "no_match";

export interface FuzzyResolveResult {
  matched: OnlineProgram | null;
  did_you_mean: Array<{ slug: string; name: string }>;
  match_strategy: ProgramMatchStrategy;
}

function tokenizeProgram(s: string): string[] {
  return tokenize(s).filter((t) => !PROGRAM_STOP_WORDS.has(t));
}

export function resolveProgram(programs: OnlineProgram[], query: string): FuzzyResolveResult {
  const qTokens = tokenizeProgram(query);
  if (qTokens.length === 0) {
    return { matched: null, did_you_mean: [], match_strategy: "no_signal" };
  }
  const qNorm = qTokens.join(" ");

  // Substring pre-stage: walk programs, score each
  const substringHits: Array<{ p: OnlineProgram; strength: number }> = [];
  for (const p of programs) {
    const slugNorm = p.slug.toLowerCase().replace(/-/g, " ");
    const nameNorm = p.name.toLowerCase();
    if (slugNorm === qNorm) {
      substringHits.push({ p, strength: 3 });            // exact slug
    } else if (slugNorm.includes(qNorm) || nameNorm.includes(qNorm)) {
      substringHits.push({ p, strength: 2 });            // substring
    } else if (qTokens.every((t) => slugNorm.includes(t) || nameNorm.includes(t))) {
      substringHits.push({ p, strength: 1 });            // all tokens present (different order)
    }
  }

  if (substringHits.length > 0) {
    substringHits.sort((a, b) =>
      b.strength - a.strength || a.p.name.length - b.p.name.length,
    );
    return {
      matched: substringHits[0].p,
      did_you_mean: substringHits.slice(1, 3).map((x) => ({ slug: x.p.slug, name: x.p.name })),
      match_strategy: "substring",
    };
  }

  // BM25 fallback (stop-word-filtered query tokens, existing 4/3/1 weights)
  const scored = programs.map((p) => {
    const slugT = tokenize(p.slug);
    const nameT = tokenize(p.name);
    const shortT = tokenize(p.short_description);
    let score = 0;
    for (const q of qTokens) {
      score += 4 * countOf(q, slugT);
      score += 3 * countOf(q, nameT);
      score += 1 * countOf(q, shortT);
    }
    return { p, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) {
    return { matched: null, did_you_mean: [], match_strategy: "no_match" };
  }
  return {
    matched: scored[0].p,
    did_you_mean: scored.slice(1, 3).map((x) => ({ slug: x.p.slug, name: x.p.name })),
    match_strategy: "bm25",
  };
}

/**
 * Back-compat alias for callers that haven't migrated yet. Same behavior as
 * resolveProgram but discards match_strategy. Remove in v1.2.0.
 */
export function fuzzyResolveProgram(programs: OnlineProgram[], query: string): {
  matched: OnlineProgram | null;
  did_you_mean: Array<{ slug: string; name: string }>;
} {
  const r = resolveProgram(programs, query);
  return { matched: r.matched, did_you_mean: r.did_you_mean };
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
cd msstate-policies && npx tsx --test tests/online/search-program-resolver.test.ts
```

Expected: all 6 scenarios PASS.

- [ ] **Step 5: Update get_online_program.ts to surface match_strategy**

Edit `msstate-policies/src/tools/get_online_program.ts`:

```ts
// Line 8 — change import:
import { resolveProgram } from "../online/search.js";

// Around line 40 — change call site:
} else if (input.name_query) {
  const r = resolveProgram(listAllPrograms(), input.name_query);
  matched = r.matched;
  did_you_mean = r.did_you_mean;
  if (!matched) {
    not_found_reason = r.match_strategy === "no_signal"
      ? `Query '${input.name_query}' had no discriminating tokens after stripping common words (online, program, degree, msu). Add a program name or subject keyword.`
      : `No program matched '${input.name_query}'. Try list_online_programs(subject_keyword=…) to browse.`;
  }
}
```

- [ ] **Step 6: Run full typecheck + tests**

```bash
cd msstate-policies && npm run typecheck && npx tsx --test tests/**/*.test.ts
```

Expected: typecheck clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add msstate-policies/src/online/search.ts \
        msstate-policies/src/tools/get_online_program.ts \
        msstate-policies/tests/online/search-program-resolver.test.ts
git commit -m "fix(online): resolveProgram with PROGRAM_STOP_WORDS + substring pre-stage"
```

---

### Task 4: Trigram similarity helper for did_you_mean

**Files:**
- Modify: `msstate-policies/src/online/search.ts` (add `trigramScore` near top, after `countOf`)
- Test: covered by Task 5's test file (the trigram helper is only used by `resolveStaff`)

- [ ] **Step 1: Add trigramScore function to search.ts**

Add to `msstate-policies/src/online/search.ts` after the existing `countOf` helper (around line 87):

```ts
/**
 * Jaccard similarity over character trigrams. Used by resolveStaff to suggest
 * did_you_mean alternates when a query doesn't match any staff member.
 * Inline implementation — no new dependency.
 *
 * Both inputs should already be normalized (lowercased, diacritic-stripped).
 */
function trigrams(s: string): Set<string> {
  const padded = ` ${s} `;
  const out = new Set<string>();
  for (let i = 0; i <= padded.length - 3; i++) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function trigramScore(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}
```

- [ ] **Step 2: Smoke-test compile**

```bash
cd msstate-policies && npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add msstate-policies/src/online/search.ts
git commit -m "feat(online): trigramScore helper (Jaccard over character trigrams, no new dep)"
```

---

### Task 5: resolveStaff helper + staff-resolver test suite

**Files:**
- Modify: `msstate-policies/src/online/search.ts` (add `resolveStaff` at end of file)
- Create: `msstate-policies/tests/online/search-staff-resolver.test.ts`

- [ ] **Step 1: Write the failing test (6 scenarios)**

Create `msstate-policies/tests/online/search-staff-resolver.test.ts`:

```ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveStaff, trigramScore } from "../../src/online/search.js";
import type { StaffEntry } from "../../src/online/types.js";

function s(name: string, email: string | null, role = "", programs: string[] = []): StaffEntry {
  return {
    display_name: name,
    email,
    role,
    programs: programs.map((slug) => ({ slug, name: slug.toUpperCase(), role_in_program: "Advisor" })),
  };
}

const INDEX: StaffEntry[] = [
  s("Lily Hudson", "lily.hudson@msstate.edu", "Coordinator", ["mba", "msw"]),
  s("Angelia Knight", "angelia.knight@msstate.edu", "Director, MBA Program", ["mba"]),
  s("Bob Knight", "bob.knight@msstate.edu", "Coach, MSW Program", ["msw"]),
  s("Élise Lamontagne", "elise.lamontagne@msstate.edu", "Advisor", ["psychology"]),
];

test("email exact match", () => {
  const r = resolveStaff(INDEX, "lily.hudson@msstate.edu");
  assert.equal(r.length, 1);
  assert.equal(r[0].display_name, "Lily Hudson");
});

test("email case-insensitive", () => {
  const r = resolveStaff(INDEX, "LILY.HUDSON@msstate.edu");
  assert.equal(r.length, 1);
});

test("first name substring", () => {
  const r = resolveStaff(INDEX, "Lily");
  assert.equal(r.length, 1);
  assert.equal(r[0].display_name, "Lily Hudson");
});

test("last name substring matches both Knights (ambiguous)", () => {
  const r = resolveStaff(INDEX, "Knight");
  assert.equal(r.length, 2);
  const names = r.map((x) => x.display_name).sort();
  assert.deepEqual(names, ["Angelia Knight", "Bob Knight"]);
});

test("no match returns empty array, caller responsible for did_you_mean", () => {
  const r = resolveStaff(INDEX, "NoSuchPerson");
  assert.deepEqual(r, []);
});

test("diacritic-normalized name match", () => {
  const r = resolveStaff(INDEX, "Elise");
  assert.equal(r.length, 1);
  assert.equal(r[0].display_name, "Élise Lamontagne");
});

test("trigramScore between similar names is high", () => {
  // "lily hudson" vs "lily huson" (typo) should score > 0.4
  assert.ok(trigramScore("lily hudson", "lily huson") > 0.4);
});

test("trigramScore between unrelated names is low", () => {
  assert.ok(trigramScore("lily hudson", "bob knight") < 0.2);
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
cd msstate-policies && npx tsx --test tests/online/search-staff-resolver.test.ts
```

Expected: import failure (`resolveStaff` does not exist yet).

- [ ] **Step 3: Implement resolveStaff in search.ts**

Append to `msstate-policies/src/online/search.ts`:

```ts
// ---- Staff resolver for list_programs_by_staff -----------------------------

import type { StaffEntry, StaffToProgramsIndex } from "./types.js";

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/\s+/g, " ")
    .trim();
}

export interface StaffMatch extends StaffEntry {
  match_kind: "email" | "substring" | "all_tokens";
}

export function resolveStaff(index: StaffToProgramsIndex, query: string): StaffMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  // Email path — exact match
  if (q.includes("@")) {
    return index
      .filter((s) => s.email && s.email.toLowerCase() === q)
      .map((s) => ({ ...s, match_kind: "email" as const }));
  }

  // Name path — diacritic-normalized substring or all-tokens-present
  const qNorm = normalizeForMatch(q);
  const qTokens = qNorm.split(" ").filter((t) => t.length > 0);
  const matches: StaffMatch[] = [];
  for (const s of index) {
    const nameNorm = normalizeForMatch(s.display_name);
    if (nameNorm.includes(qNorm)) {
      matches.push({ ...s, match_kind: "substring" });
    } else if (qTokens.length > 0 && qTokens.every((t) => nameNorm.includes(t))) {
      matches.push({ ...s, match_kind: "all_tokens" });
    }
  }

  const kindOrder = (k: StaffMatch["match_kind"]): number =>
    k === "email" ? 0 : k === "substring" ? 1 : 2;

  matches.sort((a, b) =>
    kindOrder(a.match_kind) - kindOrder(b.match_kind) ||
    a.display_name.length - b.display_name.length,
  );
  return matches;
}

/**
 * Suggest closest staff names for did_you_mean. Uses trigramScore over
 * normalized display names. Returns up to 3 names with score > 0.2.
 */
export function suggestStaff(index: StaffToProgramsIndex, query: string): string[] {
  const qNorm = normalizeForMatch(query);
  if (qNorm.length < 2) return [];
  const scored = index.map((s) => ({
    name: s.display_name,
    score: trigramScore(qNorm, normalizeForMatch(s.display_name)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score > 0.2).slice(0, 3).map((x) => x.name);
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
cd msstate-policies && npx tsx --test tests/online/search-staff-resolver.test.ts
```

Expected: all 8 scenarios PASS.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/online/search.ts \
        msstate-policies/tests/online/search-staff-resolver.test.ts
git commit -m "feat(online): resolveStaff + suggestStaff (email-primary, diacritic-normalized)"
```

---

## Phase 3 — parser.ts: build the inverted index (Task 6)

### Task 6: buildStaffToProgramsIndex

**Files:**
- Modify: `msstate-policies/src/online/parser.ts` (add exported function)
- Create: `msstate-policies/tests/online/parser-staff-index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `msstate-policies/tests/online/parser-staff-index.test.ts`:

```ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildStaffToProgramsIndex } from "../../src/online/parser.js";
import type { OnlineProgram, OnlineStaffEntry } from "../../src/online/types.js";

function prog(slug: string, contacts: Array<{ name: string; email: string | null; title: string }>): OnlineProgram {
  return {
    slug,
    name: `Online ${slug.toUpperCase()}`,
    degree_level: "master",
    format: "online",
    short_description: "",
    url: `https://www.online.msstate.edu/program/${slug}`,
    tuition: { per_credit_usd: null, instructional_fee_per_credit_usd: null, application_fee_domestic_usd: null, application_fee_international_usd: null, raw_prose: "" },
    contacts: contacts.map((c) => ({ ...c, phone: null })),
    application_deadlines: [],
    admission_requirements: "",
    entrance_exams: null,
    accreditation: null,
    forms: [],
    raw_sections: {},
    parse_warnings: [],
    retrieved_at: "2026-05-15T00:00:00Z",
  };
}

const STAFF_DIR: OnlineStaffEntry[] = [
  { name: "Lily Hudson", title: "Enrollment Coordinator", email: "lily.hudson@msstate.edu", phone: null, office: "CDE", url: "https://www.online.msstate.edu/staff", retrieved_at: "2026-05-15T00:00:00Z" },
];

const PROGRAMS: OnlineProgram[] = [
  prog("mba", [
    { name: "Lily Hudson", email: "lily.hudson@msstate.edu", title: "General Program Questions" },
    { name: "Angelia Knight", email: "angelia.knight@msstate.edu", title: "Director, MBA Program" },
  ]),
  prog("msw", [
    { name: "Lily Hudson", email: "lily.hudson@msstate.edu", title: "Enrollment & Onboarding" },
  ]),
];

test("staff appearing on 2 programs gets 2 program refs", () => {
  const idx = buildStaffToProgramsIndex(PROGRAMS, STAFF_DIR);
  const lily = idx.find((s) => s.display_name === "Lily Hudson");
  assert.ok(lily, "Lily Hudson should be in the index");
  assert.equal(lily!.email, "lily.hudson@msstate.edu");
  assert.equal(lily!.programs.length, 2);
  assert.deepEqual(lily!.programs.map((p) => p.slug).sort(), ["mba", "msw"]);
});

test("role_in_program is per-program label", () => {
  const idx = buildStaffToProgramsIndex(PROGRAMS, STAFF_DIR);
  const lily = idx.find((s) => s.display_name === "Lily Hudson")!;
  const mbaRef = lily.programs.find((p) => p.slug === "mba")!;
  const mswRef = lily.programs.find((p) => p.slug === "msw")!;
  assert.equal(mbaRef.role_in_program, "General Program Questions");
  assert.equal(mswRef.role_in_program, "Enrollment & Onboarding");
});

test("role enriched from staff_directory when email matches", () => {
  const idx = buildStaffToProgramsIndex(PROGRAMS, STAFF_DIR);
  const lily = idx.find((s) => s.display_name === "Lily Hudson")!;
  assert.equal(lily.role, "Enrollment Coordinator");
});

test("staff with no email keyed by normalized name", () => {
  const noEmail: OnlineProgram[] = [
    prog("test", [{ name: "Anonymous Person", email: null, title: "TA" }]),
  ];
  const idx = buildStaffToProgramsIndex(noEmail, []);
  assert.equal(idx.length, 1);
  assert.equal(idx[0].display_name, "Anonymous Person");
  assert.equal(idx[0].email, null);
});

test("longest spelling wins on dedup (Sam vs Samantha with same email)", () => {
  const dup: OnlineProgram[] = [
    prog("a", [{ name: "Sam Clardy", email: "sam@msstate.edu", title: "Coach" }]),
    prog("b", [{ name: "Samantha Clardy", email: "sam@msstate.edu", title: "Coach" }]),
  ];
  const idx = buildStaffToProgramsIndex(dup, []);
  assert.equal(idx.length, 1);
  assert.equal(idx[0].display_name, "Samantha Clardy");
  assert.equal(idx[0].programs.length, 2);
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-staff-index.test.ts
```

Expected: import failure (`buildStaffToProgramsIndex` does not exist).

- [ ] **Step 3: Implement buildStaffToProgramsIndex in parser.ts**

Append to `msstate-policies/src/online/parser.ts` (end of file, after the last existing export):

```ts
import type {
  StaffEntry,
  StaffToProgramsIndex,
  ProgramRef,
} from "./types.js";

function normalizeStaffKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the staff→programs inverted index from the assembled programs and
 * the central staff directory. Dedup key: lowercased email when present,
 * else normalized name. On collision, longest display_name wins.
 *
 * Each staff member's `role` is enriched from `staff_directory` (matched by
 * email) when available — falls back to the first program-contact title.
 */
export function buildStaffToProgramsIndex(
  programs: OnlineProgram[],
  staff_directory: OnlineStaffEntry[],
): StaffToProgramsIndex {
  const byKey = new Map<string, StaffEntry>();

  for (const p of programs) {
    for (const c of p.contacts) {
      const key = c.email
        ? c.email.toLowerCase()
        : normalizeStaffKey(c.name);
      if (!key) continue;

      const existing = byKey.get(key);
      const programRef: ProgramRef = {
        slug: p.slug,
        name: p.name,
        role_in_program: c.title,
      };

      if (existing) {
        // Longest spelling wins (handles "Sam" vs "Samantha")
        if (c.name.length > existing.display_name.length) {
          existing.display_name = c.name;
        }
        existing.programs.push(programRef);
      } else {
        byKey.set(key, {
          display_name: c.name,
          email: c.email ?? null,
          role: c.title,
          programs: [programRef],
        });
      }
    }
  }

  // Enrich role from staff_directory by email match (more authoritative title)
  for (const entry of byKey.values()) {
    if (!entry.email) continue;
    const dirEntry = staff_directory.find(
      (s) => s.email && s.email.toLowerCase() === entry.email!.toLowerCase(),
    );
    if (dirEntry && dirEntry.title) {
      entry.role = dirEntry.title;
    }
  }

  return Array.from(byKey.values());
}
```

Also ensure the file imports `OnlineProgram` and `OnlineStaffEntry` at the top — they should already be imported but verify the import block includes both. If not, add to the existing import:

```ts
import type {
  OnlineProgram,
  OnlineProgramTuition,
  OnlineContact,
  OnlineApplicationDeadline,
  OnlineEntranceExams,
  OnlineParseWarning,
  OnlineStaffEntry,        // ← add if missing
} from "./types.js";
```

- [ ] **Step 4: Run test, expect PASS**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-staff-index.test.ts
```

Expected: all 5 scenarios PASS.

- [ ] **Step 5: Commit**

```bash
git add msstate-policies/src/online/parser.ts \
        msstate-policies/tests/online/parser-staff-index.test.ts
git commit -m "feat(online): buildStaffToProgramsIndex (email-primary dedup, longest-spelling-wins)"
```

---

## Phase 4 — Tool integration (Tasks 7-11)

### Task 7: corpus.ts plumbing for staff_to_programs

**Files:**
- Modify: `msstate-policies/src/online/corpus.ts`

- [ ] **Step 1: Add accessor**

Edit `msstate-policies/src/online/corpus.ts`:

Update the import block (line 12-18):

```ts
import type {
  OnlineCorpus,
  OnlineProgram,
  OnlineAdmissionsProcess,
  OnlineStaffEntry,
  OnlineInfoPage,
  StaffToProgramsIndex,
} from "./types.js";
```

Add a new exported accessor after `getAllInfoPages` (around line 50):

```ts
export function getStaffToProgramsIndex(): StaffToProgramsIndex {
  return CORPUS?.staff_to_programs ?? [];
}
```

Update `OnlineCorpusHealth` and `onlineCorpusHealth` to surface staff-index size:

```ts
export interface OnlineCorpusHealth {
  loaded: boolean;
  program_count: number;
  staff_count: number;
  info_page_count: number;
  staff_to_programs_count: number;
  builtAt: string | null;
}

export function onlineCorpusHealth(): OnlineCorpusHealth {
  if (!CORPUS) {
    return {
      loaded: false,
      program_count: 0,
      staff_count: 0,
      info_page_count: 0,
      staff_to_programs_count: 0,
      builtAt: null,
    };
  }
  return {
    loaded: true,
    program_count: CORPUS.programs.length,
    staff_count: CORPUS.staff.length,
    info_page_count: CORPUS.info_pages.length,
    staff_to_programs_count: CORPUS.staff_to_programs.length,
    builtAt: CORPUS.builtAt,
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd msstate-policies && npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add msstate-policies/src/online/corpus.ts
git commit -m "feat(online): corpus.ts exposes getStaffToProgramsIndex + health stats"
```

---

### Task 8: list_programs_by_staff.ts tool handler

**Files:**
- Create: `msstate-policies/src/tools/list_programs_by_staff.ts`

- [ ] **Step 1: Create the tool file**

Create `msstate-policies/src/tools/list_programs_by_staff.ts`:

```ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  getStaffToProgramsIndex,
  getOnlineCorpus,
} from "../online/corpus.js";
import { resolveStaff, suggestStaff } from "../online/search.js";
import { ONLINE_DISCLAIMER, MAX_QUERY_CHARS } from "../online/types.js";

const Input = z
  .object({
    query: z.string().min(1).max(MAX_QUERY_CHARS),
  })
  .strict();

export const list_programs_by_staff = {
  name: "list_programs_by_staff",
  description:
    "Look up the MSU Online programs a Center for Distance Education staff member is responsible for. " +
    "Query by email (preferred — unambiguous) or by name (first, last, or full name). " +
    "Returns each matching staff member's program portfolio with their role label per program. " +
    "Use for 'what programs am I responsible for?' or 'who handles the MBA?' workflows. " +
    "Email match is exact and case-insensitive; name match is case-insensitive substring (or all-tokens-present) " +
    "with diacritic normalization (so 'Elise' matches 'Élise'). " +
    "Ambiguous queries return ≥2 matches surfaced so the model can disambiguate. " +
    "No-match returns empty matches + did_you_mean (closest names by trigram similarity).",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const index = getStaffToProgramsIndex();
    const matches = resolveStaff(index, input.query);
    const corpus = getOnlineCorpus();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: ONLINE_DISCLAIMER,
            query: input.query,
            match_count: matches.length,
            matches: matches.map((m) => ({
              staff: {
                display_name: m.display_name,
                email: m.email,
                role: m.role,
                match_kind: m.match_kind,
              },
              programs: m.programs,
              program_count: m.programs.length,
            })),
            did_you_mean: matches.length === 0 ? suggestStaff(index, input.query) : [],
            corpus_built_at: corpus?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
```

- [ ] **Step 2: Typecheck**

```bash
cd msstate-policies && npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add msstate-policies/src/tools/list_programs_by_staff.ts
git commit -m "feat(online): list_programs_by_staff tool handler"
```

---

### Task 9: Register list_programs_by_staff in src/index.ts

**Files:**
- Modify: `msstate-policies/src/index.ts`

- [ ] **Step 1: Add import and registration**

Find the import block for online tools in `msstate-policies/src/index.ts` and add:

```ts
import { list_programs_by_staff } from "./tools/list_programs_by_staff.js";
```

Find the array that lists all registered tools (search for `find_online_info` to locate it) and add `list_programs_by_staff` in the online block. The exact location depends on current ordering — place it after `find_online_info`:

```ts
const TOOLS = [
  // ... existing tools ...
  list_online_programs,
  get_online_program,
  get_online_admissions_process,
  find_online_info,
  list_programs_by_staff,           // ← NEW
  list_msu_dining_locations,
  get_msu_dining_hours,
  health_check,
];
```

- [ ] **Step 2: Verify the stdio bundle exposes 25 tools**

```bash
cd msstate-policies && npm run build
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node dist/index.js | head -n1 \
  | node -e 'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{const r=JSON.parse(d);console.log("tool count:",r.result.tools.length);console.log("has list_programs_by_staff:",r.result.tools.some(t=>t.name==="list_programs_by_staff"));})'
```

Expected output:

```
tool count: 25
has list_programs_by_staff: true
```

- [ ] **Step 3: Commit**

```bash
git add msstate-policies/src/index.ts
git commit -m "feat(online): register list_programs_by_staff tool (count 24 -> 25)"
```

---

### Task 10: Update OnlineCorpus consumers + setOnlineCorpus

**Files:**
- Modify: `msstate-policies/src/online/corpus.ts` (defensive default in setOnlineCorpus)

This task handles the case where a stale `dist/index.js` calls `setOnlineCorpus` with a payload missing `staff_to_programs` (e.g., loading a v1.1.0 bundle in v1.1.1 code path). Default to `[]` so the runtime doesn't crash.

- [ ] **Step 1: Add defensive default**

Edit `msstate-policies/src/online/corpus.ts` `setOnlineCorpus`:

```ts
export function setOnlineCorpus(c: OnlineCorpus): void {
  // Backfill for older corpus snapshots that lack staff_to_programs.
  // New builds always include it; this guards against load-time crashes
  // when a stale dist is paired with new code.
  if (!Array.isArray((c as { staff_to_programs?: unknown }).staff_to_programs)) {
    (c as { staff_to_programs: StaffToProgramsIndex }).staff_to_programs = [];
  }
  CORPUS = c;
  indexInfoPages(c.info_pages, c.staff);
}
```

- [ ] **Step 2: Typecheck**

```bash
cd msstate-policies && npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add msstate-policies/src/online/corpus.ts
git commit -m "feat(online): setOnlineCorpus backfills staff_to_programs=[] on legacy payloads"
```

---

### Task 11: Worker mirror — list_programs_by_staff dispatch

**Files:**
- Modify: `worker/src/index.ts`

The Worker has its own inline implementation of online tools (per the existing stdio/worker dual-source pattern). Mirror types, helpers, tool-list entry, and dispatch case.

- [ ] **Step 1: Add type and constant mirrors near other online types**

Find the existing `OnlineProgram` type / `ONLINE` corpus reference in `worker/src/index.ts` (around line 1480 based on existing usage). Add nearby:

```ts
type ProgramRef = { slug: string; name: string; role_in_program: string };
type StaffEntry = { display_name: string; email: string | null; role: string; programs: ProgramRef[] };
type StaffMatch = StaffEntry & { match_kind: "email" | "substring" | "all_tokens" };
```

The Worker reads `BAKED_CORPUS` (whatever constant it currently uses for corpus.json contents). Add a getter for `staff_to_programs`:

```ts
const ONLINE_STAFF_INDEX: StaffEntry[] = (BAKED_CORPUS?.online?.staff_to_programs as StaffEntry[]) ?? [];
```

Put it next to the existing `ONLINE`/`ONLINE_PROGRAMS` constants — same pattern used for `ONLINE.programs` etc.

- [ ] **Step 2: Add resolveStaff + suggestStaff + trigramScore helpers**

Copy the implementations from `msstate-policies/src/online/search.ts` into `worker/src/index.ts` (Worker has no shared module imports across the stdio/worker boundary — per existing pattern, code is duplicated). Place near the other online helpers (around line 1980 where `onlFuzzyResolveProgram` lives):

```ts
function workerNormalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function workerTrigrams(s: string): Set<string> {
  const padded = ` ${s} `;
  const out = new Set<string>();
  for (let i = 0; i <= padded.length - 3; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function workerTrigramScore(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = workerTrigrams(a);
  const B = workerTrigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function workerResolveStaff(index: StaffEntry[], query: string): StaffMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  if (q.includes("@")) {
    return index
      .filter((s) => s.email && s.email.toLowerCase() === q)
      .map((s) => ({ ...s, match_kind: "email" as const }));
  }
  const qNorm = workerNormalizeForMatch(q);
  const qTokens = qNorm.split(" ").filter((t) => t.length > 0);
  const matches: StaffMatch[] = [];
  for (const s of index) {
    const nameNorm = workerNormalizeForMatch(s.display_name);
    if (nameNorm.includes(qNorm)) {
      matches.push({ ...s, match_kind: "substring" });
    } else if (qTokens.length > 0 && qTokens.every((t) => nameNorm.includes(t))) {
      matches.push({ ...s, match_kind: "all_tokens" });
    }
  }
  const order = (k: StaffMatch["match_kind"]): number =>
    k === "email" ? 0 : k === "substring" ? 1 : 2;
  matches.sort((a, b) =>
    order(a.match_kind) - order(b.match_kind) ||
    a.display_name.length - b.display_name.length,
  );
  return matches;
}

function workerSuggestStaff(index: StaffEntry[], query: string): string[] {
  const qNorm = workerNormalizeForMatch(query);
  if (qNorm.length < 2) return [];
  return index
    .map((s) => ({ name: s.display_name, score: workerTrigramScore(qNorm, workerNormalizeForMatch(s.display_name)) }))
    .sort((a, b) => b.score - a.score)
    .filter((x) => x.score > 0.2)
    .slice(0, 3)
    .map((x) => x.name);
}
```

- [ ] **Step 3: Mirror the PROGRAM_STOP_WORDS + substring pre-stage in workerFuzzyResolveProgram**

Find the existing `onlFuzzyResolveProgram` helper in `worker/src/index.ts` (currently the broken-for-online-MBA version) and rewrite it to match the new stdio behavior:

```ts
const WORKER_PROGRAM_STOP_WORDS = new Set(["online", "program", "degree", "msu", "msstate"]);

function workerTokenizeProgram(s: string): string[] {
  return tokenize(s).filter((t) => !WORKER_PROGRAM_STOP_WORDS.has(t));
}

function onlFuzzyResolveProgram(query: string): {
  matched: OnlineProgram | null;
  did_you_mean: Array<{ slug: string; name: string }>;
  match_strategy: "substring" | "bm25" | "no_signal" | "no_match";
} {
  const programs = ONLINE?.programs ?? [];
  const qTokens = workerTokenizeProgram(query);
  if (qTokens.length === 0) {
    return { matched: null, did_you_mean: [], match_strategy: "no_signal" };
  }
  const qNorm = qTokens.join(" ");

  const substringHits: Array<{ p: OnlineProgram; strength: number }> = [];
  for (const p of programs) {
    const slugNorm = p.slug.toLowerCase().replace(/-/g, " ");
    const nameNorm = p.name.toLowerCase();
    if (slugNorm === qNorm) substringHits.push({ p, strength: 3 });
    else if (slugNorm.includes(qNorm) || nameNorm.includes(qNorm)) substringHits.push({ p, strength: 2 });
    else if (qTokens.every((t) => slugNorm.includes(t) || nameNorm.includes(t))) substringHits.push({ p, strength: 1 });
  }
  if (substringHits.length > 0) {
    substringHits.sort((a, b) => b.strength - a.strength || a.p.name.length - b.p.name.length);
    return {
      matched: substringHits[0].p,
      did_you_mean: substringHits.slice(1, 3).map((x) => ({ slug: x.p.slug, name: x.p.name })),
      match_strategy: "substring",
    };
  }
  // BM25 fallback — copy existing scoring loop but use qTokens (stop-word filtered)
  const scored = programs.map((p) => {
    const slugT = tokenize(p.slug);
    const nameT = tokenize(p.name);
    const shortT = tokenize(p.short_description);
    let score = 0;
    for (const q of qTokens) {
      for (const tok of slugT) if (tok === q) score += 4;
      for (const tok of nameT) if (tok === q) score += 3;
      for (const tok of shortT) if (tok === q) score += 1;
    }
    return { p, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { matched: null, did_you_mean: [], match_strategy: "no_match" };
  return {
    matched: scored[0].p,
    did_you_mean: scored.slice(1, 3).map((x) => ({ slug: x.p.slug, name: x.p.name })),
    match_strategy: "bm25",
  };
}
```

(Note: `tokenize` is the existing worker-side helper. If it's named differently in worker/src/index.ts, use whatever exists. If `onlFuzzyResolveProgram` is referenced in get_online_program's case block, update the consumer to handle the new `match_strategy` field for not_found_reason wording — same edits as Task 3 step 5.)

- [ ] **Step 4: Add tool-list entry**

Find the `tools/list` response array. After the `find_online_info` entry, insert:

```ts
{
  name: "list_programs_by_staff",
  description:
    "Look up the MSU Online programs a Center for Distance Education staff member is responsible for. " +
    "Query by email (preferred) or name (first, last, or full). Returns matching staff with full program portfolio + per-program role labels. " +
    "Ambiguous names surface ≥2 matches; no match returns did_you_mean closest names.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 4096, description: "Email or name." },
    },
    required: ["query"],
    additionalProperties: false,
  },
},
```

- [ ] **Step 5: Add tools/call dispatch case**

Find the `case "find_online_info":` block in the `tools/call` switch. Add the new case after it:

```ts
case "list_programs_by_staff": {
  const a = args as Record<string, unknown>;
  const query = typeof a.query === "string" ? a.query : "";
  if (!query) return errorContent("query is required.");
  if (query.length > MAX_QUERY_CHARS) return tooLong("query", query);
  const matches = workerResolveStaff(ONLINE_STAFF_INDEX, query);
  return jsonContent({
    disclaimer: ONLINE_DISCLAIMER,
    query,
    match_count: matches.length,
    matches: matches.map((m) => ({
      staff: {
        display_name: m.display_name,
        email: m.email,
        role: m.role,
        match_kind: m.match_kind,
      },
      programs: m.programs,
      program_count: m.programs.length,
    })),
    did_you_mean: matches.length === 0 ? workerSuggestStaff(ONLINE_STAFF_INDEX, query) : [],
    corpus_built_at: ONLINE?.builtAt ?? null,
  });
}
```

- [ ] **Step 6: Bump the version string**

In `worker/src/index.ts`, find the `"1.1.0"` string used in the `InitializeResult.serverInfo` and the `/info` GET handler. Replace both occurrences with `"1.1.1"`.

- [ ] **Step 7: Typecheck Worker**

```bash
cd worker && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): mirror list_programs_by_staff + PROGRAM_STOP_WORDS in fuzzyResolveProgram (v1.1.1)"
```

---

## Phase 5 — Build pipeline (Tasks 12-13)

### Task 12: scripts/_scrape-online.ts — emit staff_to_programs

**Files:**
- Modify: `scripts/_scrape-online.ts`

- [ ] **Step 1: Import and emit**

Edit `scripts/_scrape-online.ts`:

```ts
console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

import { scrapeAllOnline } from "../msstate-policies/src/online/scraper.js";
import { buildStaffToProgramsIndex } from "../msstate-policies/src/online/parser.js";

async function main(): Promise<void> {
  process.stderr.write("[scrape-online] starting two-pass scrape...\n");
  const r = await scrapeAllOnline();
  process.stderr.write(
    `[scrape-online]   ${r.programs.length} programs, ${r.staff.length} staff, ${r.info_pages.length} info pages, anyError=${r.anyError}\n`,
  );
  const programWithWarnings = r.programs.filter((p) => p.parse_warnings.length > 0).length;
  process.stderr.write(`[scrape-online]   ${programWithWarnings} programs have parse_warnings\n`);
  for (const [src, info] of Object.entries(r.per_source)) {
    if (!info.ok) process.stderr.write(`[scrape-online]   FAIL ${src}: ${info.error}\n`);
  }
  const staff_to_programs = buildStaffToProgramsIndex(r.programs, r.staff);
  const totalRefs = staff_to_programs.reduce((sum, s) => sum + s.programs.length, 0);
  process.stderr.write(
    `[scrape-online]   staff_to_programs: ${staff_to_programs.length} staff, ${totalRefs} program refs\n`,
  );
  process.stdout.write(
    JSON.stringify({
      programs: r.programs,
      admissions_process: r.admissions_process,
      staff: r.staff,
      info_pages: r.info_pages,
      staff_to_programs,
      per_source: r.per_source,
      anyError: r.anyError,
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`[scrape-online] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-test the subprocess**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
npx tsx scripts/_scrape-online.ts 2>/tmp/scrape-online.err 1>/tmp/scrape-online.out
```

This is a live scrape against online.msstate.edu — expected runtime 60-120 seconds.

After it finishes:

```bash
node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/scrape-online.out","utf8")); console.log("programs:",j.programs.length,"staff:",j.staff.length,"staff_to_programs:",j.staff_to_programs.length,"total_refs:",j.staff_to_programs.reduce((s,e)=>s+e.programs.length,0)); console.log("first_staff:",JSON.stringify(j.staff_to_programs[0],null,2).slice(0,400));'
```

Expected: non-zero `staff_to_programs.length` (≥10), non-zero `total_refs`, first staff entry has `display_name`, `email`, `role`, and a non-empty `programs[]`.

- [ ] **Step 3: Commit**

```bash
git add scripts/_scrape-online.ts
git commit -m "feat(scrape): _scrape-online emits staff_to_programs index"
```

---

### Task 13: scripts/build-worker-corpus.mjs — 2 new abort sites

**Files:**
- Modify: `scripts/build-worker-corpus.mjs` (function `scrapeOnlineViaSubprocess`)

- [ ] **Step 1: Find the online block validations**

Locate `scrapeOnlineViaSubprocess` in `scripts/build-worker-corpus.mjs` (around line 480-585 per earlier search). After the existing parser-warning ceiling checks and BEFORE the function returns, add:

```js
  // v1.1.1: staff_to_programs index must be present and populated
  if (!Array.isArray(parsed.staff_to_programs) || parsed.staff_to_programs.length === 0) {
    throw new Error(
      "online: staff_to_programs index is empty or missing - refusing to ship a poisoned online corpus",
    );
  }
  const totalStaffRefs = parsed.staff_to_programs.reduce(
    (sum, s) => sum + (Array.isArray(s.programs) ? s.programs.length : 0),
    0,
  );
  if (totalStaffRefs === 0) {
    throw new Error(
      "online: staff_to_programs has 0 program refs across all staff - refusing to ship a poisoned online corpus",
    );
  }
  console.error(
    `[build-worker-corpus]   staff_to_programs: ${parsed.staff_to_programs.length} staff, ${totalStaffRefs} program refs`,
  );
```

- [ ] **Step 2: Verify abort-site count**

```bash
grep -c "refusing to ship a poisoned online corpus" scripts/build-worker-corpus.mjs
```

Expected: `15` (was 13 + 2 new sites).

- [ ] **Step 3: Commit**

```bash
git add scripts/build-worker-corpus.mjs
git commit -m "build: 2 new abort sites for empty staff_to_programs index"
```

---

## Phase 6 — Eval + security + docs + CI (Tasks 14-17)

### Task 14: Eval rows (10 fuzzy + 5 staff) — CORPUS RULE applies

**Files:**
- Modify: `msstate-policies/eval/online.jsonl`

**CRITICAL — corpus rule:** every `expected_slug` and every staff email/name in this eval MUST be confirmed against a live `online.msstate.edu` scrape OR the freshly-built `worker/corpus.json` in the same session. Never author from memory or training data.

- [ ] **Step 1: Read existing eval format**

```bash
head -3 msstate-policies/eval/online.jsonl
```

Note the exact shape (likely `{q, expected_*, bucket, ...}`).

- [ ] **Step 2: Build a fresh local corpus to source slugs from**

(Re-uses the scrape output from Task 12. If `/tmp/scrape-online.out` is stale, re-run `npx tsx scripts/_scrape-online.ts > /tmp/scrape-online.out`.)

```bash
# List all live program slugs
node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/scrape-online.out","utf8")); console.log(j.programs.map(p=>p.slug + " :: " + p.name).join("\n"));' > /tmp/online-slugs.txt
head -20 /tmp/online-slugs.txt
```

- [ ] **Step 3: Author 10 fuzzy regression rows**

Append to `msstate-policies/eval/online.jsonl`. Pattern coverage from spec (substitute live slugs):

```jsonl
{"q":"online MBA","bucket":"fuzzy_regression","expected_tool":"get_online_program","expected_slug":"<LIVE_MBA_SLUG>","note":"online stop-word + slug substring"}
{"q":"online MSW","bucket":"fuzzy_regression","expected_tool":"get_online_program","expected_slug":"<LIVE_MSW_SLUG>","note":"acronym in slug"}
{"q":"online social work","bucket":"fuzzy_regression","expected_tool":"get_online_program","expected_slug":"<LIVE_MSW_SLUG>","note":"spelled-out name substring"}
{"q":"online psychology bachelor","bucket":"fuzzy_regression","expected_tool":"get_online_program","expected_slug":"<LIVE_PSY_BA_SLUG>","note":"all-tokens-present"}
{"q":"online cybersecurity","bucket":"fuzzy_regression","expected_tool":"get_online_program","expected_slug":"<LIVE_CYBER_SLUG>","note":"single keyword"}
{"q":"online MS in computer science","bucket":"fuzzy_regression","expected_tool":"get_online_program","expected_slug":"<LIVE_CS_SLUG>","note":"all-tokens-present"}
{"q":"online BAS business","bucket":"fuzzy_regression","expected_tool":"get_online_program","expected_slug":"<LIVE_BAS_BOT_SLUG>","note":"slug-token + name-token"}
{"q":"online graduate education","bucket":"fuzzy_regression","expected_tool":"get_online_program","expected_slug":"<LIVE_M_ED_SLUG>","note":"first matching ed grad"}
{"q":"online RN to BSN","bucket":"fuzzy_regression","expected_tool":"get_online_program","expected_slug":"<LIVE_RN_TO_BSN_SLUG>","note":"acronym phrase"}
{"q":"online ag economics","bucket":"fuzzy_regression","expected_tool":"get_online_program","expected_slug":"<LIVE_AG_ECON_SLUG>","note":"abbreviation"}
```

For each `<LIVE_*_SLUG>` placeholder, look it up in `/tmp/online-slugs.txt` and substitute the exact slug. If a category isn't represented in the live corpus (e.g., MSU discontinued it), substitute another live program of the same shape and update the `note` field.

- [ ] **Step 4: Author 5 staff-lookup rows**

```bash
# Pull a few real staff entries to source emails + names from
node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/scrape-online.out","utf8")); j.staff_to_programs.slice(0,5).forEach(s=>console.log(s.display_name,"::",s.email,"::",s.programs.length+" programs"));'
```

Append 5 rows (substitute LIVE_* placeholders with values from the staff_to_programs dump):

```jsonl
{"q":"<ONE_LIVE_STAFF_EMAIL>","bucket":"staff_lookup","expected_tool":"list_programs_by_staff","expected_match_count_min":1,"expected_programs_min":1,"note":"email exact match"}
{"q":"<ONE_LIVE_FIRST_NAME_UNIQUE>","bucket":"staff_lookup","expected_tool":"list_programs_by_staff","expected_match_count":1,"note":"first name substring"}
{"q":"<ONE_LIVE_LAST_NAME_UNIQUE>","bucket":"staff_lookup","expected_tool":"list_programs_by_staff","expected_match_count":1,"note":"last name substring"}
{"q":"<ONE_LIVE_SHARED_SUBSTRING>","bucket":"staff_lookup","expected_tool":"list_programs_by_staff","expected_match_count_min":2,"note":"ambiguous - multiple staff share substring"}
{"q":"NoSuchPersonZZZ","bucket":"staff_lookup","expected_tool":"list_programs_by_staff","expected_match_count":0,"expected_did_you_mean_max":3,"note":"no-match w/ did_you_mean"}
```

For the "shared substring" row, run this to find one:

```bash
node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/scrape-online.out","utf8")); const byLast=new Map(); for(const s of j.staff_to_programs){const last=s.display_name.split(" ").pop().toLowerCase();byLast.set(last,(byLast.get(last)||0)+1)} for(const [k,v] of byLast) if(v>=2) console.log(k,v);'
```

If output is empty (no shared last names exist in live data), the eval row author replaces the `"q"` with a longer shared substring (e.g., a common first initial or a partial name) that does match ≥2 staff. Document the choice in the `note` field.

- [ ] **Step 5: Verify the JSONL parses**

```bash
node -e 'const fs=require("fs"); const lines=fs.readFileSync("msstate-policies/eval/online.jsonl","utf8").split("\n").filter(Boolean); console.log("rows:",lines.length); for(const l of lines){try{JSON.parse(l)}catch(e){console.error("BAD:",l.slice(0,80));process.exit(1)}}'
```

Expected output: `rows: 45` (30 existing + 15 new), no `BAD:` lines.

- [ ] **Step 6: Commit**

```bash
git add msstate-policies/eval/online.jsonl
git commit -m "eval(online): +10 fuzzy regression + 5 staff lookup cases (corpus-rule sourced)"
```

---

### Task 15: Security checklist target bumps

**Files:**
- Modify: `tools/security-checklist.sh` (ONL4 + ONL5 checks)

- [ ] **Step 1: Find ONL4 and ONL5 in the checklist**

```bash
grep -n "ONL4\|ONL5\|poisoned online corpus\|ONLINE_DISCLAIMER" tools/security-checklist.sh
```

This identifies the lines that need updating.

- [ ] **Step 2: Update ONL4 minimum count**

ONL4 currently asserts ≥8 occurrences of `"refusing to ship a poisoned online corpus"` in `scripts/build-worker-corpus.mjs`. Bump to ≥10. Find the assertion (likely `if [ "$count" -lt 8 ]`) and change `8` → `10`.

Update the PASS message if it mentions the count (e.g., `"... (>=8 sites)"` → `"... (>=10 sites)"`).

- [ ] **Step 3: Update ONL5 tool-file count**

ONL5 currently greps for `ONLINE_DISCLAIMER` references across 4 online tool files. The new `list_programs_by_staff.ts` is a 5th. Find the assertion (likely a file-count or per-file check) and update to require 5 files instead of 4.

If the check uses a glob (`src/tools/{list_online_programs,get_online_program,get_online_admissions_process,find_online_info}.ts`), extend it to include `list_programs_by_staff`.

If the check uses a count (`if [ "$tool_count_with_disclaimer" -lt 4 ]`), bump 4 → 5.

- [ ] **Step 4: Run the checklist locally**

```bash
bash tools/security-checklist.sh 2>&1 | grep -E "ONL[345]|score" | tail -10
```

Expected: ONL4 PASS, ONL5 PASS, final score 284.

- [ ] **Step 5: Commit**

```bash
git add tools/security-checklist.sh
git commit -m "chore(security): bump ONL4 target (>=10) and ONL5 file count (=5) for v1.1.1"
```

---

### Task 16: CI smoke-test bump (24 → 25)

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Update the assertion**

In `.github/workflows/ci.yml`, find the step `tools/list smoke test (must list exactly 24 tools — ...)`. Update:

```yaml
      - name: tools/list smoke test (must list exactly 25 tools — 4 policy + 2 calendar + 3 course + 4 emergency + 4 tuition + 4 online + 1 staff-lookup + 2 dining + 1 health)
        run: |
          PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
          COUNT=$(printf '%s\n' "$PAYLOAD" | node dist/index.js | head -n1 | jq -r '.result.tools | length')
          echo "tool count = $COUNT"
          test "$COUNT" = "25"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: bump tools/list smoke test count 24 -> 25 (v1.1.1 list_programs_by_staff)"
```

---

### Task 17: Documentation updates

**Files:**
- Modify: `README.md` (tool count + new tool row)
- Modify: `CLAUDE.md` (v1.1.1 addendum + intro tool count)
- Modify: `docs/BUILD.md` (extend online module section)
- Modify: `msstate-policies/README.md` (tool count + new tool entry)

- [ ] **Step 1: README.md updates**

In `/Users/minsub/vscode/msstate-mcp/msstate-mcp/README.md`:

- Update hero line: `**24 MCP tools across 7 MSU content domains.**` → `**25 MCP tools across 7 MSU content domains.**` and `v1.1.0` → `v1.1.1`.
- Update install-section tool-count mentions: every `24 tools` → `25 tools`.
- Update `## The 24 tools` heading → `## The 25 tools`.
- In the Online (4) row, change to Online (5) and add:
  ```
  | `list_programs_by_staff` | Reverse-lookup: given an email or staff name, return their full MSU Online program portfolio with per-program role labels. The killer tool for the Center for Distance Education "what's mine?" workflow. |
  ```
  Place it after `find_online_info`.
- "Online programs" example questions section: add 1-2 examples like *"What programs is Lily Hudson responsible for?"* and *"Who handles the online MBA?"*

- [ ] **Step 2: CLAUDE.md updates**

In `CLAUDE.md`:

- Update the `## What this repo is` paragraph: tool count `**24**` → `**25**`, version `**v1.1.0**` → `**v1.1.1**`, breakdown `(... + 4 online + 2 dining + 1 health)` → `(... + 5 online + 2 dining + 1 health)`.
- Append a new addendum section at the bottom (after the dining addendum):

```markdown
### Corpus extension (2026-05-15) — online module fixes (v1.1.1)

Patches three bugs and adds one tool over the existing online module. No
new corpus sources; same `ONLINE_ROOTS` allowlist.

**Bugs fixed:**
- `get_online_program(name_query="online MBA")` now resolves deterministically
  to the MBA program. New `PROGRAM_STOP_WORDS = {online, program, degree,
  msu, msstate}` filter on query tokens + substring pre-stage on slug + name
  before BM25 fallback.
- `parseTuition` strips `script, style, noscript, iframe, nav, header,
  footer` before `.text()` extraction. Fixes GTM noscript-iframe leakage
  into `tuition.raw_prose`.

**New tool:** `list_programs_by_staff(query)` — email-primary, name-fallback
reverse lookup over a staff→programs inverted index baked into
`corpus.json.online.staff_to_programs` at scrape time. Tool count 24 → 25.

**Build aborts** (2 new sites, total 15 with canonical "refusing to ship
a poisoned online corpus" string): empty `staff_to_programs` index;
zero program refs across all staff entries.

**Security checks updated:** ONL4 target ≥10 (was 8). ONL5 references in 5
tool files (was 4 — new `list_programs_by_staff.ts`). Score stays at **284**.
```

- [ ] **Step 3: docs/BUILD.md updates**

In `docs/BUILD.md`:

- Find the `## MSU Online module (v1.0.0, 2026-05-13)` section. Append a new sub-section at the end of that section:

```markdown
### v1.1.1 fixes (2026-05-15)

Surfaced by live testing against the deployed Worker:

1. **Fuzzy resolver fixed for "online <X>" queries.** Old behavior:
   `get_online_program(name_query="online MBA")` returned BAS-BOT because
   "online" appears in every program's name and short_description, and the
   short marketing copy outscored the literal slug match. Fix: introduce
   `PROGRAM_STOP_WORDS = {online, program, degree, msu, msstate}` and a
   substring pre-stage that returns deterministic matches when the
   stop-word-stripped query is a substring of slug or name. BM25 (with
   stop-word-filtered tokens) is the fallback when no substring hits.

2. **`list_programs_by_staff` tool.** Reverse-lookup over a `staff_to_programs`
   inverted index baked into `corpus.json` at scrape time. Email-primary
   resolution (case-insensitive, exact match); name-fallback uses
   diacritic-normalized substring or all-tokens-present matching.
   Ambiguous names surface ≥2 matches so the model can disambiguate;
   no-match returns up to 3 `did_you_mean` suggestions ranked by trigram
   Jaccard similarity (~30 LOC inline, no new dep).

3. **HTML strip in `parseTuition`.** Both call sites (primary
   `.tuitioncowbell` path and BAS-style `quickInner` fallback) now call
   `.find('script, style, noscript, iframe, nav, header, footer').remove()`
   before `.text()`. Fixes the GTM-noscript-iframe leakage observed in
   BAS-BOT's `tuition.raw_prose`.

**Eval delta:** +10 fuzzy regression cases + 5 staff lookup cases. Online
suite goes 30 → 45 questions. Ship-blocker: 100% on regression bucket,
100% on new tool bucket, 100% on existing 30.

**Build-time guards added:** 2 new abort sites (total 15) using the
canonical `"refusing to ship a poisoned online corpus"` string for empty
or zero-ref staff index.

**Source-data quirk handled (do not regress):** GTM injects a
`<noscript><iframe>` fallback on every program page. cheerio's `.text()`
recurses into `<noscript>` content as plain text; that's why the chrome
strip is mandatory before extracting verbatim prose.
```

- [ ] **Step 4: msstate-policies/README.md updates**

In `msstate-policies/README.md`:

- Hero line: `Current version: **v1.1.0** (2026-05-14)` → `Current version: **v1.1.1** (2026-05-15)`.
- `## Tools (24)` → `## Tools (25)`.
- Online (4) bullet → Online (5) and add `list_programs_by_staff` to the list.
- Update root-README link if anchor changed: `[root README](../README.md#the-24-tools)` → `[root README](../README.md#the-25-tools)`.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md docs/BUILD.md msstate-policies/README.md
git commit -m "docs(v1.1.1): online module fixes addenda + 24 -> 25 tool count"
```

---

## Phase 7 — Release ritual (Tasks 18-21)

### Task 18: Version bumps

**Files:**
- Modify: `msstate-policies/package.json` (line with `"version"`)
- Modify: `msstate-policies/.claude-plugin/plugin.json` (line with `"version"`)

- [ ] **Step 1: Bump versions**

```bash
cd msstate-policies
node -e 'const p=require("./package.json"); p.version="1.1.1"; require("fs").writeFileSync("./package.json", JSON.stringify(p,null,2)+"\n");'
node -e 'const p=require("./.claude-plugin/plugin.json"); p.version="1.1.1"; require("fs").writeFileSync("./.claude-plugin/plugin.json", JSON.stringify(p,null,2)+"\n");'
cd ..
```

(Worker version string was already bumped in Task 11.)

- [ ] **Step 2: Commit**

```bash
git add msstate-policies/package.json msstate-policies/.claude-plugin/plugin.json
git commit -m "release: v1.1.1 — online fixes + list_programs_by_staff"
```

---

### Task 19: Full corpus rebuild

**Files:**
- Rebuild: `worker/corpus.json`
- Rebuild: `msstate-policies/dist/calendar-synonyms.json` (if calendars rebuild triggers it)

This requires the `ANTHROPIC_API_KEY` env var for the calendar-synonym build step. Maintainer must have it set.

- [ ] **Step 1: Run full corpus rebuild**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
export ANTHROPIC_API_KEY=sk-ant-...
node scripts/build-worker-corpus.mjs
```

Expected runtime: 5-25 minutes (synonyms cached if previously built).

Watch stderr for:
- All blocks complete without "refusing to ship a poisoned …" errors
- `staff_to_programs: N staff, M program refs` line in online block
- Final summary with all per-source counts

- [ ] **Step 2: Verify corpus.json has staff_to_programs**

```bash
node -e 'const c=require("./worker/corpus.json"); console.log("v:",c.version,"online.staff_to_programs:",c.online?.staff_to_programs?.length||"MISSING","total_refs:",(c.online?.staff_to_programs??[]).reduce((s,e)=>s+e.programs.length,0));'
```

Expected: non-zero `staff_to_programs` count and non-zero `total_refs`.

- [ ] **Step 3: Commit the rebuilt corpus**

```bash
git add worker/corpus.json msstate-policies/dist/calendar-synonyms.json
git commit -m "build: rebuild corpus.json with staff_to_programs index (v1.1.1)"
```

---

### Task 20: dist/ rebuild

**Files:**
- Rebuild: `msstate-policies/dist/index.js`

- [ ] **Step 1: Rebuild the stdio bundle**

```bash
cd msstate-policies && npm run build
```

Expected: builds without error; `dist/index.js` updated with new banner showing v1.1.1.

- [ ] **Step 2: Verify**

```bash
head -2 dist/index.js | tail -1
# Should print: // msstate-policies-mcp 1.1.1 <sha> built <iso>
```

- [ ] **Step 3: Verify tool count**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js | head -n1 | node -e 'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{const r=JSON.parse(d);console.log("count:",r.result.tools.length, "has_lpbs:",r.result.tools.some(t=>t.name==="list_programs_by_staff"))})'
```

Expected: `count: 25 has_lpbs: true`.

- [ ] **Step 4: Commit**

```bash
cd ..
git add msstate-policies/dist/index.js
git commit -m "build: rebuild dist/index.js for v1.1.1 (25 tools)"
```

---

### Task 21: Local validation, PR, merge, tag, publish, deploy

**Files:** (no edits — pure validation + git operations)

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp/msstate-policies
npm run typecheck
npx tsx --test tests/**/*.test.ts
```

Expected: typecheck clean, all tests pass.

- [ ] **Step 2: Run security checklist**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
bash tools/security-checklist.sh 2>&1 | tail -3
```

Expected final score: `284` (or whatever the post-bump number is — must NOT be less than 284).

- [ ] **Step 3: Run online eval**

```bash
node scripts/run-eval.mjs --suite=online 2>&1 | tail -20
```

Expected: 45/45 passing (100%). The eval may take a few minutes per question if it invokes an LLM judge.

- [ ] **Step 4: Smoke-test the new tool via stdio**

```bash
cd msstate-policies
# Pick a live email from the rebuilt corpus
EMAIL=$(node -e 'const c=require("../worker/corpus.json"); const s=c.online.staff_to_programs.find(s=>s.email && s.programs.length>0); console.log(s.email)')
echo "Testing with: $EMAIL"
PAYLOAD=$(printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_programs_by_staff","arguments":{"query":"%s"}}}' "$EMAIL")
echo "$PAYLOAD" | node dist/index.js | head -n1 | jq -r '.result.content[0].text | fromjson | {match_count, programs_for_first: (.matches[0].programs | length)}'
```

Expected: `match_count >= 1`, `programs_for_first >= 1`.

- [ ] **Step 5: Smoke-test the fuzzy fix**

```bash
PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_online_program","arguments":{"name_query":"online MBA"}}}'
echo "$PAYLOAD" | node dist/index.js | head -n1 | jq -r '.result.content[0].text | fromjson | {matched_slug: .matched.slug, strategy: .matched.match_strategy}'
```

Expected: `matched_slug: "mba"` (or whatever the live MBA slug is — verify it's the actual MBA program, not BAS-BOT).

- [ ] **Step 6: Corpus-level HTML-leak grep**

```bash
node -e 'const c=require("./worker/corpus.json"); const offenders=c.online.programs.filter(p=>/<iframe|<script|<noscript|<nav|<header|<footer/i.test(p.tuition?.raw_prose ?? "")); console.log("programs with leaked HTML in tuition.raw_prose:", offenders.length); if(offenders.length) offenders.slice(0,3).forEach(p=>console.log(" ",p.slug));'
```

Expected: `programs with leaked HTML in tuition.raw_prose: 0`.

- [ ] **Step 7: Push the branch and open the PR**

```bash
git push -u origin feat/online-fixes-v1.1.1
gh pr create --title "v1.1.1: online fixes + list_programs_by_staff" --body "$(cat <<'EOF'
## Summary

- Fix `get_online_program(name_query="online MBA")` returning the wrong program (was BAS-BOT, now MBA). Root cause: BM25 over-weighted the universal token "online". Fix: PROGRAM_STOP_WORDS + substring pre-stage before BM25 fallback.
- Add `list_programs_by_staff(query)` tool — email-primary, name-fallback reverse lookup with diacritic-normalization and trigram-similarity `did_you_mean`. Solves the Center for Distance Education "what's mine?" workflow in a single tool call instead of 115.
- Strip `script/style/noscript/iframe/nav/header/footer` from `parseTuition` before `.text()`. Fixes GTM noscript-iframe leakage in BAS-BOT's `tuition.raw_prose`.
- Tool count 24 → 25. Security score stays at 284.

## Test plan

- [x] All new tests pass (`parser-tuition-html-strip`, `search-program-resolver`, `search-staff-resolver`, `parser-staff-index`)
- [x] Online eval 45/45 (30 existing + 10 fuzzy regression + 5 staff lookup)
- [x] Manual smoke: `get_online_program(name_query="online MBA")` returns MBA slug
- [x] Manual smoke: `list_programs_by_staff(query=<live email>)` returns ≥1 program
- [x] Corpus-level grep: 0 programs with leaked HTML in `tuition.raw_prose`
- [x] Security checklist score 284
- [x] CI tools/list smoke test bumped 24 → 25

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 8: Wait for CI green, then merge**

```bash
gh pr checks --watch
# After all green:
gh pr merge --merge --auto
```

- [ ] **Step 9: Tag and publish**

```bash
git checkout main && git pull
git tag v1.1.1
git push origin v1.1.1
cd msstate-policies
npm publish --access public
```

- [ ] **Step 10: Deploy Worker**

```bash
cd ../worker
export CLOUDFLARE_API_TOKEN=...
npx wrangler deploy
```

- [ ] **Step 11: Verify live deployment**

```bash
# Tool count on the live Worker
curl -sS -X POST "https://msstate-policies-mcp.mminsub90.workers.dev/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | jq '.result.tools | length'
# Expected: 25

# Live fuzzy fix
curl -sS -X POST "https://msstate-policies-mcp.mminsub90.workers.dev/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_online_program","arguments":{"name_query":"online MBA"}}}' \
  | jq -r '.result.content[0].text | fromjson | .matched.slug'
# Expected: live MBA slug (NOT bas-business-office-technology)

# Live staff lookup
EMAIL="<one real live staff email — get from worker/corpus.json>"
curl -sS -X POST "https://msstate-policies-mcp.mminsub90.workers.dev/mcp" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"list_programs_by_staff\",\"arguments\":{\"query\":\"$EMAIL\"}}}" \
  | jq -r '.result.content[0].text | fromjson | .match_count'
# Expected: >= 1
```

All 3 expected outputs match → v1.1.1 release is live.

---

## Acceptance criteria (all must pass)

1. ☐ CI green on `v1.1.1` tag commit.
2. ☐ Security checklist score == **284** (no regression).
3. ☐ New tests pass: `parser-tuition-html-strip`, `search-program-resolver`, `search-staff-resolver`, `parser-staff-index`.
4. ☐ Online eval: **45/45 (100%)**.
5. ☐ Manual smoke: `get_online_program(name_query="online MBA")` returns the live MBA program slug.
6. ☐ Manual smoke: `list_programs_by_staff(query=<live email>)` returns ≥1 program.
7. ☐ Manual smoke: a known-ambiguous name returns ≥2 matches.
8. ☐ Corpus-level grep on `worker/corpus.json`: zero `<iframe|<script|<noscript|<nav` substrings in any `online.programs[*].tuition.raw_prose`.
9. ☐ npm publish + Worker deploy succeed; live `tools/list` returns 25 tools, live `get_online_program` resolves "online MBA" to MBA, live `list_programs_by_staff` works.

---

## Out-of-scope reminders (do NOT add to this PR)

These are deferred to v1.1.2+ per the design spec. If you find yourself tempted to address one, stop:

- Staff dedup across non-email name variants (Sam/Samantha when emails differ or are absent).
- Cross-program role analytics.
- Embedding-based program search.
- BM25 search-as-you-type / autocomplete.
- On-demand re-scrape between quarterly refreshes.
- Broader HTML strip on other `raw_*` fields (only `tuition.raw_prose` paths covered here).
