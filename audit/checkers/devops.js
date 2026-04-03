'use strict';

const DOMAIN = 'DevOps';

// ESLint config file names
const ESLINT_CONFIG_FILES = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  'eslint.config.js',
];

// Prettier config file names
const PRETTIER_CONFIG_FILES = [
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.json',
  'prettier.config.js',
];

// CHANGELOG file names
const CHANGELOG_FILES = [
  'changelog.md',
  'changelog',
  'history.md',
];

// CI/CD path patterns
const CICD_PATTERNS = [
  /\.github[\\/]workflows[\\/].+\.ya?ml$/i,
  /\.gitlab-ci\.ya?ml$/i,
  /jenkinsfile$/i,
  /\.circleci[\\/]config\.ya?ml$/i,
  /azure-pipelines\.ya?ml$/i,
];

// API doc file names (root-level or anywhere in sourceFiles)
const API_DOC_FILES = [
  'openapi.yaml',
  'openapi.yml',
  'swagger.json',
  'swagger.yaml',
  'swagger.yml',
];

// Swagger/OpenAPI npm packages that imply API docs exist
const SWAGGER_PACKAGES = [
  'swagger-jsdoc',
  'swagger-ui-express',
];

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

  const deps = (pkg && pkg.dependencies) ? pkg.dependencies : {};
  const devDeps = (pkg && pkg.devDependencies) ? pkg.devDependencies : {};
  const allDeps = { ...deps, ...devDeps };

  const sourcePaths = fileIndex.sourceFiles.map(f => f.path);

  // ── OPS-001: Missing Dockerfile ──────────────────────────────────────────
  const hasDockerfile =
    fileIndex.rootFiles.dockerfile !== null ||
    sourcePaths.some(p => /dockerfile/i.test(p));

  findings.push(hasDockerfile
    ? {
        checkId: 'OPS-001',
        domain: DOMAIN,
        status: 'passed',
        description: 'Dockerfile detected.',
        remediation: '',
      }
    : {
        checkId: 'OPS-001',
        domain: DOMAIN,
        status: 'failed',
        description: 'No Dockerfile found in the project.',
        remediation: 'Add a Dockerfile to containerise the application and enable consistent deployments.',
      }
  );

  // ── OPS-002: Missing docker-compose.yml ──────────────────────────────────
  const hasDockerCompose = fileIndex.rootFiles.dockerCompose !== null;

  findings.push(hasDockerCompose
    ? {
        checkId: 'OPS-002',
        domain: DOMAIN,
        status: 'passed',
        description: 'docker-compose.yml detected.',
        remediation: '',
      }
    : {
        checkId: 'OPS-002',
        domain: DOMAIN,
        status: 'failed',
        description: 'No docker-compose.yml found in the project root.',
        remediation: 'Add a docker-compose.yml to define and run multi-container Docker applications locally.',
      }
  );

  // ── OPS-003: Missing ESLint config ───────────────────────────────────────
  const hasEslintFile =
    ESLINT_CONFIG_FILES.some(name =>
      sourcePaths.some(p => p.endsWith('/' + name) || p === name)
    ) ||
    sourcePaths.some(p => ESLINT_CONFIG_FILES.some(name => p.toLowerCase().endsWith(name.toLowerCase())));

  const hasEslintPkg = pkg !== null && Object.prototype.hasOwnProperty.call(pkg, 'eslintConfig');

  const hasEslint = hasEslintFile || hasEslintPkg;

  findings.push(hasEslint
    ? {
        checkId: 'OPS-003',
        domain: DOMAIN,
        status: 'passed',
        description: 'ESLint configuration detected.',
        remediation: '',
      }
    : {
        checkId: 'OPS-003',
        domain: DOMAIN,
        status: 'failed',
        description: 'No ESLint configuration found (.eslintrc, .eslintrc.js, .eslintrc.json, eslint.config.js, or "eslintConfig" in package.json).',
        remediation: 'Add an ESLint configuration file and install eslint as a devDependency to enforce consistent code style.',
      }
  );

  // ── OPS-004: Missing Prettier config ─────────────────────────────────────
  const hasPrettierFile =
    PRETTIER_CONFIG_FILES.some(name =>
      sourcePaths.some(p => p.toLowerCase().endsWith(name.toLowerCase()))
    );

  const hasPrettierPkg = pkg !== null && Object.prototype.hasOwnProperty.call(pkg, 'prettier');

  const hasPrettier = hasPrettierFile || hasPrettierPkg;

  findings.push(hasPrettier
    ? {
        checkId: 'OPS-004',
        domain: DOMAIN,
        status: 'passed',
        description: 'Prettier configuration detected.',
        remediation: '',
      }
    : {
        checkId: 'OPS-004',
        domain: DOMAIN,
        status: 'failed',
        description: 'No Prettier configuration found (.prettierrc, .prettierrc.js, .prettierrc.json, prettier.config.js, or "prettier" key in package.json).',
        remediation: 'Add a Prettier configuration file and install prettier as a devDependency to enforce consistent code formatting.',
      }
  );

  // ── OPS-005: Missing CI/CD pipeline file ─────────────────────────────────
  const hasCicd = sourcePaths.some(p => CICD_PATTERNS.some(re => re.test(p)));

  findings.push(hasCicd
    ? {
        checkId: 'OPS-005',
        domain: DOMAIN,
        status: 'passed',
        description: 'CI/CD pipeline configuration detected.',
        remediation: '',
      }
    : {
        checkId: 'OPS-005',
        domain: DOMAIN,
        status: 'failed',
        description: 'No CI/CD pipeline file found (.github/workflows/*.yml, .gitlab-ci.yml, Jenkinsfile, .circleci/config.yml, azure-pipelines.yml).',
        remediation: 'Add a CI/CD pipeline configuration to automate testing, linting, and deployment.',
      }
  );

  // ── OPS-006: Missing API documentation ───────────────────────────────────
  const hasApiDocFile = sourcePaths.some(p => {
    const lower = p.toLowerCase();
    return (
      API_DOC_FILES.some(name => lower.endsWith(name)) ||
      lower.includes('swagger') ||
      lower.includes('openapi')
    );
  });

  const hasSwaggerPkg = SWAGGER_PACKAGES.some(name => allDeps[name] !== undefined);

  const hasApiDoc = hasApiDocFile || hasSwaggerPkg;

  findings.push(hasApiDoc
    ? {
        checkId: 'OPS-006',
        domain: DOMAIN,
        status: 'passed',
        description: 'API documentation configuration detected.',
        remediation: '',
      }
    : {
        checkId: 'OPS-006',
        domain: DOMAIN,
        status: 'failed',
        description: 'No API documentation found (openapi.yaml, swagger.json/yaml, swagger-jsdoc config, or swagger/openapi source files).',
        remediation: 'Add API documentation using OpenAPI/Swagger (e.g. swagger-jsdoc + swagger-ui-express) to improve developer experience.',
      }
  );

  // ── OPS-007: Missing CHANGELOG ────────────────────────────────────────────
  const hasChangelog =
    CHANGELOG_FILES.some(name => {
      // Check rootFiles indirectly via sourceFiles (scanner may include them)
      return sourcePaths.some(p => p.toLowerCase().endsWith(name));
    }) ||
    // Also check rootFiles keys for any changelog-like content
    Object.values(fileIndex.rootFiles).some((val, _idx, _arr) => {
      // rootFiles values are file contents (strings) or null — not paths.
      // We cannot derive filenames from content alone, so we rely on sourceFiles above.
      return false;
    });

  findings.push(hasChangelog
    ? {
        checkId: 'OPS-007',
        domain: DOMAIN,
        status: 'passed',
        description: 'CHANGELOG file detected.',
        remediation: '',
      }
    : {
        checkId: 'OPS-007',
        domain: DOMAIN,
        status: 'failed',
        description: 'No CHANGELOG file found (CHANGELOG.md, CHANGELOG, or HISTORY.md).',
        remediation: 'Add a CHANGELOG.md to document notable changes for each release, following the Keep a Changelog format.',
      }
  );

  // ── OPS-008: Missing `engines` field in package.json ─────────────────────
  const hasEngines = pkg !== null && pkg.engines !== null && typeof pkg.engines === 'object' && Object.keys(pkg.engines).length > 0;

  findings.push(hasEngines
    ? {
        checkId: 'OPS-008',
        domain: DOMAIN,
        status: 'passed',
        description: `"engines" field detected in package.json: ${JSON.stringify(pkg.engines)}.`,
        remediation: '',
      }
    : {
        checkId: 'OPS-008',
        domain: DOMAIN,
        status: 'failed',
        description: 'No "engines" field found in package.json.',
        remediation: 'Add an "engines" field to package.json to specify the required Node.js (and npm/yarn) version, e.g. { "node": ">=18.0.0" }.',
      }
  );

  return findings;
}

module.exports = { check };
