# Roadmap

This is a lightweight, outcome-oriented roadmap for a solo learning project. It has no date estimates. Future candidates remain subject to review after the MVP teaches us what is useful next.

## Current: Learn the single-PDF RAG flow

**Outcome:** A user can ask questions about one uploaded PDF and understand which pages and passages support each answer. The developer can trace how the document becomes retrieved evidence and then a response.

**Feature:** Single-PDF grounded chat with cited pages and source excerpts.

**Status:** MVP in progress. Frontend foundation and backlog feature 1, **Create the chat workspace**, are complete in `frontend/` using React, TypeScript, Vite, and Mantine. The workspace includes a conversation area, message composer, and an Add PDF entry point. Messages and upload status exist only in memory and clear on refresh. Document processing, generated answers, and evidence remain unimplemented.

**Backend progress:** Backlog feature 2 now includes PDF authorization and direct upload into local quarantine storage. Session handling, PDF validation and processing, promotion to the ingestion bucket, and chat readiness remain pending. See [backend/README.md](../backend/README.md) for backend conventions.

**Local storage:** Persistent local Floci storage provides separate ingestion and quarantine buckets for feature 2. See [README local storage instructions](../README.md#local-s3-storage). Feature 2 remains in progress.

**Validation:** Colocated frontend unit tests isolate each component and hook, mocking nested app components. Coverage includes chat message rendering, workspace state and wiring, composer submission and keyboard/IME guards, conversation rendering and scrolling, and PDF upload behavior. Run them with `npm test` from `frontend/`, or use `npm run test:watch` during development. Type checking and linting pass. Existing browser checks cover message submission, multiline and IME input, blank-message rejection, scrolling, PDF upload dialog and focus, refresh reset, and mobile layouts at 320px and 390px.

## Next

After the MVP feature is implemented, review the learning outcome and reprioritize the backlog. No next feature is selected yet.

## Later candidates

See [feature-backlog.md](feature-backlog.md). These are not roadmap commitments.
