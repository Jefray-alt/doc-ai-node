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
`uploaded` while a presigned upload with no object stays in
`awaiting_upload`.

## Health endpoint

```sh
curl -i http://localhost:3000/health
```

`GET /health` returns HTTP 200 with JSON:

```json
{"status":"ok"}
```

This endpoint confirms the API process can respond. It does not check external
services. PDF validation and processing, and session handling are still pending.

## Direct PDF uploads

`POST /uploads/presign` accepts a PDF filename, `application/pdf` content type,
and file size. It records an `awaiting_upload` job in PostgreSQL before returning
a short-lived presigned POST for a generated key in `doc-ai-local-pdfs`.
The browser sends the file directly to Floci; the API does not receive the file
bytes. A successful storage response means the PDF is awaiting validation and
does not make it available for chat. PostgreSQL and the initial migration must
be available for this endpoint to issue an authorization.

Run exactly one standalone worker replica in this first version. Its reconciler
checks one due `awaiting_upload` row at a time, ordered by next check time and
creation time, using S3 HEAD requests with a five-second request timeout. After
successful handling it immediately checks the next due row; when none are due
or an operational check or write fails, it waits five seconds before checking
again. A present object moves to `uploaded`.
Missing objects remain `awaiting_upload` through the ten-minute grace period
after the upload authorization expires; a final missing-object check after that
period moves the row to `expired`. Other S3 errors are retried and do not expire
the upload. `uploaded` confirms only that the S3 object exists. It does not
validate, extract, embed, ingest, or dispatch the document, and it does not
delete uploaded objects. Due checks resume from PostgreSQL after a worker
restart.

The default HTTP tests replace the jobs repository and need no running services.
`npm run test:floci` runs only the real PDF POST flow against the API and
Floci; it requires an empty, uniquely named disposable PostgreSQL database
with migrations applied. The test removes the two job rows it creates. Start
the Compose services, create a disposable database, and apply its migrations
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

## Backend conventions

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
