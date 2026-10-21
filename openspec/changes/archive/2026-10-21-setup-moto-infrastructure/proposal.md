# Proposal: Local S3 infrastructure with Moto

## Why

Feature 2 needs a repeatable local S3 environment before direct PDF uploads and backend validation can be implemented. Use Moto Server for local development, with AWS S3 as the production storage target, and accept disposable local uploads when the emulator restarts.

## What Changes

- Add a pinned official Moto Server Docker image, loopback access, readiness checks, and a repeatable startup/bootstrap command.
- Provision `pdf-staging` and `pdf-ready` with private bucket configuration and public-access blocking, without persistent storage, versioning, object lock, or automatic expiration.
- Configure staging bucket CORS for the local frontend and disable Moto's default global wildcard CORS.
- Prepare AWS-format policy definitions for separate upload-signer and backend roles. Local checks cover configuration and S3 operations; production authorization and signature-validation checks remain a later AWS verification step.
- Document dummy local credentials, host/container endpoints, startup/reset behavior, and the emulator's limits. No paid plan, cloud account, or activation token is required for Moto.
- Preserve the one-hour staging retention target as deferred work; process restarts do not implement retention while the service runs.

Upload APIs, frontend integration, webhooks, queues, workers, validation, automatic promotion/cleanup, AWS resource provisioning, and frontend hosting are excluded.

## Capabilities

### New Capabilities

- `pdf-object-storage`: Repeatable local staging/ready S3 storage, browser-origin configuration, and AWS policy definitions with explicit emulator verification limits.

### Modified Capabilities

None; the project has no existing capability specs.

## Impact

- Adds a root Compose entry point and configuration, bootstrap, policy definitions, checks, and documentation under `infra/moto/`.
- Uses Moto's official image and AWS SDK-compatible tooling. Application code and application Node dependencies remain unchanged.
- The change identifier is `setup-moto-infrastructure`.
- Requires local upload/read/copy/delete, CORS, bootstrap-rerun, and fresh-start checks. Passing these checks is not evidence of AWS IAM correctness.

### Review scope

One infrastructure outcome, delivered as runtime setup followed by bucket configuration and checks. New dependencies are Docker Compose, Moto Server, and containerized bootstrap tooling. Uncertainty concerns the pinned release's browser-upload behavior and partial policy emulation. Keep AWS deployment, real authorization checks, and background processing in later changes.
