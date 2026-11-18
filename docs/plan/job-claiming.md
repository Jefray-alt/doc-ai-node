# Job claiming for multiple workers

**Status:** T1 completed in `ebe70d3`. T2a completed; T2b ready for
implementation. Worktree branch: `feat/job-claiming`.

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

**Task status:** Approved; implement T2a and then T2b, reviewing and committing
each before starting the next.

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

### T2a: Renew active ownership and discard abandoned attempts

**Task status:** Completed; independent review passed.

**Dependencies:** T1 reviewed and committed (`ebe70d3`).

**Scope:** Guarded repository renewal, named 30-second heartbeats, bounded
database acquisition/query cleanup, and per-attempt cancellation. Keep one
renewal in flight; stop and await it before saving an outcome. Ownership loss
or renewal errors abandon the attempt without writing an outcome or retry.
Include implementation and its unit/lifecycle/PostgreSQL tests together.
Retain the one-worker restriction until T2b passes.

**Acceptance and checks:** Demonstrate failing tests first. Verify renewal
extends only live matching ownership using PostgreSQL time, including expiry
during a lock wait. Verify no overlapping or late queued renewals after timeout,
long work remains owned, abandonment aborts cancellable I/O and suppresses all
outcomes, and persistence waits for renewal before checking attempt state.
Run focused tests, disposable PostgreSQL tests, backend unit/e2e checks,
type checking, lint, and build. Preserve T1 regression coverage.

**Proposed commit:** `feat(worker): renew leases and abandon lost ownership`

**Implementation notes:** Renewal retains the token and uses the existing
lock-first ownership check. A dedicated transaction has a five-second total
request budget (including checkout) and a two-second server statement timeout.
Failed/timed-out clients are disposed; late checkouts run no SQL. Heartbeats
schedule only after the previous request settles, and outcome writes first
stop and join renewal. Lost ownership aborts the attempt and suppresses results.
Checked-out clients get an error listener inside the checkout callback;
disconnects reject renewal, dispose once, and prevent further SQL. The listener
remains through pool release and is then removed.

**Validation:** Focused renewal/lifecycle tests (20), job regression tests (69),
disposable PostgreSQL tests (40), and backend tests (130 passed,
one known baseline startup exclusion) pass. PostgreSQL timeout checks confirm
the renewal backend disappears with no transaction, lock, or late update left
behind. Active-query and between-statement disconnect subprocess tests confirm
the process survives, rejects renewal, and issues no late SQL or commit.
Type checking, lint, build, direct compiled-worker shutdown, and
whitespace checks pass. The unchanged npm-wrapper SIGTERM assertion described
under T1 still fails; the direct worker exits gracefully with code 0.

### T2b: Complete shutdown and verify multiple-worker recovery

**Task status:** Approved; waiting for T2a review and commit.

**Dependencies:** T2a reviewed and committed.

**Scope:** Complete shutdown coordination and the two-worker recovery checks
specified above. Stop renewal promptly, abort cancellable I/O, join renewal and
database work and the parser, discard results, and best-effort release only a
live matching claim, including a claim returned after shutdown. Document
multiple-process support only after the concurrency checks pass; update the
roadmap with the completed capability. Include implementation and its tests.

**Acceptance and checks:** Cover shutdown during claim, HEAD/download, parsing,
renewal, and outcome persistence, with no timer leaks or new outcome writes
after stopping. Two independent workers against disposable PostgreSQL must
handle different jobs, exclude live owners, reclaim an abandoned attempt, and
reject its late result. Set stored expiry times explicitly for recovery tests.
Run backend unit/e2e, PostgreSQL, and existing Floci flow tests, type checking,
lint, build, and a direct compiled-worker shutdown check.

**Proposed commit:** `feat(worker): complete shutdown and multiworker recovery`

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

The initial combined estimate of **1,500-2,100 changed lines** led to the
user-approved T1-only slice (932 actual added and deleted lines). After that
size discussion and T1 completion, the user explicitly requested adding T2 as
well. The full remaining T2 scope is authorized despite the original size
guardrail; its current estimate is **1,050-1,400 added and deleted lines**,
including implementation, tests, adaptations, and documentation. Split it into
T2a (roughly 650-850) and T2b (roughly 400-550) for separate review and commits;
this split does not reduce the total scope estimate.
Retain the single-replica restriction until T2a, T2b, and the concurrency checks
pass. Update roadmap progress only with the completed multiple-worker capability.

Reference: PostgreSQL documents `SKIP LOCKED` for multiple consumers of a
[queue-like table](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE).
