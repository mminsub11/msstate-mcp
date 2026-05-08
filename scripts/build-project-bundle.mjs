#!/usr/bin/env node
/**
 * Build the "Claude Project starter" zip — a curated set of MSU policy PDFs
 * plus a system-prompt template, intended for free claude.ai users who can't
 * install MCP. Drag-and-drop into a Project.
 *
 * NO TRAINED-KNOWLEDGE RULE: the bundle's contents come purely from
 * policies.msstate.edu. We pull the live index, pick policies whose titles
 * match curated keywords (high-traffic categories from PLAN.md), and zip the
 * actual PDFs MSU is currently serving.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { load as cheerioLoad } from "cheerio";

const BASE = "https://www.policies.msstate.edu";
const UA = "msstate-policies-mcp/0.1.0 (build-project-bundle)";

// Curated by title-keyword for now — high-traffic categories from PLAN.md.
// Refine when usage data exists. Patterns are matched case-insensitively.
const CURATION_PATTERNS = [
  /amnesty/i,
  /withdrawal/i,
  /ferpa|family\s+educational/i,
  /parking/i,
  /dorm|residence\s+hall|housing/i,
  /conduct/i,
  /grade\s+appeal/i,
  /title\s*ix/i,
  /financial\s+aid/i,
  /leave\s+of\s+absence/i,
  /sick\s+leave/i,
  /travel/i,
  /acceptable\s+use|computing/i,
  /intellectual\s+property/i,
  /conflict\s+of\s+interest/i,
  /harassment/i,
  /telework|remote\s+work/i,
  /parental\s+leave|paternity|maternity/i,
  /grievance/i,
  /academic\s+integrity|honesty/i,
  /transcripts?/i,
  /retention/i,
];

const SYSTEM_PROMPT = `You are an assistant that answers questions about Mississippi State University Operating Policies, using ONLY the PDFs attached to this Project as your source.

Rules:
1. Answer exclusively from the attached PDFs. Do not draw on outside knowledge of MSU, of universities in general, or of similar policies elsewhere.
2. For any normative claim ("the policy says X", deadlines, eligibility criteria, dollar amounts, exceptions), QUOTE VERBATIM from the PDF text in quotation marks and cite the OP number (e.g., "OP 91.100").
3. If the attached PDFs don't clearly answer the question, say so plainly and recommend contacting the responsible office. Do NOT extrapolate.
4. This bundle is a small curated subset — not the full MSU policy corpus. If the user's question may have a more authoritative answer in a policy not attached here, say so explicitly.
5. Disclaimer: this is unofficial. Always verify against https://www.policies.msstate.edu/current before acting.
`;

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, "..", "dist-bundle");
  const stagingDir = resolve(outDir, "staging");
  mkdirSync(stagingDir, { recursive: true });

  const res = await fetch(`${BASE}/current`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for /current`);
  const html = await res.text();
  const $ = cheerioLoad(html);

  const candidates = [];
  $("#datatable tbody tr").each((_i, tr) => {
    const $tr = $(tr);
    const number = $tr.find("td:nth-child(1)").text().trim();
    if (!/^\d{2}\.(\d{2}|\d{3})$/.test(number)) return;
    const title = $tr.find("td:nth-child(2) a").text().trim();
    const pdfHref = $tr.find("td:last-child a.btn-download").attr("href");
    if (!pdfHref) return;
    const pdfUrl = pdfHref.startsWith("http") ? pdfHref : BASE + pdfHref;
    candidates.push({ number, title, pdfUrl });
  });

  const seenSlugs = new Set();
  const picked = [];
  for (const pat of CURATION_PATTERNS) {
    for (const c of candidates) {
      if (pat.test(c.title) && !seenSlugs.has(c.number)) {
        picked.push(c);
        seenSlugs.add(c.number);
      }
    }
  }
  console.error(`build-project-bundle: picked ${picked.length} policies`);

  for (const p of picked) {
    const buf = await (await fetch(p.pdfUrl, { headers: { "User-Agent": UA } })).arrayBuffer();
    const safe =
      p.number.replace(/\./g, "_") +
      " - " +
      p.title.replace(/[^a-z0-9 ]/gi, "").slice(0, 60).trim();
    writeFileSync(resolve(stagingDir, `${safe}.pdf`), Buffer.from(buf));
  }

  writeFileSync(resolve(stagingDir, "SYSTEM_PROMPT.txt"), SYSTEM_PROMPT);
  writeFileSync(
    resolve(stagingDir, "README.txt"),
    `MSU Operating Policies — Claude Project starter\n\nDrag every PDF in this folder into a new Claude Project, then paste\nSYSTEM_PROMPT.txt into the Project's system instructions.\n\nThis is an UNOFFICIAL curated subset of MSU's published policies\n(${picked.length} of approximately ${candidates.length} total). For\nanything not covered here, see https://www.policies.msstate.edu/current.\n`,
  );

  const outZip = resolve(outDir, "msstate-policies-starter.zip");
  const zip = spawnSync("zip", ["-r", outZip, "."], { cwd: stagingDir, stdio: "inherit" });
  if (zip.status !== 0) {
    console.error("build-project-bundle: `zip` command failed; install zip or implement a JS fallback");
    process.exit(1);
  }
  console.error(`build-project-bundle: wrote ${outZip}`);
}

main().catch((err) => {
  console.error("build-project-bundle: fatal", err);
  process.exit(1);
});
