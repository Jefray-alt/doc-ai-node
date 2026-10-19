# Backend API

Express + TypeScript foundation for the single-PDF chat application. All backend
Node tooling and dependencies live in this directory.

## Development

Use Node.js 24 LTS and npm. From the repository root:

```sh
cd backend
nvm use # If you use nvm
npm ci
npm run dev
```

The API listens on port 3000 by default. Optionally copy `.env.example` to `.env`
and change `PORT`. Both `dev` and `start` load this file when present; an existing
shell environment variable takes precedence.

Development uses Node's native TypeScript support and restarts on source changes.
Run type checking separately:

```sh
npm run typecheck
npm run lint
npm run build
npm start
```

`build` compiles `src/` to JavaScript in `dist/`. `start` runs that compiled build.

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
