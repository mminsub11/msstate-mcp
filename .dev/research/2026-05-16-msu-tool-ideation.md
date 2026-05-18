# MSU tool ideation — multi-perspective discovery

**Date:** 2026-05-16
**Method:** PM + Designer + Engineer ideation (Teresa Torres "product trio" pattern) over msstate.edu reconnaissance findings
**Input artifacts:**
- 7 existing content domains in msstate-mcp v1.1.1
- 15 uncovered subdomains identified via msstate.edu reconnaissance
- Corpus-rule constraints (only `*.msstate.edu` + officially-redirected vendor domains)

**Caveat — empirical limits of this ideation:**
- No actual user interviews; "user-asks-this-weekly" is heuristic, not measured.
- No usage data from the deployed Worker (no analytics by design).
- Assumes ~22k UG + 1.5k faculty + 5k staff segments; could be miscalibrated.
- Frequency-weighted ranking biased toward UG (largest population); faculty/staff long-tail tools likely underrepresented.

---

## Section 1 — 15 candidate ideas, 5 per perspective

### Product Manager perspective (business value + strategic alignment + audience reach)

**P1. Library suite (`get_library_hours`, `search_library_databases`, `find_library_study_space`)**
- **JTBD:** "I want to know if the library is open right now / find a relevant database / find a study room I can book — without leaving Claude."
- **Domain coverage:** A (Library)
- **Segments:** UG ✓✓✓, Grad ✓✓✓, Faculty ✓✓, Staff ✓, Prospective ✓, Visitor ✓
- **Why PM:** Largest weekly audience (every active student touches the library at some point in a semester; ~daily for finals weeks). Three sub-tools share the same source domain so build cost amortizes.

**P2. People directory (`find_msu_person`)**
- **JTBD:** "Who is the department chair of ME?" / "What's Dr. Smith's email in CSE?" / "Who handles parking appeals?"
- **Domain coverage:** J (People Directory)
- **Segments:** UG ✓, Grad ✓✓, Faculty ✓✓✓, Staff ✓✓✓, Prospective ✓, Visitor ✓
- **Why PM:** Universal — every email triage moment, every "who do I contact for X" question. Currently solved by `directory.msstate.edu` which is awkward to navigate. Strategic: positions msstate-mcp as the de-facto MSU lookup layer.

**P3. Financial aid depth (`find_msu_scholarship`, `get_financial_aid_step`, `get_msu_sap_policy`, `find_aid_faq`)**
- **JTBD:** "What scholarships am I eligible for as a transfer student?" / "Walk me through the FAFSA steps." / "What happens to my aid if my GPA drops below 2.0?"
- **Domain coverage:** D (Financial Aid)
- **Segments:** UG ✓✓, Grad ✓, Faculty —, Staff —, Prospective ✓✓✓, Visitor —
- **Why PM:** Highest stakes. Prospective students + parents agonize over aid. Strategic differentiation: every other generic LLM hallucinates aid amounts/policies; msstate-mcp would have authoritative numbers.

**P4. Building locator + hours (`get_msu_building`, `find_nearest_building`)**
- **JTBD:** "Where is McCool Hall?" / "What's the closest computer lab to Allen?" / "Is Mitchell Memorial Library open until 2am?"
- **Domain coverage:** I (Maps & Building Locator)
- **Segments:** UG ✓✓, Grad ✓, Faculty ✓, Staff ✓, Prospective ✓✓✓, Visitor ✓✓✓
- **Why PM:** Foundational — enables cross-domain answers ("nearby dining," "nearby library," "nearby parking"). Onboarding/visiting use case is huge: campus tours, parents, transfer orientation.

**P5. Bursar / payment-plan extension (`get_msu_payment_plan`, `get_msu_refund_schedule`)**
- **JTBD:** "What payment plans are available?" / "If I drop a class in week 3, how much do I get back?" / "When's the tuition deadline for fall?"
- **Domain coverage:** N (Bursar / Account Services)
- **Segments:** UG ✓✓, Grad ✓, Faculty —, Staff —, Prospective ✓✓, Visitor —
- **Why PM:** Money-shaped → high stakes → high trust requirement → perfect fit for the corpus rule. Tight thematic fit with existing tuition module; same `controller.msstate.edu` source.

---

### Product Designer perspective (UX + delight + anticipating the next question)

**D1. Campus quick-info combo (`get_campus_quick_info`)**
- **JTBD:** "I'm in McCool Hall right now — what's open nearby for dining, study, or coffee?"
- **Domain coverage:** A (Library) + Dining (existing) + I (Maps) + M (Recreation) — composite
- **Segments:** UG ✓✓, Grad ✓, Faculty ✓, Staff ✓, Prospective ✓✓, Visitor ✓✓
- **Why Designer:** Single tool answering a compound question the model would otherwise have to chain 3 separate calls to answer. Reduces friction at the LLM-orchestration layer.

**D2. Student-org finder (`find_msu_organization`)**
- **JTBD:** "I'm a freshman interested in robotics — what clubs should I check out?" / "When's the next sorority recruitment?" / "How do I register a new org?"
- **Domain coverage:** H (Student Organizations + Greek Life)
- **Segments:** UG ✓✓✓, Grad ✓, Faculty —, Staff —, Prospective ✓, Visitor —
- **Why Designer:** Discoverability problem — 400+ orgs, hard to browse. BM25 by interest keyword + fuzzy match on org names creates delight ("oh, I didn't know that existed").

**D3. Health & wellness first-step (`get_msu_health_service`, `get_msu_counseling_intake`)**
- **JTBD:** "I'm having a hard time — what does counseling look like at MSU and how do I start?" / "Is there an after-hours mental health line?"
- **Domain coverage:** G (Health & Wellness)
- **Segments:** UG ✓✓, Grad ✓, Faculty —, Staff ✓, Prospective ✓, Visitor —
- **Why Designer:** Sensitive domain demanding extreme care. Tool response must always lead with the 911/crisis-line reminder (mirror the emergency-module pattern). Get the UX right and this saves a life every now and then. Get it wrong and we erode trust.

**D4. Forms aggregator (`find_msu_form`)**
- **JTBD:** "Where's the form to drop a class after the deadline?" / "Form for graduate program of study?" / "Form for FERPA release?"
- **Domain coverage:** O (Forms aggregator) — cross-cuts every Drupal subdomain
- **Segments:** UG ✓, Grad ✓, Faculty ✓✓, Staff ✓✓, Prospective ✓, Visitor —
- **Why Designer:** Kills the "where's the form for X" hunt. Form-hunting is one of the most universally hated administrative UX patterns. A single BM25 search across all `*.msstate.edu` `*.pdf` form URLs is a clear UX win.

**D5. Recreation finder (`get_msu_rec_info`)**
- **JTBD:** "When's the next yoga class at Sanderson?" / "How do I sign up for intramural soccer?" / "Is the Sanderson pool open today?"
- **Domain coverage:** M (Recreation)
- **Segments:** UG ✓✓, Grad ✓, Faculty ✓, Staff ✓, Prospective —, Visitor —
- **Why Designer:** Calendar-shaped UX (class schedule + intramural seasons + hours). Reuses the dining `status_now` pattern for "is it open right now."

---

### Software Engineer perspective (technical feasibility + pattern reuse + scrape leverage)

**E1. People directory (`find_msu_person`)** — *converges with P2*
- **JTBD:** same as P2
- **Why Engineer:** Lowest-cost / highest-leverage. Likely Drupal-backed table or LDAP-fronted HTML. Mirrors the `online/list_programs_by_staff` inverted-index pattern shipped in v1.1.1. Structured fields (name/title/email/phone/dept) — no parser surprises. ~30 LOC parser, ~80 LOC tool.

**E2. Library suite (`get_library_hours`, `search_library_databases`)** — *converges with P1*
- **JTBD:** same as P1
- **Why Engineer:** Clean HTML, table-shaped data. Hours mirror the dining `status_now` pattern (one location at a time). Databases A-Z is a single page with stable structure — mirrors the courses A-Z index pattern. ~150 LOC for both tools.

**E3. IT services FAQ (`find_msu_it_answer`)**
- **JTBD:** "How do I reset my NetID password?" / "How do I install Adobe?" / "Wi-Fi setup on Linux?"
- **Domain coverage:** C (IT Services)
- **Segments:** UG ✓, Grad ✓, Faculty ✓, Staff ✓, Prospective —, Visitor —
- **Why Engineer:** Trivial pattern — BM25 over the existing IT documentation pages. Identical shape to `find_msu_tuition_faq`. ~30 LOC. Low-cost addition with measurable benefit (Service Desk tickets typically include "I couldn't find the answer in the docs").

**E4. Parking + SMART transit (`get_msu_parking_info`, `get_smart_transit_schedule`)**
- **JTBD:** "What's the parking permit cost for a commuter?" / "When does the SMART bus from Cotton District run?" / "How do I appeal a parking ticket?"
- **Domain coverage:** B (Parking & Transportation)
- **Segments:** UG ✓✓✓, Grad ✓✓, Faculty ✓✓, Staff ✓✓, Prospective ✓, Visitor ✓
- **Why Engineer:** Table-shaped permit data on transportation.msstate.edu + TransLoc bus schedule data (likely a JSON endpoint or scrapable timetable). The SMART transit half is the highest-value: every commuter student wants "when's the next bus."

**E5. Maps (`get_msu_building`)** — *converges with P4*
- **JTBD:** same as P4
- **Why Engineer:** Drupal probably ships a building-list CSV or geocoded JSON; combine with the published PDF campus map for accessibility-entrance data. Reuses the dining `status_now` pattern for building hours. Once buildings are in the corpus, every other domain can be `nearest_to(building)` aware.

---

## Section 2 — Cross-perspective agreement matrix

| Idea | PM | Designer | Engineer | All-agree? |
|---|---|---|---|---|
| **Library suite** | P1 ✓ | (D1 composite) | E2 ✓ | **Strong** |
| **People directory** | P2 ✓ | (universal need; reduces lookup friction) | E1 ✓ | **Strong** |
| **Building locator / Maps** | P4 ✓ | D1 (composite uses it) | E5 ✓ | **Strong** |
| **Parking + SMART transit** | (universal pain — PM-implicit) | (daily commuter UX) | E4 ✓ | **Strong** |
| **Financial aid depth** | P3 ✓ | (high-stakes UX) | (mirrors tuition module pattern) | **Strong** |
| Bursar/payment plan | P5 ✓ | (low-key) | (low-key) | Mid |
| Campus quick-info combo | (P4 enables it) | D1 ✓ | (assembles existing) | Mid |
| Student-org finder | (low) | D2 ✓ | (mid feasibility) | Single-perspective |
| Health & wellness | (sensitive) | D3 ✓ | (mid feasibility) | Single-perspective |
| Forms aggregator | (low) | D4 ✓ | (medium — cross-domain index) | Single-perspective |
| Recreation finder | (low) | D5 ✓ | (medium) | Single-perspective |
| IT services FAQ | (medium) | (medium) | E3 ✓ | Single-perspective |

**5 ideas with strong cross-perspective agreement** (carry forward to prioritize-features):

1. **People directory** — every perspective sees this as the highest-leverage win
2. **Library suite** — broadest weekly audience
3. **Building locator (Maps)** — foundational; unlocks cross-domain "nearby X" queries
4. **Parking + SMART transit** — universal pain across all on-campus segments
5. **Financial aid depth** — highest-stakes domain; strategic differentiation for prospective + parents

---

## Section 3 — Top 5 selected ideas: detailed rationale + key assumptions

### Top 1: People directory — `find_msu_person`

**Description.** Search MSU's public employee directory by name (first, last, full), email, department, or title. Returns matching staff/faculty with their name, title, department, email, phone, office location. Mirrors `list_programs_by_staff` from v1.1.1 — same email-primary, name-fallback, diacritic-normalized resolution.

**Why selected.** Hits all three perspectives. Universal weekly use across every segment. Reuses a proven pattern. Smallest implementation effort relative to impact (~3 days work). Faculty/staff segments are currently *least* served by msstate-mcp; this addresses that imbalance.

**Key assumptions to validate:**
- A1: `directory.msstate.edu` (or `msstate.edu/directory`) returns scrapable HTML for the employee directory, not gated behind JS/auth.
- A2: Result count fits in the corpus (likely a few thousand employees — manageable).
- A3: Privacy: the public directory is intentionally public. We're not re-publishing student data (which is auth-walled — we must enforce that).

**Verification step before building:**
- Hit `directory.msstate.edu` or `msstate.edu/directory` with curl + cheerio. Confirm structured HTML + record count. (Quick spike, ~30 min.)

---

### Top 2: Library suite — `get_library_hours`, `search_library_databases`

**Description.**
- `get_library_hours(location?)` — returns today's open/close + this-week schedule for Mitchell Memorial Library + Architecture branch + any other locations. `status_now` field for "is it open right now."
- `search_library_databases(subject?, keyword?)` — BM25 over the Databases A-Z list. Returns name, description, subject tags, off-campus access URL.

**Why selected.** Mitchell Library has ~2k visitors per day during semester (likely; not measured). Every student asks "is the library open" at least once a semester, often weekly during finals. The databases tool is gold for grad students and researchers who currently navigate a 4-click maze.

**Key assumptions to validate:**
- A1: Hours page parses cleanly (HTML table per location, or JSON if Springshare-backed).
- A2: A-Z databases page is scrapable HTML (likely Springshare's LibGuides — usually structured).
- A3: No vendor lock concerns — we link to MSU's library pages, not direct database URLs that require off-campus VPN.

**Verification step:**
- Curl + parse a few sample fixtures. Check if Springshare hosts under `*.msstate.edu` (it usually does via reverse-proxy: `library.msstate.edu/research-tools/databases`).

---

### Top 3: Building locator (Maps) — `get_msu_building`, `find_nearest_building`

**Description.**
- `get_msu_building(name_or_query)` — returns building's full name, abbreviation, coordinates, primary departments/services housed inside, hours if public-access, accessibility info.
- `find_nearest_building(reference, kind?)` — given a building name + an optional kind filter ("dining", "library", "parking", "computer_lab"), returns the closest match by walking distance.

**Why selected.** Foundational for the whole corpus. Once buildings are indexed with coordinates, every other module gets "nearby X" awareness essentially free. Visitor/prospective-student use case (campus tours, parents at orientation) is significant; faculty/staff use it for new-employee onboarding.

**Key assumptions to validate:**
- A1: MSU publishes a building list (CSV/JSON/HTML) at `msstate.edu/maps` or a similar canonical URL.
- A2: Coordinates are published. If not, geocoding from addresses is acceptable but introduces a non-MSU dependency (Google/Nominatim) — that breaches the corpus rule unless we cache results at build time and treat as MSU-authoritative.
- A3: Building hours are published per-building (varies; some buildings have no public hours).

**Verification step:**
- Visit `msstate.edu/maps` + browse the buildings PDF + search for a structured data dump. If coordinates are not publicly available, scope down to name/abbreviation/department-housed and defer coordinate-aware queries.

---

### Top 4: Parking + SMART transit — `get_msu_parking_info`, `get_smart_transit_schedule`

**Description.**
- `get_msu_parking_info(permit_type?, lot?)` — permit types/costs/eligibility, parking zone descriptions, citation-appeal process, gameday parking rules.
- `get_smart_transit_schedule(route?, stop?)` — SMART transit route names + stops + this-week schedule + next-bus-from-stop computation (mirror dining `status_now` pattern).

**Why selected.** Parking is universally hated — and even modest help ("which zone can I park in with a Z permit") moves real frustration. SMART transit is the highest-value half: commuter students depend on it weekly, often daily. TransLoc usually exposes a JSON API for live routes that can be polled (officially MSU-authoritative if MSU contracts TransLoc).

**Key assumptions to validate:**
- A1: Parking permit pricing/zone-eligibility is published on `transportation.msstate.edu` as scrapable HTML.
- A2: SMART transit schedules are published as HTML (timetables) AND/OR via TransLoc's JSON API. TransLoc data should count as MSU-authoritative under the expanded corpus rule (MSU contracts them; their data IS MSU's data, like the dining vendor case).
- A3: Live next-bus-arrival data requires a runtime API call (not baked corpus). This is a new pattern — most existing tools are baked-corpus. If we want live data, we need a runtime-fetch path with a 30-second cache and a fail-closed fallback. Significant architectural decision.

**Verification step:**
- Inspect `transportation.msstate.edu` HTML + check TransLoc's public API for `*.msstate.edu`-scoped data.

---

### Top 5: Financial aid depth — `find_msu_scholarship`, `get_financial_aid_step`, `find_aid_faq`

**Description.**
- `find_msu_scholarship(level?, criteria_keyword?)` — search MSU's published scholarship catalog by student type (entering freshman / transfer / current / graduate / departmental) and keyword.
- `get_financial_aid_step(step_id_or_query)` — return the FAFSA / verification / loan / work-study process step-by-step (mirrors emergency-guidance-by-slug pattern).
- `find_aid_faq(query)` — BM25 over MSU's published aid FAQ (if it exists; otherwise reuse the published step pages).

**Why selected.** Highest stakes among all candidates. Every generic LLM today hallucinates scholarship eligibility rules and FAFSA timelines — the citation-grounded answer is a strong differentiator. Prospective students + parents are an underserved segment in the current msstate-mcp; this directly addresses that.

**Key assumptions to validate:**
- A1: `sfa.msstate.edu` publishes a scholarship list (it does — reconnaissance confirmed "Scholarships" section with entering freshmen / transfer / current / external buckets).
- A2: Scholarship details are stable enough to bake (rather than fetched live). Annual award amounts may change; we surface `effective_term` like the tuition module does.
- A3: Disclaimer wording: financial aid is the most-volatile high-stakes content. Build-time guards must abort on missing critical fields (amount, deadline, eligibility). Mirror the `TUITION_DISCLAIMER` pattern.

**Verification step:**
- Hit `sfa.msstate.edu/scholarships` (or whatever the listing URL is). Confirm scrapable HTML. Estimate scholarship count.

---

## Section 4 — Surprising adjacencies

Cross-domain combinations that are much more valuable as ONE tool than as a sequence of tool calls:

| Combo | Example query | Tool sketch |
|---|---|---|
| **Maps + Dining + Library** | "I'm in McCool right now — what's open nearby for coffee or study?" | `get_campus_quick_info(reference_building)` returns nearby dining + nearby library + nearby rec spaces with open-status |
| **Maps + Parking** | "Where do I park to visit Mitchell Library?" | `get_parking_for(destination_building)` returns the nearest visitor lot + walking distance + permit-required-during-day |
| **Calendars + Career** | "Next career fair + which CSE-relevant employers attend" | Extends `find_msu_date` to include career-fair employer lists |
| **Course catalog + Career outcomes** | "What jobs do CSE 4733 graduates get?" | Joins catalog records with career-center "outcomes" data (post-grad placement) |
| **Online programs + Bursar** | "Cost of online MBA including all per-credit-hour and instructional fees" | Already partially in `get_online_program.tuition`; could surface a totals widget |
| **Building locator + Health** | "Nearest urgent care to the Drill Field?" | Future: combine maps + health-services location data |

**Recommendation:** Implement Top 1-5 as primitives first, then add 1-2 composite tools (campus quick-info, parking-for-destination) once the underlying domains are in place. Composites are LLM-orchestratable today (the model can call the primitives sequentially), but a single composite tool reduces round-trips and is more discoverable in routing instructions.

---

## Section 5 — Decommission audit

Reviewed each of the 7 existing domains against per-perspective worth:

| Existing domain | PM (audience) | Designer (UX win) | Engineer (cost/maintenance) | Verdict |
|---|---|---|---|---|
| Operating Policies | ✓ high (compliance questions) | ✓ verbatim quoting | low maintenance (PDF parse) | **Keep** |
| Academic dates | ✓ very high | ✓ smart-fallback delights | low (BM25 synonyms baked at build) | **Keep** |
| Course catalog | ✓ high (advising) | ✓ prereq DAG = "what unlocks X" | medium (parse warnings) | **Keep** |
| Emergency | ✓ critical | ✓ 911 prefix is load-bearing | low | **Keep** |
| Tuition | ✓ very high | ✓ structured rate lookup | medium (heterogeneous campuses) | **Keep** |
| Online programs | ✓ targeted-audience win | ✓ list_programs_by_staff is killer | medium (Playwright not needed; static HTML) | **Keep** |
| Dining | ✓ high | ✓ status_now is the magic | high maintenance (daily refresh, Playwright) | **Keep** — but watch for cost |

No decommission candidates. The dining module is the most expensive to maintain (daily scrape, Playwright in CI), but it's also the most "demo-able" — open-now lookup against a live status is the kind of magic that makes the whole product feel valuable.

---

## Section 6 — Out-of-scope (explicit "later" list)

| Excluded | Why |
|---|---|
| Athletics schedules | hailstate.com is commercial third-party; not MSU-authoritative |
| Bookstore textbook lookup | bncollege is commercial third-party |
| Banner real-time (balances, registration windows, grades) | Auth-walled per-user data; can't be baked into a public corpus |
| Student-side directory | Auth-walled by design (FERPA) |
| Handshake / Career fair employer lists | Handshake is auth-walled; employer lists shift weekly + are vendor-hosted |
| Grant deadlines / IRB submission portal | Faculty-only; auth-walled; niche audience relative to UG |
| Greek life recruitment specifics | Highly seasonal; could fold into calendars module if asked |
| Maroon Memo / internal newsletters | Auth-walled |
| Parental notification policies | Niche; covered by Operating Policies if needed |
| Alumni transcript ordering | Vendor-hosted; auth-walled |
| Archived catalog editions | Out of scope per v0.6.0 design decision |

---

## Section 7 — Long-tail vs flagship distinction

For weighting in the next prioritization pass:

**Flagship tier** (likely 1000+ student-touches per week if shipped):
- People directory
- Library suite
- Building locator
- Parking + SMART transit

**Mid-tier** (100-1000 weekly):
- Financial aid depth (high stakes but seasonal — concentrated in fall/spring application windows)
- Recreation finder
- Student-org finder
- Forms aggregator

**Long-tail** (10-100 weekly; power users):
- IT services FAQ (mostly first-week-of-semester + new-employee onboarding)
- Bursar payment-plan extension
- Health & wellness first-step (low frequency by design; high impact per call)

**Composite/derived** (depends on primitives):
- Campus quick-info combo
- Parking-for-destination
- Calendars × Career

---

## Section 8 — Next step

Run `pm-product-discovery:prioritize-features` over the 12 candidate ideas (5 cross-perspective-agreed + 5 single-perspective + 2 composites), scoring on:

- **Impact** — weekly user-touches × stakes-per-touch
- **Effort** — engineering days from spec to ship
- **Risk** — corpus stability + auth-wall risk + parse-fragility
- **Strategic fit** — alignment with the "MSU-authoritative" north-star + segment underserve

That output feeds the v1.2.x backlog.
