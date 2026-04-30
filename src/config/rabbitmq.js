// This file manages the RabbitMQ connection and queue setup.
// RabbitMQ is our message queue — when a payout is requested, we publish a message here
// and the worker process picks it up and does the actual processing.

import amqp from "amqplib";
import logger from "../utils/logger.js";

class RabbitMQConnection {
    constructor() {
        this.connection = null;
        this.channel = null;
        this.isConnected = false;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.channelPool = [];
        this.poolIndex = 0;
        this.poolMin = parseInt(process.env.RABBITMQ_POOL_MIN) || 2;
        this.poolMax = parseInt(process.env.RABBITMQ_POOL_MAX) || 10;
    }

    async connect() {
        try {
            // Connect to RabbitMQ using the URL from .env
            // heartbeat: 60 sends a "are you still there?" ping every 60 seconds
            // Without this, a silent network failure could leave us thinking we're connected
            this.connection = await amqp.connect(process.env.RABBITMQ_URL, { heartbeat: 60 });

            this.isConnected = true;
            this.reconnectAttempts = 0; // reset counter on successful connect

            // A channel is like a virtual connection inside the main connection
            // We use one shared channel for the whole app
            this.channel = await this.connection.createChannel();

            // prefetch tells RabbitMQ how many messages to send us at once before we ack them
            // This prevents the worker from being overwhelmed with too many messages at once
            await this.channel.prefetch(parseInt(process.env.WORKER_CONCURRENCY) || 5);

            // Create the queues and exchanges we need
            await this._setupQueues();

            // Initialise the channel pool for publishing/consuming
            await this._initChannelPool();

            // If the connection drops while the app is running, log it and try to reconnect
            this.connection.on("error", (err) => {
                logger.error("RabbitMQ connection error:", err.message);
                this.isConnected = false;
            });

            // "close" fires when the connection drops — schedule a reconnect
            this.connection.on("close", () => {
                logger.warn("RabbitMQ connection closed");
                this.isConnected = false;
                this._scheduleReconnect();
            });

            // Channel errors are usually caused by bad queue operations
            this.channel.on("error", (err) => {
                logger.error("RabbitMQ channel error:", err.message);
            });

            logger.info("RabbitMQ connected and channel ready");
        } catch (error) {
            logger.error("RabbitMQ connection failed:", error.message);
            this.isConnected = false;
            this._scheduleReconnect();
            throw error;
        }
    }

    async _setupQueues() {
        // ── Payout queues ─────────────────────────────────────────────────────
        await this.channel.assertExchange("dlx_payout", "direct", { durable: true });
        await this.channel.assertQueue("payout_dlq", { durable: true });
        await this.channel.bindQueue("payout_dlq", "dlx_payout", "payout");

        await this.channel.assertQueue("payout_queue", {
            durable: true,
            arguments: {
                "x-dead-letter-exchange":    "dlx_payout",
                "x-dead-letter-routing-key": "payout",
                "x-message-ttl":             86400000,
            },
        });

        // ── NexusFlow: Workflow execution queue ───────────────────────────────
        // Workflow jobs are published here when a workflow is triggered.
        // The workflow worker consumes from this queue and runs each node.
        await this.channel.assertExchange("dlx_workflow", "direct", { durable: true });
        await this.channel.assertQueue("workflow_dlq", { durable: true });
        await this.channel.bindQueue("workflow_dlq", "dlx_workflow", "workflow");

        await this.channel.assertQueue("workflow_queue", {
            durable: true,
            arguments: {
                "x-dead-letter-exchange":    "dlx_workflow",
                "x-dead-letter-routing-key": "workflow",
                "x-message-ttl":             3600000, // 1 hour — stale workflow jobs get dead-lettered
            },
        });

        // ── NexusFlow: Message events queue ──────────────────────────────────
        // Every new message is published here so workflow triggers can be evaluated
        // and analytics can be tracked without blocking the HTTP response.
        await this.channel.assertQueue("message_events_queue", {
            durable: true,
            arguments: {
                "x-message-ttl": 3600000,
            },
        });

        // ── NexusFlow: Notification delivery queue ────────────────────────────
        // In-app and email notifications are queued here for async delivery.
        await this.channel.assertQueue("notification_queue", {
            durable: true,
            arguments: {
                "x-message-ttl": 3600000,
            },
        });

        logger.info("RabbitMQ queues configured (payout + workflow + message events + notifications)");
    }

    async _initChannelPool() {
        // Create poolMin channels upfront; more can be added up to poolMax on demand
        for (let i = 0; i < this.poolMin; i++) {
            const ch = await this.connection.createChannel();
            await ch.prefetch(parseInt(process.env.WORKER_CONCURRENCY) || 5);
            this.channelPool.push(ch);
        }
        logger.info(`RabbitMQ channel pool initialised (${this.poolMin} channels)`);
    }

    _scheduleReconnect() {
        // Don't schedule a new reconnect if one is already pending
        if (this.reconnectTimer) return;

        // If we've hit the limit, stop trying — something is seriously wrong
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.error("RabbitMQ max reconnect attempts reached — giving up");
            return;
        }

        this.reconnectAttempts++;

        // Wait longer between each attempt: 5s, 10s, 15s...
        // This avoids hammering the server when it's down (called "backoff")
        const delay = 5000 * this.reconnectAttempts;
        logger.info(`RabbitMQ reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
            } catch {
                // connect() already called _scheduleReconnect() on failure
            }
        }, delay);
    }

    async disconnect() {
        // Cancel any pending reconnect timer so we don't reconnect while shutting down
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Close pool channels
        for (const ch of this.channelPool) {
            try { await ch.close(); } catch { /* ignore */ }
        }
        this.channelPool = [];

        // Close setup channel, then the connection
        if (this.channel) {
            await this.channel.close();
            this.channel = null;
        }

        if (this.connection) {
            await this.connection.close();
            this.connection = null;
        }

        this.isConnected = false;
        logger.info("RabbitMQ disconnected gracefully");
    }

    // Returns the channel so services can publish/consume messages
    getChannel() {
        if (!this.isConnected) {
            throw new Error("RabbitMQ channel not available");
        }
        // Fall back to single channel if pool not yet initialised
        if (this.channelPool.length === 0) {
            if (!this.channel) throw new Error("RabbitMQ channel not available");
            return this.channel;
        }
        // Round-robin across pool
        const ch = this.channelPool[this.poolIndex % this.channelPool.length];
        this.poolIndex++;
        return ch;
    }

    isHealthy() {
        return this.isConnected && this.channel !== null;
    }
}

export default new RabbitMQConnection();
