# Tasks

## 1. Moto runtime and repeatable startup (review slice A)

This slice establishes the emulator and startup procedure needed by slice B.

- [x] 1.1 Add root Compose configuration using a released official Moto image pinned by digest, loopback port 5000, path-style endpoint handling, disabled global wildcard CORS, explicit dummy credentials, and no persistent data volume or credential/socket mounts; verify Compose configuration validates and the S3 endpoint becomes reachable without a cloud account or activation token.
- [x] 1.2 Add containerized bootstrap tooling and a startup helper under `infra/moto/` that waits with bounded retries and runs a fresh one-off bootstrap command on each invocation; verify readiness is distinguishable from provisioning success, an unreachable emulator produces a nonzero result, and non-local endpoints are rejected.
- [x] 1.3 Document startup, stop/reset, host/container endpoints, dummy credentials, and rerunning setup after a direct container restart in `infra/moto/README.md`, linked from the root README; verify the documented runtime commands work without host Python or changes to application Node tooling.

## 2. Buckets, policy definitions, and functional checks (review slice B)

Depends on slice A. This slice delivers bucket configuration with explicit limits on security verification.

- [x] 2.1 Implement bootstrap for both buckets with private ACLs, all public-access-block flags, no public grants, versioning, object lock, expiration, or notifications; verify configuration readback, successful rerun preserving an existing fixture, and nonzero failures for unsupported or incompatible settings.
- [x] 2.2 Add separate AWS upload-signer and backend identity-policy definitions matching the design; verify valid JSON, correct bucket/object resource scopes, and the absence of broader grants. Document role attachment and AWS enforcement tests as deferred; do not provision real AWS resources or claim local IAM equivalence.
- [x] 2.3 Apply staging bucket CORS for the configured frontend origin and expose ETag, leaving ready storage without browser CORS; verify upload preflights and response headers permit the configured origin and do not grant an unrelated origin.
- [x] 2.4 Add a repeatable smoke check for staging upload/list/read, copy into ready, byte equality, and source deletion, plus a host-reachable signed PUT upload using containerized signing tooling; verify it passes against Moto, fails when an expected result is broken, removes fixtures, and prints no signed URLs. Describe the signed upload check as compatibility evidence only.
- [x] 2.5 Extend setup documentation with configuration checks, Moto authorization/signature limits, the future AWS permission-verification requirement, disposable data, and the unenforced one-hour staging retention target; verify no persistence, automatic cleanup, or production security guarantees are claimed.

## 3. Integrated acceptance

Depends on slices A and B; checks the combined startup and storage flow.

- [x] 3.1 Run documented setup and checks in a fresh disposable Compose project, rerun bootstrap with fixtures present, then restart the emulator and rerun setup; verify configuration is recreated, fixtures survive only the same-process bootstrap rerun, and there is no reliance on restoring uploads after restart.
- [x] 3.2 Update the roadmap's lightweight feature 2 status to reference Moto infrastructure and this change, replacing missing-plan links while leaving feature 2 in progress; verify the implementation diff introduces no application integration, AWS deployment, workers, database, notification wiring, or cleanup scheduling.

## Workflow follow-up

- Before production deployment, verify role and bucket permissions, anonymous-access restrictions, CORS, and signed-upload signature/expiry behavior against actual AWS S3 in a separately authorized deployment or integration change.
- Plan upload APIs, validation/promotion workers, notification delivery, and one-hour cleanup separately.
