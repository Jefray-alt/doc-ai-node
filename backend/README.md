# Backend API

NestJS + TypeScript API using Nest's default Express adapter. All backend Node
tooling and dependencies live in this directory.

## Development

Use Node.js 24 LTS and npm. From the repository root:

```sh
cd backend
nvm use # If you use nvm
npm ci
cp .env.example .env
npm run dev
```

The API listens on port 3000 by default. Copy `.env.example` to `.env` to use
local Floci credentials and the PDF bucket. The API and worker development and start commands load
this file when present; an existing shell environment variable takes precedence.

Development uses the Nest CLI compiler in watch mode. It recompiles and restarts
when source changes. `build` compiles the API to `dist/`; `start` runs `dist/main.js`.
`dev:worker` watches the standalone background worker and writes to `dist-worker/`,
separate from the API watch output. `build` also compiles the worker to `dist/worker.js`,
which `start:worker` runs.

## PostgreSQL jobs

The root Compose project runs PostgreSQL 17 on `127.0.0.1:5432` with data in a
persistent named volume. Set `DATABASE_URL` in this directory's optional `.env`
to override the example connection string. Shell environment variables take
precedence. Apply versioned SQL migrations with:

```sh
npm run db:migrate
```

The migration command builds the backend, applies pending migrations in one
transaction, and records their versions in `schema_migrations`. Running it
again is safe. Do not remove the Compose volume when stopping local services if
you need to retain job records.

`npm run test:postgres` runs the migration and repository integration suite.
Set `DATABASE_URL` to an empty disposable database with a fresh schema; the
migration test expects to apply the initial migration itself. Do not point this
suite at a shared or application database.

Run checks and tests separately:

```sh
npm run typecheck
npm run lint
npm run build
npm test
npm run test:e2e
npm start
```

`npm test` runs all discovered unit and e2e suites. `npm run test:e2e` runs the
HTTP and process-level suites under `test/`.
`npm run test:floci` exercises the signed PDF POST against the local
Floci service, then verifies the worker reconciles the uploaded object into
`extracted` with its page count, rejects invalid PDF input as `failed`, and
keeps a presigned upload with no object in `awaiting_upload`.

## Health endpoint

```sh
curl -i http://localhost:3000/health
```

`GET /health` returns HTTP 200 with JSON:

```json
{"status":"ok"}
```

This endpoint confirms the API process can respond. It does not check external
services. Session handling is still pending.

## Direct PDF uploads

`POST /uploads/presign` accepts a PDF filename, `application/pdf` content type,
and file size. It records an `awaiting_upload` job in PostgreSQL before returning
a short-lived presigned POST for a generated key in `doc-ai-local-pdfs`.
The browser sends the file directly to Floci; the API does not receive the file
bytes. A successful storage response means the PDF is awaiting validation and
does not make it available for chat. PostgreSQL and the initial migration must
be available for this endpoint to issue an authorization.

Run exactly one standalone worker process and replica in this first version.
Its single polling loop handles one due job at a time, alternating between
`awaiting_upload` checks and `uploaded` extraction when both have due work.
Within each status, jobs are ordered by next check time, creation time, then
upload ID as a deterministic tie-breaker. Locked or actively leased jobs are skipped.
Upload checks use S3 HEAD requests with a five-second request timeout. After
successful handling the loop immediately selects the next due job; when none
are due or an operational check or write fails, it waits five seconds before
checking again. A present object moves to `uploaded` and becomes eligible for
extraction.
Missing objects remain `awaiting_upload` through the ten-minute grace period
after the upload authorization expires; a final missing-object check after that
period moves the row to `expired`. Other S3 errors are retried and do not expire
the upload. `uploaded` confirms only that the S3 object exists.

For each uploaded job, the worker calls `IngestionService` and counts every
physical page, including blank pages. Only full extraction success changes
the job to `extracted`, saves `page_count`, and clears `error_code`. No page text
or partial page counts are persisted. Known invalid inputs become `failed`
with stable codes: `PDF_TOO_LARGE`, `PDF_INVALID_HEADER`, `PDF_TOO_MANY_PAGES`,
`PDF_MALFORMED`, `PDF_PASSWORD_REQUIRED`, or `PDF_NO_TEXT`. Other operational
failures retain `uploaded`, save `PDF_PROCESSING_FAILED`, and schedule a retry
five seconds later. Logs include the original failure and upload ID; stored
error codes do not contain raw error messages.

Each upload check or extraction atomically acquires a fresh ownership token and
two-minute lease, measured by PostgreSQL time, renewed every 30 seconds during
active work. Each renewal has a five-second database request budget and a
two-second PostgreSQL statement timeout. Every outcome or retry
requires that token, the expected status, and a live lease; accepted writes clear
ownership. An active extraction remains `uploaded` until its final outcome is saved.
Abandoned claims become eligible again after expiry, so interrupted attempts or
failed outcome writes can repeat computation. A rejected or failed renewal aborts
cancellable I/O, awaits remaining parsing, and discards the result without writing
an outcome or retry. Outcome writes wait for any pending renewal to finish.
Parsing can delay heartbeats; an expired lease cannot renew or save an outcome.
Keep exactly one worker process and replica until the full recovery lifecycle
and multiple-worker checks are implemented and verified.

Shutdown stops new work and aborts the active download, then awaits any parser
already running without saving its outcome. It best-effort releases an unused
live claim; failed releases and uncertain outcome writes recover through expiry.
PDF parsing cannot be forcibly interrupted and has no hard deadline. The worker
does not delete uploaded objects, embed text, or make documents ready for chat.

Before deploying this migration, stop all old workers, apply migrations, then
start only the new worker version. Mixed versions are unsupported because old
workers do not honor ownership tokens or leases.

The default HTTP tests replace the jobs repository and need no running services.
`npm run test:floci` runs the real PDF POST and worker extraction flow against
the API and Floci; it requires an empty, uniquely named disposable PostgreSQL
database with migrations applied. Each case removes the two job rows it creates.
Start the Compose services, create a disposable database, and apply its migrations
first. Replace `doc_ai_floci_test` with a unique name for each run:

```sh
cd ..
docker compose --project-name doc-ai-node up -d --wait floci postgres
docker compose --project-name doc-ai-node exec -T postgres psql -U doc_ai -d postgres -c "CREATE DATABASE doc_ai_floci_test"
cd backend
DATABASE_URL=postgresql://doc_ai:doc_ai_dev@127.0.0.1:5432/doc_ai_floci_test npm run db:migrate
DATABASE_URL=postgresql://doc_ai:doc_ai_dev@127.0.0.1:5432/doc_ai_floci_test npm run test:floci
cd ..
docker compose --project-name doc-ai-node exec -T postgres psql -U doc_ai -d postgres -c "DROP DATABASE doc_ai_floci_test"
```

## Callable PDF extraction

`IngestionService` provides an in-process API for a caller that already has an
S3 bucket and object key:

```ts
await ingestionService.extract(bucket, key, async ({ pageNumber, text }) => {
  await consumePage(pageNumber, text);
}, signal);
```

It downloads the full object into memory, then parses and delivers one physical
page at a time, keeping only the current page text while its consumer runs. The
consumer owns any persistence. The download and extractor each enforce the 20
MiB byte limit;
the extractor also rejects PDFs with more than 100 physical pages. Blank pages
are delivered with empty text, while a document with no extractable text is
rejected. PDFs requiring a password and malformed PDFs have distinct extraction
errors. Encrypted PDFs that open without a password are accepted. OCR is not
performed. PDF parsing has no hard timeout and cannot be interrupted by the
optional signal; the signal covers the S3 download only. The standalone job
worker uses this service; no HTTP extraction route is exposed.

## Backend conventions

Use explicit `.ts` extensions for relative imports and re-exports of backend
TypeScript files, including tests and Vitest configs. TypeScript rewrites these
extensions to `.js` when emitting builds, so compiled Node.js entrypoints and
runtime paths continue to use `.js`. Keep dependency imports at their published
paths, including PDF.js `.mjs` imports.

`src/main.ts` loads the optional backend `.env` file and starts `AppModule`;
`src/worker.ts` loads the same file and starts a standalone application context
without an HTTP listener. Both processes enable graceful shutdown hooks.
The root module composes feature modules; `src/health/` owns the health
controller. Keep each feature directly under `src/<feature>/` and put its module,
controller, needed service, DTOs, and colocated unit tests there. Use constructor
injection for services and declare feature dependencies through module imports
and exports. Controllers handle routing and HTTP translation; services own
application logic. Keep shared code only for an actual shared responsibility.

Use `.module.ts`, `.controller.ts`, `.service.ts`, `.dto.ts`, and `.spec.ts`
suffixes for their matching roles. Put application HTTP and process integration
tests in `test/` with `.e2e-spec.ts` names. Tests use TypeScript, Vitest,
Supertest, and `@nestjs/testing`; `test/setup.ts` loads decorator metadata.
Changing these conventions requires an explicit design decision and updating
this guide.

The API listens on port 3000 by default. Set `PORT` in the shell or optional
`backend/.env`; shell values take precedence. The health endpoint returns HTTP
200 with `{"status":"ok"}`. Unknown routes return HTTP 404.
