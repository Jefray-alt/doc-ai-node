# Design

## Context

See [proposal.md](proposal.md) for motivation and scope. The backend has only `src/app.ts` and `src/server.ts`, with Express 5, Node.js 24, npm, ESM, strict TypeScript, and Oxlint. There is no automated backend test suite or frontend API integration. Development currently executes TypeScript directly through Node; production compiles to `dist/server.js`.

Nest introduces decorators and container-managed wiring, so this change includes compiler and startup configuration. It does not change the product's document-chat requirements; capability specs are intentionally skipped.

## Goals / Non-Goals

**Goals:** Establish conventional Nest module ownership and TypeScript testing before application features grow, preserve the current HTTP/environment contract, and keep development and production using the same decorator-capable compiler configuration. Prefer standard Nest ecosystem tooling; fewer dependencies is not a strict requirement.

**Non-Goals:** Build future feature modules, introduce a database or configuration service, generate unused services/DTOs, or add observability integrations, deployment infrastructure, or repository-wide tooling.

## Decisions

### 1. Nest application with the default Express adapter

`main.ts` creates the application through `NestFactory.create(AppModule)` and starts its listener. `AppModule` imports `HealthModule`; `HealthController` owns `GET /health` and returns the existing fixed JSON value. No service is needed for a static liveness response. Delete the superseded `app.ts` and `server.ts` rather than keeping two application entry points.

Fastify and hand-maintained Express architecture were considered. Express beneath Nest meets the agreed goal with the default adapter; manual conventions alone would keep architectural wiring in project code.

```text
backend/
  nest-cli.json
  package.json
  package-lock.json
  tsconfig.json
  tsconfig.build.json
  vitest.config.ts
  vitest.config.e2e.ts
  src/
    main.ts
    app.module.ts
    health/
      health.module.ts
      health.controller.ts
  test/
    app.e2e-spec.ts
    startup.e2e-spec.ts
    setup.ts
```

### 2. Document stable backend conventions in one place

Put the backend convention rules in `backend/README.md` and link to them from the root README. Each feature lives directly under `src/<feature>/` and owns its `.module.ts`, `.controller.ts`, needed `.service.ts` files, DTOs, and colocated TypeScript unit tests. Application HTTP/process integration tests use `.e2e-spec.ts` names under `backend/test/`.

Controllers handle routing and HTTP translation. Services own application logic and use constructor injection; feature dependencies are declared through module imports and explicit provider exports. Keep the root module for composition and `main.ts` for startup. Shared code needs an actual shared responsibility before it is extracted; avoid generic business-logic collections such as a growing `utils/` folder.

Use `.module.ts`, `.controller.ts`, `.service.ts`, `.dto.ts`, and `.spec.ts` suffixes for their corresponding roles. These are the default architecture throughout development. Changing them requires an explicit design discussion and a corresponding documentation update; Nest itself does not prevent arbitrary rearrangement. Do not add a custom architecture enforcement framework for this small foundation.

### 3. Compile decorators and retain the existing development interface

Use a backend-local Nest CLI and its TypeScript compiler for build and watch mode. Keep ESM/NodeNext, strict type checking, and Oxlint. Enable Nest's legacy decorator support and emitted decorator metadata, load `reflect-metadata`, and remove `erasableSyntaxOnly`. Use explicit `.js` relative import specifiers so the compiled ESM runs directly in Node. Exclude test files from production output and clear stale output when building, including the former `dist/server.js`.

Keep `npm run dev` for Nest watch mode, `npm run build` for compilation, `npm start` for directly executing `dist/main.js`, `npm run typecheck` for no-emit checking, and `npm run lint` for backend linting. Add `npm test` using Vitest for all populated suites and `npm run test:e2e` for the dedicated e2e configuration. The default config discovers both `src/**/*.spec.ts` and `test/**/*.e2e-spec.ts`, so the initial test command runs meaningful coverage without requiring a placeholder unit suite. The e2e config selects only `test/**/*.e2e-spec.ts`.

Type checking must cover production source, TypeScript tests, setup, and Vitest configuration. Let the base TypeScript configuration cover these files; keep `rootDir: "src"` and source-only inclusion in `tsconfig.build.json` so production still emits `dist/main.js` and excludes tests/configuration. Lint must cover source, tests, and TypeScript configuration files.

Select mutually compatible stable Nest runtime, CLI, and TypeScript versions during implementation and record them in the backend lockfile. Keep Nest runtime packages on the same major. The existing TypeScript 7 version is not a requirement: adjust the backend compiler version if the selected Nest CLI needs a supported version. Node.js remains on the 24 LTS line; a patch-level minimum may follow the selected CLI's engine requirements. Do not create a root package, Nest monorepo, or nested Git repository, and do not import optional starter integrations.

Keeping native TypeScript execution was rejected because Node's stripping does not compile Nest decorators. Retain the Nest CLI compiler for development/production; a dedicated Vitest transformation path is appropriate for the TypeScript test environment.

### 4. Load environment variables before starting Nest

Retain the current startup semantics using Node's built-in optional environment-file loading before application creation. In the compiled `main.ts`, `process.loadEnvFile()` may load the default `.env`; ignore only a missing-file error, and let other loading errors surface. Existing environment variables must retain precedence. This choice preserves the existing environment contract; it is not a dependency-count restriction on future use of `@nestjs/config`.

Both documented launch commands run from `backend/`, load its optional `.env`, and select `Number(process.env.PORT ?? 3000)`. This also permits `PORT=0` for isolated process tests. Do not introduce a global route prefix or new port-validation policy during this migration.

Retaining environment loading in two independent script wrappers was considered. Loading once at the application entry point gives development and production the same behavior and avoids relying on propagation of Node options through the watch CLI.

### 5. Use TypeScript, Vitest, Supertest, and Nest testing utilities

Use Vitest as the test runner, `@nestjs/testing` to create the Nest test application, and Supertest for HTTP assertions. Add backend-local development dependencies for those packages, `@types/supertest`, and the test transformation described below. Keep `@nestjs/testing` aligned with the Nest runtime major. Tests, setup, and configuration are TypeScript; do not use an `.mjs` suite or Node's test runner. The earlier native-runner alternative was rejected because it favored dependency minimization over the agreed Nest conventions.

`vitest.config.ts` owns the common Node test environment, setup, discovery, and decorator transformation. `vitest.config.e2e.ts` reuses that configuration and narrows discovery to e2e files. Use the Nest-documented SWC integration (`unplugin-swc` and `@swc/core`) to support TypeScript legacy decorators, emitted decorator metadata, and ESM. Load `reflect-metadata` through `test/setup.ts` before importing decorated classes. Verify that test-side module loading resolves the source's explicit `.js` relative imports to TypeScript files. Vitest transformation does not replace `npm run typecheck`.

`test/app.e2e-spec.ts` imports the actual `AppModule` into `Test.createTestingModule`, creates and initializes the Nest application, and uses Supertest against `app.getHttpServer()`. Cover `/health` status, JSON content type and exact body, plus unmatched-route 404 status. Always close the test application. Use Supertest's ESM default import. Do not recreate health routes in a test-only module or add a trivial controller unit test duplicating this coverage; future meaningful unit tests belong beside their feature classes.

`test/startup.e2e-spec.ts` also runs under Vitest, but builds the backend and launches the compiled `dist/main.js` in child processes. Check the emitted entry point, absence of stale entry points/test output, real HTTP health responses, default port 3000, shell-selected port, `.env`-selected port, shell-over-file precedence, and successful startup without `.env`. Supertest against an in-process Nest application cannot prove these process-level behaviors. Use temporary working directories for environment fixtures, isolate child environments, serialize fixed-port cases, bound startup waits, and always terminate children and clean fixtures. A default-port conflict must be reported rather than silently skipping the check. Do not edit or expose a developer's real `.env` file.

For TDD, keep the compiled entry-point contract as the initial failing assertion in the startup e2e test: the existing successful build emits `dist/server.js`, so assert that `dist/main.js` exists before attempting to import or spawn it. Start this test with only Vitest and Node API imports, so it can run against the existing Express package without importing missing Nest code. Before editing the package manifest, the selected compatible Vitest version can be invoked through standard `npm exec` using a test-only TypeScript configuration without project-package imports; once local tooling is installed, use the same focused Vitest invocation for GREEN. A missing dependency, config error, failed compilation, or changed health response is not RED. Add the Nest/Supertest suite and shared decorator setup as part of the same implementation task.

Development watch mode additionally needs a smoke check using `npm run dev`: request health, make a harmless temporary source edit, observe recompilation/restart, request health again, and restore the edit before final review. Verify development environment-file loading and precedence as well as compiled startup.

## Risks / Trade-offs

- More tooling to maintain -> Use standard Nest/Vitest/Supertest packages with compatible locked versions and documented commands; dependency minimization must not override the chosen conventions.
- Decorator/compiler/ESM incompatibility -> Check compatible package engines and compiler versions, run a clean install, and exercise the compiled entry point rather than relying on type checking alone.
- Different production and test transformation -> Enable compatible legacy decorator and metadata settings in TypeScript and the Vitest SWC integration; verify the actual Nest test module initializes and run type checking across tests/configuration.
- Stale Express build artifacts -> Clean production output on builds and remove both obsolete source entry points.
- Watch startup handles environment options differently -> Load the environment in `main.ts` and smoke-check the real development command.
- Architecture could still drift -> Record conventions in the backend README and review module ownership explicitly when later changes are proposed. Structural changes remain possible by deliberate agreement.
- Default 404 response shape may differ -> Preserve the status contract; accept the framework's normal error body because no existing client depends on its shape.

## Migration Plan

Implement the small foundation as one reviewed task and commit, including its tests and documentation. No data migration, endpoint transition, or frontend change is needed. Update `docs/plan/backend-setup.md` to describe the resulting Nest foundation while retaining the health/configuration guarantees; update only the backend progress statement in the roadmap and leave PDF/session work pending. The backend README owns the detailed conventions, so planning docs link to it instead of duplicating them.

After verification, use the existing commands to run the migrated backend. If rollback is needed, revert the migration commit deliberately and reinstall from the restored backend lockfile; no application data requires conversion. Planning completion does not start implementation, commit files, or deploy anything.

## References

- [Nest architecture and HTTP adapters](https://docs.nestjs.com/)
- [Official Nest TypeScript starter compiler configuration](https://github.com/nestjs/typescript-starter/blob/master/tsconfig.json)
- [Nest testing utilities and Supertest](https://docs.nestjs.com/fundamentals/testing)
- [Nest Vitest and SWC configuration](https://docs.nestjs.com/recipes/swc#vitest)
- [Node.js 24 TypeScript limitations](https://nodejs.org/docs/latest-v24.x/api/typescript.html#typescript-features)
- [Node.js 24 environment-file API](https://nodejs.org/docs/latest-v24.x/api/process.html#processloadenvfilepath)
