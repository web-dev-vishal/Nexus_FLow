// Webhook Delivery Log — records every attempt to deliver a webhook.
// This gives users visibility into whether their endpoint received the event,
// and lets us retry failed deliveries.

import mongoose from "mongoose";

const webhookDeliverySchema = new mongoose.Schema(
    {
        // Which webhook config this delivery belongs to
        webhookId: {
            type:     mongoose.Schema.Types.ObjectId,
            ref:      "Webhook",
            required: true,
            index:    true,
        },

        // Which user this is for
        userId: {
            type:     String,
            required: true,
            index:    true,
        },

        // The event that triggered this delivery (e.g. "payout.completed")
        event: {
            type:     String,
            required: true,
        },

        // The full payload we sent
        payload: {
            type: mongoose.Schema.Types.Mixed,
        },

        // The URL we tried to deliver to
        url: {
            type:     String,
            required: true,
        },

        // Whether the delivery succeeded (HTTP 2xx response)
        success: {
            type:    Boolean,
            default: false,
        },

        // The HTTP status code we got back (null if the request failed entirely)
        statusCode: {
            type: Number,
        },

        // How long the request took in milliseconds
        durationMs: {
            type: Number,
        },

        // The response body (truncated to 500 chars to save space)
        responseBody: {
            type: String,
        },

        // Error message if the request failed (network error, timeout, etc.)
        error: {
            type: String,
        },

        // Which attempt this was (1 = first try, 2 = first retry, etc.)
        attempt: {
            type:    Number,
            default: 1,
        },
    },
    {
        timestamps:  true,
        versionKey:  false,
    }
);

// Index for "show me all deliveries for webhook X, newest first"
webhookDeliverySchema.index({ webhookId: 1, createdAt: -1 });

export default mongoose.model("WebhookDelivery", webhookDeliverySchema);
