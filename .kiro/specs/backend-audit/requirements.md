# Requirements Document

## Introduction

This feature defines an automated backend security and production-readiness audit tool for the SwiftPay Node.js/Express/MongoDB/RabbitMQ/Socket.IO application. The Audit_Tool statically analyzes the codebase, inspects configuration, and produces a structured Audit_Report covering 13 security and quality domains. The report classifies each finding as passed, failed, or critical, assigns a production-readiness score (0–100), and provides actionable remediation guidance.

The audit is triggered on demand (CLI or API call), reads source files from the project root, and writes the Audit_Report to a configurable output path. It does not modify any source files.

## Glossary

- **Audit_Tool**: The automated analysis program defined by this specification.
- **Audit_Report**: The structured JSON/HTML document produced by the Audit_Tool containing all findings.
- **Finding**: A single check result with a status (passed | failed | critical), a description, and optional remediation advice.
- **Domain**: One of the 13 top-level audit categories (e.g., Authentication, Input_Validation).
- **Production_Readiness_Score**: An integer 0–100 derived from the weighted sum of passed checks across all domains.
- **Target_Codebase**: The Node.js/Express project directory being audited.
- **Config_File**: The `.env` or environment configuration file(s) present in the Target_Codebase.
- **Auth_Middleware**: The Express middleware responsible for verifying tokens and attaching user context to requests.
- **Token**: A PASETO or JWT credential used for authentication.
- **DLQ**: Dead-Letter Queue — a RabbitMQ queue that receives messages that could not be processed after exhausting retries.
- **RBAC**: Role-Based Access Control — restricting system access based on user roles.
- **ABAC**: Attribute-Based Access Control — restricting access based on user and resource attributes.
- **TTL**: Time-To-Live — the maximum lifetime of a token or cached value.
- **Round_Trip**: The property that parsing a value and then serializing it (or vice versa) produces an equivalent result.

---

## Requirements

### Requirement 1: Authentication & Token Security Audit

**User Story:** As a security engineer, I want the Audit_Tool to verify that authentication is implemented correctly, so that I can confirm tokens cannot be forged, replayed, or misused.

#### Acceptance Criteria

1. THE Audit_Tool SHALL detect whether the codebase uses JWT (`jsonwebtoken`) or PASETO (`paseto`) for token issuance and record the library name and version in the Audit_Report.
2. WHEN the Audit_Tool detects JWT usage, THE Audit_Tool SHALL flag a Finding of status `failed` noting that PASETO (v4.local or v4.public) is the recommended standard and JWT is in use.
3. THE Audit_Tool SHALL scan all source files for hardcoded token secrets (string literals matching patterns such as `ACCESS_SECRET`, `REFRESH_SECRET`, `VERIFY_SECRET` assigned to non-environment-variable values) and, IF any are found, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
4. THE Audit_Tool SHALL verify that token signing secrets are read exclusively from environment variables (e.g., `process.env.*`) and, IF any secret is assigned a literal string value in source code, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
5. THE Audit_Tool SHALL inspect token generation calls and verify that an `expiresIn` option is set; IF any token is generated without an expiry, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
6. THE Audit_Tool SHALL verify that access token TTL is no longer than 24 hours; IF the TTL exceeds 24 hours (e.g., `"10d"`), THEN THE Audit_Tool SHALL record a Finding of status `failed` with a recommendation to reduce TTL to 15–60 minutes.
7. THE Audit_Tool SHALL verify that password hashing uses `bcrypt` or `argon2` with a salt-rounds value of at least 10; IF the salt-rounds value is below 10 or a weaker algorithm is used, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
8. THE Audit_Tool SHALL verify that the Auth_Middleware is applied to all non-public routes by checking that every router file either imports and applies `isAuthenticated` or is explicitly listed as a public route; IF any private route lacks the Auth_Middleware, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
9. THE Audit_Tool SHALL verify that at least one role-check middleware (e.g., `adminOnly`) exists and is applied to admin-scoped routes; IF admin routes lack role enforcement, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
10. THE Audit_Tool SHALL verify that logout invalidates the Token by deleting it from the session store (Redis); IF logout does not remove the Token from the store, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
11. THE Audit_Tool SHALL verify that refresh tokens are stored server-side and validated against the store on use; IF refresh tokens are stateless with no server-side validation, THEN THE Audit_Tool SHALL record a Finding of status `failed`.

---

### Requirement 2: Input Validation & Sanitization Audit

**User Story:** As a security engineer, I want the Audit_Tool to verify that all incoming data is validated and sanitized, so that injection attacks and malformed inputs cannot reach business logic.

#### Acceptance Criteria

1. THE Audit_Tool SHALL verify that every route handler that accepts a request body, query parameters, or path parameters applies a schema validation middleware (Joi, Zod, Yup, or equivalent) before the controller function.
2. WHEN the Audit_Tool finds a route handler that accepts user input without schema validation, THE Audit_Tool SHALL record a Finding of status `failed` identifying the route path and HTTP method.
3. THE Audit_Tool SHALL verify that `express-mongo-sanitize` or an equivalent NoSQL injection prevention library is registered as global middleware; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
4. THE Audit_Tool SHALL verify that an XSS sanitization middleware (e.g., the `xss` package) is applied globally to `req.body`, `req.query`, and `req.params`; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
5. THE Audit_Tool SHALL verify that HTTP parameter pollution protection (e.g., `hpp`) is registered as global middleware; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
6. THE Audit_Tool SHALL verify that request body size is limited (e.g., `express.json({ limit: "10kb" })`); IF no body size limit is configured, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
7. THE Audit_Tool SHALL verify that Zod or equivalent schemas enforce strict data types (no `z.any()` or untyped fields on sensitive inputs); IF loose typing is detected on authentication or financial endpoints, THEN THE Audit_Tool SHALL record a Finding of status `failed`.

---

### Requirement 3: API Design & Express Best Practices Audit

**User Story:** As a backend engineer, I want the Audit_Tool to verify that the Express API follows RESTful conventions and security best practices, so that the API is predictable, secure, and maintainable.

#### Acceptance Criteria

1. THE Audit_Tool SHALL verify that `helmet` is registered as global middleware; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
2. THE Audit_Tool SHALL verify that `cors` is configured with an explicit `origin` value (not `"*"` in production); IF `origin` is set to `"*"` and `NODE_ENV` is `production`, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
3. THE Audit_Tool SHALL verify that a centralized error-handling middleware with four parameters `(err, req, res, next)` is registered after all routes; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
4. THE Audit_Tool SHALL verify that a 404 handler is registered after all routes and before the error handler; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
5. THE Audit_Tool SHALL verify that all route handlers are wrapped in try/catch or use an async error wrapper so that unhandled promise rejections cannot bypass the error handler; IF any async route handler lacks error handling, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
6. THE Audit_Tool SHALL verify that rate limiting middleware is applied to authentication endpoints (register, login, forgot-password, verify-otp); IF any of these endpoints lack rate limiting, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
7. THE Audit_Tool SHALL verify that a global rate limiter is applied to all routes; IF no global rate limiter is present, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
8. THE Audit_Tool SHALL verify that HTTP response status codes are semantically correct (e.g., 201 for resource creation, 401 for unauthenticated, 403 for unauthorized, 404 for not found); IF a controller consistently returns 200 for all responses including errors, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
9. THE Audit_Tool SHALL verify that stack traces are not included in error responses when `NODE_ENV` is `production`; IF the error handler includes `stack` in the response body unconditionally, THEN THE Audit_Tool SHALL record a Finding of status `critical`.

---

### Requirement 4: MongoDB & Data Layer Audit

**User Story:** As a backend engineer, I want the Audit_Tool to verify that the MongoDB data layer is secure and performant, so that data integrity is maintained and queries cannot be exploited.

#### Acceptance Criteria

1. THE Audit_Tool SHALL verify that all Mongoose models define field-level validation (required, type, enum, minlength, etc.); IF a model has fields with no validation constraints, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
2. THE Audit_Tool SHALL verify that unique fields (e.g., `email`) have a `unique: true` index defined in the schema; IF a field that should be unique lacks the index, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
3. THE Audit_Tool SHALL verify that query results for user-facing endpoints exclude sensitive fields (e.g., `password`, `__v`) using `.select("-password")` or equivalent projection; IF a query returns the password hash to the caller, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
4. THE Audit_Tool SHALL verify that list endpoints implement pagination (limit/skip or cursor-based) to prevent unbounded queries; IF a list endpoint fetches all documents without a limit, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
5. THE Audit_Tool SHALL verify that MongoDB transactions are used for multi-document write operations that must be atomic; IF a multi-document write sequence lacks a transaction, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
6. THE Audit_Tool SHALL verify that the MongoDB connection string is read from an environment variable and not hardcoded; IF a literal connection string is found in source code, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
7. THE Audit_Tool SHALL verify that connection pool settings (`maxPoolSize`, `serverSelectionTimeoutMS`) are explicitly configured; IF they are absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.

---

### Requirement 5: RabbitMQ Messaging Reliability Audit

**User Story:** As a backend engineer, I want the Audit_Tool to verify that RabbitMQ messaging is reliable and fault-tolerant, so that no payout messages are silently lost.

#### Acceptance Criteria

1. THE Audit_Tool SHALL verify that queues are declared with `durable: true`; IF any queue is declared without durability, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
2. THE Audit_Tool SHALL verify that messages are published with `persistent: true` (delivery mode 2); IF messages are published without persistence, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
3. THE Audit_Tool SHALL verify that the consumer uses manual acknowledgment (`noAck: false`) and calls `channel.ack(msg)` on success; IF `noAck: true` is used, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
4. THE Audit_Tool SHALL verify that a Dead-Letter Exchange and DLQ are configured for the main processing queue; IF no DLQ is configured, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
5. THE Audit_Tool SHALL verify that a retry mechanism with a maximum retry count is implemented; IF failed messages are nacked with `requeue: true` without a retry limit, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
6. THE Audit_Tool SHALL verify that the consumer checks for idempotency (e.g., skips already-completed transactions) before processing; IF no idempotency guard is present, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
7. THE Audit_Tool SHALL verify that the RabbitMQ connection implements a reconnection strategy with a maximum attempt limit; IF the connection has no reconnection logic, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
8. WHEN RabbitMQ is unavailable at startup, THE Audit_Tool SHALL verify that the application logs the error and exits gracefully rather than silently continuing; IF the application swallows the connection error, THEN THE Audit_Tool SHALL record a Finding of status `failed`.

---

### Requirement 6: Socket.IO Real-Time Layer Audit

**User Story:** As a security engineer, I want the Audit_Tool to verify that the Socket.IO layer is authenticated and protected against abuse, so that real-time events cannot be spoofed or flooded.

#### Acceptance Criteria

1. THE Audit_Tool SHALL verify that socket connections require authentication (token verification) before receiving or emitting application events; IF sockets can receive application events without authenticating, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
2. THE Audit_Tool SHALL verify that the socket authentication handler verifies the Token using the same secret as the HTTP Auth_Middleware; IF a different secret or no verification is used, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
3. THE Audit_Tool SHALL verify that each authenticated user is placed in an isolated room (e.g., `user:<userId>`) so that events are not broadcast to all connected clients; IF events are emitted to all sockets without room isolation, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
4. THE Audit_Tool SHALL verify that disconnect events are handled and the client map is cleaned up; IF disconnected sockets remain in the client map, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
5. THE Audit_Tool SHALL verify that `pingTimeout` and `pingInterval` are explicitly configured to detect stale connections; IF they are absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
6. THE Audit_Tool SHALL verify that incoming socket event payloads are validated before processing; IF socket event handlers accept arbitrary payloads without validation, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
7. THE Audit_Tool SHALL verify that the CORS `origin` for Socket.IO is not set to `"*"` in production; IF it is, THEN THE Audit_Tool SHALL record a Finding of status `failed`.

---

### Requirement 7: Logging & Monitoring Audit

**User Story:** As an operations engineer, I want the Audit_Tool to verify that logging is structured and safe, so that incidents can be diagnosed without exposing sensitive data.

#### Acceptance Criteria

1. THE Audit_Tool SHALL verify that a structured logging library (Winston or Pino) is used; IF `console.log` is the primary logging mechanism, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
2. THE Audit_Tool SHALL verify that the logger is configured with multiple log levels (info, warn, error) and that the active level is controlled by an environment variable; IF log level is hardcoded, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
3. THE Audit_Tool SHALL scan log call sites for patterns that may log sensitive fields (password, token, secret, apikey, authorization) without redaction; IF any such pattern is found, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
4. THE Audit_Tool SHALL verify that a request logging middleware (Morgan or equivalent) or per-request log entries are present; IF no request logging is configured, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
5. THE Audit_Tool SHALL verify that a `/health` or `/api/health` endpoint exists and returns a 200 status when all dependencies are healthy; IF no health endpoint is present, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
6. THE Audit_Tool SHALL verify that log files are written to a persistent directory and that file rotation is configured (maxsize, maxFiles); IF logs are written only to stdout with no file transport, THEN THE Audit_Tool SHALL record a Finding of status `failed`.

---

### Requirement 8: Error Handling & Fault Tolerance Audit

**User Story:** As a backend engineer, I want the Audit_Tool to verify that the application handles errors and external failures gracefully, so that partial failures do not corrupt state or crash the process.

#### Acceptance Criteria

1. THE Audit_Tool SHALL verify that `process.on("uncaughtException")` and `process.on("unhandledRejection")` handlers are registered in the entry point; IF either is absent, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
2. THE Audit_Tool SHALL verify that a graceful shutdown sequence closes all connections (database, Redis, RabbitMQ, HTTP server) in response to `SIGTERM` and `SIGINT`; IF any connection is not closed during shutdown, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
3. THE Audit_Tool SHALL verify that error responses in production do not include stack traces or internal file paths; IF the error handler exposes `err.stack` unconditionally, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
4. THE Audit_Tool SHALL verify that errors thrown by external service calls (RabbitMQ publish, Redis set, email send) are caught and do not propagate as unhandled rejections; IF fire-and-forget calls lack `.catch()` handlers, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
5. THE Audit_Tool SHALL verify that balance rollback logic is present in the worker for failed payout processing; IF no rollback is implemented, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
6. THE Audit_Tool SHALL verify that the worker implements a graceful shutdown that stops consuming new messages and waits for in-flight messages to complete before disconnecting; IF the worker exits immediately on SIGTERM, THEN THE Audit_Tool SHALL record a Finding of status `failed`.

---

### Requirement 9: Environment & Configuration Audit

**User Story:** As a DevOps engineer, I want the Audit_Tool to verify that configuration is externalized and validated, so that secrets never appear in the codebase and misconfiguration is caught at startup.

#### Acceptance Criteria

1. THE Audit_Tool SHALL scan all source files for string literals that match common secret patterns (JWT secrets, database passwords, API keys, connection strings with credentials); IF any are found, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
2. THE Audit_Tool SHALL verify that a `.env.example` file exists listing all required environment variables without their values; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
3. THE Audit_Tool SHALL verify that `.env` is listed in `.gitignore`; IF it is not, THEN THE Audit_Tool SHALL record a Finding of status `critical`.
4. THE Audit_Tool SHALL verify that required environment variables (`MONGO_URI`, `REDIS_HOST`, `RABBITMQ_URL`, `ACCESS_SECRET`, `REFRESH_SECRET`) are validated at startup (e.g., checked for existence before use); IF the application starts without validating required variables, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
5. THE Audit_Tool SHALL verify that `NODE_ENV` is set and used to differentiate behavior between development and production; IF `NODE_ENV` is never referenced in the codebase, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
6. WHERE a config service or validation library (e.g., `envalid`, `joi` for env) is used, THE Audit_Tool SHALL record a Finding of status `passed` for startup environment validation.

---

### Requirement 10: Performance & Scalability Audit

**User Story:** As a backend engineer, I want the Audit_Tool to verify that the application is ready for production load, so that it does not degrade under traffic.

#### Acceptance Criteria

1. THE Audit_Tool SHALL verify that response compression middleware (e.g., `compression`) is registered; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
2. THE Audit_Tool SHALL verify that Redis caching is used for frequently read data (e.g., user profiles, balance); IF no caching layer is present, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
3. THE Audit_Tool SHALL scan for synchronous blocking operations (e.g., `fs.readFileSync`, `crypto.pbkdf2Sync`) in request-handling code paths; IF any are found, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
4. THE Audit_Tool SHALL verify that MongoDB queries on high-cardinality fields used in filters (e.g., `userId`, `email`, `transactionId`) have corresponding index definitions in the schema; IF a frequently queried field lacks an index, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
5. THE Audit_Tool SHALL verify that the application does not store session state in process memory (i.e., sessions are stored in Redis or a database); IF in-memory session storage is detected, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
6. THE Audit_Tool SHALL verify that the worker uses a `prefetch` count to limit concurrent message processing; IF no prefetch is configured, THEN THE Audit_Tool SHALL record a Finding of status `failed`.

---

### Requirement 11: Testing Coverage Audit

**User Story:** As a quality engineer, I want the Audit_Tool to verify that the codebase has adequate test coverage, so that regressions are caught before deployment.

#### Acceptance Criteria

1. THE Audit_Tool SHALL verify that a test runner (Jest, Mocha, Vitest, or equivalent) is listed in `package.json` devDependencies; IF no test runner is present, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
2. THE Audit_Tool SHALL verify that a `test` script is defined in `package.json`; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
3. THE Audit_Tool SHALL verify that test files exist for service modules (files matching `*.test.js`, `*.spec.js`, or located in a `__tests__` directory); IF no test files are found, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
4. THE Audit_Tool SHALL verify that integration test files exist that cover at least one API endpoint with a real or mocked database; IF only unit tests are present with no integration tests, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
5. THE Audit_Tool SHALL verify that external dependencies (RabbitMQ, MongoDB, Redis) are mocked or use in-memory alternatives in unit tests; IF tests connect to live infrastructure, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
6. THE Audit_Tool SHALL verify that authentication flows (register, login, token refresh, logout) are covered by at least one test each; IF any auth flow lacks a test, THEN THE Audit_Tool SHALL record a Finding of status `failed`.

---

### Requirement 12: DevOps & Deployment Readiness Audit

**User Story:** As a DevOps engineer, I want the Audit_Tool to verify that the project is ready for containerized deployment with a CI/CD pipeline, so that releases are automated and reproducible.

#### Acceptance Criteria

1. THE Audit_Tool SHALL verify that a `Dockerfile` or equivalent container definition exists for the API gateway service; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
2. THE Audit_Tool SHALL verify that a `docker-compose.yml` file exists defining all required services (Node.js, MongoDB, RabbitMQ, Redis); IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
3. THE Audit_Tool SHALL verify that ESLint or an equivalent linter is configured (`.eslintrc`, `eslint.config.js`, or `eslintConfig` in `package.json`); IF no linter is configured, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
4. THE Audit_Tool SHALL verify that Prettier or an equivalent formatter is configured; IF no formatter is configured, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
5. THE Audit_Tool SHALL verify that a CI/CD pipeline definition file exists (`.github/workflows/*.yml`, `.gitlab-ci.yml`, `Jenkinsfile`, or equivalent); IF none is found, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
6. THE Audit_Tool SHALL verify that an API documentation file exists (OpenAPI/Swagger `openapi.yaml`, `swagger.json`, or `swagger-jsdoc` configuration); IF no API documentation is present, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
7. THE Audit_Tool SHALL verify that a `CHANGELOG.md` or equivalent versioning artifact exists; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.
8. THE Audit_Tool SHALL verify that the `package.json` `engines` field specifies a minimum Node.js version; IF it is absent, THEN THE Audit_Tool SHALL record a Finding of status `failed`.

---

### Requirement 13: Critical Gap Detection & Scoring

**User Story:** As a security engineer, I want the Audit_Tool to identify missing controls and produce a production-readiness score, so that I can prioritize remediation work.

#### Acceptance Criteria

1. THE Audit_Tool SHALL aggregate all Findings across all 12 domains and classify each as `passed`, `failed`, or `critical`.
2. THE Audit_Tool SHALL compute the Production_Readiness_Score as an integer 0–100 using the formula: `score = round((passed_checks / total_checks) * 100)`, where `critical` findings count as 0 and reduce the score proportionally more than `failed` findings by applying a weight of 2 to each `critical` finding in the denominator.
3. THE Audit_Tool SHALL produce a summary section in the Audit_Report listing: total checks run, passed count, failed count, critical count, and the Production_Readiness_Score.
4. THE Audit_Tool SHALL produce a `critical_vulnerabilities` array in the Audit_Report containing all Findings with status `critical`, each with a `domain`, `description`, and `remediation` field.
5. THE Audit_Tool SHALL produce a `suggested_fixes` array in the Audit_Report containing all Findings with status `failed`, each with a `domain`, `description`, and `remediation` field.
6. WHEN the Production_Readiness_Score is below 60, THE Audit_Tool SHALL set a top-level `production_ready` field in the Audit_Report to `false`.
7. WHEN the Production_Readiness_Score is 60 or above and no `critical` Findings exist, THE Audit_Tool SHALL set `production_ready` to `true`.
8. THE Audit_Tool SHALL explicitly check for the following edge cases and record a Finding for each: missing CSRF protection on state-changing endpoints, absence of request correlation IDs for distributed tracing, missing `Content-Security-Policy` header configuration, and absence of secrets rotation documentation.
9. THE Audit_Tool SHALL output the Audit_Report as a valid JSON file to a path specified by the `--output` CLI flag (default: `./audit-report.json`).
10. THE Audit_Tool SHALL complete analysis of the Target_Codebase and produce the Audit_Report within 60 seconds for a project with up to 200 source files.
11. FOR ALL valid Target_Codebase inputs, parsing the produced Audit_Report JSON and re-serializing it SHALL produce an equivalent document (Round_Trip property).
