# Product Brief: Single-PDF RAG Chat

## Vision

Turn a single PDF into a clear conversation—and a practical way to learn how AI finds answers in documents.

## Purpose

Build a small, useful document-chat application while learning how a retrieval-augmented generation (RAG) backend works end to end. The project should make the path from a document to retrieved evidence to an answer understandable to its builder.

## Audience

- **Primary:** The developer building the application to learn the fundamentals of RAG.
- **End user:** Someone who wants to ask questions about one PDF without searching through it manually.

## Problem

Finding specific information in a long PDF can be tedious. At the same time, RAG can feel abstract when its document processing and retrieval steps are hidden behind a finished product or framework.

## MVP

A user can:

1. Upload one PDF for a session.
2. Ask questions about that PDF in one chat for the session.
3. Receive answers grounded in the PDF, with cited page numbers and supporting source excerpts.

The implementation should remain small enough for the developer to understand the document-ingestion, retrieval, and answer-generation flow.

## Learning outcome

After building the MVP, the developer should be able to trace how PDF content becomes searchable evidence and how that evidence is used to produce a grounded answer.

## Out of scope for the MVP

- Multiple PDFs in one session or document libraries
- Non-PDF uploads
- Multiple chats per session
- Persistent user accounts or cross-session document storage

## Product principles

- **Clarity:** Make answers and their PDF evidence easy to understand.
- **Curiosity:** Keep the backend learning path visible and approachable to the builder.
- **Simplicity:** Keep the first version focused on one document and one conversation.
