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
- `src/App.tsx`: minimal starter screen; the PDF chat workspace is a later step.
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
The workspace interface will connect to these helpers in the next task.

Run the transport tests and frontend checks from this folder:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```
