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
- `src/App.tsx`: minimal starter screen; the PDF chat workspace is a later step.
- `postcss.config.cjs`: Mantine CSS features and responsive breakpoint variables.

Use [Mantine](https://mantine.dev/) components and hooks as the UI foundation.
[Mantine UI](https://ui.mantine.dev/) provides component source to copy and adapt
when needed; the website repository is not an application dependency.

For production, serve `dist/` as static files. Configure the host to fall back to
`index.html` for client-side routes if routing is added.
