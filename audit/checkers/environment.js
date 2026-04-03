'use strict';

const DOMAIN = 'Environment';

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {Array}
 */
function check(fileIndex) {
  const findings = [];
  const allContent = fileIndex.sourceFiles.map(f => f.content).join('\n');

  // ENV-001: No hardcoded secrets or connection strings
  const secretPatterns = [
    /(?:ACCESS_SECRET|REFRESH_SECRET|VERIFY_SECRET|JWT_SECRET)\s*=\s*['"][^'"]{4,}['"]/,
    /mongodb(?:\+srv)?:\/\/[^'"]*:[^'"]*@/,
    /(?:password|passwd|pwd)\s*=\s*['"][^'"]{4,}['"]/i,
    /(?:api[_-]?key|apikey)\s*=\s*['"][^'"]{8,}['"]/i,
    /(?:secret|token)\s*=\s*['"][^'"]{8,}['"]/i,
  ];
  // Exclude test files — they intentionally contain mock secrets
  const nonTestFiles = fileIndex.sourceFiles.filter(
    f => !f.path.includes('__tests__') && !f.path.includes('.test.') && !f.path.includes('.spec.')
  );
  const hasHardcodedSecret = secretPatterns.some(pattern =>
    nonTestFiles.some(f => pattern.test(f.content))
  );
  if (hasHardcodedSecret) {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-001', status: 'critical',
      description: 'Hardcoded secrets or connection strings found in source code.',
      remediation: 'Move all secrets to environment variables. Never commit secrets to source control.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-001', status: 'passed',
      description: 'No hardcoded secrets or connection strings detected in source files.',
      remediation: '',
    });
  }

  // ENV-002: .env.example exists
  if (fileIndex.rootFiles.envExample) {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-002', status: 'passed',
      description: '.env.example file exists listing required environment variables.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-002', status: 'failed',
      description: '.env.example file is missing.',
      remediation: 'Create a .env.example file listing all required environment variables without their values.',
    });
  }

  // ENV-003: .env in .gitignore
  const gitignoreContent = fileIndex.rootFiles.gitignore || '';
  const envInGitignore = /^\.env$/m.test(gitignoreContent) || /^\.env\b/m.test(gitignoreContent);
  if (envInGitignore) {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-003', status: 'passed',
      description: '.env is listed in .gitignore.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-003', status: 'critical',
      description: '.env is not listed in .gitignore. Secrets may be committed to source control.',
      remediation: 'Add .env to .gitignore immediately.',
    });
  }

  // ENV-004: Required env vars validated at startup
  const requiredVars = ['MONGO_URI', 'REDIS_HOST', 'RABBITMQ_URL', 'ACCESS_SECRET', 'REFRESH_SECRET'];
  const hasEnvalid = /envalid|cleanEnv|makeValidator/.test(allContent);
  const hasJoiEnv = /joi\.object\s*\(\s*\{[^}]*MONGO_URI|Joi\.object\s*\(\s*\{[^}]*MONGO_URI/.test(allContent);
  const hasManualValidation = requiredVars.filter(v =>
    new RegExp(`process\\.env\\.${v}`).test(allContent)
  ).length >= 3;

  if (hasEnvalid || hasJoiEnv) {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-004', status: 'passed',
      description: 'Environment variables are validated at startup using a validation library (envalid or joi).',
      remediation: '',
    });
  } else if (hasManualValidation) {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-004', status: 'passed',
      description: 'Required environment variables are referenced in the codebase (manual validation).',
      remediation: 'Consider using envalid or joi to validate all required env vars at startup with clear error messages.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-004', status: 'failed',
      description: 'Required environment variables (MONGO_URI, REDIS_HOST, RABBITMQ_URL, ACCESS_SECRET, REFRESH_SECRET) are not validated at startup.',
      remediation: 'Validate all required environment variables at startup using envalid or a manual check.',
    });
  }

  // ENV-005: NODE_ENV referenced in codebase
  const hasNodeEnv = /process\.env\.NODE_ENV/.test(allContent);
  if (hasNodeEnv) {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-005', status: 'passed',
      description: 'NODE_ENV is referenced in the codebase to differentiate dev/production behavior.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-005', status: 'failed',
      description: 'NODE_ENV is never referenced in the codebase.',
      remediation: 'Use process.env.NODE_ENV to differentiate behavior between development and production.',
    });
  }

  // ENV-006: Config validation library used (bonus passed finding)
  if (hasEnvalid || hasJoiEnv) {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-006', status: 'passed',
      description: 'A config validation library (envalid or joi) is used for startup environment validation.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'ENV-006', status: 'failed',
      description: 'No config validation library (envalid, joi) detected for startup environment validation.',
      remediation: 'Use envalid or joi to validate and document all required environment variables at startup.',
    });
  }

  return findings;
}

module.exports = { check };
