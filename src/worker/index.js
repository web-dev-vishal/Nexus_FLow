// Worker service — runs as a separate process from the API gateway.
// It listens to the RabbitMQ payout_queue and processes each payout job:
//   1. Re-validates the transaction exists and isn't already processed
//   2. Deducts the balance atomically in Redis
//   3. Marks the transaction as completed in MongoDB
//   4. Releases the distributed lock
//   5. Publishes a WebSocket event so the user sees the result in real time
//   6. Runs anomaly detection in the background (non-blocking)
//
// If anything fails, it rolls back the balance and marks the transaction as failed.

import "dotenv/config";

import database from "../config/database.js";
import redisConnection from "../config/redis.js";
import rabbitmq from "../config/rabbitmq.js";

import DistributedLock from "../services/distributed-lock.service.js";
import BalanceService from "../services/balance.service.js";
import MessageConsumer from "../services/message-consumer.service.js";
import GroqClient from "../services/groq.service.js";
import WebhookService from "../services/webhook.service.js";
import NotificationService from "../services/notification.service.js";
import SpendingLimitService from "../services/spending-limit.service.js";

import Transaction from "../models/transaction.model.js";
import PayoutUser from "../models/payout-user.model.js";
import AuditLog from "../models/audit-log.model.js";

import logger from "../utils/logger.js";
import { calculateDuration } from "../utils/helpers.js";

class WorkerService {
    constructor() {
        this.redis    = null;
        this.balance  = null;
        this.lock     = null;
        this.consumer = null;
        this.groq     = null;
        this.webhooks = null;
        this.notifications = null;
        this.spendingLimits = null;
        this.stopping = false;
    }

    // Connect to all dependencies before starting to consume messages.
    // If any connection fails, the worker exits — better to fail fast than process with broken deps.
    async initialize() {
        logger.info("Starting worker service...");

        await database.connect();

        await redisConnection.connect();
        this.redis = redisConnection.getClient();

        await rabbitmq.connect();

        // Wire up services with the shared Redis client
        this.balance = new BalanceService(this.redis);
        this.lock    = new DistributedLock(this.redis);
        this.groq    = new GroqClient();

        // New feature services
        this.webhooks       = new WebhookService();
        this.notifications  = new NotificationService();
        this.spendingLimits = new SpendingLimitService(this.redis);

        logger.info("Worker service initialized");
    }

    // Process a single payout message from the queue.
    // This is called by MessageConsumer for each message it receives.
    async processMessage(payload) {
        const startTime = new Date();
        const { transactionId, userId, amount, currency, lockValue } = payload;

        let transaction = null;

        try {
            // Load the transaction record — it was created by the API gateway before publishing
            transaction = await Transaction.findByTransactionId(transactionId);

            if (!transaction) throw new Error("TRANSACTION_NOT_FOUND");

            // Idempotency guard — if the message was delivered twice (RabbitMQ can do this),
            // skip it silently instead of double-processing
            if (transaction.status === "completed") {
                logger.warn("Transaction already completed — skipping", { transactionId });
                return;
            }

            if (transaction.status === "processing") {
                throw new Error("ALREADY_PROCESSING");
            }

            // Mark as processing so concurrent workers don't pick it up
            await transaction.markAsProcessing();
            await AuditLog.logAction(transactionId, userId, "PAYOUT_PROCESSING", { status: "processing" });
            await this._publishWsEvent(userId, "PAYOUT_PROCESSING", { transactionId, amount, currency });

            // Re-check balance in Redis — the distributed lock ensures no one else is here
            const currentBalance = await this.balance.getBalance(userId);
            if (currentBalance === null) throw new Error("BALANCE_NOT_FOUND");
            if (currentBalance < amount)  throw new Error("INSUFFICIENT_BALANCE");

            // Atomic deduction via Lua script — safe against concurrent writes
            const newBalance = await this.balance.deductBalance(userId, amount);

            await AuditLog.logAction(transactionId, userId, "BALANCE_DEDUCTED", {
                previousBalance: currentBalance,
                newBalance,
                amount,
            });

            // Update the transaction record with the new balance
            transaction.balanceAfter = newBalance;
            await transaction.markAsCompleted();

            // Sync the new balance back to MongoDB so it survives a Redis flush
            await PayoutUser.updateOne(
                { userId },
                {
                    $set:         { balance: newBalance },
                    $inc:         { "metadata.totalPayouts": 1, "metadata.totalPayoutAmount": amount },
                    $currentDate: { "metadata.lastPayoutAt": true },
                }
            );

            // Release the distributed lock so the user can make another payout
            if (lockValue) {
                await this.lock.release(userId, lockValue);
            } else {
                // Fallback: force-delete the lock key if we don't have the lock value
                await this.redis.del(`lock:${userId}`);
            }

            await AuditLog.logAction(transactionId, userId, "LOCK_RELEASED", { success: true });

            // Notify the user via WebSocket that their payout completed
            await this._publishWsEvent(userId, "PAYOUT_COMPLETED", { transactionId, amount, currency, newBalance });

            await AuditLog.logAction(transactionId, userId, "PAYOUT_COMPLETED", {
                amount,
                newBalance,
                processingTimeMs: calculateDuration(startTime),
            });

            // Fire webhook and notification in the background — don't block the worker
            this.webhooks.deliverEvent(userId, "payout.completed", { transactionId, amount, currency, newBalance })
                .catch((err) => logger.error("Webhook delivery error (completed):", err.message));

            // Get user contact info for the notification
            PayoutUser.findByUserId(userId).then((user) => {
                if (user) {
                    this.notifications.notifyPayoutCompleted(
                        { email: user.email, phone: user.phone },
                        { transactionId, amount, currency, newBalance }
                    ).catch((err) => logger.error("Notification error (completed):", err.message));
                }
            }).catch(() => {});

            // Record the spend against the user's spending limit counters
            this.spendingLimits.recordSpend(userId, amount)
                .catch((err) => logger.error("Spending limit record error:", err.message));

            // Run anomaly detection in the background — don't await it so it doesn't slow down the response
            this._detectAnomaly(transaction, userId).catch((err) =>
                logger.error("Anomaly detection error:", err.message)
            );

            logger.info("Payout processed successfully", {
                transactionId,
                userId,
                amount,
                processingTimeMs: calculateDuration(startTime),
            });
        } catch (error) {
            logger.error("Payout processing failed", {
                transactionId,
                userId,
                error:            error.message,
                processingTimeMs: calculateDuration(startTime),
            });

            // Roll back the balance for unexpected errors.
            // Don't roll back for logic errors like "insufficient balance" — there's nothing to undo.
            const nonRollbackErrors = new Set(["TRANSACTION_NOT_FOUND", "ALREADY_PROCESSING", "INSUFFICIENT_BALANCE"]);
            if (!nonRollbackErrors.has(error.message)) {
                try {
                    await this.balance.addBalance(userId, amount);
                    await AuditLog.logAction(transactionId, userId, "BALANCE_RESTORED", { amount, reason: "error_rollback" });
                    logger.info("Balance rolled back", { transactionId, amount });
                } catch (rollbackErr) {
                    logger.error("Balance rollback failed", { transactionId, error: rollbackErr.message });
                }
            }

            if (transaction) await transaction.markAsFailed(error);

            // Notify the user that their payout failed
            await this._publishWsEvent(userId, "PAYOUT_FAILED", { transactionId, amount, currency, error: error.message });
            await AuditLog.logAction(transactionId, userId, "PAYOUT_FAILED", {
                error:            error.message,
                processingTimeMs: calculateDuration(startTime),
            });

            // Fire webhook and notification for the failure — background, non-blocking
            this.webhooks.deliverEvent(userId, "payout.failed", { transactionId, amount, currency, error: error.message })
                .catch((err) => logger.error("Webhook delivery error (failed):", err.message));

            PayoutUser.findByUserId(userId).then((user) => {
                if (user) {
                    this.notifications.notifyPayoutFailed(
                        { email: user.email, phone: user.phone },
                        { transactionId, amount, currency, reason: error.message }
                    ).catch((err) => logger.error("Notification error (failed):", err.message));
                }
            }).catch(() => {});

            // Re-throw so MessageConsumer knows to retry or dead-letter the message
            throw error;
        }
    }

    // Publish a WebSocket event via Redis pub/sub.
    // The API gateway subscribes to this channel and forwards events to connected clients.
    async _publishWsEvent(userId, event, data) {
        try {
            await this.redis.publish(
                "websocket:events",
                JSON.stringify({ userId, event, data, timestamp: new Date().toISOString() })
            );
        } catch (error) {
            // Non-critical — don't fail the payout if the WebSocket event fails
            logger.error("Failed to publish WebSocket event", { userId, event, error: error.message });
        }
    }

    // Run AI anomaly detection on a completed transaction.
    // Compares the transaction against the user's last 100 transactions from the past 30 days.
    // Logs an audit event if the AI flags it as unusual.
    async _detectAnomaly(transaction, userId) {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const history = await Transaction.find({
            userId,
            status:    "completed",
            createdAt: { $gte: thirtyDaysAgo },
            _id:       { $ne: transaction._id },  // Exclude the current transaction
        })
            .select("amount currency createdAt")
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        // Can't detect anomalies without any history
        if (history.length === 0) return;

        const result = await this.groq.detectAnomaly(
            { amount: transaction.amount, currency: transaction.currency, createdAt: transaction.createdAt },
            history
        );

        if (result.isAnomaly) {
            await AuditLog.logAction(transaction.transactionId, userId, "ANOMALY_DETECTED", {
                confidence:   result.confidence,
                explanation:  result.explanation,
                aiAvailable:  result.aiAvailable,
                historyCount: history.length,
            });

            logger.warn("Transaction anomaly detected", {
                transactionId: transaction.transactionId,
                userId,
                confidence:    result.confidence,
            });
        }
    }

    // Start consuming messages from the queue.
    async start() {
        this.consumer = new MessageConsumer(
            rabbitmq.getChannel(),
            this.processMessage.bind(this)
        );

        await this.consumer.startConsuming("payout_queue");

        logger.info("Worker consuming from payout_queue", {
            concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 5,
        });
    }

    // Graceful shutdown — stop consuming, wait for in-flight messages, then disconnect.
    async shutdown() {
        if (this.stopping) return;
        this.stopping = true;

        logger.info("Worker shutting down...");

        // Stop accepting new messages
        if (this.consumer) await this.consumer.stopConsuming();

        // Give in-flight messages 5 seconds to finish processing
        await new Promise((r) => setTimeout(r, 5000));

        await rabbitmq.disconnect();
        await redisConnection.disconnect();
        await database.disconnect();

        logger.info("Worker shutdown complete");
        process.exit(0);
    }
}

const worker = new WorkerService();

// Start the worker
(async () => {
    try {
        await worker.initialize();
        await worker.start();
    } catch (error) {
        logger.error("Worker failed to start:", error.message);
        process.exit(1);
    }
})();

// Handle Docker stop and Ctrl+C gracefully
process.on("SIGTERM", () => worker.shutdown());
process.on("SIGINT",  () => worker.shutdown());

// These two should never fire in production — if they do, something is seriously wrong
process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception in worker:", error);
    worker.shutdown();
});

process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection in worker:", reason);
    worker.shutdown();
});
