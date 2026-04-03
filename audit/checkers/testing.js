'use strict';

const DOMAIN = 'Testing';

const TEST_RUNNERS = ['jest', 'mocha', 'vitest', 'jasmine', 'tap', 'ava'];

const MOCK_PATTERNS = [
  'jest.mock',
  'sinon',
  'nock',
  'mockgoose',
  'mongodb-memory-server',
  'ioredis-mock',
  'amqplib/callback_api',
];

const LIVE_CONNECTION_STRINGS = [
  'mongodb://',
  'redis://',
  'amqp://',
];

const AUTH_FLOW_KEYWORDS = ['register', 'login', 'refresh', 'logout'];

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {import('../lib/reporter').Finding[]}
 */
function check(fileIndex) {
  const findings = [];

  // Parse package.json once
  let pkg = null;
  if (fileIndex.rootFiles.packageJson) {
    try {
      pkg = JSON.parse(fileIndex.rootFiles.packageJson);
    } catch {
      // leave pkg as null
    }
  }

  const devDeps = (pkg && pkg.devDependencies) ? pkg.devDependencies : {};
  const deps = (pkg && pkg.dependencies) ? pkg.dependencies : {};
  const scripts = (pkg && pkg.scripts) ? pkg.scripts : {};

  // Identify test files
  const testFiles = fileIndex.sourceFiles.filter(f =>
    f.path.includes('.test.js') ||
    f.path.includes('.spec.js') ||
    f.path.includes('__tests__')
  );

  // TEST-001: No test runner in devDependencies
  const hasTestRunner = TEST_RUNNERS.some(
    runner => devDeps[runner] !== undefined || deps[runner] !== undefined
  );
  if (hasTestRunner) {
    const found = TEST_RUNNERS.find(r => devDeps[r] !== undefined || deps[r] !== undefined);
    findings.push({
      checkId: 'TEST-001',
      domain: DOMAIN,
      status: 'passed',
      description: `Test runner detected: "${found}".`,
      remediation: '',
    });
  } else {
    findings.push({
      checkId: 'TEST-001',
      domain: DOMAIN,
      status: 'critical',
      description: 'No test runner found in devDependencies (checked: jest, mocha, vitest, jasmine, tap, ava).',
      remediation: 'Install a test runner such as Jest or Vitest and add it to devDependencies.',
    });
  }

  // TEST-002: Missing `test` script in package.json
  const hasTestScript = typeof scripts.test === 'string' && scripts.test.trim().length > 0;
  if (hasTestScript) {
    findings.push({
      checkId: 'TEST-002',
      domain: DOMAIN,
      status: 'passed',
      description: `"test" script is defined in package.json: "${scripts.test}".`,
      remediation: '',
    });
  } else {
    findings.push({
      checkId: 'TEST-002',
      domain: DOMAIN,
      status: 'failed',
      description: 'No "test" script found in package.json.',
      remediation: 'Add a "test" script to package.json, e.g. "jest --runInBand" or "vitest run".',
    });
  }

  // TEST-003: No test files found
  if (testFiles.length > 0) {
    findings.push({
      checkId: 'TEST-003',
      domain: DOMAIN,
      status: 'passed',
      description: `${testFiles.length} test file(s) found (*.test.js, *.spec.js, __tests__).`,
      remediation: '',
    });
  } else {
    findings.push({
      checkId: 'TEST-003',
      domain: DOMAIN,
      status: 'critical',
      description: 'No test files found (*.test.js, *.spec.js, or __tests__ directories).',
      remediation: 'Create test files alongside your source modules using the *.test.js or *.spec.js convention.',
    });
  }

  // TEST-004: No integration tests
  const integrationTests = testFiles.filter(f => {
    const lowerPath = f.path.toLowerCase();
    if (
      lowerPath.includes('integration') ||
      lowerPath.includes('e2e') ||
      lowerPath.includes('api')
    ) {
      return true;
    }
    // Check for supertest import/require in any test file
    return /require\(['"]supertest['"]\)|from\s+['"]supertest['"]/i.test(f.content);
  });

  if (integrationTests.length > 0) {
    findings.push({
      checkId: 'TEST-004',
      domain: DOMAIN,
      status: 'passed',
      description: `${integrationTests.length} integration/e2e test file(s) detected.`,
      remediation: '',
    });
  } else {
    findings.push({
      checkId: 'TEST-004',
      domain: DOMAIN,
      status: 'failed',
      description: 'No integration or e2e tests found (no files with "integration", "e2e", or "api" in path, and no supertest usage).',
      remediation: 'Add integration tests using supertest to cover your HTTP API endpoints.',
    });
  }

  // TEST-005: Live infrastructure in tests
  const liveInfraFiles = testFiles.filter(f => {
    const hasLiveConnection = LIVE_CONNECTION_STRINGS.some(str => f.content.includes(str));
    if (!hasLiveConnection) return false;
    const hasMockPattern = MOCK_PATTERNS.some(pattern => f.content.includes(pattern));
    return !hasMockPattern;
  });

  if (liveInfraFiles.length > 0) {
    const paths = liveInfraFiles.map(f => f.path).join(', ');
    findings.push({
      checkId: 'TEST-005',
      domain: DOMAIN,
      status: 'critical',
      description: `Live infrastructure connection strings (mongodb://, redis://, amqp://) found in test files without mock/stub patterns: ${paths}`,
      remediation: 'Replace live connections in tests with in-memory alternatives (mongodb-memory-server, ioredis-mock) or mocking libraries (jest.mock, sinon, nock).',
    });
  } else {
    findings.push({
      checkId: 'TEST-005',
      domain: DOMAIN,
      status: 'passed',
      description: 'No live infrastructure connection strings detected in test files without mock patterns.',
      remediation: '',
    });
  }

  // TEST-006: Missing auth flow test coverage
  const authFlowCoverage = AUTH_FLOW_KEYWORDS.filter(keyword =>
    testFiles.some(f => f.content.toLowerCase().includes(keyword))
  );

  if (authFlowCoverage.length === AUTH_FLOW_KEYWORDS.length) {
    findings.push({
      checkId: 'TEST-006',
      domain: DOMAIN,
      status: 'passed',
      description: 'Auth flow keywords (register, login, refresh, logout) are all covered in test files.',
      remediation: '',
    });
  } else {
    const missing = AUTH_FLOW_KEYWORDS.filter(k => !authFlowCoverage.includes(k));
    findings.push({
      checkId: 'TEST-006',
      domain: DOMAIN,
      status: 'failed',
      description: `Auth flow test coverage is incomplete. Missing coverage for: ${missing.join(', ')}.`,
      remediation: 'Add test cases covering the full auth flow: register, login, token refresh, and logout.',
    });
  }

  return findings;
}

module.exports = { check };
