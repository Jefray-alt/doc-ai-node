# Document Chat

A single-PDF chat application for learning the RAG flow. Product scope lives in
[docs/product-brief.md](docs/product-brief.md).

## Repository

This monorepo keeps Node configuration, package manifests, lockfiles, and
dependencies inside each application, in `frontend/` and `backend/`.

- `frontend/`: React + TypeScript SPA using Vite and Mantine.
- `backend/`: NestJS + TypeScript REST API using Nest's default Express adapter.
- `docs/`: product brief, feature backlog, and roadmap.

### Agent-assisted code changes

Codex roles for implementation, development, and independent review are
configured under `.codex/agents/`. Code changes follow
[docs/agent-workflow.md](docs/agent-workflow.md); reload Codex after changing
the role configuration if the roles are not available.

## Development

Use Node.js 24 LTS and npm. Run each application in its own terminal.

### Frontend

From the repository root:

```sh
cd frontend
nvm use # If you use nvm
npm ci
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`).

```sh
npm run typecheck
npm run lint
npm run build
npm run preview
```

Run frontend npm commands from `frontend/`. `build` produces `frontend/dist/`.
`preview` serves that production build locally.
To pass arguments to Vite, use `npm run dev -- --host 0.0.0.0`.

The chat workspace supports sending messages with the Send button or Enter.
Use Shift + Enter for a new line. Messages stay in memory for the current tab and
are cleared when you refresh or close it; there are no accounts or saved chats.

Use Add PDF to upload one PDF directly into the quarantine bucket. After upload,
the workspace shows that the PDF is awaiting validation. The backend can promote
an exact quarantine version after a clean scan result; PDF parsing, ingestion,
and grounded chat are still pending. Upload status is held in memory and clears
when you refresh the tab.

### Backend

From the repository root:

```sh
cd backend
nvm use # If you use nvm
npm ci
cp .env.example .env
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

PDF validation, document processing, and generated answers remain to be
implemented.

### Local S3 storage

Local PDF storage uses Floci, an S3-compatible service in Docker. Start it from
the repository root with Docker Engine and Docker Compose v2:

```sh
cp .env.example .env
docker compose up -d --wait
sh scripts/floci/smoke.sh
```

Compose waits until both buckets, quarantine versioning, and the scan result
queue and processing DLQ are ready. The quarantine bucket allows browser POST
uploads from the local Vite origins.
The smoke check uploads a temporary object to each bucket, compares downloaded
bytes, and confirms deletion. It needs no AWS account or host AWS CLI.

See [.env.example](.env.example) for the local storage configuration loaded from
`.env`. To inspect startup or initialization errors, run `docker compose logs floci`.

To exercise scan-result handling without a scanner, start the API from
`backend/` with `npm run dev`, then run the worker in another backend terminal
with `npm run dev:scan-worker`. Upload a PDF through the UI or API, then publish
a simulated result using its generated `incoming/<uuid>.pdf` key:

```sh
cd backend
npm run simulate:scan -- incoming/<uuid>.pdf clean
```

The simulator reads the current version and ETag and sends a GuardDuty-shaped
event to SQS; it does not inspect or scan file contents. See
[quarantine scan operations](docs/quarantine-scan-operations.md) for supported
outcomes and production operating guidance.

Use `docker compose restart floci` to restart the service. `docker compose down`
stops and removes its container while keeping stored objects in the Compose
volume. To deliberately clear local data and recreate an empty bucket, run:

```sh
docker compose down -v
docker compose up -d --wait
```
