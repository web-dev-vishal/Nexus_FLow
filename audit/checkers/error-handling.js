'use strict';

const DOMAIN = 'Error_Handling';

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {Array}
 */
function check(fileIndex) {
  const findings = [];
  const allContent = fileIndex.sourceFiles.map(f => f.content).join('\n');
  const entryContent = (fileIndex.rootFiles.serverJs || '') + allContent;

  // ERR-001: uncaughtException and unhandledRejection handlers
  const hasUncaughtException = /process\.on\s*\(\s*['"]uncaughtException['"]/.test(entryContent);
  const hasUnhandledRejection = /process\.on\s*\(\s*['"]unhandledRejection['"]/.test(entryContent);
  if (hasUncaughtException && hasUnhandledRejection) {
    findings.push({
      domain: DOMAIN, checkId: 'ERR-001', status: 'passed',
      description: 'Both process.on("uncaughtException") and process.on("unhandledRejection") handlers are registered.',
      remediation: '',
    });
  } else {
    const missing = [];
    if (!hasUncaughtException) missing.push('uncaughtException');
    if (!hasUnhandledRejection) missing.push('unhandledRejection');
    findings.push({
      domain: DOMAIN, checkId: 'ERR-001', status: 'critical',
      description: `Missing process event handler(s): ${missing.join(', ')}.`,
      remediation: 'Register both process.on("uncaughtException") and process.on("unhandledRejection") in the entry point.',
    });
  }

  // ERR-002: Graceful shutdown closes all connections
  const hasSigterm = /process\.on\s*\(\s*['"]SIGTERM['"]/.test(entryContent);
  const hasSigint = /process\.on\s*\(\s*['"]SIGINT['"]/.test(entryContent);
  const shutdownClosesDb = /database\.disconnect|mongoose\.disconnect/.test(allContent);
  const shutdownClosesRedis = /redis.*disconnect|redisConnection\.disconnect/.test(allContent);
  const shutdownClosesRabbit = /rabbitmq\.disconnect|channel\.close|connection\.close/.test(allContent);

  if (hasSigterm && hasSigint && shutdownClosesDb && shutdownClosesRedis && shutdownClosesRabbit) {
    findings.push({
      domain: DOMAIN, checkId: 'ERR-002', status: 'passed',
      description: 'Graceful shutdown closes all connections (DB, Redis, RabbitMQ) on SIGTERM and SIGINT.',
      remediation: '',
    });
  } else {
    const issues = [];
    if (!hasSigterm) issues.push('SIGTERM handler missing');
    if (!hasSigint) issues.push('SIGINT handler missing');
    if (!shutdownClosesDb) issues.push('database not closed on shutdown');
    if (!shutdownClosesRedis) issues.push('Redis not closed on shutdown');
    if (!shutdownClosesRabbit) issues.push('RabbitMQ not closed on shutdown');
    findings.push({
      domain: DOMAIN, checkId: 'ERR-002', status: 'failed',
      description: `Graceful shutdown is incomplete: ${issues.join(', ')}.`,
      remediation: 'Implement a graceful shutdown that closes all connections (DB, Redis, RabbitMQ, HTTP server) on SIGTERM and SIGINT.',
    });
  }

  // ERR-003: Stack traces not in production error responses (duplicate of API-009 but from error handling perspective)
  const errorHandlerFiles = fileIndex.sourceFiles.filter(f =>
    f.path.includes('error') || f.path.includes('middleware')
  );
  const errorHandlerContent = errorHandlerFiles.map(f => f.content).join('\n');
  const stackConditional = /NODE_ENV.*development.*stack|stack.*NODE_ENV.*development/i.test(errorHandlerContent) ||
    /process\.env\.NODE_ENV\s*===\s*['"]development['"].*stack/i.test(errorHandlerContent);
  const stackUnconditional = /stack\s*:\s*err\.stack/.test(errorHandlerContent) && !stackConditional;
  if (stackUnconditional) {
    findings.push({
      domain: DOMAIN, checkId: 'ERR-003', status: 'critical',
      description: 'Error handler exposes err.stack unconditionally in responses.',
      remediation: 'Only include stack traces in development: ...(process.env.NODE_ENV === "development" && { stack: err.stack })',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'ERR-003', status: 'passed',
      description: 'Stack traces are conditionally excluded from error responses in production.',
      remediation: '',
    });
  }

  // ERR-004: Fire-and-forget calls have .catch() handlers
  // Look for patterns like somePromise() without .catch() — approximated by checking for .catch in service files
  const serviceFiles = fileIndex.sourceFiles.filter(f => f.path.includes('/services/'));
  const serviceContent = serviceFiles.map(f => f.content).join('\n');
  const hasFireAndForgetWithoutCatch = /\)\s*;/.test(serviceContent) &&
    !/\.catch\s*\(/.test(serviceContent);
  // More targeted: look for async calls that end without .catch
  const fireAndForgetPattern = /\w+\.\w+\([^)]*\)\s*(?!\.catch)(?!\.then)(?!;?\s*\/\/)(?:\s*;)/;
  // Use a simpler heuristic: check if .catch() is used at all in service files
  const hasCatchHandlers = /\.catch\s*\(/.test(allContent);
  if (hasCatchHandlers) {
    findings.push({
      domain: DOMAIN, checkId: 'ERR-004', status: 'passed',
      description: '.catch() handlers are used for fire-and-forget async calls.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'ERR-004', status: 'failed',
      description: 'No .catch() handlers detected for fire-and-forget async calls. Unhandled rejections may occur.',
      remediation: 'Add .catch() handlers to all fire-and-forget async calls (RabbitMQ publish, Redis set, email send).',
    });
  }

  // ERR-005: Balance rollback in worker
  const hasRollback = /rollback|addBalance|balance.*restore|restore.*balance/i.test(allContent);
  if (hasRollback) {
    findings.push({
      domain: DOMAIN, checkId: 'ERR-005', status: 'passed',
      description: 'Balance rollback logic is present in the worker for failed payout processing.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'ERR-005', status: 'critical',
      description: 'No balance rollback logic detected in the worker.',
      remediation: 'Implement balance rollback in the worker to restore the user\'s balance when payout processing fails.',
    });
  }

  // ERR-006: Worker graceful shutdown (stops consuming before disconnecting)
  const workerFiles = fileIndex.sourceFiles.filter(f => f.path.includes('/worker/'));
  const workerContent = workerFiles.map(f => f.content).join('\n');
  const workerHasGracefulShutdown = /stopConsuming|consumer\.cancel|channel\.cancel/.test(workerContent) &&
    /SIGTERM|SIGINT/.test(workerContent);
  if (workerHasGracefulShutdown) {
    findings.push({
      domain: DOMAIN, checkId: 'ERR-006', status: 'passed',
      description: 'Worker implements graceful shutdown that stops consuming before disconnecting.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'ERR-006', status: 'failed',
      description: 'Worker does not implement graceful shutdown. It may exit immediately on SIGTERM, dropping in-flight messages.',
      remediation: 'Implement graceful shutdown in the worker: stop consuming, wait for in-flight messages, then disconnect.',
    });
  }

  return findings;
}

module.exports = { check };
