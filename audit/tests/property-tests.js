// Feature: backend-audit, Property 8: finding schema completeness
// Feature: backend-audit, Property 2: score formula invariant
// Feature: backend-audit, Property 3: critical findings appear in critical_vulnerabilities
// Feature: backend-audit, Property 4: failed findings appear in suggested_fixes
// Feature: backend-audit, Property 5: production_ready consistency
// Feature: backend-audit, Property 6: summary counts match domain findings
// Feature: backend-audit, Property 1: audit report JSON round trip
'use strict';

const fc = require('fast-check');
const { buildReport, computeScore } = require('../lib/reporter');

const authChecker = require('../checkers/auth');
const inputValidationChecker = require('../checkers/input-validation');
const apiDesignChecker = require('../checkers/api-design');
const mongodbChecker = require('../checkers/mongodb');
const rabbitmqChecker = require('../checkers/rabbitmq');
const socketioChecker = require('../checkers/socketio');
const loggingChecker = require('../checkers/logging');
const errorHandlingChecker = require('../checkers/error-handling');
const environmentChecker = require('../checkers/environment');
const performanceChecker = require('../checkers/performance');
const testingChecker = require('../checkers/testing');
const devopsChecker = require('../checkers/devops');
const criticalGapsChecker = require('../checkers/critical-gaps');

const ALL_CHECKERS = [
  authChecker,
  inputValidationChecker,
  apiDesignChecker,
  mongodbChecker,
  rabbitmqChecker,
  socketioChecker,
  loggingChecker,
  errorHandlingChecker,
  environmentChecker,
  performanceChecker,
  testingChecker,
  devopsChecker,
  criticalGapsChecker,
];

const VALID_STATUSES = new Set(['passed', 'failed', 'critical']);

// Arbitrary for a single source file
const sourceFileArb = fc.record({
  path: fc.string({ minLength: 1, maxLength: 80 }).map(s => `/project/src/${s}.js`),
  content: fc.string({ minLength: 0, maxLength: 500 }),
});

// Arbitrary for rootFiles
const rootFilesArb = fc.record({
  packageJson: fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: null }),
  envExample: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
  gitignore: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
  dockerCompose: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
  serverJs: fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: null }),
  dockerfileGateway: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: null }),
  dockerfileWorker: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: null }),
  dockerfile: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: null }),
});

// Arbitrary for a full FileIndex
const fileIndexArb = fc.record({
  sourceFiles: fc.array(sourceFileArb, { minLength: 0, maxLength: 10 }),
  rootFiles: rootFilesArb,
});

// ── Property 8: Finding Schema Completeness ──────────────────────────────────
console.log('Running Property 8: Finding Schema Completeness...');
fc.assert(
  fc.property(fileIndexArb, (fileIndex) => {
    for (const checker of ALL_CHECKERS) {
      let findings;
      try {
        findings = checker.check(fileIndex);
      } catch (err) {
        throw new Error(`Checker threw unexpectedly: ${err.message}`);
      }
      if (!Array.isArray(findings)) {
        throw new Error('Checker did not return an array');
      }
      for (const f of findings) {
        if (!f.domain || typeof f.domain !== 'string' || f.domain.trim() === '') {
          throw new Error(`Finding missing domain: ${JSON.stringify(f)}`);
        }
        if (!f.checkId || typeof f.checkId !== 'string' || f.checkId.trim() === '') {
          throw new Error(`Finding missing checkId: ${JSON.stringify(f)}`);
        }
        if (!VALID_STATUSES.has(f.status)) {
          throw new Error(`Finding has invalid status "${f.status}": ${JSON.stringify(f)}`);
        }
        if (!f.description || typeof f.description !== 'string' || f.description.trim() === '') {
          throw new Error(`Finding missing description: ${JSON.stringify(f)}`);
        }
      }
    }
    return true;
  }),
  { numRuns: 100 }
);
console.log('  PASSED');

// ── Property 2: Score Formula Invariant ──────────────────────────────────────
console.log('Running Property 2: Score Formula Invariant...');
fc.assert(
  fc.property(
    fc.nat(200), // passed
    fc.nat(200), // failed
    fc.nat(200), // critical
    (passed, failed, critical) => {
      const score = computeScore(passed, failed, critical);
      if (typeof score !== 'number') return false;
      if (!Number.isInteger(score)) return false;
      if (score < 0 || score > 100) return false;
      const denom = passed + failed + critical * 2;
      if (denom === 0) return score === 0;
      const expected = Math.round((passed / denom) * 100);
      return score === expected;
    }
  ),
  { numRuns: 100 }
);
console.log('  PASSED');

// Arbitrary for a single finding
const findingArb = fc.record({
  domain: fc.constantFrom('Authentication', 'Input_Validation', 'API_Design', 'MongoDB', 'RabbitMQ'),
  checkId: fc.string({ minLength: 3, maxLength: 10 }),
  status: fc.constantFrom('passed', 'failed', 'critical'),
  description: fc.string({ minLength: 1, maxLength: 100 }),
  remediation: fc.string({ minLength: 0, maxLength: 100 }),
});

const metaArb = fc.record({
  tool: fc.constant('backend-audit'),
  version: fc.constant('1.0.0'),
  target: fc.string({ minLength: 1, maxLength: 50 }),
  generated_at: fc.constant(new Date().toISOString()),
});

// ── Property 3: Critical Findings Appear in critical_vulnerabilities ──────────
console.log('Running Property 3: Critical Findings in critical_vulnerabilities...');
fc.assert(
  fc.property(fc.array(findingArb, { minLength: 0, maxLength: 50 }), metaArb, (findings, meta) => {
    const report = buildReport(findings, meta);
    const criticalFindings = findings.filter(f => f.status === 'critical');
    if (report.critical_vulnerabilities.length !== criticalFindings.length) return false;
    return criticalFindings.every(cf =>
      report.critical_vulnerabilities.some(rv => rv.checkId === cf.checkId && rv.domain === cf.domain)
    );
  }),
  { numRuns: 100 }
);
console.log('  PASSED');

// ── Property 4: Failed Findings Appear in suggested_fixes ────────────────────
console.log('Running Property 4: Failed Findings in suggested_fixes...');
fc.assert(
  fc.property(fc.array(findingArb, { minLength: 0, maxLength: 50 }), metaArb, (findings, meta) => {
    const report = buildReport(findings, meta);
    const failedFindings = findings.filter(f => f.status === 'failed');
    if (report.suggested_fixes.length !== failedFindings.length) return false;
    return failedFindings.every(ff =>
      report.suggested_fixes.some(sf => sf.checkId === ff.checkId && sf.domain === ff.domain)
    );
  }),
  { numRuns: 100 }
);
console.log('  PASSED');

// ── Property 5: production_ready Consistency ─────────────────────────────────
console.log('Running Property 5: production_ready Consistency...');
fc.assert(
  fc.property(fc.array(findingArb, { minLength: 0, maxLength: 50 }), metaArb, (findings, meta) => {
    const report = buildReport(findings, meta);
    const hasCritical = findings.some(f => f.status === 'critical');
    if (report.production_ready === true) {
      // Must have score >= 60 and no criticals
      if (hasCritical) return false;
      if (report.summary.score < 60) return false;
    }
    if (report.production_ready === false) {
      // Either score < 60 or has criticals
      const shouldBeFalse = hasCritical || report.summary.score < 60;
      if (!shouldBeFalse) return false;
    }
    return true;
  }),
  { numRuns: 100 }
);
console.log('  PASSED');

// ── Property 6: Summary Counts Match Domain Findings ─────────────────────────
console.log('Running Property 6: Summary Counts Match Domain Findings...');
fc.assert(
  fc.property(fc.array(findingArb, { minLength: 0, maxLength: 50 }), metaArb, (findings, meta) => {
    const report = buildReport(findings, meta);
    const passed = findings.filter(f => f.status === 'passed').length;
    const failed = findings.filter(f => f.status === 'failed').length;
    const critical = findings.filter(f => f.status === 'critical').length;
    if (report.summary.passed !== passed) return false;
    if (report.summary.failed !== failed) return false;
    if (report.summary.critical !== critical) return false;
    if (report.summary.total_checks !== findings.length) return false;
    return true;
  }),
  { numRuns: 100 }
);
console.log('  PASSED');

// ── Property 1: Audit Report JSON Round Trip ──────────────────────────────────
console.log('Running Property 1: Audit Report JSON Round Trip...');
fc.assert(
  fc.property(fc.array(findingArb, { minLength: 0, maxLength: 50 }), metaArb, (findings, meta) => {
    const report = buildReport(findings, meta);
    const serialized = JSON.stringify(report);
    const parsed = JSON.parse(serialized);
    const reserialized = JSON.stringify(parsed);
    return serialized === reserialized;
  }),
  { numRuns: 100 }
);
console.log('  PASSED');

console.log('\nAll property tests passed.');
