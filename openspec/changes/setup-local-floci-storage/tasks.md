# Tasks

## 1. Local storage foundation

- [ ] 1.1 Deliver the usable local Floci environment described in `design.md`: root Compose service with a pinned compat release, persistent volume, automatic bucket initialization, bucket-based readiness, and the upload/read/delete smoke script; include README operating instructions and the brief roadmap prerequisite update in the same reviewed commit. Acceptance: no AWS account or host AWS CLI is needed; startup creates the bucket; repeat startup preserves data; restart and container recreation preserve fixture bytes; explicit reset clears data and recreates the bucket; smoke verification succeeds against healthy storage and fails when unavailable. Verify with `docker compose config -q`, `sh -n infra/floci/init/*.sh scripts/floci/smoke.sh`, and every lifecycle check below using an isolated Compose project. Feature 2 and application integration remain pending.

### Verification for task 1.1

Run from the repository root with Docker available and port 4566 free. Use a unique `COMPOSE_PROJECT_NAME` throughout validation so containers and volumes are separate from ordinary development. Never reset the default development project's volume during verification.

1. Run `docker compose config -q` and shell syntax checks. Confirm a pinned release, loopback binding, project-scoped volume, read-only hook mount, and explicit local CLI endpoint/credentials.
2. Run `docker compose up -d --wait` on a fresh validation project. Verify `docker compose ps` reports healthy and `docker compose exec -T floci aws --endpoint-url http://localhost:4566 s3api head-bucket --bucket doc-ai-local-pdfs` succeeds without a manual setup step.
3. Run `sh scripts/floci/smoke.sh` twice. Both runs must compare uploaded/downloaded bytes, verify deletion, and preserve unrelated objects.
4. Upload a separate uniquely named fixture using the container CLI and retain its expected bytes. Run `docker compose restart floci`, wait for healthy storage with a bounded wait, and download/compare the fixture. Repeat after `docker compose down` and `docker compose up -d --wait`; the bucket and identical fixture must remain.
5. Stop the validation service and confirm `sh scripts/floci/smoke.sh` exits nonzero. Bring it up again, then run `docker compose down -v` only for this validation project and start afresh. The bucket must be recreated and the retained fixture must be absent with an S3 missing-object response. Run the smoke check once more.
6. Exercise the README commands as written, including logs and deliberate reset. Confirm the roadmap records only the infrastructure prerequisite and links to setup instructions. Clean up the validation project and its volume after checks.

Record observed command outcomes for review. Use the smoke check and lifecycle checks as behavioral evidence; no frontend/backend test changes or new testing framework are required for this tooling-only change.
