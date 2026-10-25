# Design

## Context

See [proposal.md](proposal.md) for motivation and scope. The repository currently runs Vite and NestJS directly on the host, has no Compose configuration, and owns Node tooling inside each application. This change introduces an external development dependency without changing either application.

## Goals / Non-Goals

**Goals:** A developer with Docker Compose v2 can start local storage, verify it using container-provided tooling, preserve data during ordinary shutdown, and deliberately reset it.

**Non-Goals:** No application configuration, SDK dependency, application containerization, production configuration, or session retention policy. Local volume persistence makes no commitment about future user-facing document retention.

## Decisions

### One Floci service at the repository root

Add `compose.yaml` with service name `floci`. Use a specific published `floci/floci` release with the `-compat` suffix, selected and verified during implementation; do not commit a floating tag. The compat variant supplies AWS CLI tooling for initialization and smoke checks, avoiding a host installation or a separate CLI service. Do not mount the Docker socket or add unrelated AWS services or application containers.

Expose `127.0.0.1:4566:4566`. Use region `us-east-1`, dummy access key and secret `test`, and bucket `doc-ai-local-pdfs`. Set these local values explicitly in the container. Every CLI invocation in initialization, health checks, and smoke verification must explicitly target `http://localhost:4566` inside Floci, with no dependency on host AWS profiles. The documented host endpoint is `http://localhost:4566`.

Real S3 during development would require AWS setup and connectivity; defer it to a later integration change.

### Persistent storage and repeatable initialization

Use `FLOCI_STORAGE_MODE=persistent`, `FLOCI_STORAGE_PERSISTENT_PATH=/app/data`, and a Compose-managed named volume mounted at `/app/data`. Let Compose scope volume/container names by project; do not set global names. A named volume keeps generated data outside the checkout, unlike a bind mount.

Mount `infra/floci/init/` read-only at `/etc/floci/init/start.d`. The startup hook checks for the bucket and creates it if missing; repeated startup must preserve existing objects. Unexpected API errors must surface rather than being treated as successful initialization. Use a bounded health check that verifies the bucket through S3, so `docker compose up -d --wait` reports successful startup only when storage is usable. Document logs for diagnosing initialization failures. A running process alone is insufficient readiness.

Ordinary `restart` and `down` followed by `up` preserve the volume. Explicit `down -v` clears this Compose project's data; subsequent startup creates a fresh bucket.

### Small behavioral verification

Provide `scripts/floci/smoke.sh`, invoked from the repository root with a POSIX shell. Use `docker compose exec -T floci` and the bundled AWS CLI to upload a uniquely named temporary object, read and compare its bytes, delete it, and confirm absence. Fail on any unexpected result, clean up the smoke object's temporary resources where possible, and leave existing objects untouched. The smoke check must fail when Floci is unavailable. No new Node testing packages or host AWS CLI are needed.

Verify restart, recreation, and reset separately with a retained fixture in an isolated Compose project. Respect `COMPOSE_PROJECT_NAME` so validation cannot erase the developer's normal volume. Do not make destructive reset part of the routine smoke command.

### Documentation stays with development setup

Add root README instructions for prerequisites, start/wait, smoke verification, connection values, logs, stop, restart, and explicit reset. After implementation, add a short storage-prerequisite progress note to the roadmap, linking to the README while leaving Feature 2 pending.

## Risks / Trade-offs

- Floci emulation differs from AWS -> Treat this as local tooling; validate actual S3 behavior during the later integration work.
- Image tooling and hooks can vary by release -> Pin the release that passes the documented lifecycle checks. References: [Docker images](https://floci.io/floci/configuration/docker-images/), [Compose and persistence](https://floci.io/floci/configuration/docker-compose/), and [initialization hooks](https://floci.io/floci/configuration/initialization-hooks/).
- Port 4566 may already be occupied -> Surface the Compose error and document resolving the conflict before startup.
- Reset removes stored objects -> Keep it an explicit documented command and exercise it only against the isolated validation project.

## Migration Plan

No application or cloud data migration is required. Add the local tooling and verify its lifecycle before recording the prerequisite as complete. To roll back, stop this Compose project and remove the added tooling; remove its volume only when its local data can be discarded.
