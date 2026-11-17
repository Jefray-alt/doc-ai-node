# Job claiming for multiple workers

**Status:** T1 completed; T2 deferred to a
separately scoped follow-up. Worktree branch: `feat/job-claiming`.

**Outcome:** Independent worker processes can handle different upload jobs at
the same time. Each job has one current owner; abandoned claims expire, and a
previous owner cannot save an outcome after losing ownership.

## Scope

Cover both `awaiting_upload` object checks and `uploaded` PDF extraction. Keep
one active job per process, existing status alternation, upload expiry rules,
extraction outcomes, and five-second retry behavior. Ordering stays by due time,
then creation time, with upload ID as a deterministic tie-breaker; locked or
actively leased jobs are skipped. Alternation is per process, not a global
fairness guarantee.

Chunking, embeddings, vector storage, concurrency inside a process, autoscaling,
a new queue service, retry limits, and parser isolation are outside this slice.
Multiple processes become supported; launching extra replicas is a later
operational choice. Do not automatically implement chunking afterward.

## Design

### Ownership and atomic claiming

- Add nullable `claim_token` (UUID) and `lease_expires_at` (timestamp with time
  zone) to `jobs`. Require both fields to be set or both null, and forbid claims
  on terminal jobs. Existing rows start unclaimed; no new processing status is
  needed. Use a fresh token for every claim, including reclamation.
- Replace worker read-only selection with atomic claim operations. In one SQL
  statement, select one due job of the requested status using
  `FOR UPDATE SKIP LOCKED`, record its token and expiry, and return the claimed
  job. Claim only unclaimed jobs or jobs with an expired lease. Return no job
  when none are eligible. Commit before starting S3 or PDF work.
- Use PostgreSQL time for lease eligibility, expiry, and renewal to avoid worker
  clock disagreement. Review existing due-work indexes with the claim query;
  add or change an index only where the query needs it.
- Require upload ID, claim token, expected status, and an unexpired lease for
  every worker outcome or scheduling update. Successful handling clears the
  claim in the same update that changes status or schedules the next check.
  Remove worker access to the old unguarded mutation paths.
- Renewal extends only a matching, still-live claim. An expired token cannot
  renew or complete even before another worker reclaims the job. A zero-row
  update means ownership was not accepted, not successful processing.

### Lease lifecycle

- Start with a two-minute lease and a renewal every 30 seconds. Keep these as
  named constants; configuration and tuning can follow measured need. Keep at
  most one renewal request active for a job and bound its database request time.
- Renew throughout active object checks or extraction. A renewal rejection or
  database error conservatively abandons the local attempt: stop renewal,
  abort cancellable I/O, and discard its outcome. Do not write a failure or
  retry for an attempt whose ownership is uncertain. Let the lease expire.
- Before saving an outcome, stop renewal and await its in-flight request. Save
  only if the attempt is still active; the database checks ownership and expiry
  again. This prevents a late heartbeat from racing successful completion.
- A worker crash requires no cleanup service: the ordinary claim query can
  reclaim the due row after lease expiry. If an outcome write fails, stop
  renewal and let expiry provide recovery. A committed outcome whose response
  was lost remains authoritative in PostgreSQL.
- Stop claiming on shutdown and abort the active download or object check.
  Stop and await any in-flight renewal, await remaining parser work, discard
  its outcome, and then best-effort clear only the still-live matching claim.
  Handle a claim request that returns after shutdown the same way. If release
  fails, expiry provides recovery. Shutdown must not start another job.
- PDF parsing currently cannot be forcibly interrupted and can delay the Node
  event loop. Heartbeats therefore cannot guarantee uninterrupted ownership.
  Separate processes provide parallelism; claim checks protect saved outcomes
  if parsing outlasts a lease. Retries may repeat computation. This does not
  provide exactly-once execution or a hard processing deadline.

## Ordered tasks and commits

### T1: Claim jobs and require ownership for outcome writes

**Task status:** Completed; independent review passed.

**Scope:** Migration, repository claim/guard/release operations, worker integration
for both statuses, and the tests needed to verify that behavior. Include necessary
fixture and module-test updates. No heartbeat yet; retain the documented
single-replica restriction until T2 is complete.

**Dependencies:** None. At implementation startup, follow
[agent-workflow.md](../agent-workflow.md). Proposed branch:
`feat/job-claiming`; branch creation requires the workflow's explicit approval
if starting on `main`.

**Acceptance and checks:** Demonstrate failing tests before production changes.
Use separate PostgreSQL connections to verify competing claims cannot both own
one row, different jobs can be claimed concurrently, and a locked row is skipped.
Cover both statuses, due ordering, live-lease exclusion, expired reclamation,
and token replacement. Verify stale, expired, or wrong-status attempts cannot
confirm, expire, complete, fail, reschedule, or release a job, and valid outcome
writes clear ownership. Preserve upload and extraction regression coverage.
Run relevant unit/module tests and the disposable PostgreSQL suite, plus backend
type checking, linting, and build.

**Proposed commit:** `feat(jobs): claim work and guard processing outcomes`

**Implementation notes:** Fixed two-minute claims use PostgreSQL time; all worker
outcomes and releases require live matching ownership. Shutdown releases unused
claims but leaves uncertain outcome writes to expiry. Existing due-work indexes
were checked with `EXPLAIN` and retained. No heartbeat or dependency was added.
Guarded updates first acquire the row lock through a `MATERIALIZED` CTE, then
check token, status, and `clock_timestamp()` before atomically saving the outcome
and clearing ownership. This rejects a lease that expires during a lock wait.

**Validation:** Focused repository/worker tests (49) and disposable PostgreSQL
tests (31, including eight lock-wait expiry regressions) pass, as do type checking,
lint, build, and whitespace checks. Full
backend and e2e runs pass with 110 tests and one baseline failure excluded, using
`--maxWorkers=1 --hookTimeout=30000` and
`--testNamePattern='^(?!.*starts the compiled worker without an HTTP listener)'`.
The excluded startup test sends SIGTERM through `npm start:worker` and fails its
exit-code assertion on both this candidate and an untouched baseline snapshot.
Its source/configuration remain unchanged; a direct compiled-worker smoke check
confirms no HTTP listener and graceful shutdown with exit code 0.

### T2: Renew leases and finish crash and shutdown recovery

**Task status:** Deferred; do not implement in the current work.

**Scope:** Worker lease lifecycle, guarded renewal operations, recovery
tests, and backend operating instructions. Update this plan's task status on
completion; update roadmap progress only after the capability is complete.

**Dependencies:** T1 reviewed and committed.

**Acceptance and checks:** Demonstrate failing lifecycle tests first. Verify
renewals keep long work owned, renewals never overlap, renewal failure discards
results, and expired ownership cannot be revived. Test shutdown during claim,
download, parsing, renewal, and outcome persistence; await active database
operations and leave no heartbeat timers behind. Already-issued outcome writes
may commit; no new outcome write starts after shutdown or abandonment.

Exercise two independent worker instances against disposable PostgreSQL with
controlled S3/extraction doubles: each handles a different job, a live lease
blocks duplicate claims, an abandoned attempt is reclaimed, and a late result
from the old attempt cannot alter the replacement owner's state. Set stored
lease times explicitly for deterministic expiry tests instead of long sleeps.
Run backend unit/e2e suites, PostgreSQL integration tests, and the existing Floci
flow, plus type checking, linting, and build. Document support for multiple
worker processes and the lease/retry limitations.

**Proposed commit:** `feat(worker): renew job leases and recover abandoned work`

## Review, rollout, and size

Each task includes implementation and its tests. The configured implementer
must complete independent review and its separate commit before starting the
next task; do not push. Planning stays in the main session.

Keep this Markdown plan in `docs/plan/` current as decisions, scope, and task
status change, following the planning-document rule in [AGENTS.md](../../AGENTS.md).

Before rollout, stop all old workers, apply migrations, and start only the new
worker version. Old workers do not honor claims; mixed versions are unsupported.
No extra database, runtime dependency, or general-purpose queue framework is
required.

Startup reassessment: **1,500-2,100 total added and deleted lines**, including
existing test adaptations, new ownership and lifecycle coverage, and documentation,
across both tasks. This exceeds the original 850-1,000-line estimate. Before
coding, agree a smaller scope with the user. The user approved T1 only,
estimated at 850-1,000 changed lines; separately scope T2 after T1 is reviewed
and committed. T2 is outside the current implementation scope.
Retain the single-replica restriction until both tasks and the concurrency checks
pass. T1 does not complete the multiple-worker capability or change the roadmap.

Reference: PostgreSQL documents `SKIP LOCKED` for multiple consumers of a
[queue-like table](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE).
