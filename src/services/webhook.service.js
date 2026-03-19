// Webhook Service — manages webhook registrations and delivers events to user endpoints.
// When a payout event fires, we call deliverEvent() which finds all matching webhooks
// for that user and POSTs the payload to each one.
// Failed deliveries are retried up to 3 times with exponential backoff.

import crypto from "crypto";
import Webhook from "../models/webhook.model.js";
import WebhookDelivery from "../models/webhook-delivery.model.js";
import logger from "../utils/logger.js";

// How long to wait for a webhook endpoint to respond before giving up
const DELIVERY_TIMEOUT_MS = 10000;

// How many times to retry a failed delivery before giving up
const MAX_RETRIES = 3;

class WebhookService {

    // Register a new webhook endpoint for a user.
    // Generates a random secret they can use to verify deliveries came from us.
    async createWebhook(userId, { url, events }) {
        // Validate the URL format before saving
        try {
            new URL(url);
        } catch {
            throw { statusCode: 400, message: "Invalid webhook URL" };
        }

        // Only allow HTTPS in production — HTTP is fine for local dev
        if (process.env.NODE_ENV === "production" && !url.startsWith("https://")) {
            throw { statusCode: 400, message: "Webhook URL must use HTTPS in production" };
        }

        // Generate a random secret — the user uses this to verify our requests
        const secret = crypto.randomBytes(24).toString("hex");

        const webhook = await Webhook.create({
            userId,
            url,
            events: events || ["payout.completed", "payout.failed", "payout.initiated"],
            secret,
        });

        logger.info("Webhook created", { userId, webhookId: webhook._id, url });

        return {
            id:      webhook._id,
            url:     webhook.url,
            events:  webhook.events,
            secret,  // only returned once — user must save this
            active:  webhook.active,
            createdAt: webhook.createdAt,
        };
    }

    // Get all webhooks for a user
    async getUserWebhooks(userId) {
        const webhooks = await Webhook.find({ userId }).lean();

        // Don't return the secret in list responses — it was shown once at creation
        return webhooks.map(({ secret: _s, ...w }) => w);
    }

    // Update a webhook's URL or event subscriptions
    async updateWebhook(webhookId, userId, updates) {
        const webhook = await Webhook.findOne({ _id: webhookId, userId });
        if (!webhook) {
            throw { statusCode: 404, message: "Webhook not found" };
        }

        if (updates.url) {
            try { new URL(updates.url); } catch {
                throw { statusCode: 400, message: "Invalid webhook URL" };
            }
            webhook.url = updates.url;
        }

        if (updates.events) webhook.events = updates.events;
        if (typeof updates.active === "boolean") webhook.active = updates.active;

        await webhook.save();
        logger.info("Webhook updated", { webhookId, userId });

        const { secret: _s, ...result } = webhook.toObject();
        return result;
    }

    // Delete a webhook
    async deleteWebhook(webhookId, userId) {
        const webhook = await Webhook.findOneAndDelete({ _id: webhookId, userId });
        if (!webhook) {
            throw { statusCode: 404, message: "Webhook not found" };
        }
        logger.info("Webhook deleted", { webhookId, userId });
    }

    // Get delivery history for a webhook — useful for debugging
    async getDeliveryLogs(webhookId, userId, limit = 20) {
        // Make sure the webhook belongs to this user
        const webhook = await Webhook.findOne({ _id: webhookId, userId });
        if (!webhook) {
            throw { statusCode: 404, message: "Webhook not found" };
        }

        const deliveries = await WebhookDelivery.find({ webhookId })
            .sort({ createdAt: -1 })
            .limit(Math.min(limit, 100))
            .lean();

        return deliveries;
    }

    // Fire an event to all matching webhooks for a user.
    // This is called from the worker after a payout completes/fails,
    // and from the payout service when a payout is initiated.
    // We don't await individual deliveries — they run in the background.
    async deliverEvent(userId, eventName, payload) {
        // Find all active webhooks for this user that subscribe to this event
        const webhooks = await Webhook.find({
            userId,
            active: true,
            events: eventName,
        });

        if (webhooks.length === 0) return;

        logger.info(`Delivering webhook event ${eventName} to ${webhooks.length} endpoint(s)`, { userId });

        // Fire all deliveries in parallel — don't wait for them
        for (const webhook of webhooks) {
            this._deliver(webhook, eventName, payload, 1).catch((err) =>
                logger.error("Webhook delivery error", { webhookId: webhook._id, error: err.message })
            );
        }
    }

    // Actually POST the payload to the webhook URL.
    // Retries up to MAX_RETRIES times with exponential backoff.
    async _deliver(webhook, eventName, payload, attempt) {
        const startTime = Date.now();

        // Build the full payload we'll send
        const body = JSON.stringify({
            event:     eventName,
            timestamp: new Date().toISOString(),
            data:      payload,
        });

        // Sign the payload with the webhook secret so the user can verify it came from us
        const signature = crypto
            .createHmac("sha256", webhook.secret)
            .update(body)
            .digest("hex");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

        let statusCode = null;
        let responseBody = null;
        let error = null;
        let success = false;

        try {
            const res = await fetch(webhook.url, {
                method:  "POST",
                headers: {
                    "Content-Type":       "application/json",
                    "X-SwiftPay-Event":   eventName,
                    "X-SwiftPay-Secret":  webhook.secret,
                    "X-SwiftPay-Sig":     `sha256=${signature}`,
                    "User-Agent":         "SwiftPay-Webhooks/1.0",
                },
                body,
                signal: controller.signal,
            });

            clearTimeout(timer);
            statusCode = res.status;

            // Read the response body (truncated — we don't need the full thing)
            const rawBody = await res.text();
            responseBody = rawBody.substring(0, 500);

            // Any 2xx response counts as success
            success = res.ok;
        } catch (err) {
            clearTimeout(timer);
            error = err.name === "AbortError" ? "Request timed out" : err.message;
        }

        const durationMs = Date.now() - startTime;

        // Log the delivery attempt
        await WebhookDelivery.create({
            webhookId:    webhook._id,
            userId:       webhook.userId,
            event:        eventName,
            payload,
            url:          webhook.url,
            success,
            statusCode,
            durationMs,
            responseBody,
            error,
            attempt,
        });

        // Update the webhook stats
        const statsUpdate = success
            ? { $inc: { "stats.totalDeliveries": 1, "stats.successCount": 1 }, $set: { "stats.lastDeliveredAt": new Date() } }
            : { $inc: { "stats.totalDeliveries": 1, "stats.failureCount": 1 }, $set: { "stats.lastFailedAt": new Date() } };

        await Webhook.updateOne({ _id: webhook._id }, statsUpdate);

        if (success) {
            logger.debug("Webhook delivered", { webhookId: webhook._id, event: eventName, statusCode, durationMs });
            return;
        }

        // Retry with exponential backoff if we haven't hit the limit
        if (attempt < MAX_RETRIES) {
            const delay = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
            logger.warn(`Webhook delivery failed, retrying in ${delay}ms`, {
                webhookId: webhook._id,
                attempt,
                error: error || `HTTP ${statusCode}`,
            });

            setTimeout(() => {
                this._deliver(webhook, eventName, payload, attempt + 1).catch((err) =>
                    logger.error("Webhook retry error", { webhookId: webhook._id, error: err.message })
                );
            }, delay);
        } else {
            logger.error("Webhook delivery failed after all retries", {
                webhookId: webhook._id,
                event:     eventName,
                error:     error || `HTTP ${statusCode}`,
            });
        }
    }
}

export default WebhookService;
