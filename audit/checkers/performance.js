'use strict';

const DOMAIN = 'Performance';

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {Array}
 */
function check(fileIndex) {
  const findings = [];
  const allContent = fileIndex.sourceFiles.map(f => f.content).join('\n');

  // PERF-001: Compression middleware
  const hasCompression = /require\(['"]compression['"]\)|from\s+['"]compression['"]/i.test(allContent) ||
    /app\.use\s*\(\s*compression/.test(allContent);
  if (hasCompression) {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-001', status: 'passed',
      description: 'Response compression middleware (compression) is registered.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-001', status: 'failed',
      description: 'Response compression middleware is not registered.',
      remediation: 'Install and register the compression package: app.use(compression())',
    });
  }

  // PERF-002: Redis caching for frequently read data
  const hasRedisCaching = /redis\.get|redis\.set|getRedis\(\)\.get|getRedis\(\)\.set|cache\.get|cache\.set/.test(allContent);
  if (hasRedisCaching) {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-002', status: 'passed',
      description: 'Redis caching is used for frequently read data.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-002', status: 'failed',
      description: 'No Redis caching layer detected for frequently read data.',
      remediation: 'Implement Redis caching for user profiles, balances, and other frequently read data.',
    });
  }

  // PERF-003: No synchronous blocking operations in request paths
  const syncBlockingPattern = /fs\.readFileSync|fs\.writeFileSync|fs\.existsSync|crypto\.pbkdf2Sync|execSync|spawnSync/;
  const controllerAndServiceFiles = fileIndex.sourceFiles.filter(f =>
    f.path.includes('/controllers/') || f.path.includes('/services/') || f.path.includes('/middleware/')
  );
  const filesWithSyncOps = controllerAndServiceFiles.filter(f => syncBlockingPattern.test(f.content));
  if (filesWithSyncOps.length > 0) {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-003', status: 'failed',
      description: `Synchronous blocking operations detected in request-handling code: ${filesWithSyncOps.map(f => f.path.split('/').pop()).join(', ')}`,
      remediation: 'Replace synchronous operations (fs.readFileSync, crypto.pbkdf2Sync, etc.) with async alternatives in request handlers.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-003', status: 'passed',
      description: 'No synchronous blocking operations detected in request-handling code paths.',
      remediation: '',
    });
  }

  // PERF-004: Indexes on high-cardinality fields
  const modelFiles = fileIndex.sourceFiles.filter(f => f.path.includes('/models/'));
  const modelContent = modelFiles.map(f => f.content).join('\n');
  const hasIndexes = /index\s*:\s*true|\.index\s*\(|schema\.index\s*\(/.test(modelContent) ||
    /unique\s*:\s*true/.test(modelContent);
  if (hasIndexes) {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-004', status: 'passed',
      description: 'Index definitions found on model fields.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-004', status: 'failed',
      description: 'No index definitions found on high-cardinality fields (userId, email, transactionId).',
      remediation: 'Add indexes to frequently queried fields: schema.index({ userId: 1 }), schema.index({ email: 1 })',
    });
  }

  // PERF-005: No in-memory session storage
  const hasInMemorySession = /session\s*\(\s*\{[^}]*(?!redis|store)[^}]*\}|MemoryStore|session\.MemoryStore/.test(allContent);
  const hasRedisSession = /RedisStore|connect-redis|session.*redis|redis.*session/i.test(allContent);
  if (hasInMemorySession && !hasRedisSession) {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-005', status: 'failed',
      description: 'In-memory session storage detected. Sessions will be lost on server restart and cannot scale horizontally.',
      remediation: 'Use Redis or a database for session storage instead of in-memory storage.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-005', status: 'passed',
      description: 'No in-memory session storage detected. Sessions appear to be stored in Redis or a database.',
      remediation: '',
    });
  }

  // PERF-006: Worker prefetch configured
  const hasPrefetch = /channel\.prefetch|prefetch\s*\(/.test(allContent);
  if (hasPrefetch) {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-006', status: 'passed',
      description: 'Worker uses a prefetch count to limit concurrent message processing.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'PERF-006', status: 'failed',
      description: 'No prefetch count configured for the RabbitMQ worker.',
      remediation: 'Set a prefetch count: channel.prefetch(5) to limit concurrent message processing.',
    });
  }

  return findings;
}

module.exports = { check };
