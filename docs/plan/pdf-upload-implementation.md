# PDF Upload and MinIO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PDF-only upload endpoint backed by local Docker MinIO, with backend unit and request tests.

**Architecture:** Express receives and validates a bounded upload before calling an injected document store. A MinIO adapter writes the original bytes and metadata; Docker Compose builds pinned upstream sources and initializes a private bucket.

**Tech Stack:** Existing Node 24, Express 5, and TypeScript; Multer 2.4.0, pdf-lib 1.17.1, MinIO JS SDK 8.0.7; `node:test` and `node:assert/strict`.

**Spec:** [PDF upload design](pdf-upload-design.md), approved before this plan. Implementation is pending plan approval and execution-method selection.

## Global Constraints

- `POST /documents`: exactly one multipart file named `file`; reject unexpected fields and multiple files with 400.
- Maximum file size: **10 MiB (10,485,760 bytes)**; exactly the maximum is accepted, larger uploads return 413.
- Require `.pdf` (case-insensitive), `application/pdf`, a PDF signature, and successful parsing; empty, malformed, encrypted, and non-PDF files return 415.
- Validate before storage; buffer one size-limited file per request, without temporary files.
- Success: 201 with `documentId`, `filename`, `size`, `contentType`; JSON errors: `{ "error": { "code": "...", "message": "..." } }`.
- Keep `GET /health` and application/server separation; private bucket, UUID object keys, original filename metadata, no download URLs.
- MinIO binds to localhost ports 9000/9001 with a named volume and idempotent initialization.
- Automated tests require neither Docker nor storage credentials; type-check tests without emitting them into `dist/`.
- Session attachment, frontend integration, extraction, retrieval, and automatic next-feature implementation remain outside this slice.

## Review Focus

- Exact size boundary, including chunked requests with no Content-Length: enforce byte limits before storage (tasks 1 and 3).
- Truncated multipart requests and client disconnects: return 400 where a response remains possible, keep the server usable, never store partial bytes (task 3).
- Unicode and header-sensitive filenames: encode original filename metadata safely and keep UUID keys independent of filenames (task 2).
- MinIO failure or slow completion: never send 201 before acknowledgement; return a sanitized 503 on adapter failure (tasks 2 and 3).
- Repeated Compose startup with an existing bucket/volume: initialization succeeds, objects survive, anonymous reads remain denied (task 4).

## File Map

- `backend/src/documents/`: `document.types.ts` for the storage contract; `upload-error.ts` for controlled HTTP errors; `validate-pdf.ts` for validation; `documents.router.ts` for multipart routing.
- `backend/src/storage/`: `storage-config.ts` for environment validation; `minio-document-store.ts` for the MinIO adapter.
- `backend/src/app.ts`: application factory; `backend/src/server.ts`: production configuration and listener.
- `backend/test/`: `validate-pdf.test.ts`, `storage-config.test.ts`, `minio-document-store.test.ts`, `app.test.ts`; shared `helpers/pdf-fixtures.ts` and `helpers/http.ts`.
- `backend/package.json`, `backend/package-lock.json`, `backend/tsconfig.test.json`: dependencies, test command, and test type checking.
- `compose.yaml`, `docker/minio/Dockerfile`, `docker/minio/init.sh`, `.env.example`, `.gitignore`: local infrastructure and configuration.
- `backend/.env.example`, `README.md`, `backend/README.md`, `docs/roadmap.md`: developer instructions and verified progress.

## Task 1: PDF validation and backend test tooling

**Files:** Create the document contract, upload error, validator, validator tests, fixture helper, and test tsconfig from the file map; modify backend package files.

**Interfaces:**
- `DocumentInput = { documentId: string; filename: string; bytes: Buffer }` and `DocumentStore = { put(input: DocumentInput): Promise<void> }` in `document.types.ts`.
- `UploadError(status: 400 | 413 | 415 | 503 | 500, code: string, message: string)` exposes `status` and `code`.
- `MAX_PDF_BYTES = 10 * 1024 * 1024` and `validatePdf(input: { filename: string; mimeType: string; bytes: Buffer }): Promise<void>`.
- `makePdf(size?: number): Promise<Buffer>` creates a valid one-page PDF, using legal trailing whitespace for exact-byte fixtures; `makeEncryptedPdf(): Promise<Buffer>` creates an encryption-marked PDF through pdf-lib's low-level dictionary API. No external PDF downloads.

- [ ] Install the three runtime dependencies and `@types/multer` after plan approval; record exact resolved versions in the lockfile. Add `test: node --test test/*.test.ts`. Add `tsconfig.test.json` extending the source config with `rootDir: "."`, `noEmit: true`, and both `src` and `test` included; make `typecheck` use it. Preserve production build inclusion of `src` only.
- [ ] Write validator tests for valid PDF/uppercase extension, missing/wrong extension, wrong MIME, false signature, signature-only malformed data, empty data, and encrypted data. Include the exact size assertions:

  ```ts
  await assert.doesNotReject(validatePdf({ filename: 'report.pdf', mimeType: 'application/pdf', bytes: await makePdf(10_485_760) }));
  await assert.rejects(validatePdf({ filename: 'report.pdf', mimeType: 'application/pdf', bytes: await makePdf(10_485_761) }), { status: 413, code: 'FILE_TOO_LARGE' });
  ```

- [ ] Run `cd backend && node --test test/validate-pdf.test.ts`; confirm failure because the validator is not implemented.
- [ ] Implement the contract/error/validator. Reject oversized bytes first, require `%PDF-` at byte zero, then call `PDFDocument.load` with `ignoreEncryption: false`, `throwOnInvalidObject: true`, and `updateMetadata: false`. Resolve the catalog/page tree to catch structural errors. Map rejected formats to `UploadError(415, 'INVALID_PDF', ...)`; do not modify the uploaded bytes.
- [ ] Rerun validator tests and `npm run typecheck`; require zero failures. Commit this task's files as `feat(backend): validate PDF uploads with unit tests`.

## Task 2: Configured MinIO storage adapter with unit tests

**Files:** Create both storage modules and their unit tests; update `backend/.env.example`.

**Interfaces:**
- Consumes `DocumentInput`, `DocumentStore`, and `UploadError` from task 1.
- `StorageConfig = { endPoint: string; port: number; useSSL: boolean; accessKey: string; secretKey: string; bucket: string }`.
- `readStorageConfig(env: NodeJS.ProcessEnv): StorageConfig`; no environment reads at module import time.
- `PutObjectClient = { putObject(bucket: string, key: string, bytes: Buffer, size: number, metadata: Record<string, string>): Promise<unknown> }`.
- `createMinioDocumentStore(client: PutObjectClient, bucket: string): DocumentStore`.

- [ ] Write config tests using explicit environment objects: required access/secret keys; `MINIO_ENDPOINT=localhost`, `MINIO_PORT=9000`, `MINIO_USE_SSL=false`, `MINIO_BUCKET=documents` defaults; reject invalid ports, booleans, empty credentials, endpoints containing a scheme/path, and invalid bucket names. Validate without echoing secrets.
- [ ] Write adapter tests asserting `documents/<documentId>.pdf`, exact byte identity/size, `Content-Type: application/pdf`, and `X-Amz-Meta-Original-Filename: encodeURIComponent(filename)`. Use a Unicode filename containing CR/LF in the adapter test to prove header-safe encoding. A rejected client call must produce `{ status: 503, code: 'STORAGE_UNAVAILABLE' }` without leaking its message.
- [ ] Run `cd backend && node --test test/storage-config.test.ts test/minio-document-store.test.ts`; confirm missing implementation fails.
- [ ] Implement the interfaces and settings above. Await `putObject`, encode filename metadata, wrap storage failures in the controlled 503 error, and document matching backend settings in `.env.example`.
- [ ] Run those tests and `npm run typecheck`; require zero failures. Commit as `feat(backend): add tested MinIO document storage`.

## Task 3: Express upload endpoint and request tests

**Files:** Create the documents router, HTTP test helper, and `app.test.ts`; modify `app.ts` and `server.ts`.

**Interfaces:**
- Consumes task 1's validation/storage contract and task 2's configuration/adapter.
- `createDocumentsRouter(documentStore: DocumentStore): Router`.
- `createApp(dependencies: { documentStore: DocumentStore }): Express`; tests construct it with a fake store. `server.ts` constructs the real SDK client/adapter and starts the returned app.
- HTTP test helper starts the app on an ephemeral localhost port, exposes its base URL, and always closes its listener/connections using test cleanup. Native `fetch`, `FormData`, `Blob`, and `node:http` cover normal and malformed/chunked requests.

- [ ] Write `/health` and upload request tests. Assert successful 201 response shape, UUID format, returned byte count/type, preserved filename, and exactly one store call with matching ID/bytes. Hold the store promise pending and assert no response completes until it resolves.
- [ ] Add rejected request tests: missing file, JSON instead of multipart, wrong field name, extra text fields, two files, wrong MIME/extension/signature, empty/malformed/encrypted content, and malformed boundaries. Assert 400/415 as specified and zero store calls. Test exact 10,485,760-byte success and 10,485,761-byte rejection with 413/`FILE_TOO_LARGE`, also using chunked transfer without Content-Length.
- [ ] Add a truncated multipart request and an aborted partial upload; assert no storage and that a subsequent health request succeeds. Test controlled store rejection gives sanitized 503 and an unexpected error gives sanitized 500. Assert the shared JSON error envelope.
- [ ] Run `cd backend && node --test test/app.test.ts`; confirm the missing factory/route fails.
- [ ] Implement the app factory and route using route-local Multer `memoryStorage().single('file')`. Set limits for one file, zero text fields, bounded field names/headers, and bounded parts. Check the selected Multer version's exact-limit behavior against the boundary tests; never silently accept a truncated file. Keep PDF parsing out of `fileFilter`; validate after complete multipart parsing and before generating the UUID/store call.
- [ ] Map parser size errors to 413 and other parser/request errors to 400; validation/store errors retain their controlled statuses; unexpected errors return generic 500. Use codes `INVALID_UPLOAD`, `FILE_TOO_LARGE`, `INVALID_PDF`, `STORAGE_UNAVAILABLE`, and `INTERNAL_ERROR`. Preserve `GET /health` as process health only.
- [ ] Wire storage in `server.ts`, retain existing environment/port precedence, and ensure neither tests nor app imports need credentials. Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`; require zero failures. Confirm `dist/` has no test output. Commit as `feat(backend): expose tested PDF upload endpoint`.

## Task 4: Local Compose setup and end-to-end verification

**Files:** Create Compose, Dockerfile, init script, and root example environment file; update root ignore rules, READMEs, and roadmap.

**Interfaces:**
- Compose services `minio` and `minio-init`; named volume `minio-data`; root variables `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, and `MINIO_BUCKET` match the backend example.
- Two Dockerfile targets, `server` and `client`, build MinIO `RELEASE.2025-10-15T17-29-55Z` and mc `RELEASE.2025-08-13T08-35-41Z` from upstream source. Pin builder/runtime base images to verified immutable digests at implementation time. Include CA certificates and upstream license notices; shell/tools required by initialization live in the client image.
- API/console bindings: `127.0.0.1:9000:9000` and `127.0.0.1:9001:9001`; server command: `server /data --console-address :9001`.

- [ ] Verify upstream source refs/base-image availability, implement source-build targets and Compose wiring. Root context is `docker/minio/` so application files and local secrets are not sent to Docker builds. Ignore root `.env` files while preserving `.env.example`.
- [ ] Implement `init.sh` with failure propagation, bounded readiness attempts (60 attempts at 1-second intervals), `mc alias set`, `mc mb --ignore-existing`, and `mc anonymous set none`. Make initialization failures visible with a nonzero exit. Compose startup instructions must wait for the initialization service to exit successfully.
- [ ] Run `docker compose config --quiet`; then use local example settings to run `docker compose up -d --build` and inspect service status/logs. Require successful server startup and init exit 0. Do not overwrite existing user environment files or delete existing volumes.
- [ ] Start the backend and upload a generated valid PDF over HTTP. Use the SDK to retrieve/stat the generated key; assert byte equality, content type, and decoded filename metadata. Confirm anonymous object GET and bucket listing return 403. Confirm invalid/oversized uploads return expected JSON and create no objects.
- [ ] Rerun initialization and restart the MinIO service with its existing volume; confirm the uploaded object survives and private access remains enforced. Remove only the smoke-test object afterward. If Docker/build access blocks verification, record the exact limitation and do not claim the integration passed.
- [ ] Document environment setup, `docker compose up -d --build`, checking init completion, upload curl example, 10 MiB/error contract, tests/check commands, volume persistence, and shutdown. Explain source builds using the upstream references below; feature 2 remains in progress.
- [ ] Run the final backend test/typecheck/lint/build commands and `git diff --check`. Review against every spec requirement, update `docs/roadmap.md` with actual results, and commit as `feat: configure local MinIO and document PDF upload setup`.

## Execution and review

Await explicit review/approval of this plan and an execution-method choice. Recommended: **Native**, because the four tasks share small interfaces and are sequential. At execution, use the applicable worktree skill and preserve any user branch/worktree preferences. Follow the selected execution skill, perform the required independent review, resolve findings, and stop after this slice without starting session/frontend work.

## Upstream References

- [Multer middleware and limits](https://expressjs.com/en/resources/middleware/multer/)
- [PDF load options](https://pdf-lib.js.org/docs/api/interfaces/loadoptions)
- [MinIO JS SDK](https://github.com/minio/minio-js)
- [MinIO source-only distribution](https://github.com/minio/minio#source-only-distribution) and [pinned server release](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z)
- [MinIO client source](https://github.com/minio/mc/tree/RELEASE.2025-08-13T08-35-41Z)
