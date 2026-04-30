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
    publishPayoutMessage(payload, options) {
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
                    correlationId:   options?.correlationId || '',
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

    // Publish a workflow execution job to the workflow_queue.
    // Called when a workflow is triggered (manually, by keyword, by schedule, or by webhook).
    publishWorkflowJob(payload, options) {
        const message = {
            executionId: payload.executionId,
            workflowId:  payload.workflowId,
            workspaceId: payload.workspaceId,
            nodes:       payload.nodes,
            payload:     payload.payload || {},
            timestamp:   new Date().toISOString(),
        };

        const sent = this.channel.sendToQueue(
            "workflow_queue",
            Buffer.from(JSON.stringify(message)),
            {
                persistent:  true,
                contentType: "application/json",
                messageId:   payload.executionId,
                timestamp:   Date.now(),
                headers: {
                    "x-retry-count": 0,
                    "x-source":      "api-gateway",
                    correlationId:   options?.correlationId || '',
                },
            }
        );

        if (sent) {
            logger.info("Workflow job published", {
                executionId: payload.executionId,
                workflowId:  payload.workflowId,
            });
        } else {
            logger.error("Failed to publish workflow job — queue buffer full");
        }

        return sent;
    }

    // Publish a message event so workflow keyword triggers can be evaluated asynchronously.
    // Also used for analytics tracking — doesn't block the HTTP response.
    publishMessageEvent(payload, options) {
        const message = {
            messageId:   payload.messageId,
            workspaceId: payload.workspaceId,
            channelId:   payload.channelId,
            senderId:    payload.senderId,
            content:     payload.content,
            timestamp:   new Date().toISOString(),
        };

        const sent = this.channel.sendToQueue(
            "message_events_queue",
            Buffer.from(JSON.stringify(message)),
            {
                persistent:  true,
                contentType: "application/json",
                timestamp:   Date.now(),
                headers: {
                    correlationId: options?.correlationId || '',
                },
            }
        );

        if (!sent) {
            logger.warn("Failed to publish message event — queue buffer full");
        }

        return sent;
    }

    // Publish a notification delivery job.
    publishNotification(payload, options) {
        const message = {
            userId:      payload.userId,
            type:        payload.type,
            title:       payload.title,
            body:        payload.body,
            link:        payload.link,
            workspaceId: payload.workspaceId,
            timestamp:   new Date().toISOString(),
        };

        const sent = this.channel.sendToQueue(
            "notification_queue",
            Buffer.from(JSON.stringify(message)),
            {
                persistent:  true,
                contentType: "application/json",
                timestamp:   Date.now(),
                headers: {
                    correlationId: options?.correlationId || '',
                },
            }
        );

        return sent;
    }
}

export default MessagePublisher;
