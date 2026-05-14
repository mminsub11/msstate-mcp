# MSU Online Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 MCP tools (`list_online_programs`, `get_online_program`, `get_online_admissions_process`, `find_online_info`) over a baked snapshot of online.msstate.edu — ~126 program pages + admissions process + central staff directory + 5 support pages. Ships as v1.0.0.

**Architecture:** New `msstate-policies/src/online/` module mirroring v0.8.0 tuition. Frozen `ONLINE_ROOTS` + `SUPPORT_PAGE_SLUGS` allowlists, build-time subprocess scraper, baked corpus loaded via esbuild `define` on stdio + via `corpus.online_education` on Worker. Mandatory `ONLINE_DISCLAIMER` on every response. Server-side `InitializeResult.instructions` gains a 6th routing rule.

**Tech Stack:** TypeScript / Node 18+ / esbuild / cheerio / zod / `@modelcontextprotocol/sdk` / Cloudflare Workers / `node:test` runner.

**Spec:** `.dev/specs/2026-05-13-online-msu-design.md` (read before starting).

**Read-before-touching invariants** (from `CLAUDE.md`):
1. **Corpus rule** — every value comes from `*.msstate.edu`. The online module fetches only `online.msstate.edu` URLs.
2. **stderr-only logging** on stdio surface; `console.log` to stdout corrupts MCP JSON-RPC framing.
3. **Security score 257 (Linux CI) must not regress.** ONL1-ONL5 add 12 pts; expected post-PR = 269.
4. **Field name stability** — types in `src/online/types.ts` are tool-output schemas and the baked corpus references them. Renaming is breaking; ADDING a field is non-breaking.

---

## Stage 0 — Capture HTML fixtures

### Task 0.1: Save fixtures from sample online.msstate.edu pages

**Files:**
- Create: `msstate-policies/tests/fixtures/online/academic-programs.html`
- Create: `msstate-policies/tests/fixtures/online/admissions-process.html`
- Create: `msstate-policies/tests/fixtures/online/staff.html`
- Create: `msstate-policies/tests/fixtures/online/program-mba.html`
- Create: `msstate-policies/tests/fixtures/online/program-bsee.html`
- Create: `msstate-policies/tests/fixtures/online/program-psychology.html`
- Create: `msstate-policies/tests/fixtures/online/program-cert-adcn.html`
- Create: `msstate-policies/tests/fixtures/online/state-authorization.html`
- Create: `msstate-policies/tests/fixtures/online/military-assistance.html`
- Create: `msstate-policies/tests/fixtures/online/orientation.html`
- Create: `msstate-policies/tests/fixtures/online/faq.html`
- Create: `msstate-policies/tests/fixtures/online/financial-matters.html`

- [ ] **Step 1: Capture all 12 fixtures**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
mkdir -p msstate-policies/tests/fixtures/online
UA="msstate-policies-mcp/1.0.0 (fixture-capture)"

# Top-level pages
curl -sS -A "$UA" "https://www.online.msstate.edu/academic-programs" \
  > msstate-policies/tests/fixtures/online/academic-programs.html
curl -sS -A "$UA" "https://www.online.msstate.edu/admissions-process" \
  > msstate-policies/tests/fixtures/online/admissions-process.html
curl -sS -A "$UA" "https://www.online.msstate.edu/staff" \
  > msstate-policies/tests/fixtures/online/staff.html

# Program pages (4 across degree levels — MBA = master, BSEE = bachelor, psychology = bachelor, adcn = certificate)
curl -sS -A "$UA" "https://www.online.msstate.edu/mba" \
  > msstate-policies/tests/fixtures/online/program-mba.html
curl -sS -A "$UA" "https://www.online.msstate.edu/bsee" \
  > msstate-policies/tests/fixtures/online/program-bsee.html
curl -sS -A "$UA" "https://www.online.msstate.edu/psychology" \
  > msstate-policies/tests/fixtures/online/program-psychology.html
curl -sS -A "$UA" "https://www.online.msstate.edu/adcn" \
  > msstate-policies/tests/fixtures/online/program-cert-adcn.html

# Support pages
curl -sS -A "$UA" "https://www.online.msstate.edu/state-authorization" \
  > msstate-policies/tests/fixtures/online/state-authorization.html
curl -sS -A "$UA" "https://www.online.msstate.edu/military-assistance" \
  > msstate-policies/tests/fixtures/online/military-assistance.html
curl -sS -A "$UA" "https://www.online.msstate.edu/orientation" \
  > msstate-policies/tests/fixtures/online/orientation.html
curl -sS -A "$UA" "https://www.online.msstate.edu/faq" \
  > msstate-policies/tests/fixtures/online/faq.html
curl -sS -A "$UA" "https://www.online.msstate.edu/financial-matters" \
  > msstate-policies/tests/fixtures/online/financial-matters.html
```

- [ ] **Step 2: Verify each fixture is non-empty real HTML (no WAF challenge)**

```bash
for f in msstate-policies/tests/fixtures/online/*.html; do
  size=$(wc -c < "$f")
  has_waf=$(grep -c "Just a moment" "$f" || true)
  echo "$f size=$size waf=$has_waf"
done
```

Expected: every line shows `size > 5000` and `waf=0`. If any file fails, retry that specific curl after a 5-second sleep with a different User-Agent. Do NOT proceed until clean.

- [ ] **Step 3: Cut feature branch + commit fixtures**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git checkout main && git pull origin main --ff-only
git log -1 --oneline   # expect b791a32 docs(online): brainstorming design ...
git checkout -b feat/online-msu
git add msstate-policies/tests/fixtures/online/
git status --short
git commit -m "test(online): capture HTML fixtures for online.msstate.edu pages"
git rev-parse --abbrev-ref HEAD   # must show feat/online-msu
```

---

## Stage 1 — `types.ts` foundation

### Task 1.1: Write failing test for types module

**Files:**
- Create: `msstate-policies/tests/online/types.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ONLINE_ROOTS,
  SUPPORT_PAGE_SLUGS,
  ONLINE_DISCLAIMER,
  MAX_QUERY_CHARS,
  OnlineWafError,
  type DegreeLevel,
  type StudentType,
  type OnlineParseWarning,
} from "../../src/online/types.js";

describe("online/types", () => {
  test("ONLINE_ROOTS is frozen and online.msstate.edu-only", () => {
    assert.ok(Object.isFrozen(ONLINE_ROOTS));
    for (const u of ONLINE_ROOTS) {
      assert.match(u, /^https:\/\/www\.online\.msstate\.edu\//);
    }
  });
  test("ONLINE_ROOTS contains exactly 4 base URLs", () => {
    assert.equal(ONLINE_ROOTS.length, 4);
  });
  test("ONLINE_ROOTS includes academic-programs entry point", () => {
    assert.ok(ONLINE_ROOTS.some((u) => u.endsWith("/academic-programs")));
  });
  test("SUPPORT_PAGE_SLUGS is frozen and has exactly 5 entries", () => {
    assert.ok(Object.isFrozen(SUPPORT_PAGE_SLUGS));
    assert.equal(SUPPORT_PAGE_SLUGS.length, 5);
    for (const s of ["state-authorization", "military-assistance", "orientation", "faq", "financial-matters"]) {
      assert.ok(SUPPORT_PAGE_SLUGS.includes(s as never), `missing: ${s}`);
    }
  });
  test("ONLINE_DISCLAIMER mentions verifying at the source URL", () => {
    assert.match(ONLINE_DISCLAIMER, /verify/i);
    assert.match(ONLINE_DISCLAIMER, /source url/i);
  });
  test("MAX_QUERY_CHARS is 4096", () => {
    assert.equal(MAX_QUERY_CHARS, 4096);
  });
  test("OnlineWafError carries the offending URL", () => {
    const e = new OnlineWafError("https://www.online.msstate.edu/foo");
    assert.equal(e.name, "OnlineWafError");
    assert.match(e.message, /WAF/);
    assert.equal(e.url, "https://www.online.msstate.edu/foo");
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

```bash
cd msstate-policies && npx tsx --test tests/online/types.test.ts 2>&1 | tail -5
```

Expected: FAIL — `Cannot find module '../../src/online/types.js'`.

### Task 1.2: Implement `types.ts`

**Files:**
- Create: `msstate-policies/src/online/types.ts`

- [ ] **Step 1: Write the file**

```typescript
/**
 * Online module — types, frozen allowlists, mandatory disclaimer.
 *
 * Corpus rule (CLAUDE.md): every value here comes from a live
 * online.msstate.edu page. No training-data fallback.
 */

export const ONLINE_ROOTS: readonly string[] = Object.freeze([
  "https://www.online.msstate.edu/academic-programs",
  "https://www.online.msstate.edu/admissions-process",
  "https://www.online.msstate.edu/staff",
  "https://www.online.msstate.edu/",
]);

/**
 * Frozen list of support-page slugs. The scraper builds URLs by joining the
 * base ONLINE_ROOTS[3] with one of these slugs; no other path tails are
 * allowed in the support-page fetcher.
 */
export const SUPPORT_PAGE_SLUGS: readonly string[] = Object.freeze([
  "state-authorization",
  "military-assistance",
  "orientation",
  "faq",
  "financial-matters",
]);

export const ONLINE_DISCLAIMER =
  "Contact info, application deadlines, tuition, and program details on online.msstate.edu can change between releases. Verify against the source URL before applying.";

export const MAX_QUERY_CHARS = 4096;

export type DegreeLevel =
  | "bachelor"
  | "master"
  | "specialist"
  | "doctoral"
  | "certificate"
  | "endorsement";

export type StudentType =
  | "undergraduate"
  | "graduate"
  | "transfer"
  | "readmit"
  | "international";

export type OnlineParseWarning =
  | "no_contacts_extracted"
  | "no_deadlines_extracted"
  | "tuition_unparsed"
  | "admissions_section_missing"
  | "format_field_missing";

export interface OnlineContact {
  name: string;
  title: string;
  email: string | null;
  phone: string | null;
}

export interface OnlineApplicationDeadline {
  term: string;       // "Fall" | "Spring" | "Summer" — verbatim
  date_text: string;  // "August 1" — verbatim, NOT parsed to ISO
}

export interface OnlineEntranceExams {
  required: string[];
  not_required: string[];
  notes: string;
}

export interface OnlineProgramTuition {
  per_credit_usd: number | null;
  instructional_fee_per_credit_usd: number | null;
  application_fee_domestic_usd: number | null;
  application_fee_international_usd: number | null;
  raw_prose: string;
}

export interface OnlineProgram {
  slug: string;
  name: string;
  degree_level: DegreeLevel;
  format: string;
  short_description: string;
  url: string;
  tuition: OnlineProgramTuition;
  contacts: OnlineContact[];
  application_deadlines: OnlineApplicationDeadline[];
  admission_requirements: string;
  entrance_exams: OnlineEntranceExams | null;
  accreditation: string | null;
  forms: { label: string; url: string }[];
  raw_sections: Record<string, string>;
  parse_warnings: OnlineParseWarning[];
  retrieved_at: string;
}

export interface OnlineAdmissionsProcess {
  url: string;
  central_contact: OnlineContact;
  shared_prelude: string;
  sections: Record<StudentType, string>;
  application_fee_tiers: { kind: string; usd: number }[];
  external_apply_urls: { kind: string; url: string }[];
  retrieved_at: string;
}

export interface OnlineStaffEntry {
  name: string;
  title: string;
  email: string | null;
  phone: string | null;
  office: string;
  url: string;
  retrieved_at: string;
}

export interface OnlineInfoPage {
  slug: string;
  title: string;
  url: string;
  body_markdown: string;
  retrieved_at: string;
}

export interface OnlineCorpus {
  builtAt: string;
  source: "https://www.online.msstate.edu/";
  programs: OnlineProgram[];
  admissions_process: OnlineAdmissionsProcess;
  staff: OnlineStaffEntry[];
  info_pages: OnlineInfoPage[];
}

export class OnlineWafError extends Error {
  constructor(public readonly url: string) {
    super(`WAF challenge detected at ${url}`);
    this.name = "OnlineWafError";
  }
}
```

- [ ] **Step 2: Run test (expect pass)**

```bash
cd msstate-policies && npx tsx --test tests/online/types.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 7 tests, 7 pass, 0 fail.

- [ ] **Step 3: Typecheck + commit**

```bash
cd msstate-policies && npm run typecheck 2>&1 | tail -3
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/online/types.ts msstate-policies/tests/online/types.test.ts
git status --short
git commit -m "feat(online): types, frozen allowlists, ONLINE_DISCLAIMER"
git rev-parse --abbrev-ref HEAD   # must show feat/online-msu
```

---

## Stage 2 — `parseAcademicProgramsIndex` (entry point — must work first)

The scraper's two-pass design depends on this parser: pass 1 extracts the ~126 program slugs from `/academic-programs`, pass 2 fetches each program page using those slugs. Build the index parser first.

### Task 2.1: Write failing test

**Files:**
- Create: `msstate-policies/tests/online/parser-academic-programs-index.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAcademicProgramsIndex } from "../../src/online/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(here, "..", "fixtures", "online", "academic-programs.html"),
  "utf8",
);
const PAGE_URL = "https://www.online.msstate.edu/academic-programs";

describe("parseAcademicProgramsIndex", () => {
  test("extracts at least 100 program slugs (we expect ~126)", () => {
    const entries = parseAcademicProgramsIndex(FIXTURE, PAGE_URL);
    assert.ok(entries.length >= 100, `got ${entries.length}`);
  });
  test("each entry has slug, name, degree_level", () => {
    const entries = parseAcademicProgramsIndex(FIXTURE, PAGE_URL);
    for (const e of entries) {
      assert.ok(e.slug.length > 0);
      assert.ok(e.name.length > 0);
      assert.ok(["bachelor", "master", "specialist", "doctoral", "certificate", "endorsement"].includes(e.degree_level));
    }
  });
  test("slugs are URL-safe (no spaces, no leading slash)", () => {
    const entries = parseAcademicProgramsIndex(FIXTURE, PAGE_URL);
    for (const e of entries) {
      assert.ok(!e.slug.includes("/"));
      assert.ok(!e.slug.includes(" "));
    }
  });
  test("includes the MBA at master level", () => {
    const entries = parseAcademicProgramsIndex(FIXTURE, PAGE_URL);
    const mba = entries.find((e) => e.slug === "mba");
    assert.ok(mba, "no mba entry");
    assert.equal(mba.degree_level, "master");
    assert.match(mba.name, /business administration/i);
  });
  test("includes at least one doctoral program", () => {
    const entries = parseAcademicProgramsIndex(FIXTURE, PAGE_URL);
    assert.ok(entries.some((e) => e.degree_level === "doctoral"));
  });
  test("returns [] on input with no program list", () => {
    const empty = parseAcademicProgramsIndex(
      "<html><body><p>nothing here</p></body></html>",
      PAGE_URL,
    );
    assert.deepEqual(empty, []);
  });
});
```

- [ ] **Step 2: Run (expect failure — module not found)**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-academic-programs-index.test.ts 2>&1 | tail -5
```

Expected: FAIL — `Cannot find module '../../src/online/parser.js'`.

### Task 2.2: Implement `parseAcademicProgramsIndex`

**Files:**
- Create: `msstate-policies/src/online/parser.ts`

- [ ] **Step 1: Inspect the fixture's actual markup**

```bash
grep -nE "<h[1-6]|degree-level|program-list|<a href=\"/" msstate-policies/tests/fixtures/online/academic-programs.html | head -40
```

The page groups programs under headings like "Bachelor's Degrees", "Master's Degrees", etc. Each program is an anchor link to `/<slug>`. Note the actual HTML structure (heading element, container class) so the parser targets it correctly.

- [ ] **Step 2: Write the parser**

```typescript
/**
 * Online module — HTML parsers.
 *
 * Each function returns verbatim text from online.msstate.edu pages. The
 * scraper attaches `retrieved_at` and `url` after parsing.
 */
import { load as cheerioLoad } from "cheerio";
import type {
  DegreeLevel,
  OnlineProgram,
  OnlineAdmissionsProcess,
  OnlineStaffEntry,
  OnlineInfoPage,
  OnlineContact,
  OnlineApplicationDeadline,
  OnlineEntranceExams,
  OnlineProgramTuition,
  OnlineParseWarning,
  StudentType,
} from "./types.js";

const RETRIEVED_AT_PLACEHOLDER = "1970-01-01T00:00:00.000Z";

/** Section heading text → DegreeLevel. */
const LEVEL_HEADING_MAP: Array<[RegExp, DegreeLevel]> = [
  [/bachelor/i, "bachelor"],
  [/master/i, "master"],
  [/specialist/i, "specialist"],
  [/doctor(al)?/i, "doctoral"],
  [/certificate/i, "certificate"],
  [/endorsement/i, "endorsement"],
];

export interface ProgramIndexEntry {
  slug: string;
  name: string;
  degree_level: DegreeLevel;
}

/**
 * Parse /academic-programs into a list of { slug, name, degree_level } entries.
 *
 * The page groups programs under section headings ("Bachelor's Degrees",
 * "Master's Degrees", etc.). Each program is an anchor like <a href="/mba">
 * within the current section. We walk the document in order, tracking the
 * most recent matching heading as the active degree level.
 */
export function parseAcademicProgramsIndex(
  html: string,
  pageUrl: string,
): ProgramIndexEntry[] {
  const $ = cheerioLoad(html);
  const out: ProgramIndexEntry[] = [];
  const seenSlugs = new Set<string>();
  let currentLevel: DegreeLevel | null = null;

  // Walk all h1-h4 headings AND anchors in document order. When we see a
  // matching heading, update currentLevel. When we see an anchor with an
  // internal slug-shaped href, emit an entry.
  $("main h1, main h2, main h3, main h4, main a[href]").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName ?? "";
    const $el = $(el);
    if (/^h[1-4]$/i.test(tag)) {
      const text = $el.text().replace(/\s+/g, " ").trim();
      for (const [re, level] of LEVEL_HEADING_MAP) {
        if (re.test(text)) {
          currentLevel = level;
          return;
        }
      }
      return;
    }
    // Anchor
    if (currentLevel === null) return;
    const href = $el.attr("href") ?? "";
    // Internal slug: starts with "/", no further "/", no "#", no query
    const m = href.match(/^\/([a-z][a-z0-9-]*)$/i);
    if (!m) return;
    const slug = m[1];
    if (seenSlugs.has(slug)) return;
    seenSlugs.add(slug);
    const name = $el.text().replace(/\s+/g, " ").trim();
    if (name.length === 0) return;
    out.push({ slug, name, degree_level: currentLevel });
  });

  return out;
}
```

- [ ] **Step 3: Run test**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-academic-programs-index.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 6 tests, 6 pass.

If the test for "≥ 100 entries" fails (likely cause: heading selector misses something, or anchor selector is too restrictive), inspect the fixture's actual markup and tighten the heading regex or anchor href shape. Do NOT loosen the test — fix the parser.

- [ ] **Step 4: Commit**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/online/parser.ts msstate-policies/tests/online/parser-academic-programs-index.test.ts
git commit -m "feat(online): parseAcademicProgramsIndex extracts ~126 program slugs"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 3 — `parseProgramHtml` (the heart of the module)

Per-program pages have a consistent skeleton: intro + tuition + program-structure + admissions-process + contacts + forms. We extract structured fields where MSU's wording is reliable + dump prose by section heading for everything else.

### Task 3.1: Write failing test for parseProgramHtml

**Files:**
- Create: `msstate-policies/tests/online/parser-program.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProgramHtml } from "../../src/online/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "..", "fixtures", "online", name), "utf8");
}
const MBA_URL = "https://www.online.msstate.edu/mba";
const BSEE_URL = "https://www.online.msstate.edu/bsee";

describe("parseProgramHtml — MBA structured fields", () => {
  test("extracts program name verbatim", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    assert.match(p.name, /business administration/i);
  });
  test("extracts at least one contact with an @msstate.edu or @business.msstate.edu email", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    const withEmail = p.contacts.find((c) => c.email && /@(business\.)?msstate\.edu$/.test(c.email));
    assert.ok(withEmail, `no contact with @msstate.edu email; got ${JSON.stringify(p.contacts)}`);
  });
  test("extracts MBA application deadline mentioning August", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    const fall = p.application_deadlines.find((d) => /august/i.test(d.date_text));
    assert.ok(fall, `no August deadline; got ${JSON.stringify(p.application_deadlines)}`);
  });
  test("tuition.per_credit_usd is positive", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    assert.ok((p.tuition.per_credit_usd ?? 0) > 0, `expected positive; got ${p.tuition.per_credit_usd}`);
  });
  test("admission_requirements section is non-empty", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    assert.ok(p.admission_requirements.length > 0);
  });
  test("raw_sections has at least 3 entries (intro, admissions, contact)", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    assert.ok(Object.keys(p.raw_sections).length >= 3);
  });
  test("emits no parse_warnings when fully parsed", () => {
    const p = parseProgramHtml(fixture("program-mba.html"), "mba", "master", MBA_URL);
    assert.ok(p);
    assert.deepEqual(p.parse_warnings, []);
  });
});

describe("parseProgramHtml — BSEE (bachelor)", () => {
  test("extracts contacts AND application deadlines", () => {
    const p = parseProgramHtml(fixture("program-bsee.html"), "bsee", "bachelor", BSEE_URL);
    assert.ok(p);
    assert.ok(p.contacts.length >= 1);
    assert.ok(p.application_deadlines.length >= 1);
  });
});

describe("parseProgramHtml — empty input fallback", () => {
  test("returns a record with parse_warnings when page is empty", () => {
    const p = parseProgramHtml(
      "<html><body><p>nothing useful</p></body></html>",
      "empty",
      "certificate",
      "https://www.online.msstate.edu/empty",
    );
    assert.ok(p);
    // Should emit no_contacts_extracted AND no_deadlines_extracted at minimum.
    assert.ok(p.parse_warnings.includes("no_contacts_extracted"));
    assert.ok(p.parse_warnings.includes("no_deadlines_extracted"));
  });
});
```

- [ ] **Step 2: Run (expect failure)**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-program.test.ts 2>&1 | tail -10
```

Expected: FAIL — `parseProgramHtml is not a function`.

### Task 3.2: Implement parseProgramHtml

**Files:**
- Modify: `msstate-policies/src/online/parser.ts` (append)

- [ ] **Step 1: Inspect fixture markup**

```bash
grep -nE "<h[1-6]|<section|class=\"contact|class=\"deadline|tuition|mailto:|tel:" msstate-policies/tests/fixtures/online/program-mba.html | head -40
```

Note: each program page on online.msstate.edu uses Drupal's content-section pattern — `<section>` blocks with leading `<h2>` headings, prose in `<p>` tags. Contacts are typically in a final "Contact Information" section as `<p>` blocks with name in `<strong>` + title + email/phone links. Adapt to the actual fixture.

- [ ] **Step 2: Append parseProgramHtml + helpers to `parser.ts`**

```typescript
// Append to msstate-policies/src/online/parser.ts

const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
const PHONE_RE = /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const MONEY_RE = /\$?\s*([\d,]+(?:\.\d{2})?)/;
const TERM_RE = /\b(Fall|Spring|Summer)\b/i;

function parseMoneyValue(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = MONEY_RE.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractSections(
  $: ReturnType<typeof cheerioLoad>,
): Record<string, string> {
  const out: Record<string, string> = {};
  $("main h2, main h3").each((_, h) => {
    const $h = $(h);
    const heading = $h.text().replace(/\s+/g, " ").trim();
    if (!heading) return;
    const headingLevel = ($h.prop("tagName") || "").toLowerCase() === "h2" ? 2 : 3;
    // Collect sibling content until next heading at same-or-shallower level
    let $cur = $h.next();
    const parts: string[] = [];
    while ($cur.length > 0) {
      const tag = ($cur.prop("tagName") || "").toLowerCase();
      if (/^h[1-3]$/.test(tag)) {
        const curLevel = Number(tag.slice(1));
        if (curLevel <= headingLevel) break;
      }
      const text = $cur.text().replace(/\s+/g, " ").trim();
      if (text.length > 0) parts.push(text);
      $cur = $cur.next();
    }
    const body = parts.join("\n").trim();
    if (body.length > 0) out[heading] = body;
  });
  return out;
}

function extractContactsFromSection(sectionText: string, $section: cheerio.Cheerio<cheerio.Element> | null): OnlineContact[] {
  const out: OnlineContact[] = [];
  // Heuristic: look for paragraph-like blocks containing an email; preceding
  // line is the name + title. If section text has multiple emails, split on
  // double-newlines / sentence boundaries.
  const blocks = sectionText.split(/\n\s*\n/);
  for (const block of blocks) {
    const emails = block.match(EMAIL_RE) ?? [];
    if (emails.length === 0) continue;
    const phones = block.match(PHONE_RE) ?? [];
    // First non-empty line = name; second non-empty line = title (best effort).
    const lines = block.split(/\n/).map((s) => s.trim()).filter((s) => s.length > 0);
    const name = lines[0] ?? "";
    const title = lines.length > 1 ? lines[1] : "";
    if (name.length > 0 && !name.includes("@")) {
      out.push({
        name,
        title,
        email: emails[0] ?? null,
        phone: phones[0] ?? null,
      });
    }
  }
  return out;
}

function extractDeadlines(sectionText: string): OnlineApplicationDeadline[] {
  // Match patterns like "Fall Semester: August 1" or "Fall: August 1".
  // Some pages format as a table; cheerio collapses table cells with newlines.
  const out: OnlineApplicationDeadline[] = [];
  const seen = new Set<string>();
  const re = /(Fall|Spring|Summer)(?:\s+Semester)?[\s:]+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/gi;
  let m;
  while ((m = re.exec(sectionText)) !== null) {
    const key = `${m[1].toLowerCase()}|${m[2].toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      term: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(),
      date_text: m[2].trim(),
    });
  }
  return out;
}

function extractTuition(raw_prose: string): OnlineProgramTuition {
  const per_credit_match = /\$?\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s+credit\s+hour|\/?\s*credit\s+hour|tuition)/i.exec(raw_prose);
  const instr_fee_match = /\$?\s*([\d,]+(?:\.\d{2})?)\s*(?:Instructional\s+Support\s+Fee|fee\s+per\s+credit)/i.exec(raw_prose);
  const app_fee_dom_match = /\$?\s*([\d,]+(?:\.\d{2})?)\s*(?:application\s+fee\s*\(?(?:domestic|US)?)/i.exec(raw_prose);
  const app_fee_intl_match = /\$?\s*([\d,]+(?:\.\d{2})?)\s*application\s+fee\s*\(?\s*international/i.exec(raw_prose);
  const m = (s: string | undefined): number | null => (s ? parseMoneyValue(s) : null);
  return {
    per_credit_usd: m(per_credit_match?.[1]),
    instructional_fee_per_credit_usd: m(instr_fee_match?.[1]),
    application_fee_domestic_usd: m(app_fee_dom_match?.[1]),
    application_fee_international_usd: m(app_fee_intl_match?.[1]),
    raw_prose,
  };
}

function extractForms($: ReturnType<typeof cheerioLoad>): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  $("main a[href$='.pdf']").each((_, a) => {
    const $a = $(a);
    const url = $a.attr("href") ?? "";
    if (!url || seen.has(url)) return;
    seen.add(url);
    const label = $a.text().replace(/\s+/g, " ").trim() || url.split("/").pop() || url;
    // Normalize relative URLs against online.msstate.edu
    const absUrl = url.startsWith("http") ? url : `https://www.online.msstate.edu${url.startsWith("/") ? "" : "/"}${url}`;
    out.push({ label, url: absUrl });
  });
  return out;
}

function findSectionByPattern(
  sections: Record<string, string>,
  patterns: RegExp[],
): string {
  for (const [heading, body] of Object.entries(sections)) {
    for (const p of patterns) {
      if (p.test(heading)) return body;
    }
  }
  return "";
}

export function parseProgramHtml(
  html: string,
  slug: string,
  degree_level: DegreeLevel,
  url: string,
): OnlineProgram | null {
  const $ = cheerioLoad(html);

  // Name = first h1 inside <main> if present; else fall back to the <title>.
  const nameRaw =
    $("main h1").first().text().replace(/\s+/g, " ").trim() ||
    $("title").text().replace(/\s+/g, " ").trim();
  const name = nameRaw || slug;

  const sections = extractSections($);

  // First paragraph after the h1 = short_description.
  const shortDescriptionRaw = $("main h1").first().nextAll("p").first().text().replace(/\s+/g, " ").trim();
  const short_description = shortDescriptionRaw;

  // Format: look in raw_sections for any "format" key, OR check the intro.
  const formatBody = findSectionByPattern(sections, [/format/i, /delivery/i]);
  const format = formatBody || ((/fully\s+online/i.test(short_description)) ? "Fully online" : "");

  // Tuition section
  const tuitionBody = findSectionByPattern(sections, [/tuition/i, /cost/i, /fee/i]);
  const tuition = extractTuition(tuitionBody);

  // Admissions section
  const admissions_requirements = findSectionByPattern(sections, [/admission/i]);

  // Contacts section
  const contactsBody = findSectionByPattern(sections, [/contact/i, /staff/i, /faculty/i]);
  const contacts = extractContactsFromSection(contactsBody, null);

  // Deadlines — search across the whole document text in case they're not in admissions.
  const allText = $("main").text();
  const application_deadlines = extractDeadlines(allText);

  // Entrance exams — quick heuristic on admission_requirements + page body.
  const examPool = `${admissions_requirements}\n${allText}`;
  const required: string[] = [];
  const not_required: string[] = [];
  if (/TOEFL|IELTS/i.test(examPool)) required.push("TOEFL or IELTS for international students");
  if (/no\s+GMAT/i.test(examPool) || /GMAT\s+(?:is\s+)?not\s+required/i.test(examPool)) not_required.push("GMAT");
  if (/no\s+GRE/i.test(examPool) || /GRE\s+(?:is\s+)?not\s+required/i.test(examPool)) not_required.push("GRE");
  const entrance_exams: OnlineEntranceExams | null = (required.length || not_required.length)
    ? { required, not_required, notes: "" }
    : null;

  // Accreditation — look for "AACSB", "ABET", "CCNE", etc., in the page body.
  let accreditation: string | null = null;
  const accMatch = /\b(AACSB|ABET|CCNE|CAEP|NCATE|SACS|CACREP)\b/i.exec(allText);
  if (accMatch) accreditation = accMatch[1].toUpperCase();

  const forms = extractForms($);

  const parse_warnings: OnlineParseWarning[] = [];
  if (contacts.length === 0) parse_warnings.push("no_contacts_extracted");
  if (application_deadlines.length === 0) parse_warnings.push("no_deadlines_extracted");
  if (tuition.per_credit_usd === null && tuitionBody.length === 0) parse_warnings.push("tuition_unparsed");
  if (admissions_requirements.length === 0) parse_warnings.push("admissions_section_missing");
  if (format.length === 0) parse_warnings.push("format_field_missing");

  return {
    slug,
    name,
    degree_level,
    format,
    short_description,
    url,
    tuition,
    contacts,
    application_deadlines,
    admission_requirements: admissions_requirements,
    entrance_exams,
    accreditation,
    forms,
    raw_sections: sections,
    parse_warnings,
    retrieved_at: RETRIEVED_AT_PLACEHOLDER,
  };
}
```

- [ ] **Step 3: Run tests**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-program.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 9 tests, 9 pass. Common failure modes:
- "contact with @msstate.edu" fails → contacts-section heading regex too narrow. Inspect fixture, tighten/widen the patterns in `findSectionByPattern`'s "contact" array.
- "tuition.per_credit_usd is positive" fails → tuition regex didn't catch the page's specific wording. Inspect fixture's tuition section, adjust the regex.
- "no parse_warnings when fully parsed" fails → look at which warning fired; that's the extractor that needs work.

Iterate on the parser, NOT the tests.

- [ ] **Step 4: Commit**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/online/parser.ts msstate-policies/tests/online/parser-program.test.ts
git commit -m "feat(online): parseProgramHtml extracts contacts + deadlines + tuition + forms"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 4 — `parseAdmissionsProcessHtml`

### Task 4.1: Write failing test

**Files:**
- Create: `msstate-policies/tests/online/parser-admissions.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdmissionsProcessHtml } from "../../src/online/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(here, "..", "fixtures", "online", "admissions-process.html"),
  "utf8",
);
const PAGE_URL = "https://www.online.msstate.edu/admissions-process";

describe("parseAdmissionsProcessHtml", () => {
  test("all 5 student-type sections present and non-empty", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    for (const st of ["undergraduate", "graduate", "transfer", "readmit", "international"]) {
      assert.ok(p.sections[st], `missing section: ${st}`);
      assert.ok(p.sections[st].length > 0, `empty section: ${st}`);
    }
  });
  test("central_contact email is ask@online.msstate.edu", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    assert.equal(p.central_contact.email, "ask@online.msstate.edu");
  });
  test("central_contact phone matches (662) 325-3473", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    assert.ok((p.central_contact.phone ?? "").replace(/\D/g, "").endsWith("6623253473"));
  });
  test("shared_prelude is non-empty", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    assert.ok(p.shared_prelude.length > 0);
  });
  test("application_fee_tiers has at least 2 entries", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    assert.ok(p.application_fee_tiers.length >= 2);
    for (const t of p.application_fee_tiers) {
      assert.ok(t.kind.length > 0);
      assert.ok(t.usd > 0);
    }
  });
  test("external_apply_urls includes apply.msstate.edu and grad.msstate.edu", () => {
    const p = parseAdmissionsProcessHtml(FIXTURE, PAGE_URL);
    const urls = p.external_apply_urls.map((u) => u.url);
    assert.ok(urls.some((u) => /apply\.msstate\.edu/.test(u)));
    assert.ok(urls.some((u) => /grad\.msstate\.edu/.test(u)));
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-admissions.test.ts 2>&1 | tail -5
```

Expected: FAIL — `parseAdmissionsProcessHtml is not a function`.

### Task 4.2: Implement parseAdmissionsProcessHtml

**Files:**
- Modify: `msstate-policies/src/online/parser.ts` (append)

- [ ] **Step 1: Inspect the fixture**

```bash
grep -nE "<h[1-6]|undergraduate|graduate|transfer|readmission|international|@online|@msstate|apply.msstate.edu|grad.msstate.edu|\\\$\\d+" msstate-policies/tests/fixtures/online/admissions-process.html | head -40
```

Note the section headings and how the central contact info is laid out.

- [ ] **Step 2: Append parseAdmissionsProcessHtml**

```typescript
// Append to msstate-policies/src/online/parser.ts

const STUDENT_TYPE_HEADING_MAP: Array<[RegExp, StudentType]> = [
  [/undergraduate/i, "undergraduate"],
  [/graduate(?!\s+application)/i, "graduate"],  // beat "International Graduate Application" sub-heading
  [/transfer/i, "transfer"],
  [/readmission/i, "readmit"],
  [/international/i, "international"],
];

function extractCentralContact(allText: string, $: ReturnType<typeof cheerioLoad>): OnlineContact {
  const emails = allText.match(EMAIL_RE) ?? [];
  const phones = allText.match(PHONE_RE) ?? [];
  const askEmail = emails.find((e) => /^ask@online\.msstate\.edu$/i.test(e));
  return {
    name: "Office of Online Education",
    title: "Front-desk contact",
    email: askEmail ?? emails[0] ?? null,
    phone: phones[0] ?? null,
  };
}

function extractApplicationFeeTiers(allText: string): { kind: string; usd: number }[] {
  // Patterns like "$50 application fee for undergraduate", "$80 international", etc.
  const out: { kind: string; usd: number }[] = [];
  const seen = new Set<string>();
  const re = /\$(\d{2,3})\s+(?:application\s+fee\s+)?(?:for\s+)?([\w\s,/]+?)(?:[.,;]|$)/gi;
  let m;
  while ((m = re.exec(allText)) !== null) {
    const usd = Number(m[1]);
    const kind = m[2].replace(/\s+/g, " ").trim();
    if (kind.length === 0 || kind.length > 60) continue;
    const key = `${usd}|${kind.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, usd });
  }
  return out;
}

function extractExternalApplyUrls(
  $: ReturnType<typeof cheerioLoad>,
): { kind: string; url: string }[] {
  const out: { kind: string; url: string }[] = [];
  const seen = new Set<string>();
  $("main a[href]").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    if (!/apply\.msstate\.edu|grad\.msstate\.edu\/apply/i.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);
    const label = $(a).text().replace(/\s+/g, " ").trim() || href;
    let kind = label;
    if (/grad/i.test(href)) kind = "Graduate application";
    else if (/apply\.msstate/i.test(href)) kind = "Undergraduate application";
    out.push({ kind, url: href });
  });
  return out;
}

export function parseAdmissionsProcessHtml(
  html: string,
  pageUrl: string,
): OnlineAdmissionsProcess {
  const $ = cheerioLoad(html);
  const sections: Record<StudentType, string> = {
    undergraduate: "",
    graduate: "",
    transfer: "",
    readmit: "",
    international: "",
  };

  // shared_prelude = paragraphs between the page h1 and the first matching sub-heading
  const $h1 = $("main h1").first();
  const preludeParts: string[] = [];
  let $cur = $h1.next();
  while ($cur.length > 0) {
    const tag = ($cur.prop("tagName") || "").toLowerCase();
    if (/^h[2-3]$/.test(tag)) break;
    const t = $cur.text().replace(/\s+/g, " ").trim();
    if (t.length > 0) preludeParts.push(t);
    $cur = $cur.next();
  }
  const shared_prelude = preludeParts.join("\n").trim();

  // Walk h2/h3 in order, classify, accumulate prose into the matching section.
  $("main h2, main h3").each((_, h) => {
    const $h = $(h);
    const heading = $h.text().replace(/\s+/g, " ").trim();
    let matched: StudentType | null = null;
    for (const [re, type] of STUDENT_TYPE_HEADING_MAP) {
      if (re.test(heading)) { matched = type; break; }
    }
    if (!matched) return;
    // Collect prose until next h2/h3
    const headingLevel = ($h.prop("tagName") || "").toLowerCase() === "h2" ? 2 : 3;
    let $next = $h.next();
    const parts: string[] = [];
    while ($next.length > 0) {
      const tag = ($next.prop("tagName") || "").toLowerCase();
      if (/^h[1-3]$/.test(tag)) {
        const lvl = Number(tag.slice(1));
        if (lvl <= headingLevel) break;
      }
      const t = $next.text().replace(/\s+/g, " ").trim();
      if (t.length > 0) parts.push(t);
      $next = $next.next();
    }
    // Append (first matching section wins, but later sub-sections still accumulate
    // because the regex can match multiple headings — e.g., "International Graduate
    // Application Requirements" appended into "international").
    const body = parts.join("\n").trim();
    if (body.length > 0) {
      sections[matched] = sections[matched] ? `${sections[matched]}\n\n${body}` : body;
    }
  });

  const allText = $("main").text();
  const central_contact = extractCentralContact(allText, $);
  const application_fee_tiers = extractApplicationFeeTiers(allText);
  const external_apply_urls = extractExternalApplyUrls($);

  return {
    url: pageUrl,
    central_contact,
    shared_prelude,
    sections,
    application_fee_tiers,
    external_apply_urls,
    retrieved_at: RETRIEVED_AT_PLACEHOLDER,
  };
}
```

- [ ] **Step 3: Run + commit**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-admissions.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 6 tests, 6 pass. If section extraction is empty for one of the student types, inspect the fixture's heading text and tighten `STUDENT_TYPE_HEADING_MAP` to match.

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/online/parser.ts msstate-policies/tests/online/parser-admissions.test.ts
git commit -m "feat(online): parseAdmissionsProcessHtml extracts 5 student-type sections"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 5 — `parseStaffDirectoryHtml`

### Task 5.1: Write failing test

**Files:**
- Create: `msstate-policies/tests/online/parser-staff.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStaffDirectoryHtml } from "../../src/online/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(here, "..", "fixtures", "online", "staff.html"),
  "utf8",
);
const PAGE_URL = "https://www.online.msstate.edu/staff";

describe("parseStaffDirectoryHtml", () => {
  test("extracts at least 3 staff entries", () => {
    const entries = parseStaffDirectoryHtml(FIXTURE, PAGE_URL);
    assert.ok(entries.length >= 3, `got ${entries.length}`);
  });
  test("each entry has name and title", () => {
    const entries = parseStaffDirectoryHtml(FIXTURE, PAGE_URL);
    for (const e of entries) {
      assert.ok(e.name.length > 0);
      assert.ok(e.title.length > 0);
    }
  });
  test("at least one entry has @msstate.edu or @online.msstate.edu email", () => {
    const entries = parseStaffDirectoryHtml(FIXTURE, PAGE_URL);
    assert.ok(entries.some((e) => e.email && /@(online\.)?msstate\.edu$/.test(e.email)));
  });
  test("all entries reference the staff page URL", () => {
    const entries = parseStaffDirectoryHtml(FIXTURE, PAGE_URL);
    for (const e of entries) assert.ok(e.url.startsWith(PAGE_URL));
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-staff.test.ts 2>&1 | tail -5
```

Expected: FAIL — `parseStaffDirectoryHtml is not a function`.

### Task 5.2: Implement parseStaffDirectoryHtml

- [ ] **Step 1: Inspect fixture**

```bash
grep -nE "<h[1-6]|@msstate|@online|class=\"staff|class=\"team|<strong" msstate-policies/tests/fixtures/online/staff.html | head -30
```

- [ ] **Step 2: Append parser**

```typescript
// Append to msstate-policies/src/online/parser.ts

export function parseStaffDirectoryHtml(
  html: string,
  pageUrl: string,
): OnlineStaffEntry[] {
  const $ = cheerioLoad(html);
  const out: OnlineStaffEntry[] = [];
  const seenEmails = new Set<string>();

  // Heuristic: walk paragraphs / list-items / cards in main; for each block,
  // if it contains an email address, treat the block as one staff entry.
  // First non-empty line = name; second = title; remaining = office/group.
  $("main p, main li, main .views-row, main .staff-card").each((_, el) => {
    const $el = $(el);
    const blockText = $el.text();
    const emails = blockText.match(EMAIL_RE) ?? [];
    if (emails.length === 0) return;
    const email = emails[0];
    if (seenEmails.has(email)) return;

    const lines = blockText.split(/\n/).map((s) => s.trim()).filter((s) => s.length > 0 && !s.includes("@") && !PHONE_RE.test(s));
    const name = lines[0] ?? "";
    const title = lines[1] ?? "";
    const office = lines.length > 2 ? lines.slice(2).join("; ") : "";
    const phones = blockText.match(PHONE_RE) ?? [];

    if (name.length === 0) return;
    seenEmails.add(email);
    // If h2 ancestor exists, prepend it as office context (e.g., "Office of Online Education").
    const $ancestor = $el.prevAll("h2, h3").first();
    const sectionHeading = $ancestor.text().replace(/\s+/g, " ").trim();
    out.push({
      name,
      title,
      email,
      phone: phones[0] ?? null,
      office: office || sectionHeading,
      url: pageUrl,
      retrieved_at: RETRIEVED_AT_PLACEHOLDER,
    });
  });

  return out;
}
```

- [ ] **Step 3: Run + commit**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-staff.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 4 tests, 4 pass.

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/online/parser.ts msstate-policies/tests/online/parser-staff.test.ts
git commit -m "feat(online): parseStaffDirectoryHtml extracts central staff entries"
```

---

## Stage 6 — `parseSupportPageHtml` (generic for state-auth / military / orientation / faq / financial)

### Task 6.1: Write failing test

**Files:**
- Create: `msstate-policies/tests/online/parser-support.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSupportPageHtml } from "../../src/online/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "..", "fixtures", "online", name), "utf8");
}

const SUPPORT_FIXTURES: Array<{ slug: string; file: string }> = [
  { slug: "state-authorization", file: "state-authorization.html" },
  { slug: "military-assistance", file: "military-assistance.html" },
  { slug: "orientation", file: "orientation.html" },
  { slug: "faq", file: "faq.html" },
  { slug: "financial-matters", file: "financial-matters.html" },
];

describe("parseSupportPageHtml", () => {
  for (const { slug, file } of SUPPORT_FIXTURES) {
    test(`${slug}: title + non-empty body ≥ 200 chars`, () => {
      const page = parseSupportPageHtml(
        fixture(file),
        slug,
        `https://www.online.msstate.edu/${slug}`,
      );
      assert.equal(page.slug, slug);
      assert.ok(page.title.length > 0, `empty title for ${slug}`);
      assert.ok(page.body_markdown.length >= 200, `body too short for ${slug}: ${page.body_markdown.length}`);
      assert.equal(page.url, `https://www.online.msstate.edu/${slug}`);
    });
  }
  test("returns slug/url even on empty input", () => {
    const page = parseSupportPageHtml(
      "<html><body><h1>Hi</h1></body></html>",
      "test",
      "https://www.online.msstate.edu/test",
    );
    assert.equal(page.slug, "test");
    assert.equal(page.url, "https://www.online.msstate.edu/test");
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-support.test.ts 2>&1 | tail -5
```

Expected: FAIL — `parseSupportPageHtml is not a function`.

### Task 6.2: Implement parseSupportPageHtml

- [ ] **Step 1: Append**

```typescript
// Append to msstate-policies/src/online/parser.ts

export function parseSupportPageHtml(
  html: string,
  slug: string,
  pageUrl: string,
): OnlineInfoPage {
  const $ = cheerioLoad(html);
  const title = $("main h1").first().text().replace(/\s+/g, " ").trim() ||
                $("title").text().replace(/\s+/g, " ").trim() ||
                slug;
  // Convert main body to a simple markdown-ish form:
  // - h2/h3 → ## / ###
  // - lists → bullet lines
  // - paragraphs → blank-line-separated
  const lines: string[] = [];
  $("main h1, main h2, main h3, main h4, main p, main li").each((_, el) => {
    const tag = ($(el).prop("tagName") || "").toLowerCase();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length === 0) return;
    if (tag === "h1") lines.push(`# ${text}`);
    else if (tag === "h2") lines.push(`\n## ${text}`);
    else if (tag === "h3") lines.push(`\n### ${text}`);
    else if (tag === "h4") lines.push(`\n#### ${text}`);
    else if (tag === "li") lines.push(`- ${text}`);
    else lines.push(text);
  });
  const body_markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return {
    slug,
    title,
    url: pageUrl,
    body_markdown,
    retrieved_at: RETRIEVED_AT_PLACEHOLDER,
  };
}
```

- [ ] **Step 2: Run + commit**

```bash
cd msstate-policies && npx tsx --test tests/online/parser-support.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 6 tests (5 fixtures + 1 edge case), 6 pass.

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/online/parser.ts msstate-policies/tests/online/parser-support.test.ts
git commit -m "feat(online): parseSupportPageHtml extracts info-page body_markdown"
```

---

## Stage 7 — Scraper (two-pass, with mocked fetcher tests)

### Task 7.1: Write failing test

**Files:**
- Create: `msstate-policies/tests/online/scraper.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scrapeAllOnline,
  isAllowedOnlineUrl,
  detectOnlineWaf,
} from "../../src/online/scraper.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return readFileSync(join(here, "..", "fixtures", "online", name), "utf8");
}

const STUB: Record<string, string> = {
  "https://www.online.msstate.edu/academic-programs": fixture("academic-programs.html"),
  "https://www.online.msstate.edu/admissions-process": fixture("admissions-process.html"),
  "https://www.online.msstate.edu/staff": fixture("staff.html"),
  "https://www.online.msstate.edu/state-authorization": fixture("state-authorization.html"),
  "https://www.online.msstate.edu/military-assistance": fixture("military-assistance.html"),
  "https://www.online.msstate.edu/orientation": fixture("orientation.html"),
  "https://www.online.msstate.edu/faq": fixture("faq.html"),
  "https://www.online.msstate.edu/financial-matters": fixture("financial-matters.html"),
  "https://www.online.msstate.edu/mba": fixture("program-mba.html"),
  "https://www.online.msstate.edu/bsee": fixture("program-bsee.html"),
  "https://www.online.msstate.edu/psychology": fixture("program-psychology.html"),
  "https://www.online.msstate.edu/adcn": fixture("program-cert-adcn.html"),
};

async function stubFetch(url: string): Promise<string> {
  if (!(url in STUB)) {
    // Return an empty stub for slugs we don't have fixtures for; scraper records
    // a parse_warning for those programs but otherwise succeeds.
    return "<html><body><main><h1>placeholder</h1></main></body></html>";
  }
  return STUB[url];
}

describe("scraper.isAllowedOnlineUrl", () => {
  test("accepts ONLINE_ROOTS exactly", () => {
    assert.ok(isAllowedOnlineUrl("https://www.online.msstate.edu/academic-programs"));
    assert.ok(isAllowedOnlineUrl("https://www.online.msstate.edu/admissions-process"));
    assert.ok(isAllowedOnlineUrl("https://www.online.msstate.edu/staff"));
  });
  test("accepts SUPPORT_PAGE_SLUGS under base", () => {
    for (const slug of ["state-authorization", "military-assistance", "orientation", "faq", "financial-matters"]) {
      assert.ok(isAllowedOnlineUrl(`https://www.online.msstate.edu/${slug}`), slug);
    }
  });
  test("accepts a slug from a provided allowlist", () => {
    assert.ok(isAllowedOnlineUrl("https://www.online.msstate.edu/mba", new Set(["mba", "bsee"])));
  });
  test("rejects unknown slug without an allowlist", () => {
    assert.equal(isAllowedOnlineUrl("https://www.online.msstate.edu/unknown-slug"), false);
  });
  test("rejects non-online subdomain", () => {
    assert.equal(isAllowedOnlineUrl("https://www.policies.msstate.edu/foo"), false);
  });
  test("rejects http (non-TLS)", () => {
    assert.equal(isAllowedOnlineUrl("http://www.online.msstate.edu/staff"), false);
  });
});

describe("scraper.detectOnlineWaf", () => {
  test("flags Cloudflare challenge body", () => {
    assert.equal(detectOnlineWaf("<html>Just a moment...</html>"), true);
  });
  test("clean HTML returns false", () => {
    assert.equal(detectOnlineWaf("<html><body><h1>Online</h1></body></html>"), false);
  });
});

describe("scraper.scrapeAllOnline", () => {
  test("produces programs, admissions_process, staff, info_pages", async () => {
    const r = await scrapeAllOnline({ fetchUrl: stubFetch });
    assert.ok(r.programs.length >= 4, `programs: ${r.programs.length}`);
    assert.equal(r.info_pages.length, 5);
    assert.ok(r.staff.length >= 1);
    assert.equal(r.admissions_process.url, "https://www.online.msstate.edu/admissions-process");
    assert.equal(r.anyError, false);
  });
  test("each program has retrieved_at set", async () => {
    const r = await scrapeAllOnline({ fetchUrl: stubFetch });
    for (const p of r.programs) {
      assert.match(p.retrieved_at, /^\d{4}-\d{2}-\d{2}T/);
    }
  });
  test("flags anyError=true when index fetch fails", async () => {
    const broken: typeof stubFetch = async (url) => {
      if (url.endsWith("/academic-programs")) throw new Error("HTTP 500 for /academic-programs");
      return stubFetch(url);
    };
    const r = await scrapeAllOnline({ fetchUrl: broken });
    assert.equal(r.anyError, true);
  });
});
```

- [ ] **Step 2: Run (expect fail — module not found)**

```bash
cd msstate-policies && npx tsx --test tests/online/scraper.test.ts 2>&1 | tail -5
```

Expected: FAIL — `Cannot find module '../../src/online/scraper.js'`.

### Task 7.2: Implement scraper.ts

**Files:**
- Create: `msstate-policies/src/online/scraper.ts`

- [ ] **Step 1: Write scraper.ts**

```typescript
/**
 * Online-site scraper. Build-time only — never invoked at MCP request time.
 *
 * Two-pass design:
 *   Pass 1 — fetch /academic-programs, parse with parseAcademicProgramsIndex
 *            to get the ~126 program slugs + degree levels.
 *   Pass 2 — concurrency-pool fetch each program page + /admissions-process
 *            + /staff + the 5 SUPPORT_PAGE_SLUGS pages, parse each.
 *
 * Mirrors src/tuition/scraper.ts and src/emergency/scraper.ts patterns:
 * URL allowlist + WAF detector + retry-with-backoff + concurrency pool.
 */
import {
  ONLINE_ROOTS,
  SUPPORT_PAGE_SLUGS,
  OnlineWafError,
  type OnlineAdmissionsProcess,
  type OnlineProgram,
  type OnlineStaffEntry,
  type OnlineInfoPage,
} from "./types.js";
import {
  parseAcademicProgramsIndex,
  parseProgramHtml,
  parseAdmissionsProcessHtml,
  parseStaffDirectoryHtml,
  parseSupportPageHtml,
} from "./parser.js";

const ALLOWED_HOST = "www.online.msstate.edu";

export function isAllowedOnlineUrl(
  url: string,
  allowedProgramSlugs?: Set<string>,
): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.host !== ALLOWED_HOST) return false;
  // Exact match against ONLINE_ROOTS top-level entries (excluding the base "/")
  if (ONLINE_ROOTS.includes(url)) return true;
  // Or base + SUPPORT_PAGE_SLUGS
  for (const slug of SUPPORT_PAGE_SLUGS) {
    if (url === `https://www.online.msstate.edu/${slug}`) return true;
  }
  // Or base + a slug in the provided per-scrape allowlist
  if (allowedProgramSlugs) {
    const m = u.pathname.match(/^\/([a-z][a-z0-9-]*)$/i);
    if (m && allowedProgramSlugs.has(m[1])) return true;
  }
  return false;
}

export function detectOnlineWaf(body: string): boolean {
  if (body.includes("Just a moment...")) return true;
  if (body.includes("cf-chl-bypass")) return true;
  if (/<meta\s+http-equiv=["']refresh["'][^>]+url=[^>]*token=/i.test(body)) return true;
  return false;
}

const UA = "msstate-policies-mcp/1.0.0 (build-worker-corpus)";
const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const JITTER_MIN_MS = 150;
const JITTER_MAX_MS = 500;
const FETCH_RETRIES = 3;
const RETRY_BACKOFF_MS = [500, 1500, 4000];

async function fetchOnce(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    if (detectOnlineWaf(text)) throw new OnlineWafError(url);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try { return await fetchOnce(url); }
    catch (err) {
      lastErr = err;
      if (err instanceof OnlineWafError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP\s+4\d{2}/.test(msg)) throw err;
      if (attempt < FETCH_RETRIES) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function jitter(): Promise<void> {
  const ms = JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS));
  return new Promise((r) => setTimeout(r, ms));
}

async function pool<I, O>(items: I[], conc: number, fn: (i: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
      await jitter();
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return out;
}

export interface ScrapeAllOptions {
  fetchUrl?: (url: string) => Promise<string>;
}

export interface ScrapeAllResult {
  programs: OnlineProgram[];
  admissions_process: OnlineAdmissionsProcess;
  staff: OnlineStaffEntry[];
  info_pages: OnlineInfoPage[];
  per_source: Record<string, { ok: boolean; error: string | null }>;
  anyError: boolean;
}

export async function scrapeAllOnline(opts: ScrapeAllOptions = {}): Promise<ScrapeAllResult> {
  const raw = opts.fetchUrl ?? fetchWithRetry;
  const fetcher = async (url: string): Promise<string> => {
    const html = await raw(url);
    if (detectOnlineWaf(html)) throw new OnlineWafError(url);
    return html;
  };
  const retrieved_at = new Date().toISOString();
  const per_source: Record<string, { ok: boolean; error: string | null }> = {};
  let anyError = false;

  // Pass 1: academic-programs index → program slugs
  const indexUrl = "https://www.online.msstate.edu/academic-programs";
  let indexEntries: ReturnType<typeof parseAcademicProgramsIndex> = [];
  try {
    const html = await fetcher(indexUrl);
    indexEntries = parseAcademicProgramsIndex(html, indexUrl);
    per_source["academic-programs"] = { ok: indexEntries.length > 0, error: indexEntries.length === 0 ? "0 entries parsed" : null };
    if (indexEntries.length === 0) anyError = true;
  } catch (e) {
    per_source["academic-programs"] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    anyError = true;
  }

  const allowedSlugs = new Set(indexEntries.map((e) => e.slug));

  // Pass 2a: per-program pages (concurrency-pooled)
  const programResults = await pool(indexEntries, CONCURRENCY, async (entry) => {
    const programUrl = `https://www.online.msstate.edu/${entry.slug}`;
    if (!isAllowedOnlineUrl(programUrl, allowedSlugs)) {
      return { slug: entry.slug, program: null as OnlineProgram | null, error: `URL not in allowlist: ${programUrl}` };
    }
    try {
      const html = await fetcher(programUrl);
      const program = parseProgramHtml(html, entry.slug, entry.degree_level, programUrl);
      if (!program) return { slug: entry.slug, program: null, error: "parse returned null" };
      return { slug: entry.slug, program: { ...program, retrieved_at }, error: null as string | null };
    } catch (e) {
      if (e instanceof OnlineWafError) throw e;
      return { slug: entry.slug, program: null, error: e instanceof Error ? e.message : String(e) };
    }
  });

  const programs: OnlineProgram[] = [];
  for (const r of programResults) {
    per_source[`program/${r.slug}`] = { ok: r.error === null, error: r.error };
    if (r.error) anyError = true;
    if (r.program) programs.push(r.program);
  }

  // Pass 2b: /admissions-process (single fetch)
  const admissionsUrl = "https://www.online.msstate.edu/admissions-process";
  let admissions_process: OnlineAdmissionsProcess;
  try {
    const html = await fetcher(admissionsUrl);
    admissions_process = { ...parseAdmissionsProcessHtml(html, admissionsUrl), retrieved_at };
    per_source["admissions-process"] = { ok: true, error: null };
  } catch (e) {
    if (e instanceof OnlineWafError) throw e;
    per_source["admissions-process"] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    anyError = true;
    // Stub structure so callers can still validate
    admissions_process = {
      url: admissionsUrl,
      central_contact: { name: "", title: "", email: null, phone: null },
      shared_prelude: "",
      sections: { undergraduate: "", graduate: "", transfer: "", readmit: "", international: "" },
      application_fee_tiers: [],
      external_apply_urls: [],
      retrieved_at,
    };
  }

  // Pass 2c: /staff (single fetch)
  const staffUrl = "https://www.online.msstate.edu/staff";
  let staff: OnlineStaffEntry[] = [];
  try {
    const html = await fetcher(staffUrl);
    staff = parseStaffDirectoryHtml(html, staffUrl).map((s) => ({ ...s, retrieved_at }));
    per_source["staff"] = { ok: staff.length > 0, error: staff.length === 0 ? "0 entries parsed" : null };
    if (staff.length === 0) anyError = true;
  } catch (e) {
    if (e instanceof OnlineWafError) throw e;
    per_source["staff"] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    anyError = true;
  }

  // Pass 2d: 5 support pages (concurrency-pooled)
  const supportResults = await pool(
    [...SUPPORT_PAGE_SLUGS],
    CONCURRENCY,
    async (slug) => {
      const url = `https://www.online.msstate.edu/${slug}`;
      try {
        const html = await fetcher(url);
        return { slug, page: { ...parseSupportPageHtml(html, slug, url), retrieved_at } as OnlineInfoPage, error: null as string | null };
      } catch (e) {
        if (e instanceof OnlineWafError) throw e;
        return { slug, page: null as OnlineInfoPage | null, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  const info_pages: OnlineInfoPage[] = [];
  for (const r of supportResults) {
    per_source[`info/${r.slug}`] = { ok: r.page !== null, error: r.error };
    if (r.error || !r.page) anyError = true;
    if (r.page) info_pages.push(r.page);
  }

  return { programs, admissions_process, staff, info_pages, per_source, anyError };
}
```

- [ ] **Step 2: Run scraper tests**

```bash
cd msstate-policies && npx tsx --test tests/online/scraper.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 11 tests, 11 pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/online/scraper.ts msstate-policies/tests/online/scraper.test.ts
git commit -m "feat(online): two-pass scraper with allowlist + WAF + retry + concurrency pool"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 8 — search / routing helpers

### Task 8.1: Write failing test

**Files:**
- Create: `msstate-policies/tests/online/search.test.ts`

- [ ] **Step 1: Write the test**

```typescript
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
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd msstate-policies && npx tsx --test tests/online/search.test.ts 2>&1 | tail -5
```

Expected: FAIL — `Cannot find module '../../src/online/search.js'`.

### Task 8.2: Implement search.ts

**Files:**
- Create: `msstate-policies/src/online/search.ts`

- [ ] **Step 1: Write search.ts**

```typescript
/**
 * Online module — search and filter helpers.
 *
 * Three responsibilities:
 *   1. BM25 over OnlineInfoPage[] + a synthetic staff doc.
 *   2. Deterministic filter for list_online_programs (level + substring + pagination).
 *   3. Fuzzy program-name resolver for get_online_program(name_query).
 */
import type {
  OnlineInfoPage,
  OnlineProgram,
  OnlineStaffEntry,
  DegreeLevel,
} from "./types.js";

const TOKEN_SPLIT = /[\s\-_/.,;:()\[\]{}!?"'`<>|@#$%^&*=+]+/;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function tokenize(s: string): string[] {
  return s.normalize("NFKC").toLowerCase().split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

interface IndexedDoc {
  row: OnlineInfoPage;
  titleTokens: string[];
  bodyTokens: string[];
  dl: number;
}

const FIELD_WEIGHTS = { title: 3, body: 1 } as const;

let infoDocs: IndexedDoc[] = [];
let infoDf = new Map<string, number>();
let infoAvgLen = 0;

function flattenStaffAsDoc(staff: OnlineStaffEntry[]): OnlineInfoPage {
  const lines = staff.map((s) => `${s.name} — ${s.title}. ${s.email ?? ""} ${s.phone ?? ""} ${s.office}`);
  return {
    slug: "staff",
    title: "MSU Online Staff",
    url: "https://www.online.msstate.edu/staff",
    body_markdown: lines.join("\n"),
    retrieved_at: staff[0]?.retrieved_at ?? "1970-01-01T00:00:00.000Z",
  };
}

export function indexInfoPages(info_pages: OnlineInfoPage[], staff: OnlineStaffEntry[]): void {
  const docs: OnlineInfoPage[] = [...info_pages];
  if (staff.length > 0) docs.push(flattenStaffAsDoc(staff));
  infoDocs = docs.map((row) => {
    const titleTokens = tokenize(row.title);
    const bodyTokens = tokenize(row.body_markdown);
    return { row, titleTokens, bodyTokens, dl: titleTokens.length + bodyTokens.length };
  });
  infoDf = new Map();
  let total = 0;
  for (const d of infoDocs) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.titleTokens, ...d.bodyTokens]) {
      if (seen.has(t)) continue;
      seen.add(t);
      infoDf.set(t, (infoDf.get(t) ?? 0) + 1);
    }
  }
  infoAvgLen = infoDocs.length > 0 ? total / infoDocs.length : 0;
}

function idf(token: string): number {
  const n = infoDocs.length;
  const dfi = infoDf.get(token) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}

function bm25Term(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (infoAvgLen || 1));
  return idfV * ((tf * (BM25_K1 + 1)) / denom);
}

function countOf(token: string, arr: string[]): number {
  let c = 0;
  for (const t of arr) if (t === token) c++;
  return c;
}

export type InfoScope =
  | "all"
  | "state-authorization"
  | "military-assistance"
  | "orientation"
  | "faq"
  | "financial-matters"
  | "staff";

export interface InfoHit { row: OnlineInfoPage; score: number; }

export function bm25SearchInfo(query: string, k: number, scope: InfoScope): InfoHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const docs = scope === "all" ? infoDocs : infoDocs.filter((d) => d.row.slug === scope);
  const out: InfoHit[] = [];
  for (const d of docs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = idf(q);
      if (idfQ === 0) continue;
      s += FIELD_WEIGHTS.title * bm25Term(countOf(q, d.titleTokens), d.dl, idfQ);
      s += FIELD_WEIGHTS.body  * bm25Term(countOf(q, d.bodyTokens),  d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, Math.min(k, out.length)));
}

// ---- Filter for list_online_programs --------------------------------------

export interface ProgramFilterRequest {
  level?: DegreeLevel;
  subject_keyword?: string;
  limit?: number;
  offset?: number;
}

export interface ProgramFilterResult {
  matches: Array<{
    slug: string;
    name: string;
    degree_level: DegreeLevel;
    short_description: string;
    url: string;
  }>;
  total: number;
  filtered_total: number;
}

export function filterPrograms(programs: OnlineProgram[], req: ProgramFilterRequest): ProgramFilterResult {
  let filtered = programs;
  if (req.level) filtered = filtered.filter((p) => p.degree_level === req.level);
  if (req.subject_keyword && req.subject_keyword.trim().length > 0) {
    const k = req.subject_keyword.trim().toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.name.toLowerCase().includes(k) ||
        p.short_description.toLowerCase().includes(k),
    );
  }
  const limit = Math.max(1, Math.min(req.limit ?? 50, 200));
  const offset = Math.max(0, req.offset ?? 0);
  const matches = filtered.slice(offset, offset + limit).map((p) => ({
    slug: p.slug,
    name: p.name,
    degree_level: p.degree_level,
    short_description: p.short_description,
    url: p.url,
  }));
  return { matches, total: programs.length, filtered_total: filtered.length };
}

// ---- Fuzzy resolver for get_online_program(name_query) ---------------------

export interface FuzzyResolveResult {
  matched: OnlineProgram | null;
  did_you_mean: Array<{ slug: string; name: string }>;
}

export function fuzzyResolveProgram(programs: OnlineProgram[], query: string): FuzzyResolveResult {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return { matched: null, did_you_mean: [] };
  // Score = sum over query tokens of: (4 if in slug) + (3 if in name) + (1 if in short_description) per occurrence.
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
  if (scored.length === 0) return { matched: null, did_you_mean: [] };
  return {
    matched: scored[0].p,
    did_you_mean: scored.slice(1, 3).map((x) => ({ slug: x.p.slug, name: x.p.name })),
  };
}
```

- [ ] **Step 2: Run + commit**

```bash
cd msstate-policies && npx tsx --test tests/online/search.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 11 tests, 11 pass.

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/online/search.ts msstate-policies/tests/online/search.test.ts
git commit -m "feat(online): BM25 info search + program filter + fuzzy resolver"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 9 — Corpus loader

### Task 9.1: Write failing test

**Files:**
- Create: `msstate-policies/tests/online/corpus.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  setOnlineCorpus,
  getOnlineCorpus,
  getProgramBySlug,
  listAllPrograms,
  getAdmissionsProcess,
  getAllInfoPages,
  getAllStaff,
  onlineCorpusHealth,
} from "../../src/online/corpus.js";
import type { OnlineCorpus } from "../../src/online/types.js";

const SAMPLE: OnlineCorpus = {
  builtAt: "2026-05-13T00:00:00.000Z",
  source: "https://www.online.msstate.edu/",
  programs: [
    {
      slug: "mba", name: "Master of Business Administration",
      degree_level: "master", format: "Fully online", short_description: "MBA",
      url: "https://www.online.msstate.edu/mba",
      tuition: { per_credit_usd: 581, instructional_fee_per_credit_usd: 25, application_fee_domestic_usd: 60, application_fee_international_usd: 80, raw_prose: "" },
      contacts: [], application_deadlines: [], admission_requirements: "",
      entrance_exams: null, accreditation: "AACSB", forms: [], raw_sections: {},
      parse_warnings: [], retrieved_at: "x",
    },
  ],
  admissions_process: {
    url: "https://www.online.msstate.edu/admissions-process",
    central_contact: { name: "Office of Online Education", title: "Front-desk", email: "ask@online.msstate.edu", phone: "(662) 325-3473" },
    shared_prelude: "Apply now.", sections: { undergraduate: "ug", graduate: "g", transfer: "t", readmit: "r", international: "i" },
    application_fee_tiers: [], external_apply_urls: [], retrieved_at: "x",
  },
  staff: [{ name: "Jane Doe", title: "Director", email: "jdoe@msstate.edu", phone: null, office: "O", url: "x", retrieved_at: "x" }],
  info_pages: [{ slug: "orientation", title: "Orientation", url: "x", body_markdown: "x", retrieved_at: "x" }],
};

describe("online/corpus", () => {
  test("setOnlineCorpus + getters round-trip", () => {
    setOnlineCorpus(SAMPLE);
    assert.equal(getOnlineCorpus()?.builtAt, SAMPLE.builtAt);
    assert.equal(listAllPrograms().length, 1);
    assert.equal(getAllStaff().length, 1);
    assert.equal(getAllInfoPages().length, 1);
  });
  test("getProgramBySlug returns the matching program", () => {
    setOnlineCorpus(SAMPLE);
    const p = getProgramBySlug("mba");
    assert.ok(p);
    assert.equal(p.name, "Master of Business Administration");
  });
  test("getProgramBySlug returns null for unknown slug", () => {
    setOnlineCorpus(SAMPLE);
    assert.equal(getProgramBySlug("unknown"), null);
  });
  test("getAdmissionsProcess returns the process record", () => {
    setOnlineCorpus(SAMPLE);
    const a = getAdmissionsProcess();
    assert.ok(a);
    assert.equal(a.central_contact.email, "ask@online.msstate.edu");
  });
  test("health reports loaded + counts", () => {
    setOnlineCorpus(SAMPLE);
    const h = onlineCorpusHealth();
    assert.equal(h.loaded, true);
    assert.equal(h.program_count, 1);
    assert.equal(h.staff_count, 1);
    assert.equal(h.info_page_count, 1);
    assert.equal(h.builtAt, SAMPLE.builtAt);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd msstate-policies && npx tsx --test tests/online/corpus.test.ts 2>&1 | tail -5
```

Expected: FAIL — `Cannot find module '../../src/online/corpus.js'`.

### Task 9.2: Implement corpus.ts

**Files:**
- Create: `msstate-policies/src/online/corpus.ts`

- [ ] **Step 1: Write corpus.ts**

```typescript
/**
 * Online corpus loader and shared in-memory state.
 *
 * Stdio (npx plugin): bake the `online_education` block into dist/index.js
 * via esbuild's `define`. Server startup reads __ONLINE_CORPUS__ and calls
 * setOnlineCorpus(...).
 *
 * Worker: corpus.json is imported and the Worker mirrors the search/route
 * logic inline (see worker/src/index.ts).
 */
import { indexInfoPages } from "./search.js";
import type {
  OnlineCorpus,
  OnlineProgram,
  OnlineAdmissionsProcess,
  OnlineStaffEntry,
  OnlineInfoPage,
} from "./types.js";

let CORPUS: OnlineCorpus | null = null;

export function setOnlineCorpus(c: OnlineCorpus): void {
  CORPUS = c;
  indexInfoPages(c.info_pages, c.staff);
}

export function getOnlineCorpus(): OnlineCorpus | null {
  return CORPUS;
}

export function listAllPrograms(): OnlineProgram[] {
  return CORPUS?.programs ?? [];
}

export function getProgramBySlug(slug: string): OnlineProgram | null {
  if (!CORPUS) return null;
  return CORPUS.programs.find((p) => p.slug === slug) ?? null;
}

export function getAdmissionsProcess(): OnlineAdmissionsProcess | null {
  return CORPUS?.admissions_process ?? null;
}

export function getAllStaff(): OnlineStaffEntry[] {
  return CORPUS?.staff ?? [];
}

export function getAllInfoPages(): OnlineInfoPage[] {
  return CORPUS?.info_pages ?? [];
}

export interface OnlineCorpusHealth {
  loaded: boolean;
  program_count: number;
  staff_count: number;
  info_page_count: number;
  builtAt: string | null;
}

export function onlineCorpusHealth(): OnlineCorpusHealth {
  if (!CORPUS) {
    return { loaded: false, program_count: 0, staff_count: 0, info_page_count: 0, builtAt: null };
  }
  return {
    loaded: true,
    program_count: CORPUS.programs.length,
    staff_count: CORPUS.staff.length,
    info_page_count: CORPUS.info_pages.length,
    builtAt: CORPUS.builtAt,
  };
}
```

- [ ] **Step 2: Run + commit**

```bash
cd msstate-policies && npx tsx --test tests/online/corpus.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 5 tests, 5 pass.

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/online/corpus.ts msstate-policies/tests/online/corpus.test.ts
git commit -m "feat(online): corpus loader + health getter"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 10 — Subprocess scraper script

### Task 10.1: Create `_scrape-online.ts`

**Files:**
- Create: `scripts/_scrape-online.ts`

- [ ] **Step 1: Write the script**

```typescript
/**
 * One-shot online-site scrape that writes a single JSON blob to stdout.
 * Run via `npx tsx scripts/_scrape-online.ts` from repo root.
 *
 * Mirrors scripts/_scrape-tuition.ts pattern: stdout-only JSON output,
 * stderr-only logging, defensive console.log redirect at the top.
 */

// Defensive: redirect console.log → stderr so any transitive dep that logs
// to stdout doesn't corrupt the JSON pipe to build-worker-corpus.mjs.
// eslint-disable-next-line no-console
console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

import { scrapeAllOnline } from "../msstate-policies/src/online/scraper.js";

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
  process.stdout.write(
    JSON.stringify({
      programs: r.programs,
      admissions_process: r.admissions_process,
      staff: r.staff,
      info_pages: r.info_pages,
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

- [ ] **Step 2: Run the live scrape end-to-end**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
npx tsx scripts/_scrape-online.ts > /tmp/online-scrape.json 2> /tmp/online-scrape.err
echo "exit=$?"
tail -8 /tmp/online-scrape.err
jq '{programs: (.programs|length), staff: (.staff|length), info_pages: (.info_pages|length), admissions_url: .admissions_process.url, anyError, programs_with_warnings: ([.programs[] | select(.parse_warnings | length > 0)] | length)}' /tmp/online-scrape.json
```

Expected:
- `exit=0`
- `anyError: false`
- `programs >= 100`, `staff >= 1`, `info_pages == 5`
- `programs_with_warnings <= 10`

If counts are short or anyError=true, inspect `/tmp/online-scrape.err` — common issues:
- MSU rate-limited (intermittent 403s) → wait 60s and retry the live scrape
- A specific support page slug changed → MSU renamed; investigate and update SUPPORT_PAGE_SLUGS in types.ts
- A parser regression → re-run unit tests, the live data should match the fixtures

- [ ] **Step 3: Commit (NO temp JSON data)**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add scripts/_scrape-online.ts
git status --short   # confirm only the script staged; /tmp/* is gitignored
git commit -m "build(online): subprocess scraper script"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 11 — Four MCP tools

### Task 11.1: `list_online_programs` tool

**Files:**
- Create: `msstate-policies/src/tools/list_online_programs.ts`
- Create: `msstate-policies/tests/online/tool-list-online-programs.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { list_online_programs } from "../../src/tools/list_online_programs.js";
import { setOnlineCorpus } from "../../src/online/corpus.js";
import { ONLINE_DISCLAIMER, MAX_QUERY_CHARS } from "../../src/online/types.js";
import type { OnlineCorpus, OnlineProgram, DegreeLevel } from "../../src/online/types.js";

function prog(slug: string, level: DegreeLevel, name: string, shortDesc = ""): OnlineProgram {
  return {
    slug, name, degree_level: level, format: "Fully online", short_description: shortDesc,
    url: `x/${slug}`,
    tuition: { per_credit_usd: null, instructional_fee_per_credit_usd: null, application_fee_domestic_usd: null, application_fee_international_usd: null, raw_prose: "" },
    contacts: [], application_deadlines: [], admission_requirements: "",
    entrance_exams: null, accreditation: null, forms: [], raw_sections: {}, parse_warnings: [],
    retrieved_at: "x",
  };
}

function corpus(programs: OnlineProgram[]): OnlineCorpus {
  return {
    builtAt: "2026-05-13T00:00:00.000Z",
    source: "https://www.online.msstate.edu/",
    programs,
    admissions_process: { url: "x", central_contact: { name: "x", title: "x", email: null, phone: null }, shared_prelude: "", sections: { undergraduate: "", graduate: "", transfer: "", readmit: "", international: "" }, application_fee_tiers: [], external_apply_urls: [], retrieved_at: "x" },
    staff: [], info_pages: [],
  };
}

async function call(args: unknown) {
  const res = await list_online_programs.handler(args);
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("list_online_programs", () => {
  test("returns disclaimer + lightweight rows", async () => {
    setOnlineCorpus(corpus([prog("mba", "master", "Master of Business Administration")]));
    const r = await call({});
    assert.equal(r.disclaimer, ONLINE_DISCLAIMER);
    assert.ok(r.matches.length >= 1);
    assert.equal(r.matches[0].slug, "mba");
  });
  test("filter by level", async () => {
    setOnlineCorpus(corpus([
      prog("mba", "master", "MBA"),
      prog("bsee", "bachelor", "BSEE"),
    ]));
    const r = await call({ level: "master" });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].slug, "mba");
  });
  test("filter by subject_keyword", async () => {
    setOnlineCorpus(corpus([
      prog("mba", "master", "Master of Business Administration"),
      prog("bsee", "bachelor", "Bachelor in Electrical Engineering"),
    ]));
    const r = await call({ subject_keyword: "engineering" });
    assert.equal(r.matches.length, 1);
    assert.match(r.matches[0].name, /Engineering/);
  });
  test("rejects out-of-range limit via zod", async () => {
    setOnlineCorpus(corpus([prog("a", "bachelor", "A")]));
    await assert.rejects(() => call({ limit: 500 }));
  });
  test("rejects subject_keyword longer than MAX_QUERY_CHARS", async () => {
    setOnlineCorpus(corpus([prog("a", "bachelor", "A")]));
    const long = "x".repeat(MAX_QUERY_CHARS + 1);
    await assert.rejects(() => call({ subject_keyword: long }));
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd msstate-policies && npx tsx --test tests/online/tool-list-online-programs.test.ts 2>&1 | tail -5
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

```typescript
// msstate-policies/src/tools/list_online_programs.ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { listAllPrograms, getOnlineCorpus } from "../online/corpus.js";
import { filterPrograms } from "../online/search.js";
import { ONLINE_DISCLAIMER, MAX_QUERY_CHARS } from "../online/types.js";

const Input = z
  .object({
    level: z.enum(["bachelor", "master", "specialist", "doctoral", "certificate", "endorsement"]).optional(),
    subject_keyword: z.string().max(MAX_QUERY_CHARS).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export const list_online_programs = {
  name: "list_online_programs",
  description:
    "Browse / filter MSU's online programs from online.msstate.edu. Returns lightweight rows ({slug, name, degree_level, short_description, url}); for full per-program details (contacts, deadlines, tuition) follow up with get_online_program. " +
    "`level` filters by degree level (bachelor / master / specialist / doctoral / certificate / endorsement). " +
    "`subject_keyword` is a case-insensitive substring match against the name + short_description (e.g. 'engineering', 'business', 'education'). " +
    "`limit` (default 50, max 200) and `offset` (default 0) for pagination. Every response carries the online disclaimer about info changing.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const result = filterPrograms(listAllPrograms(), {
      level: input.level,
      subject_keyword: input.subject_keyword,
      limit: input.limit,
      offset: input.offset,
    });
    const corpus = getOnlineCorpus();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: ONLINE_DISCLAIMER,
            matches: result.matches,
            total: result.total,
            filtered_total: result.filtered_total,
            corpus_built_at: corpus?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
```

- [ ] **Step 4: Run + commit**

```bash
cd msstate-policies && npx tsx --test tests/online/tool-list-online-programs.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 5 tests, 5 pass.

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/tools/list_online_programs.ts msstate-policies/tests/online/tool-list-online-programs.test.ts
git commit -m "feat(online): list_online_programs tool"
git rev-parse --abbrev-ref HEAD
```

### Task 11.2: `get_online_program` tool

**Files:**
- Create: `msstate-policies/src/tools/get_online_program.ts`
- Create: `msstate-policies/tests/online/tool-get-online-program.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { get_online_program } from "../../src/tools/get_online_program.js";
import { setOnlineCorpus } from "../../src/online/corpus.js";
import { ONLINE_DISCLAIMER } from "../../src/online/types.js";
import type { OnlineCorpus, OnlineProgram, DegreeLevel } from "../../src/online/types.js";

function prog(slug: string, level: DegreeLevel, name: string, shortDesc = ""): OnlineProgram {
  return {
    slug, name, degree_level: level, format: "Fully online", short_description: shortDesc,
    url: `x/${slug}`,
    tuition: { per_credit_usd: null, instructional_fee_per_credit_usd: null, application_fee_domestic_usd: null, application_fee_international_usd: null, raw_prose: "" },
    contacts: [], application_deadlines: [], admission_requirements: "",
    entrance_exams: null, accreditation: null, forms: [], raw_sections: {}, parse_warnings: [],
    retrieved_at: "x",
  };
}

function corpus(programs: OnlineProgram[]): OnlineCorpus {
  return {
    builtAt: "2026-05-13T00:00:00.000Z",
    source: "https://www.online.msstate.edu/",
    programs,
    admissions_process: { url: "x", central_contact: { name: "x", title: "x", email: null, phone: null }, shared_prelude: "", sections: { undergraduate: "", graduate: "", transfer: "", readmit: "", international: "" }, application_fee_tiers: [], external_apply_urls: [], retrieved_at: "x" },
    staff: [], info_pages: [],
  };
}

async function call(args: unknown) {
  const res = await get_online_program.handler(args);
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("get_online_program", () => {
  test("slug match returns full record + disclaimer", async () => {
    setOnlineCorpus(corpus([prog("mba", "master", "MBA")]));
    const r = await call({ slug: "mba" });
    assert.equal(r.disclaimer, ONLINE_DISCLAIMER);
    assert.equal(r.matched?.slug, "mba");
    assert.deepEqual(r.did_you_mean, []);
  });
  test("unknown slug returns matched=null + not_found_reason", async () => {
    setOnlineCorpus(corpus([prog("mba", "master", "MBA")]));
    const r = await call({ slug: "xyz" });
    assert.equal(r.matched, null);
    assert.ok(r.not_found_reason);
  });
  test("name_query routes via fuzzy resolver", async () => {
    setOnlineCorpus(corpus([
      prog("mba", "master", "Master of Business Administration", "MBA online"),
      prog("psychology", "bachelor", "Bachelor in Psychology", "Online psychology"),
    ]));
    const r = await call({ name_query: "online psychology bachelor" });
    assert.equal(r.matched?.slug, "psychology");
  });
  test("rejects both slug and name_query set", async () => {
    setOnlineCorpus(corpus([prog("mba", "master", "MBA")]));
    await assert.rejects(() => call({ slug: "mba", name_query: "MBA" }));
  });
  test("rejects neither slug nor name_query set", async () => {
    setOnlineCorpus(corpus([prog("mba", "master", "MBA")]));
    await assert.rejects(() => call({}));
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd msstate-policies && npx tsx --test tests/online/tool-get-online-program.test.ts 2>&1 | tail -5
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

```typescript
// msstate-policies/src/tools/get_online_program.ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  getProgramBySlug,
  listAllPrograms,
  getOnlineCorpus,
} from "../online/corpus.js";
import { fuzzyResolveProgram } from "../online/search.js";
import { ONLINE_DISCLAIMER, MAX_QUERY_CHARS } from "../online/types.js";

const Input = z
  .object({
    slug: z.string().min(1).max(MAX_QUERY_CHARS).optional(),
    name_query: z.string().min(1).max(MAX_QUERY_CHARS).optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.slug) !== Boolean(v.name_query),
    { message: "Exactly one of slug or name_query is required" },
  );

export const get_online_program = {
  name: "get_online_program",
  description:
    "Fetch one MSU Online program's full record from online.msstate.edu: name + degree_level + format + short_description + tuition (per-credit + fees) + contacts (advisors with name/email/phone) + application_deadlines + admission_requirements + entrance_exams + accreditation + forms + raw_sections catch-all. " +
    "Provide `slug` (e.g., 'mba', 'bsee', 'psychology') for direct lookup, OR `name_query` (e.g., 'online psychology bachelor') for fuzzy match. Exactly one is required. " +
    "When name_query routes via BM25, the top-1 is in `matched` and the next-2 best are in `did_you_mean` so the model can clarify if ambiguous. Every response carries the online disclaimer.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const corpus = getOnlineCorpus();
    let matched = null;
    let did_you_mean: Array<{ slug: string; name: string }> = [];
    let not_found_reason: string | null = null;
    if (input.slug) {
      matched = getProgramBySlug(input.slug);
      if (!matched) not_found_reason = `No program with slug '${input.slug}' in the corpus. Try list_online_programs to see valid slugs.`;
    } else if (input.name_query) {
      const r = fuzzyResolveProgram(listAllPrograms(), input.name_query);
      matched = r.matched;
      did_you_mean = r.did_you_mean;
      if (!matched) not_found_reason = `No program matched '${input.name_query}'. Try list_online_programs(subject_keyword=…) to browse.`;
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: ONLINE_DISCLAIMER,
            matched,
            did_you_mean,
            not_found_reason,
            corpus_built_at: corpus?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
```

- [ ] **Step 4: Run + commit**

```bash
cd msstate-policies && npx tsx --test tests/online/tool-get-online-program.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 5 tests, 5 pass.

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/tools/get_online_program.ts msstate-policies/tests/online/tool-get-online-program.test.ts
git commit -m "feat(online): get_online_program tool (slug + name_query)"
```

### Task 11.3: `get_online_admissions_process` tool

**Files:**
- Create: `msstate-policies/src/tools/get_online_admissions_process.ts`
- Create: `msstate-policies/tests/online/tool-get-online-admissions-process.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { get_online_admissions_process } from "../../src/tools/get_online_admissions_process.js";
import { setOnlineCorpus } from "../../src/online/corpus.js";
import { ONLINE_DISCLAIMER } from "../../src/online/types.js";
import type { OnlineCorpus } from "../../src/online/types.js";

const SAMPLE: OnlineCorpus = {
  builtAt: "x", source: "https://www.online.msstate.edu/",
  programs: [],
  admissions_process: {
    url: "https://www.online.msstate.edu/admissions-process",
    central_contact: { name: "Office of Online Education", title: "Front-desk", email: "ask@online.msstate.edu", phone: "(662) 325-3473" },
    shared_prelude: "Apply now.",
    sections: { undergraduate: "ug body", graduate: "g body", transfer: "t body", readmit: "r body", international: "i body" },
    application_fee_tiers: [{ kind: "Undergraduate", usd: 50 }, { kind: "International", usd: 80 }],
    external_apply_urls: [{ kind: "Undergraduate application", url: "https://www.apply.msstate.edu/" }],
    retrieved_at: "x",
  },
  staff: [], info_pages: [],
};

async function call(args: unknown) {
  const res = await get_online_admissions_process.handler(args);
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("get_online_admissions_process", () => {
  test("no student_type returns all 5 sections + central contact + disclaimer", async () => {
    setOnlineCorpus(SAMPLE);
    const r = await call({});
    assert.equal(r.disclaimer, ONLINE_DISCLAIMER);
    assert.equal(r.central_contact.email, "ask@online.msstate.edu");
    for (const st of ["undergraduate", "graduate", "transfer", "readmit", "international"]) {
      assert.ok(r.sections[st]);
    }
  });
  test("student_type filter returns only that section + always the prelude/contact", async () => {
    setOnlineCorpus(SAMPLE);
    const r = await call({ student_type: "international" });
    assert.equal(r.sections.international, "i body");
    assert.equal(r.sections.undergraduate, undefined);
    assert.ok(r.shared_prelude.length > 0);
    assert.ok(r.central_contact.email);
  });
  test("application_fee_tiers + external_apply_urls always included", async () => {
    setOnlineCorpus(SAMPLE);
    const r = await call({});
    assert.ok(r.application_fee_tiers.length >= 1);
    assert.ok(r.external_apply_urls.length >= 1);
  });
  test("rejects unknown student_type via zod", async () => {
    setOnlineCorpus(SAMPLE);
    await assert.rejects(() => call({ student_type: "invalid" }));
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd msstate-policies && npx tsx --test tests/online/tool-get-online-admissions-process.test.ts 2>&1 | tail -5
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

```typescript
// msstate-policies/src/tools/get_online_admissions_process.ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getAdmissionsProcess, getOnlineCorpus } from "../online/corpus.js";
import { ONLINE_DISCLAIMER } from "../online/types.js";

const Input = z
  .object({
    student_type: z.enum(["undergraduate", "graduate", "transfer", "readmit", "international"]).optional(),
  })
  .strict();

export const get_online_admissions_process = {
  name: "get_online_admissions_process",
  description:
    "Return MSU Online's published admissions process from /admissions-process. Sectioned by student type (undergraduate / graduate / transfer / readmit / international). " +
    "Pass `student_type` to get just one section; omit to get ALL five. " +
    "Either way, the response ALWAYS includes the shared prelude, the central front-desk contact (ask@online.msstate.edu), application fee tiers, and external apply URLs (apply.msstate.edu for undergrad, grad.msstate.edu/apply for graduate). " +
    "Every response carries the online disclaimer about info changing.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const ap = getAdmissionsProcess();
    if (!ap) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              disclaimer: ONLINE_DISCLAIMER,
              shared_prelude: "",
              sections: {},
              central_contact: { name: "", title: "", email: null, phone: null },
              application_fee_tiers: [],
              external_apply_urls: [],
              source_url: "https://www.online.msstate.edu/admissions-process",
              not_found_reason: "Online admissions process is not loaded in the corpus.",
              corpus_built_at: getOnlineCorpus()?.builtAt ?? null,
            }, null, 2),
          },
        ],
      };
    }
    const sections = input.student_type
      ? { [input.student_type]: ap.sections[input.student_type] }
      : ap.sections;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: ONLINE_DISCLAIMER,
            shared_prelude: ap.shared_prelude,
            sections,
            central_contact: ap.central_contact,
            application_fee_tiers: ap.application_fee_tiers,
            external_apply_urls: ap.external_apply_urls,
            source_url: ap.url,
            corpus_built_at: getOnlineCorpus()?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
```

- [ ] **Step 4: Run + commit**

```bash
cd msstate-policies && npx tsx --test tests/online/tool-get-online-admissions-process.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 4 tests, 4 pass.

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/tools/get_online_admissions_process.ts msstate-policies/tests/online/tool-get-online-admissions-process.test.ts
git commit -m "feat(online): get_online_admissions_process tool"
```

### Task 11.4: `find_online_info` tool

**Files:**
- Create: `msstate-policies/src/tools/find_online_info.ts`
- Create: `msstate-policies/tests/online/tool-find-online-info.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { find_online_info } from "../../src/tools/find_online_info.js";
import { setOnlineCorpus } from "../../src/online/corpus.js";
import { ONLINE_DISCLAIMER, MAX_QUERY_CHARS } from "../../src/online/types.js";
import type { OnlineCorpus } from "../../src/online/types.js";

const SAMPLE: OnlineCorpus = {
  builtAt: "x", source: "https://www.online.msstate.edu/",
  programs: [],
  admissions_process: { url: "x", central_contact: { name: "x", title: "x", email: null, phone: null }, shared_prelude: "", sections: { undergraduate: "", graduate: "", transfer: "", readmit: "", international: "" }, application_fee_tiers: [], external_apply_urls: [], retrieved_at: "x" },
  staff: [{ name: "Jane Doe", title: "Director", email: "jdoe@msstate.edu", phone: null, office: "Office of Online Education", url: "https://www.online.msstate.edu/staff", retrieved_at: "x" }],
  info_pages: [
    { slug: "state-authorization", title: "State Authorization", url: "https://www.online.msstate.edu/state-authorization", body_markdown: "MSU Online operates in many states but not California or Massachusetts.", retrieved_at: "x" },
    { slug: "military-assistance", title: "Military Assistance", url: "https://www.online.msstate.edu/military-assistance", body_markdown: "MSU offers tuition assistance for service members and veterans.", retrieved_at: "x" },
    { slug: "orientation", title: "Orientation", url: "https://www.online.msstate.edu/orientation", body_markdown: "Welcome to MSU Online orientation. Honorlock proctoring info is here.", retrieved_at: "x" },
    { slug: "faq", title: "FAQ", url: "https://www.online.msstate.edu/faq", body_markdown: "Frequently asked questions about MSU Online.", retrieved_at: "x" },
    { slug: "financial-matters", title: "Financial Matters", url: "https://www.online.msstate.edu/financial-matters", body_markdown: "Financial aid and billing for MSU Online students.", retrieved_at: "x" },
  ],
};

async function call(args: unknown) {
  const res = await find_online_info.handler(args);
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("find_online_info", () => {
  test("returns disclaimer + top-k matches", async () => {
    setOnlineCorpus(SAMPLE);
    const r = await call({ q: "state authorization" });
    assert.equal(r.disclaimer, ONLINE_DISCLAIMER);
    assert.ok(r.matches.length >= 1);
    assert.equal(r.matches[0].slug, "state-authorization");
  });
  test("scope filter limits to one slug", async () => {
    setOnlineCorpus(SAMPLE);
    const r = await call({ q: "MSU", scope: "orientation" });
    assert.ok(r.matches.every((m: { slug: string }) => m.slug === "orientation"));
  });
  test("scope=staff searches the staff doc", async () => {
    setOnlineCorpus(SAMPLE);
    const r = await call({ q: "Jane", scope: "staff" });
    assert.ok(r.matches.length >= 1);
    assert.equal(r.matches[0].slug, "staff");
  });
  test("rejects q longer than MAX_QUERY_CHARS", async () => {
    setOnlineCorpus(SAMPLE);
    const long = "x".repeat(MAX_QUERY_CHARS + 1);
    await assert.rejects(() => call({ q: long }));
  });
  test("rejects k > 10 via zod", async () => {
    setOnlineCorpus(SAMPLE);
    await assert.rejects(() => call({ q: "x", k: 20 }));
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd msstate-policies && npx tsx --test tests/online/tool-find-online-info.test.ts 2>&1 | tail -5
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

```typescript
// msstate-policies/src/tools/find_online_info.ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getOnlineCorpus } from "../online/corpus.js";
import { bm25SearchInfo } from "../online/search.js";
import { ONLINE_DISCLAIMER, MAX_QUERY_CHARS } from "../online/types.js";

const Input = z
  .object({
    q: z.string().min(1).max(MAX_QUERY_CHARS),
    k: z.number().int().min(1).max(10).optional(),
    scope: z
      .enum(["all", "state-authorization", "military-assistance", "orientation", "faq", "financial-matters", "staff"])
      .optional(),
  })
  .strict();

export const find_online_info = {
  name: "find_online_info",
  description:
    "BM25 search over MSU Online's support pages (state-authorization, military-assistance, orientation, faq, financial-matters) + the central staff directory rendered as a searchable doc. " +
    "Use when the question isn't about a specific program (use get_online_program) and isn't the general admissions process (use get_online_admissions_process). " +
    "`scope` lets you pre-filter to a single info-page slug when the category is known. The `staff` scope searches the central staff directory. " +
    "Returns matches with `slug`, `title`, `excerpt` (~300 chars verbatim from the body), `full_body` (entire body_markdown), `source_url`, and `bm25_score`. Every response carries the online disclaimer.",
  inputSchema: zodToJsonSchema(Input, { target: "openApi3" }),
  zodSchema: Input,
  async handler(rawInput: unknown) {
    const input = Input.parse(rawInput);
    const k = input.k ?? 3;
    const scope = input.scope ?? "all";
    const hits = bm25SearchInfo(input.q, k, scope);
    const corpus = getOnlineCorpus();
    const matches = hits.map((h) => {
      const body = h.row.body_markdown;
      // Excerpt: ~300 chars centered on the first hit-word match, or the head.
      const excerpt = body.length <= 300 ? body : body.slice(0, 300) + "…";
      return {
        slug: h.row.slug,
        title: h.row.title,
        excerpt,
        full_body: body,
        source_url: h.row.url,
        bm25_score: h.score,
      };
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            disclaimer: ONLINE_DISCLAIMER,
            matches,
            corpus_built_at: corpus?.builtAt ?? null,
          }, null, 2),
        },
      ],
    };
  },
};
```

- [ ] **Step 4: Run + commit**

```bash
cd msstate-policies && npx tsx --test tests/online/tool-find-online-info.test.ts 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: 5 tests, 5 pass.

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/tools/find_online_info.ts msstate-policies/tests/online/tool-find-online-info.test.ts
git commit -m "feat(online): find_online_info tool (BM25 over info pages + staff)"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 12 — Register 4 tools in src/index.ts + esbuild define + test glob

### Task 12.1: Wire the online module into the stdio server

**Files:**
- Modify: `msstate-policies/src/index.ts`
- Modify: `msstate-policies/build.mjs`
- Modify: `msstate-policies/package.json`

- [ ] **Step 1: Add imports + TOOLS entries in `src/index.ts`**

Open `msstate-policies/src/index.ts`. After the existing tuition import block, append:

```typescript
import { list_online_programs } from "./tools/list_online_programs.js";
import { get_online_program } from "./tools/get_online_program.js";
import { get_online_admissions_process } from "./tools/get_online_admissions_process.js";
import { find_online_info } from "./tools/find_online_info.js";
import { setOnlineCorpus } from "./online/corpus.js";
import type { OnlineCorpus } from "./online/types.js";
```

In the `TOOLS` array, append the 4 new tools BEFORE `health_check`:

```typescript
const TOOLS = [
  // ... existing entries ...
  list_msu_tuition_campuses,   // last v0.8.0 tuition tool
  list_online_programs,
  get_online_program,
  get_online_admissions_process,
  find_online_info,
  health_check,
] as const;
```

- [ ] **Step 2: Add esbuild-define for `__ONLINE_CORPUS__` + loader**

In `msstate-policies/src/index.ts`, after the existing `declare const __TUITION_CORPUS__:` line:

```typescript
declare const __ONLINE_CORPUS__: OnlineCorpus | undefined;
```

After the `loadBakedTuitionCorpus` function, add:

```typescript
function loadBakedOnlineCorpus(): void {
  if (typeof __ONLINE_CORPUS__ !== "undefined" && __ONLINE_CORPUS__) {
    setOnlineCorpus(__ONLINE_CORPUS__);
    log("info", "online corpus loaded", {
      programs: __ONLINE_CORPUS__.programs.length,
      staff: __ONLINE_CORPUS__.staff.length,
      info_pages: __ONLINE_CORPUS__.info_pages.length,
    });
  } else {
    log("warn", "no baked online corpus available; online tools will return empty results");
  }
}
```

Call it inside `main()`, alongside the other loaders:

```typescript
  loadBakedCourseCorpus();
  loadBakedEmergencyCorpus();
  loadBakedTuitionCorpus();
  loadBakedOnlineCorpus();
```

- [ ] **Step 3: Bake `__ONLINE_CORPUS__` in `build.mjs`**

Open `msstate-policies/build.mjs`. Extend the existing try/catch that reads `worker/corpus.json`:

```javascript
let courseCorpus = null;
let emergencyCorpus = null;
let tuitionCorpus = null;
let onlineCorpus = null;
try {
  const j = JSON.parse(readFileSync(workerCorpusPath, "utf8"));
  courseCorpus = j.courses ?? null;
  emergencyCorpus = j.emergency ?? null;
  tuitionCorpus = j.tuition ?? null;
  onlineCorpus = j.online_education ?? null;
} catch {
  // initial build before corpus.json exists
}
```

Update the esbuild `define` block:

```javascript
  define: {
    __COURSE_CORPUS__: JSON.stringify(courseCorpus),
    __EMERGENCY_CORPUS__: JSON.stringify(emergencyCorpus),
    __TUITION_CORPUS__: JSON.stringify(tuitionCorpus),
    __ONLINE_CORPUS__: JSON.stringify(onlineCorpus),
  },
```

- [ ] **Step 4: Extend the test glob in `msstate-policies/package.json`**

Change the `test` script to include `tests/online/*.test.ts`:

```json
"test": "tsx --test tests/*.test.ts tests/courses/*.test.ts tests/emergency/*.test.ts tests/tuition/*.test.ts tests/online/*.test.ts",
```

- [ ] **Step 5: Build + run all tests**

```bash
cd msstate-policies && npm run build 2>&1 | tail -3
head -2 dist/index.js
npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: build succeeds; banner reads `msstate-policies-mcp 0.9.0 ...` (still 0.9.0 — version bump comes in T21); test count grows by ~50 (all online module + tool tests) vs baseline 336. Final: ~386 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/index.ts msstate-policies/build.mjs msstate-policies/package.json msstate-policies/dist/index.js
git status --short
git commit -m "feat(online): register 4 tools, bake __ONLINE_CORPUS__ via esbuild"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 13 — Worker dispatch (~250 lines mirrored from tuition)

### Task 13.1: Add online block to `worker/src/index.ts`

**Files:**
- Modify: `worker/src/index.ts`

The Worker has no module boundary — types and helpers live inline. Mirror the tuition block (~lines 530–760 in the current worker) for online.

- [ ] **Step 1: Inspect the existing tuition block as template**

```bash
grep -nE 'tuition block|TUI_DOCS|TUITION:|case "get_msu_tuition' worker/src/index.ts | head -10
```

Find where the tuition block ends. The new online block goes right after it.

- [ ] **Step 2: Add the online types + helpers block**

After the closing of the tuition block in `worker/src/index.ts`, insert:

```typescript
// ---- online block ----------------------------------------------------------

type DegreeLevel = "bachelor" | "master" | "specialist" | "doctoral" | "certificate" | "endorsement";
type StudentType = "undergraduate" | "graduate" | "transfer" | "readmit" | "international";

interface OnlineContact {
  name: string;
  title: string;
  email: string | null;
  phone: string | null;
}
interface OnlineApplicationDeadline { term: string; date_text: string; }
interface OnlineEntranceExams { required: string[]; not_required: string[]; notes: string; }
interface OnlineProgramTuition {
  per_credit_usd: number | null;
  instructional_fee_per_credit_usd: number | null;
  application_fee_domestic_usd: number | null;
  application_fee_international_usd: number | null;
  raw_prose: string;
}
interface OnlineProgram {
  slug: string; name: string; degree_level: DegreeLevel; format: string;
  short_description: string; url: string;
  tuition: OnlineProgramTuition;
  contacts: OnlineContact[];
  application_deadlines: OnlineApplicationDeadline[];
  admission_requirements: string;
  entrance_exams: OnlineEntranceExams | null;
  accreditation: string | null;
  forms: { label: string; url: string }[];
  raw_sections: Record<string, string>;
  parse_warnings?: string[];
  retrieved_at: string;
}
interface OnlineAdmissionsProcess {
  url: string;
  central_contact: OnlineContact;
  shared_prelude: string;
  sections: Record<StudentType, string>;
  application_fee_tiers: { kind: string; usd: number }[];
  external_apply_urls: { kind: string; url: string }[];
  retrieved_at: string;
}
interface OnlineStaffEntry {
  name: string; title: string; email: string | null; phone: string | null;
  office: string; url: string; retrieved_at: string;
}
interface OnlineInfoPage {
  slug: string; title: string; url: string; body_markdown: string; retrieved_at: string;
}
interface OnlineCorpus {
  builtAt: string;
  source: string;
  programs: OnlineProgram[];
  admissions_process: OnlineAdmissionsProcess;
  staff: OnlineStaffEntry[];
  info_pages: OnlineInfoPage[];
}

const ONLINE: OnlineCorpus | null =
  (corpus as { online_education?: OnlineCorpus }).online_education ?? null;

const ONLINE_DISCLAIMER =
  "Contact info, application deadlines, tuition, and program details on online.msstate.edu can change between releases. Verify against the source URL before applying.";

// BM25 over info_pages + staff doc (mirrors src/online/search.ts)
const ONL_FIELD_WEIGHTS = { title: 3, body: 1 } as const;
const ONL_BM25_K1 = 1.2;
const ONL_BM25_B = 0.75;

interface OnlInfoDoc {
  row: OnlineInfoPage;
  titleTokens: string[];
  bodyTokens: string[];
  dl: number;
}

function flattenStaffAsDocWorker(staff: OnlineStaffEntry[]): OnlineInfoPage {
  const lines = staff.map((s) => `${s.name} — ${s.title}. ${s.email ?? ""} ${s.phone ?? ""} ${s.office}`);
  return {
    slug: "staff",
    title: "MSU Online Staff",
    url: "https://www.online.msstate.edu/staff",
    body_markdown: lines.join("\n"),
    retrieved_at: staff[0]?.retrieved_at ?? "1970-01-01T00:00:00.000Z",
  };
}

const ONL_INFO_DOCS: OnlInfoDoc[] = (() => {
  if (!ONLINE) return [];
  const docs: OnlineInfoPage[] = [...ONLINE.info_pages];
  if (ONLINE.staff.length > 0) docs.push(flattenStaffAsDocWorker(ONLINE.staff));
  return docs.map((row) => ({
    row,
    titleTokens: tokenize(row.title),
    bodyTokens: tokenize(row.body_markdown),
    dl: tokenize(row.title).length + tokenize(row.body_markdown).length,
  }));
})();

const ONL_INFO_DF = new Map<string, number>();
let ONL_INFO_AVGLEN = 0;
{
  let total = 0;
  for (const d of ONL_INFO_DOCS) {
    total += d.dl;
    const seen = new Set<string>();
    for (const t of [...d.titleTokens, ...d.bodyTokens]) {
      if (seen.has(t)) continue;
      seen.add(t);
      ONL_INFO_DF.set(t, (ONL_INFO_DF.get(t) ?? 0) + 1);
    }
  }
  ONL_INFO_AVGLEN = ONL_INFO_DOCS.length > 0 ? total / ONL_INFO_DOCS.length : 0;
}

function onlInfoIdf(t: string): number {
  const n = ONL_INFO_DOCS.length;
  const dfi = ONL_INFO_DF.get(t) ?? 0;
  if (dfi === 0 || n === 0) return 0;
  return Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
}

function onlInfoBm25(tf: number, dl: number, idfV: number): number {
  if (tf <= 0) return 0;
  const denom = tf + ONL_BM25_K1 * (1 - ONL_BM25_B + (ONL_BM25_B * dl) / (ONL_INFO_AVGLEN || 1));
  return idfV * ((tf * (ONL_BM25_K1 + 1)) / denom);
}

type OnlineScope =
  | "all" | "state-authorization" | "military-assistance" | "orientation" | "faq" | "financial-matters" | "staff";

function onlSearchInfo(query: string, k: number, scope: OnlineScope): { row: OnlineInfoPage; score: number }[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const docs = scope === "all" ? ONL_INFO_DOCS : ONL_INFO_DOCS.filter((d) => d.row.slug === scope);
  const out: { row: OnlineInfoPage; score: number }[] = [];
  for (const d of docs) {
    let s = 0;
    for (const q of qTokens) {
      const idfQ = onlInfoIdf(q);
      if (idfQ === 0) continue;
      s += ONL_FIELD_WEIGHTS.title * onlInfoBm25(countOf(q, d.titleTokens), d.dl, idfQ);
      s += ONL_FIELD_WEIGHTS.body  * onlInfoBm25(countOf(q, d.bodyTokens),  d.dl, idfQ);
    }
    if (s > 0) out.push({ row: d.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, Math.min(k, out.length)));
}

// Filter for list_online_programs
function onlFilterPrograms(req: { level?: DegreeLevel; subject_keyword?: string; limit?: number; offset?: number }) {
  const programs = ONLINE?.programs ?? [];
  let filtered = programs;
  if (req.level) filtered = filtered.filter((p) => p.degree_level === req.level);
  if (req.subject_keyword && req.subject_keyword.trim().length > 0) {
    const k = req.subject_keyword.trim().toLowerCase();
    filtered = filtered.filter((p) =>
      p.name.toLowerCase().includes(k) || p.short_description.toLowerCase().includes(k));
  }
  const limit = Math.max(1, Math.min(req.limit ?? 50, 200));
  const offset = Math.max(0, req.offset ?? 0);
  return {
    matches: filtered.slice(offset, offset + limit).map((p) => ({
      slug: p.slug, name: p.name, degree_level: p.degree_level,
      short_description: p.short_description, url: p.url,
    })),
    total: programs.length,
    filtered_total: filtered.length,
  };
}

// Fuzzy resolver for get_online_program(name_query)
function onlFuzzyResolveProgram(query: string): { matched: OnlineProgram | null; did_you_mean: Array<{ slug: string; name: string }> } {
  const programs = ONLINE?.programs ?? [];
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return { matched: null, did_you_mean: [] };
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
  if (scored.length === 0) return { matched: null, did_you_mean: [] };
  return {
    matched: scored[0].p,
    did_you_mean: scored.slice(1, 3).map((x) => ({ slug: x.p.slug, name: x.p.name })),
  };
}
```

Note: `tokenize` and `countOf` are reused from the existing emergency/tuition blocks. Do NOT redefine.

- [ ] **Step 3: Register 4 online tools in `tools/list`**

Find the existing `tools` array in the `tools/list` handler. Add these 4 entries BEFORE the `health_check` entry:

```typescript
  {
    name: "list_online_programs",
    description: "Browse / filter MSU's online programs from online.msstate.edu. Returns lightweight rows {slug, name, degree_level, short_description, url}; for full details follow up with get_online_program. `level` filters by degree level. `subject_keyword` is case-insensitive substring on name + short_description. `limit` (default 50, max 200) + `offset` paginate. Every response carries the online disclaimer.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["bachelor","master","specialist","doctoral","certificate","endorsement"] },
        subject_keyword: { type: "string", description: "Substring match, max 4096 chars" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "get_online_program",
    description: "Fetch one online program's full record. Provide `slug` (e.g. 'mba', 'bsee') for direct lookup, OR `name_query` (e.g. 'online psychology bachelor') for fuzzy match. Exactly one required. When name_query routes via BM25, top-1 is in matched and next-2 in did_you_mean. Every response carries the online disclaimer.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "URL-tail slug, max 4096 chars" },
        name_query: { type: "string", description: "Fuzzy name query, max 4096 chars" },
      },
    },
  },
  {
    name: "get_online_admissions_process",
    description: "Return MSU Online's admissions process sectioned by student type (undergraduate / graduate / transfer / readmit / international). Pass `student_type` for one section; omit for all five. Always returns shared_prelude + central_contact + application_fee_tiers + external_apply_urls. Carries the online disclaimer.",
    inputSchema: {
      type: "object",
      properties: {
        student_type: { type: "string", enum: ["undergraduate","graduate","transfer","readmit","international"] },
      },
    },
  },
  {
    name: "find_online_info",
    description: "BM25 search over MSU Online's support pages (state-authorization, military-assistance, orientation, faq, financial-matters) + the central staff directory. Use when the question isn't about a specific program or the general admissions process. `scope` pre-filters to one slug. Top-k matches with verbatim excerpt + full_body + source_url. Carries the online disclaimer.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Free-text query, max 4096 chars" },
        k: { type: "integer", minimum: 1, maximum: 10 },
        scope: { type: "string", enum: ["all","state-authorization","military-assistance","orientation","faq","financial-matters","staff"] },
      },
      required: ["q"],
    },
  },
```

- [ ] **Step 4: Add the 4 `tools/call` case branches**

Find the `tools/call` switch. After the last tuition case (`case "list_msu_tuition_campuses"`) and before `case "health_check"`, add:

```typescript
    case "list_online_programs": {
      const a = args as Record<string, unknown>;
      const VALID_LEVELS = ["bachelor","master","specialist","doctoral","certificate","endorsement"];
      const level = a.level !== undefined ? String(a.level) : undefined;
      if (level !== undefined && !VALID_LEVELS.includes(level)) {
        return errorContent("level must be one of: " + VALID_LEVELS.join(", "));
      }
      const subject_keyword = typeof a.subject_keyword === "string" ? a.subject_keyword : undefined;
      if (subject_keyword !== undefined && subject_keyword.length > MAX_QUERY_CHARS) return tooLong("subject_keyword", subject_keyword);
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return errorContent("limit must be an integer 1-200.");
      const offset = typeof a.offset === "number" ? a.offset : undefined;
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) return errorContent("offset must be a non-negative integer.");
      const r = onlFilterPrograms({ level: level as DegreeLevel | undefined, subject_keyword, limit, offset });
      return jsonContent({
        disclaimer: ONLINE_DISCLAIMER,
        matches: r.matches,
        total: r.total,
        filtered_total: r.filtered_total,
        corpus_built_at: ONLINE?.builtAt ?? null,
      });
    }
    case "get_online_program": {
      const a = args as Record<string, unknown>;
      const slug = typeof a.slug === "string" ? a.slug : undefined;
      const name_query = typeof a.name_query === "string" ? a.name_query : undefined;
      if ((slug && name_query) || (!slug && !name_query)) {
        return errorContent("Exactly one of slug or name_query is required.");
      }
      if (slug && slug.length > MAX_QUERY_CHARS) return tooLong("slug", slug);
      if (name_query && name_query.length > MAX_QUERY_CHARS) return tooLong("name_query", name_query);
      let matched: OnlineProgram | null = null;
      let did_you_mean: Array<{ slug: string; name: string }> = [];
      let not_found_reason: string | null = null;
      if (slug) {
        matched = (ONLINE?.programs ?? []).find((p) => p.slug === slug) ?? null;
        if (!matched) not_found_reason = `No program with slug '${slug}'. Try list_online_programs to see valid slugs.`;
      } else if (name_query) {
        const r = onlFuzzyResolveProgram(name_query);
        matched = r.matched;
        did_you_mean = r.did_you_mean;
        if (!matched) not_found_reason = `No program matched '${name_query}'. Try list_online_programs(subject_keyword=…).`;
      }
      return jsonContent({
        disclaimer: ONLINE_DISCLAIMER,
        matched,
        did_you_mean,
        not_found_reason,
        corpus_built_at: ONLINE?.builtAt ?? null,
      });
    }
    case "get_online_admissions_process": {
      const a = args as Record<string, unknown>;
      const VALID_TYPES = ["undergraduate","graduate","transfer","readmit","international"];
      const student_type = a.student_type !== undefined ? String(a.student_type) : undefined;
      if (student_type !== undefined && !VALID_TYPES.includes(student_type)) {
        return errorContent("student_type must be one of: " + VALID_TYPES.join(", "));
      }
      const ap = ONLINE?.admissions_process;
      if (!ap) {
        return jsonContent({
          disclaimer: ONLINE_DISCLAIMER,
          shared_prelude: "",
          sections: {},
          central_contact: { name: "", title: "", email: null, phone: null },
          application_fee_tiers: [],
          external_apply_urls: [],
          source_url: "https://www.online.msstate.edu/admissions-process",
          not_found_reason: "Online admissions process is not loaded in the corpus.",
          corpus_built_at: ONLINE?.builtAt ?? null,
        });
      }
      const sections = student_type ? { [student_type]: ap.sections[student_type as StudentType] } : ap.sections;
      return jsonContent({
        disclaimer: ONLINE_DISCLAIMER,
        shared_prelude: ap.shared_prelude,
        sections,
        central_contact: ap.central_contact,
        application_fee_tiers: ap.application_fee_tiers,
        external_apply_urls: ap.external_apply_urls,
        source_url: ap.url,
        corpus_built_at: ONLINE?.builtAt ?? null,
      });
    }
    case "find_online_info": {
      const a = args as Record<string, unknown>;
      const q = String(a.q ?? "");
      if (q.length === 0) return errorContent("q is required.");
      if (q.length > MAX_QUERY_CHARS) return tooLong("q", q);
      const k = typeof a.k === "number" ? a.k : 3;
      if (!Number.isInteger(k) || k < 1 || k > 10) return errorContent("k must be an integer 1-10.");
      const VALID_SCOPES = ["all","state-authorization","military-assistance","orientation","faq","financial-matters","staff"];
      const scope = a.scope !== undefined ? String(a.scope) : "all";
      if (!VALID_SCOPES.includes(scope)) return errorContent("scope must be one of: " + VALID_SCOPES.join(", "));
      const hits = onlSearchInfo(q, k, scope as OnlineScope);
      const matches = hits.map((h) => ({
        slug: h.row.slug,
        title: h.row.title,
        excerpt: h.row.body_markdown.length <= 300 ? h.row.body_markdown : h.row.body_markdown.slice(0, 300) + "…",
        full_body: h.row.body_markdown,
        source_url: h.row.url,
        bm25_score: h.score,
      }));
      return jsonContent({
        disclaimer: ONLINE_DISCLAIMER,
        matches,
        corpus_built_at: ONLINE?.builtAt ?? null,
      });
    }
```

- [ ] **Step 5: Add online counts to `health_check`**

In `worker/src/index.ts`, find the `case "health_check"` branch. Add to its returned JSON:

```typescript
        online_program_count: ONLINE?.programs.length ?? 0,
        online_info_page_count: ONLINE?.info_pages.length ?? 0,
        online_staff_count: ONLINE?.staff.length ?? 0,
```

- [ ] **Step 6: Typecheck the Worker**

```bash
cd worker && npx --no-install tsc --noEmit 2>&1 | tail -5
```

Expected: clean (no output).

- [ ] **Step 7: Commit**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add worker/src/index.ts
git commit -m "feat(worker): dispatch 4 online tools + BM25 info search + fuzzy program resolver"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 14 — Build pipeline integration

### Task 14.1: Add `scrapeOnlineViaSubprocess` to `build-worker-corpus.mjs`

**Files:**
- Modify: `scripts/build-worker-corpus.mjs`

- [ ] **Step 1: Inspect existing pattern**

```bash
grep -n "scrapeTuitionViaSubprocess\|out.tuition" scripts/build-worker-corpus.mjs | head -5
```

The tuition step is the closest template. The online step goes right after the tuition `out.tuition = { ... }` assignment.

- [ ] **Step 2: Add the function**

After `scrapeTuitionViaSubprocess()`'s definition, append:

```javascript
async function scrapeOnlineViaSubprocess() {
  const { execFileSync } = await import("node:child_process");
  console.error("[build-worker-corpus] scraping online.msstate.edu...");
  let raw;
  try {
    raw = execFileSync(
      "npx",
      ["--yes", "tsx", "scripts/_scrape-online.ts"],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"], maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    throw new Error(
      `online scrape subprocess failed (${err.message ?? err}) — refusing to ship a poisoned online corpus`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(
      "online scrape subprocess produced unparseable JSON — refusing to ship a poisoned online corpus",
    );
  }
  if (!parsed || !Array.isArray(parsed.programs) || !parsed.admissions_process
      || !Array.isArray(parsed.staff) || !Array.isArray(parsed.info_pages)) {
    throw new Error(
      "online scrape: malformed payload — refusing to ship a poisoned online corpus",
    );
  }
  if (parsed.anyError) {
    const failed = Object.entries(parsed.per_source ?? {})
      .filter(([, info]) => !info.ok)
      .map(([k, info]) => `${k}: ${info.error}`).join("; ");
    throw new Error(
      `online scrape: per-source failure (${failed}) — refusing to ship a poisoned online corpus`,
    );
  }
  if (parsed.programs.length < 100) {
    throw new Error(
      `online scrape: only ${parsed.programs.length} programs (< 100) — refusing to ship a poisoned online corpus`,
    );
  }
  const sectionCount = Object.values(parsed.admissions_process.sections ?? {}).filter((s) => typeof s === "string" && s.length > 0).length;
  if (sectionCount < 5) {
    throw new Error(
      `online scrape: only ${sectionCount} admissions sections (< 5) — refusing to ship a poisoned online corpus`,
    );
  }
  const ce = parsed.admissions_process.central_contact?.email ?? "";
  if (!/@(online\.)?msstate\.edu$/.test(ce)) {
    throw new Error(
      `online scrape: central_contact.email='${ce}' not on msstate.edu — refusing to ship a poisoned online corpus`,
    );
  }
  if (parsed.staff.length < 1) {
    throw new Error(
      "online scrape: 0 staff entries — refusing to ship a poisoned online corpus",
    );
  }
  if (parsed.info_pages.length < 5) {
    throw new Error(
      `online scrape: only ${parsed.info_pages.length} info pages (< 5) — refusing to ship a poisoned online corpus`,
    );
  }
  for (const ip of parsed.info_pages) {
    if ((ip.body_markdown?.length ?? 0) < 200) {
      throw new Error(
        `online scrape: info page ${ip.slug} body too short (${ip.body_markdown?.length ?? 0} chars < 200) — refusing to ship a poisoned online corpus`,
      );
    }
  }
  const warningCount = parsed.programs.filter((p) => (p.parse_warnings ?? []).length > 0).length;
  if (warningCount > 10) {
    throw new Error(
      `online scrape: ${warningCount} programs have parse_warnings (> 10) — refusing to ship a poisoned online corpus`,
    );
  }
  console.error(
    `[build-worker-corpus]   online: ${parsed.programs.length} programs, ${parsed.staff.length} staff, ${parsed.info_pages.length} info pages (${warningCount} programs with parse_warnings)`,
  );
  return parsed;
}
```

- [ ] **Step 3: Wire `out.online_education` into `main()`**

After the existing tuition block in `main()`:

```javascript
  const tuitionPayload = await scrapeTuitionViaSubprocess();
  out.tuition = {
    builtAt,
    source: "https://www.controller.msstate.edu/accountservices/tuition",
    rate_rows: tuitionPayload.rate_rows,
    fee_rows: tuitionPayload.fee_rows,
    faq_rows: tuitionPayload.faq_rows,
    campuses: tuitionPayload.campuses,
  };
```

Add (right after):

```javascript
  const onlinePayload = await scrapeOnlineViaSubprocess();
  out.online_education = {
    builtAt,
    source: "https://www.online.msstate.edu/",
    programs: onlinePayload.programs,
    admissions_process: onlinePayload.admissions_process,
    staff: onlinePayload.staff,
    info_pages: onlinePayload.info_pages,
  };
```

- [ ] **Step 4: Verify abort-string count grew by 8+**

```bash
grep -c "refusing to ship a poisoned online corpus" scripts/build-worker-corpus.mjs
```

Expected: ≥ 8 (the 8 abort sites + the subprocess-failure catch + the anyError catch).

- [ ] **Step 5: Syntax check**

```bash
node --check scripts/build-worker-corpus.mjs 2>&1 | head -5
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add scripts/build-worker-corpus.mjs
git commit -m "build(online): scrapeOnlineViaSubprocess + 8+ poison-corpus abort sites"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 15 — Update server-side `instructions` (6th routing rule)

### Task 15.1: Add the online routing rule to the InitializeResult.instructions string

**Files:**
- Modify: `msstate-policies/src/index.ts`
- Modify: `worker/src/index.ts`

Both surfaces hold the same `SERVER_INSTRUCTIONS` constant (kept in sync per the v0.8.0 design). Add a 6th rule.

- [ ] **Step 1: Find the existing constant in `msstate-policies/src/index.ts`**

```bash
grep -n "SERVER_INSTRUCTIONS\|routing rules\|Routing rules" msstate-policies/src/index.ts | head -5
```

Locate the multi-line template-string constant and the section listing the 5 routing rules.

- [ ] **Step 2: Insert the 6th rule**

Add this rule AFTER the 5th rule (tuition) and BEFORE the closing of the routing-rules section, in both `msstate-policies/src/index.ts` and `worker/src/index.ts`:

```
6. Online-program / online-admissions / online-student-services questions ("does MSU have an online MBA?", "how do I apply to MSU online?", "who's the advisor for the online psychology program?", "what's the application deadline for the online MS in Cybersecurity?", "does MSU online operate in my state?", "military assistance for MSU online") → list_online_programs / get_online_program / get_online_admissions_process / find_online_info, picked by question shape. Distinction from policies/courses/tuition: the online module covers MSU's ONLINE program offerings via online.msstate.edu — distinct from the broader policy/course/tuition corpus. Online-specific tuition rates from controller.msstate.edu stay under get_msu_tuition_rate.
```

(In the template-string, this should be one paragraph — the JSON-RPC client receives it as a single newline-separated string.)

- [ ] **Step 3: Build + sanity-check both surfaces**

```bash
cd msstate-policies && npm run build 2>&1 | tail -3
cd ../worker && npx --no-install tsc --noEmit 2>&1 | tail -3
```

Expected: build clean, worker typecheck clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/src/index.ts worker/src/index.ts msstate-policies/dist/index.js
git commit -m "feat(server): add online module routing rule to InitializeResult.instructions"
```

---

## Stage 16 — Security checks ONL1–ONL5

### Task 16.1: Add 5 checks to `tools/security-checklist.sh`

**Files:**
- Modify: `tools/security-checklist.sh`

- [ ] **Step 1: Append the ONL block at the end of the file (before the final score echo)**

Following the same pattern as TUI1-TUI5, append:

```bash
# =============================================================================
# Online module checks (ONL1-ONL5, added 2026-05-13). +12 pts total.
# =============================================================================

# ONL1: All https:// URLs inside msstate-policies/src/online/ stay on *.msstate.edu.
ONL_NON_MSU=$(grep -rE 'https://[^"'"'"'[:space:])]+' msstate-policies/src/online 2>/dev/null \
  | grep -vE 'https://[^/]*msstate\.edu' \
  | wc -l | tr -d ' ')
if [ "$ONL_NON_MSU" = "0" ]; then
  score=$((score + 3))
  note "PASS" "ONL1 all online-module URLs stay on msstate.edu" 3
else
  note "FAIL" "ONL1 found $ONL_NON_MSU non-msstate.edu URLs in src/online/" 3
fi

# ONL2: ONLINE_ROOTS + SUPPORT_PAGE_SLUGS frozen allowlists present.
ONL2_OK=0
if grep -qE 'export const ONLINE_ROOTS.*=.*Object\.freeze\(' msstate-policies/src/online/types.ts 2>/dev/null \
  && grep -qE 'export const SUPPORT_PAGE_SLUGS.*=.*Object\.freeze\(' msstate-policies/src/online/types.ts 2>/dev/null; then
  ONL2_OK=1
fi
if [ "$ONL2_OK" = "1" ]; then
  score=$((score + 2))
  note "PASS" "ONL2 ONLINE_ROOTS + SUPPORT_PAGE_SLUGS frozen allowlists present" 2
else
  note "FAIL" "ONL2 ONLINE_ROOTS or SUPPORT_PAGE_SLUGS missing or not frozen" 2
fi

# ONL3: Worker length-caps q, subject_keyword, name_query before parse.
ONL3_OK=1
for case_name in "list_online_programs" "get_online_program" "find_online_info"; do
  if ! grep -nA 8 "case \"$case_name\":" worker/src/index.ts \
       | grep -q "MAX_QUERY_CHARS"; then
    ONL3_OK=0
  fi
done
if [ "$ONL3_OK" = "1" ]; then
  score=$((score + 3))
  note "PASS" "ONL3 Worker length-caps string inputs on online tools" 3
else
  note "FAIL" "ONL3 Worker missing length-cap on at least one online tool" 3
fi

# ONL4: Build aborts with canonical string on poisoned online corpus.
ONL4_COUNT=$(grep -c "refusing to ship a poisoned online corpus" scripts/build-worker-corpus.mjs 2>/dev/null | tr -d ' ')
ONL4_COUNT=${ONL4_COUNT:-0}
if [ "$ONL4_COUNT" -ge "8" ] 2>/dev/null; then
  score=$((score + 2))
  note "PASS" "ONL4 build aborts on poisoned online corpus ($ONL4_COUNT abort sites)" 2
else
  note "FAIL" "ONL4 only $ONL4_COUNT 'refusing to ship a poisoned online corpus' sites (need >= 8)" 2
fi

# ONL5: ONLINE_DISCLAIMER present in types.ts AND referenced in all 4 online tool files.
ONL5_OK=1
if ! grep -q 'ONLINE_DISCLAIMER' msstate-policies/src/online/types.ts 2>/dev/null; then
  ONL5_OK=0
fi
for f in list_online_programs get_online_program get_online_admissions_process find_online_info; do
  if ! grep -q 'ONLINE_DISCLAIMER' "msstate-policies/src/tools/${f}.ts" 2>/dev/null; then
    ONL5_OK=0
  fi
done
if [ "$ONL5_OK" = "1" ]; then
  score=$((score + 2))
  note "PASS" "ONL5 ONLINE_DISCLAIMER present in types.ts + 4 tool files" 2
else
  note "FAIL" "ONL5 ONLINE_DISCLAIMER missing from types.ts or one of the tool files" 2
fi
```

- [ ] **Step 2: Run + verify**

```bash
bash tools/security-checklist.sh 2>&1 | grep -E "^\s+\[(PASS|FAIL)\] ONL|^[0-9]+$" | head -10
bash tools/security-checklist.sh 2>&1 | tail -1
```

Expected: 5 ONL PASS lines. Final macOS score: 257 (the existing SYN4/SYN6 wc-l artifacts still subtract 12). Linux CI: 269.

- [ ] **Step 3: Commit**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add tools/security-checklist.sh
git commit -m "chore(security): add ONL1-ONL5 online checks (+12 pts, 257 -> 269 Linux CI)"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 17 — Eval set + runner

### Task 17.1: Create `online.jsonl` + add `--suite=online` to run-eval.mjs

**Files:**
- Create: `msstate-policies/evals/online.jsonl`
- Modify: `scripts/run-eval.mjs`

- [ ] **Step 1: Inspect existing eval shape**

```bash
head -3 msstate-policies/evals/courses.jsonl
head -3 msstate-policies/evals/emergency.jsonl 2>&1 || true
grep -nE 'suite === "tuition"|case .courses.|suite === "online"' scripts/run-eval.mjs | head -10
```

Note the JSONL format and how existing suites are dispatched. The tuition suite is the closest template.

- [ ] **Step 2: Pull actual values from the live corpus for eval expectations**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
jq -r '.online_education.programs[] | select(.slug=="mba") | {name, contact_count: (.contacts|length), deadline_count: (.application_deadlines|length), per_credit: .tuition.per_credit_usd}' worker/corpus.json
jq -r '.online_education.programs | map(select(.degree_level == "doctoral")) | length' worker/corpus.json   # for the "≥ 15 doctoral" check
jq -r '.online_education.programs | map(select(.degree_level == "bachelor")) | length' worker/corpus.json   # for the "≥ 25 bachelor" check
jq '.online_education.admissions_process.central_contact' worker/corpus.json
```

The corpus won't yet have an `online_education` block until the live rebuild in Stage 18. For now, use the design values:
- `doctoral` count expected ≥ 15
- `bachelor` count expected ≥ 25
- `central_contact.email` == `ask@online.msstate.edu`

If MSU's site has changed these (e.g., now 14 doctoral programs), the regression will catch it during the live rebuild.

- [ ] **Step 3: Write the eval set**

```bash
cat > msstate-policies/evals/online.jsonl <<'EOF'
{"kind":"program_slug_lookup","desc":"MBA by slug","args":{"name":"get_online_program","arguments":{"slug":"mba"}},"expect":{"matched_name_contains":"Business Administration","matched_contacts_min":1}}
{"kind":"program_slug_lookup","desc":"BSEE by slug","args":{"name":"get_online_program","arguments":{"slug":"bsee"}},"expect":{"matched_degree_level":"bachelor","matched_contacts_msstate_email":true}}
{"kind":"program_name_query","desc":"psychology bachelor by name","args":{"name":"get_online_program","arguments":{"name_query":"online psychology bachelor"}},"expect":{"matched_slug":"psychology"}}
{"kind":"program_deadlines","desc":"MBA has August deadline","args":{"name":"get_online_program","arguments":{"slug":"mba"}},"expect":{"deadlines_contain_term_date":["Fall","August"]}}
{"kind":"program_certificate","desc":"addiction counseling certificate","args":{"name":"get_online_program","arguments":{"slug":"adcn"}},"expect":{"matched_degree_level":"certificate"}}
{"kind":"program_doctoral","desc":"PhD CSE","args":{"name":"get_online_program","arguments":{"slug":"phcse"}},"expect":{"matched_degree_level":"doctoral"}}
{"kind":"program_slug_lookup","desc":"data science master","args":{"name":"get_online_program","arguments":{"slug":"msdata"}},"expect":{"matched_degree_level":"master"}}
{"kind":"program_unknown","desc":"unknown slug returns null + reason","args":{"name":"get_online_program","arguments":{"slug":"this-slug-does-not-exist"}},"expect":{"matched_null":true,"not_found_reason_nonempty":true}}
{"kind":"list_by_level","desc":"doctoral count ≥ 15","args":{"name":"list_online_programs","arguments":{"level":"doctoral"}},"expect":{"filtered_total_min":15}}
{"kind":"list_by_level","desc":"bachelor count ≥ 25","args":{"name":"list_online_programs","arguments":{"level":"bachelor"}},"expect":{"filtered_total_min":25}}
{"kind":"list_by_keyword","desc":"engineering programs","args":{"name":"list_online_programs","arguments":{"subject_keyword":"engineering"}},"expect":{"matches_min":3}}
{"kind":"list_total","desc":"total ≥ 100","args":{"name":"list_online_programs","arguments":{}},"expect":{"total_min":100}}
{"kind":"list_paging","desc":"limit=5 returns at most 5","args":{"name":"list_online_programs","arguments":{"limit":5}},"expect":{"matches_max":5}}
{"kind":"list_empty","desc":"keyword that matches nothing","args":{"name":"list_online_programs","arguments":{"subject_keyword":"football schedule game day"}},"expect":{"matches_eq":0}}
{"kind":"admissions_ug","desc":"undergrad section mentions transcripts","args":{"name":"get_online_admissions_process","arguments":{"student_type":"undergraduate"}},"expect":{"section_undergraduate_contains_any":["test-optional","transcripts","high school"]}}
{"kind":"admissions_intl","desc":"international section mentions TOEFL/IELTS","args":{"name":"get_online_admissions_process","arguments":{"student_type":"international"}},"expect":{"section_international_contains_any":["TOEFL","IELTS"]}}
{"kind":"admissions_all","desc":"no filter returns all 5 sections","args":{"name":"get_online_admissions_process","arguments":{}},"expect":{"all_5_sections_present":true}}
{"kind":"admissions_contact","desc":"central email is ask@online.msstate.edu","args":{"name":"get_online_admissions_process","arguments":{}},"expect":{"central_email_eq":"ask@online.msstate.edu"}}
{"kind":"admissions_apply_urls","desc":"apply URLs include both apply + grad","args":{"name":"get_online_admissions_process","arguments":{}},"expect":{"external_apply_contains_substrs":["apply.msstate.edu","grad.msstate.edu"]}}
{"kind":"info_state_auth","desc":"state authorization scope","args":{"name":"find_online_info","arguments":{"q":"does MSU online operate in my state","scope":"state-authorization"}},"expect":{"top_slug":"state-authorization"}}
{"kind":"info_military","desc":"military assistance","args":{"name":"find_online_info","arguments":{"q":"military tuition assistance"}},"expect":{"any_slug":"military-assistance"}}
{"kind":"info_honorlock","desc":"Honorlock proctoring","args":{"name":"find_online_info","arguments":{"q":"Honorlock proctoring"}},"expect":{"any_full_body_contains":"Honorlock"}}
{"kind":"info_orientation","desc":"orientation top scope","args":{"name":"find_online_info","arguments":{"q":"orientation","scope":"orientation"}},"expect":{"top_slug":"orientation"}}
{"kind":"info_staff","desc":"staff scope is searchable","args":{"name":"find_online_info","arguments":{"q":"Office of Online Education","scope":"staff"}},"expect":{"top_slug":"staff"}}
{"kind":"info_financial","desc":"financial matters","args":{"name":"find_online_info","arguments":{"q":"financial aid billing","scope":"financial-matters"}},"expect":{"top_slug":"financial-matters"}}
{"kind":"info_faq","desc":"FAQ scope","args":{"name":"find_online_info","arguments":{"q":"frequently asked","scope":"faq"}},"expect":{"top_slug":"faq"}}
{"kind":"info_no_match","desc":"off-topic — Ole Miss","args":{"name":"find_online_info","arguments":{"q":"ole miss admission application"}},"expect":{"matches_eq":0}}
{"kind":"adversarial_program","desc":"non-existent program name","args":{"name":"get_online_program","arguments":{"name_query":"program that definitely does not exist xyz"}},"expect":{"matched_null":true}}
{"kind":"adversarial_keyword","desc":"football subject keyword","args":{"name":"list_online_programs","arguments":{"subject_keyword":"football team"}},"expect":{"matches_eq":0}}
{"kind":"adversarial_off_topic","desc":"weather query","args":{"name":"find_online_info","arguments":{"q":"weather forecast today"}},"expect":{"matches_eq":0}}
EOF
wc -l msstate-policies/evals/online.jsonl
```

Expected: 30 lines. Each line is one question.

- [ ] **Step 4: Add `--suite=online` branch to `scripts/run-eval.mjs`**

Find the existing `--suite=tuition` branch (closest template). After its closing brace, before any default-case logic, add a parallel `--suite=online` branch:

```javascript
if (suite === "online") {
  const { spawn: spawnOnl } = await import("node:child_process");
  const onlinePath = resolve(evalDir, "online.jsonl");
  if (!existsSync(onlinePath)) {
    console.error(`run-eval: ${onlinePath} not found`);
    process.exit(1);
  }
  const rows = readFileSync(onlinePath, "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).map((l) => JSON.parse(l));

  class OnlMcp {
    constructor() {
      this.proc = spawnOnl("node", [distPath], { stdio: ["pipe", "pipe", "inherit"] });
      this.buf = ""; this.pending = new Map(); this.nextId = 1;
      this.proc.stdout.on("data", (chunk) => {
        this.buf += chunk.toString();
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id && this.pending.has(msg.id)) {
              const { r, j } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) j(new Error(msg.error.message ?? "MCP error"));
              else r(msg.result);
            }
          } catch { /* ignore */ }
        }
      });
    }
    call(method, params) {
      const id = this.nextId++;
      return new Promise((r, j) => {
        this.pending.set(id, { r, j });
        this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
    async init() {
      await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "run-eval-online", version: "0.1.0" } });
    }
    callTool(args) { return this.call("tools/call", args); }
    close() { this.proc.kill(); }
  }

  const mcp = new OnlMcp();
  await mcp.init();
  let pass = 0;
  const failures = [];
  for (const q of rows) {
    let res;
    try {
      res = await mcp.callTool(q.args);
    } catch (err) {
      failures.push({ q, got: `error: ${err.message}` });
      continue;
    }
    const text = res?.content?.[0]?.text ?? "";
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
    let ok = false;
    const e = q.expect ?? {};
    if (q.kind.startsWith("program_") || q.kind === "adversarial_program") {
      const m = parsed?.matched;
      if (e.matched_null) ok = m === null || m === undefined;
      else if (e.matched_slug) ok = m?.slug === e.matched_slug;
      else if (e.matched_degree_level) ok = m?.degree_level === e.matched_degree_level;
      else if (e.matched_name_contains) ok = typeof m?.name === "string" && m.name.toLowerCase().includes(e.matched_name_contains.toLowerCase());
      else if (e.matched_contacts_min !== undefined) ok = Array.isArray(m?.contacts) && m.contacts.length >= e.matched_contacts_min;
      else if (e.matched_contacts_msstate_email) ok = Array.isArray(m?.contacts) && m.contacts.some((c) => c.email && /@(\w+\.)?msstate\.edu$/.test(c.email));
      else if (e.deadlines_contain_term_date) ok = Array.isArray(m?.application_deadlines) && m.application_deadlines.some((d) => d.term === e.deadlines_contain_term_date[0] && new RegExp(e.deadlines_contain_term_date[1], "i").test(d.date_text));
      else if (e.not_found_reason_nonempty) ok = typeof parsed?.not_found_reason === "string" && parsed.not_found_reason.length > 0;
    } else if (q.kind.startsWith("list_") || q.kind === "adversarial_keyword") {
      const matches = parsed?.matches ?? [];
      const t = parsed?.total ?? 0; const ft = parsed?.filtered_total ?? 0;
      if (e.filtered_total_min !== undefined) ok = ft >= e.filtered_total_min;
      else if (e.total_min !== undefined) ok = t >= e.total_min;
      else if (e.matches_min !== undefined) ok = matches.length >= e.matches_min;
      else if (e.matches_max !== undefined) ok = matches.length <= e.matches_max;
      else if (e.matches_eq !== undefined) ok = matches.length === e.matches_eq;
    } else if (q.kind.startsWith("admissions_")) {
      const sec = parsed?.sections ?? {};
      if (e.section_undergraduate_contains_any) {
        const body = (sec.undergraduate ?? "").toLowerCase();
        ok = e.section_undergraduate_contains_any.some((s) => body.includes(s.toLowerCase()));
      } else if (e.section_international_contains_any) {
        const body = (sec.international ?? "").toLowerCase();
        ok = e.section_international_contains_any.some((s) => body.includes(s.toLowerCase()));
      } else if (e.all_5_sections_present) {
        ok = ["undergraduate","graduate","transfer","readmit","international"].every((st) => typeof sec[st] === "string" && sec[st].length > 0);
      } else if (e.central_email_eq) {
        ok = parsed?.central_contact?.email === e.central_email_eq;
      } else if (e.external_apply_contains_substrs) {
        const urls = (parsed?.external_apply_urls ?? []).map((u) => u.url ?? "");
        ok = e.external_apply_contains_substrs.every((s) => urls.some((u) => u.includes(s)));
      }
    } else if (q.kind.startsWith("info_") || q.kind === "adversarial_off_topic") {
      const matches = parsed?.matches ?? [];
      if (e.top_slug) ok = matches[0]?.slug === e.top_slug;
      else if (e.any_slug) ok = matches.some((m) => m.slug === e.any_slug);
      else if (e.any_full_body_contains) ok = matches.some((m) => (m.full_body ?? "").includes(e.any_full_body_contains));
      else if (e.matches_eq !== undefined) ok = matches.length === e.matches_eq;
    }
    if (ok) pass++;
    else failures.push({ q, got: parsed ?? text.slice(0, 200) });
  }
  mcp.close();
  console.log(`online eval: ${pass}/${rows.length} passed`);
  for (const f of failures.slice(0, 20)) console.error("FAIL", JSON.stringify(f.q.desc ?? f.q.kind), "got", JSON.stringify(f.got).slice(0, 300));
  const threshold = Math.ceil(rows.length * 0.9);
  process.exit(pass >= threshold ? 0 : 1);
}
```

- [ ] **Step 5: Sanity-test the runner (against stubbed corpus from unit tests — not live yet)**

We can't run the eval until the corpus has the online block. Defer end-to-end eval to Stage 18 after the live rebuild.

- [ ] **Step 6: Commit**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add msstate-policies/evals/online.jsonl scripts/run-eval.mjs
git commit -m "test(online): 30-question eval set + --suite=online runner"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 18 — Live corpus rebuild + eval validation

### Task 18.1: Run the live build end-to-end

**Files:**
- Modify (regenerated): `worker/corpus.json`, `msstate-policies/dist/index.js`, `msstate-policies/dist/calendar-synonyms.json`

- [ ] **Step 1: Source env + run the build**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
set -a; . ./.env; set +a
node scripts/build-worker-corpus.mjs --skip-calendars 2>&1 | tail -40
```

(We pass `--skip-calendars` because MSU's registrar calendar pages are still flaky as of v0.9.0. If MSU registrar is healthy, drop the flag.)

Expected: no abort. Log line `[build-worker-corpus]   online: NN programs, MM staff, KK info pages (X programs with parse_warnings)` with:
- NN ≥ 100
- MM ≥ 1
- KK == 5
- X ≤ 10

If the build aborts on a TUITION or COURSE issue, that's pre-existing — re-investigate.

If the build aborts on an ONLINE issue, read the abort message:
- `< 100 programs` → MSU may have restructured /academic-programs. Inspect the live page, adjust parser.
- `< 5 admissions sections` → MSU renamed a student-type heading. Update `STUDENT_TYPE_HEADING_MAP` in parser.
- `central_contact.email not on msstate.edu` → MSU rebranded the central contact. Investigate.
- `info_page body too short` → A support page was emptied or its slug changed. Investigate.
- `> 10 programs with parse_warnings` → Bulk parser regression. Inspect a few failing programs.

DO NOT bypass the abort. Fix the parser.

- [ ] **Step 2: Validate the new corpus**

```bash
jq '.online_education | {programs: (.programs|length), staff: (.staff|length), info_pages: (.info_pages|length), builtAt, programs_with_warnings: ([.programs[] | select((.parse_warnings // []) | length > 0)] | length)}' worker/corpus.json
jq -r '.online_education.admissions_process.central_contact.email' worker/corpus.json
jq -r '.online_education.programs | map(.degree_level) | group_by(.) | map({level: .[0], count: length})' worker/corpus.json
```

Expected:
- programs ≥ 100, staff ≥ 1, info_pages == 5
- Reasonable warning count (≤ 10)
- central_contact.email ends `@online.msstate.edu`
- doctoral count ≥ 15, bachelor count ≥ 25 (matches eval expectations)

- [ ] **Step 3: Rebuild stdio bundle**

```bash
cd msstate-policies && npm run build 2>&1 | tail -3
head -2 dist/index.js
grep -o "online_education\|prereq_summary\|online" dist/index.js | sort | uniq -c | head
```

Expected: build clean. Banner still 0.9.0. Bundle contains online_education references.

- [ ] **Step 4: Run the full test suite against the rebuilt corpus**

```bash
cd msstate-policies && npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
```

Expected: ~386/386 pass.

- [ ] **Step 5: Run the online eval**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
node scripts/run-eval.mjs --suite=online 2>&1 | tail -20
```

Expected: `online eval: NN/30 passed` with NN ≥ 27 (90% threshold). Exit 0.

If failures:
- A program_slug_lookup fails → the slug we picked doesn't exist anymore. Update the eval line with a slug that's in the corpus.
- A list_by_level count fails → degree-level distribution shifted. Update the threshold (downward) only if it's a real change in MSU's offering.
- An info_state_auth top_slug mismatch → BM25 ranked something else. Inspect; either tighten the query OR accept slightly lower precision.

DO NOT lower the 90% pass threshold to skirt a failing eval. Either the test is wrong (fix it) or the parser is wrong (fix it).

- [ ] **Step 6: Commit the rebuilt artifacts**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add worker/corpus.json msstate-policies/dist/index.js msstate-policies/dist/calendar-synonyms.json
git status --short
git commit -m "build(online): rebuild corpus with v1.0.0 online module"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 19 — Docs

### Task 19.1: Update README + CLAUDE.md + docs/BUILD.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/BUILD.md`

- [ ] **Step 1: README updates**

- Bump version banner: `**18 MCP tools.** Current version: **v0.9.0**.` → `**22 MCP tools.** Current version: **v1.0.0**.`
- Add a new domain row to the coverage table:
  ```
  | **Online programs** | ~126 program pages + admissions + staff + 5 support pages | `online.msstate.edu` |
  ```
- Add a "What you can ask" block for Online:
  ```
  **Online programs** (v1.0.0)
  - *"Does MSU have an online MBA?"*
  - *"How do I apply to MSU online as an international student?"*
  - *"Who's the advisor for the online psychology program?"*
  - *"What's the application deadline for the online MS in Cybersecurity?"*
  - *"Does MSU online operate in my state?"*
  ```
- Add 4 new tool rows to the 22-tools table (under a "Online (4, v1.0.0)" sub-heading)
- Add a Quality table row: `Online | 30-question eval (program lookup / list / admissions / info / adversarial) | ≥ 27 / 30 (90%)`
- Optionally update the "Server-side routing (new in v0.8.0)" section to mention the 6th rule

- [ ] **Step 2: CLAUDE.md addendum**

After the existing v0.9.0 addendum, append:

```markdown
### Corpus extension (2026-05-13d) — online programs (v1.0.0)

Adds 4 MCP tools (`list_online_programs`, `get_online_program`, `get_online_admissions_process`, `find_online_info`) over a baked snapshot of online.msstate.edu — ~126 program pages + admissions process + central staff directory + 5 support pages (state-authorization, military-assistance, orientation, faq, financial-matters). Tool count 18 → 22.

**Allowlists (frozen in `msstate-policies/src/online/types.ts`):**
- `ONLINE_ROOTS` — 4 base URLs (academic-programs index, admissions-process, staff, base for slugs)
- `SUPPORT_PAGE_SLUGS` — 5 support-page slugs pinned to whitelist

Per-program URLs are extracted from the live `/academic-programs` index, never constructed from external input. Support-page URLs are formed by joining the base + a SUPPORT_PAGE_SLUGS entry.

**Mandatory disclaimer (`ONLINE_DISCLAIMER`):** "Contact info, application deadlines, tuition, and program details on online.msstate.edu can change between releases. Verify against the source URL before applying." Carried on every response. ONL5 enforces presence in all 4 tool files.

**Build aborts (8+ canonical-string sites, all use "refusing to ship a poisoned online corpus"):** subprocess failure, malformed payload, any per-source error, < 100 programs, < 5 admissions sections, central_contact.email not on msstate.edu, < 1 staff, < 5 info pages, any info page body < 200 chars, > 10 programs with parse_warnings.

**Per-program `parse_warnings: OnlineParseWarning[]`** (v0.9.0 pattern): `no_contacts_extracted`, `no_deadlines_extracted`, `tuition_unparsed`, `admissions_section_missing`, `format_field_missing`. Empty array means fully parsed. Aggregate count gated at 10.

**Server-side routing:** `InitializeResult.instructions` gains a 6th rule routing online-program / admissions / student-services questions to the 4 new tools. Distinct from policies/courses/tuition (which cover the broader MSU corpus).
```

- [ ] **Step 3: docs/BUILD.md addendum**

Append a "MSU Online module (v1.0.0, 2026-05-13)" section to docs/BUILD.md. Cover:

- Two-pass scrape design (programs index → fan-out)
- Schema split (structured fields where MSU's wording is reliable + verbatim prose for everything else)
- The 4 tools mapped to the 4 highest-volume student question categories
- Build-time ceilings + canonical abort string
- Eval results (30 questions, ≥ 27 pass)
- Source-data quirks: deadlines kept verbatim (no ISO parse); slug stability; rate limiting tolerance

(~50 lines.)

- [ ] **Step 4: Verify tests still pass + commit**

```bash
cd msstate-policies && npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail"
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
git add README.md CLAUDE.md docs/BUILD.md
git commit -m "docs(online): v1.0.0 README/CLAUDE/BUILD addenda"
git rev-parse --abbrev-ref HEAD
```

---

## Stage 20 — Version bump 0.9.0 → 1.0.0 + rebuild

### Task 20.1: Bump version + rebuild bundle

**Files:**
- Modify: `msstate-policies/package.json`
- Modify (auto-synced): `msstate-policies/.claude-plugin/plugin.json`
- Modify: `worker/src/index.ts` (3 hardcoded sites)
- Modify (rebuilt): `msstate-policies/dist/index.js`

- [ ] **Step 1: Bump versions across 4 sites**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
sed -i.bak 's/"version": "0.9.0"/"version": "1.0.0"/' msstate-policies/package.json && rm msstate-policies/package.json.bak
sed -i.bak 's/version: "0.9.0"/version: "1.0.0"/g; s/"version": "0.9.0"/"version": "1.0.0"/g' worker/src/index.ts && rm worker/src/index.ts.bak
grep '"version"' msstate-policies/package.json
grep -nE '"version": "0\.[89]\.0"|"version": "1\.0\.0"|version: "0\.[89]\.0"|version: "1\.0\.0"' worker/src/index.ts | head -5
```

Expected: package.json shows 1.0.0; worker/src/index.ts shows three `1.0.0` references (lines ~1586, ~1707, ~1778 — these may have shifted from prior commits).

- [ ] **Step 2: Rebuild bundle**

```bash
cd msstate-policies && npm run build 2>&1 | tail -3
head -2 dist/index.js
```

Expected: banner reads `// msstate-policies-mcp 1.0.0 <sha> built ...`.

- [ ] **Step 3: Run full tests + security checklist**

```bash
cd /Users/minsub/vscode/msstate-mcp/msstate-mcp
(cd msstate-policies && npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail")
bash tools/security-checklist.sh 2>&1 | tail -1
```

Expected: all tests pass. Score: 257 macOS / 269 Linux CI.

- [ ] **Step 4: Commit the release**

```bash
git add msstate-policies/package.json msstate-policies/.claude-plugin/plugin.json worker/src/index.ts msstate-policies/dist/index.js
git status --short
git commit -m "release: v1.0.0 — MSU Online module

- 4 new tools: list_online_programs, get_online_program,
  get_online_admissions_process, find_online_info
- 18 → 22 tools
- ~126 online program pages + admissions + staff + 5 support pages
- Two-pass scraper (programs-index then per-program fan-out)
- Per-program parse_warnings diagnostic (v0.9.0 pattern)
- ONLINE_DISCLAIMER on every response
- InitializeResult.instructions gains 6th routing rule
- Security score 257 → 269 (Linux CI; ONL1-ONL5)
- 30-question online eval at ≥ 90% pass

First major version. Earns the v1.0.0 bump as the first
non-policy/non-academic domain at this scale (700KB corpus growth,
true product-market-fit feature for prospective students).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Stage 21 — Push + open PR (STOP — do not merge)

### Task 21.1: Push branch + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/online-msu 2>&1 | tail -3
```

- [ ] **Step 2: Open PR via gh**

```bash
gh pr create --base main --head feat/online-msu --title "v1.0.0: MSU Online module (4 new MCP tools)" --body "$(cat <<'EOF'
## Summary

Adds 4 MCP tools — `list_online_programs`, `get_online_program`, `get_online_admissions_process`, `find_online_info` — over a baked snapshot of online.msstate.edu (~126 program pages + admissions process + central staff directory + 5 support pages). Tool count **18 → 22**.

- **Spec:** [`.dev/specs/2026-05-13-online-msu-design.md`](.dev/specs/2026-05-13-online-msu-design.md)
- **Plan:** [`.dev/plans/2026-05-13-online-msu.md`](.dev/plans/2026-05-13-online-msu.md)

## What this delivers

| | Before | After |
|---|---|---|
| Tool count | 18 | **22** |
| Domains covered | 5 | **6** (adds Online) |
| Online programs in corpus | 0 | **~126** |
| Worker `corpus.json` size | ~5.0 MB | ~5.7 MB |
| Unit tests | 336 | **~386** |
| Eval suites | 5 | **6** (adds Online, ≥ 27 / 30) |
| Security score (Linux CI) | 257 | **269** (ONL1–ONL5) |

## Response-shape highlights

- `OnlineProgram` — slug + name + degree_level + format + tuition + contacts + application_deadlines + admission_requirements + entrance_exams + accreditation + forms + raw_sections + parse_warnings
- `OnlineAdmissionsProcess.central_contact` — `ask@online.msstate.edu` / (662) 325-3473
- `OnlineInfoPage[]` — state-authorization, military-assistance, orientation, faq, financial-matters
- `OnlineStaffEntry[]` — central staff directory
- Mandatory `ONLINE_DISCLAIMER` on every response

## Notable architecture

- **Two-pass scraper:** fetch `/academic-programs` first to enumerate the ~126 program slugs, then concurrency-pool fetch each per-program page. Per-program URLs never constructed from external input.
- **Application deadlines kept verbatim** (e.g., "August 1") — year context unreliable for ISO parsing
- **Soft-warn per-program parse failures** + hard-fail on whole-corpus issues (mirrors v0.9.0 prereq pattern)
- **State authorization called out** — `/state-authorization` lists states where MSU online cannot operate; model surfaces proactively for out-of-state queries
- **Server-side routing instructions** updated with a 6th rule for online-module questions

## Test plan

- [x] `npm test` → ~386/386 pass
- [x] `node scripts/run-eval.mjs --suite=online` → ≥ 27/30 (90% threshold)
- [x] `bash tools/security-checklist.sh` → 257 (macOS) / 269 (Linux CI)
- [x] Live corpus rebuild succeeded; counts under ceilings (programs ≥ 100, ≤ 10 program parse_warnings)
- [x] Stdio bundle banner reads `msstate-policies-mcp 1.0.0`
- [x] Worker typecheck clean

## Release follow-ups (after merge)

- `npm publish msstate-policies-mcp@1.0.0`
- `cd worker && wrangler deploy`
- `git tag v1.0.0 && git push origin v1.0.0`

## Why v1.0.0

First major version. Earns the bump as the first non-policy/non-academic domain at this scale (700 KB corpus growth, 4 new tools, true product-market-fit feature for prospective students). Seven minor releases (v0.2.0 → v0.9.0) preceded this.

## Notes

- Corpus rebuilt with `--skip-calendars` (calendar scrape uses the v0.9.0 cached block — MSU registrar pages remain flaky). Online + course data is freshly scraped under v1.0.0 parsers.
- A few programs may carry `parse_warnings` in the corpus — soft-warn behavior is intentional (a single broken program page does not block the build).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 3: STOP**

PR is open. Do NOT merge. Report the PR URL and stop. The user will review, merge, and trigger the release follow-ups (npm publish, wrangler deploy, git tag).

---

## Done

After Stage 21, v1.0.0 PR is open. Same release pattern as v0.8.0 / v0.9.0:

1. User reviews PR
2. Merge to main (`--no-ff` for visibility)
3. `npm publish msstate-policies-mcp@1.0.0` (with NPM_TOKEN from `.env`)
4. `cd worker && wrangler deploy` (with CLOUDFLARE_API from `.env`)
5. `git tag v1.0.0 && git push origin v1.0.0`

Once deployed, a prospective student asking ChatGPT or Claude:

- *"Does MSU have an online MBA?"* → `get_online_program(name_query="online MBA")` → full structured record
- *"How do I apply to MSU online as an international student?"* → `get_online_admissions_process(student_type="international")` → verbatim section with TOEFL/IELTS requirements + ask@online.msstate.edu
- *"Does MSU online operate in my state?"* → `find_online_info(q="...", scope="state-authorization")` → verbatim authorization data
- *"Who's the advisor for the online psychology program?"* → `get_online_program(slug="psychology")` → contact names + emails + phones

…gets grounded answers from MSU's own marketing site, with citations and a disclaimer reminding them to verify before applying.



