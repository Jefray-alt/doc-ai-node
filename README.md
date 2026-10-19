# Document Chat

A single-PDF chat application for learning the RAG flow. Product scope lives in
[docs/product-brief.md](docs/product-brief.md).

## Repository

This monorepo keeps Node configuration, package manifests, lockfiles, and
dependencies inside each application, in `frontend/` and `backend/`.

- `frontend/`: React + TypeScript SPA using Vite and Mantine.
- `backend/`: Express + TypeScript REST API with a health endpoint.
- `docs/`: product brief, feature backlog, and roadmap.

## Development

Use Node.js 24 LTS and npm. Run each application in its own terminal.

### Frontend

From the repository root:

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

Run frontend npm commands from `frontend/`. `build` produces `frontend/dist/`.
`preview` serves that production build locally.
To pass arguments to Vite, use `npm run dev -- --host 0.0.0.0`.

The chat workspace supports sending messages with the Send button or Enter.
Use Shift + Enter for a new line. Messages stay in memory for the current tab and
are cleared when you refresh or close it; there are no accounts or saved chats.

The Add PDF entry point currently opens an availability notice. PDF upload,
document processing, and generated answers belong to later backlog features.

### Backend

From the repository root:

```sh
cd backend
nvm use # If you use nvm
npm ci
npm run dev
```

Check the API with `curl http://localhost:3000/health`. It returns
`{"status":"ok"}`. Set `PORT` in the environment or copy `backend/.env.example`
to `backend/.env` to change the port.

Run `npm run typecheck`, `npm run lint`, and `npm run build` from `backend/`.
Then use `npm start` to run the compiled API. See [backend/README.md](backend/README.md).

PDF upload, generated answers, and frontend/backend integration remain to be
implemented.
