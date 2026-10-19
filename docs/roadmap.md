# Roadmap

This is a lightweight, outcome-oriented roadmap for a solo learning project. It has no date estimates. Future candidates remain subject to review after the MVP teaches us what is useful next.

## Current: Learn the single-PDF RAG flow

**Outcome:** A user can ask questions about one uploaded PDF and understand which pages and passages support each answer. The developer can trace how the document becomes retrieved evidence and then a response.

**Feature:** Single-PDF grounded chat with cited pages and source excerpts.

**Status:** MVP in progress. Frontend foundation and backlog feature 1, **Create the chat workspace**, are complete in `frontend/` using React, TypeScript, Vite, and Mantine. The workspace includes a conversation area, message composer, and an Add PDF entry point. Messages exist only in memory and are cleared on refresh. PDF upload, document processing, generated answers, and evidence remain unimplemented.

**Validation:** Type checking, linting, and the production build pass. Browser checks cover message submission, multiline and IME input, blank-message rejection, scrolling, PDF availability dialog and focus, refresh reset, and mobile layouts at 320px and 390px.

## Next

After the MVP feature is implemented, review the learning outcome and reprioritize the backlog. No next feature is selected yet.

## Later candidates

See [feature-backlog.md](feature-backlog.md). These are not roadmap commitments.
