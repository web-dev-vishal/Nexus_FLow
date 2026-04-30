// Message Consumer — listens to the RabbitMQ queue and processes payout jobs.
// This runs in the worker process (src/worker/index.js), not in the API gateway.
// Each message is acknowledged (ack) on success or retried/dead-lettered on failure.

import logger from "../utils/logger.js";

class MessageConsumer {
    constructor(channel, handler) {
        // The RabbitMQ channel to consume from
        this.channel = channel;

        // The function that actually processes each payout message
        // (defined in WorkerService.processMessage)
        this.handler = handler;

        // Stored so we can cancel the consumer on graceful shutdown
        this.consumerTag = null;
    }

    // Start listening to the queue.
    // noAck: false means we manually ack/nack each message — important for reliability.
    async startConsuming(queueName = "payout_queue") {
        const { consumerTag } = await this.channel.consume(
            queueName,
            async (msg) => {
                // null means the consumer was cancelled by the server (e.g. queue deleted)
                if (msg === null) {
                    logger.warn("Consumer cancelled by server");
                    return;
                }
                await this._handleMessage(msg);
            },
            { noAck: false }  // We'll manually ack/nack after processing
        );

        this.consumerTag = consumerTag;
        logger.info(`Consuming from ${queueName}`, { consumerTag });
    }

    // Process a single message from the queue.
    // Acks on success, calls _handleFailure on error.
    async _handleMessage(msg) {
        const startTime = Date.now();
        let payload;

        try {
            // Parse the JSON payload from the message body
            let raw;
            try {
                raw = JSON.parse(msg.content.toString());
            } catch {
                // Malformed JSON — dead-letter immediately, no point retrying
                logger.error("Malformed message payload — routing to DLQ immediately", {
                    content: msg.content.toString().slice(0, 200),
                });
                this.channel.nack(msg, false, false);
                return;
            }

            // Validate required fields — a message missing these can never be processed
            const required = ["transactionId", "userId", "amount", "currency"];
            const missing = required.filter((k) => raw[k] === undefined || raw[k] === null);
            if (missing.length > 0) {
                logger.error("Message missing required fields — routing to DLQ", {
                    missing,
                    transactionId: raw.transactionId,
                });
                this.channel.nack(msg, false, false);
                return;
            }

            // Type-check the amount — must be a positive number
            if (typeof raw.amount !== "number" || raw.amount <= 0) {
                logger.error("Message has invalid amount — routing to DLQ", {
                    amount:        raw.amount,
                    transactionId: raw.transactionId,
                });
                this.channel.nack(msg, false, false);
                return;
            }

            payload = raw;

            logger.info("Processing message", {
                transactionId: payload.transactionId,
                retryCount:    msg.properties.headers?.["x-retry-count"] ?? 0,
            });

            // Hand off to the worker's processMessage function
            await this.handler(payload, msg);

            // Tell RabbitMQ the message was processed successfully — remove it from the queue
            this.channel.ack(msg);

            logger.info("Message processed", {
                transactionId:    payload.transactionId,
                processingTimeMs: Date.now() - startTime,
            });
        } catch (error) {
            logger.error("Message processing failed", {
                transactionId:    payload?.transactionId,
                error:            error.message,
                processingTimeMs: Date.now() - startTime,
            });

            // Don't just drop the message — try to retry it
            await this._handleFailure(msg, error, payload);
        }
    }

    // Handle a failed message — retry it a few times before giving up.
    // We nack without requeue and re-publish manually so we can add a delay between retries.
    // If we just nacked with requeue=true, RabbitMQ would instantly re-deliver it in a tight loop.
    async _handleFailure(msg, error, payload) {
        const retryCount = (msg.properties.headers?.["x-retry-count"] ?? 0) + 1;
        const maxRetries = parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3;

        if (retryCount <= maxRetries) {
            logger.warn(`Requeuing message (attempt ${retryCount}/${maxRetries})`, {
                transactionId: payload?.transactionId,
            });

            // Nack without requeue — we'll re-publish manually after a delay
            // so we get a proper retry delay instead of an instant tight loop
            this.channel.nack(msg, false, false);

            const delay = parseInt(process.env.RETRY_DELAY_MS) || 5000;

            // Wait before re-publishing so we don't hammer a failing service
            setTimeout(() => {
                this.channel.sendToQueue("payout_queue", msg.content, {
                    ...msg.properties,
                    headers: {
                        ...msg.properties.headers,
                        "x-retry-count": retryCount,
                    },
                });
            }, delay);
        } else {
            // We've retried enough — send to the dead letter queue for manual investigation
            logger.error("Max retries reached — routing to DLQ", {
                transactionId: payload?.transactionId,
            });
            this.channel.nack(msg, false, false);
        }
    }

    // Stop consuming — called during graceful shutdown so in-flight messages can finish.
    async stopConsuming() {
        if (this.consumerTag) {
            await this.channel.cancel(this.consumerTag);
            logger.info("Consumer stopped", { consumerTag: this.consumerTag });
            this.consumerTag = null;
        }
    }
}

export default MessageConsumer;
