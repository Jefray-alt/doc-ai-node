# Backend and MinIO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Track steps with the checkboxes below.

**Goal:** Deliver direct PDF uploads to local MinIO, durable status/webhook handling, and background validation with backend tests.

**Architecture:** Express creates reservations and handles metadata/status/events; clients upload PDF bytes directly to MinIO. PostgreSQL stores document state and pg-boss jobs. A separate worker validates an immutable staging version, copies it into the accepted bucket, commits success, and cleans up staging.

**Tech Stack:** Existing Node 24, Express 5, TypeScript, and npm; `pg` 8.23.1, `pg-boss` 12.38.0, `minio` 8.0.7, `pdf-lib` 1.17.1, and `@types/pg`; native `node:test` and `node:assert/strict`. Resolve/install these only during approved execution; commit the backend lockfile. Multer is not needed.

**Spec:** [Approved PDF upload design](pdf-upload-design.md). The user approved the revised design/scope; this new executable checklist awaits review and an execution-method choice. Earlier synchronous upload plans are superseded.

## Global Constraints

- Backend/infrastructure only. No frontend plan/code, session implementation, extraction, tokenization, embeddings, or generated answers.
- Preserve `GET /health`. Implement JSON `POST /documents`, `GET /documents/:id/status`, and authenticated `POST /webhooks/minio` with the exact response/error contracts in the spec.
- **10 MiB (10,485,760 bytes)** maximum; exactly the maximum is accepted. PDF extension/MIME metadata checks precede signing; actual content validation happens in the worker.
- Two private buckets, `staging` and `documents`; UUID key `<id>.pdf` in each. Version staging; only the selected immutable version can be validated/copied. Browser permission expires after **30 minutes** and permits one exact key/type/declared byte size.
- Status: `awaiting_upload -> queued -> validating -> uploaded`; terminal `failed`/`expired`. A validated upload is not ready for questions.
- Copy/finalize: initial attempt plus **three retries**, delayed **10, 30, 90 seconds**, **5-minute** per-stage deadline. Cleanup: initial plus three retries delayed **1, 5, 15 minutes**, **30-minute** deadline. Calls are capped at **30 seconds** and the remaining stage budget. Persist attempts/deadlines across restarts; no sleeping while occupying a job slot.
- Cleanup never changes an `uploaded` document to `failed`. Failed finalization keeps both copies and requires reconciliation; confirmed copies are not repeated.
- Recovery checks awaiting uploads every **minute**; abandoned/replayed completed versions become cleanup candidates after **24 hours**, excluding active validation/reconciliation sources. MinIO temporary-data settings: expiry **24h**, scan interval **1h**.
- API and worker run on the host. Compose runs MinIO, initializer, and PostgreSQL with named volumes and localhost ports **9000**, **9001**, **5432**.
- `npm test` requires no Docker/credentials; integration checks use separate isolated resources. Type-check tests without emitting them into `dist/`. Update the roadmap only with actual implementation/verification results.

## Review Focus

- An upload finishes but its webhook is delayed/lost: reconciliation finds the timely version before expiring the reservation (tasks 2, 5, 6).
- Duplicate events and simultaneous API/worker instances: claim one version/job and preserve retry counts/status monotonicity (tasks 2, 4, 5, 6).
- Copy/commit succeeds but its acknowledgement is lost: inspect destination metadata/database state before repeating work (tasks 3, 5, 6).
- Upload URL is replayed while validation runs: later versions cannot replace accepted content or erase the selected source (tasks 3, 5, 6).
- Browser abort/server restart/cleanup failure: no partial object is processed, pending work survives, and accepted documents remain available (tasks 3, 5, 6).

## File Map

- `backend/src/documents/`: `document.types.ts`, `upload-error.ts`, `validate-upload.ts`, `validate-pdf.ts`, `documents.service.ts`, `documents.router.ts`, `documents.repository.ts`, `upload-events.ts`.
- `backend/src/db/`: `database.ts`, `database.types.ts`, `migrate.ts`, `migrations/001-documents.sql`.
- `backend/src/jobs/`: `job.types.ts`, `job-queue.ts`, `retry-policy.ts`, `validation-job.ts`, `recovery-job.ts`, `cleanup-job.ts`.
- `backend/src/storage/`: `storage.types.ts`, `storage-config.ts`, `minio-storage.ts`; `backend/src/config.ts` owns process settings.
- Modify `backend/src/app.ts`, `backend/src/server.ts`; add `backend/src/worker.ts` and `backend/src/app.types.ts` for composition/dependencies.
- `backend/test/*.test.ts` plus `backend/test/helpers/{pdf-fixtures,fakes,http}.ts` for unit/request tests; `backend/test/integration/*.test.ts` and `helpers.ts` for opt-in Docker tests.
- Backend package files and `tsconfig.test.json`; `compose.yaml`, `docker/minio/{Dockerfile,init.sh,upload-policy.json,worker-policy.json}`, root/backend environment examples, `.gitignore`, READMEs, and roadmap.

## Task 1: Document contracts, PDF validation, and unit-test tooling

**Files:** Create `document.types.ts`, `upload-error.ts`, `validate-upload.ts`, `validate-pdf.ts`, `retry-policy.ts`, test helpers, `test/{validate-upload,validate-pdf,retry-policy}.test.ts`, and `tsconfig.test.json`; modify backend package files.

**Interfaces:**
- `UploadMetadata = { filename: string; size: number; contentType: 'application/pdf' }`; `DocumentStatus` contains only the six statuses above.
- `DocumentRecord` names its fields `documentId`, `filename`, `declaredSize`, `contentType`, `stagingKey`, nullable `stagingVersionId`/`acceptedKey`, `status`, nullable safe `error`, `expiresAt`, `createdAt`, and `updatedAt`. It also stores `revision`, nullable `currentJobId`/current `stage`, `attempt`, nullable `stageStartedAt`/`runAfter`, `cleanupPending`, and `reconciliationRequired`. Dates are `Date` values inside the backend. `Clock = { now(): Date }` is owned by `document.types.ts`.
- `UploadError(status: number, code: string, message: string)`; `validateUpload(input: unknown): UploadMetadata`; `validatePdf(bytes: Buffer): Promise<void>`; `MAX_PDF_BYTES = 10 * 1024 * 1024`.
- `RetryStage = 'validate' | 'copy' | 'finalize' | 'cleanup'`; `RetryDecision = { retryAt: Date } | { exhausted: true }`; `planRetry(stage: RetryStage, completedAttempts: number, startedAt: Date, now: Date): RetryDecision`. Attempt 1 is the initial call, not the first retry.

- [ ] Install the listed dependencies after approval; add `test: node --test test/*.test.ts`. Add a no-emit test tsconfig extending the source config with `rootDir: "."` and `include: ["src", "test"]`; point `typecheck` at it. Keep the production build scoped to `src` and copy migration SQL into `dist/db/migrations` as part of the build.
- [ ] Write named validator/boundary tests and controlled PDF fixtures, including uppercase extension, wrong/missing type/extension, fractions/zero/oversized declared sizes, malformed/empty/encrypted/spoofed PDFs, and exact maximum bytes. Pin representative assertions:

  ```ts
  assert.equal(validateUpload({ filename: 'report.PDF', contentType: 'application/pdf', size: 10_485_760 }).size, 10_485_760);
  assert.throws(() => validateUpload({ filename: 'report.pdf', contentType: 'application/pdf', size: 10_485_761 }), { status: 413 });
  const firstRetry = planRetry('copy', 1, start, start);
  assert.ok('retryAt' in firstRetry);
  assert.equal(firstRetry.retryAt.getTime(), start.getTime() + 10_000);
  assert.deepEqual(planRetry('copy', 4, start, start), { exhausted: true });
  ```

- [ ] Run `cd backend && node --test test/validate-upload.test.ts test/validate-pdf.test.ts test/retry-policy.test.ts`; verify failure for missing implementation.
- [ ] Implement metadata validation and `%PDF-` signature/size checks; load PDFs with pdf-lib `ignoreEncryption: false`, `throwOnInvalidObject: true`, `updateMetadata: false`, and resolve the catalog/page tree. Generate fixtures locally, with valid trailing whitespace for byte-boundary PDFs and a low-level encryption-marked fixture. Implement the exact retry table; test deadlines and all three delay values with the injected clock.
- [ ] Run those tests and `npm run typecheck`; require zero failures. Commit as `feat(backend): define tested PDF validation and retry contracts`.

## Task 2: PostgreSQL document repository and transactional durable jobs

**Files:** Create the `db/` modules/migration, `documents.repository.ts`, `job.types.ts`, `job-queue.ts`, `config.ts`, and `test/{documents.repository,job-queue,config}.test.ts`.

**Interfaces:**
- `SqlExecutor` exposes `query<Row>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>`; `Database` extends it with `transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>` and `close(): Promise<void>`.
- `createDocumentRepository(db: Database, queue: JobQueue)` returns `insert(metadata: UploadMetadata, id: string, expiresAt: Date): Promise<DocumentRecord>`, `get(id: string): Promise<DocumentRecord | null>`, and `claimAndEnqueue(event: UploadEvent, now: Date): Promise<boolean>`. `UploadEvent = { documentId: string; versionId: string; occurredAt: Date }` is owned by `document.types.ts`.
- The same repository owns `saveProgress(id: string, expectedRevision: number, patch: DocumentProgressPatch, tx: SqlExecutor): Promise<boolean>`, `listAwaiting(): Promise<DocumentRecord[]>`, `listRecoverableJobs(now: Date): Promise<DocumentRecord[]>`, and `listCleanupCandidates(before: Date): Promise<DocumentRecord[]>`; `DocumentProgressPatch` is a typed subset of status/progress fields from task 1.
- `JobPayload = { documentId: string }`; `JobContext = JobPayload & { jobId: string; kind: 'validation' | 'cleanup' }`. `JobQueue` exposes `enqueue(kind: JobContext['kind'], payload: JobPayload, runAfter: Date, tx: SqlExecutor): Promise<string>`, `completeCurrent(context: JobContext, tx: SqlExecutor): Promise<void>`, `getState(context: JobContext): Promise<'queued' | 'active' | 'completed' | 'failed' | 'expired' | 'missing'>`, and runtime start/stop methods. `createJobQueue` adapts pg-boss to the caller's SQL transaction; save the returned job ID with document progress in that transaction.
- `readConfig(env: NodeJS.ProcessEnv): AppConfig` validates `DATABASE_URL`, internal/public MinIO endpoint URLs, separate signer/worker keys, staging/documents bucket names, `MINIO_REGION`, `WEBHOOK_SECRET`, `ALLOWED_ORIGIN`, `HOST`, and `PORT`; concrete environment names live in matching root/backend examples. Never read credentials at module import time.

- [ ] Write repository/queue unit tests with controlled SQL/transaction fakes. Test new records, atomic version claiming, conditional revision updates, rollback if enqueue fails, duplicate claims leaving progress unchanged, expiry respecting event timestamps, and parameterized IDs. Pin `assert.equal(await repo.claimAndEnqueue(event, now), false)` for a previously claimed version and `assert.equal(fakeQueue.enqueued.length, 0)` after rollback.
- [ ] Run `cd backend && node --test test/documents.repository.test.ts test/job-queue.test.ts test/config.test.ts`; require the expected missing-implementation failure.
- [ ] Implement SQL migration/version tracking with a migration lock and transactional document updates/job insertion. Conditional state/revision updates must prevent concurrent event claims and stale worker writes. Persist an attempt before each external operation; preserve stage start/deadline across retries. Configure connection acquisition and statement deadlines, close clients, and sanitize errors. Use no ORM or custom polling queue.
- [ ] Implement pg-boss queues with `policy: 'exclusive'` and `singletonKey: documentId`, permitting two different documents to run but only one queued/active job per document in each queue. To schedule a continuation on that queue, complete the current job and enqueue its successor inside the same SQL transaction; otherwise the exclusive policy would reject it. Check enqueue results instead of silently dropping conflicts. Disable overlapping SDK/queue business retry policies: pg-boss persists scheduled attempts, while task 1 decides exact delays/counts. Crashed-job recovery resumes the stored stage/budget. Load authoritative state from PostgreSQL.
- [ ] Add `npm run migrate` and `npm run migrate:prod` for source/compiled entry points, both resolving SQL relative to their module. Run unit tests/type checking; commit as `feat(backend): persist upload records and durable validation jobs`. Real transaction/concurrency checks run in task 6 after Compose is available.

## Task 3: MinIO adapter, scoped credentials, and Docker infrastructure

**Files:** Create the storage modules, `test/{storage-config,minio-storage}.test.ts`, Compose and `docker/minio/` files; update environment examples/root ignore rules.

**Interfaces:**
- `SignedUpload = { url: string; fields: Record<string, string>; expiresAt: string }`.
- `StoredVersion = { versionId: string; size: number; contentType: string; lastModified: Date; metadata: Record<string, string> }`; `StorageOperations` contains `signUpload(id: string, metadata: UploadMetadata, expiresAt: Date): Promise<SignedUpload>`, `statStaging(id: string, versionId?: string): Promise<StoredVersion | null>`, `readStaging(id: string, versionId: string): Promise<Buffer>`, `statAccepted(id: string): Promise<Omit<StoredVersion, 'versionId'> | null>`, `copyAccepted(record: DocumentRecord): Promise<void>`, `removeStaging(id: string, versionId: string): Promise<void>`, and `listStagingVersions(before: Date): AsyncIterable<{ documentId: string; version: StoredVersion }>`. Staging must return a real version ID; the accepted bucket need not be versioned.
- All object operations accept an optional `AbortSignal` in a final options argument and honor caller deadlines; reads cap bytes, including unknown/chunked sizes. Use separate signer and worker SDK clients. Destination metadata includes encoded filename, document ID, and exact source version; content type is `application/pdf`.

- [ ] Write adapter tests for exact-key/type/size/expiry policy, browser-accessible signed endpoint, version-specific stat/get/copy/delete, bounded streams, safe filename metadata, destination inspection, absent-object handling, and sanitized dependency failures. Pin `assert.equal(policy.maxBytes, 10_485_760)` for a maximum reservation and `assert.equal(copy.sourceVersionId, record.stagingVersionId)` using the SDK fake.
- [ ] Run `cd backend && node --test test/storage-config.test.ts test/minio-storage.test.ts`; confirm missing implementation fails, then implement the adapter/config and rerun tests/type checking. On a timed-out operation, actually abort/destroy the underlying request/stream rather than merely rejecting a timer promise; cover this in the fake transport test.
- [ ] Build local Dockerfile targets `server` and `client` from upstream MinIO `RELEASE.2025-10-15T17-29-55Z` and mc `RELEASE.2025-08-13T08-35-41Z`. Resolve verified immutable builder/runtime image digests during execution and retain upstream notices. Compose uses build context `docker/minio`, PostgreSQL 18 pinned to a verified digest, and named data/notification/database volumes; preserve existing user files/volumes.
- [ ] Implement repeatable init: create private buckets, enable staging versioning, apply separate signer/worker identities and policies, and attach only staging creation events. Configure explicit browser origins with MinIO's `MINIO_API_CORS_ALLOW_ORIGIN` server setting; do not assume per-bucket S3 CORS APIs are available in this release. Cap readiness attempts at 60 one-second intervals; propagate failures. Use `host.docker.internal:host-gateway` for the host webhook and an explicit API listening-address setting. Enable persistent webhook queue and the spec's temporary-data cleanup settings. Keep admin secrets only in init/server settings, never browser responses.
- [ ] Run `docker compose config --quiet`, build/start MinIO/PostgreSQL, and verify initialization/bucket policies/versions without the upload API. Separate base initialization from event attachment as needed so a missing callback cannot deadlock startup; final event attachment is verified after task 4. Document this sequence in environment-file comments and commit as `feat: configure private MinIO uploads and local PostgreSQL`.

## Task 4: Reservation, status, and authenticated MinIO webhook API

**Files:** Create `documents.service.ts`, `documents.router.ts`, `upload-events.ts`, `app.types.ts`, `test/{documents.service,upload-events,app}.test.ts`, HTTP helper; modify `app.ts`/`server.ts`.

**Interfaces:**
- `UploadReservation = { documentId: string; status: 'awaiting_upload'; statusUrl: string; upload: SignedUpload }`; `DocumentStatusResponse = Pick<DocumentRecord, 'documentId' | 'filename' | 'status'> & { updatedAt: string; error?: { code: string; message: string } }`. Serialize timestamps as ISO strings in API responses.
- `createDocumentService(deps: { repository: ReturnType<typeof createDocumentRepository>; storage: StorageOperations; clock: Clock }): DocumentService` provides `reserve(input: unknown): Promise<UploadReservation>` and `status(id: string): Promise<DocumentStatusResponse>` using the earlier tasks' interfaces.
- `parseUploadEvents(body: unknown, expectedBucket: string): UploadEvent[]`; `createApp(deps: { documents: DocumentService; events: { receive(events: UploadEvent[]): Promise<void> }; webhookSecret: string }): Express`.

- [ ] Write service/parser/request tests for exact response contracts, maximum size, invalid metadata/UUIDs, unknown documents, and safe errors. Cover `s3:TestEvent`, batched records, object-created POST events, URI/plus key decoding, missing versions, irrelevant buckets/events, unknown keys, and duplicates. Pin `assert.equal(response.status, 204)` only after the fake transactional enqueue resolves and assert failed enqueue returns 503 with no committed status change.
- [ ] Run `cd backend && node --test test/documents.service.test.ts test/upload-events.test.ts test/app.test.ts`; verify expected failure, then implement the interfaces with bounded JSON parsers (16 KiB reservation, 1 MiB webhook), constant-time shared-secret comparison, and the spec's HTTP error contract. Do not log signed form fields or secrets. Handle authenticated MinIO test events harmlessly.
- [ ] Wire host API startup without requiring a reachable storage callback or browser. Keep `GET /health` independent of dependency readiness; reservations commit durably before returning 201. Match signing configuration to public host/origin, not Docker-only DNS. Add explicitly configured API-origin CORS for the future client and MinIO CORS; do not create frontend files.
- [ ] Run request/unit tests, type checking, lint, and build. Attach/retry MinIO notification initialization now that its receiver exists and check a real authenticated callback reaches it. Commit as `feat(backend): expose direct-upload reservation and status API`.

## Task 5: Validation, recovery, and cleanup worker

**Files:** Create `validation-job.ts`, `recovery-job.ts`, `cleanup-job.ts`, `worker.ts`, and `test/{validation-job,recovery-job,cleanup-job}.test.ts`; extend repository progress methods and backend scripts.

**Interfaces:**
- `WorkerDependencies = { db: Database; repository: ReturnType<typeof createDocumentRepository>; storage: StorageOperations; queue: JobQueue; clock: Clock }` in `job.types.ts`.
- `processValidation(context: JobContext, deps: WorkerDependencies): Promise<void>`, `processCleanup(context: JobContext, deps: WorkerDependencies): Promise<void>`, and `recoverDocuments(deps: WorkerDependencies): Promise<void>`.
- Source command `npm run worker`; compiled command `npm run worker:prod`. Start two processing slots; register one-minute recovery and hourly abandoned-version maintenance without adding ingestion stages.

- [ ] Write fake-clock/job tests covering valid PDF promotion, immediate rejection, wrong size/type/version, retry delays/deadlines, concurrency/stale revisions, source cleanup, and restart checkpoints. Pin `assert.equal(fakeStorage.copyCalls.length, 1)` after a successful copy followed by repeated finalization attempts; `assert.equal(record.status, 'uploaded')` after cleanup exhaustion; and `assert.equal(fakeStorage.deletedSourceVersions.length, 0)` after finalization exhaustion.
- [ ] Add recovery tests for a lost/delayed webhook, missing object at 30-minute expiry, uploaded-before-expiry with delayed processing, URL replay, missing selected source, orphaned copied object, crashed/expired queue ownership, and an active/reconciliation source older than 24 hours. Pin `assert.equal(activeVersionWasDeleted, false)` and assert duplicates never reset the saved attempt count/start time. A restarted worker must recover expired durable work even though library business retries are disabled.
- [ ] Run `cd backend && node --test test/validation-job.test.ts test/recovery-job.test.ts test/cleanup-job.test.ts`; verify expected failure, then implement phase-specific durable operations: stat/read exact version, validate, copy, finalize, then cleanup. At a resumed copy stage inspect destination document/source-version metadata first; never overwrite a conflicting destination. For an ambiguous database commit read the current record before retrying. Use conditional revision updates and the queue's ownership/recovery mechanism to avoid stale transitions across worker instances.
- [ ] Persist retry/deadline decisions, complete the current queue job, and enqueue its scheduled continuation/cleanup in one transaction. On failure, roll back all three so existing durable work remains recoverable. Keep finalize exhaustion/source protection and cleanup exhaustion separate from document validation failure. If PostgreSQL is unavailable, retain stored attempt checkpoints and defer reconciliation until it returns; no in-memory retry loop or unbounded fresh budget. Log/reify reconciliation-required jobs for operator diagnosis without silently retrying beyond the defined budget.
- [ ] Implement recovery/maintenance using version-aware object inspection and spec retention rules. Inspect each nonterminal record's `currentJobId` and durable queue state; re-enqueue lost/expired work with its saved stage/attempt/deadline, or apply the specified exhaustion outcome. Never steal an active job or reset a budget. Configure explicit queue job expiry/heartbeat so crashed ownership is eventually released. Do not rely on blanket staging lifecycle expiration that could delete a recovery source. Gracefully stop fetching, finish/return owned work, and close queue/database/storage clients on shutdown.
- [ ] Run worker/unit tests, type checking, lint, and build. Commit as `feat(backend): validate PDFs with durable retries and staging cleanup`.

## Task 6: Isolated integration verification, documentation, and final review

**Files:** Add `backend/test/integration/{persistence,upload-flow,recovery}.test.ts` and `helpers.ts`; update package scripts, READMEs, spec/plan status, and `docs/roadmap.md`.

- [ ] Add `test:integration: node --env-file-if-exists=.env --test --test-concurrency=1 test/integration/*.test.ts`. Require explicit integration environment settings; use a unique test database/schema, dedicated buckets/identities, and an isolated MinIO instance for destructive/restart/temp-expiry checks. Never mutate user document buckets, accelerate a user's live cleanup settings, or delete existing volumes.
- [ ] Test real migration reruns, transactional rollback, concurrent version claims/enqueue, and two worker instances with durable queue ownership. Assert exactly one document/source version is accepted and stale attempts cannot regress terminal status.
- [ ] Test the real HTTP sequence: reserve -> signed POST -> webhook -> worker -> poll uploaded. Assert accepted bytes/content type/filename/source-version metadata and removal of the selected staging version. Test invalid PDF rejection and exact 10 MiB policy success/one-byte mismatch rejection. Verify the signer cannot read staging or write accepted objects, both buckets deny anonymous access, and explicit browser-origin preflights succeed.
- [ ] Abort a signed POST before all declared bytes arrive; assert no completed object or validation job and correct reservation expiry using the injected clock. Test isolated accelerated MinIO temporary cleanup. Upload while the API is unavailable and verify persistent notifications/recovery on return. Re-upload the same signed key and prove the accepted bytes remain the selected version.
- [ ] Inject a copy acknowledgement loss, post-copy DB outage, cleanup failure, and worker/database/MinIO restart with existing test volumes. Verify persisted attempt budgets, checkpoint recovery, source preservation, accepted availability, and idempotent init without waiting real retry windows. Clean only test-owned resources afterward and report any checks blocked by the environment.
- [ ] Run `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run lint`, `npm run build` from `backend/`, plus root `docker compose config --quiet` and `git diff --check`. Smoke-test the compiled API, compiled worker, and production migration command. Confirm no tests enter `dist/` and no application changes exist in `frontend/`.
- [ ] Document root/backend `.env` setup, startup order (base infrastructure -> migrations/API -> event attachment -> worker), all commands, curl reservation/upload/poll examples, version/promotion flow, timing limits, operational reconciliation diagnostics, persistence/cleanup, and shutdown. Keep detailed behavior in the spec rather than duplicating it in the roadmap.
- [ ] Record actual validation evidence and partial feature-2 status in the roadmap; commit as `test: verify direct PDF upload and document local operation`. Obtain the required independent review for the chosen execution method, resolve findings, and stop before session/frontend/feature-3 work or integration actions the user has not selected.

## Execution Handoff

Review this checklist before coding. Recommended: **Native** (one implementer in this session, followed by independent review), because these six tasks share the same lifecycle and persistence interfaces. **Subagent-driven** execution is also available, with separate implementer/review passes per task.

At execution, use the applicable worktree skill and preserve the user's branch/worktree preferences. No execution method or branch/integration preference has been selected yet. Do not infer execution approval from approval of the earlier scope outline.

Implementation references: [pg-boss queue policies](https://pgboss.io/api/queues), [transaction adapters](https://pgboss.io/api/adapters), and [pinned MinIO server settings](https://github.com/minio/minio/blob/RELEASE.2025-10-15T17-29-55Z/docs/config/README.md).
