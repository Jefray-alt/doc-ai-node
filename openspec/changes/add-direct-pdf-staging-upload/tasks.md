# Tasks

Apply serially through the project's TDD developer/independent reviewer workflow. Each checkbox is an independently reviewed commit containing its relevant files, tests/documentation, and checkbox update. Dependencies are explicit below; no task starts the next feature.

## 1. Backend signing contract

- [x] 1.1 Add backend AWS SDK dependencies and validated Moto/AWS storage configuration with an injectable signing component; document environment settings in `backend/.env.example` and `backend/README.md`. Verify tests cover local endpoint rejection, explicit dummy credentials without profile fallback, AWS configuration without local overrides, unique staging keys, required headers, and five-minute expiration; run backend typecheck/lint/build. No real AWS calls are required.
- [ ] 1.2 After 1.1, add `POST /api/uploads/presign` with bounded JSON parsing, candidate metadata checks, the designed success/error contract, and safe failure handling; document the endpoint. Verify HTTP tests cover accepted/normalized metadata, invalid types/extensions/sizes/media types, malformed and oversized JSON, refusal of client-controlled targets, signing failures without secret leakage, and unchanged `/health`; run backend tests/typecheck/lint/build.

## 2. Browser HTTP transport

- [ ] 2.1 After 1.2, add Axios with separate backend and storage instances, typed authorization/raw-file upload helpers, progress and cancellation signals, bounded timeouts, Vite `/api` proxy, and documented frontend environment configuration. Verify transport tests exercise the API contract, exact raw file/header forwarding, isolation from API authorization/defaults/interceptors, cancellation and storage failures without URL leakage; run frontend typecheck/lint/build. Colocate upload types with their owning component/domain.

## 3. Workspace upload interaction

- [ ] 3.1 After 2.1, add the focused upload controller with candidate checks and idle/selected/requesting/uploading/uploaded/failed/cancelled transitions. Verify behavioral tests cover duplicate suppression, cancellation during both requests, stale response/progress isolation, unmount cleanup, fresh authorization on retry, waiting for storage success after 100 percent progress, and one completed document per in-memory workspace; document the state/retention behavior alongside the frontend flow.
- [ ] 3.2 After 3.1, replace the availability placeholder with the Mantine single-PDF upload interface and connect it to the workspace; colocate styles/types/hooks, preserve uploaded status when the dialog closes, and cancel active work on close. Verify accessible selection, progress, cancel/retry controls, invalid-file messages, explicit uploaded-but-not-ready wording, refresh reset, and existing chat composition through component/browser checks at desktop and narrow mobile widths; update frontend usage documentation and run frontend tests/typecheck/lint/build.

## 4. End-to-end integration

- [ ] 4.1 After 3.2, exercise the real browser-to-API-to-Moto flow and record reproducible integration instructions/results: confirm CORS, uploaded byte equality in staging, no ready-bucket promotion, failure/retry and cancellation behavior, and the installed SDK's checksum/signing compatibility without exposing signed URLs. Run the existing Moto checks and both applications' tests/typecheck/lint/build. Update `docs/roadmap.md` to describe staging upload with Feature 2 still in progress; retain explicit deferred validation/session attachment/cleanup/AWS enforcement work. Remove only integration fixtures created by these checks and document the integration outcome in the setup guide.

## Workflow follow-up

- Review the completed upload slice before archiving; archive only when requested.
- Plan validation/promotion and server-side session attachment separately. Do not implement them automatically.
- Before deployment, provision AWS roles/buckets/hosting and verify actual permission and signature enforcement in a separate deployment change.
