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
#   N1-N10, DISC         : extended findings from autoresearch_security.md
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
  score=$((score + 10))
  note "PASS" "H3a msstate-policies npm audit clean (high+critical = 0)" 10
else
  note "FAIL" "H3a msstate-policies npm audit (high or critical present)" 10
fi

# ---- H3b: worker npm audit (no high or critical) ----------------------------
if (cd worker && npm audit --audit-level=high --json 2>/dev/null) \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); m=d.get("metadata",{}).get("vulnerabilities",{}); sys.exit(0 if (m.get("high",0)==0 and m.get("critical",0)==0) else 1)' 2>/dev/null; then
  score=$((score + 10))
  note "PASS" "H3b worker npm audit clean (high+critical = 0)" 10
else
  note "FAIL" "H3b worker npm audit (high or critical present)" 10
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
# Extended findings (N1-N10, DISC) from autoresearch_security.md (2026-05-08).
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
  score=$((score + 12))
  note "PASS" "N2 worker/corpus.json sanity (>=200 rows, all bodies >=200 chars)" 12
else
  note "FAIL" "N2 worker/corpus.json sanity check failed" 12
fi

# ---- N3: msstate-policies npm audit clean at MODERATE+ ----------------------
# H3a uses --audit-level=high. N3 tightens to moderate so build-tooling CVEs
# (e.g. esbuild) also gate the score.
if (cd msstate-policies && npm audit --audit-level=moderate --json 2>/dev/null) \
    | python3 -c 'import json,sys
d=json.load(sys.stdin); m=d.get("metadata",{}).get("vulnerabilities",{})
sys.exit(0 if (m.get("moderate",0)==0 and m.get("high",0)==0 and m.get("critical",0)==0) else 1)' 2>/dev/null; then
  score=$((score + 8))
  note "PASS" "N3 msstate-policies npm audit clean (moderate+high+critical = 0)" 8
else
  note "FAIL" "N3 msstate-policies npm audit (moderate or higher present)" 8
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
  score=$((score + 12))
  note "PASS" "N6 CI runs security-checklist + npm audit" 12
else
  note "FAIL" "N6 CI does not gate on security-checklist + npm audit" 12
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

echo "$score"
