# PDF upload and local MinIO

**Status:** Written spec approved. Includes the requested backend unit tests.
Implementation plan awaiting review.

## Outcome and boundary

Continue feature 2 by accepting one PDF per upload request, validating it, and
storing it in a private local MinIO bucket. Provide Docker Compose configuration
and backend tests. This is a slice of feature 2: session attachment, the
one-document-per-session rule, frontend integration, and document readiness for
questions remain pending. Text extraction and retrieval belong to feature 3.

## Upload contract

- `POST /documents` accepts multipart form data with exactly one file field named
  `file`. Reject missing files, unexpected fields, and multiple files with 400.
- The maximum file size is **10 MiB (10,485,760 bytes)**. Enforce the limit while
  receiving the file and return 413 when exceeded, including multipart parser
  truncation. Limit multipart parts and fields as well as file bytes.
- Require a `.pdf` filename extension (case-insensitive), the declared MIME type
  `application/pdf`, a PDF signature, and successful PDF parsing. Reject empty,
  malformed, encrypted, and non-PDF files with 415. Filename and MIME checks alone
  do not establish that the content is a PDF.
- Buffer at most one size-limited file per request, validate before storage, and
  discard the buffer after handling the request. No temporary files are needed.
- On successful storage, return 201 with `documentId`, `filename`, `size`, and
  `contentType`. `size` is the validated byte count; `contentType` is
  `application/pdf`. The response confirms storage, not readiness for questions.
- Use JSON errors shaped as `{ "error": { "code": "...", "message": "..." } }`.
  Malformed multipart requests return 400, storage unavailability returns 503,
  and unexpected failures return 500 without exposing credentials or internals.

## Backend structure and storage

Keep the existing Express application/server separation and `GET /health`.
Expose an application factory accepting a document-storage dependency so tests
can exercise request handling without MinIO or storage credentials. Keep PDF
validation, upload routing/error handling, storage configuration, and the MinIO
adapter in focused backend modules.

Generate a UUID document ID and store the object under `documents/<id>.pdf`.
Never derive the object key from the supplied filename. Store its original
filename safely as metadata and use `application/pdf` as the object content
type. Return success only after MinIO acknowledges the write. The bucket is
private; there is no public download URL, listing endpoint, or metadata database
in this slice. Each successful request creates a new object; session lifecycle
and cleanup will be designed when session attachment is implemented.

## Local infrastructure

Add a root `compose.yaml` running MinIO with a named data volume, API port 9000,
and console port 9001, both bound to localhost. Use pinned releases; build local
images from pinned upstream source releases because the community server is now
[distributed as source only](https://github.com/minio/minio#source-only-distribution).
Include a one-shot initialization service that waits for MinIO, creates the
configured bucket idempotently, and ensures anonymous access is disabled.
Initialization failures must be visible rather than silently ignored.

Provide example local credentials and bucket configuration for Compose, plus
backend settings for the endpoint, port, TLS flag, access key, secret key, and
bucket. Keep local environment files out of git. The backend runs on the host
as it does today. Document startup, configuration, upload examples, errors, and
how to run tests in the repository/backend READMEs.

## Verification and project status

Use Node's built-in test runner with TypeScript tests and an `npm test` command.
Include tests in type checking without placing test files in the production
build. Unit tests cover the validator and storage adapter using controlled
fixtures and mocked dependencies. Request-level tests cover `/health`, upload
success/response metadata, missing or unexpected fields, extra files, spoofed
PDFs, empty/malformed/encrypted PDFs, the size boundary, and storage failure.
Rejected requests must not call storage. Automated tests run without Docker or
real storage credentials.

Run backend tests, type checking, linting, and production build. Separately
validate Compose and smoke-test an actual upload against Docker MinIO, checking
the stored object's bytes/metadata and private bucket access. If the environment
cannot run Docker, report that limitation explicitly.

Update the roadmap after implementation to record this slice and its verified
status while keeping feature 2 in progress until session/frontend work is done.
