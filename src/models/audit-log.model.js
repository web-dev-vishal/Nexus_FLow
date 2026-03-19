// The AuditLog model records every important thing that happens to a transaction.
// Think of it like a paper trail — every step of the payout process gets logged here
// so we can always look back and see exactly what happened and when.
// This is important for debugging, compliance, and fraud investigation.

import mongoose from "mongoose";

// Every log entry must use one of these action names.
// This keeps the logs consistent and easy to filter/search.
const AUDIT_ACTIONS = [
    "PAYOUT_INITIATED",         // user requested a payout
    "PAYOUT_PROCESSING",        // worker started processing it
    "PAYOUT_COMPLETED",         // payout finished successfully
    "PAYOUT_FAILED",            // something went wrong
    "LOCK_ACQUIRED",            // distributed lock was grabbed (prevents double-spend)
    "LOCK_RELEASED",            // lock was released after processing
    "BALANCE_DEDUCTED",         // money was taken from the user's balance
    "BALANCE_RESTORED",         // money was put back (rollback after an error)
    "MESSAGE_PUBLISHED",        // payout message was sent to RabbitMQ
    "MESSAGE_CONSUMED",         // worker received the message from RabbitMQ
    "MESSAGE_ACKED",            // worker told RabbitMQ the message was handled successfully
    "MESSAGE_NACKED",           // worker told RabbitMQ the message failed
    "FRAUD_SCORE_CALCULATED",   // AI scored the transaction for fraud risk
    "HIGH_FRAUD_RISK_DETECTED", // AI flagged the transaction as high risk
    "IP_MISMATCH_DETECTED",     // the request IP country doesn't match the user's country
    "ANOMALY_DETECTED",         // AI found this transaction looks unusual compared to history
];

const auditLogSchema = new mongoose.Schema(
    {
        // Which transaction this log entry belongs to
        transactionId: { type: String, required: true, index: true },

        // Which user this log entry belongs to
        userId: { type: String, required: true, index: true },

        // What happened — must be one of the AUDIT_ACTIONS above
        action: { type: String, required: true, enum: AUDIT_ACTIONS },

        // Any extra data relevant to this action (e.g. the fraud score, the balance amount)
        // Mixed type means it can be any shape — different actions have different details
        details: { type: mongoose.Schema.Types.Mixed },

        // When this happened — defaults to right now
        timestamp: { type: Date, default: Date.now, index: true },
    },
    {
        versionKey: false, // skip the __v field
    }
);

// Compound indexes for the two most common queries:
// "show me all logs for transaction X in order" and "show me all logs for user Y in order"
auditLogSchema.index({ transactionId: 1, timestamp: -1 });
auditLogSchema.index({ userId: 1, timestamp: -1 });

// Static helper — called throughout the codebase to write a log entry.
// We wrap it in try/catch so a logging failure never crashes the main payout flow.
// If audit logging breaks, the payout should still complete — logs are secondary.
auditLogSchema.statics.logAction = async function (transactionId, userId, action, details = {}) {
    try {
        await this.create({ transactionId, userId, action, details, timestamp: new Date() });
    } catch (error) {
        // Just print the error — don't throw it, don't let it stop anything
        console.error("Audit log write failed:", error.message);
    }
};

export default mongoose.model("AuditLog", auditLogSchema);
