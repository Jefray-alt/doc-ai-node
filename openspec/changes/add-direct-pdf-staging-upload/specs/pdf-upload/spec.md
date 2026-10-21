# PDF Upload Spec Delta

## Purpose

Let a user transfer one candidate PDF from the chat workspace into staging storage and understand upload progress without mistaking transfer completion for document readiness.

## ADDED Requirements

### Requirement: Candidate file checks

The browser and upload API SHALL accept only a nonempty filename ending in `.pdf` case-insensitively, a positive integer byte size no greater than 10 MiB, and a declared media type of `application/pdf` or empty. Empty media types SHALL be normalized to `application/pdf`. These checks MUST NOT be described as PDF content validation or storage-enforced size limits.

#### Scenario: Candidate PDF accepted
- **WHEN** the user selects one file whose declared metadata meets the candidate checks
- **THEN** the browser allows an upload authorization request
- **AND** an empty media type is treated as `application/pdf`

#### Scenario: Invalid metadata rejected
- **WHEN** either the browser selection or a direct API request has a missing filename, a different extension, an invalid size, or an unsupported media type
- **THEN** the invalid candidate is rejected with an actionable error
- **AND** the API does not issue an upload URL for invalid metadata

### Requirement: Scoped upload authorization

The API SHALL issue a five-minute presigned PUT authorization for one server-generated, unique staging object key. The client MUST NOT select the target bucket or object key. The response SHALL include the upload identifier, method, URL, required browser-settable headers, and expiration time. Credentials and signed URLs MUST NOT be logged by application code or exposed in user-facing errors.

#### Scenario: Valid authorization request
- **WHEN** the API receives valid candidate metadata
- **THEN** it returns an object-specific staging upload authorization with the required response fields
- **AND** the original filename does not determine the object key
- **AND** a subsequent authorization request receives a different key

#### Scenario: Signing failure
- **WHEN** the API cannot obtain signing credentials or generate the upload authorization
- **THEN** it returns a controlled error without a usable upload URL or secret diagnostic details
- **AND** the browser allows a fresh attempt

### Requirement: Direct staging transfer

The browser SHALL send the raw selected file directly to the returned URL using the returned method and required headers. Storage requests MUST NOT inherit backend authorization headers, cookies, URL prefixes, or request interceptors. Transfer completion SHALL be reported only after a successful storage HTTP response, not merely when progress reaches 100 percent.

#### Scenario: Successful browser transfer
- **WHEN** authorization succeeds and storage accepts the subsequent upload
- **THEN** the uploaded bytes match the selected file
- **AND** no PDF bytes pass through the upload authorization endpoint
- **AND** the browser reports upload completion after the storage response

#### Scenario: Storage rejects the transfer
- **WHEN** storage responds unsuccessfully or the transfer fails at the network layer
- **THEN** the browser reports failure without reporting upload success
- **AND** a user-triggered retry requests a fresh authorization

### Requirement: Single-file upload interaction

The workspace SHALL support one selected file and at most one active upload attempt. It SHALL expose requesting, uploading, uploaded, failed, and cancelled states, transfer progress when available, cancellation, and retry after failure or cancellation. A completed upload SHALL occupy the current workspace's single document slot until refresh. Refresh SHALL clear in-memory upload state without promising storage deletion.

#### Scenario: Progress and completion
- **WHEN** an upload is running
- **THEN** the workspace identifies the selected file and indicates progress or an indeterminate transfer
- **AND** duplicate submissions and additional file selections are unavailable
- **AND** successful completion prevents another upload in that workspace

#### Scenario: Cancellation and late responses
- **WHEN** the user cancels during authorization or transfer
- **THEN** the active browser request is aborted and the workspace reports cancellation
- **AND** late responses from that attempt cannot change the cancelled state or a later attempt
- **AND** cancellation does not claim that a stored object was deleted

### Requirement: Upload completion is distinct from readiness

Successful transfer SHALL be presented as uploaded with validation/processing not yet available. The interface MUST NOT claim that the PDF is validated, attached to a persisted server session, or ready for questions. Existing in-memory chat composition SHALL remain available without introducing generated answers.

#### Scenario: File reaches staging
- **WHEN** the storage upload succeeds
- **THEN** the workspace identifies the uploaded file and explains that it is not yet ready for questions
- **AND** the system does not promote the object to ready storage or start document processing

### Requirement: Environment-based storage targeting

The application SHALL use the same upload contract for local Moto and AWS S3. Local mode MUST require an explicit loopback endpoint and dummy credentials without falling back to AWS. AWS mode SHALL use regional endpoint resolution and deployment credentials. Signing MUST use the browser-reachable storage endpoint, and the signed URL MUST NOT be rewritten afterward.

#### Scenario: Local development
- **WHEN** local configuration is selected
- **THEN** signing targets `http://localhost:5000` with path-style addressing and dummy credentials
- **AND** invalid or missing local endpoint configuration prevents startup instead of selecting AWS

#### Scenario: AWS configuration
- **WHEN** AWS mode, region, and the deployed staging bucket name are configured
- **THEN** the application uses AWS endpoint resolution and deployment credentials with the same browser upload flow
- **AND** local endpoint overrides and dummy credentials are not injected
