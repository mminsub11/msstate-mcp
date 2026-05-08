#!/usr/bin/env node
/**
 * Live PDF audit. Downloads every PDF linked from /current and runs it
 * through pdf-parse, then writes a CSV summary to msstate-policies/eval/
 * audit-YYYY-MM-DD.csv.
 *
 * Pass criteria (from PLAN.md): >=95% of PDFs yield >=500 chars/page on
 * average; <5% with parse_error. Below that, switch to pdfjs-dist.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as cheerioLoad } from "cheerio";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "msstate-policies", "eval");
mkdirSync(outDir, { recursive: true });

const BASE = "https://www.policies.msstate.edu";
const UA = "msstate-policies-mcp/0.1.0 (audit-pdfs)";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  console.error("audit-pdfs: fetching index");
  const html = await fetchText(`${BASE}/current`);
  const $ = cheerioLoad(html);
  const rows = [];
  $("#datatable tbody tr").each((_i, tr) => {
    const $tr = $(tr);
    const number = $tr.find("td:nth-child(1)").text().trim();
    if (!/^\d{2}\.(\d{2}|\d{3})$/.test(number)) return;
    const pdfHref = $tr.find("td:last-child a.btn-download").attr("href");
    if (!pdfHref) return;
    const pdfUrl = pdfHref.startsWith("http") ? pdfHref : BASE + pdfHref;
    rows.push({ number, pdfUrl });
  });
  console.error(`audit-pdfs: ${rows.length} PDFs to audit`);

  const csv = ["number,bytes,page_count,extracted_chars,first_100_chars,has_smart_quotes,parse_error"];
  let parseErrors = 0;
  let goodEnough = 0;

  const queue = [...rows];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;
      try {
        const buf = await fetchBuffer(row.pdfUrl);
        const parsed = await pdfParse(buf);
        const text = (parsed.text || "").normalize("NFKC");
        const chars = text.length;
        const first100 = text.slice(0, 100).replace(/[\r\n,"]/g, " ").trim();
        const hasSmart = /[“”‘’]/.test(text);
        const charsPerPage = parsed.numpages ? chars / parsed.numpages : 0;
        if (charsPerPage >= 500) goodEnough++;
        csv.push(
          [
            row.number,
            buf.length,
            parsed.numpages || 0,
            chars,
            JSON.stringify(first100),
            hasSmart ? "1" : "0",
            "",
          ].join(","),
        );
      } catch (err) {
        parseErrors++;
        csv.push(
          [
            row.number,
            "",
            "",
            "",
            "",
            "",
            JSON.stringify(err.message ?? String(err)),
          ].join(","),
        );
      }
    }
  });
  await Promise.all(workers);

  const today = new Date().toISOString().slice(0, 10);
  const outPath = resolve(outDir, `audit-${today}.csv`);
  writeFileSync(outPath, csv.join("\n") + "\n");
  console.error(`audit-pdfs: wrote ${outPath}`);
  console.error(
    `audit-pdfs: ${goodEnough}/${rows.length} >= 500 chars/page (${((goodEnough / rows.length) * 100).toFixed(1)}%); parse_error=${parseErrors}`,
  );

  if (goodEnough / rows.length < 0.95) {
    console.error("audit-pdfs: WARNING — pass rate below 95% threshold");
  }
  if (parseErrors / rows.length >= 0.05) {
    console.error("audit-pdfs: WARNING — parse_error rate above 5%");
  }
}

main().catch((err) => {
  console.error("audit-pdfs: fatal", err);
  process.exit(1);
});
