'use strict';

const { check } = require('../checkers/devops.js');

// Empty project — all 8 checks should fail
const emptyResult = check({
  sourceFiles: [],
  rootFiles: { packageJson: null, envExample: null, gitignore: null, dockerCompose: null, dockerfile: null },
});

console.assert(emptyResult.length === 8, `Expected 8 findings, got ${emptyResult.length}`);
emptyResult.forEach(f => {
  console.assert(f.status === 'failed', `${f.checkId} should be failed, got ${f.status}`);
  console.assert(f.domain === 'DevOps', `${f.checkId} domain should be DevOps`);
});

// Full project — all 8 checks should pass
const fullResult = check({
  sourceFiles: [
    { path: '/project/docker/Dockerfile.gateway', content: '' },
    { path: '/project/.github/workflows/ci.yml', content: '' },
    { path: '/project/docs/openapi.yaml', content: '' },
    { path: '/project/CHANGELOG.md', content: '' },
    { path: '/project/.eslintrc.js', content: '' },
    { path: '/project/.prettierrc', content: '' },
  ],
  rootFiles: {
    packageJson: JSON.stringify({
      engines: { node: '>=18' },
      eslintConfig: {},
      prettier: {},
    }),
    envExample: null,
    gitignore: null,
    dockerCompose: 'version: "3"',
    dockerfile: 'FROM node:18',
  },
});

console.assert(fullResult.length === 8, `Expected 8 findings, got ${fullResult.length}`);
fullResult.forEach(f => {
  console.assert(f.status === 'passed', `${f.checkId} should be passed, got ${f.status}`);
});

console.log('All assertions passed.');
