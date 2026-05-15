import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  setOnlineCorpus,
  getOnlineCorpus,
  getProgramBySlug,
  listAllPrograms,
  getAdmissionsProcess,
  getAllInfoPages,
  getAllStaff,
  onlineCorpusHealth,
} from "../../src/online/corpus.js";
import type { OnlineCorpus } from "../../src/online/types.js";

const SAMPLE: OnlineCorpus = {
  builtAt: "2026-05-13T00:00:00.000Z",
  source: "https://www.online.msstate.edu/",
  programs: [
    {
      slug: "mba", name: "Master of Business Administration",
      degree_level: "master", format: "Fully online", short_description: "MBA",
      url: "https://www.online.msstate.edu/mba",
      tuition: { per_credit_usd: 581, instructional_fee_per_credit_usd: 25, application_fee_domestic_usd: 60, application_fee_international_usd: 80, raw_prose: "" },
      contacts: [], application_deadlines: [], admission_requirements: "",
      entrance_exams: null, accreditation: "AACSB", forms: [], raw_sections: {},
      parse_warnings: [], retrieved_at: "x",
    },
  ],
  admissions_process: {
    url: "https://www.online.msstate.edu/admissions-process",
    central_contact: { name: "Office of Online Education", title: "Front-desk", email: "ask@online.msstate.edu", phone: "(662) 325-3473" },
    shared_prelude: "Apply now.", sections: { undergraduate: "ug", graduate: "g", transfer: "t", readmit: "r", international: "i" },
    application_fee_tiers: [], external_apply_urls: [], retrieved_at: "x",
  },
  staff: [{ name: "Jane Doe", title: "Director", email: "jdoe@msstate.edu", phone: null, office: "O", url: "x", retrieved_at: "x" }],
  info_pages: [{ slug: "orientation", title: "Orientation", url: "x", body_markdown: "x", retrieved_at: "x" }],
  staff_to_programs: [],
};

describe("online/corpus", () => {
  test("setOnlineCorpus + getters round-trip", () => {
    setOnlineCorpus(SAMPLE);
    assert.equal(getOnlineCorpus()?.builtAt, SAMPLE.builtAt);
    assert.equal(listAllPrograms().length, 1);
    assert.equal(getAllStaff().length, 1);
    assert.equal(getAllInfoPages().length, 1);
  });
  test("getProgramBySlug returns the matching program", () => {
    setOnlineCorpus(SAMPLE);
    const p = getProgramBySlug("mba");
    assert.ok(p);
    assert.equal(p.name, "Master of Business Administration");
  });
  test("getProgramBySlug returns null for unknown slug", () => {
    setOnlineCorpus(SAMPLE);
    assert.equal(getProgramBySlug("unknown"), null);
  });
  test("getAdmissionsProcess returns the process record", () => {
    setOnlineCorpus(SAMPLE);
    const a = getAdmissionsProcess();
    assert.ok(a);
    assert.equal(a.central_contact.email, "ask@online.msstate.edu");
  });
  test("health reports loaded + counts", () => {
    setOnlineCorpus(SAMPLE);
    const h = onlineCorpusHealth();
    assert.equal(h.loaded, true);
    assert.equal(h.program_count, 1);
    assert.equal(h.staff_count, 1);
    assert.equal(h.info_page_count, 1);
    assert.equal(h.builtAt, SAMPLE.builtAt);
  });
});
