'use strict';

const DOMAIN = 'RabbitMQ';

/**
 * @param {import('../lib/scanner').FileIndex} fileIndex
 * @returns {Array}
 */
function check(fileIndex) {
  const findings = [];
  const allContent = fileIndex.sourceFiles.map(f => f.content).join('\n');

  // RMQ-001: Durable queues
  const hasDurableQueue = /assertQueue\s*\([^)]*durable\s*:\s*true/.test(allContent) ||
    /durable\s*:\s*true/.test(allContent);
  if (hasDurableQueue) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-001', status: 'passed',
      description: 'Queues are declared with durable: true.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-001', status: 'critical',
      description: 'No durable queue declarations found. Queues will not survive RabbitMQ restarts.',
      remediation: 'Declare all queues with durable: true.',
    });
  }

  // RMQ-002: Persistent messages
  const hasPersistentMessages = /persistent\s*:\s*true/.test(allContent) ||
    /deliveryMode\s*:\s*2/.test(allContent);
  if (hasPersistentMessages) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-002', status: 'passed',
      description: 'Messages are published with persistent: true (delivery mode 2).',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-002', status: 'critical',
      description: 'Messages are not published with persistent: true. Messages will be lost on RabbitMQ restart.',
      remediation: 'Set persistent: true in sendToQueue options.',
    });
  }

  // RMQ-003: Manual acknowledgment (noAck: false)
  const hasManualAck = /noAck\s*:\s*false/.test(allContent) ||
    /channel\.ack\s*\(/.test(allContent);
  const hasAutoAck = /noAck\s*:\s*true/.test(allContent);
  if (hasAutoAck) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-003', status: 'critical',
      description: 'Consumer uses noAck: true (auto-acknowledgment). Messages will be lost if processing fails.',
      remediation: 'Set noAck: false and manually call channel.ack(msg) on success, channel.nack(msg) on failure.',
    });
  } else if (hasManualAck) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-003', status: 'passed',
      description: 'Consumer uses manual acknowledgment (noAck: false) and calls channel.ack(msg) on success.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-003', status: 'critical',
      description: 'No message acknowledgment pattern detected.',
      remediation: 'Set noAck: false and manually ack/nack messages.',
    });
  }

  // RMQ-004: Dead Letter Exchange and DLQ configured
  const hasDlq = /dead.letter|dlx|dlq|x-dead-letter/i.test(allContent);
  if (hasDlq) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-004', status: 'passed',
      description: 'Dead-Letter Exchange (DLX) and Dead-Letter Queue (DLQ) are configured.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-004', status: 'failed',
      description: 'No Dead-Letter Exchange or DLQ configuration found.',
      remediation: 'Configure a DLX and DLQ for the main processing queue to capture failed messages.',
    });
  }

  // RMQ-005: Retry mechanism with max retry count
  const hasRetryLimit = /maxRetries|max_retries|MAX_RETRY|maxRetryAttempts|MAX_RETRY_ATTEMPTS/.test(allContent);
  const hasRetryLogic = /retryCount|retry_count|x-retry-count/.test(allContent);
  if (hasRetryLimit && hasRetryLogic) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-005', status: 'passed',
      description: 'Retry mechanism with a maximum retry count is implemented.',
      remediation: '',
    });
  } else if (hasRetryLogic && !hasRetryLimit) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-005', status: 'failed',
      description: 'Retry logic exists but no maximum retry count is enforced.',
      remediation: 'Add a maximum retry count to prevent infinite retry loops.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-005', status: 'failed',
      description: 'No retry mechanism detected for failed messages.',
      remediation: 'Implement a retry mechanism with a maximum retry count before routing to DLQ.',
    });
  }

  // RMQ-006: Idempotency guard
  const hasIdempotencyGuard = /idempotent|already.completed|status.*completed|completed.*status|COMPLETED|transaction.*status/i.test(allContent) &&
    /skip|return|already/i.test(allContent);
  if (hasIdempotencyGuard) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-006', status: 'passed',
      description: 'Consumer checks for idempotency before processing (skips already-completed transactions).',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-006', status: 'failed',
      description: 'No idempotency guard detected in the message consumer.',
      remediation: 'Check transaction status before processing to skip already-completed transactions and prevent duplicate processing.',
    });
  }

  // RMQ-007: Reconnection strategy with max attempt limit
  const hasReconnection = /reconnect|_scheduleReconnect|scheduleReconnect/.test(allContent);
  const hasMaxAttempts = /maxReconnectAttempts|max_reconnect|MAX_RECONNECT/.test(allContent);
  if (hasReconnection && hasMaxAttempts) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-007', status: 'passed',
      description: 'RabbitMQ connection implements a reconnection strategy with a maximum attempt limit.',
      remediation: '',
    });
  } else if (hasReconnection) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-007', status: 'failed',
      description: 'Reconnection logic exists but no maximum attempt limit is enforced.',
      remediation: 'Add a maximum reconnect attempt limit to prevent infinite reconnection loops.',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-007', status: 'failed',
      description: 'No RabbitMQ reconnection strategy detected.',
      remediation: 'Implement a reconnection strategy with exponential backoff and a maximum attempt limit.',
    });
  }

  // RMQ-008: Connection error logged and not swallowed
  const rabbitFiles = fileIndex.sourceFiles.filter(f =>
    f.path.includes('rabbitmq') || f.path.includes('amqp')
  );
  const rabbitContent = rabbitFiles.map(f => f.content).join('\n');
  const connectionErrorLogged = /logger\.(error|warn)|console\.(error|warn)/.test(rabbitContent) &&
    /catch\s*\(/.test(rabbitContent);
  if (connectionErrorLogged) {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-008', status: 'passed',
      description: 'RabbitMQ connection errors are logged and not swallowed.',
      remediation: '',
    });
  } else {
    findings.push({
      domain: DOMAIN, checkId: 'RMQ-008', status: 'failed',
      description: 'RabbitMQ connection errors may be swallowed without logging.',
      remediation: 'Ensure connection errors are logged and the application exits gracefully if RabbitMQ is unavailable at startup.',
    });
  }

  return findings;
}

module.exports = { check };
