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

This skill contains Markdown instructions only. Use normal Git, OpenSpec and
project test commands directly. Do not create or depend on a replacement helper
script, hook, runtime state file, or automated gate for this workflow. The
orchestrator is responsible for checking the protocol and retaining evidence in
the conversation; these rules are not mechanically enforced.

Use the installed OpenSpec apply skill for change discovery, root resolution,
status, context, and readiness checks. Replace its implementation loop with this
protocol. Do not start both loops or mark tasks done early.

Get current `openspec status --change <name> --json` and
`openspec instructions apply --change <name> --json`. Stop on command errors,
malformed JSON, unresolved roots/stores, missing artifacts, or `blocked` state.
Read the returned context files and apply relevant project context and guidance.
Select an unambiguous change; announce its name and current progress.

Before any writes, require a clean Git root with committed planning and workflow
files. Resolve each task's returned `sourcePath` and one-based `line`, verify the
unchecked text, and refresh instructions if it moved. Code and tracking files
must belong to the same Git repository. External stores, submodules, sparse
checkouts, symlinked task files and hidden index entries are unsupported. Never
stash, discard, reset, or absorb user work automatically.

For each task, serially:

1. Check the clean working tree and empty index. Record HEAD, exact unchecked
   task, acceptance criteria, relevant file list and test commands in the
   conversation. Do not begin another task or allow concurrent writers.
2. Spawn a developer with only this task and relevant project context. Require
   observed behavioral RED before production edits, then GREEN with the same
   focused command, then REFACTOR and passing final checks. Retain actual command
   output and exit statuses; summaries alone do not establish TDD.
3. Wait for the developer to finish and freeze writes. Capture the complete
   candidate: tracked diff plus the list, content and modes of new files. Spawn
   a fresh independent reviewer with raw requirements, base commit, exact
   candidate and test evidence, without a suggested verdict or developer pitch.
4. Record its Markdown verdict and findings in the conversation. Allow at most
   **three review rounds total** (initial review plus two correction rounds).
   Send findings to the developer; rerun checks and review the revised candidate.
   A blocked review, missing evidence, unavailable subagents, or exhausted budget
   stops the task. Preserve the unchecked task and working files for recovery.
5. On a current independent PASS, stop/wait for all task agents and compare HEAD,
   candidate contents and modes against what was reviewed. Any change requires
   fresh checks and review within the same budget. Only the orchestrator checks
   this task's checkbox, stages its explicit files, inspects the staged diff,
   and makes one commit. Developers/reviewers never stage, commit, or edit tasks.
6. Verify the commit's parent, complete contents, single checkbox change and clean
   working tree. Refresh OpenSpec apply instructions, confirm completion, then
   continue to the next task in this change.

One successful task means one commit containing its code, tests, required
supporting files and exactly its checkbox. No WIP/RED commits, bulk staging,
amend, auto-stash, auto-push or bypassing hooks. A failed commit or hook that
changes files requires recovery inspection; never retry blindly.

Report completed tasks with commit hashes, test evidence, review rounds, current
OpenSpec progress and blockers. Suggest verification/archive after completion;
do not archive automatically. Do not claim TDD or independent review without
actual evidence, or describe this written protocol as an automated guarantee.
