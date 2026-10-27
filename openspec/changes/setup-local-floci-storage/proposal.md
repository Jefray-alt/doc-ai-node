# Proposal

## Why

Feature 2 will need somewhere to store an uploaded PDF, but the repository has no local object storage. Establish a reproducible Floci development environment first so application integration can be planned separately without requiring an AWS account.

## What Changes

- Add a root Docker Compose configuration for a local Floci service with a pinned release image, a loopback-only S3 endpoint, and persistent Docker storage.
- Automatically create a development bucket on startup, including after an explicit reset, without overwriting existing data.
- Provide a repeatable upload/read/delete smoke check and verify that objects survive container restart and recreation.
- Document startup, readiness, local connection values, shutdown, and deliberate data reset; record the completed infrastructure prerequisite in the roadmap after implementation.
- Keep NestJS integration, application containers, PDF upload handling, sessions, ingestion, and production AWS provisioning outside this change. Feature 2 remains pending.

## Capabilities

### New Capabilities

None. This change adds local development tooling without changing application behavior. Capability specs are intentionally skipped through `skip_specs: true`.

### Modified Capabilities

None.

## Impact

- Planned implementation files: `compose.yaml`, `infra/floci/init/` for bucket initialization, `scripts/floci/smoke.sh` for verification, `README.md`, and a brief progress update in `docs/roadmap.md`.
- Requires Docker Engine and Docker Compose v2; the container supplies AWS CLI tooling, so host AWS CLI installation and real AWS credentials are unnecessary.
- Adds a local container, a project-scoped named volume, and host port 4566. Frontend/backend code, dependencies, configuration, and APIs are unchanged.
