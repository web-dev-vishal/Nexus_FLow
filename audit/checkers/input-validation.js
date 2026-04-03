'use strict';

const DOMAIN = 'Input_Validation';

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {Array}
 */
function check(fileIndex) {
  const findings = [];
  const allContent = fileIndex.sourceFiles.map(f => f.content).join('\n');
  const appContent = fileIndex.rootFiles.serverJs || '';
  const appFiles = fileIndex.sourceFiles.filter(f =>
    f.path.includes('app.js') || f.path.includes('server.js')
  );
  const appFileContent = appFiles.map(f => f.content).join('\n') + appContent;

  // INP-001 / INP-002: Schema validation on route handlers
  const routeFiles = fileIndex.sourceFiles.filter(f => f.path.includes('/routes/'));
  const validatorKeywords = /validate|schema|Joi|Zod|Yup|z\.object|joi\.object|yup\.object/i;
  const routesWithoutValidation = routeFiles.filter(f => {
    // Check if the route file imports or uses a validator
    return !validatorKeywords.test(f.content);
  });

  if (routeFiles.length === 0) {
    findings.push({
      domain: DOMAIN, checkId: 'INP-001', status: 'failed',
      description: 'No route files found to verify schema validation coverage.',
      remediation: 'Ensure all route handlers apply schema validation middleware before the controller.',
    });
  } else if (routesWithoutValidation.length > 0) {
    findings.push({
      domain: DOMAIN, checkId: 'INP-001', status: 'failed',
      description: `${routesWithoutValidation.length} route file(s) do not appear to apply schema validation middleware: ${routesWithoutValidation.map(f => f.path.split('/').pop()).join(', ')}`,
      remediation: 'Apply Joi, Zod, or Yup schema validation middleware before every route handler that accepts user input.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'INP-001', status: 'passed',
      description: 'All route files appear to apply schema validation middleware.',
      remediation: '',
    });
  }

  // INP-003: express-mongo-sanitize
  const hasMongoSanitize = /mongoSanitize|express-mongo-sanitize|mongo-sanitize/.test(allContent);
  if (hasMongoSanitize) {
    findings.push({
      domain: DOMAIN, checkId: 'INP-003', status: 'passed',
      description: 'express-mongo-sanitize is registered as global middleware.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'INP-003', status: 'critical',
      description: 'express-mongo-sanitize or equivalent NoSQL injection prevention middleware is not registered.',
      remediation: 'Install express-mongo-sanitize and register it globally: app.use(mongoSanitize())',
    });
  }

  // INP-004: XSS sanitization middleware
  const hasXss = /xss|filterXSS|xssSanitizer|sanitizeHtml/.test(allContent);
  if (hasXss) {
    findings.push({
      domain: DOMAIN, checkId: 'INP-004', status: 'passed',
      description: 'XSS sanitization middleware is applied globally.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'INP-004', status: 'critical',
      description: 'No XSS sanitization middleware detected for req.body, req.query, and req.params.',
      remediation: 'Install the xss package and apply a sanitizer middleware globally in app.js.',
    });
  }

  // INP-005: HTTP parameter pollution protection (hpp)
  const hasHpp = /\bhpp\b/.test(allContent);
  if (hasHpp) {
    findings.push({
      domain: DOMAIN, checkId: 'INP-005', status: 'passed',
      description: 'HTTP parameter pollution protection (hpp) is registered as global middleware.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'INP-005', status: 'failed',
      description: 'hpp (HTTP parameter pollution protection) middleware is not registered.',
      remediation: 'Install hpp and register it globally: app.use(hpp())',
    });
  }

  // INP-006: Body size limit
  const hasBodyLimit = /express\.json\s*\(\s*\{[^}]*limit/.test(allContent) ||
    /bodyParser\.json\s*\(\s*\{[^}]*limit/.test(allContent);
  if (hasBodyLimit) {
    findings.push({
      domain: DOMAIN, checkId: 'INP-006', status: 'passed',
      description: 'Request body size is limited (e.g., express.json({ limit: "10kb" })).',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'INP-006', status: 'failed',
      description: 'No body size limit configured for express.json().',
      remediation: 'Set a body size limit: app.use(express.json({ limit: "10kb" }))',
    });
  }

  // INP-007: No z.any() on sensitive endpoints
  const validatorFiles = fileIndex.sourceFiles.filter(f => f.path.includes('/validators/'));
  const hasLooseTyping = validatorFiles.some(f => /z\.any\(\)|z\.unknown\(\)/.test(f.content));
  if (hasLooseTyping) {
    findings.push({
      domain: DOMAIN, checkId: 'INP-007', status: 'failed',
      description: 'Loose Zod typing (z.any() or z.unknown()) detected in validator schemas.',
      remediation: 'Replace z.any() and z.unknown() with strict type definitions on all sensitive inputs.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'INP-007', status: 'passed',
      description: 'No loose Zod typing (z.any() or z.unknown()) detected in validator schemas.',
      remediation: '',
    });
  }

  return findings;
}

module.exports = { check };
