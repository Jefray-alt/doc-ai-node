# Agent workflow

This protocol applies to code-change work routed through the configured Codex
agents. The main session owns the user relationship and routes code changes to
`implementer` by default, passing the user requirements and decisions. Product
planning, exploration, and other non-code requests stay in the main session.

## Before starting

Before decomposing a task, starting developer/reviewer workers, or editing files,
the implementer runs:

```sh
git status --porcelain=v1 --untracked-files=all
git symbolic-ref --quiet --short HEAD
```

The first command must print nothing. If it prints staged, unstaged, untracked,
or conflicted paths, report those paths and stop. Do not stash, commit, discard,
or move them to get past the check. Ignored files are excluded by this check.
The second command must identify a branch; stop if HEAD is detached. On a clean
`main` branch, propose creating or switching to a task branch, then ask the
user explicitly before doing so. Propose a specific task branch name before
asking. If they refuse, stop; a refusal alone is not permission to work on
`main`. Continue on `main` only if they explicitly
approve that choice. Recheck cleanliness and the current branch after any
branch change. The main session may start the implementer solely to perform
these guard checks, but must not start developer/reviewer workers before they
pass. An existing feature branch needs no branch question. These startup gates
do not apply to edits made during an already-started normal task.

## One task at a time

Work serially in the same checkout. For each distinct task, start a fresh
`developer` and independent `code_reviewer` pair with `fork_turns=none`; give
the reviewer a curated brief containing the task requirements and acceptance
criteria, baseline, candidate scope, and validation evidence. Reuse that pair
for corrections to that task. Children must not delegate or start nested
agents. Do not begin the next task until this task has passed review and its
commit is complete.

The implementer provides a task ID, baseline, requirements and acceptance
criteria, file ownership, dependencies, relevant earlier context, and expected
checks before making changes. For code, use test-first development: demonstrate
a meaningful failing test before production edits, then pass it with the
implementation; refactor and run relevant regression checks where practical.
For work such as docs or configuration where a meaningful RED test does not
fit, explain the exception and validate the result with appropriate checks.

When ready, the implementer freezes edits and supplies the complete candidate
diff, including untracked files, plus the exact validation commands and exit
results. The reviewer independently checks the candidate and reruns suitable
nonmutating checks. The reviewer must not edit, stage, commit, push, or
delegate. Its read-only behavior is an instruction, not a sandbox guarantee.
The reviewer returns one verdict: `PASS`, `CHANGES_REQUESTED`, or `BLOCKED`,
with specific findings and evidence.

## Review limit and commit

Each task has three review rounds total: one initial review and at most two
re-reviews. Increment the round whenever a review is dispatched, including a
review that returns `BLOCKED`. The implementer tracks the round and the
reviewer confirms it.
Corrections reuse the same pair. If the third review does not pass, stop the
entire workflow: make no further fixes or commits, and do not start another
task. Report unresolved findings, attempted corrections, checks, and the
decisions or input needed from the user; preserve the working changes. An
explicit user request to retry that same task starts a new three-round budget
and carries forward the unresolved findings. Renaming the task or replacing
the reviewer does not reset the budget. Escalate blockers as soon as they
prevent safe progress.

After `PASS` and successful required checks, only the implementer stages the
exact files owned by that task and makes one Conventional Commit. Never push.
Before starting another task, confirm the expected clean state and check for
unexpected external changes; do not overwrite another person's edits. At the
end, report task commits, validation, and limitations, and run appropriate
integration checks. Update `docs/roadmap.md` only when an actual product
feature has been completed.

Keep this workflow lightweight: do not add runtime dependencies or workflow
scripts. If a configured custom role is unavailable, report that and stop
routed implementation; do not silently use a different model or role. After
changing agent configuration, a Codex reload may be needed before the roles
become available.
