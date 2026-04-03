'use strict';

const DOMAIN = 'MongoDB';

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {Array}
 */
function check(fileIndex) {
  const findings = [];
  const allContent = fileIndex.sourceFiles.map(f => f.content).join('\n');

  // MDB-001: Models have field-level validation
  const modelFiles = fileIndex.sourceFiles.filter(f => f.path.includes('/models/'));
  const modelsWithoutValidation = modelFiles.filter(f => {
    // Check if the model has at least some validation (required, type, enum, minlength, etc.)
    return !/required\s*:|type\s*:|enum\s*:|minlength\s*:|min\s*:|max\s*:/.test(f.content);
  });
  if (modelFiles.length === 0) {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-001', status: 'failed',
      description: 'No Mongoose model files found.',
      remediation: 'Define Mongoose models with field-level validation.',
    });
  } else if (modelsWithoutValidation.length > 0) {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-001', status: 'failed',
      description: `${modelsWithoutValidation.length} model file(s) lack field-level validation: ${modelsWithoutValidation.map(f => f.path.split('/').pop()).join(', ')}`,
      remediation: 'Add required, type, enum, minlength, and other validators to all model fields.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-001', status: 'passed',
      description: 'All Mongoose models define field-level validation.',
      remediation: '',
    });
  }

  // MDB-002: Unique fields have unique: true index
  const hasUniqueIndex = /unique\s*:\s*true/.test(allContent);
  if (hasUniqueIndex) {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-002', status: 'passed',
      description: 'Unique fields have unique: true index defined in the schema.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-002', status: 'failed',
      description: 'No unique: true index found in any model schema.',
      remediation: 'Add unique: true to fields that must be unique (e.g., email).',
    });
  }

  // MDB-003: Password not returned in queries
  const hasPasswordExclusion = /\.select\s*\(\s*['"]-password|select\s*:\s*false/.test(allContent);
  if (hasPasswordExclusion) {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-003', status: 'passed',
      description: 'Sensitive fields (password) are excluded from query results using .select("-password") or select: false.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-003', status: 'critical',
      description: 'No evidence of password field exclusion from query results.',
      remediation: 'Use .select("-password") or set select: false on the password field in the schema.',
    });
  }

  // MDB-004: Pagination on list endpoints
  const hasPagination = /\.limit\s*\(|\.skip\s*\(|limit\s*:|skip\s*:|page\s*:|cursor/.test(allContent);
  if (hasPagination) {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-004', status: 'passed',
      description: 'Pagination (limit/skip or cursor-based) is implemented for list endpoints.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-004', status: 'failed',
      description: 'No pagination detected for list endpoints. Unbounded queries can cause performance issues.',
      remediation: 'Implement pagination using .limit() and .skip() or cursor-based pagination for all list endpoints.',
    });
  }

  // MDB-005: MongoDB transactions for multi-doc writes
  const hasTransactions = /session\s*\.|startSession|withTransaction|startTransaction|commitTransaction/.test(allContent);
  if (hasTransactions) {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-005', status: 'passed',
      description: 'MongoDB transactions are used for multi-document write operations.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-005', status: 'failed',
      description: 'No MongoDB transaction usage detected. Multi-document writes may not be atomic.',
      remediation: 'Use MongoDB sessions and transactions for multi-document write operations that must be atomic.',
    });
  }

  // MDB-006: Connection string from env var
  const hardcodedMongoUri = /mongodb:\/\/[^'"]*@|mongodb\+srv:\/\/[^'"]*@/.test(allContent) &&
    !/process\.env\.MONGO_URI|process\.env\.MONGODB_URI|process\.env\.DATABASE_URL/.test(allContent);
  if (hardcodedMongoUri) {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-006', status: 'critical',
      description: 'Hardcoded MongoDB connection string with credentials found in source code.',
      remediation: 'Move the MongoDB connection string to an environment variable (MONGO_URI).',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-006', status: 'passed',
      description: 'MongoDB connection string is read from an environment variable.',
      remediation: '',
    });
  }

  // MDB-007: Connection pool settings configured
  const hasPoolSettings = /maxPoolSize|serverSelectionTimeoutMS|socketTimeoutMS/.test(allContent);
  if (hasPoolSettings) {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-007', status: 'passed',
      description: 'MongoDB connection pool settings (maxPoolSize, serverSelectionTimeoutMS) are explicitly configured.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'MDB-007', status: 'failed',
      description: 'MongoDB connection pool settings are not explicitly configured.',
      remediation: 'Configure maxPoolSize and serverSelectionTimeoutMS in the mongoose.connect() options.',
    });
  }

  return findings;
}

module.exports = { check };
