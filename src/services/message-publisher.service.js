// Message Publisher — sends payout jobs to the RabbitMQ queue.
// The API gateway publishes a message here, and the worker process picks it up
// and does the actual balance deduction. This decouples the API from the processing
// so slow payouts don't block the HTTP response.

import logger from "../utils/logger.js";

class MessagePublisher {
    constructor(channel) {
        // The RabbitMQ channel is passed in from app.js after the connection is established
        this.channel = channel;
    }

    // Publish a payout job to the payout_queue.
    // Returns true if the message was accepted by RabbitMQ, false if the buffer is full.
    publishPayoutMessage(payload) {
        // Build the full message — include everything the worker needs to process the payout
        const message = {
            transactionId: payload.transactionId,
            userId:        payload.userId,
            amount:        payload.amount,
            currency:      payload.currency,
            lockValue:     payload.lockValue,  // Worker needs this to release the distributed lock
            metadata:      payload.metadata,
            timestamp:     new Date().toISOString(),
        };

        const sent = this.channel.sendToQueue(
            "payout_queue",
            Buffer.from(JSON.stringify(message)),
            {
                persistent:  true,          // Survive RabbitMQ restarts
                contentType: "application/json",
                messageId:   payload.transactionId,
                timestamp:   Date.now(),
                headers: {
                    "x-retry-count": 0,     // Worker uses this to track retry attempts
                    "x-source":      "api-gateway",
                },
            }
        );

        if (sent) {
            logger.info("Message published to payout_queue", {
                transactionId: payload.transactionId,
                userId:        payload.userId,
            });
        } else {
            // This happens when RabbitMQ's internal buffer is full — very rare
            logger.error("Failed to publish message — queue buffer full");
        }

        return sent;
    }
}

export default MessagePublisher;
