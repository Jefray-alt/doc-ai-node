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
local Floci credentials and the quarantine bucket. Both `dev` and `start` load
this file when present; an existing shell environment variable takes precedence.

Development uses the Nest CLI compiler in watch mode. It recompiles and restarts
when source changes. `build` clears and compiles production output to `dist/`;
`start` runs `dist/main.js`.

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
`npm run test:floci` exercises the signed quarantine POST against the local
Floci service and verifies the uploaded object is absent from the ingestion bucket.

## Health endpoint

```sh
curl -i http://localhost:3000/health
```

`GET /health` returns HTTP 200 with JSON:

```json
{"status":"ok"}
```

This endpoint confirms the API process can respond. It does not check external
services. PDF processing, validation, promotion from quarantine, and session
handling are still pending.

## Direct PDF uploads

`POST /uploads/presign` accepts a PDF filename, `application/pdf` content type,
and file size. It returns a short-lived presigned POST for a generated key in
`doc-ai-local-quarantine`. The browser sends the file directly to Floci; the API
does not receive the file bytes. A successful storage response means the PDF is
awaiting validation and does not make it available for chat.

## Backend conventions

`src/main.ts` loads the optional backend `.env` file and starts `AppModule`.
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
