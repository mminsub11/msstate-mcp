import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMatchedPassages } from "../src/search.js";

test("extractMatchedPassages windows around query-token hits, merges overlap, and capacity-limits", () => {
  const text =
    "Mississippi State University tornado warning protocols. Faculty and staff should follow the policy in OP 01.04 for evacuation. Emergency response is coordinated through campus security.";

  const passages = extractMatchedPassages(text, ["tornado", "evacuation"], {
    window: 30,
    maxPassages: 5,
  });

  assert.ok(passages.length >= 1, "expected at least one passage");
  assert.ok(
    passages.some((p) => p.text.toLowerCase().includes("tornado")),
    "tornado must appear in some passage",
  );
  assert.ok(
    passages.some((p) => p.text.toLowerCase().includes("evacuation")),
    "evacuation must appear in some passage",
  );
  assert.ok(
    passages.every((p) => p.text.length <= 200),
    "no passage should exceed window*2 + token + merge slack",
  );
  assert.ok(
    passages.every((p) => p.matchedTokens.length > 0),
    "every passage must record which tokens matched",
  );

  // Empty inputs return empty results.
  assert.deepEqual(extractMatchedPassages(text, [], { window: 30 }), []);
  assert.deepEqual(extractMatchedPassages("", ["tornado"], { window: 30 }), []);

  // Whole-word matching: "ration" must NOT match inside "evacuation".
  const noBleed = extractMatchedPassages(text, ["ration"], { window: 30 });
  assert.equal(noBleed.length, 0, "substring matches must not bleed across word boundaries");

  // maxPassages cap is honored.
  const richText = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  const capped = extractMatchedPassages(
    richText,
    ["alpha", "bravo", "charlie", "delta", "echo"],
    { window: 1, maxPassages: 2 },
  );
  assert.ok(capped.length <= 2, "maxPassages must cap the result count");
});
