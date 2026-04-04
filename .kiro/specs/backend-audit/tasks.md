# Implementation Plan: backend-audit

## Overview

Build a zero-dependency CLI audit tool at `audit/` that statically analyzes the SwiftPay codebase and produces a structured JSON report. Tasks are ordered so each step builds on the previous, ending with full wiring.

## Tasks

- [x] 1. Initialize project structure and install fast-check
  - Create the `audit/` directory with `audit/checkers/` and `audit/tests/` subdirectories
  - Add `fast-check` to devDependencies: `npm install --save-dev fast-check`
  - Create stub `package.json` scripts for running tests in `audit/tests/`
  - _Requirements: 13.1_

- [x] 2. Implement `audit/lib/scanner.js`
  - [x] 2.1 Write `buildFileIndex(targetDir)` using `glob` to discover all `src/**/*.js` files and named root-level files (`server.js`, `package.json`, `.env.example`, `.gitignore`, `docker-compose.yml`, `Dockerfile*`)
    - Read each file as UTF-8; return `{ sourceFiles: [{path, content}], rootFiles: {...} }`
    - Handle unreadable files with a warning and skip; handle zero `.js` files gracefully
    - _Requirements: 13.9, 13.10_
  - [ ]* 2.2 Write unit tests for `buildFileIndex`
    - Test with a temp directory containing known files; assert correct `sourceFiles` and `rootFiles` shape
    - Test missing root files return `null` in `rootFiles`
    - _Requirements: 13.9_

- [x] 3. Implement `audit/lib/reporter.js`
  - [x] 3.1 Write `buildReport(allFindings, meta)` that aggregates findings, computes score, sets `production_ready`, and builds the full `AuditReport` shape
    - Score formula: `round(passed / (passed + failed + critical * 2) * 100)`, default `0` when no checks
    - `production_ready`: `true` iff `score >= 60 && critical === 0`
    - Populate `domains`, `critical_vulnerabilities`, `suggested_fixes`, and `summary`
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_
  - [ ]* 3.2 Write property test — Property 2: Score Formula Invariant
    - **Property 2: score formula invariant**
    - **Validates: Requirements 13.2**
    - `// Feature: backend-audit, Property 2: score formula invariant`
  - [ ]* 3.3 Write property test — Property 3: Critical Findings Appear in critical_vulnerabilities
    - **Property 3: critical findings appear in critical_vulnerabilities**
    - **Validates: Requirements 13.4**
    - `// Feature: backend-audit, Property 3: critical findings appear in critical_vulnerabilities`
  - [ ]* 3.4 Write property test — Property 4: Failed Findings Appear in suggested_fixes
    - **Property 4: failed findings appear in suggested_fixes**
    - **Validates: Requirements 13.5**
    - `// Feature: backend-audit, Property 4: failed findings appear in suggested_fixes`
  - [ ]* 3.5 Write property test — Property 5: production_ready Consistency
    - **Property 5: production_ready consistency**
    - **Validates: Requirements 13.6, 13.7**
    - `// Feature: backend-audit, Property 5: production_ready consistency`
  - [ ]* 3.6 Write property test — Property 6: Summary Counts Match Domain Findings
    - **Property 6: summary counts match domain findings**
    - **Validates: Requirements 13.1, 13.3**
    - `// Feature: backend-audit, Property 6: summary counts match domain findings`
  - [ ]* 3.7 Write property test — Property 1: Audit Report JSON Round Trip
    - **Property 1: audit report JSON round trip**
    - **Validates: Requirements 13.11**
    - `// Feature: backend-audit, Property 1: audit report JSON round trip`

- [x] 4. Checkpoint — Ensure reporter and scanner tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement `audit/checkers/auth.js` (Requirement 1)
  - [x] 5.1 Write `check(fileIndex)` detecting: JWT vs PASETO usage, hardcoded secrets, missing `expiresIn`, TTL > 24h, bcrypt salt rounds, auth middleware coverage, admin role checks, logout token invalidation, stateless refresh tokens
    - Return `Finding[]` with appropriate `checkId` values (`AUTH-001` through `AUTH-011`)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11_
  - [ ]* 5.2 Write property test — Property 7: Hardcoded Secret Detection
    - **Property 7: hardcoded secret detection**
    - **Validates: Requirements 1.3, 1.4, 9.1**
    - `// Feature: backend-audit, Property 7: hardcoded secret detection`
  - [ ]* 5.3 Write unit tests for `auth.js` checker
    - Test each check with synthetic `FileIndex` fixtures (compliant and non-compliant)
    - _Requirements: 1.1–1.11_

- [x] 6. Implement `audit/checkers/input-validation.js` (Requirement 2)
  - [x] 6.1 Write `check(fileIndex)` detecting: missing schema validation on routes, absent `express-mongo-sanitize`, absent XSS middleware, absent `hpp`, missing body size limit, loose Zod typing on sensitive endpoints
    - Return `Finding[]` with `checkId` values `INP-001` through `INP-007`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
  - [ ]* 6.2 Write unit tests for `input-validation.js` checker
    - _Requirements: 2.1–2.7_

- [x] 7. Implement `audit/checkers/api-design.js` (Requirement 3)
  - [x] 7.1 Write `check(fileIndex)` detecting: absent `helmet`, wildcard CORS in production, missing 4-param error handler, missing 404 handler, unguarded async handlers, missing auth-endpoint rate limiting, missing global rate limiter, incorrect status codes, stack trace in error response
    - Return `Finding[]` with `checkId` values `API-001` through `API-009`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_
  - [ ]* 7.2 Write unit tests for `api-design.js` checker
    - _Requirements: 3.1–3.9_

- [x] 8. Implement `audit/checkers/mongodb.js` (Requirement 4)
  - [x] 8.1 Write `check(fileIndex)` detecting: models without field validation, missing unique indexes, password returned in queries, unbounded list queries, missing transactions for multi-doc writes, hardcoded connection string, missing pool settings
    - Return `Finding[]` with `checkId` values `MDB-001` through `MDB-007`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  - [ ]* 8.2 Write unit tests for `mongodb.js` checker
    - _Requirements: 4.1–4.7_

- [x] 9. Implement `audit/checkers/rabbitmq.js` (Requirement 5)
  - [x] 9.1 Write `check(fileIndex)` detecting: non-durable queues, non-persistent messages, auto-ack consumers, missing DLQ, missing retry limit, missing idempotency guard, missing reconnection logic, swallowed connection errors
    - Return `Finding[]` with `checkId` values `RMQ-001` through `RMQ-008`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_
  - [ ]* 9.2 Write unit tests for `rabbitmq.js` checker
    - _Requirements: 5.1–5.8_

- [x] 10. Implement `audit/checkers/socketio.js` (Requirement 6)
  - [x] 10.1 Write `check(fileIndex)` detecting: unauthenticated socket connections, mismatched auth secret, missing room isolation, missing disconnect cleanup, missing ping config, unvalidated socket payloads, wildcard CORS on Socket.IO
    - Return `Finding[]` with `checkId` values `SIO-001` through `SIO-007`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_
  - [ ]* 10.2 Write unit tests for `socketio.js` checker
    - _Requirements: 6.1–6.7_

- [x] 11. Implement `audit/checkers/logging.js` (Requirement 7)
  - [x] 11.1 Write `check(fileIndex)` detecting: console.log as primary logger, hardcoded log level, sensitive field logging, missing request logging, missing health endpoint, missing file transport with rotation
    - Return `Finding[]` with `checkId` values `LOG-001` through `LOG-006`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
  - [ ]* 11.2 Write unit tests for `logging.js` checker
    - _Requirements: 7.1–7.6_

- [x] 12. Implement `audit/checkers/error-handling.js` (Requirement 8)
  - [x] 12.1 Write `check(fileIndex)` detecting: missing `uncaughtException`/`unhandledRejection` handlers, incomplete graceful shutdown, stack trace in error response, fire-and-forget without `.catch()`, missing balance rollback, worker exits immediately on SIGTERM
    - Return `Finding[]` with `checkId` values `ERR-001` through `ERR-006`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - [ ]* 12.2 Write unit tests for `error-handling.js` checker
    - _Requirements: 8.1–8.6_

- [x] 13. Implement `audit/checkers/environment.js` (Requirement 9)
  - [x] 13.1 Write `check(fileIndex)` detecting: hardcoded secrets/connection strings, missing `.env.example`, `.env` not in `.gitignore`, missing startup env validation, `NODE_ENV` never referenced; record `passed` when `envalid`/joi env validation is present
    - Return `Finding[]` with `checkId` values `ENV-001` through `ENV-006`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
  - [ ]* 13.2 Write unit tests for `environment.js` checker
    - _Requirements: 9.1–9.6_

- [x] 14. Implement `audit/checkers/performance.js` (Requirement 10)
  - [x] 14.1 Write `check(fileIndex)` detecting: missing `compression` middleware, no Redis caching, synchronous blocking calls in request paths, missing indexes on high-cardinality fields, in-memory session storage, missing worker prefetch
    - Return `Finding[]` with `checkId` values `PERF-001` through `PERF-006`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
  - [ ]* 14.2 Write unit tests for `performance.js` checker
    - _Requirements: 10.1–10.6_

- [x] 15. Implement `audit/checkers/testing.js` (Requirement 11)
  - [x] 15.1 Write `check(fileIndex)` detecting: no test runner in devDependencies, missing `test` script, no test files found, no integration tests, live infrastructure in tests, missing auth flow test coverage
    - Parse `rootFiles.packageJson` with `JSON.parse` for devDependencies and scripts checks
    - Return `Finding[]` with `checkId` values `TEST-001` through `TEST-006`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_
  - [ ]* 15.2 Write unit tests for `testing.js` checker
    - _Requirements: 11.1–11.6_

- [x] 16. Implement `audit/checkers/devops.js` (Requirement 12)
  - [x] 16.1 Write `check(fileIndex)` detecting: missing Dockerfile, missing `docker-compose.yml`, missing ESLint config, missing Prettier config, missing CI/CD pipeline file, missing API docs, missing CHANGELOG, missing `engines` field in `package.json`
    - Return `Finding[]` with `checkId` values `OPS-001` through `OPS-008`
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_
  - [ ]* 16.2 Write unit tests for `devops.js` checker
    - _Requirements: 12.1–12.8_

- [x] 17. Implement `audit/checkers/critical-gaps.js` (Requirement 13.8)
  - [x] 17.1 Write `check(fileIndex)` explicitly checking for: missing CSRF protection on state-changing endpoints, absent request correlation IDs, missing `Content-Security-Policy` header config, absent secrets rotation documentation
    - Return `Finding[]` with `checkId` values `GAP-001` through `GAP-004`
    - _Requirements: 13.8_
  - [ ]* 17.2 Write unit tests for `critical-gaps.js` checker
    - _Requirements: 13.8_

- [x] 18. Checkpoint — Ensure all checker tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 19. Write property test — Property 8: Finding Schema Completeness
  - [x] 19.1 Write property test in `audit/tests/` that runs all checkers with arbitrary `FileIndex` inputs and asserts every returned finding has non-empty `domain`, `checkId`, `status`, `description` and a valid `status` enum value
    - **Property 8: finding schema completeness**
    - **Validates: Requirements 13.1**
    - `// Feature: backend-audit, Property 8: finding schema completeness`
    - _Requirements: 13.1_

- [x] 20. Implement `audit/index.js` — CLI entry point
  - [x] 20.1 Write `main(argv)` that parses `--target` and `--output` flags, invokes `buildFileIndex`, runs all 13 checkers in sequence (catching per-checker exceptions as synthetic `critical` findings), calls `buildReport`, writes JSON to the output path, and prints a summary line to stdout
    - Validate `--target` path exists; attempt `mkdirSync` for output directory; exit `0` on success, `1` on fatal error
    - _Requirements: 13.9, 13.10_
  - [x] 20.2 Wire all checkers: import all 13 checker modules and pass their results to `buildReport`
    - _Requirements: 13.1, 13.3, 13.4, 13.5_

- [x] 21. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkers are pure functions — no side effects, no I/O beyond receiving `FileIndex`
- Property tests use fast-check with a minimum of 100 iterations per property
- Unit tests use synthetic `FileIndex` fixtures, not the live codebase
