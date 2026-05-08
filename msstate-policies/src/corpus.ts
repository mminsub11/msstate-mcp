/**
 * Lazy body fetcher with optional disk cache.
 *
 *  - In-memory cache (24h) lives in scraper.ts.
 *  - This module adds an opt-in on-disk layer (MSU_DISK_CACHE=1) under a
 *    cross-platform cache dir via `env-paths` so Windows users land in
 *    LOCALAPPDATA, not ~/.cache/. Disk cache survives process restart.
 *  - Concurrency is bounded by http.ts (4 in flight); we don't add a second
 *    pool here.
 */

import envPaths from "env-paths";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fetchPolicy } from "./scraper.js";
import { attachBody } from "./search.js";
import { log } from "./log.js";
import { PolicyDocument } from "./types.js";

const DISK_TTL_MS = 24 * 60 * 60 * 1000;

let cacheRoot: string | null = null;

function diskCacheEnabled(): boolean {
  return process.env.MSU_DISK_CACHE === "1";
}

function ensureCacheDir(): string {
  if (cacheRoot) return cacheRoot;
  const paths = envPaths("msstate-policies-mcp", { suffix: "" });
  cacheRoot = join(paths.cache, "policies");
  try {
    mkdirSync(cacheRoot, { recursive: true });
  } catch (err) {
    log("warn", "could not create disk cache dir; running memory-only", {
      dir: cacheRoot,
      err: err instanceof Error ? err.message : String(err),
    });
    cacheRoot = null;
    return "";
  }
  return cacheRoot;
}

function diskPath(slug: string): string | null {
  if (!diskCacheEnabled()) return null;
  const dir = ensureCacheDir();
  if (!dir) return null;
  return join(dir, `${slug}.json`);
}

function readDiskCache(slug: string): PolicyDocument | null {
  const p = diskPath(slug);
  if (!p || !existsSync(p)) return null;
  try {
    const stat = statSync(p);
    if (Date.now() - stat.mtimeMs > DISK_TTL_MS) return null;
    return JSON.parse(readFileSync(p, "utf8")) as PolicyDocument;
  } catch (err) {
    log("warn", "disk cache read failed", {
      slug,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function writeDiskCache(doc: PolicyDocument): void {
  const p = diskPath(doc.slug);
  if (!p) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(doc));
  } catch (err) {
    log("warn", "disk cache write failed", {
      slug: doc.slug,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getPolicy(numberOrSlug: string): Promise<PolicyDocument> {
  const slugCandidate = numberOrSlug.replace(/\./g, "");
  const cached = readDiskCache(slugCandidate);
  if (cached) {
    attachBody(cached.slug, cached.text);
    return cached;
  }
  const doc = await fetchPolicy(numberOrSlug);
  writeDiskCache(doc);
  attachBody(doc.slug, doc.text);
  return doc;
}

export async function getPolicies(slugs: string[]): Promise<PolicyDocument[]> {
  return Promise.all(slugs.map((s) => getPolicy(s)));
}

export function getCorpusHealth(): { diskCacheEnabled: boolean; cacheRoot: string | null } {
  return {
    diskCacheEnabled: diskCacheEnabled(),
    cacheRoot: cacheRoot,
  };
}
