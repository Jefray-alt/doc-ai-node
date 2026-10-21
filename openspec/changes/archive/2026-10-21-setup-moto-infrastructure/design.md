# Design

## Context

See `proposal.md` for motivation. The backend currently exposes only Express `/health`; neither application has storage integration or container infrastructure. The frontend normally runs at `http://localhost:5173`. The roadmap's linked upload plans are absent from this checkout.

The user selected Moto Server and accepted disposable local data. This replaces the prior persistence and comprehensive local authorization requirements. The durable capability remains `pdf-object-storage`; no implementation exists to migrate.

## Goals / Non-Goals

**Goals:** Start local S3 storage reproducibly, configure staging and ready buckets using AWS APIs, and prepare narrow AWS policy definitions for later deployment.

**Non-Goals:** Durable storage, full IAM emulation, production hosting, real AWS provisioning, application integration, PDF validation, automatic promotion, notifications, or cleanup scheduling.

## Decisions

### 1. Pinned Moto Server in Compose

Add root `compose.yaml` with the official `motoserver/moto` image, selecting a released version and recording its digest during implementation. Do not use `latest` or a development build. Bind port 5000 to host loopback. Keep frontend and backend on their existing host-based workflows.

Use `http://localhost:5000` from the host and `http://moto:5000` between Compose services, with region `us-east-1` and path-style S3 addressing. Set `S3_IGNORE_SUBDOMAIN_BUCKETNAME=true` so container hostnames are not mistaken for bucket names. Future browser upload signatures must use the browser-reachable endpoint; signed URLs must not be rewritten afterward.

Use explicit dummy AWS credentials for all local tooling. Do not mount AWS credential directories or the Docker socket. Local scripts must reject non-local endpoints rather than risk using real AWS. No activation token or host Python installation is required. [Moto server documentation](https://docs.getmoto.org/en/latest/docs/server_mode.html)

Alternative: LocalStack adds an account/token dependency and paid features for the earlier persistence/enforcement goals. Moto fits the selected disposable functional environment.

### 2. Startup procedure provisions every fresh instance

Put bootstrap and check scripts under `infra/moto/`. Run Python/boto3 tooling in the same pinned Moto image, using an explicit auxiliary-service entrypoint rather than changing the Node applications.

Provide a startup helper that starts the server, waits for a successful S3 health request, and invokes a fresh one-off bootstrap command. Bound availability retries and propagate provisioning failures. Do not assume an already-exited Compose bootstrap service will run again after a server restart.

The helper is the supported startup procedure. After a direct `docker restart` or a computer reboot, rerun it to restore bucket configuration. Bootstrap creates missing buckets, reapplies declared settings, and preserves objects already present in a running process. Unexpected configuration errors fail visibly; do not suppress them as 'already exists'.

Use no persistent data volume and make no recovery promise. A fresh process starts disposable state. A repeat bootstrap within the same process preserves fixtures; a fresh startup restores configuration, not old uploads.

Alternative: native-style startup hooks would assume functionality Moto does not provide. A small explicit helper makes completion and failure reviewable.

### 3. Private access configuration and separate policy definitions

Bootstrap creates `pdf-staging` and `pdf-ready`, sets private ACLs and all four public-access-block flags, and removes public policy grants. Do not install public Allow statements. Leave versioning and object lock disabled; fail on incompatible existing bucket settings instead of recreating buckets.

Deliver two AWS identity-policy JSON definitions under `infra/moto/policies/`:

| Intended role | Staging permissions | Ready permissions |
|---|---|---|
| Upload signer | `s3:PutObject`, `s3:GetBucketLocation` | None |
| Backend | `s3:ListBucket`, `s3:GetObject`, `s3:DeleteObject`, `s3:GetBucketLocation` | `s3:GetObject`, `s3:PutObject`, `s3:GetBucketLocation` |

Use bucket ARNs for bucket actions and the corresponding `/*` object ARNs for object actions. No broad action grants, administrator policy, ready deletion, or unrelated-bucket resources. Copying uses source read and destination write permissions. Production bucket names and role attachment are resolved in a later deployment change; do not provision AWS resources or long-lived AWS keys here.

Moto stores bucket-policy configuration but documents limited evaluation: only `Principal: "*"` statements are considered and conditions are ignored. Its IAM-like checks are basic and disabled by default. Leave optional IAM enforcement disabled in this slice; do not provision mock identities and present them as a proven security boundary. Private configuration is checked by API readback. Real allow/deny and signature/expiry checks remain required before AWS deployment. [S3 coverage](https://docs.getmoto.org/en/latest/docs/services/s3.html), [IAM limitations](https://docs.getmoto.org/en/latest/docs/iam.html)

Alternative: expanding Moto's authorization model or enabling request-count-based IAM bootstrap would add complexity without establishing AWS parity.

### 4. Bucket CORS with global fallback disabled

Set `MOTO_DISABLE_GLOBAL_CORS=true`. Apply staging bucket CORS for the configured frontend origin, default `http://localhost:5173`, allowing PUT and POST uploads, required request headers, and exposed `ETag`. Give the ready bucket no browser CORS configuration. Check both matching and unrelated origins; CORS controls browser access, not authentication.

Keep local settings in an environment example and document dummy credentials as development values only. No real secrets belong in frontend variables. No application SDK dependency or upload API is introduced by this change.

### 5. Functional checks and deferred retention

Add a repeatable smoke check for bucket configuration, staging upload/list/read, copy to ready, destination byte equality, and staging deletion. Also generate an object-specific signed PUT URL in containerized tooling and exercise it from the host-reachable endpoint, with browser-equivalent preflight headers. Check CORS separately. This proves client compatibility, not signature rejection, expiry enforcement, or authorization parity. Do not log signed URLs.

Remove test fixtures explicitly. Verify bootstrap rerun, startup after a process restart, and visible failures. Keep fixtures small; no PDF parser or additional test framework is needed.

The one-hour staging retention target remains agreed and unenforced. Neither process restart nor a day-based lifecycle rule substitutes for scheduled cleanup. Workers, notification delivery, validation/promotion, and retention coordination belong in a later change.

## Risks / Trade-offs

- Partial policy and signature emulation -> verify configuration locally and test real AWS permissions before production.
- Restart discards uploads -> recreate configuration through the startup helper and re-upload local fixtures.
- Version-sensitive CORS or SDK behavior -> pin the image and exercise the exact upload flow during implementation.
- Local endpoints offer weak authentication guarantees -> bind to loopback, use only dummy data/credentials, and keep Moto out of deployment configuration.
- No one-hour expiration yet -> document the limitation and retain cleanup as separate work.

## Migration Plan

There is no storage deployment to migrate. Implement runtime/startup first, then buckets, policies, CORS, and functional checks. Rollback stops the local services; all emulator data is disposable.

At implementation completion, update the roadmap's feature 2 status and replace missing-plan references with this change. Feature 2 remains in progress.

Review scope remains one local-storage foundation; no database, worker service, or application refactor is needed.
