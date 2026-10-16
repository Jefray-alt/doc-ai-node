# Project Brief: AI Document Chat

Project Type: Personal learning project

Stage: MVP planning

Status: Draft

## 1. Project Overview

AI Document Chat is a lightweight web application that lets users upload a PDF and ask questions about its contents through a conversational AI interface.

Inspired by NotebookLM, the application helps users understand documents by retrieving relevant information and answering questions grounded in the uploaded material.

Each knowledge base contains exactly one PDF, and each chat session uses only one selected knowledge base. Users can create and revisit multiple knowledge bases, but the AI must never combine content from different documents in a single session.

## 2. Problem Statement

Finding specific information in a long PDF often requires repeated searching, skimming, and interpreting passages. AI Document Chat aims to make this easier by letting users ask natural-language questions and receive answers tied to the source document.

## 3. Project Goals

- Provide a simple upload-to-chat experience without accounts or setup steps.
- Let users create and return to saved knowledge bases.
- Answer questions using the selected PDF as the source of knowledge.
- Support conversational follow-up questions within a chat session.
- Show the PDF page numbers that support answers, where supporting passages are found.
- Clearly indicate when the document does not support an answer.

Learning objective: Build a working Retrieval-Augmented Generation (RAG) application and understand the user-facing flow from document upload to grounded question answering.

## 4. Core User Experience

### Step 1: Upload a PDF

The user uploads a text-based PDF. The application creates a knowledge base for it and shows whether it is processing, ready to use, or could not be processed.

Scanned or image-only PDFs are not supported in the MVP. The application should explain this limitation when a file has no usable extractable text.

### Step 2: Select a Knowledge Base

The user sees a list of previously uploaded knowledge bases and can choose one. Uploaded documents and their knowledge bases remain available after the user leaves and returns to the application.

### Step 3: Start a Chat

The user opens a chat for the selected knowledge base. Only that PDF is used to answer questions in the session.

### Step 4: Ask Questions and Follow Up

The user asks questions such as:

- “Can you summarize this document?”
- “What are the main findings?”
- “What does page 5 say about the proposed approach?”
- “Can you explain that in simpler terms?”

The AI responds using relevant information from the selected PDF and maintains enough conversation context to understand follow-up questions.

### Step 5: Check the Source

When the AI uses information from the PDF, its response includes the relevant page number(s), allowing the user to verify the answer in the original document. It must not invent a page reference or claim that unsupported information appears in the PDF.

### Step 6: Switch Documents

The user may select a different knowledge base and start a separate chat. Information from the previous PDF must not be used in the new session.

## 5. MVP Functional Requirements

### Document and Knowledge Base Management

- Accept PDF uploads with extractable text.
- Create one knowledge base per uploaded PDF, with a maximum of one PDF per knowledge base.
- Persist uploaded PDFs and knowledge bases so they can be accessed again later.
- Display existing knowledge bases for selection.
- Show processing, ready, and error states.
- Reject unsupported or unreadable PDFs with understandable feedback.

### Document Chat

- Allow the user to start a chat with one selected knowledge base.
- Answer questions based on the selected PDF, not other uploaded documents or external sources.
- Understand follow-up questions using the current conversation context.
- Display the current session's messages.
- Include supporting PDF page references when answering from the document.
- Say when the document does not provide enough information to answer.

### User Interface

- Simple upload area.
- Knowledge base list and selection.
- Chat interface for the selected document.
- Clear loading, processing, and error messages.
- No authentication or user accounts.

## 6. MVP Boundaries

To keep the first version focused:

- A knowledge base can contain only one PDF.
- A chat session can use only one selected knowledge base.
- Only text-based PDFs are supported; there is no OCR for scanned documents.
- Answers use the selected document, not web search or general-purpose research across other sources.
- Knowledge bases are saved, but saving chat history across visits is not required.
- There is no registration, login, collaboration, or document sharing.

## 7. MVP Success Criteria

The MVP is successful when a user can:

1. Upload a text-based PDF and see whether processing succeeds.
2. Return to the application later and reopen the saved knowledge base.
3. Ask a question and get a useful answer grounded in that PDF.
4. See page references supporting the answer.
5. Ask a follow-up question that relies on the current conversation.
6. Receive a clear explanation when the document cannot support the answer.
7. Switch to another knowledge base without mixing content between documents.

## 8. Project Vision

Build a small, easy-to-use PDF question-answering application that demonstrates the essential user experience of document-grounded AI: upload a document, select it, ask questions, and verify answers against the source.
