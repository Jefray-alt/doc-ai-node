# Feature Backlog

Priorities reflect the approved MVP and this project's learning goal. The first five items are build slices for the same MVP, ordered by dependency. Later items are candidates only; they are not approved scope changes.

## MVP: Single-PDF chat

| Priority | Feature | Outcome and boundary |
|---|---|---|
| 1 | Create the chat workspace | A user can start a session in a basic chat view with a conversation area, message input, and an entry point to add a PDF. This establishes the app's primary interaction; it does not include persistent accounts or chat history. |
| 2 | Attach one PDF to a session | A user can upload one PDF and see when it is ready for questions. A session has one document and one chat. |
| 3 | Prepare the PDF for search | The application extracts document text while retaining page references and makes relevant passages retrievable. This is the document-ingestion part of the learning path. |
| 4 | Ask questions in the session chat | A user can ask questions and receive answers based on passages retrieved from that session's PDF. Follow-up questions stay in the same chat and document context. |
| 5 | Show answer evidence and limitations | Answers show cited page numbers and supporting excerpts. When the PDF does not support an answer, the application says so instead of presenting an unsupported response. |

## Later candidates

These ideas can be reconsidered after the MVP; they are not commitments.

| Candidate | Rationale |
|---|---|
| Inspect retrieved passages | Helps the developer see and debug what the retrieval step selected. |
| Evaluate answer grounding with a small question set | Helps compare retrieval and answer quality as the RAG flow changes. |
| Save and revisit sessions | Adds convenience but is not needed for the one-session learning goal. |
| Support multiple documents or additional file types | Broadens use but adds ingestion complexity beyond the MVP. |
