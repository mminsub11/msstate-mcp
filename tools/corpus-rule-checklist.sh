#!/usr/bin/env bash
# Corpus-rule integrity score (0-100). Used as the autoresearch Verify
# metric for the second security loop. Lives outside the loop's editable
# Scope so the metric can't be gamed.
#
# Theme: defenses against users getting answers NOT from official MSU
# resources. Builds on tools/security-checklist.sh (the mechanical layer)
# by adding structural defenses: disclaimer field, stale-corpus visibility,
# low-confidence flag, release runbook, weekly rebuild workflow.
#
# Run from repo root.

set -u
cd "$(dirname "$0")/.." || exit 1

score=0

note() { printf '  [%s] %s (%s pts)\n' "$1" "$2" "$3" >&2; }

# ---- A. disclaimer field — stdio types.ts -----------------------------------
if grep -qE 'disclaimer\s*[:?]?\s*string' msstate-policies/src/types.ts 2>/dev/null; then
  score=$((score + 4))
  note "PASS" "A1 disclaimer on PolicyDocument (msstate-policies/src/types.ts)" 4
else
  note "FAIL" "A1 disclaimer field missing from PolicyDocument" 4
fi

# ---- A. disclaimer field — stdio chain_find_relevant.ts ---------------------
if grep -q 'disclaimer' msstate-policies/src/tools/chain_find_relevant.ts 2>/dev/null; then
  score=$((score + 4))
  note "PASS" "A2 disclaimer in chain_find_relevant_policies response" 4
else
  note "FAIL" "A2 disclaimer not surfaced in chain_find_relevant" 4
fi

# ---- A. disclaimer field — stdio get_policy.ts ------------------------------
if grep -q 'disclaimer' msstate-policies/src/tools/get_policy.ts 2>/dev/null; then
  score=$((score + 4))
  note "PASS" "A3 disclaimer in get_policy response" 4
else
  note "FAIL" "A3 disclaimer not surfaced in get_policy" 4
fi

# ---- A. disclaimer field — Worker -------------------------------------------
if grep -q 'disclaimer' worker/src/index.ts 2>/dev/null; then
  score=$((score + 8))
  note "PASS" "A4 disclaimer in Worker tool responses" 8
else
  note "FAIL" "A4 disclaimer missing from Worker" 8
fi

# ---- B. corpus_age_days — Worker --------------------------------------------
if grep -q 'corpus_age_days' worker/src/index.ts 2>/dev/null; then
  score=$((score + 10))
  note "PASS" "B corpus_age_days surfaced by Worker" 10
else
  note "FAIL" "B corpus_age_days not present in Worker" 10
fi

# ---- C. low_confidence flag — stdio chain -----------------------------------
if grep -q 'low_confidence' msstate-policies/src/tools/chain_find_relevant.ts 2>/dev/null; then
  score=$((score + 8))
  note "PASS" "C1 low_confidence flag in stdio chain response" 8
else
  note "FAIL" "C1 low_confidence flag missing from stdio chain" 8
fi

# ---- C. low_confidence flag — Worker ----------------------------------------
if grep -q 'low_confidence' worker/src/index.ts 2>/dev/null; then
  score=$((score + 6))
  note "PASS" "C2 low_confidence flag in Worker chain response" 6
else
  note "FAIL" "C2 low_confidence flag missing from Worker" 6
fi

# ---- D. docs/release.md with required sections ------------------------------
if [ -f docs/release.md ] \
    && grep -qi 'npm publish' docs/release.md \
    && grep -qi 'wrangler deploy' docs/release.md \
    && grep -qi 'token' docs/release.md \
    && grep -qiE 'rotat|ttl|expir' docs/release.md; then
  score=$((score + 10))
  note "PASS" "D docs/release.md has publish/deploy/token sections" 10
else
  note "FAIL" "D docs/release.md missing or incomplete" 10
fi

# ---- E. .github/workflows/rebuild-corpus.yml --------------------------------
if [ -f .github/workflows/rebuild-corpus.yml ] \
    && grep -qE '(schedule|cron):' .github/workflows/rebuild-corpus.yml \
    && grep -qi 'wrangler' .github/workflows/rebuild-corpus.yml \
    && grep -qi 'CLOUDFLARE_API_TOKEN' .github/workflows/rebuild-corpus.yml; then
  score=$((score + 10))
  note "PASS" "E .github/workflows/rebuild-corpus.yml has cron + wrangler + token ref" 10
else
  note "FAIL" "E rebuild-corpus.yml missing or incomplete" 10
fi

# ---- Guards (must keep passing) --------------------------------------------

# G1: tests still pass
if (cd msstate-policies && npm test >/dev/null 2>&1); then
  score=$((score + 10))
  note "PASS" "G1 tests still pass (msstate-policies)" 10
else
  note "FAIL" "G1 tests broken in msstate-policies" 10
fi

# G2: typecheck still clean
if (cd msstate-policies && npm run typecheck >/dev/null 2>&1) \
    && (cd worker && npx --no-install tsc --noEmit >/dev/null 2>&1); then
  score=$((score + 8))
  note "PASS" "G2 typecheck clean (both packages)" 8
else
  note "FAIL" "G2 typecheck broken in one or both packages" 8
fi

# G3: dist matches src (CI gate)
if git diff --exit-code msstate-policies/dist/ >/dev/null 2>&1; then
  score=$((score + 5))
  note "PASS" "G3 dist/ matches src (git diff clean)" 5
else
  note "FAIL" "G3 dist/ drift from src — needs npm run build" 5
fi

# G4: Don't regress the prior mechanical security checklist.
# Round-1 floor was 100. Round-2 (audit closure 2026-05-08; see docs/BUILD.md)
# extended the script's max to 192 with N1-N10 + DISC checks. Gate
# numerically (>= 100) so round-2 progress doesn't trip this guard.
prior=$(bash tools/security-checklist.sh 2>/dev/null | tail -1)
if [[ "$prior" =~ ^[0-9]+$ ]] && [ "$prior" -ge 100 ]; then
  score=$((score + 8))
  note "PASS" "G4 tools/security-checklist.sh score >= 100 (now $prior)" 8
else
  note "FAIL" "G4 tools/security-checklist.sh regressed below 100 (now $prior)" 8
fi

# G5: Tool description still emphasizes corpus rule
if grep -q 'ONLY the returned text' msstate-policies/src/tools/chain_find_relevant.ts 2>/dev/null \
    && grep -q 'ONLY the returned text' worker/src/index.ts 2>/dev/null; then
  score=$((score + 5))
  note "PASS" "G5 tool descriptions still say 'Use ONLY the returned text'" 5
else
  note "FAIL" "G5 corpus-rule reinforcement weakened in tool descriptions" 5
fi

echo "$score"
