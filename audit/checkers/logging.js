'use strict';

const DOMAIN = 'Logging';

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {Array}
 */
function check(fileIndex) {
  const findings = [];
  const allContent = fileIndex.sourceFiles.map(f => f.content).join('\n');

  // LOG-001: Structured logging library (Winston or Pino)
  const hasWinston = /require\(['"]winston['"]\)|from\s+['"]winston['"]/i.test(allContent);
  const hasPino = /require\(['"]pino['"]\)|from\s+['"]pino['"]/i.test(allContent);
  const primaryIsConsoleLog = !hasWinston && !hasPino &&
    (allContent.match(/console\.log\s*\(/g) || []).length > 5;

  if (hasWinston || hasPino) {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-001', status: 'passed',
      description: `Structured logging library (${hasWinston ? 'Winston' : 'Pino'}) is used.`,
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-001', status: 'failed',
      description: 'No structured logging library (Winston or Pino) detected. console.log appears to be the primary logging mechanism.',
      remediation: 'Replace console.log with Winston or Pino for structured, leveled logging.',
    });
  }

  // LOG-002: Log level controlled by env var
  const logLevelFromEnv = /process\.env\.LOG_LEVEL|process\.env\.LOG_LEVEL/.test(allContent);
  const hardcodedLogLevel = /level\s*:\s*['"](?:info|warn|error|debug|verbose)['"]/.test(allContent) && !logLevelFromEnv;
  if (logLevelFromEnv) {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-002', status: 'passed',
      description: 'Log level is controlled by an environment variable (LOG_LEVEL).',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-002', status: 'failed',
      description: 'Log level appears to be hardcoded rather than controlled by an environment variable.',
      remediation: 'Set log level via process.env.LOG_LEVEL so it can be changed without code changes.',
    });
  }

  // LOG-003: No sensitive fields in logs
  const sensitiveLogPattern = /logger\.(info|warn|error|debug)\s*\([^)]*(?:password|token|secret|apikey|api_key|authorization)/i;
  const hasSensitiveLogging = sensitiveLogPattern.test(allContent);
  if (hasSensitiveLogging) {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-003', status: 'critical',
      description: 'Potential logging of sensitive fields (password, token, secret, apikey, authorization) detected.',
      remediation: 'Redact sensitive fields before logging. Never log passwords, tokens, or secrets.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-003', status: 'passed',
      description: 'No obvious sensitive field logging patterns detected.',
      remediation: '',
    });
  }

  // LOG-004: Request logging middleware (Morgan or per-request logs)
  const hasMorgan = /morgan|require\(['"]morgan['"]\)|from\s+['"]morgan['"]/i.test(allContent);
  const hasRequestLogging = /req\.method|req\.originalUrl|req\.url/.test(allContent) &&
    /logger\.(info|debug)/.test(allContent);
  if (hasMorgan || hasRequestLogging) {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-004', status: 'passed',
      description: 'Request logging middleware or per-request log entries are present.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-004', status: 'failed',
      description: 'No request logging middleware (Morgan or equivalent) detected.',
      remediation: 'Add Morgan or implement per-request logging to track all incoming requests.',
    });
  }

  // LOG-005: Health endpoint exists
  const hasHealthEndpoint = /\/health|health\.route|healthRouter|createHealthRouter/i.test(allContent);
  if (hasHealthEndpoint) {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-005', status: 'passed',
      description: 'A /health or /api/health endpoint exists.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-005', status: 'failed',
      description: 'No health check endpoint (/health or /api/health) detected.',
      remediation: 'Add a /health endpoint that returns 200 when all dependencies are healthy.',
    });
  }

  // LOG-006: File transport with rotation configured
  const hasFileTransport = /transports\.File|new.*File\s*\(\s*\{/.test(allContent);
  const hasRotation = /maxsize|maxFiles|maxSize/.test(allContent);
  if (hasFileTransport && hasRotation) {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-006', status: 'passed',
      description: 'Log files are written to a persistent directory with file rotation configured.',
      remediation: '',
    });
  } else if (hasFileTransport) {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-006', status: 'failed',
      description: 'Log file transport exists but file rotation (maxsize, maxFiles) is not configured.',
      remediation: 'Configure maxsize and maxFiles on the Winston file transport to prevent unbounded log growth.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'LOG-006', status: 'failed',
      description: 'Logs are written only to stdout with no file transport.',
      remediation: 'Add a Winston file transport with rotation settings (maxsize, maxFiles).',
    });
  }

  return findings;
}

module.exports = { check };
