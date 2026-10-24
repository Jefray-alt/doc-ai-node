# Proposal: Direct PDF upload to staging

## Why

Feature 2 has local S3 infrastructure but no application upload path. Connect the existing Add PDF entry point to staging storage using an integration that can target Moto locally and AWS S3 when deployed.

## What Changes

- Add an Express endpoint that checks declared file metadata, generates an opaque object key, and returns a short-lived presigned PUT URL for the staging bucket.
- Use AWS SDK for JavaScript v3 in the backend, with explicit local Moto configuration and deployment configuration using AWS endpoint resolution and role credentials.
- Use Axios from the start for frontend API requests and direct PDF uploads; isolate storage uploads from backend request defaults and interceptors.
- Replace the PDF availability placeholder with single-file selection, upload progress, cancellation, retry after failure, and an explicit uploaded-to-staging result.
- Keep upload completion distinct from PDF validation and readiness for questions. This slice does not complete Feature 2.

Session persistence and server-side document attachment, PDF content validation, promotion to ready storage, processing, notifications, databases/jobs, one-hour cleanup, and AWS provisioning/enforcement verification remain separate work.

## Capabilities

### New Capabilities

- `pdf-upload`: Request scoped upload authorization and transfer one candidate PDF from the browser into staging, with observable upload status and environment-based storage configuration.

### Modified Capabilities

None. The existing `pdf-object-storage` provisioning and verification requirements remain unchanged.

## Impact

- Backend: new upload route, configuration and signing module; `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` dependencies.
- Frontend: Axios dependency, API/upload helpers, a focused PDF upload component and hook, and workspace composition updates. Existing chat behavior remains available.
- Development: Vite API proxy, environment examples, functional checks, and setup documentation. No new infrastructure service or database.
- At implementation completion, update Feature 2's roadmap status without marking document readiness complete.

### Review scope

One cross-application outcome: a browser-selected PDF reaches staging. Deliver serial, independently reviewed slices for signing, browser transport, the upload UI, and integration verification. Main uncertainties are exact AWS SDK checksum/header behavior with the pinned Moto release and browser cancellation races. Split validation/promotion and production deployment into later changes; no additional split is needed for this upload outcome.
