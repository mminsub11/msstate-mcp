/**
 * One-shot emergency-site scrape that writes a single JSON blob to stdout.
 * Run via `npx tsx scripts/_scrape-emergency.ts` from repo root.
 *
 * Uses the same parsers + scraper as the runtime stdio server.
 *
 * Corpus rule: all data comes exclusively from msstate.edu sites.
 */

// pdf-parse uses console.log() for warnings. We don't use pdf-parse here, but
// keep the redirect for consistency with _scrape-calendars.ts in case any
// transitive dep also writes to stdout.
// eslint-disable-next-line no-console
console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

import { scrapeAllEmergency } from "../msstate-policies/src/emergency/scraper.js";

async function main(): Promise<void> {
  process.stderr.write("[scrape-emergency] fetching 12 guidelines + /refuge...\n");
  const r = await scrapeAllEmergency();
  process.stderr.write(
    `[scrape-emergency]   ${r.guidelines.length} guidelines, ${r.refuge_areas.length} refuge rows, ${r.contacts.length} contacts, anyError=${r.anyError}\n`,
  );
  for (const [src, info] of Object.entries(r.per_source)) {
    if (!info.ok) {
      process.stderr.write(`[scrape-emergency]   FAIL ${src}: ${info.error}\n`);
    }
  }
  process.stdout.write(
    JSON.stringify({
      guidelines: r.guidelines,
      refuge_areas: r.refuge_areas,
      contacts: r.contacts,
      per_source: r.per_source,
      anyError: r.anyError,
    }),
  );
}

main().catch((err) => {
  process.stderr.write(
    `[scrape-emergency] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
