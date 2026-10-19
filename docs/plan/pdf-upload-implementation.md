# Backend and MinIO Plan

**Status:** Scope revised; detailed implementation tasks are pending approval
of the [revised written design](pdf-upload-design.md). The old synchronous
multipart/Multer plan is superseded and must not be executed.

## Current deliverable

A backend-only flow that issues direct-upload instructions, receives MinIO
webhooks, validates PDFs in a separate worker, and exposes durable status. Use
PostgreSQL for records and durable jobs. Prove the flow through HTTP/SDK checks
without implementing a frontend client.

## Intended implementation sequence

1. **Persistence and test foundation:** Add backend unit-test tooling, document
   status records/migrations, and PostgreSQL-backed validation jobs. Keep
   automated unit tests independent of Docker.
2. **MinIO and PostgreSQL setup:** Add Compose, private staging/accepted buckets,
   staging versioning, signed POST policies, notification authentication/queue,
   scoped signer/worker credentials, origin configuration, and repeatable
   initialization.
3. **API contracts:** Add the JSON upload-reservation endpoint, authenticated
   MinIO event receiver, and status endpoint; preserve health behavior. Test
   metadata validation, durable enqueueing, deduplication, and sanitized errors.
4. **Validation worker:** Read the recorded object version, enforce the 10 MiB
   limit and actual PDF validation, copy valid bytes to the accepted bucket,
   record success, then delete the staging version. Cover retry/restart safety,
   reservation recovery, and cleanup. See the design's [concrete bucket
   operations](pdf-upload-design.md#concrete-bucket-operations) and
   [retry timing/stop conditions](pdf-upload-design.md#retry-timing-and-stop-conditions).
   Use fake-clock tests to prove attempt limits, persisted deadlines, and that
   finalization/cleanup retries do not repeat a confirmed successful copy.
5. **Integration verification and documentation:** Exercise signed uploads,
   real notifications, worker processing, database/storage restarts, replayed
   uploads, private access, and initializer reruns. Document backend commands,
   configuration, and actual results; update the roadmap.

This is the scope/sequence for review, not an executable task checklist. After
written-spec approval, expand only this backend slice into the test-first tasks
required by the selected Superpowers execution method, then present that plan
for explicit approval before implementation.

## Deferred work

Frontend API/MinIO integration has no plan file or detailed implementation tasks
at the user's request. Session attachment and the one-PDF-per-session rule remain
pending within feature 2. Extraction, tokenization, retrieval, and generated
answers belong to subsequent feature work. Do not automatically start any of
these after backend delivery.
