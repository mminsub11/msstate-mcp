import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as pathResolve } from "node:path";
import { TTLCache } from "../src/cache.js";

// All tests below use an explicit persistDir under tmpdir() so the host
// machine's real env-paths cache directory is never touched.

test("TTLCache backward compat: number constructor stays in-memory only", () => {
  const c = new TTLCache<number>(60_000);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
});

test("TTLCache disk persistence: write -> reload across instances", () => {
  const dir = mkdtempSync(pathResolve(tmpdir(), "ttl-disk-"));
  try {
    const c1 = new TTLCache<{ x: number }>({
      ttlMs: 60_000,
      persistKey: "k",
      persistDir: dir,
    });
    c1.set("foo", { x: 42 });

    const file = pathResolve(dir, "k.json");
    assert.ok(existsSync(file), "expected persistence file to exist");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(Array.isArray(onDisk));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].key, "foo");

    const c2 = new TTLCache<{ x: number }>({
      ttlMs: 60_000,
      persistKey: "k",
      persistDir: dir,
    });
    assert.deepEqual(c2.get("foo"), { x: 42 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TTLCache disk persistence: skips expired entries on load", () => {
  const dir = mkdtempSync(pathResolve(tmpdir(), "ttl-disk-"));
  try {
    const c1 = new TTLCache<number>({
      ttlMs: 1,
      persistKey: "k",
      persistDir: dir,
    });
    c1.set("foo", 42);
    const start = Date.now();
    while (Date.now() - start < 10) {
      // spin so wall-clock advances past the 1ms TTL
    }

    const c2 = new TTLCache<number>({
      ttlMs: 60_000,
      persistKey: "k",
      persistDir: dir,
    });
    assert.equal(c2.get("foo"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TTLCache clear() removes the disk file", () => {
  const dir = mkdtempSync(pathResolve(tmpdir(), "ttl-disk-"));
  try {
    const c = new TTLCache<number>({
      ttlMs: 60_000,
      persistKey: "k",
      persistDir: dir,
    });
    c.set("foo", 42);
    const file = pathResolve(dir, "k.json");
    assert.ok(existsSync(file));
    c.clear();
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TTLCache disk persistence: missing file on construction is fine (cold start)", () => {
  const dir = mkdtempSync(pathResolve(tmpdir(), "ttl-disk-"));
  try {
    const c = new TTLCache<number>({
      ttlMs: 60_000,
      persistKey: "k",
      persistDir: dir,
    });
    assert.equal(c.get("foo"), undefined);
    c.set("foo", 99);
    assert.equal(c.get("foo"), 99);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TTLCache disk persistence: corrupt file on disk doesn't crash", () => {
  const dir = mkdtempSync(pathResolve(tmpdir(), "ttl-disk-"));
  try {
    const file = pathResolve(dir, "k.json");
    writeFileSync(file, "{not valid json at all");
    const c = new TTLCache<number>({
      ttlMs: 60_000,
      persistKey: "k",
      persistDir: dir,
    });
    assert.equal(c.get("foo"), undefined);
    c.set("foo", 1);
    assert.equal(c.get("foo"), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
