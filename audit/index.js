#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { buildFileIndex } = require('./lib/scanner');
const { buildReport } = require('./lib/reporter');

// ── All 13 checkers ───────────────────────────────────────────────────────────
const checkers = [
  { name: 'Authentication',    mod: require('./checkers/auth') },
  { name: 'Input_Validation',  mod: require('./checkers/input-validation') },
  { name: 'API_Design',        mod: require('./checkers/api-design') },
  { name: 'MongoDB',           mod: require('./checkers/mongodb') },
  { name: 'RabbitMQ',          mod: require('./checkers/rabbitmq') },
  { name: 'Socket.IO',         mod: require('./checkers/socketio') },
  { name: 'Logging',           mod: require('./checkers/logging') },
  { name: 'Error_Handling',    mod: require('./checkers/error-handling') },
  { name: 'Environment',       mod: require('./checkers/environment') },
  { name: 'Performance',       mod: require('./checkers/performance') },
  { name: 'Testing',           mod: require('./checkers/testing') },
  { name: 'DevOps',            mod: require('./checkers/devops') },
  { name: 'Critical_Gaps',     mod: require('./checkers/critical-gaps') },
];

/**
 * Parse --flag value pairs from argv.
 * @param {string[]} argv
 * @returns {{ target: string, output: string }}
 */
function parseArgs(argv) {
  const args = { target: process.cwd(), output: './audit-report.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) {
      args.target = argv[++i];
    } else if (argv[i] === '--output' && argv[i + 1]) {
      args.output = argv[++i];
    }
  }
  return args;
}

/**
 * Main entry point.
 * @param {string[]} argv - process.argv.slice(2)
 */
async function main(argv) {
  const { target, output } = parseArgs(argv);

  // Validate target path
  const targetAbs = path.resolve(target);
  if (!fs.existsSync(targetAbs)) {
    process.stderr.write(`[audit] ERROR: Target path does not exist: ${targetAbs}\n`);
    process.exit(1);
  }

  process.stdout.write(`[audit] Scanning: ${targetAbs}\n`);

  // Build file index
  let fileIndex;
  try {
    fileIndex = await buildFileIndex(targetAbs);
  } catch (err) {
    process.stderr.write(`[audit] ERROR: Failed to build file index: ${err.message}\n`);
    process.exit(1);
  }

  process.stdout.write(`[audit] Found ${fileIndex.sourceFiles.length} source file(s)\n`);

  // Run all checkers, catching per-checker errors as synthetic critical findings
  const allFindings = [];
  for (const { name, mod } of checkers) {
    try {
      const findings = mod.check(fileIndex);
      allFindings.push(...findings);
    } catch (err) {
      process.stderr.write(`[audit] WARN: Checker "${name}" threw an error: ${err.message}\n`);
      allFindings.push({
        domain: name,
        checkId: `${name.toUpperCase().replace(/[^A-Z]/g, '_')}-ERR`,
        status: 'critical',
        description: `Checker "${name}" failed with an internal error: ${err.message}`,
        remediation: 'Investigate the checker error and re-run the audit.',
      });
    }
  }

  // Build report
  const meta = {
    tool: 'backend-audit',
    version: '1.0.0',
    target: targetAbs,
    generated_at: new Date().toISOString(),
  };
  const report = buildReport(allFindings, meta);

  // Ensure output directory exists
  const outputAbs = path.resolve(output);
  const outputDir = path.dirname(outputAbs);
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    process.stderr.write(`[audit] ERROR: Cannot create output directory ${outputDir}: ${err.message}\n`);
    process.exit(1);
  }

  // Write JSON report
  try {
    fs.writeFileSync(outputAbs, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`[audit] ERROR: Failed to write report to ${outputAbs}: ${err.message}\n`);
    process.exit(1);
  }

  // Print summary
  const { summary } = report;
  process.stdout.write('\n========================================\n');
  process.stdout.write('  BACKEND AUDIT REPORT\n');
  process.stdout.write('========================================\n');
  process.stdout.write(`  Total checks : ${summary.total_checks}\n`);
  process.stdout.write(`  Passed       : ${summary.passed}\n`);
  process.stdout.write(`  Failed       : ${summary.failed}\n`);
  process.stdout.write(`  Critical     : ${summary.critical}\n`);
  process.stdout.write(`  Score        : ${summary.score}/100\n`);
  process.stdout.write(`  Ready        : ${report.production_ready ? 'YES' : 'NO'}\n`);
  process.stdout.write('========================================\n');
  process.stdout.write(`  Report saved : ${outputAbs}\n`);
  process.stdout.write('========================================\n\n');

  if (report.summary.critical > 0) {
    process.stdout.write(`  CRITICAL VULNERABILITIES (${report.summary.critical}):\n`);
    for (const v of report.critical_vulnerabilities) {
      process.stdout.write(`  [${v.checkId}] ${v.description}\n`);
    }
    process.stdout.write('\n');
  }

  process.exit(0);
}

main(process.argv.slice(2));
