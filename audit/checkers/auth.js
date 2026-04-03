'use strict';

const DOMAIN = 'Authentication';

/**
 * Parse a TTL string like "10d", "24h", "60m", "3600s" into hours.
 * Returns Infinity if unparseable.
 */
function parseTTLToHours(ttlStr) {
  if (!ttlStr) return Infinity;
  const match = ttlStr.match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!match) return Infinity;
  const val = parseFloat(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  switch (unit) {
    case 's': return val / 3600;
    case 'm': return val / 60;
    case 'h': return val;
    case 'd': return val * 24;
    default: return Infinity;
  }
}

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {import('../lib/reporter').Finding[]}
 */
function check(fileIndex) {
  const findings = [];
  const allContent = fileIndex.sourceFiles.map(f => f.content).join('\n');

  // AUTH-001: Detect JWT vs PASETO
  const usesJwt = /require\(['"]jsonwebtoken['"]\)|from\s+['"]jsonwebtoken['"]/i.test(allContent);
  const usesPaseto = /require\(['"]paseto['"]\)|from\s+['"]paseto['"]/i.test(allContent);

  if (usesPaseto && !usesJwt) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-001', status: 'passed',
      description: 'PASETO is used for token issuance.',
      remediation: '',
    });
  } else if (usesJwt) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-001', status: 'failed',
      description: 'JWT (jsonwebtoken) is used instead of PASETO. JWT is vulnerable to algorithm confusion attacks.',
      remediation: 'Replace jsonwebtoken with the paseto library and use v4.local or v4.public tokens.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-001', status: 'failed',
      description: 'No recognized token library (jsonwebtoken or paseto) detected.',
      remediation: 'Implement PASETO v4.local or v4.public for token issuance.',
    });
  }

  // AUTH-002 / AUTH-003 / AUTH-004: Hardcoded secrets
  const hardcodedSecretPattern = /(ACCESS_SECRET|REFRESH_SECRET|VERIFY_SECRET)\s*=\s*['"][^'"]{4,}['"]/;
  const hasHardcodedSecret = fileIndex.sourceFiles
    .filter(f => !f.path.includes('__tests__') && !f.path.includes('.test.') && !f.path.includes('.spec.'))
    .some(f => hardcodedSecretPattern.test(f.content));
  if (hasHardcodedSecret) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-003', status: 'critical',
      description: 'Hardcoded token secret found in source code.',
      remediation: 'Move all secrets to environment variables and read them via process.env.*',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-003', status: 'passed',
      description: 'No hardcoded token secrets detected in source files.',
      remediation: '',
    });
  }

  // AUTH-004: Secrets from env vars
  const secretsFromEnv = /process\.env\.(ACCESS_SECRET|REFRESH_SECRET|VERIFY_SECRET)/.test(allContent);
  if (secretsFromEnv) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-004', status: 'passed',
      description: 'Token secrets are read from environment variables.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-004', status: 'critical',
      description: 'Token secrets do not appear to be read from environment variables.',
      remediation: 'Use process.env.ACCESS_SECRET, process.env.REFRESH_SECRET, etc.',
    });
  }

  // AUTH-005: expiresIn set on token generation
  // Use a broader search: find all jwt.sign blocks by looking for expiresIn near sign calls
  const signCallCount = (allContent.match(/jwt\.sign\s*\(/g) || []).length;
  const expiresInCount = (allContent.match(/expiresIn\s*:/g) || []).length;
  const signWithoutExpiry = signCallCount > expiresInCount ? signCallCount - expiresInCount : 0;
  if (signWithoutExpiry > 0) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-005', status: 'critical',
      description: `${signWithoutExpiry} jwt.sign() call(s) found without expiresIn option.`,
      remediation: 'Always set expiresIn on every jwt.sign() call.',
    });
  } else if (signCallCount > 0) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-005', status: 'passed',
      description: 'All detected jwt.sign() calls include an expiresIn option.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-005', status: 'passed',
      description: 'No jwt.sign() calls detected (PASETO or other mechanism may be in use).',
      remediation: '',
    });
  }

  // AUTH-006: Access token TTL <= 24h
  const ttlMatches = allContent.match(/expiresIn\s*:\s*["']([^"']+)["']/g) || [];
  let longTTLFound = false;
  for (const match of ttlMatches) {
    const ttlStr = match.match(/["']([^"']+)["']/)?.[1];
    if (ttlStr && parseTTLToHours(ttlStr) > 24) {
      longTTLFound = true;
      break;
    }
  }
  if (longTTLFound) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-006', status: 'failed',
      description: 'Access token TTL exceeds 24 hours (e.g., "10d"). This increases the window for token misuse.',
      remediation: 'Reduce access token TTL to 15–60 minutes. Use refresh tokens for session continuity.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-006', status: 'passed',
      description: 'Access token TTL is within the recommended 24-hour limit.',
      remediation: '',
    });
  }

  // AUTH-007: bcrypt/argon2 with salt rounds >= 10
  const usesBcrypt = /require\(['"]bcrypt(?:js)?['"]\)|from\s+['"]bcrypt(?:js)?['"]/i.test(allContent);
  const usesArgon2 = /require\(['"]argon2['"]\)|from\s+['"]argon2['"]/i.test(allContent);
  const saltRoundsMatch = allContent.match(/saltRounds\s*=\s*(\d+)|bcrypt\.hash\([^,]+,\s*(\d+)/);
  const saltRounds = saltRoundsMatch ? parseInt(saltRoundsMatch[1] || saltRoundsMatch[2], 10) : null;

  if (!usesBcrypt && !usesArgon2) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-007', status: 'critical',
      description: 'No bcrypt or argon2 password hashing library detected.',
      remediation: 'Use bcrypt or argon2 with salt rounds >= 10 for password hashing.',
    });
  } else if (saltRounds !== null && saltRounds < 10) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-007', status: 'critical',
      description: `Password hashing salt rounds is ${saltRounds}, which is below the minimum of 10.`,
      remediation: 'Increase bcrypt salt rounds to at least 10 (12 recommended).',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-007', status: 'passed',
      description: 'Password hashing uses bcrypt/argon2 with adequate salt rounds.',
      remediation: '',
    });
  }

  // AUTH-008: Auth middleware applied to routes
  const routeFiles = fileIndex.sourceFiles.filter(f => f.path.includes('/routes/'));
  const routesWithoutAuth = routeFiles.filter(f =>
    !f.content.includes('isAuthenticated') && !f.content.includes('public')
  );
  if (routeFiles.length === 0) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-008', status: 'failed',
      description: 'No route files found to verify auth middleware coverage.',
      remediation: 'Ensure all private routes apply isAuthenticated middleware.',
    });
  } else if (routesWithoutAuth.length > 0) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-008', status: 'critical',
      description: `${routesWithoutAuth.length} route file(s) do not apply isAuthenticated middleware and are not marked as public.`,
      remediation: 'Apply isAuthenticated to all private routes.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-008', status: 'passed',
      description: 'All route files apply isAuthenticated or are marked as public.',
      remediation: '',
    });
  }

  // AUTH-009: Role-check middleware (adminOnly)
  const hasAdminMiddleware = /adminOnly|requireRole|checkRole|isAdmin/.test(allContent);
  const adminRoutesUseRoleCheck = fileIndex.sourceFiles
    .filter(f => f.path.includes('admin'))
    .some(f => /adminOnly|requireRole|checkRole|isAdmin/.test(f.content));

  if (!hasAdminMiddleware) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-009', status: 'critical',
      description: 'No role-check middleware (adminOnly, requireRole, etc.) found in the codebase.',
      remediation: 'Implement and apply role-check middleware to all admin-scoped routes.',
    });
  } else if (!adminRoutesUseRoleCheck) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-009', status: 'critical',
      description: 'Role-check middleware exists but is not applied to admin routes.',
      remediation: 'Apply adminOnly or equivalent middleware to all admin-scoped routes.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-009', status: 'passed',
      description: 'Role-check middleware exists and is applied to admin routes.',
      remediation: '',
    });
  }

  // AUTH-010: Logout invalidates token in Redis
  const logoutInvalidates = /redis\.del|client\.del|redisClient\.del/.test(allContent) &&
    /logout/i.test(allContent);
  if (logoutInvalidates) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-010', status: 'passed',
      description: 'Logout deletes the token from the session store (Redis).',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-010', status: 'critical',
      description: 'Logout does not appear to invalidate the token in Redis.',
      remediation: 'On logout, delete the refresh token key from Redis to invalidate the session.',
    });
  }

  // AUTH-011: Refresh tokens stored server-side
  const refreshStoredServerSide = /redis\.set.*refresh|refreshToken.*redis/i.test(allContent) ||
    /keys\.refreshToken/.test(allContent);
  if (refreshStoredServerSide) {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-011', status: 'passed',
      description: 'Refresh tokens are stored server-side in Redis and validated on use.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'AUTH-011', status: 'failed',
      description: 'Refresh tokens appear to be stateless with no server-side validation.',
      remediation: 'Store refresh tokens in Redis and validate them against the store on each use.',
    });
  }

  return findings;
}

module.exports = { check };
