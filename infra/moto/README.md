# Local S3 with Moto

Run commands from the repository root. Requirements: Docker Engine with Compose
v2 or newer, a POSIX shell, and curl. Python and boto3 run inside the pinned
official Moto image; there are no application Node dependency changes. No cloud
account, activation token, or real AWS credentials are needed.

## Start and inspect readiness

```sh
# Optional: customize FRONTEND_ORIGIN (defaults to http://localhost:5173).
cp infra/moto/.env.example infra/moto/.env
./infra/moto/up.sh
docker compose ps moto
docker compose run --rm -T tools ready
```

The helper starts Moto, waits for a successful S3 list-buckets request with at
most 15 attempts, reports **S3 ready**, then runs a fresh one-off bootstrap.
Readiness alone does not prove provisioning succeeded. The helper exits nonzero
if either stage fails. `Bucket provisioning completed` confirms bootstrap.
Rerunning the helper preserves objects in the same running emulator process.

| Setting | Local value |
| --- | --- |
| Host/browser endpoint | `http://localhost:5000` |
| Compose service endpoint | `http://moto:5000` |
| Region | `us-east-1` |
| Access key | `moto-local` |
| Secret key | `moto-local-secret` |
| Addressing | Path style, e.g. `/pdf-staging/key` |

Only host loopback port 5000 is published. Tooling explicitly selects the local
endpoint, hardcodes dummy credentials, disables metadata/profile-file lookup,
and rejects non-local endpoint overrides. Do not mount credential directories or
the Docker socket. Keep this emulator local and use dummy data only.

The image is the official `motoserver/moto:5.2.4` release tag pinned to the
manifest digest recorded in `compose.yaml`. See the
[release](https://github.com/getmoto/moto/releases/tag/5.2.4) and
[server documentation](https://docs.getmoto.org/en/latest/docs/server_mode.html).

## Stop, restart, and reset

```sh
docker compose stop moto
./infra/moto/up.sh

# A direct restart discards uploads; rerun setup to restore configuration.
docker compose restart moto
./infra/moto/up.sh

# Remove this Compose project's containers/network and start fresh.
docker compose down
./infra/moto/up.sh
```

There is no persistent data volume. Stopping/restarting the process, recreating
the container, or rebooting can discard uploads. Setup recreates configuration;
previous uploads must be supplied again. After any direct container restart or
reboot, run `up.sh` even if the container appears healthy.

Set `COMPOSE_PROJECT_NAME` consistently for an isolated disposable project:

```sh
export COMPOSE_PROJECT_NAME=doc-ai-moto-acceptance
./infra/moto/up.sh
# Run checks, then remove only this project's containers/network.
docker compose down
unset COMPOSE_PROJECT_NAME
```

Only one project can publish loopback port 5000 at a time. This infrastructure
does not integrate either application with S3.

## Check configuration and operations

```sh
./infra/moto/check.sh

# Configuration readback alone (select .env instead if you customized it).
docker compose --env-file infra/moto/.env.example run --rm -T tools check
```

The helpers automatically use `infra/moto/.env` if present, otherwise
`.env.example`. Shell `FRONTEND_ORIGIN` overrides that file. Use the same origin
for setup and checks; direct Compose tooling commands must select the same env
file. Origins must be exact HTTP(S) origins without a trailing slash or wildcard.

Bootstrap creates `pdf-staging` and `pdf-ready`, reapplies private owner-only
ACLs and all four public-access-block flags, removes bucket policies and
lifecycle rules, and clears notification targets. It rejects existing versioning
(including suspended versioning) or object lock with an error; it never deletes
and recreates an incompatible bucket. Reset disposable storage explicitly if
that happens. Unsupported API operations and unexpected errors also fail.

Staging CORS permits PUT/POST from the configured frontend origin, Content-Type
and `x-amz-*` request headers, and exposes ETag. Ready has no browser CORS
configuration, and Moto's global wildcard fallback is disabled. CORS controls
browser access; it does not authenticate requests.

`check.sh` verifies configuration readback, matching/unrelated-origin preflights,
ready CORS absence, staging upload/list/read, copy into ready, destination byte
equality, and source deletion. It also signs an object-specific PUT using the
host endpoint in containerized tooling, performs the preflight and upload with
host curl, and verifies response headers and bytes. The host URL is signed as
`http://localhost:5000`; signed URLs must never be rewritten to another endpoint.
Fixtures are explicitly deleted, including on ordinary check failures. If Moto
becomes unreachable during cleanup, the check fails and reports the cleanup
error; reset or remove the reported fixture before continuing.

Signed URLs are stored only in a private temporary curl configuration, removed
on exit, and never printed. Server request logging is disabled because Werkzeug
would otherwise log signed query strings. Do not run the helper with shell
tracing or add curl verbose/trace flags. The signed upload is **compatibility
evidence only**, not proof of signature, expiry, or authorization enforcement.

## Verification and retention limits

Moto's [bucket policy evaluation](https://docs.getmoto.org/en/latest/docs/services/s3.html)
is limited to `Principal: "*"` statements and ignores conditions. Its optional
[IAM-like checks](https://docs.getmoto.org/en/latest/docs/iam.html) are basic and
disabled by default; this setup leaves them disabled. API readback of private
settings is not a production security guarantee, and anonymous-access denial
is not established by these checks.

Before production deployment, a separately authorized AWS integration change
must verify both roles' permitted and denied operations, bucket/public-access
restrictions, anonymous-access denial, CORS, and valid/invalid/expired upload
signatures against actual AWS S3. These local checks do not establish those
properties.

All data is disposable across process restarts. The agreed **one-hour staging
retention target remains unenforced**: no expiration rule, scheduler, or cleanup
worker runs. A restart is not retention enforcement. Notifications, PDF
validation, automatic promotion, upload APIs, database/jobs, and application
integration remain separate work. Smoke fixtures are dummy bytes, not a PDF
validation test.

## AWS policy definitions

`policies/upload-signer.json` grants staging `PutObject` and `GetBucketLocation`.
`policies/backend.json` grants staging list/read/delete, ready read/write, and
bucket location discovery. Bucket actions use exact bucket ARNs; object actions
use the corresponding `/*` ARNs. Copy needs staging read and ready write.

These identity-policy definitions are not attached to local identities. Production
bucket names, role creation/attachment, and real AWS allow/deny enforcement tests
are deferred to a separately authorized deployment change. No AWS resources or
long-lived keys are provisioned here. Passing local operations does not prove
these policies enforce permissions in AWS.
