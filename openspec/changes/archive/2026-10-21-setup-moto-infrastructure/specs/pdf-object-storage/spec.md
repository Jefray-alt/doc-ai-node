# Spec Delta

## Purpose

Provide repeatable local S3 storage for untrusted PDF uploads and documents admitted for processing, with browser-origin configuration and clearly documented limits on local permission verification.

## ADDED Requirements

### Requirement: Repeatable local startup

The local storage startup procedure SHALL expose a documented loopback endpoint and report service readiness separately from bucket provisioning. It MUST run without real AWS credentials, a cloud account, or a paid emulator subscription.

#### Scenario: First startup
- **WHEN** a developer follows the documented startup procedure
- **THEN** the emulator becomes reachable and bucket provisioning completes successfully using dummy local credentials
- **AND** readiness and provisioning success can each be checked

### Requirement: Disposable local storage

Local storage SHALL be treated as disposable across emulator process restarts. The startup procedure MUST recreate the required buckets and configuration in a fresh instance without requiring previous uploads or metadata.

#### Scenario: Fresh instance after restart
- **WHEN** the emulator process has been restarted and the startup procedure is rerun
- **THEN** the required buckets and configuration are available again
- **AND** instructions explain that previous uploads must be supplied again and are not restored

### Requirement: Staging and ready bucket configuration

The environment SHALL provide `pdf-staging` and `pdf-ready` with private ACL configuration, all bucket public-access-block flags enabled, and no public bucket-policy grants. Both MUST start without versioning, object lock, automatic expiration, or notification targets. Configuration checks MUST NOT be described as full AWS permission enforcement.

#### Scenario: Provisioned bucket configuration
- **WHEN** bootstrap completes against fresh storage
- **THEN** both buckets exist and their reported access configuration matches the declaration
- **AND** no automatic validation, promotion, expiration, or notification behavior is installed

### Requirement: Basic storage operations

Local storage SHALL support uploading to staging, reading and listing staging contents, copying an object into ready storage, reading the destination, and deleting the staging source through S3 APIs.

#### Scenario: Manual storage flow
- **WHEN** a smoke check uploads a fixture to staging, lists and reads it, copies it to ready, reads the destination, and deletes the source
- **THEN** the destination bytes match the original and the source is absent
- **AND** no automatic PDF validation or promotion is implied

### Requirement: Separate AWS access policy definitions

The infrastructure SHALL include separate AWS identity-policy definitions for upload signing and backend access. Upload signing MUST grant only staging writes and bucket location discovery. Backend access MUST grant staging list/read/delete, ready read/write, and location discovery. Neither definition SHALL grant administration, staging writes to the backend, ready deletion, or unrelated-bucket access.

#### Scenario: Policy review
- **WHEN** the delivered policy definitions are inspected
- **THEN** bucket actions and object actions target the appropriate exact bucket and object resources
- **AND** no broader permissions are granted
- **AND** documentation identifies these as definitions awaiting AWS enforcement verification

### Requirement: Bucket-specific browser-origin configuration

The staging bucket SHALL allow upload CORS requests from the configured frontend origin, defaulting to `http://localhost:5173`, and expose the uploaded object's ETag. Global wildcard CORS MUST be disabled. Unconfigured origins MUST NOT receive an origin allowance. Ready storage SHALL have no browser CORS grant in this slice.

#### Scenario: Configured origin
- **WHEN** a browser sends an upload preflight from the configured origin
- **THEN** the response permits the configured upload method and headers and exposes ETag on the upload response

#### Scenario: Unconfigured origin
- **WHEN** a browser sends a preflight from another origin
- **THEN** the response does not grant cross-origin access to that origin

### Requirement: Safe repeatable bootstrap

Bootstrap SHALL reapply bucket configuration without deleting existing objects in a running instance. Failures MUST produce a nonzero bootstrap result and an actionable error. Local tooling MUST target the emulator explicitly and MUST NOT fall back to AWS endpoints or real credential profiles.

#### Scenario: Bootstrap rerun
- **GIVEN** the running emulator contains a fixture object
- **WHEN** bootstrap is rerun with the same configuration
- **THEN** it succeeds and preserves that object

#### Scenario: Bootstrap failure
- **WHEN** the emulator is unreachable or a required configuration operation fails
- **THEN** bootstrap exits unsuccessfully within a bounded wait
- **AND** it does not continue against an AWS endpoint

### Requirement: Document verification and retention limits

Local setup instructions SHALL document startup, endpoints, dummy credentials, reset/restart behavior, and functional checks. They MUST explain Moto's partial authorization emulation, the need for later AWS permission/signature verification, and that the one-hour staging retention target remains unenforced.

#### Scenario: Developer reads setup instructions
- **WHEN** a developer follows the local setup guide
- **THEN** they can start and check storage and understand that uploads are disposable
- **AND** they can distinguish local functional checks from future AWS security verification and cleanup work
