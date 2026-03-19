// PayoutUser stores the payout-specific data for each user.
// This is separate from the main User model (which handles login/auth).
// Keeping them separate means auth and payments don't interfere with each other.
// Example: a user can have an account but not be set up for payouts yet.

import mongoose from "mongoose";

// All the currencies we support — used to validate the currency field
const SUPPORTED_CURRENCIES = [
    "USD", "EUR", "GBP", "INR", "CAD", "AUD", "JPY", "CHF",
    "CNY", "MXN", "BRL", "ZAR", "SGD", "HKD", "NZD", "SEK",
    "NOK", "DKK", "PLN", "THB", "KRW", "RUB", "TRY", "IDR",
    "MYR", "PHP", "VND", "AED", "SAR", "EGP",
];

const payoutUserSchema = new mongoose.Schema(
    {
        // This links to the User model's _id — stored as a string for flexibility
        // (MongoDB ObjectIds can be stored as strings without issues)
        userId: {
            type:     String,
            required: true,
            unique:   true, // one payout profile per user
            index:    true, // indexed so lookups by userId are fast
        },

        // How much money this user currently has available to pay out
        // We also keep a copy of this in Redis for fast reads — see balance.service.js
        balance: {
            type:     Number,
            required: true,
            default:  0,
            min:      0, // balance can never go below zero
        },

        // The user's preferred currency for payouts
        currency: {
            type:     String,
            required: true,
            default:  "USD",
            enum:     SUPPORTED_CURRENCIES, // must be one of the currencies we support
        },

        // Multi-currency wallet — holds balances in different currencies.
        // The main `balance` field above is always in the user's primary currency.
        // This wallet lets users hold and pay out in multiple currencies.
        wallet: {
            type:    Map,
            of:      Number,
            default: {},
            // Example: { "EUR": 150.00, "GBP": 80.00 }
        },

        // Contact info for notifications — optional, only used if the user provides them
        email: {
            type:  String,
            trim:  true,
        },

        phone: {
            type:  String,
            trim:  true,
        },

        // The user's country — used to detect suspicious IP locations during payouts
        country: {
            type:    String,
            default: "US",
            trim:    true,
        },

        // Whether this user is allowed to make payouts right now
        // "suspended" means temporarily blocked, "closed" means permanently closed
        status: {
            type:     String,
            required: true,
            enum:     ["active", "suspended", "closed"],
            default:  "active",
            index:    true, // indexed so we can quickly find all suspended users if needed
        },

        // Stats about this user's payout history — updated after each successful payout
        metadata: {
            lastPayoutAt:      Date,                        // when they last made a payout
            totalPayouts:      { type: Number, default: 0 }, // how many payouts they've made
            totalPayoutAmount: { type: Number, default: 0 }, // total amount paid out ever
        },
    },
    {
        timestamps:  true,  // adds createdAt and updatedAt automatically
        versionKey:  false, // skip the __v field — we don't need it
    }
);

// Quick lookup by userId — used everywhere in the payout flow
payoutUserSchema.statics.findByUserId = function (userId) {
    return this.findOne({ userId });
};

// Check if the user has enough money for a given payout amount
// Simple comparison — the actual atomic deduction happens in balance.service.js via Redis
payoutUserSchema.methods.hasSufficientBalance = function (amount) {
    return this.balance >= amount;
};

export default mongoose.model("PayoutUser", payoutUserSchema);
