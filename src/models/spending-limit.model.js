// Spending Limit — lets users (or admins) set caps on how much can be paid out
// in a given time window. Useful for fraud prevention and budget control.
// Example: "no more than $500 per day" or "$2000 per month".

import mongoose from "mongoose";

const spendingLimitSchema = new mongoose.Schema(
    {
        // Which user this limit applies to
        userId: {
            type:     String,
            required: true,
            index:    true,
        },

        // The time window for this limit
        period: {
            type:     String,
            required: true,
            enum:     ["daily", "weekly", "monthly"],
        },

        // The maximum amount allowed in this period
        limitAmount: {
            type:     Number,
            required: true,
            min:      1,
        },

        // Currency for the limit (always USD for simplicity — we convert if needed)
        currency: {
            type:    String,
            default: "USD",
        },

        // Whether this limit is currently active
        active: {
            type:    Boolean,
            default: true,
        },

        // Who set this limit — "user" means they set it themselves, "admin" means it was imposed
        setBy: {
            type:    String,
            enum:    ["user", "admin"],
            default: "user",
        },
    },
    {
        timestamps:  true,
        versionKey:  false,
    }
);

// One limit per user per period — can't have two daily limits for the same user
spendingLimitSchema.index({ userId: 1, period: 1 }, { unique: true });

export default mongoose.model("SpendingLimit", spendingLimitSchema);
