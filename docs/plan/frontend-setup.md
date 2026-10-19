# Frontend initialization

**Goal:** Initialize the requested React/Vite SPA in `frontend/` within a monorepo.

**Design:** Keep Node configuration, package manifests, dependencies, and lockfiles
inside each application. Run frontend commands from `frontend/`. Keep the frontend as an independent React +
TypeScript application, install Mantine core and hooks, and
configure Mantine styles, provider, and PostCSS. Mantine UI is the component source
reference for future screens. Add the backend package when backend work begins.

This is foundation work within the approved MVP. It does not implement the chat
workspace, upload, retrieval, or backend functionality.

## Tasks

- [x] Scaffold React + TypeScript with Vite and keep Node tooling inside `frontend/`.
- [x] Configure Mantine and replace demo assets with a minimal starter screen.
- [x] Verify a clean lockfile install, type checking, linting, production build,
  server rendering with MantineProvider, and Vite HTTP responses.
- [x] Document setup commands and record foundation status in the roadmap.

Browser visual verification was unavailable because this session has no connected
browser. No application behavior beyond the starter screen was added.
