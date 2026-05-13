import { load as cheerioLoad } from "cheerio";
import type { FaqRow, FeeRow, FeeKind } from "./types.js";

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
