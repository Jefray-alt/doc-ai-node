# Frontend

React + TypeScript SPA built with Vite and Mantine. This folder owns its
`.nvmrc`, `package.json`, `package-lock.json`, and `node_modules/`. From this folder, run:

```sh
nvm use # If you use nvm
npm ci
npm run dev
```

See the [root README](../README.md) for the available development and build commands.

- `src/main.tsx`: React entry point, Mantine provider, and global styles.
- `src/App.tsx`: composes the chat workspace.
- `postcss.config.cjs`: Mantine CSS features and responsive breakpoint variables.

Use [Mantine](https://mantine.dev/) components and hooks as the UI foundation.
[Mantine UI](https://ui.mantine.dev/) provides component source to copy and adapt
when needed; the website repository is not an application dependency.

## Unit tests

Run these commands from `frontend/`:

```sh
npm test             # Run the full suite once
npm run test:watch   # Watch tests during development
npm test -- src/components/MessageComposer/MessageComposer.test.tsx
```

Tests use Vitest, jsdom, and React Testing Library. Colocate each test with its
subject: `ComponentName.test.tsx` or `useHookName.test.ts` (use `.tsx` when a hook
test needs JSX). Shared setup and the Mantine render wrapper live in `src/test/`.
Import `render` from `src/test/render` for Mantine components, and import Vitest
functions explicitly. Tests and helpers are included in `npm run typecheck`.
Each component's tests exercise that component in isolation; mock nested app
components and test each child in its own colocated file.

Prefer accessible role and label queries for controls. Use stable, descriptive,
kebab-case `data-testid` attributes for structural targets when useful. Message
articles expose `data-testid="chat-message"`; scope `getAllByTestId` to the
conversation log to check their order. Use user-event for ordinary interactions
and targeted DOM events for IME cases. The suite checks behavior rather than
snapshots or CSS; jsdom scroll tests use controlled dimensions, not real layout.

For production, serve `dist/` as static files. Configure the host to fall back to
`index.html` for client-side routes if routing is added.
