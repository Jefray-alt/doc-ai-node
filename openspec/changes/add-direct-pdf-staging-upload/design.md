# Design

## Context

See `proposal.md` for motivation. Express currently exposes only `/health`; React has an Add PDF availability modal and in-memory messages. Neither application has HTTP/storage integration or a test script. Vite has no API proxy. Moto already provides staging/ready buckets, staging PUT CORS for the frontend origin, and separate signer/backend AWS policy definitions.

This design is needed because the change crosses browser, API, and storage boundaries and introduces Axios and AWS SDK dependencies.

## Goals / Non-Goals

**Goals:** Establish a metadata-only signing API and direct browser upload, isolate service-specific HTTP configuration, and make success/failure/cancellation understandable.

**Non-Goals:** Treating an upload as a persisted session attachment or validated PDF. There is no server-side document registry, completion callback, ready-bucket access, or deletion on cancellation in this slice. The capability spec defines the user-visible boundary.

## Decisions

### 1. Metadata-only authorization endpoint

Add `POST /api/uploads/presign` with JSON `{ filename, size, contentType }`. Apply a small JSON body limit and validate types and metadata before signing. Proposed defaults are a 10 MiB candidate limit and a five-minute URL lifetime; these are planning choices, not previously established product limits. Accept an empty browser media type for `.pdf` files and normalize it to `application/pdf`.

Generate a UUID upload ID and an opaque key such as `uploads/<uuid>.pdf`; never interpolate user filenames or accept a client bucket/key. Return HTTP 201 with `{ uploadId, method: 'PUT', url, headers, expiresAt }`. The headers map includes `Content-Type: application/pdf` and every other browser-settable header required by the signature. Return HTTP 400 for invalid metadata/malformed JSON, 413 for oversized JSON bodies, and 503 for signing failure, using a stable `{ error: { code, message } }` shape. Do not echo signer exceptions or request/response bodies containing URLs into logs. `/health` keeps its current process-only meaning.

Signing is offline authorization creation, so API success does not prove the bucket exists or storage is reachable. Upload failures are surfaced by the browser. The API does not receive file bytes or persist the upload ID. No completion endpoint is needed until validation and session ownership are designed.

Alternative: proxy file bytes through Express. Direct uploads fit the already-provisioned browser CORS and signer policy and keep this API small.

### 2. One AWS SDK integration with explicit modes

Keep storage configuration and signing in focused backend modules, injected into the app/route for deterministic tests. Use `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`; create a `PutObjectCommand` and sign with `getSignedUrl`. Sign for the PDF content type and verify the exact checksum/query/header behavior of the installed SDK against the pinned Moto version. Do not accidentally sign an empty-body checksum for a later nonempty browser upload. Prefer SDK-supported configuration over stripping signed parameters or adding an incompatible header.

| Backend setting | Moto mode | AWS mode |
| --- | --- | --- |
| `STORAGE_MODE` | `moto`, explicit | `aws`, explicit |
| `AWS_REGION` | `us-east-1` | Required deployed region |
| `S3_STAGING_BUCKET` | `pdf-staging` | Required deployed name |
| `S3_ENDPOINT` | Required `http://localhost:5000` or equivalent loopback endpoint | Unset |
| Addressing | `forcePathStyle: true` | SDK default |
| Credentials | Explicit `moto-local` / `moto-local-secret` | Default credential provider chain; deployment role intended |

Reject unknown/missing mode, invalid configuration, non-loopback local endpoints, and local endpoint settings in AWS mode at startup. Local mode must not consult real profiles, metadata credentials, or silently fall back to AWS. Avoid implicit endpoint overrides that defeat the selected mode. Keep storage secrets out of frontend configuration. Backend `.env` is separate from Compose service environment, so document its settings explicitly.

The currently host-run backend signs `localhost:5000`, which the browser can reach. If it later moves into Compose, signing still needs a browser-reachable endpoint; do not rewrite a signed URL. No container migration is included here.

Use the existing upload-signer permission boundary for the signing component; do not expand the separately defined backend-access policy to add staging writes. Deploying distinct role credentials/assumption and verifying policies belongs to deployment work.

Alternative: separate Moto and S3 storage implementations. They expose the same S3 API, so configuration is sufficient; no general storage abstraction is needed.

### 3. Axios instances separate backend and storage traffic

Create a backend API instance with `/api` as its default base URL and a configurable `VITE_API_BASE_URL` override. Add a Vite development proxy for `/api` to the host Express server. Same-origin API hosting is the documented production default; a separately hosted API's CORS/authentication configuration is outside this change.

Use a separate Axios storage instance with no backend base URL, authorization, interceptors, or credentials. Do not mutate global Axios defaults. PUT the raw `File` to the returned URL with exactly the supplied headers; do not use `FormData`, add query parameters, or set browser-forbidden `Content-Length`. Use `onUploadProgress` and `AbortController` signals. A 100 percent progress event still waits for the storage HTTP response. Use bounded timeouts and show actionable messages without logging Axios error config, which contains the signed URL.

Cancellation aborts either authorization or transfer. Each attempt has an identity so late progress/success/error cannot update cancelled, unmounted, or newer state. A manual retry obtains a fresh URL and key; no automatic retry loop or refresh persistence. Cancellation can race with an accepted PUT and does not guarantee deletion.

Alternatives: fetch was discussed; Axios is the user's selected frontend transport. Sharing one Axios instance risks carrying future API authorization into signed storage requests.

### 4. Focused upload UI in the existing workspace

Replace `PdfAvailabilityModal` with a `PdfUpload` component folder containing its types, styles, transport/domain types and a focused upload hook. Keep a persistent upload controller under `ChatWorkspace` so closing the dialog does not erase the filename/result; keep `App.tsx` compositional and the theme in its existing config file. Closing during an active attempt cancels it before closing; closing after success preserves the workspace result.

Use existing Mantine primitives, an accessible single-file picker, a clear upload action, progress, cancellation, and explicit retry. Keep state transitions small:

```text
idle --> selected --> requesting --> uploading --> uploaded
                       |               |
                       +--> failed <---+
                       +--> cancelled <+
failed / cancelled --> requesting (fresh authorization)
```

Client-invalid selection never reaches `requesting`. Disable duplicate actions during an attempt. After success, show the filename and "Uploaded; not ready for questions" in the workspace, and prevent another document upload until refresh. This is a browser interaction constraint, not a server-enforced one-document session guarantee. Chat composition stays available and does not generate answers.

Alternative: implement server sessions now. That introduces a separate ownership/data model outcome and should be planned with validation/attachment rather than folded into storage transfer.

### 5. Verification and review slices

Introduce only test support needed for meaningful behavioral checks. Cover invalid signing requests, target configuration and signer failure in backend tests; cover raw-file transport, service isolation, completion ordering, cancellation and stale responses in frontend tests. Use actual browser verification with Moto for CORS, uploaded byte equality, failure/retry, and accessible desktop/mobile interaction. SDK-signature structure alone is not proof of AWS enforcement.

Deliver serial slices: backend contract/signing, Axios transport, upload interaction, then integration evidence/documentation. Each has its own independent TDD review and commit through the project's apply workflow. Backend work precedes transport, transport precedes UI, and all precede integration verification. Scope remains one upload outcome with no schema migration or background infrastructure.

## Risks / Trade-offs

- Declared MIME/size can be dishonest -> treat the object as untrusted staging data; real validation and storage-enforced limits remain future work.
- URLs are reusable until expiry and retries/cancellation can leave objects -> use opaque keys and short expiry; retain the already-deferred one-hour cleanup work without claiming it is implemented.
- No authentication/session ownership yet -> this slice establishes the local upload path; account/session authorization and the production deployment remain separate work.
- Moto only partially models permissions/signatures -> verify local functionality here and actual allow/deny/expiry behavior before deployment.
- SDK checksum behavior can differ across releases -> lock dependencies and exercise the exact browser request against Moto.

## Migration Plan

No stored data migration. Configure and start Moto, configure the host backend, then run Vite through its API proxy. Document both applications' environment examples and an end-to-end check. Update the roadmap after implementation to describe staging upload while leaving Feature 2 in progress. Rollback removes the upload integration and dependencies; disposable staging objects need no recovery.

AWS deployment later supplies bucket names, roles, matching frontend-origin bucket CORS, hosting configuration, and real security verification. Application upload logic and response contract stay the same; this proposal does not provision AWS resources.

## References

- [AWS JavaScript S3 and presigner examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html)
- [Moto server SDK compatibility](https://docs.getmoto.org/en/latest/docs/server_mode.html)
- [AWS Node credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
- [Axios instances](https://axios-http.com/docs/instance), [request configuration](https://axios-http.com/docs/req_config), and [AbortController cancellation](https://axios-http.com/docs/cancellation)
