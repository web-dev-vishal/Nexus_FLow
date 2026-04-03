'use strict';

const DOMAIN = 'Critical_Gaps';

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {Array}
 */
function check(fileIndex) {
  const findings = [];
  const allContent = fileIndex.sourceFiles.map(f => f.content).join('\n');

  // GAP-001: CSRF protection on state-changing endpoints
  const hasCsrf =
    /csrf|csurf|csrfToken|_csrf|x-csrf-token/i.test(allContent) ||
    /sameSite\s*:\s*['"]strict['"]/i.test(allContent);
  if (hasCsrf) {
    findings.push({
      domain: DOMAIN,
      checkId: 'GAP-001',
      status: 'passed',
      description: 'CSRF protection detected (csurf middleware or SameSite=Strict cookie policy).',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN,
      checkId: 'GAP-001',
      status: 'failed',
      description: 'No CSRF protection detected on state-changing endpoints.',
      remediation:
        'Add CSRF protection using the csurf package or enforce SameSite=Strict on session cookies for all state-changing (POST/PUT/PATCH/DELETE) endpoints.',
    });
  }

  // GAP-002: Request correlation IDs for distributed tracing
  const hasCorrelationId =
    /correlationId|correlation-id|x-correlation-id|x-request-id|requestId|traceId/i.test(allContent);
  if (hasCorrelationId) {
    findings.push({
      domain: DOMAIN,
      checkId: 'GAP-002',
      status: 'passed',
      description: 'Request correlation IDs are present for distributed tracing.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN,
      checkId: 'GAP-002',
      status: 'failed',
      description: 'No request correlation ID (x-correlation-id, x-request-id, requestId) detected.',
      remediation:
        'Generate a unique correlation ID per request (e.g. using uuid) and attach it to req, logs, and response headers to enable distributed tracing.',
    });
  }

  // GAP-003: Content-Security-Policy header configured
  const hasCsp =
    /contentSecurityPolicy|content-security-policy|csp/i.test(allContent) &&
    /helmet/i.test(allContent);
  const helmetWithCspDisabled =
    /contentSecurityPolicy\s*:\s*false/.test(allContent);
  if (hasCsp && !helmetWithCspDisabled) {
    findings.push({
      domain: DOMAIN,
      checkId: 'GAP-003',
      status: 'passed',
      description: 'Content-Security-Policy header is configured via helmet.',
      remediation: '',
    });
  } else if (helmetWithCspDisabled) {
    findings.push({
      domain: DOMAIN,
      checkId: 'GAP-003',
      status: 'failed',
      description: 'Content-Security-Policy is explicitly disabled in helmet configuration.',
      remediation:
        'Remove contentSecurityPolicy: false from helmet options and configure a strict CSP policy.',
    });
  } else {
    findings.push({
      domain: DOMAIN,
      checkId: 'GAP-003',
      status: 'failed',
      description: 'No explicit Content-Security-Policy header configuration detected.',
      remediation:
        'Configure helmet with a Content-Security-Policy: helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["\'self\'"] } } })',
    });
  }

  // GAP-004: Secrets rotation documentation
  const allRootContent = Object.values(fileIndex.rootFiles)
    .filter(Boolean)
    .join('\n');
  const allText = allContent + allRootContent;
  const hasSecretsRotation =
    /secret.*rotat|rotat.*secret|key.*rotat|rotat.*key|credential.*rotat|rotat.*credential/i.test(allText) ||
    /SECRETS_ROTATION|secrets-rotation|rotate-secrets/i.test(allText);
  if (hasSecretsRotation) {
    findings.push({
      domain: DOMAIN,
      checkId: 'GAP-004',
      status: 'passed',
      description: 'Secrets rotation documentation or automation detected.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN,
      checkId: 'GAP-004',
      status: 'failed',
      description: 'No secrets rotation documentation or automation found.',
      remediation:
        'Document a secrets rotation procedure (e.g. in README or runbook) and consider automating rotation using AWS Secrets Manager, HashiCorp Vault, or a scheduled rotation script.',
    });
  }

  return findings;
}

module.exports = { check };
