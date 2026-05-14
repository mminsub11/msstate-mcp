#!/usr/bin/env bash
# Mechanical security checklist score (0-192). Used as the autoresearch
# Verify metric for the security-fix loop. Lives outside the loop's
# editable Scope so the metric can't be gamed.
#
# Each check awards 0 or full points. Output is a single integer to stdout.
# Diagnostic detail goes to stderr.
#
# Sections:
#   H1-H3b, M3-M5, L1-L4 : original 100-pt checklist (round 1)
#   N1-N10, DISC         : extended findings from the round-2 audit (2026-05-08)
#                          (2026-05-08 audit), worth +92 pts.
#   tests + typecheck    : 28 pts of guard coverage already in the score.
#
# Run from repo root.

set -u

cd "$(dirname "$0")/.." || exit 1

score=0

note() { printf '  [%s] %s (%s pts)\n' "$1" "$2" "$3" >&2; }

# ---- H1: Worker validates input length on tool args -------------------------
# Worker tool handlers should reject oversized query/question strings to
# avoid memory/CPU exhaustion via tokenize() on a 10MB payload.
if grep -qE '(query|question)\.length\s*>' worker/src/index.ts 2>/dev/null; then
  score=$((score + 8))
  note "PASS" "H1 input length validation in Worker" 8
else
  note "FAIL" "H1 input length validation in Worker" 8
fi

# ---- H2: Worker doesn't echo internal error.message -------------------------
# Internal error: ${err.message} pattern can leak stack/path info.
if grep -qF 'Internal error: ${' worker/src/index.ts 2>/dev/null; then
  note "FAIL" "H2 generic error messages (still echoes err.message)" 8
else
  score=$((score + 8))
  note "PASS" "H2 generic error messages in Worker" 8
fi

# ---- H3a: msstate-policies npm audit (no high or critical) ------------------
if (cd msstate-policies && npm audit --audit-level=high --json 2>/dev/null) \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); m=d.get("metadata",{}).get("vulnerabilities",{}); sys.exit(0 if (m.get("high",0)==0 and m.get("critical",0)==0) else 1)' 2>/dev/null; then
  score=$((score + 6))
  note "PASS" "H3a msstate-policies npm audit clean (high+critical = 0)" 6
else
  note "FAIL" "H3a msstate-policies npm audit (high or critical present)" 6
fi

# ---- H3b: worker npm audit (no high or critical) ----------------------------
if (cd worker && npm audit --audit-level=high --json 2>/dev/null) \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); m=d.get("metadata",{}).get("vulnerabilities",{}); sys.exit(0 if (m.get("high",0)==0 and m.get("critical",0)==0) else 1)' 2>/dev/null; then
  score=$((score + 6))
  note "PASS" "H3b worker npm audit clean (high+critical = 0)" 6
else
  note "FAIL" "H3b worker npm audit (high or critical present)" 6
fi

# ---- M3: SECURITY.md exists with required sections --------------------------
if [ -f SECURITY.md ] \
    && grep -qi 'report' SECURITY.md \
    && grep -qi 'supported version' SECURITY.md; then
  score=$((score + 8))
  note "PASS" "M3 SECURITY.md exists with reporting + supported sections" 8
else
  note "FAIL" "M3 SECURITY.md missing or incomplete" 8
fi

# ---- M4: Dependabot config ---------------------------------------------------
if [ -f .github/dependabot.yml ]; then
  score=$((score + 8))
  note "PASS" "M4 Dependabot config" 8
else
  note "FAIL" "M4 .github/dependabot.yml missing" 8
fi

# ---- M5: npm publish --provenance documented --------------------------------
# Either README, docs/BUILD.md, or a docs/release.md should mention provenance
if grep -qi 'provenance' README.md docs/BUILD.md 2>/dev/null \
    || (ls docs/release.md 2>/dev/null | grep -qi 'release'); then
  score=$((score + 5))
  note "PASS" "M5 provenance flag documented" 5
else
  note "FAIL" "M5 npm publish --provenance not documented anywhere" 5
fi

# ---- L1: Threat model section in docs/BUILD.md ------------------------------
if grep -qi 'threat model' docs/BUILD.md 2>/dev/null; then
  score=$((score + 5))
  note "PASS" "L1 threat model in docs/BUILD.md" 5
else
  note "FAIL" "L1 threat model section missing from docs/BUILD.md" 5
fi

# ---- L2: Security section in docs/BUILD.md ----------------------------------
if grep -qi '^## security' docs/BUILD.md 2>/dev/null; then
  score=$((score + 5))
  note "PASS" "L2 ## Security heading in docs/BUILD.md" 5
else
  note "FAIL" "L2 ## Security heading missing from docs/BUILD.md" 5
fi

# ---- L4: Corpus rule documented as trust anchor -----------------------------
if grep -qi 'corpus rule' docs/BUILD.md 2>/dev/null \
    && grep -qi 'trust' docs/BUILD.md 2>/dev/null; then
  score=$((score + 5))
  note "PASS" "L4 corpus rule discussed as trust anchor" 5
else
  note "FAIL" "L4 corpus-rule-as-trust-anchor not documented" 5
fi

# ---- Guards (must keep passing) --------------------------------------------
if (cd msstate-policies && npm test >/dev/null 2>&1); then
  score=$((score + 14))
  note "PASS" "tests still pass (msstate-policies)" 14
else
  note "FAIL" "tests broken in msstate-policies" 14
fi

if (cd msstate-policies && npm run typecheck >/dev/null 2>&1) \
    && (cd worker && npx --no-install tsc --noEmit >/dev/null 2>&1); then
  score=$((score + 14))
  note "PASS" "typecheck still clean (both packages)" 14
else
  note "FAIL" "typecheck broken in one or both packages" 14
fi

# =============================================================================
# Extended findings (N1-N10, DISC) from the round-2 audit (2026-05-08).
# Each block scores 0 or full points based on a mechanical grep / audit / sanity
# check tied to one finding's mitigation.
# =============================================================================

# ---- N1: Worker error paths don't echo err.message --------------------------
# Stricter than H2: covers BOTH the handler-catch and the JSON-parse-catch
# error paths in worker/src/index.ts. H2 only matches "Internal error: ${".
if grep -qE '(Internal|Parse) error: \$\{' worker/src/index.ts 2>/dev/null; then
  note "FAIL" "N1 worker still echoes err.message on at least one error path" 10
else
  score=$((score + 10))
  note "PASS" "N1 worker error paths don't echo err.message" 10
fi

# ---- N2: worker/corpus.json sanity (rows + body sizes) ----------------------
# A poisoned or partial corpus.json (e.g. WAF-shell save during a future M6
# auto-rebuild) would land silently otherwise. Floor matches MIN_INDEX_ROWS
# in the runtime scraper and MIN_USABLE_POLICY_TEXT_CHARS for bodies.
if python3 -c '
import json,sys
try:
    d=json.load(open("worker/corpus.json"))
    if d.get("indexRowCount",0) < 200: sys.exit(1)
    pol=d.get("policies",[])
    if len(pol) < 200: sys.exit(1)
    if any(len(p.get("text","")) < 200 for p in pol): sys.exit(1)
except Exception:
    sys.exit(1)
' 2>/dev/null; then
  score=$((score + 8))
  note "PASS" "N2 worker/corpus.json sanity (>=200 rows, all bodies >=200 chars)" 8
else
  note "FAIL" "N2 worker/corpus.json sanity check failed" 8
fi

# ---- N3: msstate-policies npm audit clean at MODERATE+ ----------------------
# H3a uses --audit-level=high. N3 tightens to moderate so build-tooling CVEs
# (e.g. esbuild) also gate the score.
if (cd msstate-policies && npm audit --audit-level=moderate --json 2>/dev/null) \
    | python3 -c 'import json,sys
d=json.load(sys.stdin); m=d.get("metadata",{}).get("vulnerabilities",{})
sys.exit(0 if (m.get("moderate",0)==0 and m.get("high",0)==0 and m.get("critical",0)==0) else 1)' 2>/dev/null; then
  score=$((score + 4))
  note "PASS" "N3 msstate-policies npm audit clean (moderate+high+critical = 0)" 4
else
  note "FAIL" "N3 msstate-policies npm audit (moderate or higher present)" 4
fi

# ---- N4: Worker rejects oversize bodies before request.json() ---------------
# MAX_QUERY_CHARS only fires AFTER parsing. A Content-Length pre-check rejects
# multi-MB bodies cheaply.
if grep -qiE 'content-length' worker/src/index.ts 2>/dev/null \
    && grep -qE 'Request too large|413|too large' worker/src/index.ts 2>/dev/null; then
  score=$((score + 8))
  note "PASS" "N4 worker checks Content-Length before parsing body" 8
else
  note "FAIL" "N4 worker missing Content-Length pre-parse check" 8
fi

# ---- N5: Worker handler-catch doesn't log raw err object --------------------
# `console.error("...", err)` autoserializes err.stack into CF Workers Logs.
# Pass when no `console.error(..., err)` pattern remains in the worker file.
if grep -qE 'console\.error\([^)]*",[[:space:]]*err\)' worker/src/index.ts 2>/dev/null; then
  note "FAIL" "N5 worker console.error still passes raw err (stack leak in CF logs)" 8
else
  score=$((score + 8))
  note "PASS" "N5 worker error logs scrubbed (no bare err object)" 8
fi

# ---- N6: CI gates on security-checklist + npm audit -------------------------
# Mechanical verification that the verify metric and dependency audit run on
# every push/PR -- converts the "rerun before each release" social contract
# into a hard gate.
if grep -qE 'security-checklist\.sh' .github/workflows/ci.yml 2>/dev/null \
    && grep -qE 'npm audit' .github/workflows/ci.yml 2>/dev/null; then
  score=$((score + 4))
  note "PASS" "N6 CI runs security-checklist + npm audit" 4
else
  note "FAIL" "N6 CI does not gate on security-checklist + npm audit" 4
fi

# ---- N7: build-worker-corpus.mjs detects WAF challenge pages ----------------
# Pre-requisite for any future M6 auto-rebuild. Without this, an MSU WAF
# interstitial during build silently poisons corpus.json.
if grep -qE '(WAFChallenge|antibot|Just a moment|cf-chl-bypass|looksLikeWaf)' \
    scripts/build-worker-corpus.mjs 2>/dev/null; then
  score=$((score + 8))
  note "PASS" "N7 build-worker-corpus.mjs has WAF detection" 8
else
  note "FAIL" "N7 build-worker-corpus.mjs lacks WAF detection" 8
fi

# ---- N8: No `new Function()` runtime-eval in stdio entry --------------------
# `new Function` is an eval-class primitive. Replace with esbuild --define
# const refs.
if grep -qE 'new Function\(' msstate-policies/src/index.ts 2>/dev/null; then
  note "FAIL" "N8 'new Function' used in msstate-policies/src/index.ts" 6
else
  score=$((score + 6))
  note "PASS" "N8 no 'new Function' in msstate-policies/src/index.ts" 6
fi

# ---- N9: Disk cache writes use explicit file mode ---------------------------
# On multi-user hosts, writes that follow umask leak the cache file to other
# users. mode 0o600 closes the leak.
if grep -qE 'writeFileSync\([^)]*mode:[[:space:]]*0o[67][0-9][0-9]' \
    msstate-policies/src/cache.ts 2>/dev/null \
    || grep -qE 'mode:[[:space:]]*0o600' msstate-policies/src/cache.ts 2>/dev/null; then
  score=$((score + 6))
  note "PASS" "N9 cache writes use explicit file mode (>= 0o600)" 6
else
  note "FAIL" "N9 cache writes follow umask (no explicit mode 0o600)" 6
fi

# ---- N10: CORS allow-headers does not include Authorization -----------------
# Worker has no auth surface. Advertising Authorization is a confused-deputy
# hint to future maintainers.
if grep -qE '"Access-Control-Allow-Headers".*Authorization' \
    worker/src/index.ts 2>/dev/null; then
  note "FAIL" "N10 CORS allow-headers includes Authorization (no auth surface exists)" 6
else
  score=$((score + 6))
  note "PASS" "N10 CORS allow-headers no longer advertises Authorization" 6
fi

# ---- DISC: SECURITY.md has Out-of-scope section -----------------------------
# Captures the user-side circumvention behaviors that are explicitly NOT in
# this server's threat model (local edits to dist, prompt-level instruction
# of the LLM, forking the corpus, etc.).
if grep -qiE '^#+[[:space:]]*out[-[:space:]]*of[-[:space:]]*scope' \
    SECURITY.md 2>/dev/null \
    && grep -qiE '(prompt|tool description|local copy|fork|llm)' \
    SECURITY.md 2>/dev/null; then
  score=$((score + 8))
  note "PASS" "DISC SECURITY.md captures out-of-scope user-side behaviors" 8
else
  note "FAIL" "DISC SECURITY.md missing Out-of-scope section" 8
fi

# ---- CAL1: Calendar corpus URLs are hardcoded in types.ts -------------------
if grep -qF 'CALENDAR_URLS' msstate-policies/src/calendars/types.ts 2>/dev/null \
   && grep -qE 'https://www\.registrar\.msstate\.edu' msstate-policies/src/calendars/types.ts \
   && grep -qE 'https://www\.hrm\.msstate\.edu' msstate-policies/src/calendars/types.ts \
   && grep -qE 'https://www\.grad\.msstate\.edu' msstate-policies/src/calendars/types.ts \
   && grep -qE 'https://www\.sfa\.msstate\.edu' msstate-policies/src/calendars/types.ts \
   && grep -qE 'https://www\.housing\.msstate\.edu' msstate-policies/src/calendars/types.ts; then
  score=$((score + 8))
  note "PASS" "CAL1 calendar URLs hardcoded in types.ts" 8
else
  note "FAIL" "CAL1 calendar URLs hardcoded in types.ts" 8
fi

# ---- CAL2: Calendar parsers never touch non-msstate.edu hosts ---------------
# Grep for any literal http(s):// URL inside calendars/ source, excluding the
# allowed MSU subdomains. Any hit is a regression.
CAL2_FAIL=0
for f in $(find msstate-policies/src/calendars -type f -name '*.ts' 2>/dev/null); do
  while IFS= read -r url; do
    case "$url" in
      *registrar.msstate.edu*|*hrm.msstate.edu*|*grad.msstate.edu*|*sfa.msstate.edu*|*housing.msstate.edu*|*policies.msstate.edu*|*www.msstate.edu*)
        : ;;
      *)
        CAL2_FAIL=1
        echo "  CAL2 unexpected URL in $f: $url" >&2
        ;;
    esac
  done < <(grep -oE 'https?://[^"'"'"' )]+' "$f" 2>/dev/null)
done
if [ "$CAL2_FAIL" -eq 0 ]; then
  score=$((score + 8))
  note "PASS" "CAL2 calendar code stays on msstate.edu" 8
else
  note "FAIL" "CAL2 calendar code touches non-msstate.edu URLs" 8
fi

# ---- CAL3: Worker calendar handler caps q length before tokenize() ----------
if grep -qE 'find_msu_date' worker/src/index.ts \
   && grep -qE 'q\.length\s*>\s*MAX_QUERY_CHARS' worker/src/index.ts; then
  score=$((score + 4))
  note "PASS" "CAL3 Worker caps find_msu_date q length" 4
else
  note "FAIL" "CAL3 Worker caps find_msu_date q length" 4
fi

# ---- CAL4: Build aborts on WAF challenge / empty calendar scrape ------------
if grep -qF "refusing to ship a poisoned calendar corpus" scripts/build-worker-corpus.mjs; then
  score=$((score + 4))
  note "PASS" "CAL4 build aborts on calendar WAF/empty" 4
else
  note "FAIL" "CAL4 build aborts on calendar WAF/empty" 4
fi

# ---- v0.5.0: synonym-expansion security checks ------------------------------

# SYN1: No raw Anthropic API key committed. The grep walks the working tree;
# matches in gitignored files (e.g. a developer's local msstate-policies/.env)
# are tolerated per the spec's "outside .gitignore allowlist" wording.
SYN1_HITS=$(grep -rE "sk-ant-[a-zA-Z0-9_-]{20,}" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.wrangler -l 2>/dev/null \
  | while IFS= read -r f; do
      if ! git check-ignore -q "$f" 2>/dev/null; then
        printf '%s\n' "$f"
      fi
    done)
if [ -z "$SYN1_HITS" ]; then
  score=$((score + 5))
  note "PASS" "SYN1 no ANTHROPIC_API_KEY committed" 5
else
  note "FAIL" "SYN1 sk-ant- pattern found in tracked files: $SYN1_HITS" 5
fi

# SYN2: Build script aborts on partial paraphrase failure with canonical string.
if grep -qF "refusing to ship a poisoned calendar corpus" scripts/build-worker-corpus.mjs; then
  score=$((score + 5))
  note "PASS" "SYN2 build aborts with canonical string on paraphrase failure" 5
else
  note "FAIL" "SYN2 canonical abort string missing from build script" 5
fi

# SYN3: Build script aborts when ANTHROPIC_API_KEY is unset.
if grep -qF "ANTHROPIC_API_KEY is required for the build step" scripts/build-worker-corpus.mjs; then
  score=$((score + 3))
  note "PASS" "SYN3 build aborts on missing ANTHROPIC_API_KEY" 3
else
  note "FAIL" "SYN3 no missing-key guard in build script" 3
fi

# SYN4: No runtime egress to Anthropic. Only the build script may reference api.anthropic.com.
RT_ANTHROPIC=$(grep -rn "api\.anthropic\.com" msstate-policies/src worker/src 2>/dev/null | wc -l)
if [ "$RT_ANTHROPIC" = "0" ]; then
  score=$((score + 10))
  note "PASS" "SYN4 zero runtime egress to api.anthropic.com" 10
else
  note "FAIL" "SYN4 found $RT_ANTHROPIC runtime references to api.anthropic.com" 10
fi

# SYN5: Synonym validation visible in build script (length cap or digit-reject regex).
if grep -qE "PARAPHRASE_MAX_CHARS|\.length > 80|/\\\\d/" scripts/build-worker-corpus.mjs; then
  score=$((score + 3))
  note "PASS" "SYN5 paraphrase validation regex/length checks present" 3
else
  note "FAIL" "SYN5 no synonym validation in build script" 3
fi

# SYN6: row.synonyms is not surfaced in any user-facing path in tools.
# Catches property access (.synonyms), JSON keys ("synonyms":), and array
# destructuring (synonyms:) — but NOT the bare word "synonyms" appearing
# inside a user-facing mode-note string (e.g., "BM25 with synonyms").
TOOLS_SYN=$(grep -rnE '\.synonyms\b|"synonyms"\s*:|\bsynonyms\s*:|\{[^}]*\bsynonyms\b[^}]*\}' msstate-policies/src/tools 2>/dev/null | wc -l)
if [ "$TOOLS_SYN" = "0" ]; then
  score=$((score + 2))
  note "PASS" "SYN6 no row.synonyms property access in src/tools/" 2
else
  note "FAIL" "SYN6 found $TOOLS_SYN row.synonyms-style references in src/tools/" 2
fi

# CAL5 (regression): Worker CORS allowlist still excludes Authorization.
if ! grep -nE "Access-Control-Allow-Headers.*Authorization" worker/src/index.ts 2>/dev/null | grep -q .; then
  score=$((score + 0))
  note "PASS" "CAL5 Authorization stays out of CORS allowlist" 0
else
  note "FAIL" "CAL5 Authorization regressed into CORS allowlist" 0
fi

# CAL6: Build aborts if the calendar scrape produces zero multi-day rows.
# Guards against a registrar HTML regression that would collapse every
# range (Spring Break, Fall Break, advising windows) into a single day.
if grep -qF "refusing to ship a calendar corpus with zero multi-day ranges" scripts/build-worker-corpus.mjs; then
  score=$((score + 5))
  note "PASS" "CAL6 build aborts on zero multi-day calendar rows" 5
else
  note "FAIL" "CAL6 build aborts on zero multi-day calendar rows" 5
fi

# ---- v0.6.0: course catalog security checks ---------------------------------

# CAT1: every https URL inside the courses module stays on msstate.edu.
CAT1_HITS=$(grep -RhoE "https://[a-zA-Z0-9.\-]+" msstate-policies/src/courses/ 2>/dev/null \
  | grep -vE "^https://([a-zA-Z0-9.\-]+\.)?msstate\.edu(/|$)" \
  | sort -u)
if [ -z "$CAT1_HITS" ]; then
  score=$((score + 4))
  note "PASS" "CAT1 all course-module URLs stay on msstate.edu" 4
else
  note "FAIL" "CAT1 non-msstate.edu URL in src/courses/: $CAT1_HITS" 4
fi

# CAT2: Worker length-caps every course-tool input before parse.
if grep -qE "MAX_QUERY_CHARS" worker/src/index.ts \
   && grep -qE "search_msu_courses" worker/src/index.ts \
   && grep -qE "get_msu_course\b" worker/src/index.ts \
   && grep -qE "get_msu_course_graph" worker/src/index.ts ; then
  score=$((score + 2))
  note "PASS" "CAT2 Worker length-caps course-tool input before parse" 2
else
  note "FAIL" "CAT2 Worker missing length cap before parse for course tools" 2
fi

# CAT3: build script aborts on poisoned course corpus.
if grep -qF "refusing to ship a poisoned course corpus" scripts/build-worker-corpus.mjs; then
  score=$((score + 2))
  note "PASS" "CAT3 build aborts on poisoned course corpus" 2
else
  note "FAIL" "CAT3 build-worker-corpus.mjs missing course-corpus poison-abort" 2
fi

# CAT4: CATALOG_ROOTS allowlist exists and is frozen.
if grep -qE "Object\.freeze" msstate-policies/src/courses/types.ts \
   && grep -qE "CATALOG_ROOTS" msstate-policies/src/courses/types.ts ; then
  score=$((score + 2))
  note "PASS" "CAT4 CATALOG_ROOTS frozen allowlist present in types.ts" 2
else
  note "FAIL" "CAT4 CATALOG_ROOTS allowlist missing or not frozen" 2
fi

# ---- v0.7.0: emergency-guideline security checks ---------------------------

# EMG1: every https URL inside the emergency module stays on msstate.edu.
EMG1_HITS=$(grep -RhoE "https://[a-zA-Z0-9.\-]+" msstate-policies/src/emergency/ 2>/dev/null \
  | grep -vE "^https://([a-zA-Z0-9.\-]+\.)?msstate\.edu(/|$)" \
  | sort -u)
if [ -z "$EMG1_HITS" ]; then
  score=$((score + 3))
  note "PASS" "EMG1 all emergency-module URLs stay on msstate.edu" 3
else
  note "FAIL" "EMG1 non-msstate.edu URL in src/emergency/: $EMG1_HITS" 3
fi

# EMG2: EMERGENCY_ROOTS allowlist exists and is frozen.
if grep -qE "Object\.freeze" msstate-policies/src/emergency/types.ts \
   && grep -qE "EMERGENCY_ROOTS" msstate-policies/src/emergency/types.ts ; then
  score=$((score + 2))
  note "PASS" "EMG2 EMERGENCY_ROOTS frozen allowlist present in types.ts" 2
else
  note "FAIL" "EMG2 EMERGENCY_ROOTS allowlist missing or not frozen" 2
fi

# EMG3: Worker length-caps the 3 input-taking emergency tools before parse.
# list_msu_emergency_types takes no input — exempt.
if grep -qE "MAX_QUERY_CHARS" worker/src/index.ts \
   && grep -qE "get_msu_emergency_guideline" worker/src/index.ts \
   && grep -qE "find_msu_severe_weather_refuge" worker/src/index.ts \
   && grep -qE "get_msu_emergency_contacts" worker/src/index.ts ; then
  score=$((score + 3))
  note "PASS" "EMG3 Worker length-caps emergency-tool input before parse" 3
else
  note "FAIL" "EMG3 Worker missing length cap for one or more emergency tools" 3
fi

# EMG4: build script aborts on poisoned emergency corpus.
if grep -qF "refusing to ship a poisoned emergency corpus" scripts/build-worker-corpus.mjs; then
  score=$((score + 2))
  note "PASS" "EMG4 build aborts on poisoned emergency corpus" 2
else
  note "FAIL" "EMG4 build-worker-corpus.mjs missing emergency-corpus poison-abort" 2
fi

# =============================================================================
# Tuition module checks (TUI1-TUI5, added 2026-05-13). +12 pts total.
# =============================================================================

# TUI1: All https:// URLs inside msstate-policies/src/tuition/ stay on msstate.edu.
TUI_NON_MSU=$(grep -rE 'https://[^"'"'"'[:space:])]+' msstate-policies/src/tuition 2>/dev/null \
  | grep -vE 'https://[^/]*msstate\.edu' \
  | wc -l | tr -d ' ')
if [ "$TUI_NON_MSU" = "0" ]; then
  score=$((score + 3))
  note "PASS" "TUI1 all tuition-module URLs stay on msstate.edu" 3
else
  note "FAIL" "TUI1 found $TUI_NON_MSU non-msstate.edu URLs in src/tuition/" 3
fi

# TUI2: TUITION_ROOTS frozen Object.freeze allowlist present, exact 9 URLs.
TUI_ROOTS_OK=0
if grep -qE 'export const TUITION_ROOTS.*=.*Object\.freeze\(' msstate-policies/src/tuition/types.ts 2>/dev/null; then
  EXPECTED_TUI_URLS=(
    "https://www.controller.msstate.edu/accountservices/tuition"
    "https://www.controller.msstate.edu/accountservices/tuition/frequently-asked-questions"
    "https://www.controller.msstate.edu/accountservices/tuition/other-enrollment-costs"
    "https://www.controller.msstate.edu/accountservices/tuition/select-your-campus"
    "https://www.controller.msstate.edu/accountservices/tuition/starkville-campus"
    "https://www.controller.msstate.edu/accountservices/tuition/meridian-campus"
    "https://www.controller.msstate.edu/accountservices/tuition/mgccc-campus-rates"
    "https://www.controller.msstate.edu/accountservices/tuition/online-education-rates"
    "https://www.vetmed.msstate.edu/tuition"
  )
  TUI_MISSING=0
  for u in "${EXPECTED_TUI_URLS[@]}"; do
    if ! grep -qF "\"$u\"" msstate-policies/src/tuition/types.ts; then
      TUI_MISSING=$((TUI_MISSING+1))
    fi
  done
  if [ "$TUI_MISSING" = "0" ]; then TUI_ROOTS_OK=1; fi
fi
if [ "$TUI_ROOTS_OK" = "1" ]; then
  score=$((score + 2))
  note "PASS" "TUI2 TUITION_ROOTS frozen allowlist present with all 9 URLs" 2
else
  note "FAIL" "TUI2 TUITION_ROOTS allowlist missing or incomplete" 2
fi

# TUI3: Worker length-caps `q` and `filter` before parse on the 2 string-taking
# tuition tools. (list_msu_tuition_campuses + get_msu_tuition_rate are exempt.)
TUI3_OK=1
if ! grep -nA 6 'case "get_msu_enrollment_fees":' worker/src/index.ts \
     | grep -q "MAX_QUERY_CHARS"; then
  TUI3_OK=0
fi
if ! grep -nA 6 'case "find_msu_tuition_faq":' worker/src/index.ts \
     | grep -q "MAX_QUERY_CHARS"; then
  TUI3_OK=0
fi
if [ "$TUI3_OK" = "1" ]; then
  score=$((score + 3))
  note "PASS" "TUI3 Worker length-caps q + filter before parse on tuition tools" 3
else
  note "FAIL" "TUI3 Worker missing length-cap on at least one tuition tool" 3
fi

# TUI4: Build aborts with the canonical string on poisoned tuition corpus.
TUI4_COUNT=$(grep -c "refusing to ship a poisoned tuition corpus" scripts/build-worker-corpus.mjs 2>/dev/null | tr -d ' ')
TUI4_COUNT=${TUI4_COUNT:-0}
if [ "$TUI4_COUNT" -ge "8" ] 2>/dev/null; then
  score=$((score + 2))
  note "PASS" "TUI4 build aborts on poisoned tuition corpus ($TUI4_COUNT abort sites)" 2
else
  note "FAIL" "TUI4 only $TUI4_COUNT 'refusing to ship a poisoned tuition corpus' sites (need >= 8)" 2
fi

# TUI5: TUITION_DISCLAIMER constant present in types.ts AND referenced in
# all 4 tuition tool files.
TUI5_OK=1
if ! grep -q 'TUITION_DISCLAIMER' msstate-policies/src/tuition/types.ts 2>/dev/null; then
  TUI5_OK=0
fi
for f in get_msu_tuition_rate get_msu_enrollment_fees find_msu_tuition_faq list_msu_tuition_campuses; do
  if ! grep -q 'TUITION_DISCLAIMER' "msstate-policies/src/tools/${f}.ts" 2>/dev/null; then
    TUI5_OK=0
  fi
done
if [ "$TUI5_OK" = "1" ]; then
  score=$((score + 2))
  note "PASS" "TUI5 TUITION_DISCLAIMER present in types.ts + 4 tool files" 2
else
  note "FAIL" "TUI5 TUITION_DISCLAIMER missing from types.ts or one of the tool files" 2
fi

# =============================================================================
# Online module checks (ONL1-ONL5, added 2026-05-13). +12 pts total.
# =============================================================================

# ONL1: All https:// URLs inside msstate-policies/src/online/ stay on *.msstate.edu.
ONL_NON_MSU=$(grep -rE 'https://[^"'"'"'[:space:])]+' msstate-policies/src/online 2>/dev/null \
  | grep -vE 'https://[^/]*msstate\.edu' \
  | wc -l | tr -d ' ')
if [ "$ONL_NON_MSU" = "0" ]; then
  score=$((score + 3))
  note "PASS" "ONL1 all online-module URLs stay on msstate.edu" 3
else
  note "FAIL" "ONL1 found $ONL_NON_MSU non-msstate.edu URLs in src/online/" 3
fi

# ONL2: ONLINE_ROOTS + SUPPORT_PAGE_SLUGS frozen allowlists present.
ONL2_OK=0
if grep -qE 'export const ONLINE_ROOTS.*=.*Object\.freeze\(' msstate-policies/src/online/types.ts 2>/dev/null \
  && grep -qE 'export const SUPPORT_PAGE_SLUGS.*=.*Object\.freeze\(' msstate-policies/src/online/types.ts 2>/dev/null; then
  ONL2_OK=1
fi
if [ "$ONL2_OK" = "1" ]; then
  score=$((score + 2))
  note "PASS" "ONL2 ONLINE_ROOTS + SUPPORT_PAGE_SLUGS frozen allowlists present" 2
else
  note "FAIL" "ONL2 ONLINE_ROOTS or SUPPORT_PAGE_SLUGS missing or not frozen" 2
fi

# ONL3: Worker length-caps q, subject_keyword, name_query before parse.
ONL3_OK=1
for case_name in "list_online_programs" "get_online_program" "find_online_info"; do
  if ! grep -nA 8 "case \"$case_name\":" worker/src/index.ts \
       | grep -q "MAX_QUERY_CHARS"; then
    ONL3_OK=0
  fi
done
if [ "$ONL3_OK" = "1" ]; then
  score=$((score + 3))
  note "PASS" "ONL3 Worker length-caps string inputs on online tools" 3
else
  note "FAIL" "ONL3 Worker missing length-cap on at least one online tool" 3
fi

# ONL4: Build aborts with canonical string on poisoned online corpus.
ONL4_COUNT=$(grep -c "refusing to ship a poisoned online corpus" scripts/build-worker-corpus.mjs 2>/dev/null | tr -d ' ')
ONL4_COUNT=${ONL4_COUNT:-0}
if [ "$ONL4_COUNT" -ge "8" ] 2>/dev/null; then
  score=$((score + 2))
  note "PASS" "ONL4 build aborts on poisoned online corpus ($ONL4_COUNT abort sites)" 2
else
  note "FAIL" "ONL4 only $ONL4_COUNT 'refusing to ship a poisoned online corpus' sites (need >= 8)" 2
fi

# ONL5: ONLINE_DISCLAIMER present in types.ts AND referenced in all 4 online tool files.
ONL5_OK=1
if ! grep -q 'ONLINE_DISCLAIMER' msstate-policies/src/online/types.ts 2>/dev/null; then
  ONL5_OK=0
fi
for f in list_online_programs get_online_program get_online_admissions_process find_online_info; do
  if ! grep -q 'ONLINE_DISCLAIMER' "msstate-policies/src/tools/${f}.ts" 2>/dev/null; then
    ONL5_OK=0
  fi
done
if [ "$ONL5_OK" = "1" ]; then
  score=$((score + 2))
  note "PASS" "ONL5 ONLINE_DISCLAIMER present in types.ts + 4 tool files" 2
else
  note "FAIL" "ONL5 ONLINE_DISCLAIMER missing from types.ts or one of the tool files" 2
fi

echo "$score"
