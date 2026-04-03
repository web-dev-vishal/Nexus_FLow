'use strict';

const DOMAIN = 'Socket.IO';

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {Array}
 */
function check(fileIndex) {
  const findings = [];

  // Find Socket.IO related files
  const socketFiles = fileIndex.sourceFiles.filter(f =>
    f.path.includes('websocket') || f.path.includes('socket') || f.path.includes('io')
  );
  const socketContent = socketFiles.map(f => f.content).join('\n');

  // SIO-001: Socket connections require authentication
  const hasSocketAuth = /authenticate|jwt\.verify|token.*verify|verify.*token/i.test(socketContent) ||
    /socket\.on\s*\(\s*['"]authenticate['"]/.test(socketContent);
  if (hasSocketAuth) {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-001', status: 'passed',
      description: 'Socket connections require authentication (token verification) before receiving application events.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-001', status: 'critical',
      description: 'Socket connections do not require authentication. Any client can receive application events.',
      remediation: 'Implement socket authentication middleware that verifies a token before allowing event subscriptions.',
    });
  }

  // SIO-002: Socket auth uses same secret as HTTP middleware
  const socketUsesAccessSecret = /process\.env\.ACCESS_SECRET/.test(socketContent);
  if (socketUsesAccessSecret) {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-002', status: 'passed',
      description: 'Socket authentication uses the same ACCESS_SECRET as the HTTP auth middleware.',
      remediation: '',
    });
  } else if (socketFiles.length > 0) {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-002', status: 'critical',
      description: 'Socket authentication does not use process.env.ACCESS_SECRET — may use a different secret than HTTP middleware.',
      remediation: 'Ensure socket token verification uses the same secret (process.env.ACCESS_SECRET) as the HTTP auth middleware.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-002', status: 'failed',
      description: 'No Socket.IO files found to verify authentication secret.',
      remediation: 'Implement Socket.IO authentication using the same secret as the HTTP auth middleware.',
    });
  }

  // SIO-003: Room isolation (user:<userId>)
  const hasRoomIsolation = /socket\.join\s*\(\s*[`'"]user[:`'"]|join\s*\(\s*`user:\$\{/.test(socketContent) ||
    /user:\$\{userId\}|user:\$\{.*id\}/.test(socketContent);
  if (hasRoomIsolation) {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-003', status: 'passed',
      description: 'Each authenticated user is placed in an isolated room (user:<userId>).',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-003', status: 'critical',
      description: 'No user room isolation detected. Events may be broadcast to all connected clients.',
      remediation: 'Place each authenticated user in an isolated room: socket.join(`user:${userId}`)',
    });
  }

  // SIO-004: Disconnect handler cleans up client map
  const hasDisconnectCleanup = /disconnect.*delete|delete.*disconnect|clients\.delete|sockets\.delete/i.test(socketContent) ||
    /on\s*\(\s*['"]disconnect['"]/.test(socketContent);
  if (hasDisconnectCleanup) {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-004', status: 'passed',
      description: 'Disconnect events are handled and the client map is cleaned up.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-004', status: 'failed',
      description: 'No disconnect cleanup handler detected. Disconnected sockets may remain in the client map.',
      remediation: 'Handle the disconnect event and remove the socket from the client map.',
    });
  }

  // SIO-005: pingTimeout and pingInterval configured
  const hasPingConfig = /pingTimeout|pingInterval/.test(socketContent);
  if (hasPingConfig) {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-005', status: 'passed',
      description: 'pingTimeout and pingInterval are explicitly configured.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-005', status: 'failed',
      description: 'pingTimeout and pingInterval are not explicitly configured.',
      remediation: 'Configure pingTimeout and pingInterval in the Socket.IO server options to detect stale connections.',
    });
  }

  // SIO-006: Incoming socket event payloads validated
  const hasPayloadValidation = /if\s*\(!.*token\)|if\s*\(!Array\.isArray|typeof.*!==|payload.*validate|schema\.parse/i.test(socketContent);
  if (hasPayloadValidation) {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-006', status: 'passed',
      description: 'Incoming socket event payloads are validated before processing.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-006', status: 'failed',
      description: 'Socket event handlers may accept arbitrary payloads without validation.',
      remediation: 'Validate all incoming socket event payloads before processing them.',
    });
  }

  // SIO-007: CORS origin not wildcard in production
  const socketCorsWildcard = /cors\s*:\s*\{[^}]*origin\s*:[^}]*['"]\*['"]/.test(socketContent) ||
    /\|\|\s*['"]\*['"]/.test(socketContent);
  if (socketCorsWildcard) {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-007', status: 'failed',
      description: 'Socket.IO CORS origin has a wildcard ("*") fallback. In production this allows any origin.',
      remediation: 'Set an explicit CORS origin for Socket.IO without a wildcard fallback.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'SIO-007', status: 'passed',
      description: 'Socket.IO CORS origin is not set to wildcard.',
      remediation: '',
    });
  }

  return findings;
}

module.exports = { check };
