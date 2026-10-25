# Proposal

## Why

The backend currently leaves application structure and wiring to manual Express conventions. Adopt NestJS while the API contains only a health endpoint so subsequent PDF and chat work follows a stable, documented feature-module structure.

## What Changes

- Replace the hand-wired Express application and server entry point with a Nest application using the default Express adapter.
- Establish feature folders, Nest file naming, thin controllers, service-owned application logic, and constructor dependency injection as backend conventions. Structural exceptions require an explicit design decision.
- Use Nest compilation and watch tooling, retaining the existing `dev`, `build`, `start`, `typecheck`, and `lint` command names. Add TypeScript tests using Vitest, Supertest, and `@nestjs/testing`, with conventional test configuration and file naming.
- Preserve the health endpoint, port selection, optional environment-file loading, and backend-local package ownership.
- Update backend instructions and the roadmap during implementation to describe the completed foundation and its conventions.

## Capabilities

### New Capabilities

None. This is an architecture and tooling refactor with no new product capability. The change declares `skip_specs: true`; compatibility criteria live in the design and tasks.

### Modified Capabilities

None. There are no existing OpenSpec capability specs, and the migration preserves the current API contract.

## Impact

- Affects `backend/src/`, backend dependencies and lockfile, TypeScript/build/test configuration, and package scripts.
- Adds Nest core/common/platform-express, reflection metadata, RxJS, and the necessary local development/testing tools, including Vitest, Supertest, `@nestjs/testing`, and decorator-capable test transformation. Express remains the HTTP adapter beneath Nest. Standard Nest conventions take priority over minimizing dependency count.
- Updates `backend/README.md`, the repository `README.md`, `docs/plan/backend-setup.md`, and the backend progress entry in `docs/roadmap.md` during implementation.
- Keeps Node.js 24, npm, ESM, strict TypeScript, and backend-owned dependencies. Native TypeScript execution is replaced by decorator-capable compilation.
- Preserves `GET /health` as HTTP 200 with JSON `{"status":"ok"}`, default port 3000, optional `backend/.env`, and shell environment precedence. Unmatched routes remain HTTP 404; their framework-generated bodies are not a compatibility guarantee.
- PDF upload, session handling, RAG, frontend integration, and changes to MVP scope remain outside this change.
