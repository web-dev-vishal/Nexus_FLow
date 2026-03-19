// Payout request validator — checks that all required fields are present and valid
// before the request reaches the controller.
// Uses Zod for schema validation — it gives clear, specific error messages.

import { z } from "zod";

// The full list of currency codes we accept for payouts.
// Any currency not in this list will be rejected before it even hits the service layer.
const SUPPORTED_CURRENCIES = [
    "USD", "EUR", "GBP", "INR", "CAD", "AUD", "JPY", "CHF",
    "CNY", "MXN", "BRL", "ZAR", "SGD", "HKD", "NZD", "SEK",
    "NOK", "DKK", "PLN", "THB", "KRW", "RUB", "TRY", "IDR",
    "MYR", "PHP", "VND", "AED", "SAR", "EGP",
];

export const payoutSchema = z.object({
    // userId must be alphanumeric with hyphens/underscores — no spaces or special chars
    userId: z
        .string({ required_error: "userId is required" })
        .min(3, "userId must be at least 3 characters")
        .max(50, "userId must be at most 50 characters")
        .regex(/^[a-zA-Z0-9_-]+$/, "userId may only contain letters, numbers, hyphens, and underscores"),

    // Amount must be a positive number between 0.01 and 1,000,000
    amount: z
        .number({ required_error: "amount is required", invalid_type_error: "amount must be a number" })
        .positive("amount must be positive")
        .min(0.01, "minimum amount is 0.01")
        .max(1_000_000, "maximum amount is 1,000,000"),

    // Currency is automatically uppercased — so "usd" and "USD" both work
    currency: z
        .string()
        .toUpperCase()
        .refine((v) => SUPPORTED_CURRENCIES.includes(v), {
            message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
        })
        .default("USD"),

    // Description is optional — just a note for the user's records
    description: z
        .string()
        .max(500, "description must be at most 500 characters")
        .optional(),
});

// Express middleware — validates req.body against the schema.
// Returns 400 with all validation errors if invalid.
// Replaces req.body with the parsed (coerced + trimmed) data on success.
export const validatePayout = (req, res, next) => {
    const result = payoutSchema.safeParse(req.body);

    if (!result.success) {
        const errors = result.error.errors.map((e) => e.message);
        return res.status(400).json({ success: false, errors });
    }

    // Use the parsed data — Zod has already coerced types and applied defaults
    req.body = result.data;
    next();
};
