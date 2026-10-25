# Backend initialization

**Goal:** Scaffold the NestJS REST API foundation for feature 2, attaching one
PDF to a session.

**Design:** Keep TypeScript source, Node 24 configuration, npm dependencies, and
the lockfile in `backend/`. Nest owns bootstrap and health routing through
`AppModule` and `HealthModule`, using its default Express adapter. Expose
`GET /health` with HTTP 200 and `{"status":"ok"}`. Use port 3000 by default,
configurable through `PORT` or an optional local `.env` file.

This slice adds only the API foundation. PDF upload, session handling, storage,
and frontend integration remain part of future feature 2 work.

## Tasks

- [x] Scaffold the standalone backend package and development/build commands.
- [x] Add the health endpoint and verify it over HTTP.
- [x] Verify a clean install, type checking, linting, and the compiled server.
- [x] Document usage and update the roadmap to reflect partial progress.

See [backend/README.md](../../backend/README.md) for module, naming, and test
conventions and the current verification commands. PDF upload, session handling,
storage, and frontend integration remain pending.
