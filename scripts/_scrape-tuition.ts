/**
 * One-shot tuition-site scrape that writes a single JSON blob to stdout.
 * Run via `npx tsx scripts/_scrape-tuition.ts` from repo root.
 *
 * Uses the same parsers + scraper as the runtime stdio server.
 * Corpus rule: all data comes exclusively from *.msstate.edu sites.
 */

// Defensive: redirect console.log → stderr so any transitive dep that logs
// to stdout doesn't corrupt the JSON pipe to build-worker-corpus.mjs.
// eslint-disable-next-line no-console
console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

import { scrapeAllTuition } from "../msstate-policies/src/tuition/scraper.js";

async function main(): Promise<void> {
  process.stderr.write("[scrape-tuition] fetching 9 source pages...\n");
  const r = await scrapeAllTuition();
  process.stderr.write(
    `[scrape-tuition]   ${r.rate_rows.length} rate rows, ${r.fee_rows.length} fee rows, ${r.faq_rows.length} faq rows, ${r.campuses.length} campuses, anyError=${r.anyError}\n`,
  );
  for (const [src, info] of Object.entries(r.per_source)) {
    if (!info.ok) process.stderr.write(`[scrape-tuition]   FAIL ${src}: ${info.error}\n`);
  }
  process.stdout.write(
    JSON.stringify({
      rate_rows: r.rate_rows,
      fee_rows: r.fee_rows,
      faq_rows: r.faq_rows,
      campuses: r.campuses,
      per_source: r.per_source,
      anyError: r.anyError,
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`[scrape-tuition] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
