// Centralised Prometheus metrics registry.
//
// All custom metrics are defined here so they are created once and reused
// across the codebase. Importing this module is safe to do multiple times —
// prom-client deduplicates registrations.
//
// Metrics exposed:
//   Business counters  — payout_initiated_total, payout_completed_total,
//                        payout_failed_total, fraud_blocked_total
//   Business gauges    — payout_processing_duration_ms (histogram)
//   Queue gauges       — rabbitmq_queue_depth (gauge, polled periodically)
//   Existing           — http_request_duration_seconds (defined in middleware.js)

import client from "prom-client";

// ── Business counters ─────────────────────────────────────────────────────────

export const payoutInitiatedCounter = new client.Counter({
    name:    "payout_initiated_total",
    help:    "Total number of payout requests initiated",
    labelNames: ["currency", "source"],
});

export const payoutCompletedCounter = new client.Counter({
    name:    "payout_completed_total",
    help:    "Total number of payouts successfully completed",
    labelNames: ["currency"],
});

export const payoutFailedCounter = new client.Counter({
    name:    "payout_failed_total",
    help:    "Total number of payouts that failed",
    labelNames: ["reason"],
});

export const fraudBlockedCounter = new client.Counter({
    name:    "fraud_blocked_total",
    help:    "Total number of payouts blocked by fraud scoring",
});

export const spendingLimitBlockedCounter = new client.Counter({
    name:    "spending_limit_blocked_total",
    help:    "Total number of payouts blocked by spending limits",
});

// ── Business histograms ───────────────────────────────────────────────────────

export const payoutProcessingDuration = new client.Histogram({
    name:    "payout_processing_duration_ms",
    help:    "End-to-end payout processing time in milliseconds (worker side)",
    labelNames: ["status"],
    buckets: [100, 250, 500, 1000, 2000, 5000, 10000, 30000],
});

export const fraudScoringDuration = new client.Histogram({
    name:    "fraud_scoring_duration_ms",
    help:    "Time taken by the AI fraud scoring call in milliseconds",
    buckets: [50, 100, 250, 500, 1000, 2000, 5000],
});

// ── Queue depth gauge ─────────────────────────────────────────────────────────

export const queueDepthGauge = new client.Gauge({
    name:    "rabbitmq_queue_depth",
    help:    "Number of messages currently waiting in each RabbitMQ queue",
    labelNames: ["queue"],
});

// Poll RabbitMQ queue depths every 30 seconds using the amqplib channel.
// Call this once after the RabbitMQ connection is established.
export function startQueueDepthPolling(getChannelFn, intervalMs = 30000) {
    const queues = [
        "payout_queue",
        "workflow_queue",
        "message_events_queue",
        "notification_queue",
        "payout_dlq",
        "workflow_dlq",
        "message_events_dlq",
        "notification_dlq",
    ];

    const poll = async () => {
        try {
            const ch = getChannelFn();
            for (const queue of queues) {
                try {
                    const info = await ch.checkQueue(queue);
                    queueDepthGauge.set({ queue }, info.messageCount);
                } catch {
                    // Queue might not exist yet — skip silently
                }
            }
        } catch {
            // Channel not available — skip this poll cycle
        }
    };

    // Run immediately, then on the interval
    poll();
    return setInterval(poll, intervalMs);
}
