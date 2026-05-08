import { test } from "node:test";
import assert from "node:assert/strict";
import { getRetrievalMode } from "../src/search.js";

const ENV_KEY = "MSSTATE_POLICIES_RETRIEVAL";

function withEnv(value: string | undefined, fn: () => void): void {
  const prior = process.env[ENV_KEY];
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
  try {
    fn();
  } finally {
    if (prior === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = prior;
    }
  }
}

test("getRetrievalMode: default is hybrid when env var unset", () => {
  withEnv(undefined, () => {
    assert.equal(getRetrievalMode(), "hybrid");
  });
});

test("getRetrievalMode: 'bm25' (case-insensitive) selects BM25-only mode", () => {
  withEnv("bm25", () => assert.equal(getRetrievalMode(), "bm25"));
  withEnv("BM25", () => assert.equal(getRetrievalMode(), "bm25"));
  withEnv("Bm25", () => assert.equal(getRetrievalMode(), "bm25"));
});

test("getRetrievalMode: 'embed' selects embeddings-only mode", () => {
  withEnv("embed", () => assert.equal(getRetrievalMode(), "embed"));
  withEnv("EMBED", () => assert.equal(getRetrievalMode(), "embed"));
});

test("getRetrievalMode: unrecognized value falls back to hybrid (defensive default)", () => {
  withEnv("nonsense", () => assert.equal(getRetrievalMode(), "hybrid"));
  withEnv("", () => assert.equal(getRetrievalMode(), "hybrid"));
});
