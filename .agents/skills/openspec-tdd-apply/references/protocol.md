# Execution protocol

## Task preparation

Work from one clean Git root. Use `git status --porcelain=v1 --untracked-files=all`
and inspect the index before each task; require no staged, unstaged or untracked
work. Record `git rev-parse HEAD` as the baseline. Stop for an active merge,
rebase or other unfinished Git operation. Use a full checkout; do not proceed
with submodules, symlinked task paths, sparse checkout or assume-unchanged /
skip-worktree entries that could conceal changes.

Read project instructions and OpenSpec's current context files. Normalize the
CLI-returned `sourcePath` to a path inside this repository and verify its
one-based `line` still contains the intended unchecked task. Refresh instructions
if it moved. For schemas tracking several files, select only this task's file.
On older output without coordinates, read the schema-configured tracking file
and identify the unique task; never assume a filename.

In the conversation, retain the task text/location, baseline commit, intended
files, acceptance criteria, test commands, actual results and review-round count.
This is a task ledger, not a file to commit. Carry it across context compaction;
if evidence or prior review count cannot be recovered, stop instead of inventing
results or restarting the review budget. Do not write replacement guard scripts,
lock files, state stores or hooks. Serial execution and native Git inspections
are the orchestrator's responsibility.

## Developer and TDD

Create one developer agent per task. Use the named custom agent when available;
otherwise provide the corresponding `.codex/agents/openspec_tdd_developer.toml`
instructions to a generic subagent. If subagents are unavailable, stop rather
than substitute self-review. Give the developer the exact task, approved
requirements/design, baseline, intended files and test commands.

1. RED: write a meaningful behavioral test, run it before editing production
   behavior, and inspect its failing assertion. Capture the real command, exit
   status and output. Confirm only the planned test files changed at this point.
   Missing tests, skipped tests, broken imports/tool setup and synthetic failures
   are not evidence of the intended missing behavior.
2. GREEN: implement the minimum behavior and rerun the same focused command.
   Confirm it actually ran the intended tests and passed.
3. REFACTOR: improve structure only where useful, preserve behavior, and run the
   task's required regression tests and relevant lint/type/build checks. No forced
   refactoring is required. Capture each required command and its actual result.

Do not hide failures behind later passing commands. Use existing project test
commands directly; do not add a workflow runner. Avoid incidental untracked
outputs, for example using Python `-B` or `PYTHONDONTWRITEBYTECODE=1`. Retain raw
outputs in tool history or conversation rather than committing generated logs.

Tests and implementation belong to the same task. Documentation/configuration
work also needs a meaningful executable acceptance check if it is included in
this strict TDD workflow; if that cannot be established, stop for a plan revision
rather than waive TDD. Stop for scope ambiguity, missing infrastructure or needed
expansion of the intended file set; do not silently narrow the specification.
The developer never edits checkboxes, stages, commits, pushes or delegates review.

## Frozen candidate and independent review

Wait for all developer writes to finish. Inspect `git status` and the complete
tracked diff against the recorded baseline, including deletions and mode changes.
A native command is `git diff --binary --no-ext-diff --no-renames <base>`.
Separately list untracked files with `git ls-files --others --exclude-standard`
and inspect each file's full content and mode: ordinary `git diff` omits them.
Capture this exact candidate in the conversation and prove every file/hunk serves
the selected task. Confirm the tracking file and HEAD remain unchanged.

Spawn a separate reviewer; it must not have authored the candidate. Prefer fresh
context without the developer transcript. If the client can only fork the
orchestrator context, disclose that limitation and provide raw requirements,
diffs and outputs without the developer's persuasive summary. If named agents
are unavailable, use a generic subagent with the installed reviewer instructions.
No different model is required. Custom agents inherit parent permissions; the
reviewer's no-edit instruction is not a separate read-only sandbox.

Require a Markdown report in this form, populated from actual work:

- Task and baseline commit.
- Actual developer and reviewer runtime identities.
- Candidate files and reviewed scope, including new files.
- Verdict: PASS, CHANGES_REQUESTED or BLOCKED.
- Findings: file/line, defect, impact and required correction; none for PASS.
- Evidence: inspected RED assertion, GREEN and final checks, independently rerun
  checks, acceptance coverage and any verification limitations.

PASS requires no unresolved findings, full approved behavior, credible temporal
TDD evidence, meaningful tests, regression assessment and a minimal diff. Missing
required evidence/checks cannot receive PASS. The reviewer must inspect raw
outputs and rerun relevant non-mutating checks where possible. It must not edit,
format, stage, commit, alter tracking files or delegate fixes.

Count each review, including PASS: maximum three rounds total. A third-round PASS
may commit; a third-round rejection stops. BLOCKED stops immediately. Corrections
return to the developer, with regression RED/GREEN for behavior fixes and final
checks before another review. Do not reset the counter on a new candidate,
conversation or agent. Further attempts after exhaustion require the user to
resolve the blocker and authorize a retry. A reviewer cannot waive scope.

## Commit and recovery

Before committing, stop every task agent. Recheck baseline HEAD, index and task
file. Compare the complete tracked diff and all untracked file contents/modes
with the reviewed candidate. Any change, including a formatter or test side
effect, invalidates earlier PASS; rerun affected checks and review within the
same budget. If unchanged contents cannot be established, do not commit.

Only the orchestrator changes the selected `- [ ]` to `- [x]`, preserving every
other tracking byte. Stage explicit relevant paths with native Git, for example
`git --literal-pathspecs add --all -- <file1> <file2> <tracking-file>`. Substitute
actual individual files; never use `git add .`, broad globs or `git add -A` without
explicit paths. Inspect staged filenames and the entire staged diff; it must be
exactly the reviewed candidate plus this one checkbox change. Run
`git diff --cached --check`. Do not make checkbox-only or empty task commits.

Record the proposed tree with `git write-tree`, then make one descriptive commit
with normal hooks/signing. Verify its parent equals the baseline, its tree equals
the recorded tree, the tracking diff changes exactly one checkbox, and the
working tree/index are clean. Refresh OpenSpec apply instructions and confirm the
task is complete before starting another. Do not push or archive automatically.

On any failure, stop and report the actual HEAD, working tree/index, task status,
review rounds, remaining findings and recovery needs. Preserve all user work;
never discard, reset, stash, blindly unstage, amend, or make a second task commit
automatically. A failed hook can leave a checked checkbox and staged files;
report that state without claiming completion. If the commit succeeded but
postchecks failed, report its hash before proposing recovery. Resume only from
a reconciled state with recoverable evidence and the existing retry budget.

These are agent instructions, not enforced gates. There is no runtime lock,
automated digest check, identity authentication or persisted retry counter.
Native Git/test output and the independent reviewer provide evidence; the
orchestrator must inspect it faithfully. Other writers, trusted hooks and Git
filters can change files, so concurrent manual editing is unsupported.
