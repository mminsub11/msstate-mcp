import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { get_online_admissions_process } from "../../src/tools/get_online_admissions_process.js";
import { setOnlineCorpus } from "../../src/online/corpus.js";
import { ONLINE_DISCLAIMER } from "../../src/online/types.js";
import type { OnlineCorpus } from "../../src/online/types.js";

const SAMPLE: OnlineCorpus = {
  builtAt: "x", source: "https://www.online.msstate.edu/",
  programs: [],
  admissions_process: {
    url: "https://www.online.msstate.edu/admissions-process",
    central_contact: { name: "Office of Online Education", title: "Front-desk", email: "ask@online.msstate.edu", phone: "(662) 325-3473" },
    shared_prelude: "Apply now.",
    sections: { undergraduate: "ug body", graduate: "g body", transfer: "t body", readmit: "r body", international: "i body" },
    application_fee_tiers: [{ kind: "Undergraduate", usd: 50 }, { kind: "International", usd: 80 }],
    external_apply_urls: [{ kind: "Undergraduate application", url: "https://www.apply.msstate.edu/" }],
    retrieved_at: "x",
  },
  staff: [], info_pages: [],
};

async function call(args: unknown) {
  const res = await get_online_admissions_process.handler(args);
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("get_online_admissions_process", () => {
  test("no student_type returns all 5 sections + central contact + disclaimer", async () => {
    setOnlineCorpus(SAMPLE);
    const r = await call({});
    assert.equal(r.disclaimer, ONLINE_DISCLAIMER);
    assert.equal(r.central_contact.email, "ask@online.msstate.edu");
    for (const st of ["undergraduate", "graduate", "transfer", "readmit", "international"]) {
      assert.ok(r.sections[st]);
    }
  });
  test("student_type filter returns only that section + always the prelude/contact", async () => {
    setOnlineCorpus(SAMPLE);
    const r = await call({ student_type: "international" });
    assert.equal(r.sections.international, "i body");
    assert.equal(r.sections.undergraduate, undefined);
    assert.ok(r.shared_prelude.length > 0);
    assert.ok(r.central_contact.email);
  });
  test("application_fee_tiers + external_apply_urls always included", async () => {
    setOnlineCorpus(SAMPLE);
    const r = await call({});
    assert.ok(r.application_fee_tiers.length >= 1);
    assert.ok(r.external_apply_urls.length >= 1);
  });
  test("rejects unknown student_type via zod", async () => {
    setOnlineCorpus(SAMPLE);
    await assert.rejects(() => call({ student_type: "invalid" }));
  });
});
