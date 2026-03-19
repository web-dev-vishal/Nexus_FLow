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
        // Dead Letter Exchange (DLX) — when a message fails too many times,
        // RabbitMQ moves it here instead of dropping it silently.
        // This gives us a "dead letter queue" where we can inspect failed messages.

        // Create the exchange that receives dead letters
        await this.channel.assertExchange("dlx_payout", "direct", { durable: true });

        // Create the dead letter queue where failed messages pile up
        await this.channel.assertQueue("payout_dlq", { durable: true });

        // Connect the queue to the exchange with routing key "payout"
        await this.channel.bindQueue("payout_dlq", "dlx_payout", "payout");

        // Main payout queue — this is where the API publishes and the worker reads from
        // durable: true means the queue survives a RabbitMQ restart (messages saved to disk)
        await this.channel.assertQueue("payout_queue", {
            durable: true,
            arguments: {
                // If a message fails, send it to the dead letter exchange instead of dropping it
                "x-dead-letter-exchange":    "dlx_payout",
                "x-dead-letter-routing-key": "payout",

                // Messages older than 24 hours are considered stale and get dead-lettered
                "x-message-ttl": 86400000,
            },
        });

        logger.info("RabbitMQ queues configured");
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

        // Close channel first, then the connection
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
        if (!this.isConnected || !this.channel) {
            throw new Error("RabbitMQ channel not available");
        }
        return this.channel;
    }

    isHealthy() {
        return this.isConnected && this.channel !== null;
    }
}

export default new RabbitMQConnection();
