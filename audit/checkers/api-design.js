'use strict';

const DOMAIN = 'API_Design';

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {Array}
 */
function check(fileIndex) {
  const findings = [];
  const allContent = fileIndex.sourceFiles.map(f => f.content).join('\n');

  // API-001: helmet registered
  const hasHelmet = /helmet\s*\(\s*\)/.test(allContent) || /app\.use\s*\(\s*helmet/.test(allContent);
  if (hasHelmet) {
    findings.push({
      domain: DOMAIN, checkId: 'API-001', status: 'passed',
      description: 'helmet is registered as global middleware.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'API-001', status: 'critical',
      description: 'helmet security headers middleware is not registered.',
      remediation: 'Install helmet and register it globally: app.use(helmet())',
    });
  }

  // API-002: CORS not wildcard in production
  const corsWildcard = /cors\s*\(\s*\{[^}]*origin\s*:[^}]*['"]\*['"]/.test(allContent) ||
    /origin\s*:\s*['"]\*['"]/.test(allContent) ||
    /\|\|\s*['"]\*['"]/.test(allContent);
  if (corsWildcard) {
    findings.push({
      domain: DOMAIN, checkId: 'API-002', status: 'failed',
      description: 'CORS origin has a wildcard ("*") fallback. In production this allows any origin.',
      remediation: 'Set an explicit CORS origin without a wildcard fallback. Use an allowlist of trusted origins.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'API-002', status: 'passed',
      description: 'CORS is configured with an explicit origin (no wildcard fallback).',
      remediation: '',
    });
  }

  // API-003: 4-param error handler (err, req, res, next)
  const hasErrorHandler = /\(\s*err\s*,\s*req\s*,\s*res\s*,\s*next\s*\)/.test(allContent);
  if (hasErrorHandler) {
    findings.push({
      domain: DOMAIN, checkId: 'API-003', status: 'passed',
      description: 'Centralized error-handling middleware with 4 parameters (err, req, res, next) is registered.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'API-003', status: 'critical',
      description: 'No centralized error-handling middleware with 4 parameters (err, req, res, next) found.',
      remediation: 'Add a global error handler: app.use((err, req, res, next) => { ... })',
    });
  }

  // API-004: 404 handler
  const has404Handler = /notFoundHandler|404|route not found/i.test(allContent);
  if (has404Handler) {
    findings.push({
      domain: DOMAIN, checkId: 'API-004', status: 'passed',
      description: '404 handler is registered after all routes.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'API-004', status: 'failed',
      description: 'No 404 handler detected after all routes.',
      remediation: 'Register a 404 handler after all routes: app.use((req, res) => res.status(404).json(...))',
    });
  }

  // API-005: Async handlers wrapped in try/catch or async wrapper
  const controllerFiles = fileIndex.sourceFiles.filter(f => f.path.includes('/controllers/'));
  const asyncHandlersWithoutTryCatch = controllerFiles.filter(f => {
    const hasAsync = /async\s+\w+\s*\(/.test(f.content) || /async\s*\(/.test(f.content);
    const hasTryCatch = /try\s*\{/.test(f.content);
    const hasAsyncWrapper = /asyncHandler|catchAsync|wrapAsync/.test(f.content);
    return hasAsync && !hasTryCatch && !hasAsyncWrapper;
  });
  if (asyncHandlersWithoutTryCatch.length > 0) {
    findings.push({
      domain: DOMAIN, checkId: 'API-005', status: 'failed',
      description: `${asyncHandlersWithoutTryCatch.length} controller file(s) have async handlers without try/catch or async wrapper.`,
      remediation: 'Wrap all async route handlers in try/catch or use an asyncHandler wrapper.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'API-005', status: 'passed',
      description: 'All async route handlers appear to be wrapped in try/catch or an async wrapper.',
      remediation: '',
    });
  }

  // API-006: Rate limiting on auth endpoints
  const hasAuthRateLimiting = /registerLimiter|loginLimiter|forgotPasswordLimiter|verifyOtpLimiter/.test(allContent);
  if (hasAuthRateLimiting) {
    findings.push({
      domain: DOMAIN, checkId: 'API-006', status: 'passed',
      description: 'Rate limiting middleware is applied to authentication endpoints.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'API-006', status: 'critical',
      description: 'Rate limiting is not applied to authentication endpoints (register, login, forgot-password, verify-otp).',
      remediation: 'Apply rate limiting middleware to all auth endpoints to prevent brute force attacks.',
    });
  }

  // API-007: Global rate limiter
  const hasGlobalLimiter = /globalLimiter|global.*limiter|app\.use.*limiter/i.test(allContent);
  if (hasGlobalLimiter) {
    findings.push({
      domain: DOMAIN, checkId: 'API-007', status: 'passed',
      description: 'A global rate limiter is applied to all routes.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'API-007', status: 'failed',
      description: 'No global rate limiter detected.',
      remediation: 'Apply a global rate limiter to all routes: app.use(globalLimiter)',
    });
  }

  // API-008: Correct HTTP status codes (not always 200)
  const controllerContents = controllerFiles.map(f => f.content).join('\n');
  const onlyStatus200 = controllerFiles.length > 0 &&
    !/(res\.status\s*\(\s*201\s*\)|res\.status\s*\(\s*401\s*\)|res\.status\s*\(\s*403\s*\)|res\.status\s*\(\s*404\s*\)|res\.status\s*\(\s*400\s*\))/.test(controllerContents);
  if (onlyStatus200) {
    findings.push({
      domain: DOMAIN, checkId: 'API-008', status: 'failed',
      description: 'Controllers do not appear to use semantically correct HTTP status codes (201, 400, 401, 403, 404).',
      remediation: 'Use appropriate HTTP status codes: 201 for creation, 400 for bad request, 401 for unauthenticated, 403 for forbidden, 404 for not found.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'API-008', status: 'passed',
      description: 'Controllers use semantically correct HTTP status codes.',
      remediation: '',
    });
  }

  // API-009: Stack traces not in production error responses
  const errorHandlerFiles = fileIndex.sourceFiles.filter(f =>
    f.path.includes('error') || f.path.includes('middleware')
  );
  const errorHandlerContent = errorHandlerFiles.map(f => f.content).join('\n');
  const stackConditional = /NODE_ENV.*development.*stack|stack.*NODE_ENV.*development/i.test(errorHandlerContent) ||
    /process\.env\.NODE_ENV\s*===\s*['"]development['"].*stack/i.test(errorHandlerContent);
  const stackUnconditional = /stack\s*:\s*err\.stack/.test(errorHandlerContent) && !stackConditional;
  if (stackUnconditional) {
    findings.push({
      domain: DOMAIN, checkId: 'API-009', status: 'critical',
      description: 'Error handler includes err.stack in the response body unconditionally.',
      remediation: 'Only include stack traces in development: ...(process.env.NODE_ENV === "development" && { stack: err.stack })',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'API-009', status: 'passed',
      description: 'Stack traces are conditionally excluded from error responses in production.',
      remediation: '',
    });
  }

  return findings;
}

module.exports = { check };
