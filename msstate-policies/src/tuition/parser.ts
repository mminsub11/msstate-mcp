import { load as cheerioLoad } from "cheerio";
import type {
  FaqRow,
  FeeRow,
  FeeKind,
  TuitionRateRow,
  CampusSlug,
  Level,
  Term,
  CreditHourBucket,
  Residency,
  LineItem,
  CampusEntry,
} from "./types.js";

const RETRIEVED_AT_PLACEHOLDER = "1970-01-01T00:00:00.000Z";

/**
 * Parse the tuition FAQ page. Returns one FaqRow per Q&A pair.
 *
 * The page uses a Bootstrap accordion rendered by Drupal:
 *   div.accordion-item
 *     h2.accordion-header[id="panels-heading--NNN--slug"]
 *       button.accordion-button   <- question text lives here
 *     div.accordion-collapse[id="panels-collapse--NNN--slug"]
 *       div.accordion-body        <- answer text lives here
 *
 * Each accordion-item maps to exactly one FaqRow. The anchor link uses the
 * id from h2.accordion-header (the heading id, not the collapse panel id).
 *
 * `retrieved_at` is left as a placeholder — the scraper overwrites it.
 */
export function parseFaqHtml(html: string, pageUrl: string): FaqRow[] {
  const $ = cheerioLoad(html);
  const out: FaqRow[] = [];
  const seen = new Set<string>();

  $(".accordion-item").each((_, item) => {
    const $item = $(item);

    // Question: text of the button inside h2.accordion-header
    const $button = $item.find("h2.accordion-header button.accordion-button");
    if (!$button.length) return;

    const question = $button.text().replace(/\s+/g, " ").trim();
    if (question.length < 5) return;
    if (seen.has(question)) return;
    seen.add(question);

    // Answer: text of the accordion body
    const $body = $item.find(".accordion-body");
    if (!$body.length) return;

    // Preserve paragraph breaks in the answer (questions collapse all whitespace; answers don't)
    const answer = $body.text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (answer.length < 1) return;

    // Anchor: use the id on h2.accordion-header (not the collapse panel id)
    const headingId = $item.find("h2.accordion-header").attr("id");
    const source_url = headingId ? `${pageUrl}#${headingId}` : pageUrl;

    out.push({
      question,
      answer,
      source_url,
      retrieved_at: RETRIEVED_AT_PLACEHOLDER,
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// Fees parser
// ---------------------------------------------------------------------------

// MONEY_RE and parseMoney are at module scope so later parsers can reuse them.
const MONEY_RE = /\$?\s*([\d,]+(?:\.\d{2})?)/;

function parseMoney(s: string | undefined | null): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (/n\/?a/i.test(trimmed)) return null;
  const m = MONEY_RE.exec(trimmed);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Maps Bootstrap tab-pane aria-label values to FeeKind.
// The page uses tab-panes rather than h2/h3 headings.
const PANE_TO_KIND: Array<[RegExp, FeeKind]> = [
  [/college fees?/i, "college"],
  [/program fees?/i, "program"],
  [/course.*distance|distance.*fees?/i, "course_distance"],
];

/**
 * Parse the "Other Enrollment Costs" fees page.
 *
 * The page uses Bootstrap tabs with div.tab-pane[aria-label="..."] containers:
 *   - "College Fees"          -> one table (College | Per-Credit-Hour Rate | Full-Time Cap)
 *   - "Program Fees"          -> multiple tables, each with a group <th> in thead
 *   - "Course & Distance Fees" -> no table, just descriptive text
 *
 * For the Honors College row, Per-Credit-Hour Rate is "n/a" and the
 * Full-Time Rate is $75.00. That $75 is a flat per-semester fee, so we
 * expose it as flat_amount_usd (not full_time_cap_usd) so callers find it
 * naturally. full_time_cap_usd is also populated for rows that have both.
 */
export function parseFeesHtml(html: string, pageUrl: string): FeeRow[] {
  const $ = cheerioLoad(html);
  const out: FeeRow[] = [];

  $("div.tab-pane").each((_, pane) => {
    const ariaLabel = $(pane).attr("aria-label") ?? "";
    const kindMatch = PANE_TO_KIND.find(([re]) => re.test(ariaLabel));
    if (!kindMatch) return;
    const kind: FeeKind = kindMatch[1];

    // Collect an applicability note from <p> tags before any table.
    const noteLines: string[] = [];
    $(pane)
      .children("p")
      .each((_, p) => {
        const t = $(p).text().replace(/\s+/g, " ").trim();
        if (t.length > 0) noteLines.push(t);
      });
    const applicability_note = noteLines.join(" ");

    $(pane)
      .find("table")
      .each((_, table) => {
        const $table = $(table);

        // Determine column indices from the header row.
        const $headerRow = $table.find("thead tr").first();
        const headerCells = $headerRow
          .find("th, td")
          .map((_, c) => $(c).text().replace(/\s+/g, " ").trim().toLowerCase())
          .get();

        // Column index detection — tolerant matching.
        const perCreditIdx = headerCells.findIndex((c) =>
          /per.{0,6}credit|per.{0,6}hour/i.test(c),
        );
        const fullTimeIdx = headerCells.findIndex((c) =>
          /full.{0,6}time|cap|semester/i.test(c),
        );
        // label is always the first column (index 0)
        const labelIdx = 0;

        $table.find("tbody tr").each((_, tr) => {
          const cells = $(tr)
            .find("td, th")
            .map((_, c) => $(c).text().replace(/\s+/g, " ").trim())
            .get();

          // Need at least a label cell
          if (cells.length < 1) return;
          const label = cells[labelIdx];
          if (!label) return;

          const per_credit_usd =
            perCreditIdx >= 0 ? parseMoney(cells[perCreditIdx]) : null;
          const fullTimeVal =
            fullTimeIdx >= 0 ? parseMoney(cells[fullTimeIdx]) : null;

          // full_time_cap_usd: populated when there is also a per-credit rate
          // (it caps the per-credit accumulation). When per_credit is null/n/a
          // but a full-time amount exists (e.g. Honors $75 flat fee), treat it
          // as flat_amount_usd instead.
          let full_time_cap_usd: number | null = null;
          let flat_amount_usd: number | null = null;

          if (per_credit_usd !== null && fullTimeVal !== null) {
            full_time_cap_usd = fullTimeVal;
          } else if (per_credit_usd === null && fullTimeVal !== null) {
            // No per-credit rate — the full-time amount is a flat fee.
            flat_amount_usd = fullTimeVal;
          }

          out.push({
            kind,
            label,
            per_credit_usd,
            full_time_cap_usd,
            flat_amount_usd,
            applicability_note,
            source_url: pageUrl,
            retrieved_at: RETRIEVED_AT_PLACEHOLDER,
          });
        });
      });
  });

  return out;
}

// ---------------------------------------------------------------------------
// Controller-campus rate-table parser
// ---------------------------------------------------------------------------

/**
 * Derive Term from a heading string extracted from the table's <thead> <p>.
 */
function classifyTerm(heading: string): Term | null {
  const lc = heading.toLowerCase();
  if (/fall.*spring|spring.*fall|fall .+\d+.*spring|spring .+\d+.*fall/i.test(heading)) {
    return "fall_spring";
  }
  if (/fall/i.test(lc)) return "fall_spring";
  if (/spring/i.test(lc) && !/summer/i.test(lc)) return "fall_spring";
  if (/winter/i.test(lc)) return "winter";
  if (/summer/i.test(lc)) return "summer";
  return null;
}

/**
 * Derive CreditHourBucket from the bucket-descriptor cell (first <tbody> row,
 * first column). Examples:
 *   "Per-Credit-Hour Cost: 1 - 11 Hours"
 *   "Per Semester Cost: 12 - 16 Hours"
 *   "Per-Credit-Hour Cost: 1 - 8 Hours"
 *   "Per Semester Cost: 9 or More Hours"
 *   "Per-Credit-Hour Cost"               (no explicit bucket — winter/summer)
 */
function classifyBucket(descriptor: string): CreditHourBucket | null {
  const lc = descriptor.toLowerCase();
  if (/1\s*-\s*11\b/.test(lc)) return "1-11";
  if (/12\s*-\s*16\b/.test(lc) || /12\+|12 or more/.test(lc)) return "12-16";
  if (/1\s*-\s*8\b/.test(lc)) return "1-8";
  if (/9\s*or\s*more|9\s*\+/.test(lc)) return "9+";
  return null;
}

/**
 * Parse a controller.msstate.edu campus rate page.
 *
 * Page structure (Bootstrap tab-pane per level):
 *   div.tab-pane[id="pane--undergraduate-rates"] -> undergrad tables
 *   div.tab-pane[id="pane--graduate-rates"]       -> grad tables  (absent for mgccc)
 *
 * Each <table> inside a pane:
 *   <thead><tr><th colspan="3"><p ...>Fall 2026 or Spring 2027</p></th></tr></thead>
 *   <tbody>
 *     <tr>                                        <- descriptor/header row
 *       <td><b>Per-Credit-Hour Cost: 1 - 11 Hours</b></td>
 *       <td>Resident</td>
 *       <td>Non-Resident</td>
 *     </tr>
 *     <tr><td>Tuition & Required Fees</td><td>$452.00</td><td>$452.00</td></tr>
 *     ...
 *     <tr><td>Total Fee (Per Credit Hour)</td><td>$458.25</td><td>$1,249.75</td></tr>
 *   </tbody>
 *
 * Some tables (second one in a pair) have an empty <thead> — they inherit
 * the term from the most-recent table that had a non-empty <thead> in
 * the same pane.
 *
 * Column indices: label=0, resident=1, non_resident=2 (confirmed across all
 * fixtures — the column-header row is the first tbody row, not thead).
 */
// ---------------------------------------------------------------------------
// Vetmed flat-rate parser
// ---------------------------------------------------------------------------

/**
 * Find the "Effective …" line from any <em> or <p> text in the article body.
 */
function findEffectiveLine($: ReturnType<typeof cheerioLoad>): string {
  let found = "";
  $("article p em, article p, section p em, section p").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (/^effective\b/i.test(t)) {
      found = t;
      return false; // break
    }
    return undefined;
  });
  return found || "Effective term not stated on source page";
}

/**
 * Parse the vetmed.msstate.edu/tuition rate page.
 *
 * Page structure (different domain from controller pages — no Bootstrap tabs):
 *   <p><em>Effective Fall 2025 Semester through Summer 2026</em></p>
 *   <h3><strong>Mississippi Resident Costs</strong></h3>
 *   <table class="table">
 *     <thead><tr><th></th><th>Semester Rate</th><th>Annual Rate</th></tr></thead>
 *     <tbody>
 *       <tr><td>Base Tuition</td><td>$13,682.88</td><td>$27,365.75</td></tr>
 *       ...
 *       <tr><td>Total Charge to Student</td><td>$14,951.50</td><td>$29,903.00</td></tr>
 *     </tbody>
 *   </table>
 *   <h3><strong>Non-Resident Costs</strong></h3>
 *   <table class="table">...</table>
 *
 * Strategy: find each <h3> to determine residency, then select the immediately
 * following <table> sibling. Column 1 = Semester Rate, column 2 = Annual Rate.
 * "Total Charge to Student" provides the totals; line items are the other rows.
 * Produces two TuitionRateRow records per residency: one per_semester_flat and
 * one annual_flat.
 */
export function parseVetmedRateHtml(html: string, pageUrl: string): TuitionRateRow[] {
  const $ = cheerioLoad(html);
  const out: TuitionRateRow[] = [];
  const effective_term = findEffectiveLine($);

  // Find each h3 that names a residency group, then grab its next table sibling.
  $("h3").each((_, h3El) => {
    const heading = $(h3El).text().replace(/\s+/g, " ").trim();
    let residency: Residency | null = null;
    if (/non.?resident/i.test(heading)) residency = "non_resident";
    else if (/resident/i.test(heading)) residency = "resident";
    if (!residency) return;

    // Find the immediately following table sibling.
    const $table = $(h3El).next("table");
    if (!$table.length) return;

    // Determine column indices from the <thead> row.
    const headerCells = $table
      .find("thead tr")
      .first()
      .find("th, td")
      .map((_, c) => $(c).text().replace(/\s+/g, " ").trim().toLowerCase())
      .get();

    const semIdx = headerCells.findIndex((c) => /semester/i.test(c));
    const annIdx = headerCells.findIndex((c) => /annual/i.test(c));
    // Fall back to positional defaults if header detection fails.
    const semCol = semIdx >= 0 ? semIdx : 1;
    const annCol = annIdx >= 0 ? annIdx : 2;

    const semItems: LineItem[] = [];
    const annItems: LineItem[] = [];
    let semTotal: number | null = null;
    let annTotal: number | null = null;

    $table.find("tbody tr").each((_, tr) => {
      const cells = $(tr)
        .find("td, th")
        .map((_, c) => $(c).text().replace(/\s+/g, " ").trim())
        .get();
      if (cells.length < 1) return;
      const label = cells[0];
      if (!label) return;

      const semAmt = semCol < cells.length ? parseMoney(cells[semCol]) : null;
      const annAmt = annCol < cells.length ? parseMoney(cells[annCol]) : null;

      if (/total/i.test(label)) {
        semTotal = semAmt;
        annTotal = annAmt;
      } else {
        if (semAmt !== null) semItems.push({ label, amount_usd: semAmt });
        if (annAmt !== null) annItems.push({ label, amount_usd: annAmt });
      }
    });

    // Fall back to summing line items if no explicit Total row found.
    if (semTotal === null && semItems.length > 0) {
      semTotal = semItems.reduce((s, li) => s + li.amount_usd, 0);
    }
    if (annTotal === null && annItems.length > 0) {
      annTotal = annItems.reduce((s, li) => s + li.amount_usd, 0);
    }

    if (semTotal !== null && semTotal > 0) {
      out.push({
        campus: "vetmed",
        level: "dvm",
        residency,
        term: "fall_spring",
        rate_basis: "per_semester_flat",
        credit_hour_bucket: null,
        amount_usd: semTotal,
        line_items: semItems,
        effective_term,
        source_url: pageUrl,
        retrieved_at: RETRIEVED_AT_PLACEHOLDER,
      });
    }
    if (annTotal !== null && annTotal > 0) {
      out.push({
        campus: "vetmed",
        level: "dvm",
        residency,
        term: "annual",
        rate_basis: "annual_flat",
        credit_hour_bucket: null,
        amount_usd: annTotal,
        line_items: annItems,
        effective_term,
        source_url: pageUrl,
        retrieved_at: RETRIEVED_AT_PLACEHOLDER,
      });
    }
  });

  return out;
}

export function parseControllerRateHtml(
  html: string,
  campus: CampusSlug,
  pageUrl: string,
): TuitionRateRow[] {
  const $ = cheerioLoad(html);
  const out: TuitionRateRow[] = [];

  const LEVEL_PANE_IDS: Array<[string, Level]> = [
    ["pane--undergraduate-rates", "undergrad"],
    ["pane--graduate-rates", "grad"],
  ];

  for (const [paneId, level] of LEVEL_PANE_IDS) {
    const $pane = $(`#${paneId}`);
    if (!$pane.length) continue;

    let currentTerm: Term | null = null;
    let currentEffectiveTerm = "";

    $pane.find("table").each((_, table) => {
      const $table = $(table);

      // Extract term label from <thead> <p> (may be absent on paired tables).
      const theadText = $table.find("thead p").first().text().replace(/\s+/g, " ").trim();
      if (theadText.length > 0) {
        const derived = classifyTerm(theadText);
        if (derived !== null) {
          currentTerm = derived;
          currentEffectiveTerm = theadText;
        }
      }

      if (!currentTerm) return; // skip tables before we've seen a term heading

      const rows = $table.find("tbody tr").toArray();
      if (rows.length < 2) return; // need at least descriptor row + one data row

      // First tbody row: bucket descriptor + column headers (Resident / Non-Resident)
      const descriptorCells = $(rows[0])
        .find("td, th")
        .map((_, c) => $(c).text().trim())
        .get();
      if (descriptorCells.length < 3) return;

      const bucketDescriptor = descriptorCells[0];
      const bucket = classifyBucket(bucketDescriptor);

      // Verify the header cells look like resident / non-resident.
      const col1 = descriptorCells[1].toLowerCase();
      const col2 = descriptorCells[2].toLowerCase();
      const residentIdx = /^resident/.test(col1) ? 1 : /^resident/.test(col2) ? 2 : -1;
      const nonResidentIdx = /non.?resident/.test(col2) ? 2 : /non.?resident/.test(col1) ? 1 : -1;
      if (residentIdx < 0 || nonResidentIdx < 0) return;

      // Two-pass row scan. Collect candidate Total rows + line items first;
      // pick the headline Total once we know how many candidates exist:
      //   - 1-11 tables have ONE Total row "Total Fee (Per Credit Hour)" — it
      //     IS the headline (the whole table is per-credit-hour).
      //   - 12-16 tables have TWO: "Total Fee" (per-semester, headline) and
      //     "Total Fee (Per Credit Hour)" (derived breakdown).
      interface TotalCandidate { label: string; res: number | null; nonRes: number | null; }
      const residentItems: LineItem[] = [];
      const nonResidentItems: LineItem[] = [];
      const totalCandidates: TotalCandidate[] = [];

      for (let i = 1; i < rows.length; i++) {
        const cells = $(rows[i])
          .find("td, th")
          .map((_, c) => $(c).text().trim())
          .get();
        if (cells.length < 3) continue;

        const label = cells[0].replace(/ /g, " ").trim();
        if (!label) continue;

        const resAmt = parseMoney(cells[residentIdx]);
        const nonResAmt = parseMoney(cells[nonResidentIdx]);

        if (/total/i.test(label)) {
          totalCandidates.push({ label, res: resAmt, nonRes: nonResAmt });
        } else {
          if (resAmt !== null) residentItems.push({ label, amount_usd: resAmt });
          if (nonResAmt !== null) nonResidentItems.push({ label, amount_usd: nonResAmt });
        }
      }

      // Pick headline Total: prefer a row WITHOUT the "Per Credit Hour"
      // qualifier when multiple Total rows exist; otherwise take the only one.
      const isPerCreditQualifier = (s: string): boolean =>
        /per.{0,4}(credit|hour)/i.test(s);
      let headlineTotal: TotalCandidate | null = null;
      if (totalCandidates.length === 1) {
        headlineTotal = totalCandidates[0];
      } else if (totalCandidates.length > 1) {
        headlineTotal =
          totalCandidates.find((c) => !isPerCreditQualifier(c.label)) ??
          totalCandidates[0];
      }
      let residentTotal: number | null = headlineTotal?.res ?? null;
      let nonResidentTotal: number | null = headlineTotal?.nonRes ?? null;

      // Reconcile Total against line-items sum.
      //  - If no Total row was parsed, sum the line items.
      //  - If Total is present but diverges from the sum by > 5%, the source
      //    HTML has a typo (e.g. Meridian non-resident 12-16 publishes
      //    "$14.968.00" instead of "$14,968.00", parsing to $14.96). Prefer
      //    the line-items sum in that case — line items parse correctly
      //    because they use the standard comma-as-thousands format.
      const reconcile = (total: number | null, items: LineItem[]): number | null => {
        if (items.length === 0) return total;
        const sum = items.reduce((s: number, li: LineItem) => s + li.amount_usd, 0);
        if (total === null) return sum;
        if (sum === 0) return total;
        const drift = Math.abs(total - sum) / sum;
        return drift > 0.05 ? sum : total;
      };
      residentTotal = reconcile(residentTotal, residentItems);
      nonResidentTotal = reconcile(nonResidentTotal, nonResidentItems);

      const push = (residency: Residency, total: number, items: LineItem[]) => {
        out.push({
          campus,
          level,
          residency,
          term: currentTerm!,
          rate_basis: "per_credit_hour",
          credit_hour_bucket: bucket,
          amount_usd: total,
          line_items: items,
          effective_term: currentEffectiveTerm,
          source_url: pageUrl,
          retrieved_at: RETRIEVED_AT_PLACEHOLDER,
        });
      };

      if (residentTotal !== null && residentTotal > 0) {
        push("resident", residentTotal, residentItems);
      }
      if (nonResidentTotal !== null && nonResidentTotal > 0) {
        push("non_resident", nonResidentTotal, nonResidentItems);
      }
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Campus list builder
// ---------------------------------------------------------------------------

const DISPLAY_NAMES: Record<CampusSlug, string> = {
  starkville: "Starkville Campus",
  meridian: "Meridian Campus",
  mgccc: "MGCCC — Engineering on the Coast",
  online: "MSU Online Education",
  vetmed: "College of Veterinary Medicine (DVM)",
};

const SOURCE_URLS: Record<CampusSlug, string> = {
  starkville: "https://www.controller.msstate.edu/accountservices/tuition/starkville-campus",
  meridian:   "https://www.controller.msstate.edu/accountservices/tuition/meridian-campus",
  mgccc:      "https://www.controller.msstate.edu/accountservices/tuition/mgccc-campus-rates",
  online:     "https://www.controller.msstate.edu/accountservices/tuition/online-education-rates",
  vetmed:     "https://www.vetmed.msstate.edu/tuition",
};

export function buildCampusList(rateRows: TuitionRateRow[]): CampusEntry[] {
  const byCampus = new Map<CampusSlug, { levels: Set<Level>; basis: "per_credit_hour" | "annual_flat" }>();
  for (const r of rateRows) {
    const entry = byCampus.get(r.campus) ?? {
      levels: new Set(),
      basis: r.campus === "vetmed" ? "annual_flat" : "per_credit_hour",
    };
    entry.levels.add(r.level);
    byCampus.set(r.campus, entry);
  }
  const out: CampusEntry[] = [];
  for (const slug of ["starkville", "meridian", "mgccc", "online", "vetmed"] as CampusSlug[]) {
    const e = byCampus.get(slug);
    if (!e) continue;
    out.push({
      slug,
      display_name: DISPLAY_NAMES[slug],
      levels_offered: Array.from(e.levels),
      rate_basis: e.basis,
      source_url: SOURCE_URLS[slug],
    });
  }
  return out;
}
