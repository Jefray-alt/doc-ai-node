# Document Chat

A single-PDF chat application for learning the RAG flow. Product scope lives in
[docs/product-brief.md](docs/product-brief.md).

## Repository

This monorepo keeps a root launcher and its `concurrently` dependency at the
repository root. Application dependencies and lockfiles remain inside
`frontend/` and `backend/`.

- `frontend/`: React + TypeScript SPA using Vite and Mantine.
- `backend/`: NestJS + TypeScript REST API using Nest's default Express adapter.
- `docs/`: product brief, feature backlog, and roadmap.

### Agent-assisted code changes

Codex roles for implementation, development, and independent review are
configured under `.codex/agents/`. Code changes follow
[docs/agent-workflow.md](docs/agent-workflow.md); reload Codex after changing
the role configuration if the roles are not available.

## Development

Use Node.js 24 LTS and npm. Install dependencies from the repository root and
each application directory:

```sh
nvm use 24 # If you use nvm
npm ci
(cd frontend && npm ci)
(cd backend && npm ci)
```

Prepare local environment files once. These commands copy examples only when
the destination does not already exist, so they preserve local settings:

```sh
test -f .env || cp .env.example .env
test -f backend/.env || cp backend/.env.example backend/.env
```

These commands preserve existing files. If `backend/.env` predates the worker,
compare it with `backend/.env.example` and add any missing SQS and worker
settings while keeping local endpoint, credentials, and database values. The
worker needs both `SQS_QUEUE_URL` and `SQS_DLQ_URL`.

Start the complete development environment from the repository root:

```sh
npm run dev
```

The launcher starts PostgreSQL and Floci with Docker Compose, waits for their
health checks, applies PostgreSQL migrations, and starts Vite, the NestJS API,
and the independent document worker. Logs are labeled in the terminal. Open the
URL printed by Vite (normally `http://localhost:5173`). Press Ctrl+C to stop
Vite, the API, and the worker. PostgreSQL and Floci stay running and retain
their data.

To run one application alone, use the existing application scripts:

```sh
cd frontend
npm run dev
npm run typecheck
npm run lint
npm run build
npm run preview
```

Run frontend npm commands from `frontend/`. `build` produces `frontend/dist/`;
`preview` serves that production build locally. To pass arguments to Vite, use
`npm run dev -- --host 0.0.0.0`.

The standalone message composer supports sending messages with the Send button
or Enter and uses Shift + Enter for a new line. The workspace keeps its composer
disabled until document preparation and chat are implemented. There are no
accounts or saved chats.

Use Add PDF to upload one PDF directly to the configured Floci source bucket.
After storage accepts the file, the browser confirms the upload with the API.
The workspace shows the queued and processing state, then reports whether the
worker checked the source object's ETag and byte count. That check does not
parse or prepare the document, and chat remains unavailable. The worker reads
the same `incoming/<uploadId>.pdf` object; it does not copy, promote, or delete
it. Upload status is held in memory and clears when you refresh the tab.

### Backend

Run backend npm commands from `backend/`:

```sh
cd backend
npm run dev
```

Check the API with `curl http://localhost:3000/health`. It returns
`{"status":"ok"}`. Set `PORT` in the environment or copy `backend/.env.example`
to `backend/.env` to change the port.

Run `npm run typecheck`, `npm run lint`, and `npm run build` from `backend/`.
Then use `npm start` to run the compiled API. See [backend/README.md](backend/README.md).
Run `npm test` for all TypeScript suites or `npm run test:e2e` for HTTP and
process-level coverage. Backend modules, naming, and testing conventions are
documented in [backend/README.md](backend/README.md).

The upload dialog confirms the S3 POST with the API before showing a queued
job. In the workspace, `queued` means the API recorded the durable job,
`processing` means the worker is checking the uploaded object, `source_checked`
means its ETag and byte count matched, and `failed` shows the safe failure
message returned by the API. The UI polls queued and processing uploads every
two seconds. A `source_checked` upload is not prepared for chat, so the message
composer remains unavailable.

PDF parsing, document preparation, generated answers, and evidence citations
remain to be implemented.

### Local S3 storage

Local PDF storage uses Floci, an S3-compatible service in Docker. The root
`npm run dev` command starts it with Docker Engine and Docker Compose v2. To
start Floci by itself, use the same explicit Compose project name used by the
launcher:

```sh
docker compose --project-name doc-ai-node up -d --wait floci
COMPOSE_PROJECT_NAME=doc-ai-node sh scripts/floci/smoke.sh
```

Compose waits until both the ingestion bucket (`doc-ai-local-pdfs`) and
upload bucket (`doc-ai-local-quarantine`) respond to S3 readiness checks. The
browser uploads directly to the configured upload bucket from the local Vite
origin. The worker checks that same bucket and key in place; no promotion or
file movement currently occurs.
The smoke check uploads a temporary object to each bucket, compares downloaded
bytes, and confirms deletion. It needs no AWS account or host AWS CLI.

See [.env.example](.env.example) for the local storage configuration loaded from
`.env`. To inspect startup or initialization errors, run
`docker compose --project-name doc-ai-node logs floci`. Use the same project
name for other Compose commands, such as `restart floci` or `stop floci`, so
they address the launcher's service. `stop floci` stops the service while
keeping its container and data. `down` stops and removes the container while
keeping stored objects in the named Compose volume. The `doc-ai-node` project
name also means a worktree shares that project's Floci data; when Compose
configuration paths change between worktrees, it may safely recreate the
container while retaining the named volume.

If the API does not start, check `backend/.env` for a valid `DATABASE_URL` and
inspect PostgreSQL and Floci with
`docker compose --project-name doc-ai-node ps`. The root launcher applies
migrations before starting the API or worker. If an upload stays queued,
inspect the worker log in the `npm run dev` terminal and confirm the local SQS
queue URLs in `backend/.env` match Floci's initialized queue names.

To stop Floci while keeping the container and its data, run:

```sh
docker compose --project-name doc-ai-node stop floci
```

To deliberately clear local data and recreate an empty bucket, run:

```sh
docker compose --project-name doc-ai-node down -v
docker compose --project-name doc-ai-node up -d --wait floci
```
