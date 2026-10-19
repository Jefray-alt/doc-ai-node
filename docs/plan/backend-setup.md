# Backend initialization

**Goal:** Scaffold the Express REST API foundation for feature 2, attaching one
PDF to a session.

**Design:** Keep TypeScript source, Node 24 configuration, npm dependencies, and
the lockfile in `backend/`. Separate the Express application from the server
entry point. Expose `GET /health` with HTTP 200 and `{"status":"ok"}`. Use port
3000 by default, configurable through `PORT` or an optional local `.env` file.

This slice adds only the API foundation. PDF upload, session handling, storage,
and frontend integration remain part of future feature 2 work.

## Tasks

- [x] Scaffold the standalone backend package and development/build commands.
- [x] Add the health endpoint and verify it over HTTP.
- [x] Verify a clean install, type checking, linting, and the compiled server.
- [x] Document usage and update the roadmap to reflect partial progress.

**Verification:** Clean `npm ci`, type checking, linting, and builds passed for
both applications. HTTP smoke checks passed for the development server and
compiled server: health returns HTTP 200 with JSON, unknown routes return 404,
the default port works, `.env` configures the port, and shell `PORT` overrides
`.env`. No automated test suite was added for this foundation-only slice.
