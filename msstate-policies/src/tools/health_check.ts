import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fetchIndex, getScraperHealth } from "../scraper.js";
import { getSearchHealth } from "../search.js";
import { getCorpusHealth } from "../corpus.js";
import { HealthState } from "../types.js";

const HealthInput = z.object({}).strict();

declare const __VERSION__: string;
declare const __GIT_SHA__: string;

function safeIdent(name: "__VERSION__" | "__GIT_SHA__"): string {
  // esbuild substitutes these via define; if it didn't (e.g. in tests),
  // fall back to env or "unknown".
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return typeof ${name} !== "undefined" ? ${name} : ""`)();
  } catch {
    return process.env[name] ?? "unknown";
  }
}

export const health_check = {
  name: "health_check",
  description:
    "Report the scraper's current health: cached index size, last fetch time, last error, taxonomy size, cache stats, and version. Use this when answers seem suspiciously empty (the scraper may be broken) or when you want to verify the server is reaching MSU.",
  inputSchema: zodToJsonSchema(HealthInput, { target: "openApi3" }),
  zodSchema: HealthInput,
  async handler(_input: unknown) {
    let rowCount = 0;
    let volumes = 0;
    let sections = 0;
    try {
      const idx = await fetchIndex();
      rowCount = idx.rows.length;
      volumes = idx.volumes.length;
      sections = idx.sections.length;
    } catch {
      // last_index_error already populated by scraper.ts
    }
    const sh = getScraperHealth();
    const sr = getSearchHealth();
    const co = getCorpusHealth();

    const total = sh.cacheHits + sh.cacheMisses;
    const hitRate = total > 0 ? Number((sh.cacheHits / total).toFixed(3)) : 0;

    const state: HealthState & {
      embeddings_loaded: boolean;
      embedding_chunks: number;
      disk_cache_enabled: boolean;
    } = {
      index_row_count: rowCount,
      last_index_fetch: sh.lastIndexFetch,
      last_index_error: sh.lastIndexError,
      volumes_discovered: volumes,
      sections_discovered: sections,
      cache_hit_rate: hitRate,
      pdf_parse_fallback_count: sh.pdfFallbackCount,
      version: safeIdent("__VERSION__") || "unknown",
      git_sha: safeIdent("__GIT_SHA__") || "unknown",
      embeddings_loaded: sr.embeddingsLoaded,
      embedding_chunks: sr.embeddingChunks,
      disk_cache_enabled: co.diskCacheEnabled,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
    };
  },
};
