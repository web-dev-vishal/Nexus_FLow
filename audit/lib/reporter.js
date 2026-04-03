'use strict';

/**
 * Compute the production readiness score.
 * Formula: round(passed / (passed + failed + critical * 2) * 100)
 * Returns 0 if no checks ran.
 * @param {number} passed
 * @param {number} failed
 * @param {number} critical
 * @returns {number} integer 0-100
 */
function computeScore(passed, failed, critical) {
  const denominator = passed + failed + critical * 2;
  if (denominator === 0) return 0;
  return Math.round((passed / denominator) * 100);
}

/**
 * Build the full AuditReport from all findings.
 * @param {import('./scanner').Finding[]} allFindings - Flat array of all findings from all checkers
 * @param {{ tool: string, version: string, target: string, generated_at: string }} meta
 * @returns {object} AuditReport
 */
function buildReport(allFindings, meta) {
  // Group findings by domain
  const domains = {};
  for (const finding of allFindings) {
    if (!domains[finding.domain]) {
      domains[finding.domain] = [];
    }
    domains[finding.domain].push(finding);
  }

  // Count by status
  let passed = 0;
  let failed = 0;
  let critical = 0;
  for (const finding of allFindings) {
    if (finding.status === 'passed') passed++;
    else if (finding.status === 'failed') failed++;
    else if (finding.status === 'critical') critical++;
  }

  const total_checks = passed + failed + critical;
  const score = computeScore(passed, failed, critical);
  const production_ready = score >= 60 && critical === 0;

  const critical_vulnerabilities = allFindings.filter(f => f.status === 'critical');
  const suggested_fixes = allFindings.filter(f => f.status === 'failed');

  return {
    meta,
    summary: {
      total_checks,
      passed,
      failed,
      critical,
      score,
    },
    production_ready,
    domains,
    critical_vulnerabilities,
    suggested_fixes,
  };
}

module.exports = { buildReport, computeScore };
