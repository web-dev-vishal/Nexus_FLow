// Webhook model — stores webhook endpoints that users register.
// When a payout event happens (initiated, completed, failed), we POST to these URLs.
// Think of it like Stripe's webhook system — users register a URL and we call it.

import mongoose from "mongoose";

const webhookSchema = new mongoose.Schema(
    {
        // Which user owns this webhook
        userId: {
            type:     String,
            required: true,
            index:    true,
        },

        // The URL we'll POST to when an event fires
        url: {
            type:     String,
            required: true,
            trim:     true,
        },

        // Which events this webhook should fire for.
        // If empty, it fires for all events.
        events: {
            type:    [String],
            default: ["payout.completed", "payout.failed", "payout.initiated"],
            enum:    ["payout.initiated", "payout.processing", "payout.completed", "payout.failed"],
        },

        // A secret the user can use to verify the webhook came from us.
        // We include it as a header (X-NexusFlow-Secret) on every delivery.
        secret: {
            type:     String,
            required: true,
        },

        // Whether this webhook is active — users can pause without deleting
        active: {
            type:    Boolean,
            default: true,
        },

        // Stats about delivery attempts
        stats: {
            totalDeliveries:  { type: Number, default: 0 },
            successCount:     { type: Number, default: 0 },
            failureCount:     { type: Number, default: 0 },
            lastDeliveredAt:  Date,
            lastFailedAt:     Date,
        },
    },
    {
        timestamps:  true,
        versionKey:  false,
    }
);

// Compound index — most queries are "get all webhooks for user X"
webhookSchema.index({ userId: 1, active: 1 });

export default mongoose.model("Webhook", webhookSchema);
