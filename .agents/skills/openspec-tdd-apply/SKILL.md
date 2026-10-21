---
name: openspec-tdd-apply
description: Implement an OpenSpec change through serial TDD developer and independent reviewer subagents, with one isolated commit per reviewed task. Use for OpenSpec apply and implementation requests.
---

# OpenSpec TDD apply

Act as the orchestrator. Delegate implementation to `openspec_tdd_developer`
and review to a separate `openspec_tdd_reviewer`. Read
[the execution protocol](references/protocol.md) before starting. This skill
requests subagent delegation; it does not authorize publishing, pushing, or
changing the plan's scope.

Use the installed OpenSpec apply skill for change discovery, root resolution,
status, context, and readiness checks. Replace its implementation loop with the
protocol here. Do not start both loops or mark tasks done early.

Get current `openspec status --change <name> --json` and
`openspec instructions apply --change <name> --json`. Stop on command errors,
malformed JSON, unresolved roots/stores, missing artifacts, or `blocked` state.
Read the returned context files and apply relevant project context and guidance.
Select an unambiguous change; announce its name and current progress.

Before any writes, require a clean Git root with committed planning and workflow
files. Resolve every task's returned `sourcePath` and one-based `line`, verify
the unchecked text, and refresh instructions if it moved. All implementation and
tracking files must belong to this same Git repository. External stores,
submodules, sparse checkouts, symlinked task files, and hidden Git index entries
are unsupported: stop and explain. Never stash, discard, reset, or absorb user
work automatically.

For each task, serially:

1. Agree on behavior, test commands, and exact relevant files from the approved
   artifacts. Start `scripts/task_guard.py begin` from the repository root.
2. Spawn a developer with only this task and the relevant project context.
   Require an observed behavioral RED before production edits, then GREEN,
   then REFACTOR and passing final checks. Use the guard to record real commands.
3. Wait for the developer to finish; freeze edits and obtain the guard snapshot.
   Spawn a fresh independent reviewer. Supply requirements, the base commit,
   candidate digest, diff including new files, and TDD logs. Do not supply a
   suggested verdict or the developer's persuasive summary.
4. Register its report with the guard. Allow at most **three review rounds
   total** (initial review plus two correction rounds). Send concrete findings
   to the developer; rerun checks and get a new review after every correction.
   A blocked review, missing evidence, unavailable subagents, or exhausted budget
   stops the task. Preserve the unchecked task and work for recovery.
5. On a current independent PASS, stop/wait for all task agents, inspect the
   allowlist and exact candidate, and use guard `commit`. The guard changes only
   this checkbox and stages only this task's files. Developers/reviewers must
   never stage, commit, or modify tracking files.
6. Verify the resulting commit and clean working tree. Refresh OpenSpec apply
   instructions, confirm the task is complete, and continue to the next task.

Only the orchestrator commits. One successful task means one commit containing
its code, tests, required supporting files, and exactly its checkbox. No WIP/RED
commits, bulk staging, amend, auto-stash, auto-push, or bypassing hooks. If a hook
changes files or a commit fails, stop for recovery; never retry blindly.

Report completed tasks with commit hashes, test evidence, review rounds, current
OpenSpec progress, and any blocker. Suggest verification/archive after completion;
do not archive automatically. Do not claim behavioral TDD or independent review
unless the actual execution evidence supports it.
