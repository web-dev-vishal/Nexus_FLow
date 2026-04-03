'use strict';

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

/**
 * @typedef {Object} SourceFile
 * @property {string} path - Absolute file path
 * @property {string} content - UTF-8 file content
 */

/**
 * @typedef {Object} RootFiles
 * @property {string|null} packageJson
 * @property {string|null} envExample
 * @property {string|null} gitignore
 * @property {string|null} dockerCompose
 * @property {string|null} serverJs
 * @property {string|null} dockerfileGateway
 * @property {string|null} dockerfileWorker
 * @property {string|null} dockerfile
 */

/**
 * @typedef {Object} FileIndex
 * @property {SourceFile[]} sourceFiles - All .js files under src/
 * @property {RootFiles} rootFiles - Named root-level files
 */

/**
 * Read a file safely, returning null if it doesn't exist or can't be read.
 * @param {string} filePath
 * @returns {string|null}
 */
function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Build a FileIndex from the target directory.
 * @param {string} targetDir - Absolute path to the project root
 * @returns {Promise<FileIndex>}
 */
async function buildFileIndex(targetDir) {
  const sourceFiles = [];

  // Discover all .js files under src/
  let jsPaths = [];
  try {
    jsPaths = await glob('src/**/*.js', {
      cwd: targetDir,
      absolute: true,
      nodir: true,
    });
  } catch (err) {
    process.stderr.write(`[scanner] glob error: ${err.message}\n`);
  }

  for (const filePath of jsPaths) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      sourceFiles.push({ path: filePath, content });
    } catch (err) {
      process.stderr.write(`[scanner] skipping unreadable file ${filePath}: ${err.message}\n`);
    }
  }

  // Also include worker/index.js if outside src/
  const workerPath = path.join(targetDir, 'src', 'worker', 'index.js');
  if (!sourceFiles.find(f => f.path === workerPath)) {
    const workerContent = safeRead(workerPath);
    if (workerContent !== null) {
      sourceFiles.push({ path: workerPath, content: workerContent });
    }
  }

  // Named root-level files
  const r = (name) => safeRead(path.join(targetDir, name));

  const rootFiles = {
    packageJson: r('package.json'),
    envExample: r('.env.example'),
    gitignore: r('.gitignore'),
    dockerCompose: r('docker-compose.yml'),
    serverJs: r('server.js'),
    dockerfileGateway: r('docker/Dockerfile.gateway'),
    dockerfileWorker: r('docker/Dockerfile.worker'),
    dockerfile: r('Dockerfile'),
  };

  return { sourceFiles, rootFiles };
}

module.exports = { buildFileIndex };
