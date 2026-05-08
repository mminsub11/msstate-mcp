#!/usr/bin/env node
/**
 * Build dist/embeddings.json. Requires OPENAI_API_KEY.
 *
 * 1. Fetches the current index from policies.msstate.edu.
 * 2. Downloads each PDF, extracts text via pdf-parse.
 * 3. Chunks each policy into ~1k-token windows with 200-token overlap
 *    (we approximate tokens by characters/4 to avoid a tokenizer dep).
 * 4. Calls OpenAI text-embedding-3-small in batches of 100.
 * 5. Writes msstate-policies/dist/embeddings.json with the schema in src/search.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as cheerioLoad } from "cheerio";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("build-embeddings: OPENAI_API_KEY not set; aborting");
  process.exit(1);
}

const MODEL = "text-embedding-3-small";
const DIM = 1536;
const BASE = "https://www.policies.msstate.edu";
const UA = "msstate-policies-mcp/0.1.0 (build-embeddings)";

const CHARS_PER_TOKEN = 4;
const CHUNK_TOKENS = 1000;
const OVERLAP_TOKENS = 200;
const CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

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

function chunkText(text) {
  const out = [];
  if (!text) return out;
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + CHUNK_CHARS);
    const piece = text.slice(start, end).trim();
    if (piece.length > 0) out.push(piece);
    if (end >= text.length) break;
    start = end - OVERLAP_CHARS;
  }
  return out;
}

async function embedBatch(inputs) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ input: inputs, model: MODEL }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function main() {
  const html = await fetchText(`${BASE}/current`);
  const $ = cheerioLoad(html);
  const rows = [];
  $("#datatable tbody tr").each((_i, tr) => {
    const $tr = $(tr);
    const number = $tr.find("td:nth-child(1)").text().trim();
    if (!/^\d{2}\.(\d{2}|\d{3})$/.test(number)) return;
    const slug = number.replace(/\./g, "");
    const pdfHref = $tr.find("td:last-child a.btn-download").attr("href");
    if (!pdfHref) return;
    rows.push({
      number,
      slug,
      pdfUrl: pdfHref.startsWith("http") ? pdfHref : BASE + pdfHref,
    });
  });
  console.error(`build-embeddings: ${rows.length} policies`);

  const chunks = [];
  let i = 0;
  for (const row of rows) {
    i++;
    try {
      const buf = await fetchBuffer(row.pdfUrl);
      const parsed = await pdfParse(buf);
      const text = (parsed.text || "").normalize("NFKC");
      const pieces = chunkText(text);
      pieces.forEach((piece, idx) => {
        chunks.push({ slug: row.slug, chunkIndex: idx, text: piece });
      });
      if (i % 20 === 0) console.error(`build-embeddings: extracted ${i}/${rows.length}`);
    } catch (err) {
      console.error(`build-embeddings: skip ${row.number}: ${err.message ?? err}`);
    }
  }
  console.error(`build-embeddings: ${chunks.length} chunks total; embedding...`);

  const BATCH = 100;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const vectors = await embedBatch(slice.map((c) => c.text));
    vectors.forEach((v, j) => {
      slice[j].vector = v;
    });
    console.error(
      `build-embeddings: embedded ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`,
    );
  }

  const outDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "msstate-policies",
    "dist",
  );
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "embeddings.json");
  const out = {
    model: MODEL,
    dim: DIM,
    builtAt: new Date().toISOString(),
    chunks,
  };
  writeFileSync(outPath, JSON.stringify(out));
  console.error(`build-embeddings: wrote ${outPath} (${chunks.length} chunks)`);
}

main().catch((err) => {
  console.error("build-embeddings: fatal", err);
  process.exit(1);
});
