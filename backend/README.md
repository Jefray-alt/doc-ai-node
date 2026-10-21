# Backend API

Express + TypeScript foundation for the single-PDF chat application. All backend
Node tooling and dependencies live in this directory.

## Development

Use Node.js 24 LTS and npm. From the repository root:

```sh
cd backend
nvm use # If you use nvm
npm ci
cp .env.example .env
npm run dev
```

The API listens on port 3000 by default. Copy `.env.example` to `.env` and set
the required storage settings below before starting. Both `dev` and `start` load
this file when present; an existing shell environment variable takes precedence.
Invalid or missing storage settings stop startup before opening the listener.

Development uses Node's native TypeScript support and restarts on source changes.
Run type checking separately:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm start
```

`build` compiles `src/` to JavaScript in `dist/`. `start` runs that compiled build.
`npm test` runs Vitest, including offline SDK signing checks; it requires neither
Moto nor real AWS credentials.

## Storage configuration

The host backend uses the same AWS SDK v3 signing component for Moto and AWS S3.
Backend `.env` settings are separate from the Compose service environment.

| Setting | Local Moto | AWS deployment |
| --- | --- | --- |
| `STORAGE_MODE` | Required `moto` | Required `aws` |
| `AWS_REGION` | Required, normally `us-east-1` | Required bucket region |
| `S3_STAGING_BUCKET` | Required `pdf-staging` | Required deployed staging bucket name |
| `S3_ENDPOINT` | Required `http://localhost:5000` | Must be absent, including no empty assignment |
| Credentials | Explicit `moto-local` / `moto-local-secret` | SDK default credential chain; deployment role intended |
| Addressing | Path style | SDK default regional addressing |

Moto accepts only HTTP(S) loopback origins (`localhost`, `127.0.0.1`, or `::1`),
with no user information, path, query, or fragment. Missing endpoints, remote
hosts, unknown modes, invalid regions/bucket names, and AWS-mode local endpoint
settings are rejected. SDK endpoint environment overrides (`AWS_ENDPOINT_URL`,
`AWS_ENDPOINT_URL_S3`) are rejected; configured profile endpoint overrides are
ignored. Moto credentials are supplied explicitly even when real environment
credentials or AWS profiles exist; Moto mode never consults the credential chain.
AWS mode injects no endpoint, dummy credentials, or path-style setting.

The endpoint used when signing must be reachable by the browser. The backend is
currently host-run, so `localhost:5000` fits the local setup. A Docker-only name
such as `moto:5000` is unsuitable. Do not rewrite a signed URL after signing.

`src/storage/signer.ts` exports an injectable `createUploadSigner` factory. Each
call returns a PUT authorization with a UUID upload ID, an opaque
`uploads/<uuid>.pdf` key in the configured staging bucket, a required
`Content-Type: application/pdf` header, and a five-minute expiration. The signer
has no filename or target arguments and performs no storage network request.
SDK optional upload checksums are disabled (`requestChecksumCalculation:
WHEN_REQUIRED`) because file bytes arrive later from the browser; the signer
must not bind an empty-body checksum. The installed SDK's actual signed headers,
expiration, and checksum query behavior are covered by offline tests. Browser
compatibility with Moto is verified in the integration slice.

Keep this signer within the existing upload-signer permission boundary. AWS
provisioning, role assignment, bucket CORS, and actual permission/signature
allow/deny checks remain deployment work. The separate backend-access policy
does not need staging writes. Signing success alone does not prove storage is
reachable or a bucket exists. Never log signing exceptions, credentials, or
signed URLs. The API endpoint and direct browser transfer are subsequent slices.

## Health endpoint

```sh
curl -i http://localhost:3000/health
```

`GET /health` returns HTTP 200 with JSON:

```json
{"status":"ok"}
```

This endpoint confirms the API process can respond. It does not check external
services. PDF upload, session handling, and frontend integration are still pending.

`src/app.ts` defines the Express application and routes. `src/server.ts` starts
the HTTP listener. See the [Express documentation](https://expressjs.com/en/starter/installing/)
for the framework's TypeScript setup.
