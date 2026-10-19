# Document Chat

A single-PDF chat application for learning the RAG flow. Product scope lives in
[docs/product-brief.md](docs/product-brief.md).

## Repository

This monorepo keeps Node configuration, package manifests, lockfiles, and
dependencies inside each application. The frontend owns these files in
`frontend/`.

- `frontend/`: React + TypeScript SPA using Vite and Mantine.
- `docs/`: product brief, feature backlog, and roadmap.

The backend will be added in `backend/` with its own package and lockfile when
its implementation starts.

## Development

Use Node.js 24 LTS and npm. From the repository root:

```sh
cd frontend
nvm use # If you use nvm
npm ci
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`).

```sh
npm run typecheck
npm run lint
npm run build
npm run preview
```

Run all npm commands from `frontend/`. `build` produces `frontend/dist/`.
`preview` serves that production build locally.
To pass arguments to Vite, use `npm run dev -- --host 0.0.0.0`.

The initial screen only verifies the frontend foundation. PDF upload, chat, and
backend integration will be implemented in subsequent work.
