import { test } from "node:test";
import assert from "node:assert/strict";
import { isPolicyTextUsable } from "../src/scraper.js";

test("isPolicyTextUsable rejects empty/short/whitespace text and accepts substantial text", () => {
  assert.equal(isPolicyTextUsable(""), false, "empty string must be unusable");
  assert.equal(isPolicyTextUsable("   \n\t  "), false, "whitespace-only must be unusable");
  assert.equal(isPolicyTextUsable("short"), false, "below threshold must be unusable");
  assert.equal(isPolicyTextUsable("x".repeat(199)), false, "199 chars must be just below threshold");
  const realText = "MSU Operating Policy. ".repeat(20);
  assert.equal(isPolicyTextUsable(realText), true, "substantial text must be usable");
});
