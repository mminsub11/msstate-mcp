import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import envPaths from "env-paths";
import { log } from "./log.js";

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface TTLCacheOptions {
  ttlMs: number;
  /**
   * When set, the cache persists to disk under
   * `${persistDir or env-paths('msstate-policies-mcp').cache}/${persistKey}.json`.
   * Per PLAN.md the policy-body cache opts in via env var; the index cache
   * stays in-memory because its values include cheerio-derived Maps.
   */
  persistKey?: string;
  /**
   * Override the env-paths cache directory. Mainly for tests so the host
   * machine's real cache dir isn't touched.
   */
  persistDir?: string;
}

export class TTLCache<T> {
  private store = new Map<string, Entry<T>>();
  private ttlMs: number;
  private persistPath: string | null = null;

  constructor(optsOrTtlMs: number | TTLCacheOptions) {
    if (typeof optsOrTtlMs === "number") {
      this.ttlMs = optsOrTtlMs;
      return;
    }
    this.ttlMs = optsOrTtlMs.ttlMs;
    if (!optsOrTtlMs.persistKey) return;

    try {
      const baseDir =
        optsOrTtlMs.persistDir ?? envPaths("msstate-policies-mcp").cache;
      mkdirSync(baseDir, { recursive: true });
      this.persistPath = pathResolve(baseDir, `${optsOrTtlMs.persistKey}.json`);
      this.loadFromDisk();
    } catch (err) {
      // Disk persistence is best-effort; degrade to in-memory rather than fail
      // construction. Surface to stderr so an operator sees it.
      this.persistPath = null;
      log("warn", "TTLCache disk persistence disabled", {
        persistKey: optsOrTtlMs.persistKey,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) {
      this.store.delete(key);
      this.saveToDisk();
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.saveToDisk();
  }

  clear(): void {
    this.store.clear();
    if (this.persistPath && existsSync(this.persistPath)) {
      try {
        rmSync(this.persistPath);
      } catch {
        // best-effort
      }
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, "utf8");
      const arr = JSON.parse(raw) as Array<{ key: string; entry: Entry<T> }>;
      if (!Array.isArray(arr)) return;
      const now = Date.now();
      for (const item of arr) {
        if (
          item &&
          typeof item.key === "string" &&
          item.entry &&
          typeof item.entry.expiresAt === "number" &&
          item.entry.expiresAt > now
        ) {
          this.store.set(item.key, item.entry);
        }
      }
    } catch {
      // Corrupt file -> treat as empty, don't crash construction.
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      const arr = Array.from(this.store.entries()).map(([key, entry]) => ({
        key,
        entry,
      }));
      writeFileSync(this.persistPath, JSON.stringify(arr));
    } catch {
      // Best-effort. Don't throw from get/set.
    }
  }
}
