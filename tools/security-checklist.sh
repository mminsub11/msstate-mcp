#!/usr/bin/env bash
# Mechanical security checklist score (0-100). Used as the autoresearch
# Verify metric for the security-fix loop. Lives outside the loop's
# editable Scope so the metric can't be gamed.
#
# Each check awards 0 or full points. Output is a single integer to stdout.
# Diagnostic detail goes to stderr.
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

echo "$score"
