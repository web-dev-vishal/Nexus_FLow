// Scheduled Payout — lets users queue a payout for a future date/time.
// A background job checks this collection every minute and processes any
// payouts whose scheduledAt time has passed.

import mongoose from "mongoose";

const scheduledPayoutSchema = new mongoose.Schema(
    {
        // The user who scheduled this payout
        userId: {
            type:     String,
            required: true,
            index:    true,
        },

        // Payout details — same fields as a regular payout
        amount: {
            type:     Number,
            required: true,
            min:      0.01,
        },

        currency: {
            type:     String,
            required: true,
            default:  "USD",
        },

        description: {
            type: String,
            trim: true,
        },

        // When to execute this payout — must be in the future when created
        scheduledAt: {
            type:     Date,
            required: true,
            index:    true, // indexed so the scheduler can quickly find due payouts
        },

        // Lifecycle status of the scheduled payout
        status: {
            type:     String,
            required: true,
            enum:     ["pending", "processing", "completed", "failed", "cancelled"],
            default:  "pending",
            index:    true,
        },

        // If it ran, which transaction was created
        transactionId: {
            type: String,
        },

        // If it failed, why
        failureReason: {
            type: String,
        },

        // When it was actually executed (might differ slightly from scheduledAt)
        executedAt: {
            type: Date,
        },
    },
    {
        timestamps:  true,
        versionKey:  false,
    }
);

// The scheduler queries: "give me all pending payouts where scheduledAt <= now"
scheduledPayoutSchema.index({ status: 1, scheduledAt: 1 });

export default mongoose.model("ScheduledPayout", scheduledPayoutSchema);
