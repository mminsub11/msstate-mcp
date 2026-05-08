/**
 * Runtime query embedding via OpenAI text-embedding-3-small.
 *
 * If OPENAI_API_KEY is unset, we silently fall back to BM25-only retrieval
 * (search.ts handles the null return). Tools never throw on missing key.
 */

import { httpPostJson } from "./http.js";
import { log } from "./log.js";

export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIM = 1536;
const OPENAI_URL = "https://api.openai.com/v1/embeddings";

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

let warnedOnce = false;

export async function embedQuery(text: string): Promise<number[] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    if (!warnedOnce) {
      log("warn", "OPENAI_API_KEY missing; semantic retrieval disabled (BM25-only)");
      warnedOnce = true;
    }
    return null;
  }
  try {
    const res = await httpPostJson<OpenAIEmbeddingResponse>(
      OPENAI_URL,
      { input: text, model: EMBED_MODEL },
      { Authorization: `Bearer ${key}` },
    );
    const vec = res.data?.[0]?.embedding;
    if (!vec || !Array.isArray(vec)) {
      log("warn", "OpenAI returned no embedding; degrading to BM25-only");
      return null;
    }
    return vec;
  } catch (err) {
    log("warn", "embed query failed; degrading to BM25-only", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Embed an array of texts in one request. Used by scripts/build-embeddings.mjs.
 * Returns null when the key is missing — the script must check.
 */
export async function embedBatch(texts: string[]): Promise<number[][] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const res = await httpPostJson<OpenAIEmbeddingResponse>(
    OPENAI_URL,
    { input: texts, model: EMBED_MODEL },
    { Authorization: `Bearer ${key}` },
  );
  return res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}
