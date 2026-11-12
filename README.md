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

Start the complete development environment from the repository root:

```sh
npm run dev
```

The launcher starts Floci and PostgreSQL with Docker Compose, waits for both
health checks, and applies pending database migrations before starting Vite and
the NestJS API. All three application logs are labeled in the terminal. Vite, the NestJS API,
and the standalone NestJS worker watch source files and reload as you edit; open the URL printed by Vite
(normally `http://localhost:5173`). Press Ctrl+C to stop the application processes. The services stay running and retain their data.

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

The chat workspace supports sending messages with the Send button or Enter.
Use Shift + Enter for a new line. Messages stay in memory for the current tab and
are cleared when you refresh or close it; there are no accounts or saved chats.

Use Add PDF to upload one PDF directly into the local PDF bucket. After upload,
the workspace shows that the PDF is awaiting validation. The chat cannot use it
until validation, processing, and chat readiness are implemented. Upload status
is held in memory and clears when you refresh the tab.

### Backend

Run backend npm commands from `backend/`:

```sh
cd backend
npm run dev
npm run dev:worker
```

Use `npm run dev:worker` in a separate terminal to run only the background worker.
For production, run `npm run build`, then `npm start` for the API or
`npm run start:worker` for the worker.

Check the API with `curl http://localhost:3000/health`. It returns
`{"status":"ok"}`. Set `PORT` in the environment or copy `backend/.env.example`
to `backend/.env` to change the port.

Run `npm run typecheck`, `npm run lint`, and `npm run build` from `backend/`.
Then use `npm start` to run the compiled API. See [backend/README.md](backend/README.md).
Run `npm test` for all TypeScript suites or `npm run test:e2e` for HTTP and
process-level coverage. Backend modules, naming, and testing conventions are
documented in [backend/README.md](backend/README.md).

PDF validation, document processing, and generated answers remain to be
implemented.

### Local AWS infrastructure

Local AWS-compatible S3 storage uses Floci in Docker. The root `npm run dev`
command starts it with Docker Engine and Docker Compose v2. The root
`.env.example` sets `S3_BUCKET_NAME=doc-ai-local-pdfs`, which can be changed
in `.env`.

To start Floci by itself, use the same explicit Compose project name used by
the launcher:

```sh
docker compose --project-name doc-ai-node up -d --wait floci
COMPOSE_PROJECT_NAME=doc-ai-node sh scripts/floci/smoke.sh
```

Compose waits until the PDF bucket responds to its readiness check. The bucket
allows browser POST uploads from the local Vite origins. The S3 smoke check
uploads a temporary object, compares downloaded bytes, and confirms deletion.
It runs the AWS CLI inside Floci, so it needs neither an AWS account nor a host
AWS CLI.

See [.env.example](.env.example) for the local storage configuration loaded from
`.env`. To inspect startup or initialization errors, run
`docker compose --project-name doc-ai-node logs floci`. Use the same project
name for other Compose commands, such as `restart floci` or `stop floci`, so
they address the launcher's service. `stop floci` stops the service while
keeping its container and data. `down` stops and removes the container while
keeping stored objects in the named Compose volume. The
`doc-ai-node` project name also means a worktree shares that project's Floci and
PostgreSQL data;
when Compose configuration paths change between worktrees, it may safely
recreate a container while retaining the named volume.

To stop Floci while keeping the container and its data, run:

```sh
docker compose --project-name doc-ai-node stop floci
```

To deliberately clear all local Floci objects and PostgreSQL job records, then
recreate empty storage, run:

```sh
docker compose --project-name doc-ai-node down -v
docker compose --project-name doc-ai-node up -d --wait floci postgres
```

### Local PostgreSQL

PostgreSQL 17 stores upload job state in a persistent Compose volume. Local
credentials and the database name are in the root `.env.example`; the backend
connection string is in `backend/.env.example`. The API retries upload
reconciliation if PostgreSQL is unavailable, while `/health` remains available.
The root launcher waits for PostgreSQL and runs repeat-safe migrations
before starting development servers. To apply migrations manually, run
`npm run db:migrate` from `backend/`.
