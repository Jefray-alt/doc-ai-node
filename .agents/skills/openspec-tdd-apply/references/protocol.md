# Execution protocol

## Roles and task boundaries

Tasks run serially against one clean branch or user-selected worktree. A developer
and reviewer are separate agent identities per task; no reviewer may review its
own implementation. Use the named custom agents when the runtime supports them.
If the runtime exposes only generic subagents, load the respective installed
`.codex/agents/openspec_tdd_*.toml` instructions into separate agents. If neither
is available, stop; self-review cannot stand in for an independent reviewer.

Prefer a fresh reviewer context without the developer's conversation. If the
client can only fork the orchestrator's context, state that limitation and keep
the developer transcript out of the orchestrator context; pass raw requirements,
diffs and logs. Independence means a separate actor assessing evidence, not a
guaranteed independent model or OS sandbox. Custom agents inherit parent
permissions; a no-edit instruction alone does not enforce read-only access.

Read project instructions before delegating. Give the developer: exact task text,
acceptance criteria, relevant specs/design, baseline commit, allowed file list,
test commands, and guard location. Return control on scope changes or missing
test infrastructure. Do not silently waive TDD for documentation/configuration
tasks: define a meaningful failing executable acceptance check first, or stop
and ask for a plan revision. Do not manufacture a failure with `false`, skipped
tests, import errors, or a failing tool installation.

Each task must deliver independently useful behavior with tests. RED/GREEN/
REFACTOR are phases inside one task, not separate task checkboxes. Split an
oversized task in the planning workflow before implementation. If the allowlist
needs to expand after begin, stop and preserve work for explicit replanning;
do not edit guard state to expand it mid-task.

## Guard commands

Run from the Git root. In these examples `guard` means the full command:

```sh
python3 .agents/skills/openspec-tdd-apply/scripts/task_guard.py
```

`guard` is explanatory shorthand, not an installed executable. Replace the
sample paths and line with the CLI-returned location. Normalize `sourcePath`
to a repository-relative path and prove it stays inside this Git root. This
also supports schemas tracking multiple files: select just the current task's
file/line each time. Older OpenSpec output without source coordinates requires
reading the schema's configured tracking file and verifying a unique checkbox;
never assume its filename.

```text
guard begin --task-file openspec/changes/add-greeting/tasks.md --line 3 \
  --allow greeting.py --allow test_greeting.py --test test_greeting.py
guard check --phase red -- python3 -m unittest test_greeting
guard check --phase green -- python3 -m unittest test_greeting
guard check --phase refactor -- python3 -m unittest discover
guard snapshot
guard review --report /absolute/path/outside/project/review.json
guard commit --message "feat(greeting): implement task 1.1"
guard status
```

The helper records command argv, real exit status, output logs, candidate hashes,
and review submissions under the Git common directory's `openspec-tdd/` folder.
These are local evidence, not additional commits. `begin` acquires a repository
lock and captures the clean baseline and complete tracking file. It accepts
explicit files, including files to be created/deleted; no directory allowlists.
It rejects ignored allowlisted paths. Test files must be a subset of the allowlist.
Use test commands that avoid incidental untracked outputs (for example Python
`-B` or `PYTHONDONTWRITEBYTECODE=1`) and existing project ignore conventions for
build artifacts. Do not broaden staging to absorb generated caches or logs.

For the initial RED, only allowlisted test files may differ from the baseline.
The developer must inspect the expected failing outcome and show an assertion failing
for the intended missing behavior. Then implement the minimum behavior and rerun
the same focused command for GREEN. During REFACTOR, preserve behavior, improve
the code as needed (no forced edits), and run all checks required for the task,
including the relevant regression suite. Use a project check command/script that
runs all mandatory checks if more than one tool is needed; do not hide failures.
Later review fixes require regression RED/GREEN where behavior changes, followed
by final REFACTOR checks. The helper enforces phase order and records outcomes;
the reviewer must judge the meaning, coverage, and validity of those outcomes.

RED expects assertion-failure exit status 1 by default. If a project's runner
documents a different assertion-failure status, pass `--red-exit-code N` before
`--`. Do not use this option to relabel missing tests, runner errors or setup
failures as RED. Unexpected statuses and executables that fail to start stop the
phase; failed checks also invalidate any earlier final-check evidence.

The final passing refactor event must match the exact candidate digest. Any
subsequent file/mode change invalidates that evidence and any existing PASS.
Stop every writer before snapshot/review/commit. No test command may format or
change files during review. Include new files and deletions in the review; a plain
`git diff` does not display untracked file contents.

## Review report

The reviewer returns this JSON structure, with actual runtime agent identities,
the supplied candidate digest and its own evidence. The orchestrator saves the
returned JSON outside the project working tree, then calls `guard review`.
Never invent an agent identity or translate a non-passing review into PASS.

```json
{
  "developer_id": "actual-developer-thread-id",
  "reviewer_id": "actual-separate-reviewer-thread-id",
  "digest": "sha256-from-guard-snapshot",
  "verdict": "pass",
  "findings": [],
  "evidence": "Requirements inspected, RED assertion verified, checks rerun, coverage and exact diff assessed."
}
```

Verdicts: `pass`, `changes_requested`, `blocked`. Findings for a non-passing
review should name a file/line, defect, impact, and required correction.
PASS requires no unresolved findings and verified acceptance criteria, credible
RED/GREEN/REFACTOR evidence, meaningful tests, regressions considered, and a
minimal task-scoped diff. Missing evidence is not PASS. A review cannot waive
the approved behavior or expand its scope.

The guard counts every submitted review, including PASS. Default maximum: three
rounds. A third-round PASS may commit; a third-round rejection stops. `blocked`
stops immediately. Never restart begin/abort to evade this limit. Any new attempt
after exhaustion requires the user to resolve the blocker and authorize a retry.

## Commit and recovery

The snapshot digest covers HEAD, original tracking bytes/location, changed
filenames, content hashes, deletions and executable modes. `commit` demands a
current PASS, flips one checkbox, stages explicit literal paths, verifies the
staged file set, runs whitespace checks and normal Git hooks, and checks the
commit's parent/tree plus the final clean state. The reviewer must inspect that
each allowed file and hunk belongs to this task; file scoping cannot establish
semantic relevance. An empty/checkbox-only task cannot commit.

Git hooks, attributes/filters, signing, test commands and other local tools are
trusted project code. The guard is a cooperative workflow safeguard, not an
adversarial security boundary or proof of identity/test correctness. Avoid
simultaneous manual editors and other agents. It cannot make filesystem snapshots
and Git commands atomic against an uncooperative concurrent writer.

On failure, inspect `guard status`, Git status, logs and the actual last commit.
Do not reset, discard, stash, unstage user work, amend, or make a second commit
for the same task automatically. A failed hook may leave a checked checkbox and
staged files; report that state without calling the task complete. Repair only
known workflow-owned changes with the user's guidance. If a commit succeeded but
postchecks failed, report its hash before proposing a recovery.

After stopping all task agents, `guard abort` archives the local state and
releases the lock while preserving every file and the index. It does not clean
the checkout or authorize another attempt. A crash between lock creation and
state writing may require manual lock inspection/removal; never remove a live
task's lock. Only begin again from a reconciled clean tree.
