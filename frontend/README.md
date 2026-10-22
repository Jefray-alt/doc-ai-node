# Frontend

React + TypeScript SPA built with Vite and Mantine. This folder owns its
`.nvmrc`, `package.json`, `package-lock.json`, and `node_modules/`. From this folder, run:

```sh
nvm use # If you use nvm
npm ci
cp .env.example .env.local
npm run dev
```

See the [root README](../README.md) for the available development and build commands.

- `src/main.tsx`: React entry point, Mantine provider, and global styles.
- `src/App.tsx`: composition of the in-memory PDF chat workspace.
- `postcss.config.cjs`: Mantine CSS features and responsive breakpoint variables.

Use [Mantine](https://mantine.dev/) components and hooks as the UI foundation.
[Mantine UI](https://ui.mantine.dev/) provides component source to copy and adapt
when needed; the website repository is not an application dependency.

For production, serve `dist/` as static files. Configure the host to fall back to
`index.html` for client-side routes if routing is added.

The upload transport uses Axios. `VITE_API_BASE_URL` defaults to `/api`, and Vite
proxies that prefix to the host Express server at `http://localhost:3000` without
rewriting the path. Start the backend using its [setup guide](../backend/README.md).
For production, route `/api` to Express on the same origin as the static frontend;
Vite's development proxy is not part of the production build. An alternative API
base URL can include a prefix, for example `https://api.example.com/api`; separate
hosting requires its own CORS/authentication configuration. Restart Vite after
changing `.env.local`; frontend environment values are public build-time values.

`src/components/PdfUpload/uploadTransport.ts` requests metadata-only authorization
at `POST /api/uploads/presign` and uploads the raw `File` to the returned signed
PUT URL with its required headers. Storage uses an independent Axios XHR instance
with cross-origin credentials disabled, no API authorization/interceptors, and no
URL rewriting. The browser-reachable Moto or regional S3 endpoint must be on a
separate origin from the frontend; same-origin storage proxies are not configured.
The helpers accept an `AbortController` signal and optional transfer progress;
completion waits for the successful storage response. Authorization has a
15-second timeout and storage a 120-second timeout. Failures expose safe messages
without signed URLs; callers should not log raw Axios errors or authorizations.
The workspace owns `src/components/PdfUpload/usePdfUpload.ts`, which calls these
helpers, and renders the Mantine upload dialog in the same component folder.

Choose **Add PDF**, select a file with the labelled **PDF file** picker, then
choose **Upload PDF**. Selecting a file does not start a request. The dialog shows
metadata errors beside the picker; correct the selection before uploading.
It shows authorization, indeterminate transfer or percentage progress, then waits
for storage confirmation even after 100 percent of bytes have transferred.
The picker and duplicate upload actions are unavailable during the attempt.

Use **Cancel upload** to abort an active request, or close the dialog with its
close button, Escape, or the backdrop; closing cancels active work first.
After failure or cancellation, **Retry upload** starts a fresh attempt, and the
picker also allows another candidate. On completion, the filename and
**Uploaded; not ready for questions** remain in the workspace. **View upload**
reopens that result with selection and upload actions unavailable until refresh.
The message composer stays available throughout and does not generate answers.

The controller checks candidate metadata before requesting authorization: a
nonempty `.pdf` filename (case-insensitive), a positive integer size up to and
including 10 MiB, and `application/pdf` or an empty media type. Empty media types
become `application/pdf`. These are candidate checks, not PDF content validation
or storage-enforced size limits.

Its normal transition is `idle → selected → requesting → uploading → uploaded`.
Authorization or storage failure produces `failed`; cancelling either active
request produces `cancelled` and aborts its signal. Retrying a
failed or cancelled attempt requests fresh authorization and a new storage target.
Selection is allowed before starting or after failure/cancellation. Duplicate
submissions and replacement selections are blocked while an attempt is active.
Progress can be indeterminate; 100 percent still waits for storage success.
Late responses and progress cannot update cancelled, superseded or unmounted
controllers. Failures contain safe, actionable messages without signed URLs.

Closing the dialog preserves a completed upload and its filename because the
controller belongs to the workspace. Closing during an active attempt cancels it.
One completed document occupies the workspace slot and prevents another upload.
Refresh or remount clears this in-memory state and permits another selection.
Cancellation does not guarantee deletion of an object storage may already have
accepted, and refreshing does not delete stored objects. This is a browser
interaction limit, not a server-enforced session attachment guarantee.

An uploaded file is **not ready for questions**. This controller does not validate
PDF bytes, promote objects, start processing or persist server sessions. Existing
chat composition remains available without generating answers.

## Verified browser-to-Moto flow

The host-run setup and recorded result for a real headless Chromium upload are in
the [Moto setup guide](../infra/moto/README.md#browser-to-moto-upload-integration).
With Moto, Express, and Vite running, execute `cd backend && npm run test:integration`.
The browser test covers CORS-enabled transfer, a controlled storage failure and
fresh-authorization retry, cancellation, and confirms uploaded bytes match the
selected file in staging, with no ready-bucket object. It uses the installed AWS
SDK signing path; it does not establish AWS permission or signature enforcement.

Run the Vitest transport, controller and rendered workspace tests, plus frontend
checks, from this folder:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```
