# `.dev/` — internal building & planning docs

Working directory for the maintainer's spec/plan artifacts. Visible in the repo (so they're versioned and reviewable) but visually de-emphasized via the leading-dot convention, in the same family as `.agents/`, `.claude/`, `.github/`.

## What lives here

- **`.dev/specs/`** — design specs from `superpowers:brainstorming` runs. One file per project, named `YYYY-MM-DD-<topic>-design.md`.
- **`.dev/plans/`** — task-by-task implementation plans from `superpowers:writing-plans` runs, named `YYYY-MM-DD-<feature-name>.md`. Each plan is consumed by `superpowers:subagent-driven-development` or `superpowers:executing-plans` to drive execution.

After a project ships, its spec and plan files in here can be deleted in a cleanup pass — the implementation history lives in `git log`. Keeping them around is optional, useful only when the "why" is non-obvious from commit messages.

## What does NOT live here

These docs stay at their current paths and are NOT moved into `.dev/`:

- **`README.md`** — user-facing entry point.
- **`CLAUDE.md`** — load-bearing rules every Claude session must read (corpus rule, security-score contract, stderr-only logging).
- **`SECURITY.md`** — vulnerability-disclosure policy, in-scope vs out-of-scope statement.
- **`docs/BUILD.md`** — architecture, decision history, threat model, eval methodology, deferred-work backlog.
- **`msstate-policies/README.md`** — npm-published package README.

## Future Claude sessions

The user's auto-memory captures this layout as a feedback rule, so `superpowers:brainstorming` and `superpowers:writing-plans` should land their artifacts here automatically rather than in `docs/superpowers/`.
