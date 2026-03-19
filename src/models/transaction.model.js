// This model stores every payout transaction.
// Each time a user requests a payout, one Transaction document is created and
// updated as it moves through the lifecycle: initiated → processing → completed/failed.

import mongoose from "mongoose";

// All the currencies we support for payouts
const SUPPORTED_CURRENCIES = [
    "USD", "EUR", "GBP", "INR", "CAD", "AUD", "JPY", "CHF",
    "CNY", "MXN", "BRL", "ZAR", "SGD", "HKD", "NZD", "SEK",
    "NOK", "DKK", "PLN", "THB", "KRW", "RUB", "TRY", "IDR",
    "MYR", "PHP", "VND", "AED", "SAR", "EGP",
];

const transactionSchema = new mongoose.Schema(
    {
        // Our own unique ID for this transaction (e.g. TXN_ABC123_XYZ)
        // We generate this ourselves instead of using MongoDB's _id so it's human-readable
        transactionId: {
            type:     String,
            required: true,
            unique:   true,
            index:    true, // indexed so lookups by transactionId are fast
        },

        // The user who requested this payout
        userId: {
            type:     String,
            required: true,
            index:    true, // indexed so we can quickly fetch all transactions for a user
        },

        // How much money is being paid out
        amount: {
            type:     Number,
            required: true,
            min:      0.01, // can't payout zero or negative amounts
        },

        // What currency the payout is in
        currency: {
            type:     String,
            required: true,
            default:  "USD",
            enum:     SUPPORTED_CURRENCIES, // only allow currencies from our supported list
        },

        // Where the transaction is in its lifecycle
        status: {
            type:     String,
            required: true,
            enum:     ["initiated", "processing", "completed", "failed", "rolled_back"],
            default:  "initiated",
            index:    true, // indexed so we can quickly filter by status
        },

        // What kind of transaction this is
        type: {
            type:     String,
            required: true,
            enum:     ["payout", "refund", "adjustment"],
            default:  "payout",
        },

        // Snapshot of the user's balance before and after this transaction.
        // We store both so we can audit exactly what happened to the balance.
        balanceBefore: { type: Number, required: true },
        balanceAfter:  { type: Number, required: true },

        // Extra context about where the request came from
        metadata: {
            ipAddress:    String,  // the IP address of the request
            userAgent:    String,  // the browser/client that made the request
            source:       String,  // "api", "mobile", etc.
            description:  String,  // optional note from the user
            ipCountry:    String,  // country detected from the IP address
            ipCity:       String,  // city detected from the IP address
            exchangeRate: Number,  // the exchange rate used if currency != USD
            amountInUSD:  Number,  // the equivalent USD amount (for reporting)
        },

        // Timestamps and details about how the processing went
        processingDetails: {
            initiatedAt:          Date,    // when the API received the request
            processingStartedAt:  Date,    // when the worker picked it up
            completedAt:          Date,    // when it finished successfully
            failedAt:             Date,    // when it failed (if it did)
            processingDurationMs: Number,  // how long the worker took (in milliseconds)
            fraudScore:           Number,  // AI fraud risk score (0-100)
            fraudReasoning:       String,  // why the AI gave that score
            ipSuspicious:         Boolean, // true if the IP country doesn't match the user's country
        },

        // If the transaction failed, we store the error details here
        errorDetails: {
            code:         String, // machine-readable error code (e.g. "INSUFFICIENT_BALANCE")
            message:      String, // human-readable error message
            retryAttempt: Number, // which retry attempt this was (0 = first try)
        },

        // Info about the distributed lock that was held during processing
        lockInfo: {
            lockAcquired:   Boolean, // was a lock successfully acquired?
            lockReleasedAt: Date,    // when the lock was released
        },
    },
    {
        timestamps:  true,  // adds createdAt and updatedAt automatically
        versionKey:  false, // don't add the __v field (we don't need optimistic locking here)
    }
);

// ── Compound indexes ──────────────────────────────────────────────────────────
// These speed up the most common queries we run

// "show me all transactions for user X, newest first"
transactionSchema.index({ userId: 1, createdAt: -1 });

// "show me all failed transactions, newest first" (useful for monitoring)
transactionSchema.index({ status: 1, createdAt: -1 });

// ── Static method ─────────────────────────────────────────────────────────────
// Shortcut to find a transaction by our custom transactionId field
transactionSchema.statics.findByTransactionId = function (transactionId) {
    return this.findOne({ transactionId });
};

// ── Instance methods ──────────────────────────────────────────────────────────
// These update the transaction status and save it in one call

// Called when the worker picks up the message and starts processing
transactionSchema.methods.markAsProcessing = function () {
    this.status = "processing";
    this.processingDetails.processingStartedAt = new Date();
    return this.save();
};

// Called when the worker successfully deducts the balance
transactionSchema.methods.markAsCompleted = function () {
    this.status = "completed";
    this.processingDetails.completedAt = new Date();

    // Calculate how long the worker took to process this transaction
    if (this.processingDetails.processingStartedAt) {
        this.processingDetails.processingDurationMs =
            Date.now() - this.processingDetails.processingStartedAt.getTime();
    }

    return this.save();
};

// Called when something goes wrong — stores the error details for debugging
transactionSchema.methods.markAsFailed = function (error) {
    this.status = "failed";
    this.processingDetails.failedAt = new Date();

    if (error) {
        this.errorDetails = {
            code:    error.code || "UNKNOWN_ERROR",
            message: error.message,
        };
    }

    return this.save();
};

export default mongoose.model("Transaction", transactionSchema);
